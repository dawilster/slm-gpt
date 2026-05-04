# slm-gpt

A personal assistant that runs on a small local model — **Qwen 3-4B-Instruct** (4-bit MLX, ~2.4 GB) served by LM Studio. ~20 tok/s on an 8 GB M1 Air. Private, offline-capable, free per token.

Built incrementally — one mental model per version. The full architecture, version trajectory, and decision log live in [`design.md`](./design.md).

---

## Quick start

```bash
# 1. Start LM Studio, load Qwen 3-4B-Instruct-2507, start the Developer server.
# 2. Then:
bun install
bun run src/index.ts                    # new session
bun run src/index.ts --resume           # most recent session
bun run src/index.ts --load <id-prefix> # specific session
```

Inside the REPL:

```
/quit  /clear  /new  /history  /tokens  /context  /budget [n]
/sessions  /load <id>  /resume  /tools  /profile  /forget <key>
```

State lives at `~/.assistant/`:
- `sessions/*.jsonl` — append-only chat history
- `notes/*.md` — markdown corpus the assistant can search/read/write
- `profile.json` — flat key→value facts loaded into every system prompt

---

## The trajectory

One concept per version. We don't advance until the previous one is felt.

| v | Concept | Status |
|---|---|---|
| v0 | Bare chat loop | shipped |
| v1 | Context management (budget, sliding window) | shipped |
| v2 | Persistence (kill → reload → recall) | shipped |
| v3 | Single-tool agent loop | shipped |
| v4 | Multi-tool routing (5 tools) | shipped |
| v5 | Profile — mutable current truth | shipped |
| v6 | Local RAG over notes & sessions | shipped |
| v6.5 | System bridge (Apple Shortcuts) | shipped |
| v7 | Web search | next |
| v8 | Tiered model routing (local → mid → frontier) | future |
| v9 | Background daemon, scheduling, notifications | future |
| v10+ | Channel adapters (iMessage, Slack, …) | future |

Capability-level pass conditions and evals live in `eval/suites/*.ts` and `design.md` §6. Run with `bun run eval/run.ts` (or `bun run eval/run.ts <suite>` for one; `--offline` to skip model-driven checks).

---

## What works (and what doesn't) at 4B

**Works well:** tool calling at 7+ tools, profile recall, saving facts on demand, anti-confabulation, single-step actions.

**Breaks:** multi-step reasoning past 3 hops, code generation > 30 lines, long context past ~20 turns, negation/quantifiers, plan-then-execute.

The full failure-mode catalog (with mitigations) lives in `design.md` §5. The short version: be explicit, one concept per turn, `/clear` between topics, escalate to a frontier model when the answer must be *correct* rather than *plausible*.

---

## Architecture, in one picture

```
┌──────────────────────────────────────────┐
│  Brain (TypeScript / Bun)                │
│   chat loop · context · tools · memory   │
│   router (tier selection)  ← v8          │
└────────────────┬─────────────────────────┘
                 │ OpenAI-compatible HTTP
                 ▼
┌──────────────────────────────────────────┐
│  Model tiers                             │
│   local     LM Studio / Qwen 3-4B   ←now │
│   mid       Haiku / Sonnet / mini   ←v8  │
│   frontier  Opus / GPT-5            ←v8  │
└──────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────┐
│  Local services                          │
│   notes (md) · vector index · shortcuts  │
└──────────────────────────────────────────┘
```

Principles: HTTP between brain and model (no SDK lock-in); memory as plain markdown; state on disk; routing is ambient; the privacy boundary is enforced *before* tier selection.

---

## Privacy

Profile, notes, and sessions are all local on the laptop. No telemetry, no third-party calls, no cloud. The privacy boundary becomes load-bearing at v8 when remote tiers arrive — until then it's a side-effect of being purely local.

---

## License

Personal project. No license attached yet.
