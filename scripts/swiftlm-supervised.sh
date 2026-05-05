#!/bin/sh
# Death-pact wrapper for SwiftLM (mlx-based inference server).
#
# Same pattern as src/server.ts's HALO_PARENT_PID watchdog: when the Mac
# app spawns this script, it sets HALO_PARENT_PID to its own pid. The
# wrapper polls that pid every second; when the parent disappears
# (graceful quit, crash, or SIGKILL — all leave the child orphaned to
# launchd otherwise), the wrapper sends SIGTERM-then-SIGKILL to SwiftLM.
#
# Without this, force-killing the Mac app (or the Mac app crashing)
# leaves SwiftLM holding ~2-3GB of RAM with the model loaded, listening
# on its port — until the user manually pkills it.
#
# Sits next to SwiftLM because the binary expects mlx.metallib in its
# working directory. ModelServer.swift spawns this script with the same
# arg list it would have given SwiftLM.

set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PARENT_PID="${HALO_PARENT_PID:-}"

# If no parent pid set, exec SwiftLM directly — caller wants the
# raw binary's behavior (manual testing, etc.)
if [ -z "$PARENT_PID" ]; then
  cd "$HERE"  # so SwiftLM finds mlx.metallib
  exec "$HERE/SwiftLM" "$@"
fi

# Spawn SwiftLM in the background so we can watch both pids.
cd "$HERE"  # so SwiftLM finds mlx.metallib
"$HERE/SwiftLM" "$@" &
CHILD_PID=$!

# Death-pact loop — exit when either parent or child is gone.
while kill -0 "$PARENT_PID" 2>/dev/null; do
  if ! kill -0 "$CHILD_PID" 2>/dev/null; then
    # Child died on its own — exit with its status.
    wait "$CHILD_PID" 2>/dev/null
    exit $?
  fi
  sleep 1
done

# Parent gone. Tear down the child cleanly.
kill -TERM "$CHILD_PID" 2>/dev/null || true
# Give SwiftLM a few seconds to flush + free model RAM.
for _ in 1 2 3 4 5; do
  kill -0 "$CHILD_PID" 2>/dev/null || exit 0
  sleep 1
done
kill -KILL "$CHILD_PID" 2>/dev/null || true
