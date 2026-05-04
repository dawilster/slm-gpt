#!/bin/sh
# Death-pact wrapper for llama-server.
#
# Same pattern as src/server.ts's HALO_PARENT_PID watchdog: when the Mac
# app spawns this script, it sets HALO_PARENT_PID to its own pid. The
# wrapper polls that pid every second; when the parent disappears (graceful
# quit, crash, or SIGKILL — all leave the child orphaned to launchd
# otherwise), the wrapper sends SIGTERM-then-SIGKILL to llama-server.
#
# Without this, force-killing the Mac app (or the Mac app crashing) leaves
# llama-server holding ~3GB of RAM with the GGUF mmap'd, listening on :1235
# and orphaned — until the user manually pkills it.
#
# Sits next to llama-server because llama.cpp's @loader_path rpath
# requires the dylibs to be next to the binary. ModelServer.swift spawns
# this script with the same arg list it would have given llama-server.

set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PARENT_PID="${HALO_PARENT_PID:-}"

# If no parent pid set, exec llama-server directly — caller wants the
# raw binary's behavior (manual testing, etc.)
if [ -z "$PARENT_PID" ]; then
  exec "$HERE/llama-server" "$@"
fi

# Spawn llama-server in the background so we can watch both pids.
"$HERE/llama-server" "$@" &
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
# Give llama-server a few seconds to flush + free the GGUF mmap.
for _ in 1 2 3 4 5; do
  kill -0 "$CHILD_PID" 2>/dev/null || exit 0
  sleep 1
done
kill -KILL "$CHILD_PID" 2>/dev/null || true
