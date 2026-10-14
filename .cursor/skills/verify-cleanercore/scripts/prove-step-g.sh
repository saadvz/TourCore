#!/usr/bin/env bash
# Prove the step G safety gates through the doctor/smoke CLI.
# No arguments. Never texts a phone. Overwrites evidence/step-g.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  printf '%s\n' "prove-step-g.sh takes no arguments and accepts no phone number." >&2
  exit 1
fi

export NODE_OPTIONS="${NODE_OPTIONS:-} --disable-warning=ExperimentalWarning"

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
SKILL="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE="$SKILL/evidence/step-g"
rm -rf "$EVIDENCE"
mkdir -p "$EVIDENCE"
cd "$ROOT"

if [[ ! -x node_modules/.bin/tsx ]]; then
  printf '%s\n' "tsx is missing. From the repo root run: npm ci" >&2
  exit 1
fi

GUESTY="$ROOT/src/cleaner-core/fixtures/guesty-lite-scratch.ics"
MOVED="$ROOT/src/cleaner-core/fixtures/guesty-lite-date-moved.ics"
COURT_STAY="$ROOT/src/cleaner-core/fixtures/google-court-stay.json"
LANE_READ="$ROOT/src/cleaner-core/fixtures/notion-lane-read.json"
OWNER="+15555550100"
CLEANER="+15555550101"
OBSERVER="+15555550122"
UNAPPROVED="+15555550199"
FRESH="2026-10-14T15:00:00.000Z"
STALE="2026-10-14T18:00:00.001Z"
AFTER="2026-10-18T16:00:00.000Z"
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
    const write = (name, value) => fs.writeFileSync(name, JSON.stringify(value ?? [], null, 2) + "\n");
    fs.writeFileSync(process.argv[2], (report.transcript ?? []).join("\n") + "\n");
    write(process.argv[3], report.jobs);
    write(process.argv[4], report.outbox);
    if (report.reviews) write(process.argv[5], report.reviews);
    if (report.health) fs.writeFileSync(process.argv[6], JSON.stringify(report.health, null, 2) + "\n");
  ' "$dir/$name.stdout.txt" "$dir/$name.transcript.txt" "$dir/$name.jobs.json" "$dir/$name.outbox.json" "$dir/$name.reviews.json" "$dir/$name.health.json"
}

assert_journey() {
  local name="$1"
  shift
  if ! node "$SKILL/scripts/assert-step-g.mjs" "$name" "$@"; then
    fail "feature: $name"
  fi
  printf '%s\n' "feature: $name" >"$EVIDENCE/$name/result.txt"
  printf '%s\n' "pass" >>"$EVIDENCE/$name/result.txt"
}

smoke() {
  env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- "$@"
}

# ci-local runs last so a journey failure stops first. The folder is still the CI proof.
run_journeys() {
  doctor "$EVIDENCE/stale-source"
  run_smoke "$EVIDENCE/stale-source" smoke smoke --watch-freshness --feed "$GUESTY" \
    --reply "$OWNER=YES" --now "$STALE" --reply "$OWNER=YES" \
    --fetched-at "$FRESH" --feed "$GUESTY" \
    --fetched-at "$STALE" --feed "$GUESTY"
  assert_journey stale-source "$EVIDENCE/stale-source/smoke.stdout.txt"

  doctor "$EVIDENCE/host-override-beats-stale-feed"
  run_smoke "$EVIDENCE/host-override-beats-stale-feed" smoke smoke --watch-freshness --feed "$GUESTY" \
    --reply "$OWNER=2:00 PM" --reply "$OWNER=YES" \
    --now "$STALE" --fetched-at "$FRESH" --then-feed "$MOVED"
  assert_journey host-override-beats-stale-feed "$EVIDENCE/host-override-beats-stale-feed/smoke.stdout.txt"

  doctor "$EVIDENCE/permanent-code"
  PIN_DIR="$(mktemp -d)"
  PIN_FILE="$PIN_DIR/reply.txt"
  npx tsx -e 'import { writeFileSync } from "node:fs"; import { scratchTenant } from "./src/cleaner-core/tenants.ts"; const tenant = scratchTenant("scratch-lane"); if (!tenant) throw new Error("missing"); writeFileSync(process.argv[1], tenant.pin + "\n");' "$PIN_FILE"
  PERM_DIR="$(mktemp -d)"
  PERM_BAK="$PERM_DIR/turn.db"
  run_smoke "$EVIDENCE/permanent-code" native smoke --with-pin --data "$PERM_DIR" \
    --group-mode native --group-capable --group "$UNAPPROVED" --participant "observer=$OBSERVER" \
    --feed "$GUESTY" \
    --reply "$CLEANER=YES" --reply "$OBSERVER=YES" \
    --reply "$OWNER=YES" --reply "$OWNER=YES" \
    --reply "$CLEANER=YES" --reply "$OWNER=guests have left" \
    --backup "$PERM_BAK"
  run_smoke "$EVIDENCE/permanent-code" mirror smoke --with-pin \
    --group-mode mirrored --participant "observer=$OBSERVER" \
    --feed "$GUESTY" \
    --reply "$CLEANER=YES" --reply "$OBSERVER=YES" \
    --reply "$OWNER=YES" --reply "$OWNER=YES" \
    --reply "$CLEANER=YES" --reply "$OWNER=guests have left"
  run_smoke "$EVIDENCE/permanent-code" expose smoke --no-poll --with-pin --watch-freshness \
    --reply "$CLEANER=@$PIN_FILE"
  rm -rf "$PIN_DIR"
  cp "$PERM_BAK" "$EVIDENCE/permanent-code/backup.db"
  if [[ ! -f "$PERM_DIR/cleaner-core.log" ]]; then
    fail "permanent-code log was not written"
  fi
  cp "$PERM_DIR/cleaner-core.log" "$EVIDENCE/permanent-code/log.txt"
  if grep -E '\+1555555' "$EVIDENCE/permanent-code/log.txt" >/dev/null; then
    fail "the permanent-code log kept a full phone number"
  fi
  rm -rf "$PERM_DIR"
  assert_journey permanent-code \
    "$EVIDENCE/permanent-code/native.stdout.txt" \
    "$EVIDENCE/permanent-code/mirror.stdout.txt" \
    "$EVIDENCE/permanent-code/expose.stdout.txt"

  doctor "$EVIDENCE/backup-restore"
  SHARE="$(mktemp -d)"
  BAK="$SHARE/turn.db"
  run_smoke "$EVIDENCE/backup-restore" court smoke --tenant scratch-court --data "$SHARE" --google "$COURT_STAY"
  run_smoke "$EVIDENCE/backup-restore" lane smoke --with-pin --data "$SHARE" --feed "$GUESTY" \
    --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$OWNER=STOP" \
    --backup "$BAK"
  node -e '
    const fs = require("node:fs");
    const file = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const court = file.tenants && file.tenants["scratch-court"];
    if (!court) throw new Error("Court slice missing before restore");
    const lane = {
      schemaVersion: 1,
      tenantId: "scratch-lane",
      jobs: [],
      hostFacts: [],
      tombstones: [],
      outbox: [],
      inboundIds: [],
      transcript: [],
      optedOut: false,
      injurySent: [],
      blocks: [],
    };
    fs.writeFileSync(process.argv[1], JSON.stringify({ schemaVersion: 1, tenants: { "scratch-court": court, "scratch-lane": lane } }) + "\n");
  ' "$SHARE/cleaner-core.json"
  run_smoke "$EVIDENCE/backup-restore" restored smoke --with-pin --data "$SHARE" --restore "$BAK" --feed "$GUESTY"
  run_smoke "$EVIDENCE/backup-restore" court-again smoke --tenant scratch-court --data "$SHARE" --no-poll
  cp "$BAK" "$EVIDENCE/backup-restore/backup.db"
  rm -rf "$SHARE"
  assert_journey backup-restore \
    "$EVIDENCE/backup-restore/court.stdout.txt" \
    "$EVIDENCE/backup-restore/restored.stdout.txt" \
    "$EVIDENCE/backup-restore/court-again.stdout.txt"

  doctor "$EVIDENCE/replay-no-resend"
  REPLAY_DIR="$(mktemp -d)"
  run_smoke "$EVIDENCE/replay-no-resend" turn smoke --data "$REPLAY_DIR" --feed "$GUESTY" \
    --reply "$OWNER=YES" --reply "$OWNER=YES"
  run_smoke "$EVIDENCE/replay-no-resend" replay smoke --no-poll --data "$REPLAY_DIR" --replay
  rm -rf "$REPLAY_DIR"
  assert_journey replay-no-resend \
    "$EVIDENCE/replay-no-resend/turn.stdout.txt" \
    "$EVIDENCE/replay-no-resend/replay.stdout.txt"

  doctor "$EVIDENCE/recovery-after-restart"
  OFFER_DIR="$(mktemp -d)"
  PIN_HALT="$(mktemp -d)"
  run_smoke "$EVIDENCE/recovery-after-restart" crash-offer smoke --with-pin --data "$OFFER_DIR" --crash after-accept \
    --feed "$GUESTY" --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES"
  run_smoke "$EVIDENCE/recovery-after-restart" replay smoke --no-poll --data "$OFFER_DIR" --replay
  run_smoke "$EVIDENCE/recovery-after-restart" replay-again smoke --no-poll --data "$OFFER_DIR" --replay
  run_smoke "$EVIDENCE/recovery-after-restart" crash-pin smoke --with-pin --data "$PIN_HALT" --crash before-pin \
    --feed "$GUESTY" --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" \
    --reply "$CLEANER=YES" --reply "$OWNER=guests have left"
  run_smoke "$EVIDENCE/recovery-after-restart" resume smoke --with-pin --no-poll --data "$PIN_HALT" --now "$AFTER" --remind
  run_smoke "$EVIDENCE/recovery-after-restart" resume-again smoke --with-pin --no-poll --data "$PIN_HALT" --now "$AFTER" --remind
  rm -rf "$OFFER_DIR" "$PIN_HALT"
  assert_journey recovery-after-restart \
    "$EVIDENCE/recovery-after-restart/crash-offer.stdout.txt" \
    "$EVIDENCE/recovery-after-restart/replay.stdout.txt" \
    "$EVIDENCE/recovery-after-restart/replay-again.stdout.txt" \
    "$EVIDENCE/recovery-after-restart/crash-pin.stdout.txt" \
    "$EVIDENCE/recovery-after-restart/resume.stdout.txt" \
    "$EVIDENCE/recovery-after-restart/resume-again.stdout.txt"

  doctor "$EVIDENCE/review-queue"
  run_smoke "$EVIDENCE/review-queue" smoke smoke --no-poll \
    --review stale-source --review stale-source \
    --review airbnb-exception --review airbnb-exception \
    --review same-day-capacity --review same-day-capacity \
    --review missed-reminder --review missed-reminder \
    --review conflicting-replies --review conflicting-replies \
    --review failed-sms --review failed-sms \
    --review uncertain-sms --review uncertain-sms \
    --review shared-chat-routing --review shared-chat-routing \
    --review possible-code-exposure --review possible-code-exposure
  run_smoke "$EVIDENCE/review-queue" airbnb smoke --watch-freshness --no-poll --reply "$OWNER=booked on airbnb"
  assert_journey review-queue \
    "$EVIDENCE/review-queue/smoke.stdout.txt" \
    "$EVIDENCE/review-queue/airbnb.stdout.txt"

  doctor "$EVIDENCE/observability"
  OBS_DIR="$(mktemp -d)"
  run_smoke "$EVIDENCE/observability" smoke smoke --watch-freshness --data "$OBS_DIR" --backup-dir "$OBS_DIR/scheduled" \
    --feed "$GUESTY" --reply "$OWNER=YES" --now "$STALE" --reply "$OWNER=YES"
  mkdir -p "$EVIDENCE/observability"
  printf '%s\n' "env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:health -- --data $OBS_DIR --now $STALE" >"$EVIDENCE/observability/health.command"
  set +e
  env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:health -- --data "$OBS_DIR" --now "$STALE" \
    >"$EVIDENCE/observability/health.stdout.txt" 2>"$EVIDENCE/observability/health.stderr.txt"
  local_health=$?
  set -e
  printf '%s\n' "$local_health" >"$EVIDENCE/observability/health.exit"
  if [[ "$local_health" != "0" ]]; then
    fail "health exit $local_health"
  fi
  if [[ -f "$OBS_DIR/cleaner-core.log" ]]; then
    cp "$OBS_DIR/cleaner-core.log" "$EVIDENCE/observability/log.txt"
  else
    fail "observability log was not written"
  fi
  if [[ ! -f "$OBS_DIR/scheduled/scheduled.db" ]]; then
    fail "scheduled backup was not written"
  fi
  cp "$OBS_DIR/scheduled/scheduled.db" "$EVIDENCE/observability/scheduled.db"
  rm -rf "$OBS_DIR"
  assert_journey observability \
    "$EVIDENCE/observability/smoke.stdout.txt" \
    "$EVIDENCE/observability/health.stdout.txt"
  if grep -E '\+1555555' "$EVIDENCE/observability/log.txt" >/dev/null; then
    fail "the log kept a full phone number"
  fi

  doctor "$EVIDENCE/tenant-isolation"
  TENANT_DIR="$(mktemp -d)"
  TENANT_BAK="$TENANT_DIR/lane.db"
  run_smoke "$EVIDENCE/tenant-isolation" lane smoke --data "$TENANT_DIR" --watch-freshness --feed "$GUESTY" \
    --review same-day-capacity --backup "$TENANT_BAK"
  run_smoke "$EVIDENCE/tenant-isolation" court smoke --tenant scratch-court --data "$TENANT_DIR" --google "$COURT_STAY"
  run_smoke "$EVIDENCE/tenant-isolation" lane-restore smoke --data "$TENANT_DIR" --restore "$TENANT_BAK" --no-poll
  run_smoke "$EVIDENCE/tenant-isolation" lane-replay smoke --data "$TENANT_DIR" --no-poll --replay
  run_smoke "$EVIDENCE/tenant-isolation" court-again smoke --tenant scratch-court --data "$TENANT_DIR" --no-poll --watch-freshness
  run_smoke "$EVIDENCE/tenant-isolation" court-replay smoke --tenant scratch-court --data "$TENANT_DIR" --no-poll --replay
  cp "$TENANT_BAK" "$EVIDENCE/tenant-isolation/lane-backup.db"
  rm -rf "$TENANT_DIR"
  assert_journey tenant-isolation \
    "$EVIDENCE/tenant-isolation/lane.stdout.txt" \
    "$EVIDENCE/tenant-isolation/court.stdout.txt" \
    "$EVIDENCE/tenant-isolation/lane-restore.stdout.txt" \
    "$EVIDENCE/tenant-isolation/lane-replay.stdout.txt" \
    "$EVIDENCE/tenant-isolation/court-again.stdout.txt" \
    "$EVIDENCE/tenant-isolation/court-replay.stdout.txt"

  doctor "$EVIDENCE/stop-help-injury"
  run_smoke "$EVIDENCE/stop-help-injury" stop smoke --closed --notion "$LANE_READ" --reply "$OWNER=STOP"
  run_smoke "$EVIDENCE/stop-help-injury" help smoke --closed --notion "$LANE_READ" --reply "$OWNER=HELP"
  run_smoke "$EVIDENCE/stop-help-injury" injury smoke --closed --notion "$LANE_READ" \
    --reply "$OWNER=$HURT" --reply "$OWNER=$HURT" \
    --reply "$CLEANER=$HURT" --reply "$CLEANER=$HURT"
  node "$SKILL/scripts/assert-step-g.mjs" stop-help-injury \
    "$EVIDENCE/stop-help-injury/stop.stdout.txt" \
    "$EVIDENCE/stop-help-injury/help.stdout.txt" \
    "$EVIDENCE/stop-help-injury/injury.stdout.txt"

  doctor "$EVIDENCE/stop-help-injury"
  run_smoke "$EVIDENCE/stop-help-injury" observer-group smoke \
    --with-pin --group-mode native --group-capable --participant "observer=$OBSERVER" \
    --notion "$LANE_READ" \
    --reply "$CLEANER=YES" --reply "$OBSERVER=YES" \
    --reply "$OBSERVER=$HURT" --reply "$OBSERVER=$HURT"
  run_smoke "$EVIDENCE/stop-help-injury" observer-solo smoke \
    --group-mode cleaner-only --participant "observer=$OBSERVER" \
    --notion "$LANE_READ" \
    --reply "$OBSERVER=$HURT" --reply "$OBSERVER=$HURT"
  run_smoke "$EVIDENCE/stop-help-injury" owner smoke --notion "$LANE_READ" \
    --reply "$OWNER=$HURT" --reply "$OWNER=$HURT"
  node "$SKILL/scripts/assert-step-g.mjs" observer-injury-group "$EVIDENCE/stop-help-injury/observer-group.stdout.txt"
  node "$SKILL/scripts/assert-step-g.mjs" observer-injury-solo "$EVIDENCE/stop-help-injury/observer-solo.stdout.txt"
  node "$SKILL/scripts/assert-step-g.mjs" owner-injury "$EVIDENCE/stop-help-injury/owner.stdout.txt"

  WORD_REPORTS=()
  word_i=0
  while IFS= read -r phrase; do
    for mode in solo group; do
      name="phrase-${word_i}-${mode}"
      if [[ "$mode" == "group" ]]; then
        run_smoke "$EVIDENCE/stop-help-injury" "$name" smoke \
          --with-pin --group-mode native --group-capable --participant "observer=$OBSERVER" \
          --notion "$LANE_READ" \
          --reply "$CLEANER=YES" --reply "$OBSERVER=YES" \
          --reply "$CLEANER=$phrase" --reply "$OBSERVER=$phrase"
      else
        run_smoke "$EVIDENCE/stop-help-injury" "$name" smoke \
          --group-mode cleaner-only --participant "observer=$OBSERVER" \
          --notion "$LANE_READ" \
          --reply "$CLEANER=$phrase" --reply "$OBSERVER=$phrase"
      fi
      WORD_REPORTS+=("$EVIDENCE/stop-help-injury/${name}.stdout.txt")
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
  node "$SKILL/scripts/assert-step-g.mjs" injury-wording "${WORD_REPORTS[@]}"
  run_smoke "$EVIDENCE/stop-help-injury" everyday smoke \
    --group-mode cleaner-only --participant "observer=$OBSERVER" \
    --notion "$LANE_READ" \
    --reply "$CLEANER=that hurt my schedule lol, running late"
  printf '%s\n' "feature: stop-help-injury" >"$EVIDENCE/stop-help-injury/result.txt"
  printf '%s\n' "pass" >>"$EVIDENCE/stop-help-injury/result.txt"
  node -e '
    const fs = require("node:fs");
    const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const emergencies = (report.sent ?? []).filter((text) => text.kind === "emergency");
    const note = emergencies.length > 0
      ? "everyday from +15555550101, one-to-one: \"that hurt my schedule lol, running late\" was treated as an injury."
      : "everyday from +15555550101, one-to-one: \"that hurt my schedule lol, running late\" was not treated as an injury.";
    fs.appendFileSync(process.argv[2], note + "\n");
  ' "$EVIDENCE/stop-help-injury/everyday.stdout.txt" "$EVIDENCE/stop-help-injury/result.txt"
}

run_journeys

printf '%s\n' "== regressions"
if ! bash "$SKILL/scripts/prove-step-d.sh" >"$EVIDENCE/regression-step-d.txt"; then
  fail "prove-step-d failed"
fi
if ! bash "$SKILL/scripts/prove-step-e.sh" >"$EVIDENCE/regression-step-e.txt"; then
  fail "prove-step-e failed"
fi
if ! bash "$SKILL/scripts/prove-step-f.sh" >"$EVIDENCE/regression-step-f.txt"; then
  fail "prove-step-f failed"
fi

doctor "$EVIDENCE/ci-local"
mkdir -p "$EVIDENCE/ci-local"
printf '%s\n' "bash scripts/ci-check.sh" >"$EVIDENCE/ci-local/ci.command"
set +e
bash scripts/ci-check.sh >"$EVIDENCE/ci-local/ci.stdout.txt" 2>"$EVIDENCE/ci-local/ci.stderr.txt"
ci_code=$?
set -e
printf '%s\n' "$ci_code" >"$EVIDENCE/ci-local/ci.exit"
if [[ "$ci_code" != "0" ]]; then
  fail "ci-local exit $ci_code"
fi
printf '%s\n' "env -u CLEANER_CORE_ENABLED npm run --silent cleaner:smoke -- --watch-freshness --feed $GUESTY --review stale-source" >"$EVIDENCE/ci-local/flag-off.command"
set +e
env -u CLEANER_CORE_ENABLED npm run --silent cleaner:smoke -- --watch-freshness --feed "$GUESTY" --review stale-source \
  >"$EVIDENCE/ci-local/flag-off.stdout.txt" 2>"$EVIDENCE/ci-local/flag-off.stderr.txt"
flag_code=$?
set -e
printf '%s\n' "$flag_code" >"$EVIDENCE/ci-local/flag-off.exit"
if [[ "$flag_code" != "2" ]]; then
  fail "flag-off exit $flag_code"
fi
assert_journey ci-local "$EVIDENCE/ci-local/flag-off.stdout.txt"

if ! node scripts/scan-cleaner-secrets.mjs "$EVIDENCE"; then
  fail "step G evidence contains a configured scratch secret"
fi

cat >"$EVIDENCE/result.txt" <<EOF
features: ci-local stale-source host-override-beats-stale-feed permanent-code backup-restore replay-no-resend recovery-after-restart review-queue observability tenant-isolation stop-help-injury
regressions: prove-step-d.sh prove-step-e.sh prove-step-f.sh
script: .cursor/skills/verify-cleanercore/scripts/prove-step-g.sh
pins: redacted
stale-default: 3 hours, three missed hourly Guesty Lite polls
EOF

cat >"$EVIDENCE/stand-in.txt" <<'EOF'
This run used the in-process doctor/smoke CLI. A live cleaning job will not do these steps. They stay unverified until a run on that live target covers them. That run still uses only Scratch test numbers.

1. Started tsx via npm run cleaner:doctor, npm run cleaner:smoke, and npm run cleaner:health in this checkout. A hosted job is not launched that way.
2. Read Guesty Lite, Google Calendar, and Notion fixtures under src/cleaner-core/fixtures/. Did not call Guesty, Google, Notion, or Twilio, and did not use a live credential.
3. Froze time at the smoke default 2026-10-14T15:00:00.000Z, or at the --now instant a journey passed. Did not use the wall clock except where health was given that same instant.
4. Pushed texts onto an in-memory array, or a JSON file under a temporary --data directory, and printed JSON. Did not call a messaging provider. Temporary directories were removed after stdout was saved.
5. Applied each --reply inside the process. A reply that starts with @ reads a file inside the process. The exposure reply file was a temporary file outside this evidence folder and was deleted. Neither path received an inbound SMS.
6. Printed no door code. A crash is --crash after-accept or --crash before-pin, which stops the process after the durable row is saved. It is not a kill of a live host.
7. ci-local ran scripts/ci-check.sh: typecheck, build, the full test suite, the cleaner-core tests with the flag on and off, the secret scan, the baseline eval, and the SETUP_PROMPT check. Then a flag-off smoke exited 2.
EOF

printf '%s\n' "$EVIDENCE"
