#!/usr/bin/env bash
# Fetch the official llama.cpp prebuilt for macOS arm64 and stage it
# under ./llama-runtime/ so the Mac app's build phase can bundle it
# into Resources/llama-runtime/.
#
# We pin a specific upstream tag (open question §23 in design.md):
# llama.cpp moves fast and its GGUF format / Metal backend can break
# between releases. Bumping LLAMA_TAG should be a deliberate act
# accompanied by re-running the v4 / v6 / v6.5 regression suites.
#
# The bundle is ~26MB: 1 binary + 9 dylibs (the ggml + llama family,
# Metal backend included). All linked via @loader_path so they only
# resolve when the binary and dylibs sit in the same directory — that's
# why we copy the whole release tree rather than cherry-picking files.
#
# Usage:
#   ./scripts/build-llama-server.sh           # idempotent — skips if present
#   ./scripts/build-llama-server.sh --force   # re-download even if present

set -euo pipefail

cd "$(dirname "$0")/.."

LLAMA_TAG="b9025"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  ASSET="llama-${LLAMA_TAG}-bin-macos-arm64.tar.gz" ;;
  x86_64) ASSET="llama-${LLAMA_TAG}-bin-macos-x64.tar.gz"   ;;
  *) echo "error: unsupported arch $ARCH" >&2; exit 1 ;;
esac
URL="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/${ASSET}"
DEST="llama-runtime"
CACHE="vendor/${ASSET}"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

if [ -x "$DEST/llama-server" ] && [ "$FORCE" = "0" ]; then
  echo "✓ $DEST/llama-server present (tag $LLAMA_TAG) — pass --force to re-fetch"
  exit 0
fi

mkdir -p vendor
if [ ! -f "$CACHE" ] || [ "$FORCE" = "1" ]; then
  echo "→ fetching $ASSET"
  curl -fL --progress-bar -o "$CACHE.tmp" "$URL"
  mv "$CACHE.tmp" "$CACHE"
fi

echo "→ extracting to $DEST/"
rm -rf "$DEST"
mkdir -p "$DEST"
tar xzf "$CACHE" -C "$DEST" --strip-components=1

# Sanity check — binary must run.
if ! "$DEST/llama-server" --version >/dev/null 2>&1; then
  echo "error: extracted llama-server doesn't run" >&2
  exit 1
fi

SIZE=$(du -sh "$DEST" | cut -f1)
VERSION=$("$DEST/llama-server" --version 2>&1 | grep -oE 'version: [0-9]+' | head -1 || echo "?")
echo "✓ staged $DEST ($SIZE, llama.cpp $VERSION)"
