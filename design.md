# Design — Personal Assistant on Local SLMs

A working document. Update as we learn.

## 1. Vision

A personal assistant in the spirit of OpenClaw / Jarvis:
- Knows me, my notes, my context.
- Lives on a generic chat interface today, on more channels later.
- Built incrementally, one capability at a time.
- **Model-agnostic by design.** Today the brain is a small local model (Qwen2.5-3B on LM Studio). Tomorrow it's a *tiered* system: local handles the easy 80%, a mid-tier model handles the harder 15%, a frontier model handles the rare 5% that genuinely needs it. The brain (the router) decides; the model just answers.

The stretch goal is "my own OpenClaw." The near-term goal is "the smallest assistant I'd actually use daily."

## 2. Constraints

These are the cards we're playing.

| Constraint | Reality |
|---|---|
| Hardware | M1 MacBook Air, 8GB unified memory |
| Available headroom | ~3.5–4 GB for a model after OS + apps |
| Primary local model | Qwen3-4B-Instruct-2507 (4-bit MLX), ~2.4GB |
| Steady-state inference | ~20 tok/s via LM Studio (~25 tok/s direct mlx-lm) |
| Context window | Practical ceiling ~4K–8K tokens (KV cache eats RAM at long context) |
| Tool calling | Adequate at this size with Qwen; weak with Llama 3.2 |
| Reasoning depth | 1–3 hop reasoning okay; deeper chains break |

**Honest expectations:** This won't out-think Claude Opus. It won't write a working Flask API end-to-end. What it *will* do is summarize, classify, extract, route, and serve as a conversational shell over local data — fast, free per token, private, offline-capable. We design around the strengths.

## 3. Architecture

```
┌──────────────────────────────────────────┐
│  Brain (TypeScript / Bun)                │
│   - chat loop                            │
│   - context management                   │
│   - tool dispatch                        │
│   - memory / persistence                 │
│   - router (tier selection)  ← critical  │
│   - eventually: channels (Slack, etc.)   │
└────────────────┬─────────────────────────┘
                 │ OpenAI-compatible HTTP (per tier)
                 ▼
┌──────────────────────────────────────────┐
│  Model tiers (router decides)            │
│   ┌────────────────────────────────────┐ │
│   │ local     LM Studio / Qwen-3B      │ │  default; cheap, fast, private, weak
│   │ mid       Haiku / Sonnet / GPT-mini│ │  escalation; cheap-ish, capable
│   │ frontier  Opus / GPT-5             │ │  rare; expensive, capable
│   └────────────────────────────────────┘ │
└──────────────────────────────────────────┘
                 │
                 ▼ (used by RAG, embeddings, ...)
┌──────────────────────────────────────────┐
│  Local services                          │
│   - notes folder (markdown)              │
│   - vector index (bun:sqlite + sqlite-vec│
│   - calendar/file/system tools           │
└──────────────────────────────────────────┘
```

**Architectural principles:**

1. **Brain ↔ model is HTTP.** Always. No SDK lock-in. OpenAI-compat is the contract.
2. **One config knob per tier:** each model tier is an OpenAI-compat endpoint behind a `ModelClient` interface; tiers compose, they don't fork the code.
3. **Tools are discrete, typed capabilities.** Each tool has a clear schema and a small surface. Small models cope better with 3 sharp tools than 12 fuzzy ones.
4. **Memory is plain markdown files** wherever possible. Greppable, version-controllable, portable, AI-readable.
5. **State lives on disk, not in process.** Restarting the brain doesn't lose context.
6. **Routing is ambient.** Every request passes through the router before it reaches a model. The default tier is local — escalation is a deliberate act, not an accident.

### 3.4 Model tiers and routing

The brain talks to *tiers*, not specific providers. Each tier is an OpenAI-compatible endpoint exposed by a `ModelClient` implementation. The router picks one per request based on policy.

**The three tiers:**

| Tier | Examples (today) | Cost | Latency | Privacy | Use it when |
|---|---|---|---|---|---|
| **local** | Qwen2.5-3B on LM Studio | $0 | ~20 tok/s on M1 | full — never leaves the laptop | default; classification, summarization, chit-chat, anything over local data |
| **mid** | Haiku, Sonnet, gpt-5-mini | low | fast | leaves laptop | when local hesitates or fails; tool use that's beyond local; non-trivial reasoning |
| **frontier** | Opus, GPT-5, top Gemini | high | medium | leaves laptop | rare — gnarly reasoning, multi-step planning, code generation that has to be right |

**Routing strategies (we'll layer these incrementally):**

1. **Static rules.** "Anything mentioning {sensitive topics} → local. Anything containing 'plan', 'strategize', or 'review code' → frontier." Cheap to implement, hard to get right.
2. **Confidence-based escalation.** Run local first. If response confidence is low (model says "I'm not sure", schema validation fails, or a self-evaluator scores it weakly), retry on mid or frontier. The "let me think harder" pattern.
3. **Classifier-first.** A tiny model (the local one, or a 1B classifier) picks the tier from the request before any answer is generated. Fast routing, requires good labels.
4. **Explicit user override.** `/think` or `/expensive` slash commands force a tier. Sometimes the user just knows.
5. **Budget-bounded.** Daily/monthly $ cap; once exceeded, all routing collapses to local. Keeps a runaway loop from running up a bill.

We'll start with explicit override + static rules (v7), and add confidence-based escalation once we've shipped enough versions to have signal worth measuring.

**The privacy boundary** is non-negotiable: certain content classes never leave the laptop, regardless of routing pressure. Examples: anything in `~/notes/private/`, anything matching configured regex (SSN, account numbers, etc.), anything explicitly tagged `:private`. The router enforces this *before* tier selection.

**Observability:** every routed request logs `{tier, latency_ms, cost_usd, fallback_chain}` to a local file. Without this, you can't tell whether the router is making good decisions; with it, you can answer "what fraction of my requests went to frontier last month, and was the answer worth the price?"

### 3.5 Local resource awareness

A cloud LLM owns its slice of GPU and RAM. A local SLM on an 8GB M1 Air shares everything with the rest of the user's machine — browser, IDE, video calls, builds, language servers. The available resource envelope at any moment is *sporadic*, not stable. The brain has to plan for that.

**Failure modes measured (perf_kv + perf_gen evals, 2026-04-29):**

- The MLX inference worker crashes mid-stream under memory pressure (exit code null, no graceful error). After the crash, the model auto-reloads at a smaller context, and downstream requests fail with "input greater than context length" — a single OOM event cascades into a degraded-state bug.
- Generation throughput decays as the KV cache fills: ~21 → ~16 tok/s across one 3.8K-token completion at 4K context. Long replies cost more user time per token than short ones.
- Inference contends with the user's interactive work. A 30s prompt-eval pegs the CPU and the user's IDE feels it.

**Strategies (layer in as we hit pain):**

1. **Pre-flight resource check.** Sample free RAM / CPU before each request. Below threshold: refuse with a clear message, defer, or trim context preemptively. Cheap safety rail; addresses the OOM crash directly.
2. **Adaptive context budget.** `budget = f(free memory, conversation length, user signal)`, not a static knob. Cap dynamically; let the high watermark stay generous.
3. **Single-track queueing.** Local inference is effectively single-threaded. Never two outstanding local requests at once. Background jobs (indexing, grooming) explicitly wait behind foreground work.
4. **Backoff + re-route on crash.** Detect worker crashes, wait for reload, retry once. If it crashes again on the same prompt, escalate to mid/frontier — the local system literally cannot host it right now.
5. **Pressure-driven routing.** Today's routing asks "is this hard enough to escalate?" Pressure-driven routing asks "even if local *could* answer, is now the right time?" Memory pressure becomes a routing input alongside difficulty.
6. **Background tasks yield.** v9's scheduled / cron / proactive work MUST yield to foreground use — run at idle, throttle on user activity, pause during memory pressure. The line between "the assistant runs in the background" and "the assistant makes my laptop unusable" is exactly this discipline.
7. **Model lifecycle.** After N minutes idle, unload the model to free ~2.4GB for the user's other work. Reload on next request (cost: ~3s once). The brain owns this decision.
8. **User-signaled priority.** "Urgent" vs "whenever" is an explicit override that lets pressure-driven scheduling do the right thing without the user having to decode indicator lights.

**Observability:** every request logs resource state at issue time — free memory, CPU%, queue depth, currently-loaded model. Without this we can't tell whether the brain made good calls under load; with it we can ask "what fraction of crashes correlated with high pressure?" and "did pressure-routing escalate work it didn't need to?"

The mental shift: cloud routing asks "where should this run?" once. Local routing asks "where should this run *and is now the right time?*" — every request.

### 3.6 Background runtime

Today the brain is a foreground REPL — start it, talk to it, quit. Tomorrow it has to run as a long-lived daemon that wakes periodically, checks for work, and reaches out to the user when something deserves their attention.

Two pieces, architecturally linked.

**The daemon loop.** A long-running process that:

- wakes on a schedule (cron-style time-of-day, or fixed interval) to evaluate pending work
- pulls from a task queue: scheduled reminders, deferred questions, retries from prior failures, proactive grooming passes (see §7 #15)
- yields aggressively to foreground use — see §3.5 strategy #6
- survives system sleep / wake; restarts cleanly on boot; never silently loses queued work

The cadence isn't single-mode. Some tasks fire on cron (daily summary at 8am); others poll (calendar event in 10 min, file appeared in `~/inbox/`); others react (notification dispatched, user replied). The daemon orchestrates; the model only runs when there's actually something to do.

**System notifications.** A daemon that can't surface anything runs in a forest with no one to hear it. The brain needs at least one *outbound* channel that doesn't require the user to be staring at a terminal:

- **Baseline:** macOS native notifications (osascript or equivalent) — low-friction "I noticed X."
- **Escalation:** a higher-priority tier (sound + persistent banner) for items the user explicitly flagged important.
- **Cross-channel** (v10+): iMessage, Slack, etc. Same primitive, different transport. The notification helper is the substrate; channel adapters layer on top.

Notifications respect system focus state — macOS Do Not Disturb / Focus modes are a hard signal. Non-urgent items defer until the user is reachable.

**Coordination boundaries:**

- **Daemon vs REPL.** If the user is actively in a foreground REPL session, the daemon must NOT run inference simultaneously (single-track queue, see §3.5 #3). Coordination via a shared lock file or simple IPC.
- **Restart safety.** If the daemon dies mid-task, the next wake detects and resumes / retries — work is persisted before execution, not after.
- **Dry runs.** A "show me what you'd do" mode for new scheduled tasks before they fire for real. Background work the user can't audit is background work the user won't trust.

What lands first (when v9 ships): a notification helper + a daemon mode that wakes every N minutes to check a markdown task list. The task list itself is `~/.assistant/tasks/*.md` — same principle as memory in §3 (greppable, version-controllable, AI-readable).

### 3.7 System bridge (Apple Shortcuts)

The runtime needs a way to *act* on the user's machine — create reminders, fire timers, append to Notes, post to apps the assistant has no business writing custom adapters for. Apple Shortcuts is the existing surface: every macOS user already has a library of named, parameterised actions, and there's a `/usr/bin/shortcuts` CLI that runs them by name.

**Architectural shape.** Two tools, not N. Exposing each shortcut as its own model-visible tool blows past the §5 tool-selection cliff almost immediately — a typical library is dozens of entries. Instead we mirror the `list_notes` / `read_note` pattern that's already proven at v4:

- `list_shortcuts()` → newline-delimited names, for the model to discover what's available.
- `run_shortcut(name, input?)` → runs `shortcuts run "<name>"`, pipes `input` via `-i <tmpfile>`, captures stdout. Output goes back as the tool result.

That's a fixed +2 surface regardless of how big the user's library is.

**Chaining.** No new mechanism needed. The agent loop in `assistant.ts` already iterates tool calls until the model emits a terminal text reply (verified at v4 with `list_notes → read_note`). "Make a note then set a timer" becomes two `run_shortcut` invocations across two iterations of the existing loop. The only adjustment: `DEFAULT_MAX_STEPS` bumps from 5 to 8 so longer chains don't trip the loop guard.

**Graceful failure.** Reuse the v3.5 validate-and-retry primitive — `executeToolCall` returns errors that list available alternatives so the model self-corrects on the next loop iteration. Apply the same to shortcuts:

- *Unknown name* → return `Error: shortcut '<X>' not found. Closest matches: …. Available: …`. The model retries with the corrected name on its next turn.
- *Shortcut errors out* → return stderr verbatim prefixed with `Error:`. Model decides whether to tell the user, retry, or fall back.
- *Hangs* → `AbortController` timeout (default 30s) → timeout-shaped error.
- *First-run permission dialog* → macOS prompts the first time `shortcuts run` invokes a given shortcut. We catch the resulting failure and surface a one-line "approve in the dialog and re-ask" message, since the dialog is async to our process.

**Listing in the UI.** `GET /v1/shortcuts` returns `{ shortcuts: [{name}], cachedAt }`. In-process cache (~30s TTL) so the Mac dock pane can repaint cheaply without re-spawning the CLI per render.

**Trust posture (v6.5 ships with).** Trust the user's library wholesale. Shortcuts can do anything — send messages, hit APIs, delete files — but the user wrote them, and every invocation is already visible in the chat UI via the existing tool-event SSE stream. Revisit if the model misfires; an opt-in allowlist (`~/.assistant/shortcuts-allowed.json`) is the obvious next step but adds friction we don't yet need.

**Tool-count tradeoff.** v4 shipped at 8 tools with a clean 30/30. v6.5 takes us to 10 — right at the §5 "8+" cliff. We accept that and watch the v4 regression suite for tool-selection drift. If it shows up, the weakest carrier in the existing set (`search_notes_by_filename` — semantically overlapping with `search_corpus`) is the natural drop candidate.

## 4. The Trajectory

Each version introduces exactly one new mental model. We do not advance until the previous one is felt.

| v | Status | Concept | What we add | What we learn |
|---|---|---|---|---|
| **v0** | ✅ shipped | Bare chat loop | Basic loop, token telemetry | Models are stateless; we ship the entire conversation each turn |
| **v1** | ✅ shipped | Context management | Token budget, sliding window, summarization | Context is a resource, not a free buffet |
| **v2** | ✅ shipped | Persistence | Save/load conversations to disk | Session memory vs long-term memory; restart safety |
| **v3** | ✅ shipped | One tool (two, actually) | Tool schema, model decision, execution, result injection, validate-and-retry | The mechanics of an agent loop; the cost of dated models |
| **v4** | ✅ shipped | Multi-tool routing | 3–5 tools, tool selection, error handling | The capacity ceiling — how many tools before quality collapses |
| **v5** | ✅ shipped | Profile (current truth) | Mutable key→value facts loaded into every system prompt; remember/forget tools | Separate facts from episodes; supersession at write-time, not retrieval-time |
| **v6** | ✅ shipped (23/30 on practical eval — see §5 + §8 for the 1-point gap discussion) | Local RAG (episodic) | Embeddings, vector store, retrieval over notes + past sessions; per-chunk metadata layer (`source_mtime`, `content_date`, `intent`) for filtered retrieval | Retrieval-augmented generation; "knowing about X" vs "remembering X"; the cliff between retrieval-found and retrieval-skipped |
| **v6.5** | future | System bridge (Apple Shortcuts) | `list_shortcuts` + `run_shortcut(name, input?)` over the macOS `shortcuts` CLI; fuzzy-match on unknown names; `GET /v1/shortcuts` for the Mac app | The runtime can reach *out* of the laptop via the user's existing Shortcuts library, without a tool-per-shortcut blowup |
| **v7** | future | Web search | External tool, fetch + parse + summarize | Live data, source citation, latency |
| **v8** | future | Model routing | Add a second tier (mid or frontier), `ModelClient` abstraction, routing policy, cost/latency logs | When to escalate, what the privacy boundary buys, the cost/quality/latency triangle |
| **v9** | future | Scheduling / background | Cron-style triggers, notifications, persistent agent loop | The assistant runs even when I'm not looking |
| **v10+** | future | Channels | Adapters for iMessage, Slack, etc. | The OpenClaw shape |

**Running what's shipped:**

```bash
bun run src/index.ts                     # new session
bun run src/index.ts --resume            # load the most recent session
bun run src/index.ts --load <id-prefix>  # load a specific session

# slash commands inside the REPL:
/quit /clear /new /history /tokens /context /budget [n]
/sessions /load <id> /resume /tools

# evals (organised by capability, not version):
bun run eval/run.ts                    # all suites — exits 0 if every gated check passes
bun run eval/run.ts substrate          # one suite by name (prefix match)
bun run eval/run.ts --offline          # skip anything that hits the model

# suites: substrate, context, persistence, profile, tool_loop, rag, shortcuts
# perf benchmarks (not pass/fail): bun run eval/perf/perf_gen.ts etc.
```

Notes folder: `~/.assistant/notes/*.md` — drop markdown files there and the assistant can `read_note` them. Sessions live at `~/.assistant/sessions/`.

**Note on the `ModelClient` abstraction:** even though "real" routing lands at v7, the interface should appear earlier — probably v3, when we first introduce structured tool calls. The brain calls `client.chat.completions.create(...)` against a typed wrapper, not directly against the OpenAI SDK. That way v7 is "add a second `ModelClient` and a router that picks one," not a refactor.

We may pause at any version. Some versions may take an afternoon, others a week. The trajectory is the spine; the meat is what we learn at each step.

## 5. Where SLMs break (the honest map)

What a 3B-class instruct model genuinely struggles with — to be confirmed empirically as we go:

| Failure mode | Symptom | Mitigation |
|---|---|---|
| **Multi-step reasoning** | Hallucinates intermediate steps in 4+ hop chains | Decompose; one tool call per step; show work |
| **Tool selection from large sets** | Picks wrong tool when 8+ are offered | Limit to 3–5 tools; route via classifier first |
| **JSON schema adherence under pressure** | Drops fields, malforms types, hallucinates extra keys | Use grammar-constrained sampling if available; validate + re-prompt on parse failure |
| **Long-context coherence** | Forgets/confuses turn 1 by turn 20 | Active context management (v1); summarize older turns |
| **Negation & quantifiers** | "All X except Y" → handles X, ignores Y | Phrase prompts in positive form |
| **Following a tool result** | Ignores tool output, repeats the original answer | Explicit "based on the tool result above…" framing |
| **Refusal vs. attempt** | Tries to answer when it should say "I don't know" | Add explicit "if unsure, say so" to system prompt |
| **Confabulation under context loss** | When a fact has been evicted from the sliding window, model invents a plausible-sounding wrong answer rather than admitting it doesn't know (observed v1 eval, Qwen 2.5-3B: invented "Omniscientophilia" when "petrichor" had aged out) | **Mitigation verified at 3B scale (v1 post-fix):** explicit "if you don't know, say so plainly" in system prompt flipped reply to a graceful "I don't know what your favorite obscure word is because I wasn't previously told." Pin salient facts and summarize-on-eviction are still on the roadmap. |
| ~~**System-prompt sensitivity** (Qwen 2.5)~~ | Qwen 2.5-3B's tool calling collapsed when *any* additional system-prompt clause was added (even "Say if unsure"). Verbose anti-confab prompt + tools were mutually exclusive. | **Resolved at v3 by upgrading to Qwen 3-4B-Instruct-2507.** Newer model handles verbose system prompt + tools cleanly. The "tradeoff" was a model staleness artifact, not a fundamental SLM property. |
| ~~**Discrimination (over-calling)**~~ | Qwen 2.5-3B reflexively called `get_current_time` for unrelated prompts ("What's 2+2?", "Make up a haiku") — 1/5 correct skip rate. | **Resolved at v3 by Qwen 3-4B.** Discrimination went 1/5 → 5/5. Confirmed at v4 with 5 tools active: still 5/5 — over-call bias did not return when the toolset grew. |
| **Hallucinated tool names** | Qwen 2.5 occasionally emitted tool calls with names that don't exist (e.g., `function`, `suggest_farmers_market_activity`). Hermes-3-3B leaked its native tool format (`[TOOL_RESULT...`) into user-visible text. | **Mitigated by validate-and-retry** (v3.5): unknown tool names produce a tool-result error that lists actual available tools, giving the model a chance to retry on the next loop iteration. Largely a non-issue on Qwen 3-4B regardless. |
| **Code generation > 30 lines** | Drift, syntax errors, broken imports | Don't use it for this. Tool-call to a coder model if needed. |
| **Implicit change detection** | "I don't like eggs anymore" / "I changed my mind about X" — model often replies conversationally without calling `remember(...)` to update the profile. (v5 supersession: 1/3 with terse prompt, 2/3 with example-driven prompt.) | Use explicit-replacement phrasing in prompts when *correctness* matters: "My X is now Y, not Z" lands reliably. For UX, document this so users learn to phrase updates explicitly (see README). |
| **RAG retrieval quality** (v6 eval, 2026-04-29) | Two distinct failure modes surfaced at 23/30 (one short of pass): (a) **Retrieval skipped** — model treats encyclopedic-sounding queries ("what is petrichor?", "where do wood ducks nest?", "Cairns climate?", "what's at Tulamben?") as general knowledge and answers without calling `search_corpus`. 5/30 misses, all this shape. (b) **Wrong chunks ranked first** — `search_corpus` *was* called, but the genuinely-relevant chunk wasn't in the top-K. Both 2/30 misses were one source dominating top-3 (Sourced Grocer session chunk outranked by topical Brisbane food + coffee notes for "breakfast in Brisbane" / "coffee for breakfast in Brisbane"). | (a) Stronger system-prompt phrasing or a cheap query-classifier (deferred — model-discrimination problem, not a system bug). (b) Three known fixes, each with real trade-offs: **K=3 → K=5** (cheap; ~700 extra tokens of retrieved context per query; probably solves the specific failures); **source-diversity in top-K** (cheap, but trades wrong-source-dominated misses for diversity-prevented misses on single-source queries like "what's my V60 recipe?"); **top-20 → keyword/BM25 re-rank** (more controllable, more code). Deferred at v6 ship — see §8 entry for rationale. |
| **Profile-vs-recent-chat contradiction resolution** | When chat history says "I love eggs" and profile says "dislike", the model often sides with the recent chat. The "right" answer is genuinely ambiguous — real fix is "ask the user", which the model won't do reliably. | Track but don't gate (v5 override category). Document workaround in README ("if you mean a profile fact to be authoritative, restate it"). Real fix when v8 introduces a tier that *does* handle ambiguity well. |

### 5.1 Qwen3-4B empirical cliffs (v6.5 eval, 2026-05-01)

Five iterations of the v6.5 shortcut eval surfaced a cluster of 4B-specific failure modes. **Mitigation policy: solve in runtime / UI / data, not in the system prompt** (one iteration cycle grew BASE_SYSTEM 109% via library-specific examples; reverted — see §8). The model's job is high-level routing; the runtime catches the small set of failure shapes; the UI gives the user agency.

| Failure mode | Where it shows up | Runtime / UI mitigation (NOT prompt) |
|---|---|---|
| **Tool-leak as text** | Model reads a profile or shortcut value and emits it verbatim in the reply instead of using it as a tool argument. Saw "reply='Create Note with Date'" with `tools=0`. | Runtime regex-scans replies for known shortcut names. If found and no tool was called, surface a one-tap "Run X?" affordance in the chat UI. The bug becomes a feature. |
| **Verb cross-pollination** | "Save a reminder", "save a note" — the verb collides with the memory tool's "save a fact" framing. Model picks `remember` instead of `run_shortcut`. | When `remember()` is called with a value that *also* matches a shortcut name, runtime intercepts: inline disambiguation prompt in the UI ("did you mean to set a reminder, or save a fact?"). |
| **Ask-vs-act indeterminism** | Same prompt, different runs: sometimes asks, sometimes acts silently. The model's "ambiguous enough to ask" threshold is unstable. | Embrace it. When the model acts without asking, surface "✓ used Apple Notes — change default?" pill below the action. One tap saves a preference. |
| **Three-step flow fragility** | Cold-start disambig (ask → save preference → act) requires meta-cognition alongside action. Model skipped the save step in 2/3 cold-start tests before an explicit example was added. | Move save-preference from model to runtime: when the user resolves an ambiguous request, the runtime inspects the resulting `run_shortcut(name, ...)` and writes the preference programmatically. The model never has to remember to remember. |
| **Content-shape lapses** | Model passes the topic literal as `input` instead of generating items ("packing checklist for a weekend trip" → input was that exact string). Discipline failure, not discrimination. | UI affordance: when `input` is suspiciously short relative to the request shape ("checklist", "list of N", etc.), show a "Regenerate with full content" button. |
| **Refusal hallucination** | "X is not available" / "I cannot do Y" — even when X/Y is in the visible shortcut list. Pattern-completion overrides the prompt. | Runtime detects "not available" / "I cannot" patterns when matching shortcuts exist and surfaces a one-tap retry to the user. Single retry attempt, then surface to user. |

**The wins were architectural, not prompt-engineered.** Inlining shortcut names in the prompt fixed catastrophic guessing. Prompt cache hitting cut prefill 8500ms → 700ms. Profile injection for stable preferences carried steady-state requests. The 109% prompt growth was patches around specific failure shapes that didn't generalize and made the prompt brittle to the user's specific shortcut library.

We will keep this section updated as we hit specific cliffs.

## 6. Evaluation: how we know it's working

This is the most interesting open question. We have two evaluators available:

- **Me (William)** — final arbiter of "is this useful?"
- **Frontier model (Claude)** — automated grader, test-case generator, capability ceiling probe

The plan is to make Claude an active part of the evaluation loop, not just a chat partner. Concrete patterns:

### 6.1 Per-version success criteria

Each version ships with a defined "done" — concrete, measurable, automatable.

| v | Pass condition |
|---|---|
| v0 | Loop runs, token counter visible, /clear and /history work |
| v1 | Conversation can run 50 turns without exceeding configured token budget; salient earlier facts still recalled |
| v2 | Kill brain mid-conversation, restart, prior context reloaded correctly |
| v3 | Single-tool test set: 20 prompts, ≥ 16 produce a valid tool call with correct args |
| v4 | Multi-tool test set: 30 prompts across 4 tools, ≥ 22 pick the right tool with valid args |
| v5 | Profile: write 5/5, recall 5/5, supersession ≥2/3. Override (profile vs. recent-chat contradiction) tracked but ungated — inherently ambiguous. |
| v6 | RAG test set: 30 questions over a known corpus, ≥ 24 retrieve a relevant passage AND incorporate it into the answer |
| v6.5 | Shortcuts test set: 15 prompts (single run, two-step chain, unknown-name graceful, three-step chain). ≥ 12 produce the right `run_shortcut` call(s) with reasonable args; 100% of unknown-name cases return a fuzzy-match suggestion rather than a generic failure; v4 regression suite still ≥ 28/30 (no tool-selection drift). |
| v7 | Web-search test set: 20 current-events questions, ≥ 14 produce a sourced, accurate answer |
| v8 | Routing test set: 40 prompts hand-labeled with the correct tier; router picks correctly ≥ 32. Privacy regex is respected on 100% of synthetic sensitive prompts (zero leaks). Cost log is accurate to within 5%. |
| v9 | Scheduled task fires on time, completes, and notifies; no zombie processes after restart |

### 6.2 Frontier-as-judge

For open-ended responses, the small model's output is graded by Claude on a rubric. Pattern:

```
test_prompt → small model → response
                                ↓
              [response, reference, prompt] → Claude grader → {score, rationale}
```

Rubric per task type:
- **Tool calls:** valid? (yes/no), correct tool? (yes/no), args reasonable? (1–5)
- **Summaries:** factual? (1–5), comprehensive? (1–5), concise? (1–5)
- **Q&A:** correct? (yes/no/partial), well-structured? (1–5), hallucinations? (count)

This is a known pattern (LLM-as-judge from research literature). It's imperfect — the judge has biases — but it's much faster than human grading and consistent enough for tracking deltas across versions.

### 6.3 Capability gradient tests

For each new capability, define an easy / medium / hard tier and find the cliff.

Example for v3 (single tool, "read_note"):
- **Easy:** "Read my note about Brisbane." (one obvious match)
- **Medium:** "What did I write about Brisbane last week?" (date filter + topic)
- **Hard:** "Summarize what I've written about Brisbane vs Cairns." (multi-fetch + synthesis)

Where does Qwen-3B's score curve break? That's the architectural cliff for the version.

### 6.4 Frontier baseline ("Opus comparison")

A small set of *real* tasks I'd normally do with Opus, run through both. Score the gap.

The interesting result isn't "is local as good as Opus?" (no, it isn't) — it's **"for which of my Opus tasks is the gap small enough that local wins on cost/privacy/latency?"** That's actionable: it surfaces tasks I should *stop* paying Opus for.

This eval directly informs the router's static rules at v7. Tasks where local scores within ~1 point of Opus on a 10-point rubric become rules: "this category routes local." Tasks where the gap is ≥ 3 points become "always escalate."

### 6.5 Routing correctness (v7+)

Once routing exists, the eval expands. Per request, log:

- **Tier chosen** by the router
- **Tier that *should* have answered** (oracle label, generated by Claude with full context)
- **Quality of the actual answer** (graded by Claude)
- **Quality if a higher tier had answered** (run the same prompt against the next tier; compare)

Two separate things to track:

| Metric | What it measures | Failure mode |
|---|---|---|
| **Routing accuracy** | router picks tier == oracle tier | over- or under-routing |
| **Cost of being wrong** | quality delta when router under-routes vs over-routes | under-routing wastes the user's time; over-routing wastes money |

The asymmetry matters. Under-routing (sending a hard task to local) produces a bad answer the user notices. Over-routing (sending an easy task to frontier) produces a fine answer at extra cost the user doesn't notice. Both are wrong, but they fail differently — eval should weight them differently.

### 6.6 Regression suite

Each new version runs the previous version's test suite. Capabilities should not regress. If they do (because we tweaked the system prompt, changed the context strategy, etc.), we surface it before merging.

### 6.7 Cost / latency / quality dashboard

Per task type, track:

| Task | Local model | Local tok/s | Frontier model | Frontier $/run | Quality (local) | Quality (frontier) | Verdict |
|---|---|---|---|---|---|---|---|
| Daily journal summary | Qwen-3B | 20 | Opus | $0.04 | 7/10 | 9/10 | local |
| Code review | Qwen-3B | 20 | Opus | $0.30 | 3/10 | 9/10 | frontier |
| ... | | | | | | | |

Living document. Drives architectural decisions like "should this task tier go to a paid model?"

## 7. Open questions

Things we don't know yet, and intend to learn:

1. What's the practical context limit for Qwen-3B before quality drops? (KV cache says ~8K is feasible RAM-wise, but does the model coherently use 8K?)
2. ~~How many tools can Qwen-3B handle before tool selection collapses?~~ **Partially answered (v4 eval, Qwen 3-4B):** at 5 tools the model is *not* near the cliff — 30/30 on a curated test set spanning all five, plus a clean 2-step composition (`list_notes` → `read_note`). Hypothesis "4–5" was too pessimistic for this generation of model. Open question becomes: where *is* the cliff? 8 tools? 12? Worth probing at v5+ as the toolset grows.
3. Does CoT prompting ("think step by step") help or hurt at this scale?
4. Is `Phi-3.5-mini` better than Qwen for reasoning-heavy tasks at the same RAM cost?
5. Is `DeepSeek-R1-Distill-Qwen-1.5B` worth a slot for explicit reasoning tasks even though it's not generalist?
6. At what point does adding more tools require a routing classifier (a small model deciding which tool *family* before the big model picks the specific one)?
7. How much does fine-tuning a 3B on William's writing improve "knows me" responses vs RAG over the same corpus?
8. When the assistant runs as a daemon (v8), what's the right interface for "interrupt me" vs "wait until I'm at my desk"?
9. **Routing:** is rule-based routing enough, or do we need a classifier? Hypothesis: rules cover ~70% of cases cleanly; the rest need either explicit user override or confidence-based escalation.
10. **Routing:** does the local model's own self-assessment ("I'm not sure about this") correlate with actual answer quality, or is it noise? If correlation is real, we can use it to drive escalation cheaply.
11. **Routing:** when a request escalates from local to frontier, does the frontier need the original conversation history, or is the latest message + a summary enough? (Cost vs quality tradeoff.)
12. **Privacy:** what's the right user-facing affordance for "this stays local"? A `:private` tag in notes? A folder? A regex? All three?
13. ~~**Confabulation:** does adding "if you're not certain, say 'I don't remember'" to the system prompt actually reduce hallucinated recall?~~ **Answered (v1 eval):** yes, at 3B scale. With the instruction, Qwen-3B admits uncertainty cleanly. Without it, it confabulates. n=1 per arm — would benefit from a sweep, but the binary effect is striking. Open question becomes: how robust is this under prompt-injection or adversarial framing?
14. **Eval design:** v1 surfaced that subtle eval choices (distractor content, question phrasing) materially change conclusions about model capability. We need a discipline around eval prompts: neutral distractors, no answer-shaped escape hatches, control runs on a frontier model to confirm the test is actually solvable.
15. **Proactive memory (deferred from v5):** today the profile only updates when the user explicitly says "remember X" or uses replacement phrasing ("X is now Y"). Casual self-descriptions ("I'm a vegetarian", "my dog is Buddy") aren't reliably auto-saved. Three candidate paths:
    - **Real-time auto-save** — strengthen the system prompt to push the model toward saving stable-sounding facts on its own. Risk: false positives at 4B (in-game pretending, hypotheticals, jokes mistaken for facts).
    - **Offline grooming** — periodically scan past sessions + notes with a frontier (or local) model, extract candidate facts, surface for user approval. Lower per-turn latency; precision improvable; **shares infrastructure with v6 RAG** (same retrieval over the same corpus).
    - **Hybrid** — auto-save with visible surfacing ("(saved: X)") so the user can `/forget` mistakes cheaply. Asymmetric error cost reduced.
    Working hypothesis: offline grooming is the right primary lever — it leverages v6 RAG infrastructure and avoids the per-turn precision tax. Revisit empirically after v6 lands.
16. **Qwen 3 Thinking as a local mid-tier?** Same family, same RAM footprint (~2.4GB at 4-bit), but post-trained to emit `<think>...</think>` reasoning before its answer. Plausibly addresses our known weak spots: v5 supersession 2/3, v5 override 0-1/2, anticipated v6 cross-chunk synthesis, multi-hop tool composition. Costs: 5-10x latency on ambient turns (the model thinks even when nothing needs thinking), bigger maxTokens budgets, a `<think>` strip pass in the client wrapper, and re-validation of every prior eval. Four strategies considered:
    - **A. Switch wholesale.** Probably not — mid-trajectory model swaps lose hard-won baselines.
    - **B. Empirical probe.** ~1 hour: run v3/v4/v5 evals against Qwen3-4B-Thinking-2507 to see if accuracy lifts on supersession and override are worth the latency penalty. Cheap data, no commitment.
    - **C. Use it as the local mid-tier in v8 routing.** A thinking model that never leaves the laptop is actually the most interesting "mid tier" the routing design could hit — keeps the privacy boundary intact while still escalating beyond Instruct on hard prompts. Falls cleanly out of the trajectory.
    - **D. Reserve it for offline grooming.** Background passes over sessions/notes (proactive profile saves, summary generation, fact extraction) are exactly the workload reasoning models earn their keep on. Avoids the per-turn latency tax entirely. Pairs naturally with question #15.
    Working hypothesis: **C + D** is the right shape — Thinking is the on-architecture answer to "how do we escalate beyond Instruct without leaving the laptop?", and grooming is the workload where reasoning pays off without the latency tax. B is the cheap probe that would harden this hypothesis. Revisit when v6 RAG lands and v8 routing becomes the next architectural concern.
17. **Resource thresholds (§3.5):** what free-RAM threshold should trigger refuse / defer / route-away on an 8GB system? Hypothesis: <1GB free is dangerous given Qwen 4B's ~2.4GB footprint and the KV cache spikes we observed, but this needs measurement against actual crash rates.
18. **Pressure-signal accuracy (§3.5):** does macOS `memory_pressure` (or `vm_stat` derivations) correlate with actual inference-worker crash risk, or is the only honest signal "we tried to inference and it crashed, retroactively"? The latter forces strategy #4 (backoff + reroute) to do real work; the former enables proactive prevention.
19. **Daemon-vs-REPL coordination primitive (§3.6):** file lock? Unix socket? A row in a shared SQLite? The simplest thing that survives crashes and doesn't require the user to manually clear stale state wins.
20. **Notification taxonomy (§3.6):** is two tiers enough (informational vs urgent), or do we need finer grain — and how does the user define which is which without becoming an admin? Inversion candidate: classify-on-emit ("this is the first thing that matched the rule, so it's urgent; the next twenty are noise"), not classify-on-rule.
21. **Shortcut metadata layer (v6.5 follow-up):** v6.5 ships the action surface (run_shortcut + name list inlined into the prompt), but the agent-facing contract is genuinely thin — opaque string names, no schema, no intent tag. The eval surfaced that without metadata the model has to disambiguate purely from name string + user phrasing, which is fragile and pushed us toward library-specific prompt examples (rejected — see §8). The architectural answer is `~/.assistant/shortcut-meta.json` keyed on shortcut name, with fields like `intent` (enum: `create_note`, `start_timer`, etc.), `is_default_for` (intent), and possibly `expects_input` (bool). Generation: local LLM classifies new names on first sight (one-shot, ~5 tokens out, runs at most a handful of times across the user's lifetime). User overrides via UI. Refresh cadence: diff-and-fill on every shortcut cache refresh — almost never runs in practice. Open empirical question: how much of the model's failure modes does this actually fix vs how much is intrinsic to 4B routing? Answer when v6.5 ships its non-hardcoded baseline eval.

## 8. Decision log

Architectural choices, with reasons. So future-William remembers why.

| Date | Decision | Reason |
|---|---|---|
| 2026-04-28 | Bun over Node.js | Zero-config TS, all-in-one tooling, fewer deps for an incremental learning project |
| 2026-04-28 | TypeScript over Python for the brain | Brain is an orchestrator (HTTP I/O, no local tensor work). TS ecosystem is right for that. Python kept for `mlx-lm` benchmarks only. |
| 2026-04-28 | OpenAI-compatible HTTP as the model contract | Universal compat. Brain doesn't know if the model is local, hosted, paid, or free. Trivial to swap. |
| 2026-04-28 | Qwen2.5-3B-Instruct as primary brain | Best tool-calling among 3B instruct models; fits 8GB RAM headroom |
| 2026-04-28 | LM Studio as serving layer | Native MLX support; OpenAI-compat server out of the box; GUI for swapping models |
| 2026-04-28 | Markdown as memory format | Greppable, version-controllable, AI-readable. Avoid databases until necessary. |
| 2026-04-28 | `ModelClient` interface, not direct SDK use | Routing requires uniform interface across tiers. Introduce abstraction at v3 so v7 is a drop-in addition rather than a refactor. |
| 2026-04-28 | Tiered routing (local → mid → frontier), local as default | Cost discipline + privacy + latency. Default-local forces every capability to first prove it can't be served cheaply. |
| 2026-04-28 | Privacy boundary enforced *before* routing | Sensitive content can never reach a hosted tier, regardless of routing pressure. The router asks "is this allowed to leave?" before "where should it go?" |
| 2026-04-28 | Default system prompt includes anti-confabulation instruction | v1 eval showed Qwen-3B confabulates by default but admits uncertainty when explicitly told to. Cheap mitigation, large behavioral effect. |
| 2026-04-28 | Probe server's loaded context length at startup; warn if budget exceeds it | v1 surfaced silent prompt truncation (LM Studio at 4096 + budget at 8192 → server chops oldest turns, indistinguishable from a model recall failure). Now we warn at startup and the eval refuses to run if the server can't host the test. |
| 2026-04-28 | Sessions stored in `~/.assistant/sessions/` as append-only JSONL, one file per session | XDG-ish hidden home dir is conventional for personal assistants and survives project moves. JSONL is greppable, streamable, append-friendly, and lossless. One-file-per-session matches "session" semantics and makes `/load` meaningful. |
| 2026-04-28 | Always start a new session by default; `/load` and `/resume` are explicit | Auto-resume surprises users (where did this assistant get my context from?). Explicit is safer; sessions are cheap to create. |
| 2026-04-28 | Restoring a session uses its *stored* system prompt, not the current default | Continuity. If the default prompt changes between sessions, an old conversation should still behave as it originally did. |
| 2026-04-28 | Promoted primary local model from Qwen 2.5-3B to Qwen 3-4B-Instruct-2507 | v3 work surfaced that Qwen 2.5-3B couldn't tolerate verbose system prompt + tools. Investigation across Hermes-3-Llama-3.2-3B-4bit (worse: format leakage, high variance) and a separate Claude's recommendation pointed to model staleness. Qwen 3-4B closes all observed gaps: 14/14 on v3 eval *with* the v1 anti-confab prompt active. |
| 2026-04-28 | `executeToolCall` validates parsed args against the tool's JSON schema before dispatching | Robust against the model emitting malformed args (missing required fields, wrong types, unknown tool names). Failed validation returns a structured error message; the next agent-loop iteration gives the model a chance to self-correct. Cheaper than constrained decoding and a useful primitive regardless of which model we route to. |
| 2026-04-28 | Constrained decoding deferred (not adopted at v3) | Identified by an external consultation as the production-grade primitive for guaranteed schema adherence (GBNF in llama.cpp, Outlines, XGrammar). For our MLX-based stack, support is patchy. With Qwen 3-4B's empirical reliability, the immediate need disappeared. Reconsider when v7 routing introduces a llama.cpp-served tier where GBNF is native. |
| 2026-04-28 | v4 ships with 5 tools, not 4, despite the pass condition naming "4 tools" | The pass condition (≥22/30) was a hedge; the underlying goal is "stress tool selection past the v3 comfort zone." Five tools (`get_current_time`, `read_note`, `list_notes`, `write_note`, `search_notes_by_filename`) give a stronger signal — and three of them (`read_note`, `list_notes`, `search_notes_by_filename`) deliberately overlap semantically, which is the routing failure mode the eval is meant to surface. Result: 30/30 + clean control + clean 2-step composition. |
| 2026-04-28 | Path-safety helper factored out of `read_note` once 3 callers needed it | Three is the threshold for DRY; below that, duplication is cheaper than a helper. With `read_note`, `write_note`, and (implicitly via filesystem ops) the others all needing the same parent-traversal / absolute-path / escape checks, the helper finally pays for itself. |
| 2026-04-28 | v5 = profile (mutable facts), v6 = RAG (was v5) | The "knows me" goal in §1 is closer to "stable preferences across sessions" than "retrieve passages from the corpus". Profile is ~50 lines of code with no infra; RAG would need embeddings + a vector store. Profile-first captures the higher-impact win sooner *and* de-risks RAG (you build retrieval over an episode store you've already accepted is historical, not over a corpus you're trying to extract current-truth from). The supersession problem is solved at write-time (overwrite) instead of retrieval-time (temporal reasoning) — which is the part a 4B model can't reliably do. |
| 2026-04-28 | Profile is a flat key→value JSON file, rendered into the system prompt at the start of each user turn | Three alternatives considered: (a) sectioned markdown — nice for hand-editing, but tools doing markdown surgery is gnarly. (b) free-form text appended to system prompt by the model itself — model is unreliable at maintaining structure. (c) flat KV with normalize-on-write — wins on simplicity. Keys are lowercased + whitespace-collapsed so "Dog Name" and "dog  name" don't double-enter. The system prompt is rebuilt before every chat turn so newly-saved facts surface immediately. |
| 2026-04-28 | v5 system prompt is verbose (memory rules + examples) where v0–v4 prompts were terse | Tested empirically: the terse one-liner ("update facts when they change") missed implicit changes like "I don't like eggs anymore" — supersession was 1/3. Adding example phrases ("'I don't like X anymore', 'I now prefer Y', 'actually, I W'") brought it to 2/3. The general rule "small models cope better with terse prompts" still holds, but instruction-shaped text *with examples* is an exception worth paying for when the failure mode is discrimination, not generation. |
| 2026-04-28 | v5 override category (profile beats recent-chat contradiction) is tracked but ungated | The test setup ("user said in chat history they love eggs, but profile says dislike — what does the model say?") is *inherently* ambiguous: in real use, the right answer is "ask which is current". A 4B model won't do that, and forcing a binary right-or-wrong on an ambiguous case would teach the eval to lie. We log the result for visibility and don't fail the build on it. The honest correctness bar is "model handles the *current-turn* supersession case" (the gated supersession category), not "model resolves history-vs-profile contradictions". |
| 2026-04-29 | Local resource awareness (§3.5) and background runtime (§3.6) elevated to first-class architectural concerns | Empirical: KV-quant test runs (`eval/perf_kv.ts`) crashed the inference worker mid-stream at 6K-token prompts on 8GB M1; throughput decay measured at ~25% across a 3.8K-token completion (`eval/perf_gen.ts`). The brain on local hardware lives inside a sporadic resource envelope — that constraint shapes routing, queueing, scheduling, and lifecycle decisions. Elevating it to its own architectural section now means v8 routing inherits "pressure as a routing input" and v9 daemon work inherits "yield aggressively" rather than bolting both on later. |
| 2026-04-29 | LM Studio KV cache quantization marked unusable on the current build (v0.4.12) | Empirically broken at both 8-bit and 4-bit: `NameError: name 'tree_reduce' is not defined` in the MLX runtime's quant path the moment a prompt crosses the activation threshold; subsequent worker crash. Single working data point (1K prompt) was below the quant threshold and therefore proves nothing. Disable until LM Studio updates; revisit then. Captured here so future-William doesn't repeat the experiment without checking the version. |
| 2026-04-29 | v6 chunks carry per-row `source_mtime`, `content_date`, `intent`; `IndexStore.search` gains `intent` + `sinceMtime` filters | Forward-looking for the §3.6 Pebble pipeline — adding these now (alongside v6 ship) is one schema migration; threading them in later would mean re-indexing every chunk to backfill. Chunker populates `contentDate` for sessions only (where it's derivable from the turn timestamp); indexer denormalizes file mtime onto each chunk. `intent` stays null until the Pebble decompose step exists to produce it. Backwards-compatible ALTER on legacy DBs verified by `eval/index_metadata.ts`. |
| 2026-04-29 | v6 ships at 23/30 on the practical RAG eval (one short of the ≥24/30 pass condition); retrieval-quality fixes deferred | The 1-point gap is two prompts where `search_corpus` ranked the wrong chunk first ("breakfast in Brisbane", "coffee for breakfast in Brisbane" — the Sourced Grocer session chunk was outranked by topical food/coffee notes). Three known fixes (bump K to 5, source-diversity in top-K, top-N re-rank) all have real trade-offs documented in §5. Deferring rather than picking arbitrarily — the right fix depends on usage patterns we don't have yet. Re-evaluate when (a) the corpus grows and the failure profile clarifies, or (b) the §3.6 Pebble pipeline lands and intent-filtered retrieval gives sharper signal about what queries should target what kinds of chunks. The v6 lessons (RAG mechanics, the model-discrimination cliff between "personal" and "general-knowledge" framings) are felt either way. |
| 2026-05-01 | Shortcuts integration shipped as v6.5 (system bridge), not folded into v9 or v7 | Shortcuts is small (~one module + two tools), demonstrates the §5 tool-cliff explicitly (10 tools — first time we cross "8+"), and exercises the v3.5 retry primitive on a non-notes domain. Bundling it into v9's daemon work would conflate "act on the system" with "run on a schedule" — two separate concerns. Folding it into v7 would mix outbound *system* action with outbound *web* action, which have different trust profiles. Standalone v6.5 keeps the trajectory's "one mental model per version" discipline. |
| 2026-05-01 | Shortcuts exposed as two tools (`list_shortcuts`, `run_shortcut`), not one tool per shortcut | A typical macOS Shortcuts library is dozens of entries. One-tool-per-shortcut would land us 30+ tools, well past the §5 selection cliff. The `list_notes` / `read_note` pattern proven at v4 (open-set keyed by name) is the right shape: small fixed surface, runtime discovery via the list call, error-on-miss includes the name set so the model can self-correct. |
| 2026-05-01 | v6.5 ships with whole-library trust (no allowlist) | Shortcuts can do anything destructive the user's library is wired up to do. Two postures considered: (a) trust wholesale, rely on the existing tool-event SSE stream so every invocation is visible in the UI; (b) opt-in allowlist at `~/.assistant/shortcuts-allowed.json`. We pick (a) because the user wrote the shortcuts, the surface is already visible, and the friction of (b) is real — every new shortcut would need adding before the model could touch it. Revisit if the model materially misfires; (b) is a small follow-up, not a redesign. |
| 2026-05-01 | `DEFAULT_MAX_STEPS` raised from 5 to 8 alongside v6.5 | Shortcut chains ("create a note, then set a timer, then add a reminder") realistically need 3–4 tool-call iterations plus the terminal text reply. 5 was tight even for v6's `list_notes → search_corpus → read_note` flows. 8 leaves headroom without making infinite-loop bugs invisible. |
| 2026-05-01 | Dropped note-file CRUD tools (`read_note`, `list_notes`, `write_note`, `search_notes_by_filename`); note actions now route through Shortcuts | The user owns their notes ergonomics in Apple Notes (or whatever the "New Note" shortcut writes to), and that's where their existing reading/editing/search workflow lives. A second markdown-file CRUD surface inside the agent was always a parallel store the user had to remember to use. Cleanest is one write path: Shortcuts. Side effects: tool count drops from 10 → 6 (well below the §5 "8+" cliff — easier tool selection, less to mis-select); `~/.assistant/notes/` becomes import-only for `search_corpus` (RAG) — drop markdown there if you want it indexed; v4 multi-tool eval is now over a different toolset, so not directly comparable for regression checks. **Open seam:** notes the agent creates via the "New Note" shortcut land in Apple Notes' store, while `search_corpus` only sees `~/.assistant/notes/`. The agent can write but won't recall what it wrote — bridge candidates: (a) point the shortcut at a markdown file, (b) Apple Notes → markdown sync, (c) accept that "create a note" and "find a note" speak to different stores and document it. Defer until usage shows which way the user actually flows. |
| 2026-05-01 | v6.5 eval iteration: BASE_SYSTEM grew 109% via library-specific examples (362 → 758 tokens). Reverted; durable rule against this approach. | Five eval iterations chasing failure modes ended up encoding specific user-library values ("Create Note with Date", "Add to Bear Note") and specific user phrasings ("save a note", "remind me to take out the trash") as anti-examples in the prompt. Three problems: brittle (renaming the user's shortcuts breaks the examples), bloats every request (now-stable prefix, but eats budget), doesn't generalize across users. Pivoting to: solve in runtime / UI / data, not in the prompt. The 4B failure-mode catalog (§5.1) lists each mode with its non-prompt mitigation. The system prompt's job is high-level routing; runtime catches the failure shapes; UI gives the user agency. **Captured as a durable feedback memory** so future-Claude doesn't re-run the same hill. |
| 2026-05-01 | Adopt shortcut-meta.json as the typed contract layer over Shortcuts (replaces hardcoded prompt examples) | Shortcuts as a user-facing primitive is right (user-authored, macOS-integrated, zero engineering overhead). The agent-facing contract — opaque name strings — is wrong; without intent metadata the model has to disambiguate from name + user phrasing, which fails at 4B. `~/.assistant/shortcut-meta.json` keyed on shortcut name with fields {intent (enum), is_default_for, classified_by, classified_at}. Local LLM classifies new names on first sight (one-shot, ~5 tokens out). Diff-and-fill runs on every shortcut cache refresh — almost never fires in practice. Defaults are picked programmatically (first-seen of an intent), not asked of the model — sidesteps the three-step ask-save-act flow that broke at 4B (§5.1). The model picks shortcuts by intent matching, not name string matching. New users tag their shortcuts via UI once; reliability follows from the data, not the prompt. |

## 9. Out of scope (for now)

Things we explicitly aren't doing yet, to keep scope honest:

- Voice (input or output)
- Mobile (iOS/Android)
- Multi-user / shared assistants
- Fine-tuning the model
- Self-hosting outside the laptop
- Channel adapters (Slack, iMessage, etc.) — comes at v9+
- Cost optimization / billing — comes alongside routing at v7

These are deferred, not rejected. They land when their prerequisite work is in place.

---

*Last updated: 2026-05-01 (v6.5 iteration: 4B empirical-cliffs catalog, shortcut-meta.json architecture, durable rule against prompt-hardcoding). Update at every architectural decision, every learned constraint, every shipped version.*
