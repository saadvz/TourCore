#!/usr/bin/env bash
# Prove the step D blocker journeys through the doctor/smoke CLI.
# No arguments. Never texts a phone. Overwrites evidence/step-d.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  printf '%s\n' "prove-step-d.sh takes no arguments and accepts no phone number." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
SKILL="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE="$SKILL/evidence/step-d"
rm -rf "$EVIDENCE"
mkdir -p "$EVIDENCE"
cd "$ROOT"
PIN_PATTERN="$(node "$ROOT/scripts/scratch-pin-pattern.mjs")"

if [[ ! -x node_modules/.bin/tsx ]]; then
  printf '%s\n' "tsx is missing. From the repo root run: npm ci" >&2
  exit 1
fi

FEED="$ROOT/src/cleaner-core/fixtures/guesty-lite-scratch.ics"
OWNER="+15555550100"
CLEANER="+15555550101"
UNAPPROVED="+15555550199"
DUE="2026-10-18T12:00:00.000Z"
AFTER="2026-10-18T15:30:00.000Z"

fail() {
  printf '%s\n' "$1" | tee "$EVIDENCE/result.txt" >&2
  printf '%s\n' "evidence: $EVIDENCE" >&2
  exit 1
}

doctor() {
  local dir="$1"
  mkdir -p "$dir"
  printf '%s\n' "env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor" >"$dir/doctor.command"
  set +e
  env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor >"$dir/doctor.stdout.txt" 2>"$dir/doctor.stderr.txt"
  local code=$?
  set -e
  printf '%s\n' "$code" >"$dir/doctor.exit"
  if [[ "$code" != "0" ]]; then
    fail "doctor exit $code"
  fi
  if ! node "$SKILL/scripts/assert-report.mjs" doctor "$dir/doctor.stdout.txt" "$SKILL/scripts/expected/doctor-on.json" forbidden; then
    fail "doctor stdout mismatch"
  fi
}

run_smoke() {
  local dir="$1"
  local name="$2"
  shift 2
  mkdir -p "$dir"
  printf '%s\n' "$*" >"$dir/$name.command"
  set +e
  "$@" >"$dir/$name.stdout.txt" 2>"$dir/$name.stderr.txt"
  local code=$?
  set -e
  printf '%s\n' "$code" >"$dir/$name.exit"
  if [[ "$code" != "0" ]]; then
    fail "$name exit $code"
  fi
  node -e '
    const fs = require("node:fs");
    const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    fs.writeFileSync(process.argv[2], (report.transcript ?? []).join("\n") + "\n");
    fs.writeFileSync(process.argv[3], JSON.stringify(report.jobs ?? [], null, 2) + "\n");
    fs.writeFileSync(process.argv[4], JSON.stringify(report.outbox ?? [], null, 2) + "\n");
  ' "$dir/$name.stdout.txt" "$dir/$name.transcript.txt" "$dir/$name.jobs.json" "$dir/$name.outbox.json"
}

assert_journey() {
  local name="$1"
  shift
  if ! node "$SKILL/scripts/assert-step-d.mjs" "$name" "$@"; then
    fail "feature: $name"
  fi
  printf '%s\n' "feature: $name" >"$EVIDENCE/$name/result.txt"
  printf '%s\n' "pass" >>"$EVIDENCE/$name/result.txt"
}

doctor "$EVIDENCE/held"
run_smoke "$EVIDENCE/held" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --with-pin --feed "$FEED" \
  --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$CLEANER=YES" \
  --now "$AFTER"
assert_journey held "$EVIDENCE/held/smoke.stdout.txt"

doctor "$EVIDENCE/released"
run_smoke "$EVIDENCE/released" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --with-pin --feed "$FEED" \
  --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$CLEANER=YES" \
  --now "$AFTER" --reply "$OWNER=guests have left"
assert_journey released "$EVIDENCE/released/smoke.stdout.txt"

doctor "$EVIDENCE/not-opted"
run_smoke "$EVIDENCE/not-opted" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --with-pin --feed "$FEED" \
  --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" \
  --reply "$OWNER=guests have left"
assert_journey not-opted "$EVIDENCE/not-opted/smoke.stdout.txt"

doctor "$EVIDENCE/unapproved-yes"
run_smoke "$EVIDENCE/unapproved-yes" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --with-pin --feed "$FEED" \
  --reply "$UNAPPROVED=YES" \
  --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" \
  --reply "$OWNER=guests have left"
assert_journey unapproved-yes "$EVIDENCE/unapproved-yes/smoke.stdout.txt"

doctor "$EVIDENCE/not-approved"
run_smoke "$EVIDENCE/not-approved" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --with-pin --unapproved --feed "$FEED" \
  --reply "$CLEANER=YES" \
  --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" \
  --reply "$OWNER=guests have left"
assert_journey not-approved "$EVIDENCE/not-approved/smoke.stdout.txt"

doctor "$EVIDENCE/checkout-moved"
run_smoke "$EVIDENCE/checkout-moved" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --with-pin --feed "$FEED" \
  --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$CLEANER=YES" \
  --reply "$OWNER=2:00 PM" --reply "$OWNER=guests have left" \
  --reply "$CLEANER=YES" --reply "$OWNER=guests have left"
assert_journey checkout-moved "$EVIDENCE/checkout-moved/smoke.stdout.txt"

doctor "$EVIDENCE/full-turn"
run_smoke "$EVIDENCE/full-turn" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --with-pin --feed "$FEED" \
  --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$CLEANER=YES" \
  --now "$DUE" --remind --now "$AFTER" \
  --reply "$OWNER=guests have left" --reply "$CLEANER=START" --reply "$CLEANER=DONE"
assert_journey full-turn "$EVIDENCE/full-turn/smoke.stdout.txt"

doctor "$EVIDENCE/done-without-start"
run_smoke "$EVIDENCE/done-without-start" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --with-pin --feed "$FEED" \
  --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$CLEANER=YES" \
  --now "$DUE" --remind --now "$AFTER" \
  --reply "$OWNER=guests have left" --reply "$CLEANER=DONE" --reply "$CLEANER=DONE"
assert_journey done-without-start "$EVIDENCE/done-without-start/smoke.stdout.txt"

doctor "$EVIDENCE/done-early"
run_smoke "$EVIDENCE/done-early" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --with-pin --feed "$FEED" \
  --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$CLEANER=YES" \
  --now "$AFTER" --reply "$CLEANER=DONE"
assert_journey done-early "$EVIDENCE/done-early/smoke.stdout.txt"

doctor "$EVIDENCE/pin-stored"
STORE_DIR="$(mktemp -d)"
run_smoke "$EVIDENCE/pin-stored" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --with-pin --data "$STORE_DIR" --feed "$FEED" \
  --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$CLEANER=YES" \
  --reply "$OWNER=guests have left"
cp "$STORE_DIR/cleaner-core.json" "$EVIDENCE/pin-stored/store.json"
rm -rf "$STORE_DIR"
assert_journey pin-stored "$EVIDENCE/pin-stored/smoke.stdout.txt"

doctor "$EVIDENCE/stop-holds"
run_smoke "$EVIDENCE/stop-holds" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --with-pin --feed "$FEED" \
  --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$CLEANER=YES" \
  --reply "$CLEANER=STOP" --reply "$OWNER=guests have left" --reply "$CLEANER=START"
assert_journey stop-holds "$EVIDENCE/stop-holds/smoke.stdout.txt"

doctor "$EVIDENCE/help-waiting"
run_smoke "$EVIDENCE/help-waiting" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --with-pin --feed "$FEED" \
  --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$CLEANER=YES" \
  --now "$AFTER" --reply "$CLEANER=HELP" --reply "$OWNER=I fell and I'm hurt" --reply "$CLEANER=I fell and I'm hurt"
assert_journey help-waiting "$EVIDENCE/help-waiting/smoke.stdout.txt"

doctor "$EVIDENCE/help-cleared"
run_smoke "$EVIDENCE/help-cleared" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --with-pin --feed "$FEED" \
  --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$CLEANER=YES" \
  --now "$AFTER" --reply "$OWNER=guests have left" \
  --reply "$CLEANER=HELP" --reply "$OWNER=I fell and I'm hurt" --reply "$CLEANER=I fell and I'm hurt"
assert_journey help-cleared "$EVIDENCE/help-cleared/smoke.stdout.txt"

doctor "$EVIDENCE/help-progress"
run_smoke "$EVIDENCE/help-progress" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --with-pin --feed "$FEED" \
  --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$CLEANER=YES" \
  --now "$AFTER" --reply "$OWNER=guests have left" --reply "$CLEANER=START" \
  --reply "$CLEANER=HELP" --reply "$OWNER=I fell and I'm hurt" --reply "$CLEANER=I fell and I'm hurt"
assert_journey help-progress "$EVIDENCE/help-progress/smoke.stdout.txt"

doctor "$EVIDENCE/injury-failed"
run_smoke "$EVIDENCE/injury-failed" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --with-pin --feed "$FEED" \
  --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$CLEANER=YES" \
  --fail-sends 1 --reply "$CLEANER=I fell and I'm hurt" --reply "$CLEANER=I fell and I'm hurt"
assert_journey injury-failed "$EVIDENCE/injury-failed/smoke.stdout.txt"

doctor "$EVIDENCE/pin-failed"
FAIL_DIR="$(mktemp -d)"
run_smoke "$EVIDENCE/pin-failed" failed env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --with-pin --data "$FAIL_DIR" --feed "$FEED" \
  --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$CLEANER=YES" \
  --now "$AFTER" --fail-sends 1 --reply "$OWNER=guests have left"
run_smoke "$EVIDENCE/pin-failed" retry env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --with-pin --data "$FAIL_DIR" --no-poll --remind
run_smoke "$EVIDENCE/pin-failed" again env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --with-pin --data "$FAIL_DIR" --no-poll --remind
cp "$FAIL_DIR/cleaner-core.json" "$EVIDENCE/pin-failed/store.json"
rm -rf "$FAIL_DIR"
assert_journey pin-failed \
  "$EVIDENCE/pin-failed/failed.stdout.txt" \
  "$EVIDENCE/pin-failed/retry.stdout.txt" \
  "$EVIDENCE/pin-failed/again.stdout.txt"

doctor "$EVIDENCE/no-group"
run_smoke "$EVIDENCE/no-group" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --with-pin --group "$UNAPPROVED" --feed "$FEED" \
  --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$CLEANER=YES" \
  --reply "$OWNER=guests have left"
assert_journey no-group "$EVIDENCE/no-group/smoke.stdout.txt"

if grep -R -n -E "$PIN_PATTERN" "$EVIDENCE" >/dev/null; then
  fail "step D evidence contains the scratch door code"
fi

cat >"$EVIDENCE/result.txt" <<EOF
features: held released not-opted unapproved-yes not-approved checkout-moved full-turn done-without-start done-early pin-stored stop-holds help-waiting help-cleared help-progress injury-failed pin-failed no-group
script: .cursor/skills/verify-cleanercore/scripts/prove-step-d.sh
pin: redacted
EOF

cat >"$EVIDENCE/stand-in.txt" <<'EOF'
This run used the in-process doctor/smoke CLI. A live cleaning job will not do these steps. They stay unverified until a run on that live target covers them. That run still uses only Scratch test numbers.

1. Started tsx via npm run cleaner:doctor and npm run cleaner:smoke in this checkout. A hosted job is not launched that way.
2. Read the Guesty Lite fixture src/cleaner-core/fixtures/guesty-lite-scratch.ics. Did not fetch a Guesty Lite URL.
3. Froze time with --now or the smoke default 2026-10-14T15:00:00.000Z. Did not use the wall clock.
4. Pushed texts onto an in-memory array, or a JSON file under a temporary --data directory, and printed JSON. Did not call a messaging provider. The temporary directory was removed. The saved stdout, transcript, job list, and outbox were not.
5. Applied each --reply inside the process. Did not receive an inbound SMS.
6. Printed the private door code as [redacted]. The scratch digits are not in this folder.
EOF

printf '%s\n' "$EVIDENCE"
