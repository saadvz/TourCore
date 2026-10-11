#!/bin/sh
set -eu
umask 077
if ! mountpoint -q /data; then
  echo 'Cleaner Core test requires a dedicated persistent volume mounted at /data.' >&2
  exit 1
fi
if [ "${CLEANER_TEST_HOME:-}" != /data/cleaner-core-test ]; then
  echo 'Container test storage must be /data/cleaner-core-test.' >&2
  exit 1
fi
mkdir -p "$CLEANER_TEST_HOME"
export CLEANER_TEST_EXTERNAL_LOCK=1
# --no-fork replaces flock with node while retaining the advisory lock.
# Exit code 73 means another process already owns this storage directory.
exec flock --nonblock --conflict-exit-code 73 --no-fork "$CLEANER_TEST_HOME/service.flock" node dist/cleaner-test-server.mjs
