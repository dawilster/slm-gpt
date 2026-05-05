#!/bin/sh
# Death-pact wrapper for the bundled Python MLX server.
#
# This is the binary the Mac app actually invokes. It does two jobs:
#   1. Set up the right environment so the bundled python finds its
#      libraries and serve.py
#   2. Watch HALO_PARENT_PID and SIGTERM/SIGKILL the python child if
#      the Mac app dies (otherwise python orphans to launchd holding
#      ~3-4GB of model RAM until the user manually pkills it).
#
# Same pattern as the old swiftlm-supervised.sh; serve.py also has
# its own in-process watchdog as belt-and-braces. The wrapper is the
# robust one because it works even if serve.py crashes before
# starting its own watchdog.
#
# Layout assumed (set up by scripts/fetch-python-mlx.sh, then copied
# into Resources/python-runtime/ by Xcode build phase):
#   <HERE>/bin/python3
#   <HERE>/lib/python3.11/site-packages/...
#   <HERE>/serve.py
#   <HERE>/python-supervised.sh   ← this file

set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PYTHON="$HERE/bin/python3"
SCRIPT="$HERE/serve.py"
PARENT_PID="${HALO_PARENT_PID:-}"

if [ ! -x "$PYTHON" ]; then
  echo "error: $PYTHON not executable" >&2
  exit 1
fi
if [ ! -f "$SCRIPT" ]; then
  echo "error: $SCRIPT not found" >&2
  exit 1
fi

# Direct-exec mode (manual testing): no parent pid → just run python.
# Useful for `./python-runtime/python-supervised.sh --model ... --port 1235`
# from a terminal without the Mac app.
if [ -z "$PARENT_PID" ]; then
  exec "$PYTHON" "$SCRIPT" "$@"
fi

# Supervised mode — used by ModelServer.swift in production.
"$PYTHON" "$SCRIPT" "$@" &
CHILD_PID=$!

# Death-pact loop. Exits when either party dies.
while kill -0 "$PARENT_PID" 2>/dev/null; do
  if ! kill -0 "$CHILD_PID" 2>/dev/null; then
    # Child died on its own (model load failure, OOM, etc.) — surface
    # the exit status so ModelServer.swift can react.
    wait "$CHILD_PID" 2>/dev/null
    exit $?
  fi
  sleep 1
done

# Parent gone — bring down the child gracefully.
# SIGTERM gives serve.py's atexit / uvicorn shutdown hooks a chance
# to flush logs. 5s is enough for that but not so long that a force-
# quit waits visibly.
kill -TERM "$CHILD_PID" 2>/dev/null || true
for _ in 1 2 3 4 5; do
  kill -0 "$CHILD_PID" 2>/dev/null || exit 0
  sleep 1
done
# Stubborn — force kill.
kill -KILL "$CHILD_PID" 2>/dev/null || true
