"""
serve.py — OpenAI-compatible HTTP server in front of mlx-lm.

WHAT THIS IS
============
A ~350-line FastAPI app that exposes an MLX-loaded language model on
HTTP using the OpenAI API shape, so the rest of the stack (the Bun
harness `halo-runtime`) can talk to it the same way it talks to
LM Studio or any other OpenAI-compatible endpoint.

The Mac app spawns this process with an arg list like:
    python3 serve.py --model <path-to-mlx-dir> --port 1235 --ctx-size 8192

WHY IT EXISTS
=============
mlx-lm is a *library*, not a server. It gives you Python functions
like `mlx_lm.generate(model, tokenizer, prompt, ...)` but no HTTP. We
need HTTP because the harness is in a different process (Bun) and
OpenAI-compat is the lingua franca that lets us swap the backend
(LM Studio, our bundled MLX, hosted APIs) without changing the harness.

TEXT-ONLY: NO VISION/VIDEO
==========================
This build deliberately ships *without* mlx-vlm + torch + torchvision
+ transformers' video processor. That cuts ~700MB from the bundle.
mlx-lm's loader handles Qwen3 / Qwen3.5 / Llama / etc. directly,
including the language-model portion of VLM repos like
`mlx-community/Qwen3.5-2B-6bit` (config.json `model_type: qwen3_5`,
which mlx-lm has a native loader for). If a user points at a true
vision-only model that mlx-lm doesn't recognize, loading fails with
a clear error message.

LOAD MODEL IN BACKGROUND
========================
Earlier versions loaded the model synchronously *before* uvicorn
bound the port. That meant /health didn't respond at all for ~3-10s
during boot, which made the harness's own /v1/health hang waiting
on the model — and the Mac app's URLSession probe time out at 60s.

Now we bind uvicorn first and load the model on a background task.
/health returns 503 + {"status":"loading", "progress":"..."} while
loading, then 200 + {"status":"ok"} once ready. ModelServer.swift's
healthOK() treats *any* response as a sign the process is alive;
the new "loaded" check on the response body decides when to flip
from `.starting` → `.running`.

ROUTES
======
    GET  /health                   — readiness probe (200=ready, 503=loading)
    GET  /v1/models                — list loaded model
    POST /v1/chat/completions      — streaming + non-streaming + tool calls
    POST /v1/embeddings            — placeholder (returns 501)
"""

from __future__ import annotations

import argparse
import asyncio
import concurrent.futures
import json
import logging
import os
import re
import sys
import time
import threading
import uuid
from pathlib import Path
from typing import Any, Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

logging.basicConfig(
    level=logging.INFO,
    format="[mlx %(asctime)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("mlx-server")


# ----------------------------------------------------------------------------
# Model loading state — one global, mutated only on the worker thread.
# ----------------------------------------------------------------------------

class ModelState:
    """
    Single source of truth for "what model is loaded, and is it ready?".
    Mutated only on the dedicated MLX worker thread (see _GEN_EXECUTOR).
    Read from any thread; the GIL makes simple reads safe enough — we
    never partially-update fields, so a reader sees either pre-load or
    post-load state, never half.
    """
    def __init__(self):
        self.model: Any = None
        self.tokenizer: Any = None
        self.model_id: str = ""
        self.path: Optional[Path] = None
        self.ctx_size: int = 0
        # Loading lifecycle: "loading" → "ready" or "error".
        self.status: str = "loading"
        self.error: Optional[str] = None
        self.loaded_at: Optional[float] = None
        self.load_started_at: float = time.monotonic()


state = ModelState()


def _load_model(path: Path, ctx_size: int) -> None:
    """
    Run on the MLX worker thread (see _GEN_EXECUTOR) — both because
    mlx-lm's stream object is thread-local (created on first import,
    must live in the thread that uses it) and because model loading
    is heavy enough to warrant separation from the asyncio loop.
    """
    state.model_id = path.name
    state.path = path
    state.ctx_size = ctx_size
    state.status = "loading"
    state.load_started_at = time.monotonic()

    log.info(f"loading {path.name}")

    try:
        from mlx_lm import load as lm_load
        state.model, state.tokenizer = lm_load(str(path))
        state.status = "ready"
        state.loaded_at = time.monotonic()
        elapsed = state.loaded_at - state.load_started_at
        log.info(f"loaded {path.name} in {elapsed:.1f}s")
    except Exception as e:
        state.status = "error"
        state.error = str(e)
        log.error(f"load failed: {e}")


# ----------------------------------------------------------------------------
# Tool call parsing.
# ----------------------------------------------------------------------------

# Two formats wrapped by `<tool_call>...</tool_call>`:
#   JSON (Qwen3, Hermes):       {"name": "...", "arguments": {...}}
#   XML  (Qwen3.5, some Llama): <function=name><parameter=k>v</parameter></function>
TOOL_CALL_RE = re.compile(r"<tool_call>\s*(.*?)\s*</tool_call>", re.DOTALL)
XML_FUNCTION_RE = re.compile(r"<function=([^>]+)>(.*?)</function>", re.DOTALL)
XML_PARAMETER_RE = re.compile(r"<parameter=([^>]+)>\s*(.*?)\s*</parameter>", re.DOTALL)


def _parse_xml_tool_call(body: str) -> Optional[dict[str, Any]]:
    fn_match = XML_FUNCTION_RE.search(body)
    if not fn_match:
        return None
    name = fn_match.group(1).strip()
    args = {}
    for param in XML_PARAMETER_RE.finditer(fn_match.group(2)):
        args[param.group(1).strip()] = param.group(2).strip()
    return {"name": name, "arguments": args}


def extract_tool_calls(text: str) -> tuple[str, list[dict[str, Any]]]:
    """Pull `<tool_call>...</tool_call>` blocks out and reformat as OpenAI
    `tool_calls`. Returns (cleaned_text, calls). `arguments` is a JSON
    *string* per OpenAI convention so SDKs can parse lazily."""
    calls = []
    for match in TOOL_CALL_RE.finditer(text):
        body = match.group(1).strip()
        payload: Optional[dict[str, Any]] = None
        if body.startswith("{"):
            try:
                payload = json.loads(body)
            except json.JSONDecodeError:
                log.warning(f"unparseable JSON tool_call: {body[:80]}")
        elif "<function" in body:
            payload = _parse_xml_tool_call(body)
            if payload is None:
                log.warning(f"unparseable XML tool_call: {body[:80]}")
        else:
            log.warning(f"unrecognized tool_call shape: {body[:80]}")
        if payload is None:
            continue
        calls.append({
            "id": f"call_{uuid.uuid4().hex[:24]}",
            "type": "function",
            "function": {
                "name": payload.get("name", ""),
                "arguments": json.dumps(payload.get("arguments", {})),
            },
        })
    cleaned = TOOL_CALL_RE.sub("", text).strip()
    return cleaned, calls


# ----------------------------------------------------------------------------
# Request / response shapes (OpenAI-compatible subset).
# Only the fields the harness actually uses; extra="allow" lets unknowns
# pass through silently for forward-compat with new OpenAI fields.
# ----------------------------------------------------------------------------

class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="allow")
    role: str
    content: Optional[Any] = None
    name: Optional[str] = None
    tool_calls: Optional[list[dict[str, Any]]] = None
    tool_call_id: Optional[str] = None


class ChatCompletionsRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: Optional[str] = None
    messages: list[ChatMessage]
    temperature: float = 0.7
    top_p: float = 1.0
    max_tokens: int = Field(default=2048, ge=1, le=32768)
    stream: bool = False
    tools: Optional[list[dict[str, Any]]] = None
    tool_choice: Optional[Any] = None
    stop: Optional[Any] = None
    # Qwen3 family: when False, the chat template injects an empty
    # `<think></think>` block so the model skips its reasoning trace.
    # We default to True because the dock has dedicated UI for the
    # trace ("thinking capsules") — serve.py routes content inside
    # `<think>...</think>` to OpenAI's `delta.reasoning_content`
    # field, and the harness re-emits it as a separate SSE
    # `event: thinking` so the dock can render it independently of
    # the assistant message body. Set false in the request body to
    # opt out (faster, no trace at all).
    enable_thinking: bool = True


# ----------------------------------------------------------------------------
# App + worker thread.
# ----------------------------------------------------------------------------

app = FastAPI(title="halo-mlx-server")

# Single dedicated worker thread for both load and generation. mlx-lm
# objects (Stream, etc.) are thread-local — pinning everything to one
# thread means they get created once and reused. Also the right
# concurrency model: GPU does one generation at a time anyway.
_GEN_EXECUTOR = concurrent.futures.ThreadPoolExecutor(
    max_workers=1, thread_name_prefix="mlx-gen"
)


def _require_loaded():
    """Raise 503 if generation is requested before the model is ready.
    Better than letting requests pile up in the executor queue while
    the model is loading — the caller can retry with backoff."""
    if state.status == "loading":
        elapsed = time.monotonic() - state.load_started_at
        raise HTTPException(503, f"model loading ({elapsed:.1f}s)")
    if state.status == "error":
        raise HTTPException(500, f"model load failed: {state.error}")


@app.get("/health")
async def health():
    """Readiness probe.
    - 200 + {status:"ok"} when model is loaded and generation is ready
    - 503 + {status:"loading", elapsed:N.Ns} during model load
    - 503 + {status:"error", error:"..."} if load failed

    ModelServer.swift's healthOK() requires a 200 to flip into
    `.running` — so the Mac app's UI will show "Loading <id>…"
    until we return 200 here.
    """
    if state.status == "ready":
        return {"status": "ok", "model": state.model_id}
    elapsed = time.monotonic() - state.load_started_at
    body = {"status": state.status, "model": state.model_id, "elapsed": round(elapsed, 1)}
    if state.error:
        body["error"] = state.error
    return JSONResponse(status_code=503, content=body)


@app.get("/v1/models")
async def list_models():
    """OpenAI model list. Always returns the real model id — the
    harness caches whatever we return at boot for its `modelId`,
    which feeds back into the dock's status header. Returning a
    `loading-<id>` placeholder during the load window meant the
    harness held onto that placeholder for the whole session even
    after the model was ready."""
    return {
        "object": "list",
        "data": [{
            "id": state.model_id,
            "object": "model",
            "owned_by": "halo",
            "created": int(time.time()),
        }],
    }


@app.get("/api/v0/models")
async def lm_studio_compat_models():
    """LM Studio-flavoured. The harness's `probeServerCapabilities()`
    reads `loaded_context_length` from here for the menubar context pill."""
    return {
        "data": [{
            "id": state.model_id or "pending",
            "type": "llm",
            "state": "loaded" if state.status == "ready" else "loading",
            "loaded_context_length": state.ctx_size,
            "capabilities": ["tool_use"],
        }],
    }


@app.post("/v1/chat/completions")
async def chat_completions(req: ChatCompletionsRequest, raw: Request):
    _require_loaded()

    messages = [m.model_dump(exclude_none=True) for m in req.messages]
    # Build template kwargs incrementally so we can drop unsupported
    # keys (older tokenizers lack `tools=` / `enable_thinking=` and
    # raise TypeError if you pass them).
    tmpl_kwargs: dict[str, Any] = {
        "add_generation_prompt": True,
        "tokenize": False,
    }
    if req.tools:
        tmpl_kwargs["tools"] = req.tools
    # Always pass enable_thinking — Qwen3's template only suppresses
    # thinking when the kwarg is *defined and false*; omitting the
    # kwarg leaves the model in default thinking-on behaviour.
    tmpl_kwargs["enable_thinking"] = req.enable_thinking
    try:
        prompt = state.tokenizer.apply_chat_template(messages, **tmpl_kwargs)
    except TypeError:
        # Tokenizer doesn't accept one of our kwargs — retry with the
        # bare minimum. We lose tools + thinking control but at least
        # the request succeeds.
        log.warning("template rejected tools/enable_thinking — retrying bare")
        prompt = state.tokenizer.apply_chat_template(
            messages, add_generation_prompt=True, tokenize=False
        )
    except Exception as e:
        log.error(f"chat template failed: {e}")
        raise HTTPException(400, f"chat template error: {e}")

    if req.stream:
        return StreamingResponse(
            stream_completion(prompt, req),
            media_type="text/event-stream",
        )
    return await complete_once(prompt, req)


async def complete_once(prompt: str, req: ChatCompletionsRequest) -> JSONResponse:
    loop = asyncio.get_running_loop()
    text = await loop.run_in_executor(_GEN_EXECUTOR, _generate_sync, prompt, req)

    # If the prompt prepended `<think>\n` (Qwen3 enable_thinking=True),
    # the model output starts already inside a think block — there is
    # no `<think>` opener in the response, only the closing `</think>`.
    # Synthesise the opener so _split_thinking can split cleanly.
    if prompt.rstrip().endswith("<think>"):
        text = "<think>" + text

    # Split out the reasoning trace (if any) and pull tool calls out
    # of the residual content. Order matters: thinking can wrap tool
    # calls in some prompt shapes, so strip thinking first.
    reasoning, content = _split_thinking(text)
    content_clean, tool_calls = extract_tool_calls(content)

    message: dict[str, Any] = {"role": "assistant", "content": content_clean or None}
    if reasoning:
        # Mirrors LM Studio's MLX runtime — the harness's client.ts
        # reads `message.reasoning_content` and routes it to the
        # dock's thinking-capsule UI.
        message["reasoning_content"] = reasoning
    finish_reason = "stop"
    if tool_calls:
        message["tool_calls"] = tool_calls
        finish_reason = "tool_calls"

    return JSONResponse({
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": state.model_id,
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    })


THINK_BLOCK_RE = re.compile(r"<think>(.*?)</think>\s*", re.DOTALL)


def _split_thinking(text: str) -> tuple[str, str]:
    """Pull `<think>...</think>` blocks out of `text`. Returns
    (concatenated_reasoning, text_with_blocks_removed). Multiple
    blocks join with a blank line."""
    parts = THINK_BLOCK_RE.findall(text)
    if not parts:
        return "", text
    cleaned = THINK_BLOCK_RE.sub("", text).strip()
    return "\n\n".join(p.strip() for p in parts if p.strip()), cleaned


def _generate_sync(prompt: str, req: ChatCompletionsRequest) -> str:
    """Blocking generation on the dedicated MLX worker thread. Returns
    the full generated text. mlx-lm 0.31 takes a sampler callable
    instead of `temp=` directly."""
    from mlx_lm import generate as lm_generate
    from mlx_lm.sample_utils import make_sampler
    sampler = make_sampler(temp=req.temperature, top_p=req.top_p)
    result = lm_generate(
        state.model,
        state.tokenizer,
        prompt=prompt,
        max_tokens=req.max_tokens,
        sampler=sampler,
        verbose=False,
    )
    # mlx-lm 0.20+ returns GenerationResponse; older versions returned
    # a string. Coerce both.
    return getattr(result, "text", result) if not isinstance(result, str) else result


async def stream_completion(prompt: str, req: ChatCompletionsRequest):
    """SSE streaming. mlx-lm's `stream_generate` is a sync generator;
    we run it in the worker thread, pipe deltas through an asyncio.Queue."""
    completion_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())

    def chunk(delta: dict[str, Any], finish_reason: Optional[str] = None) -> str:
        payload = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": state.model_id,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
        }
        return f"data: {json.dumps(payload)}\n\n"

    yield chunk({"role": "assistant"})

    queue: asyncio.Queue[Optional[str]] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def producer():
        try:
            from mlx_lm import stream_generate as lm_stream
            from mlx_lm.sample_utils import make_sampler
            gen = lm_stream(
                state.model, state.tokenizer,
                prompt=prompt,
                max_tokens=req.max_tokens,
                sampler=make_sampler(temp=req.temperature, top_p=req.top_p),
            )
            for response in gen:
                # mlx-lm 0.20+ yields GenerationResponse; .text can be
                # empty between yields (multi-byte char buffering) — use
                # hasattr, not truthiness, to dispatch.
                if hasattr(response, "text"):
                    token = response.text
                elif isinstance(response, str):
                    token = response
                else:
                    continue
                if token:
                    asyncio.run_coroutine_threadsafe(queue.put(token), loop).result()
        except Exception as e:
            log.error(f"generation failed: {e}")
            asyncio.run_coroutine_threadsafe(queue.put(f"\n[error: {e}]"), loop).result()
        finally:
            asyncio.run_coroutine_threadsafe(queue.put(None), loop).result()

    loop.run_in_executor(_GEN_EXECUTOR, producer)

    # ── Token routing state machine ──
    #
    # The model's raw stream interleaves three things we want routed
    # to *different* OpenAI delta fields:
    #
    #   - Plain text   → emit as `delta.content` (the chat bubble)
    #   - `<think>...</think>` reasoning trace
    #                   → emit as `delta.reasoning_content` (the dock
    #                     renders these in collapsible "thinking
    #                     capsules", separate from the chat bubble)
    #   - `<tool_call>...</tool_call>` markup
    #                   → buffer until full block, parse, emit as
    #                     `delta.tool_calls` in OpenAI shape
    #
    # We have three modes (text | think | tool) and a tiny lookback
    # buffer that holds tokens just long enough to detect a tag
    # boundary. The buffer prevents partial markers like `<thi` (split
    # across two model tokens) from leaking out as "content" before
    # we recognise them as a `<think>` opener.
    OPENERS = ("<think>", "<tool_call>")
    THINK_CLOSE = "</think>"
    TOOL_CLOSE = "</tool_call>"

    def _opener_prefix_len(s: str) -> int:
        """How many trailing chars of `s` could be the start of an
        opener tag? That many chars get held back from flushing as
        plain content — once we see more bytes we know whether it
        was a real opener or just a stray `<`."""
        for opener in OPENERS:
            for k in range(min(len(s), len(opener) - 1), 0, -1):
                if opener.startswith(s[-k:]):
                    return k
        return 0

    def _closer_prefix_len(s: str, closer: str) -> int:
        for k in range(min(len(s), len(closer) - 1), 0, -1):
            if closer.startswith(s[-k:]):
                return k
        return 0

    # Initial mode: if the chat template prepended `<think>\n` to the
    # prompt (Qwen3 does this when enable_thinking=True), the model's
    # first generated tokens are already inside a think block — there
    # is no `<think>` opener in the output to trigger our transition,
    # only a `</think>` closer later. Detect by sniffing the rendered
    # prompt's trailing chars and start in `think` mode accordingly.
    # `re.sub` strips trailing whitespace before the substring check
    # so we tolerate `<think>\n` vs `<think>` vs `<think>\n\n`.
    prompt_tail = prompt.rstrip()
    mode = "think" if prompt_tail.endswith("<think>") else "text"
    buffer = ""
    tool_calls_emitted = False

    while True:
        token = await queue.get()
        eof = token is None
        if not eof:
            buffer += token

        # Drain as much of the buffer as we can each round. We loop
        # because finishing a tag (e.g. exiting THINK mode) might let
        # us recognise a new opener in the same tick.
        progressed = True
        while progressed:
            progressed = False
            if mode == "text":
                think_at = buffer.find("<think>")
                tool_at = buffer.find("<tool_call>")
                # Earliest opener wins.
                positions = [(p, k) for p, k in [(think_at, "think"), (tool_at, "tool")] if p != -1]
                if positions:
                    pos, kind = min(positions, key=lambda t: t[0])
                    if pos > 0:
                        yield chunk({"content": buffer[:pos]})
                    open_tag = "<think>" if kind == "think" else "<tool_call>"
                    buffer = buffer[pos + len(open_tag):]
                    mode = kind
                    progressed = True
                    continue
                hold = _opener_prefix_len(buffer)
                if eof:
                    if buffer:
                        yield chunk({"content": buffer})
                        buffer = ""
                elif len(buffer) > hold:
                    flush = buffer[:-hold] if hold else buffer
                    if flush:
                        yield chunk({"content": flush})
                    buffer = buffer[-hold:] if hold else ""
            elif mode == "think":
                close_at = buffer.find(THINK_CLOSE)
                if close_at != -1:
                    if close_at > 0:
                        yield chunk({"reasoning_content": buffer[:close_at]})
                    buffer = buffer[close_at + len(THINK_CLOSE):]
                    mode = "text"
                    progressed = True
                    continue
                hold = _closer_prefix_len(buffer, THINK_CLOSE)
                if eof:
                    if buffer:
                        yield chunk({"reasoning_content": buffer})
                        buffer = ""
                elif len(buffer) > hold:
                    flush = buffer[:-hold] if hold else buffer
                    if flush:
                        yield chunk({"reasoning_content": flush})
                    buffer = buffer[-hold:] if hold else ""
            elif mode == "tool":
                close_at = buffer.find(TOOL_CLOSE)
                if close_at != -1:
                    body = buffer[:close_at]
                    buffer = buffer[close_at + len(TOOL_CLOSE):]
                    # extract_tool_calls expects the wrapped form;
                    # re-wrap so we can reuse the JSON+XML parser.
                    _, calls = extract_tool_calls(f"<tool_call>{body}</tool_call>")
                    if calls:
                        yield chunk({"tool_calls": calls}, finish_reason="tool_calls")
                        tool_calls_emitted = True
                    mode = "text"
                    progressed = True
                    continue
                # Mid-tool-call — never leak partial markup to the
                # client. Keep buffering until we see </tool_call> or EOF.
                if eof:
                    log.warning(f"unterminated <tool_call>: {buffer[:80]}")
                    buffer = ""
        if eof:
            break

    if not tool_calls_emitted:
        yield chunk({}, finish_reason="stop")
    yield "data: [DONE]\n\n"


@app.post("/v1/embeddings")
async def embeddings(req: Request):
    raise HTTPException(
        501,
        "no embedding model loaded — bundle one via catalog.json + "
        "--embedding-model arg (not wired in v8.5)",
    )


# ----------------------------------------------------------------------------
# Death-pact: poll HALO_PARENT_PID and exit when it disappears. Belt-and-
# braces with the python-supervised.sh wrapper — works even if the wrapper
# is bypassed (e.g. someone runs serve.py directly with HALO_PARENT_PID set).
# ----------------------------------------------------------------------------

def _start_parent_watchdog(app: FastAPI):
    pid_str = os.environ.get("HALO_PARENT_PID")
    if not pid_str:
        return
    try:
        parent_pid = int(pid_str)
    except ValueError:
        return

    async def watchdog():
        while True:
            await asyncio.sleep(2.0)
            try:
                os.kill(parent_pid, 0)
            except ProcessLookupError:
                log.error(f"parent pid {parent_pid} is gone — exiting")
                os._exit(0)
            except PermissionError:
                pass

    @app.on_event("startup")
    async def kick_off_watchdog():
        asyncio.create_task(watchdog())


# ----------------------------------------------------------------------------
# Entrypoint.
# ----------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="halo MLX server")
    parser.add_argument("--model", required=True, help="path to MLX model directory")
    parser.add_argument("--port", type=int, default=1235)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--ctx-size", type=int, default=8192,
                        help="advertised context window — informational; mlx-lm "
                             "doesn't enforce a server-side cap")
    args = parser.parse_args()

    model_path = Path(args.model).expanduser().resolve()
    if not model_path.is_dir():
        print(f"error: --model must be a directory; got {model_path}", file=sys.stderr)
        sys.exit(1)

    # Set basic state so /health can describe the in-progress load
    # before the executor thread even picks up the load task.
    state.model_id = model_path.name
    state.path = model_path
    state.ctx_size = args.ctx_size

    # Submit the model load to the worker thread. Don't block — we want
    # uvicorn binding the port immediately so /health is responsive.
    _GEN_EXECUTOR.submit(_load_model, model_path, args.ctx_size)

    _start_parent_watchdog(app)

    log.info(f"listening on http://{args.host}:{args.port} (model loading in background)")
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level="warning",
        access_log=False,
    )


if __name__ == "__main__":
    main()


# ----------------------------------------------------------------------------
# TODO — embeddings
# ----------------------------------------------------------------------------
# To wire embeddings:
#   1. Add an embedding-model entry to catalog.json (e.g. nomic-embed-text-v1.5
#      MLX port at mlx-community/nomic-embed-text-v1.5) with role="embeddings".
#   2. Teach ModelCatalog.swift to pick + download alongside the chat model.
#   3. Pass --embedding-model <path> from ModelServer.swift.
#   4. Replace the 501 with: load via mlx-embeddings or sentence-transformers,
#      apply nomic prefix (search_query: / search_document:) based on input,
#      return OpenAI-shaped {data: [{embedding: [...], index: 0}]}.
# Deferred from v8.5 because the catalog doesn't yet track multi-role
# entries and shipping a chat model alone is the higher-value step.
