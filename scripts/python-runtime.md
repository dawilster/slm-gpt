# python-runtime — the bundled Python MLX inference server

This file documents `python-runtime/` (a build artifact at the repo
root; not source-controlled). The Mac app spawns it; the Bun harness
talks to it over HTTP. **You don't need Python installed on your
system** — the whole interpreter and every dependency live inside
the bundled directory.

The doc lives in `scripts/` because `python-runtime/` gets blown
away and rebuilt from scratch by `scripts/fetch-python-mlx.sh --force`,
which would otherwise delete a README sitting inside it.

## What's in here

```
python-runtime/
  bin/python3            ← cpython 3.11.15, relocatable (Astral's build)
  bin/python3.11         ← actual binary (python3 is a symlink)
  lib/python3.11/        ← stdlib + every pip-installed package
  include/               ← Python C headers (used by some pip-installed pkgs)
  share/                 ← stdlib data files (encodings, tcl/tk, etc.)
  serve.py               ← our OpenAI-compatible HTTP shim
  python-supervised.sh   ← death-pact wrapper (the actual entrypoint)
  README.md              ← you are here
  .installed             ← marker file (lets the fetch script skip rebuilds)
```

The Mac app invokes `python-supervised.sh` with arguments like:

```
python-supervised.sh --model <path-to-mlx-dir> --port 1235 --ctx-size 8192
```

The wrapper:
1. Watches `$HALO_PARENT_PID` (set by the Mac app to its own pid). When
   that pid disappears (Mac app crashed, force-killed, etc.), the
   wrapper SIGTERMs then SIGKILLs the python child. This stops orphaned
   processes from keeping ~3-4GB of RAM busy after the app dies.
2. Execs `bin/python3 serve.py <args>` with the args forwarded.

`serve.py` then binds FastAPI to the requested port *immediately*
and starts loading the model on a background worker thread. `/health`
returns 503 + `{status:"loading", elapsed:N.Ns}` while loading, then
200 + `{status:"ok"}` once ready. The Mac app's readiness probe
waits for the 200 before flipping the menubar from "Loading…" to
"Ready" — a synchronous load (the older shape) made `/health` time
out for ~3-10s during boot, which made the harness's downstream
probe block too.

This build is **text-only** — no `mlx-vlm`, no `torch`, no
`torchvision`. mlx-lm has its own loaders for Qwen3 / Qwen3.5 /
Llama / etc., and can load the language portion of `mlx-community`
VLM repos directly (Qwen3.5-2B-6bit's config declares
`model_type: qwen3_5`, which mlx-lm's `qwen3_5.py` loader handles
natively). Skipping the VLM stack saves ~700MB of bundle size.
If image or video input becomes a real requirement, restoring is a
one-line edit to the `pip install` line in
`scripts/fetch-python-mlx.sh`.

## How this directory got built

Run this from the repo root:

```
./scripts/fetch-python-mlx.sh
```

That script:
1. Downloads a relocatable cpython tarball from
   [python-build-standalone](https://github.com/astral-sh/python-build-standalone/releases)
   (Astral's project — same thing `uv` uses internally), extracts it
   to `python-runtime/`.
2. `pip install`s our (small) dependency set into the bundled python's
   site-packages: `mlx`, `mlx-lm`, `fastapi`, `uvicorn[standard]`.
3. Copies `scripts/serve.py` into `python-runtime/serve.py` so the
   bundle is self-contained.
4. Strips `__pycache__/` and dependency `tests/` directories to save
   a few hundred MB.
5. Touches `.installed` so future runs skip the slow pip step.

Re-run with `--force` to rebuild from scratch.

## How it gets into the .app

Xcode's `Bundle python-runtime` build phase (defined in
`MacApp/HaloApp/HaloApp.xcodeproj/project.pbxproj`) does:

1. Calls `scripts/fetch-python-mlx.sh` (idempotent — no work if
   `.installed` is recent enough).
2. `ditto`s the entire `python-runtime/` tree into
   `HaloApp.app/Contents/Resources/python-runtime/`. We use `ditto`
   instead of `cp -R` because it preserves symlinks (e.g. `bin/python3`
   → `python3.11`) and resource forks correctly.
3. Re-copies `scripts/python-supervised.sh` and `scripts/serve.py`
   from the source tree (so editing them doesn't require a fetch
   re-run).

## Adding a Python dependency

Edit `scripts/fetch-python-mlx.sh` — append your package to the
`pip install` line, then:

```
./scripts/fetch-python-mlx.sh --force
```

That rebuilds everything (~2-3 min). Verify the new package imports:

```
./python-runtime/bin/python3 -c "import your_package; print(your_package.__version__)"
```

The next Xcode build will pick up the change automatically.

## Bumping the Python version

Edit `PYTHON_VERSION` and `PYTHON_BUILD_TAG` at the top of
`scripts/fetch-python-mlx.sh`. Find the current tag at
[python-build-standalone releases](https://github.com/astral-sh/python-build-standalone/releases).
Then `./scripts/fetch-python-mlx.sh --force`.

3.11.x is the sweet spot for wheel coverage as of 2026-Q2 — every
mlx + transformers dep ships an arm64 wheel for it. If you bump to a
newer Python, double-check:

- `mlx` has a wheel: `https://pypi.org/simple/mlx/` and look for `cp31N`
- `torch` has a wheel: `https://pypi.org/simple/torch/`
- `mlx-vlm` works (it tracks transformers releases closely)

## Running serve.py manually

For debugging, you can launch `serve.py` outside the Mac app:

```
./python-runtime/bin/python3 ./scripts/serve.py \
  --model ~/Library/Application\ Support/HaloApp/models/qwen3.5-2b-6bit \
  --port 1235 \
  --ctx-size 8192
```

Then hit it with curl:

```
# Health
curl http://127.0.0.1:1235/health

# Models list
curl http://127.0.0.1:1235/v1/models

# Chat
curl http://127.0.0.1:1235/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role":"user","content":"hi"}],
    "max_tokens": 50,
    "stream": false
  }'

# Streaming
curl -N http://127.0.0.1:1235/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role":"user","content":"count to 5"}],
    "max_tokens": 50,
    "stream": true
  }'
```

## Logs

Two log files under `~/Library/Logs/HaloApp/`:

```
~/Library/Logs/HaloApp/runtime.log         ← halo-runtime (Bun harness)
~/Library/Logs/HaloApp/llama-server.log    ← serve.py (model server)
```

Both are tee'd from the spawned child's stdout/stderr by ModelServer.swift
and RuntimeServer.swift respectively. The "llama-server" filename is
historical — older builds bundled llama.cpp's `llama-server` binary;
contents are now `serve.py` output. Each spawn appends a header line
with the timestamp and the launched command, so you can find the right
section even across many app restarts.

Tail both to debug a boot:

```sh
tail -f ~/Library/Logs/HaloApp/{runtime,llama-server}.log
```

For the Mac app side (ModelServer.swift, AppDelegate, hotkey, etc.),
filter `Console.app` by subsystem `halo.runtime` — the Swift code uses
`os.Logger(subsystem: "halo.runtime", category: "<file>")` everywhere.

## Common failure modes

**"There is no Stream(gpu, 0) in current thread."** mlx-vlm's
`generation_stream` is created on first import and lives in that
thread. If `serve.py` was edited to import mlx-vlm at module level
(rather than inside the worker-thread callbacks), this breaks. The
fix is to load + generate from the same dedicated worker thread —
see `_GEN_EXECUTOR` in `serve.py`.

**`Qwen3VLVideoProcessor requires the Torchvision library`** (or
similar VLM-loader errors). Means the user picked a model whose
loader needs torch — but this build is text-only. Two fixes:
(a) drop the model from the catalog, (b) re-add `mlx-vlm torch
torchvision` to the `pip install` in `scripts/fetch-python-mlx.sh`
and accept the ~700MB bundle bloat.

**"unknown model id"** at startup. The Mac app's selectedModelId in
UserDefaults points at a catalog entry that no longer exists. Either
re-run setup or `defaults delete halo.HaloApp halo.selectedModelId`.

**Bundle size**. ~363MB for python-runtime/, ~450MB for the .app
overall. Largest contributors: mlx (~180MB), Python interpreter
(~80MB), transformers (~50MB), pip itself (~30MB). If we ever
restore VLM support, expect bundle to roughly triple.
