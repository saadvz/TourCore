#!/usr/bin/env bash
# Prove feature same-day-turnover through the doctor/smoke CLI.
# No arguments. Never texts a phone. Leaves evidence in place.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  printf '%s\n' "prove-turnover.sh takes no arguments and accepts no phone number." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
SKILL="$(cd "$(dirname "$0")/.." && pwd)"
RUN_ID="${VERIFY_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
EVIDENCE="$SKILL/evidence/$RUN_ID"
mkdir -p "$EVIDENCE"

cd "$ROOT"

if [[ ! -x node_modules/.bin/tsx ]]; then
  printf '%s\n' "tsx is missing. From the repo root run: npm ci" >&2
  exit 1
fi

run_one() {
  local name="$1"
  shift
  printf '%s\n' "$*" >"$EVIDENCE/$name.command"
  set +e
  "$@" >"$EVIDENCE/$name.stdout.txt" 2>"$EVIDENCE/$name.stderr.txt"
  local code=$?
  set -e
  printf '%s\n' "$code" >"$EVIDENCE/$name.exit"
  printf '%s\n' "$code"
}

fail() {
  printf '%s\n' "$1" | tee "$EVIDENCE/result.txt" >&2
  printf '%s\n' "evidence: $EVIDENCE" >&2
  exit 1
}

doctor_code="$(run_one doctor env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor)"
if [[ "$doctor_code" != "0" ]]; then
  fail "feature: same-day-turnover doctor exit $doctor_code"
fi
if ! node "$SKILL/scripts/assert-report.mjs" doctor "$EVIDENCE/doctor.stdout.txt" "$SKILL/scripts/expected/doctor-on.json"; then
  fail "feature: same-day-turnover doctor stdout mismatch"
fi

smoke_code="$(run_one smoke env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke)"
if [[ "$smoke_code" != "0" ]]; then
  fail "feature: same-day-turnover smoke exit $smoke_code"
fi
if ! node "$SKILL/scripts/assert-report.mjs" smoke "$EVIDENCE/smoke.stdout.txt" "$SKILL/scripts/expected/smoke-turnover.json"; then
  fail "feature: same-day-turnover smoke stdout mismatch"
fi

cat >"$EVIDENCE/result.txt" <<EOF
feature: same-day-turnover
entry: CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke
doctor_exit: 0
smoke_exit: 0
scratch: pass
pin_recipient: +15555550101
EOF

cat >"$EVIDENCE/stand-in.txt" <<'EOF'
This run used the in-process doctor/smoke CLI. A live cleaning job will not do these steps. They stay unverified until a run on that live target covers them. That run still uses only Scratch test numbers.

1. Started tsx via npm run cleaner:doctor and npm run cleaner:smoke in this checkout. A hosted job is not launched that way.
2. Read the iCal fixture inside src/cleaner-core/cli.ts, including the folded checkout date. Did not fetch a Guesty Lite feed.
3. Froze time at 2026-10-14T15:00:00.000Z. Did not use the wall clock.
4. Pushed texts onto an in-memory array and printed JSON. Did not call a messaging provider.
5. Injected id smoke-yes from +15555550100 with text YES inside the process, because this command passed no --reply. Did not receive an inbound SMS.

Not driven by this script. Drive them with prove-safety.sh:
- flag-off, stop, help, injury, and unapproved-yes.
EOF

printf '%s\n' "$EVIDENCE"
