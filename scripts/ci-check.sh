#!/usr/bin/env bash
# Commands the Cleaner Core CI job runs after checkout and npm ci.
# Node 22 is required for the SQLite backup store (node:sqlite).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p ci-logs

major="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$major" -lt 22 ]]; then
  printf '%s\n' "Cleaner Core SQLite backups need Node 22. This process is Node $(node -v)." >&2
  exit 1
fi

run_log() {
  local name="$1"
  shift
  printf '%s\n' "== $name"
  if ! "$@" >"ci-logs/$name.log" 2>&1; then
    printf '%s\n' "$name failed" >&2
    tail -n 80 "ci-logs/$name.log" >&2
    exit 1
  fi
  printf '%s\n' "$name ok"
}

run_log typecheck npm run typecheck
run_log build npm run build
run_log test-default npm test
run_log test-on env CLEANER_CORE_ENABLED=1 npx vitest run test/cleanerCore.test.ts test/cleanerCoreStepG.test.ts
run_log test-off env -u CLEANER_CORE_ENABLED npx vitest run test/cleanerCore.test.ts test/cleanerCoreStepG.test.ts
run_log secret-scan node scripts/scan-cleaner-secrets.mjs ci-logs
run_log test-eval npm run test:eval

printf '%s\n' "== SETUP_PROMPT unchanged"
git fetch origin master --depth=1
git diff --exit-code origin/master -- grok-template/SETUP_PROMPT.md
printf '%s\n' "SETUP_PROMPT ok"

printf '%s\n' "test-default $(grep -E 'Tests[[:space:]]+[0-9]+ passed' ci-logs/test-default.log | tail -n 1)"
printf '%s\n' "test-on $(grep -E 'Tests[[:space:]]+[0-9]+ passed' ci-logs/test-on.log | tail -n 1)"
printf '%s\n' "test-off $(grep -E 'Tests[[:space:]]+[0-9]+ passed' ci-logs/test-off.log | tail -n 1)"
