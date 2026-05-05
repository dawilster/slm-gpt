#!/usr/bin/env bash
# Fetch the SharpAI/SwiftLM prebuilt for macOS arm64 and stage it under
# ./swiftlm-runtime/ so the Mac app's build phase can bundle it into
# Resources/swiftlm-runtime/.
#
# We pin a specific upstream tag (open question §23 in design.md):
# SwiftLM moves fast — bumping SWIFTLM_TAG should be a deliberate act
# accompanied by re-running the v4 / v6 / v6.5 regression suites.
#
# Usage:
#   ./scripts/fetch-swiftlm.sh           # idempotent — skips if present
#   ./scripts/fetch-swiftlm.sh --force   # re-download even if present

set -euo pipefail

cd "$(dirname "$0")/.."

SWIFTLM_TAG="b644"
ASSET="SwiftLM-${SWIFTLM_TAG}-macos-arm64.tar.gz"
URL="https://github.com/SharpAI/SwiftLM/releases/download/${SWIFTLM_TAG}/${ASSET}"
DEST="swiftlm-runtime"
CACHE="vendor/${ASSET}"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

if [ -x "$DEST/SwiftLM" ] && [ -f "$DEST/mlx.metallib" ] && [ "$FORCE" = "0" ]; then
  echo "✓ $DEST/SwiftLM present (tag $SWIFTLM_TAG) — pass --force to re-fetch"
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
tar xzf "$CACHE" -C "$DEST"

# Sanity check — binary must be executable.
if [ ! -x "$DEST/SwiftLM" ]; then
  echo "error: extracted SwiftLM not executable" >&2
  exit 1
fi
if [ ! -f "$DEST/mlx.metallib" ]; then
  echo "error: extracted bundle missing mlx.metallib" >&2
  exit 1
fi

SIZE=$(du -sh "$DEST" | cut -f1)
echo "✓ staged $DEST ($SIZE, SwiftLM $SWIFTLM_TAG)"
