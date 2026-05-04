#!/usr/bin/env bash
# Compile src/server.ts into a single standalone binary.
#
# This is what the Mac app spawns. It bundles the Bun runtime + the entire
# TypeScript source (server, assistant, tools, RAG, sessions, profile) into
# one executable — no `bun` install required on the user's machine.
#
# Output: ./halo-runtime at the repo root. The Mac app's RuntimeServer
# looks for it inside the app bundle first; in dev (running from Xcode)
# it falls back to this path.
#
# Usage:
#   ./scripts/build-runtime.sh

set -euo pipefail

cd "$(dirname "$0")/.."

# Xcode build phases run with a minimal PATH that omits Homebrew's prefix,
# so a `bun` installed via brew won't be found unless we extend the search
# paths ourselves. Cover both Apple Silicon (/opt/homebrew) and Intel
# (/usr/local) brew prefixes, plus the default user-install location.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun not found on PATH (looked in: $PATH)" >&2
  echo "hint: install with 'brew install bun' or 'curl -fsSL https://bun.sh/install | bash'" >&2
  exit 1
fi

# arm64 is the only target we care about (M1 Air baseline). If the host is
# x86_64 we still build for arm64 — the binary is shipped, not run, on the
# build host.
TARGET="bun-darwin-arm64"
OUT="halo-runtime"

echo "→ bun build --compile --target=$TARGET src/server.ts → $OUT"
bun build \
  --compile \
  --target="$TARGET" \
  --minify \
  --sourcemap=none \
  src/server.ts \
  --outfile "$OUT"

echo "✓ built $OUT ($(du -h "$OUT" | cut -f1))"
