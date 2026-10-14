#!/usr/bin/env bash
# Prove the step F blocker journeys through the doctor/smoke CLI.
# No arguments. Never texts a phone. Overwrites evidence/step-f.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  printf '%s\n' "prove-step-f.sh takes no arguments and accepts no phone number." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
SKILL="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE="$SKILL/evidence/step-f"
rm -rf "$EVIDENCE"
mkdir -p "$EVIDENCE"
cd "$ROOT"
PIN_PATTERN="$(node "$ROOT/scripts/scratch-pin-pattern.mjs")"

if [[ ! -x node_modules/.bin/tsx ]]; then
  printf '%s\n' "tsx is missing. From the repo root run: npm ci" >&2
  exit 1
fi

GUESTY="$ROOT/src/cleaner-core/fixtures/guesty-lite-scratch.ics"
LANE_READ="$ROOT/src/cleaner-core/fixtures/notion-lane-read.json"
LANE_REMOVED="$ROOT/src/cleaner-core/fixtures/notion-lane-removed.json"
LANE_DENIED="$ROOT/src/cleaner-core/fixtures/notion-lane-denied.json"
LANE_OVERLAP="$ROOT/src/cleaner-core/fixtures/notion-lane-overlap.json"
COURT_STAY="$ROOT/src/cleaner-core/fixtures/notion-court-stay.json"
ANNEX="$ROOT/src/cleaner-core/fixtures/notion-annex.json"
LOCK="@src/cleaner-core/fixtures/annex-lock.txt"
OWNER="+15555550100"
CLEANER="+15555550101"
OBSERVER="+15555550122"
UNAPPROVED="+15555550199"
COURT_OWNER="+15555550110"
ANNEX_HOST="+15555550120"
ANNEX_CLEANER="+15555550121"
DUE="2026-10-18T12:00:00.000Z"
HURT="I fell and I'm hurt"

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
  if ! node "$SKILL/scripts/assert-step-f.mjs" "$name" "$@"; then
    fail "feature: $name"
  fi
  printf '%s\n' "feature: $name" >"$EVIDENCE/$name/result.txt"
  printf '%s\n' "pass" >>"$EVIDENCE/$name/result.txt"
}

smoke() {
  env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- "$@"
}

doctor "$EVIDENCE/notion-permission-denied"
run_smoke "$EVIDENCE/notion-permission-denied" smoke smoke --closed --notion "$LANE_DENIED"
assert_journey notion-permission-denied "$EVIDENCE/notion-permission-denied/smoke.stdout.txt"

doctor "$EVIDENCE/notion-source-read"
run_smoke "$EVIDENCE/notion-source-read" smoke smoke --closed --notion "$LANE_READ"
assert_journey notion-source-read "$EVIDENCE/notion-source-read/smoke.stdout.txt"

doctor "$EVIDENCE/notion-sync-repeat"
SYNC_DIR="$(mktemp -d)"
run_smoke "$EVIDENCE/notion-sync-repeat" smoke smoke --closed --data "$SYNC_DIR" \
  --notion "$LANE_READ" --notion "$LANE_READ" --notion "$LANE_READ"
run_smoke "$EVIDENCE/notion-sync-repeat" restart smoke --closed --data "$SYNC_DIR" --notion "$LANE_READ"
rm -rf "$SYNC_DIR"
assert_journey notion-sync-repeat \
  "$EVIDENCE/notion-sync-repeat/smoke.stdout.txt" \
  "$EVIDENCE/notion-sync-repeat/restart.stdout.txt"

doctor "$EVIDENCE/notion-removed"
run_smoke "$EVIDENCE/notion-removed" smoke smoke --with-pin \
  --notion "$LANE_READ" \
  --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$CLEANER=YES" \
  --now "$DUE" --remind \
  --notion "$LANE_REMOVED" --remind --notion "$LANE_REMOVED"
assert_journey notion-removed "$EVIDENCE/notion-removed/smoke.stdout.txt"

doctor "$EVIDENCE/notion-cleaner-routing"
run_smoke "$EVIDENCE/notion-cleaner-routing" smoke smoke --with-pin \
  --notion "$LANE_READ" \
  --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$CLEANER=YES"
assert_journey notion-cleaner-routing "$EVIDENCE/notion-cleaner-routing/smoke.stdout.txt"

doctor "$EVIDENCE/group-no-optin"
run_smoke "$EVIDENCE/group-no-optin" smoke smoke \
  --group-mode native --group-capable --feed "$GUESTY" \
  --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES"
assert_journey group-no-optin "$EVIDENCE/group-no-optin/smoke.stdout.txt"

doctor "$EVIDENCE/multi-source-dedupe"
run_smoke "$EVIDENCE/multi-source-dedupe" smoke smoke --closed --feed "$GUESTY" --notion "$LANE_OVERLAP"
assert_journey multi-source-dedupe "$EVIDENCE/multi-source-dedupe/smoke.stdout.txt"

doctor "$EVIDENCE/onboarding-full"
run_smoke "$EVIDENCE/onboarding-full" smoke smoke --onboard --notion "$ANNEX" \
  --reply "$ANNEX_HOST=Annex | 9 Scratch Annex, Teaneck, NJ 07666 | America/New_York | 11:00 AM | 4:00 PM | $ANNEX_HOST" \
  --reply "$ANNEX_HOST=Guesty Lite and Notion. Yes, early check-ins and late checkouts are agreed on Airbnb, outside that calendar." \
  --reply "$ANNEX_HOST=OK" \
  --reply "$ANNEX_HOST=Cleaner $ANNEX_CLEANER. Observer Cory $OBSERVER." \
  --reply "$ANNEX_CLEANER=YES" --reply "$OBSERVER=YES" \
  --reply "$ANNEX_HOST=Morning of checkout, and after you say the guests have left. Quiet hours 9:00 PM to 8:00 AM. Escalate to the host." \
  --reply "$ANNEX_HOST=$LOCK" \
  --reply "$ANNEX_HOST=SKIP" \
  --reply "$ANNEX_HOST=APPROVE"
assert_journey onboarding-full "$EVIDENCE/onboarding-full/smoke.stdout.txt"

doctor "$EVIDENCE/onboarding-no-optin"
run_smoke "$EVIDENCE/onboarding-no-optin" smoke smoke --onboard --notion "$ANNEX" \
  --reply "$ANNEX_HOST=Annex | 9 Scratch Annex, Teaneck, NJ 07666 | America/New_York | 11:00 AM | 4:00 PM | $ANNEX_HOST" \
  --reply "$ANNEX_HOST=Notion. Yes, late checkouts are agreed on Airbnb, outside that calendar." \
  --reply "$ANNEX_HOST=OK" \
  --reply "$ANNEX_HOST=Cleaner $ANNEX_CLEANER. Observer Cory $OBSERVER." \
  --reply "$ANNEX_HOST=Morning of checkout. Quiet hours 9:00 PM to 8:00 AM. Escalate to the host." \
  --reply "$ANNEX_HOST=$LOCK" \
  --reply "$ANNEX_HOST=SKIP" \
  --reply "$ANNEX_HOST=APPROVE"
assert_journey onboarding-no-optin "$EVIDENCE/onboarding-no-optin/smoke.stdout.txt"

doctor "$EVIDENCE/group-native-consented"
run_smoke "$EVIDENCE/group-native-consented" smoke smoke \
  --with-pin --group-mode native --group-capable --participant "observer=$OBSERVER" \
  --feed "$GUESTY" \
  --reply "$CLEANER=YES" --reply "$OBSERVER=YES" \
  --reply "$OWNER=YES" --reply "$OWNER=YES"
assert_journey group-native-consented "$EVIDENCE/group-native-consented/smoke.stdout.txt"

doctor "$EVIDENCE/group-mirrored-fallback"
run_smoke "$EVIDENCE/group-mirrored-fallback" smoke smoke \
  --with-pin --group-mode mirrored --participant "observer=$OBSERVER" \
  --feed "$GUESTY" \
  --reply "$CLEANER=YES" --reply "$OBSERVER=YES" \
  --reply "$OWNER=YES" --reply "$OWNER=YES"
assert_journey group-mirrored-fallback "$EVIDENCE/group-mirrored-fallback/smoke.stdout.txt"

doctor "$EVIDENCE/group-unconsented-participant"
run_smoke "$EVIDENCE/group-unconsented-participant" held smoke \
  --with-pin --group-mode native --group-capable --participant "observer=$OBSERVER" \
  --feed "$GUESTY" \
  --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES"
run_smoke "$EVIDENCE/group-unconsented-participant" smoke smoke \
  --with-pin --group-mode native --group-capable --participant "observer=$OBSERVER" \
  --feed "$GUESTY" \
  --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" \
  --reply "$OBSERVER=STOP" --reply "$OBSERVER=HELP"
assert_journey group-unconsented-participant \
  "$EVIDENCE/group-unconsented-participant/held.stdout.txt" \
  "$EVIDENCE/group-unconsented-participant/smoke.stdout.txt"

doctor "$EVIDENCE/pin-private-only"
run_smoke "$EVIDENCE/pin-private-only" smoke smoke \
  --with-pin --group-mode native --group-capable --group "$UNAPPROVED" --participant "observer=$OBSERVER" \
  --feed "$GUESTY" \
  --reply "$CLEANER=YES" --reply "$OBSERVER=YES" \
  --reply "$OWNER=YES" --reply "$OWNER=YES" \
  --reply "$CLEANER=YES" --reply "$OWNER=guests have left"
assert_journey pin-private-only "$EVIDENCE/pin-private-only/smoke.stdout.txt"

doctor "$EVIDENCE/tenant-isolation"
SHARED="$(mktemp -d)"
run_smoke "$EVIDENCE/tenant-isolation" lane smoke --tenant scratch-lane --closed --data "$SHARED" --notion "$LANE_READ"
run_smoke "$EVIDENCE/tenant-isolation" court smoke --tenant scratch-court --closed --data "$SHARED" --notion "$COURT_STAY"
run_smoke "$EVIDENCE/tenant-isolation" onboard smoke --onboard --data "$SHARED" --notion "$ANNEX" \
  --reply "$ANNEX_HOST=Annex | 9 Scratch Annex, Teaneck, NJ 07666 | America/New_York | 11:00 AM | 4:00 PM | $ANNEX_HOST" \
  --reply "$ANNEX_HOST=Notion. No Airbnb timing exception." \
  --reply "$ANNEX_HOST=OK" \
  --reply "$ANNEX_HOST=Cleaner $ANNEX_CLEANER. Observer Cory $OBSERVER." \
  --reply "$ANNEX_CLEANER=YES" --reply "$OBSERVER=YES" \
  --reply "$ANNEX_HOST=Morning of checkout. Quiet hours 9:00 PM to 8:00 AM. Escalate to the host." \
  --reply "$ANNEX_HOST=$LOCK" \
  --reply "$ANNEX_HOST=SKIP" \
  --reply "$ANNEX_HOST=APPROVE"
run_smoke "$EVIDENCE/tenant-isolation" lane-left smoke --tenant scratch-lane --no-poll --data "$SHARED"
rm -rf "$SHARED"
assert_journey tenant-isolation \
  "$EVIDENCE/tenant-isolation/lane.stdout.txt" \
  "$EVIDENCE/tenant-isolation/court.stdout.txt" \
  "$EVIDENCE/tenant-isolation/onboard.stdout.txt" \
  "$EVIDENCE/tenant-isolation/lane-left.stdout.txt"

doctor "$EVIDENCE/stop-help-injury"
run_smoke "$EVIDENCE/stop-help-injury" stop smoke --closed --notion "$LANE_READ" --reply "$OWNER=STOP"
run_smoke "$EVIDENCE/stop-help-injury" help smoke --closed --notion "$LANE_READ" --reply "$OWNER=HELP"
run_smoke "$EVIDENCE/stop-help-injury" injury smoke --closed --notion "$LANE_READ" \
  --reply "$OWNER=$HURT" --reply "$OWNER=$HURT" \
  --reply "$CLEANER=$HURT" --reply "$CLEANER=$HURT"
assert_journey stop-help-injury \
  "$EVIDENCE/stop-help-injury/stop.stdout.txt" \
  "$EVIDENCE/stop-help-injury/help.stdout.txt" \
  "$EVIDENCE/stop-help-injury/injury.stdout.txt"

doctor "$EVIDENCE/observer-injury-group"
run_smoke "$EVIDENCE/observer-injury-group" smoke smoke \
  --with-pin --group-mode native --group-capable --participant "observer=$OBSERVER" \
  --notion "$LANE_READ" \
  --reply "$CLEANER=YES" --reply "$OBSERVER=YES" \
  --reply "$OBSERVER=$HURT" --reply "$OBSERVER=$HURT"
assert_journey observer-injury-group "$EVIDENCE/observer-injury-group/smoke.stdout.txt"

doctor "$EVIDENCE/observer-injury-solo"
run_smoke "$EVIDENCE/observer-injury-solo" smoke smoke \
  --group-mode cleaner-only --participant "observer=$OBSERVER" \
  --notion "$LANE_READ" \
  --reply "$OBSERVER=$HURT" --reply "$OBSERVER=$HURT"
assert_journey observer-injury-solo "$EVIDENCE/observer-injury-solo/smoke.stdout.txt"

doctor "$EVIDENCE/owner-injury"
run_smoke "$EVIDENCE/owner-injury" smoke smoke --notion "$LANE_READ" \
  --reply "$OWNER=$HURT" --reply "$OWNER=$HURT"
assert_journey owner-injury "$EVIDENCE/owner-injury/smoke.stdout.txt"

doctor "$EVIDENCE/injury-wording"
WORD_REPORTS=()
word_i=0
while IFS= read -r phrase; do
  for mode in solo group; do
    name="phrase-${word_i}-${mode}"
    if [[ "$mode" == "group" ]]; then
      run_smoke "$EVIDENCE/injury-wording" "$name" smoke \
        --with-pin --group-mode native --group-capable --participant "observer=$OBSERVER" \
        --notion "$LANE_READ" \
        --reply "$CLEANER=YES" --reply "$OBSERVER=YES" \
        --reply "$CLEANER=$phrase" --reply "$OBSERVER=$phrase"
    else
      run_smoke "$EVIDENCE/injury-wording" "$name" smoke \
        --group-mode cleaner-only --participant "observer=$OBSERVER" \
        --notion "$LANE_READ" \
        --reply "$CLEANER=$phrase" --reply "$OBSERVER=$phrase"
    fi
    WORD_REPORTS+=("$EVIDENCE/injury-wording/${name}.stdout.txt")
  done
  word_i=$((word_i + 1))
done <<'PHRASES'
she's hurt
Cleaner fell down the stairs, she's hurt
there's blood everywhere
someone got hurt
I'm injured
she fell and can't get up
I fell and I'm hurt
PHRASES
assert_journey injury-wording "${WORD_REPORTS[@]}"
run_smoke "$EVIDENCE/injury-wording" everyday smoke \
  --group-mode cleaner-only --participant "observer=$OBSERVER" \
  --notion "$LANE_READ" \
  --reply "$CLEANER=that hurt my schedule lol, running late"
node -e '
  const fs = require("node:fs");
  const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const emergencies = (report.sent ?? []).filter((text) => text.kind === "emergency");
  const lines = emergencies.map((text) => text.to + ": " + text.body);
  const note = lines.length > 0
    ? "everyday from +15555550101, one-to-one: \"that hurt my schedule lol, running late\" was treated as an injury.\n" + lines.join("\n")
    : "everyday from +15555550101, one-to-one: \"that hurt my schedule lol, running late\" was not treated as an injury.";
  fs.appendFileSync(process.argv[2], note + "\n");
' "$EVIDENCE/injury-wording/everyday.stdout.txt" "$EVIDENCE/injury-wording/result.txt"

if grep -R -n -E "$PIN_PATTERN" "$EVIDENCE" >/dev/null; then
  fail "step F evidence contains a scratch door code"
fi

cat >"$EVIDENCE/result.txt" <<EOF
features: notion-permission-denied notion-source-read notion-sync-repeat notion-removed notion-cleaner-routing group-no-optin multi-source-dedupe onboarding-full onboarding-no-optin group-native-consented group-mirrored-fallback group-unconsented-participant pin-private-only tenant-isolation stop-help-injury observer-injury-group observer-injury-solo owner-injury injury-wording
script: .cursor/skills/verify-cleanercore/scripts/prove-step-f.sh
pins: redacted
EOF

cat >"$EVIDENCE/stand-in.txt" <<'EOF'
This run used the in-process doctor/smoke CLI. A live cleaning job will not do these steps. They stay unverified until a run on that live target covers them. That run still uses only Scratch test numbers.

1. Started tsx via npm run cleaner:doctor and npm run cleaner:smoke in this checkout. A hosted job is not launched that way.
2. Read Guesty Lite and Notion fixtures under src/cleaner-core/fixtures/. Did not call Notion, did not write a Notion database, and did not use a Notion account or credential.
3. Froze time at the smoke default 2026-10-14T15:00:00.000Z, or at the --now instant a journey passed. Did not use the wall clock.
4. Pushed texts onto an in-memory array, or a JSON file under a temporary --data directory, and printed JSON. Did not call a messaging provider. The tenant-isolation drive kept Scratch Lane, Scratch Court, and the onboarded property in that one directory. The temporary directory was removed. The saved stdout, transcript, job list, and outbox were not.
5. Applied each --reply inside the process. A reply that starts with @ reads a fixture file inside the process. Neither path received an inbound SMS. --closed means the sync ran with no open conversation.
6. Printed no door code. The scratch digits are not in this folder. A group text and a mirrored copy do not carry the door code.
EOF

printf '%s\n' "$EVIDENCE"
