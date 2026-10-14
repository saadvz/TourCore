#!/usr/bin/env bash
# Prove the ten step C blocker journeys through the doctor/smoke CLI.
# No arguments. Never texts a phone. Leaves evidence in place.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  printf '%s\n' "prove-step-c.sh takes no arguments and accepts no phone number." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
SKILL="$(cd "$(dirname "$0")/.." && pwd)"
RUN_ID="${VERIFY_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
EVIDENCE="$SKILL/evidence/$RUN_ID/step-c"
mkdir -p "$EVIDENCE"
cd "$ROOT"

if [[ ! -x node_modules/.bin/tsx ]]; then
  printf '%s\n' "tsx is missing. From the repo root run: npm ci" >&2
  exit 1
fi

FEED="$ROOT/src/cleaner-core/fixtures"
OWNER="+15555550100"
CLEANER="+15555550101"
DUE="2026-10-18T12:00:00.000Z"

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
  if ! node "$SKILL/scripts/assert-step-c.mjs" "$name" "$@"; then
    fail "feature: $name"
  fi
  printf '%s\n' "feature: $name" >"$EVIDENCE/$name/result.txt"
  printf '%s\n' "pass" >>"$EVIDENCE/$name/result.txt"
}

# 1. Read the Guesty Lite fixture.
doctor "$EVIDENCE/read-feed"
run_smoke "$EVIDENCE/read-feed" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --feed "$FEED/guesty-lite-scratch.ics"
assert_journey read-feed "$EVIDENCE/read-feed/smoke.stdout.txt"

# 2. Host time wins over a later calendar clock.
doctor "$EVIDENCE/host-time"
run_smoke "$EVIDENCE/host-time" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --feed "$FEED/guesty-lite-scratch.ics" \
  --reply "$OWNER=1:00 PM" \
  --reply "$OWNER=YES" \
  --then-feed "$FEED/guesty-lite-clock-bait.ics"
assert_journey host-time "$EVIDENCE/host-time/smoke.stdout.txt"

# 3. Corrected text after an offer.
doctor "$EVIDENCE/corrected-time"
run_smoke "$EVIDENCE/corrected-time" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --feed "$FEED/guesty-lite-scratch.ics" \
  --reply "$OWNER=1:00 PM" \
  --reply "$OWNER=YES" \
  --reply "$OWNER=YES" \
  --then-feed "$FEED/guesty-lite-date-moved.ics"
assert_journey corrected-time "$EVIDENCE/corrected-time/smoke.stdout.txt"

# 4. One reminder across a second poll and a restart.
doctor "$EVIDENCE/reminder-once"
REMIND_DIR="$(mktemp -d)"
run_smoke "$EVIDENCE/reminder-once" first env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --data "$REMIND_DIR" --now "$DUE" \
  --feed "$FEED/guesty-lite-scratch.ics" \
  --feed "$FEED/guesty-lite-scratch.ics" \
  --reply "$OWNER=YES" --reply "$OWNER=YES" \
  --remind --remind
run_smoke "$EVIDENCE/reminder-once" restart env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --data "$REMIND_DIR" --no-poll --now "$DUE" --remind
assert_journey reminder-once "$EVIDENCE/reminder-once/first.stdout.txt" "$EVIDENCE/reminder-once/restart.stdout.txt"
rm -rf "$REMIND_DIR"

# 5. Blocks create no job.
doctor "$EVIDENCE/blocks"
run_smoke "$EVIDENCE/blocks" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --feed "$FEED/guesty-lite-blocks-only.ics"
assert_journey blocks "$EVIDENCE/blocks/smoke.stdout.txt"

# 6. A removed stay leaves one canceled job.
doctor "$EVIDENCE/one-live-job"
run_smoke "$EVIDENCE/one-live-job" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --feed "$FEED/guesty-lite-scratch.ics" \
  --reply "$OWNER=YES" --reply "$OWNER=YES" \
  --then-feed "$FEED/guesty-lite-stay-removed.ics"
assert_journey one-live-job "$EVIDENCE/one-live-job/smoke.stdout.txt"

# 7. STOP silences the owner.
doctor "$EVIDENCE/stop-silences"
run_smoke "$EVIDENCE/stop-silences" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --now "$DUE" \
  --feed "$FEED/guesty-lite-scratch.ics" \
  --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$OWNER=STOP" \
  --then-feed "$FEED/guesty-lite-date-moved.ics" \
  --remind
assert_journey stop-silences "$EVIDENCE/stop-silences/smoke.stdout.txt"

# 8. No door code.
doctor "$EVIDENCE/no-pin"
PIN_DIR="$(mktemp -d)"
run_smoke "$EVIDENCE/no-pin" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --data "$PIN_DIR" \
  --feed "$FEED/guesty-lite-scratch.ics" \
  --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES"
cp "$PIN_DIR/cleaner-core.json" "$EVIDENCE/no-pin/store.json"
if grep -q "4821" "$EVIDENCE/no-pin/smoke.stdout.txt" "$EVIDENCE/no-pin/store.json" "$EVIDENCE/no-pin/smoke.stderr.txt"; then
  fail "feature: no-pin leaked the scratch code"
fi
assert_journey no-pin "$EVIDENCE/no-pin/smoke.stdout.txt"
rm -rf "$PIN_DIR"

# 9. Safety replies in the three new states.
doctor "$EVIDENCE/safety-states"
safety_one() {
  local name="$1"
  shift
  run_smoke "$EVIDENCE/safety-states" "$name" env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- "$@"
}
safety_one waiting-stop --feed "$FEED/guesty-lite-scratch.ics" --reply "$OWNER=STOP"
safety_one waiting-help --feed "$FEED/guesty-lite-scratch.ics" --reply "$OWNER=HELP"
safety_one waiting-emergency --feed "$FEED/guesty-lite-scratch.ics" --reply "$OWNER=I fell and I'm hurt"
safety_one offered-stop --feed "$FEED/guesty-lite-scratch.ics" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$OWNER=STOP"
safety_one offered-help --feed "$FEED/guesty-lite-scratch.ics" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$OWNER=HELP"
safety_one offered-emergency --feed "$FEED/guesty-lite-scratch.ics" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$OWNER=I fell and I'm hurt"
safety_one corrected-stop --feed "$FEED/guesty-lite-scratch.ics" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" --then-feed "$FEED/guesty-lite-date-moved.ics" --reply "$OWNER=STOP"
safety_one corrected-help --feed "$FEED/guesty-lite-scratch.ics" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" --then-feed "$FEED/guesty-lite-date-moved.ics" --reply "$OWNER=HELP"
safety_one corrected-emergency --feed "$FEED/guesty-lite-scratch.ics" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" --then-feed "$FEED/guesty-lite-date-moved.ics" --reply "$OWNER=I fell and I'm hurt" --reply "$CLEANER=I fell and I'm hurt"
assert_journey safety-states \
  "$EVIDENCE/safety-states/waiting-stop.stdout.txt" \
  "$EVIDENCE/safety-states/waiting-help.stdout.txt" \
  "$EVIDENCE/safety-states/waiting-emergency.stdout.txt" \
  "$EVIDENCE/safety-states/offered-stop.stdout.txt" \
  "$EVIDENCE/safety-states/offered-help.stdout.txt" \
  "$EVIDENCE/safety-states/offered-emergency.stdout.txt" \
  "$EVIDENCE/safety-states/corrected-stop.stdout.txt" \
  "$EVIDENCE/safety-states/corrected-help.stdout.txt" \
  "$EVIDENCE/safety-states/corrected-emergency.stdout.txt"

# 10. A failed reminder is not delivered, and the retry sends it once.
doctor "$EVIDENCE/failed-send"
FAIL_DIR="$(mktemp -d)"
run_smoke "$EVIDENCE/failed-send" failed env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --data "$FAIL_DIR" --now "$DUE" \
  --feed "$FEED/guesty-lite-scratch.ics" \
  --reply "$OWNER=YES" --reply "$OWNER=YES" \
  --fail-sends 1 --remind
run_smoke "$EVIDENCE/failed-send" retry env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --data "$FAIL_DIR" --no-poll --now "$DUE" --remind
run_smoke "$EVIDENCE/failed-send" restart env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --data "$FAIL_DIR" --no-poll --now "$DUE" --remind
assert_journey failed-send \
  "$EVIDENCE/failed-send/failed.stdout.txt" \
  "$EVIDENCE/failed-send/retry.stdout.txt" \
  "$EVIDENCE/failed-send/restart.stdout.txt"
rm -rf "$FAIL_DIR"

if grep -R -n "4821" "$EVIDENCE" >/dev/null; then
  fail "step C evidence contains the scratch code"
fi

cat >"$EVIDENCE/result.txt" <<EOF
features: read-feed host-time corrected-time reminder-once blocks one-live-job stop-silences no-pin safety-states failed-send
script: .cursor/skills/verify-cleanercore/scripts/prove-step-c.sh
pin: absent
EOF

cat >"$EVIDENCE/stand-in.txt" <<'EOF'
This run used the in-process doctor/smoke CLI. A live cleaning job will not do these steps. They stay unverified until a run on that live target covers them. That run still uses only Scratch test numbers.

1. Started tsx via npm run cleaner:doctor and npm run cleaner:smoke in this checkout. A hosted job is not launched that way.
2. Read Guesty Lite fixture files under src/cleaner-core/fixtures. Did not fetch a Guesty Lite URL.
3. Froze time with --now or the smoke default 2026-10-14T15:00:00.000Z. Did not use the wall clock.
4. Pushed texts onto an in-memory array, or a JSON file under a temporary --data directory, and printed JSON. Did not call a messaging provider. The temporary directory was removed. The saved stdout, transcript, job list, and outbox were not.
5. Applied each --reply inside the process. Did not receive an inbound SMS.
EOF

printf '%s\n' "$EVIDENCE"
