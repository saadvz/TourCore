#!/usr/bin/env bash
# Prove the step E blocker journeys through the doctor/smoke CLI.
# No arguments. Never texts a phone. Overwrites evidence/step-e.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  printf '%s\n' "prove-step-e.sh takes no arguments and accepts no phone number." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
SKILL="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE="$SKILL/evidence/step-e"
rm -rf "$EVIDENCE"
mkdir -p "$EVIDENCE"
cd "$ROOT"

if [[ ! -x node_modules/.bin/tsx ]]; then
  printf '%s\n' "tsx is missing. From the repo root run: npm ci" >&2
  exit 1
fi

GUESTY="$ROOT/src/cleaner-core/fixtures/guesty-lite-scratch.ics"
LANE_READ="$ROOT/src/cleaner-core/fixtures/google-lane-read.json"
LANE_OVERLAP="$ROOT/src/cleaner-core/fixtures/google-lane-overlap.json"
LANE_BLOCK="$ROOT/src/cleaner-core/fixtures/google-lane-block.json"
COURT_STAY="$ROOT/src/cleaner-core/fixtures/google-court-stay.json"
COURT_MOVED="$ROOT/src/cleaner-core/fixtures/google-court-stay-moved.json"
COURT_EMPTY="$ROOT/src/cleaner-core/fixtures/google-court-empty.json"
OWNER="+15555550100"
CLEANER="+15555550101"
COURT_OWNER="+15555550110"
COURT_CLEANER="+15555550111"

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
  if ! node "$SKILL/scripts/assert-step-e.mjs" "$name" "$@"; then
    fail "feature: $name"
  fi
  printf '%s\n' "feature: $name" >"$EVIDENCE/$name/result.txt"
  printf '%s\n' "pass" >>"$EVIDENCE/$name/result.txt"
}

doctor "$EVIDENCE/source-read"
run_smoke "$EVIDENCE/source-read" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --closed --google "$LANE_READ"
assert_journey source-read "$EVIDENCE/source-read/smoke.stdout.txt"

doctor "$EVIDENCE/closed-sync"
SYNC_DIR="$(mktemp -d)"
run_smoke "$EVIDENCE/closed-sync" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --tenant scratch-court --closed --data "$SYNC_DIR" \
  --google "$COURT_STAY" --google "$COURT_MOVED" --google "$COURT_MOVED"
run_smoke "$EVIDENCE/closed-sync" restart env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --tenant scratch-court --closed --data "$SYNC_DIR" --google "$COURT_MOVED"
rm -rf "$SYNC_DIR"
assert_journey closed-sync "$EVIDENCE/closed-sync/smoke.stdout.txt" "$EVIDENCE/closed-sync/restart.stdout.txt"

doctor "$EVIDENCE/removed"
run_smoke "$EVIDENCE/removed" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --tenant scratch-court --closed --google "$COURT_STAY" --google "$COURT_EMPTY"
assert_journey removed "$EVIDENCE/removed/smoke.stdout.txt"

doctor "$EVIDENCE/one-job"
run_smoke "$EVIDENCE/one-job" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --closed --feed "$GUESTY" --google "$LANE_OVERLAP"
assert_journey one-job "$EVIDENCE/one-job/smoke.stdout.txt"

doctor "$EVIDENCE/block"
run_smoke "$EVIDENCE/block" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --closed --google "$LANE_BLOCK"
assert_journey block "$EVIDENCE/block/smoke.stdout.txt"

doctor "$EVIDENCE/wrong-tenant"
run_smoke "$EVIDENCE/wrong-tenant" smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --tenant scratch-lane --closed --google "$COURT_STAY"
assert_journey wrong-tenant "$EVIDENCE/wrong-tenant/smoke.stdout.txt"

doctor "$EVIDENCE/tenant-isolation"
SHARED="$(mktemp -d)"
run_smoke "$EVIDENCE/tenant-isolation" lane env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --tenant scratch-lane --with-pin --data "$SHARED" \
  --feed "$GUESTY" \
  --reply "$COURT_CLEANER=YES" \
  --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$CLEANER=YES" \
  --reply "$COURT_OWNER=guests have left"
run_smoke "$EVIDENCE/tenant-isolation" court env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --tenant scratch-court --with-pin --data "$SHARED" \
  --google "$COURT_STAY" \
  --reply "$CLEANER=YES" \
  --reply "$COURT_CLEANER=YES" --reply "$COURT_OWNER=YES" --reply "$COURT_CLEANER=YES" \
  --reply "$OWNER=guests have left"
run_smoke "$EVIDENCE/tenant-isolation" lane-left env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --tenant scratch-lane --with-pin --data "$SHARED" --no-poll \
  --reply "$OWNER=guests have left"
run_smoke "$EVIDENCE/tenant-isolation" court-left env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --tenant scratch-court --with-pin --data "$SHARED" --no-poll \
  --reply "$COURT_OWNER=guests have left"
cp "$SHARED/cleaner-core.json" "$EVIDENCE/tenant-isolation/store.json"
rm -rf "$SHARED"
assert_journey tenant-isolation \
  "$EVIDENCE/tenant-isolation/lane.stdout.txt" \
  "$EVIDENCE/tenant-isolation/court.stdout.txt" \
  "$EVIDENCE/tenant-isolation/lane-left.stdout.txt" \
  "$EVIDENCE/tenant-isolation/court-left.stdout.txt" \
  "$EVIDENCE/tenant-isolation/store.json"

if grep -R -n -E '4821|7392' "$EVIDENCE" >/dev/null; then
  fail "step E evidence contains a scratch door code"
fi

cat >"$EVIDENCE/result.txt" <<EOF
features: source-read closed-sync removed one-job block wrong-tenant tenant-isolation
script: .cursor/skills/verify-cleanercore/scripts/prove-step-e.sh
pins: redacted
EOF

cat >"$EVIDENCE/stand-in.txt" <<'EOF'
This run used the in-process doctor/smoke CLI. A live cleaning job will not do these steps. They stay unverified until a run on that live target covers them. That run still uses only Scratch test numbers.

1. Started tsx via npm run cleaner:doctor and npm run cleaner:smoke in this checkout. A hosted job is not launched that way.
2. Read Guesty Lite and Google Calendar fixtures under src/cleaner-core/fixtures/. Did not fetch a Guesty Lite URL, did not call Google, and did not use a Google account or credential.
3. Froze time at the smoke default 2026-10-14T15:00:00.000Z. Did not use the wall clock.
4. Pushed texts onto an in-memory array, or a JSON file under a temporary --data directory, and printed JSON. Did not call a messaging provider. The tenant-isolation drive kept both Scratch tenants in that one directory. The temporary directory was removed. The saved stdout, transcript, job list, outbox, and shared store were not.
5. Applied each --reply inside the process. A --closed drive applied no reply. Neither path received an inbound SMS. Closed means the sync ran with no open conversation.
6. Printed no door code. The scratch digits are not in this folder.
EOF

printf '%s\n' "$EVIDENCE"
