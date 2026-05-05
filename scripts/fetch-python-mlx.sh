#!/usr/bin/env bash
# Fetch a relocatable Python and pip-install the MLX inference stack into
# ./python-runtime/, so the Mac app's build phase can ditto-copy that
# whole directory into Resources/python-runtime/.
#
# WHY PYTHON (vs SwiftLM, vs llama.cpp)
# -------------------------------------
# We tried SwiftLM (native Swift+MLX, ~190MB). It worked for plain text
# Qwen3 models but couldn't load Qwen3.5-2B-6bit — the mlx-community
# packaging is a VLM (vision-language) variant whose tokenizer/vision
# tower expectations don't match SwiftLM's loader. The Python ecosystem
# (mlx-lm + mlx-vlm) tracks bleeding-edge model support — it's what
# LM Studio uses under the hood — so we follow it. Bundle goes from
# ~190MB to ~300MB; the trade is worth it.
#
# WHAT GETS BUNDLED
# -----------------
#   python-runtime/
#     bin/python3.11                   ← relocatable cpython from Astral
#     lib/python3.11/site-packages/    ← mlx, mlx-lm, mlx-vlm, fastapi, ...
#     serve.py                         ← our OpenAI-compat HTTP shim
#     python-supervised.sh             ← death-pact wrapper (copied at build)
#
# python-build-standalone (Astral's relocatable cpython distros) is
# the same thing `uv` uses internally. Each tarball is `tar -xzf`
# into any directory, and `bin/python3` runs from wherever it lives.
# That portability is what makes bundling sane: no system Python
# dependency, no per-user pyenv setup, just files.
#
# HOW TO BUMP THINGS
# ------------------
# - Python version: edit PYTHON_VERSION + PYTHON_BUILD_TAG below.
#   Find the current tag at https://github.com/astral-sh/python-build-standalone/releases.
#   3.11.x is the sweet spot for wheel coverage as of 2026-Q2.
# - Add a Python dependency: append to the `pip install` line below,
#   re-run `./scripts/fetch-python-mlx.sh --force` to rebuild.
# - Pin a dependency version: write `mlx-lm==0.18.2` instead of `mlx-lm`.
#   Pin everything before shipping; floats are for development only.
#
# Usage:
#   ./scripts/fetch-python-mlx.sh           # idempotent, skips if up-to-date
#   ./scripts/fetch-python-mlx.sh --force   # nuke and rebuild from scratch

set -euo pipefail

cd "$(dirname "$0")/.."

# Pinned distribution. The "+TAG" suffix is python-build-standalone's
# build identifier — same Python version can have multiple builds with
# fixes. Always pair version with tag.
PYTHON_VERSION="3.11.15"
PYTHON_BUILD_TAG="20260504"
ARCH="aarch64-apple-darwin"

ASSET="cpython-${PYTHON_VERSION}+${PYTHON_BUILD_TAG}-${ARCH}-install_only.tar.gz"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD_TAG}/${ASSET}"

DEST="python-runtime"
CACHE="vendor/${ASSET}"

# Marker file: written when the install completes cleanly. Lets us
# skip the (slow) pip install on rebuilds when nothing's changed.
# `--force` blows it away; otherwise edit-the-script-then-rebuild
# requires either touching the marker or passing --force.
MARKER="$DEST/.installed"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

if [ -x "$DEST/bin/python3" ] && [ -f "$MARKER" ] && [ "$FORCE" = "0" ]; then
  echo "✓ $DEST/ already built (Python $PYTHON_VERSION) — pass --force to rebuild"
  exit 0
fi

# Step 1 — Download the Python tarball (cached so re-runs are fast).
mkdir -p vendor
if [ ! -f "$CACHE" ]; then
  echo "→ fetching $ASSET (~30MB)"
  # curl: -f fail on HTTP error, -L follow redirects, -# progress bar.
  curl -fL --progress-bar -o "$CACHE.tmp" "$URL"
  mv "$CACHE.tmp" "$CACHE"
fi

# Step 2 — Extract Python. The tarball top-level is `python/`; we
# rename it to `python-runtime/` for clarity in the bundle.
echo "→ extracting Python to $DEST/"
rm -rf "$DEST"
tar xzf "$CACHE"
mv python "$DEST"

PYBIN="$DEST/bin/python3"

# Step 3 — Upgrade pip in the bundled Python (the one shipped with
# python-build-standalone is recent but not always latest). --no-warn-
# script-location silences "scripts go in <bundle>/bin which isn't on
# PATH" — by design; users never invoke our bundled pip.
echo "→ upgrading pip"
"$PYBIN" -m pip install --upgrade pip --no-warn-script-location --quiet

# Step 4 — Install the inference stack. Each package, why it's here:
#   mlx          Apple's array library (the GPU/Metal substrate)
#   mlx-lm       text-only model loaders + generators (Qwen3, Llama, etc.)
#   mlx-vlm      vision-language model loaders (Qwen3.5-VL, LLaVA, etc.)
#                wraps mlx-lm; for text-only requests on a VLM model,
#                still works — VLM vs LM is a model property, not a flag
#   fastapi      HTTP framework — gives us OpenAI-compat /v1/* endpoints
#   uvicorn      ASGI server FastAPI runs on
#   sse-starlette streaming-helper for OpenAI's SSE chat-completions
#
# Versions are floating during development — `pip install foo` (no
# pin) lets the resolver pick a compatible set from latest releases.
# Pin everything to exact versions before shipping a release build.
#
# Text-only build: we deliberately skip mlx-vlm + torch + torchvision.
# mlx-lm has its own loaders for Qwen3 / Qwen3.5 / Llama / etc. and
# can load the language portion of mlx-community VLM repos directly
# (Qwen3.5-2B-6bit's config is `model_type: qwen3_5`, which mlx-lm's
# qwen3_5.py loader handles natively). Skipping the VLM stack saves
# ~700MB: torch (~400MB), opencv-python (~120MB), pyarrow (~120MB
# via datasets), sympy/networkx (~100MB via torch). If we ever need
# image/video input, restoring is a one-line edit here.
echo "→ installing mlx + mlx-lm + fastapi (this takes ~1 min on first run)"
"$PYBIN" -m pip install --no-warn-script-location --quiet \
  mlx \
  mlx-lm \
  fastapi \
  'uvicorn[standard]'

# Step 5 — Drop our serve.py next to the python binary. Lives in
# scripts/ so it's source-controlled; gets copied here so the bundle
# is self-contained.
echo "→ installing serve.py"
cp scripts/serve.py "$DEST/serve.py"

# Step 6 — Strip __pycache__ to save bundle size (uvicorn regenerates
# them on first run; cuts ~30MB). Also strip .pyc files in tests/.
echo "→ cleaning pycache + tests"
find "$DEST" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
find "$DEST" -type d -name "tests" -path "*/site-packages/*" -exec rm -rf {} + 2>/dev/null || true

# Marker file — install succeeded.
date "+%Y-%m-%d %H:%M:%S" > "$MARKER"

SIZE=$(du -sh "$DEST" | cut -f1)
echo "✓ python-runtime ready ($SIZE)"
echo "  Python:  $("$PYBIN" --version)"
echo "  mlx:     $("$PYBIN" -c 'import mlx; print(mlx.__version__)' 2>/dev/null || echo '?')"
echo "  mlx-lm:  $("$PYBIN" -c 'import mlx_lm; print(mlx_lm.__version__)' 2>/dev/null || echo '?')"
echo "  mlx-vlm: $("$PYBIN" -c 'import mlx_vlm; print(mlx_vlm.__version__)' 2>/dev/null || echo '?')"
