#!/usr/bin/env bash
# Drive the safety journeys through the doctor/smoke CLI.
# No arguments. Never texts a phone. Leaves evidence in place.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  printf '%s\n' "prove-safety.sh takes no arguments and accepts no phone number." >&2
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

run_in() {
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
  printf '%s\n' "$code"
}

fail() {
  printf '%s\n' "$1" | tee "$EVIDENCE/result.txt" >&2
  printf '%s\n' "evidence: $EVIDENCE" >&2
  exit 1
}

doctor_for() {
  local feature="$1"
  local mode="$2"
  local dir="$EVIDENCE/$feature"
  local code expected
  if [[ "$mode" == "on" ]]; then
    code="$(run_in "$dir" doctor env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor)"
    expected="$SKILL/scripts/expected/doctor-on.json"
  else
    code="$(run_in "$dir" doctor env -u CLEANER_CORE_ENABLED npm run --silent cleaner:doctor)"
    expected="$SKILL/scripts/expected/doctor-off.json"
  fi
  if [[ "$code" != "0" ]]; then
    fail "feature: $feature doctor exit $code"
  fi
  if ! node "$SKILL/scripts/assert-report.mjs" doctor "$dir/doctor.stdout.txt" "$expected"; then
    fail "feature: $feature doctor stdout mismatch"
  fi
}

smoke_for() {
  local feature="$1"
  local want_exit="$2"
  local pin_mode="$3"
  local expected="$4"
  shift 4
  local dir="$EVIDENCE/$feature"
  local code
  code="$(run_in "$dir" smoke "$@")"
  if [[ "$code" != "$want_exit" ]]; then
    fail "feature: $feature smoke exit $code"
  fi
  if ! node "$SKILL/scripts/assert-report.mjs" smoke "$dir/smoke.stdout.txt" "$SKILL/scripts/expected/$expected" "$pin_mode"; then
    fail "feature: $feature smoke stdout mismatch"
  fi
  cat >"$dir/result.txt" <<EOF
feature: $feature
entry: $*
doctor_exit: 0
smoke_exit: $want_exit
scratch: pass
pin: $pin_mode
EOF
  printf '%s\n' "$dir"
}

doctor_for flag-off off
smoke_for flag-off 2 forbidden smoke-off.json \
  env -u CLEANER_CORE_ENABLED npm run --silent cleaner:smoke -- --reply +15555550100=YES

doctor_for stop on
smoke_for stop 0 forbidden smoke-stop.json \
  env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --reply +15555550100=STOP --reply +15555550100=YES

doctor_for help on
smoke_for help 0 forbidden smoke-help.json \
  env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --reply +15555550100=HELP

doctor_for injury on
smoke_for injury 0 forbidden smoke-injury.json \
  env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- \
  --reply "+15555550100=I fell and I'm hurt" \
  --reply "+15555550100=I fell and I'm hurt" \
  --reply "+15555550101=I fell and I'm hurt" \
  --reply "+15555550101=I fell and I'm hurt"

doctor_for unapproved-yes on
smoke_for unapproved-yes 0 forbidden smoke-unapproved.json \
  env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --reply +15555550199=YES

cat >"$EVIDENCE/result.txt" <<EOF
features: flag-off stop help injury unapproved-yes
script: .cursor/skills/verify-cleanercore/scripts/prove-safety.sh
EOF

cat >"$EVIDENCE/stand-in.txt" <<'EOF'
This run used the in-process doctor/smoke CLI. A live cleaning job will not do these steps. They stay unverified until a run on that live target covers them. That run still uses only Scratch test numbers.

1. Started tsx via npm run cleaner:doctor and npm run cleaner:smoke in this checkout. A hosted job is not launched that way.
2. Read the iCal fixture inside src/cleaner-core/cli.ts, including the folded checkout date. Did not fetch a Guesty Lite feed.
3. Froze time at 2026-10-14T15:00:00.000Z. Did not use the wall clock.
4. Pushed texts onto an in-memory array and printed JSON. Did not call a messaging provider.
5. Applied each --reply inside the process. Did not receive an inbound SMS. When no --reply is passed, smoke still injects YES from +15555550100. This safety run passed --reply and did not add that YES.

Smoke offers one turnover. This run does not open a second job, so a later job sending the emergency line again stays unverified here.
EOF
