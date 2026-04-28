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
| Primary local model | Qwen2.5-3B-Instruct (4-bit MLX), ~1.8GB |
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

## 4. The Trajectory

Each version introduces exactly one new mental model. We do not advance until the previous one is felt.

| v | Concept | What we add | What we learn |
|---|---|---|---|
| **v0** | Bare chat loop | Basic loop, token telemetry | Models are stateless; we ship the entire conversation each turn |
| **v1** | Context management | Token budget, sliding window, summarization | Context is a resource, not a free buffet |
| **v2** | Persistence | Save/load conversations to disk | Session memory vs long-term memory; restart safety |
| **v3** | One tool | Tool schema, model decision, execution, result injection | The mechanics of an agent loop |
| **v4** | Multi-tool routing | 3–5 tools, tool selection, error handling | The capacity ceiling — how many tools before quality collapses |
| **v5** | Local RAG | Embeddings, vector store, retrieval before generation | Retrieval-augmented generation; "knowing about X" vs "remembering X" |
| **v6** | Web search | External tool, fetch + parse + summarize | Live data, source citation, latency |
| **v7** | Model routing | Add a second tier (mid or frontier), `ModelClient` abstraction, routing policy, cost/latency logs | When to escalate, what the privacy boundary buys, the cost/quality/latency triangle |
| **v8** | Scheduling / background | Cron-style triggers, notifications, persistent agent loop | The assistant runs even when I'm not looking |
| **v9+** | Channels | Adapters for iMessage, Slack, etc. | The OpenClaw shape |

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
| **Confabulation under context loss** | When a fact has been evicted from the sliding window, model invents a plausible-sounding wrong answer rather than admitting it doesn't know (observed v1 eval, Qwen-3B: invented "Omniscientophilia" when the original fact "petrichor" had aged out of context) | Pin salient facts; system prompt must instruct refusal on uncertainty; consider summarizing dropped turns rather than discarding |
| **Code generation > 30 lines** | Drift, syntax errors, broken imports | Don't use it for this. Tool-call to a coder model if needed. |

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
| v5 | RAG test set: 30 questions over a known corpus, ≥ 24 retrieve a relevant passage AND incorporate it into the answer |
| v6 | Web-search test set: 20 current-events questions, ≥ 14 produce a sourced, accurate answer |
| v7 | Routing test set: 40 prompts hand-labeled with the correct tier; router picks correctly ≥ 32. Privacy regex is respected on 100% of synthetic sensitive prompts (zero leaks). Cost log is accurate to within 5%. |
| v8 | Scheduled task fires on time, completes, and notifies; no zombie processes after restart |

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
2. How many tools can Qwen-3B handle before tool selection collapses? (Hypothesis: 4–5)
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
13. **Confabulation:** does adding "if you're not certain, say 'I don't remember'" to the system prompt actually reduce hallucinated recall, or does the 3B model confidently override it? (Empirical question, run the v1 confabulation test with and without the instruction.)
14. **Eval design:** v1 surfaced that subtle eval choices (distractor content, question phrasing) materially change conclusions about model capability. We need a discipline around eval prompts: neutral distractors, no answer-shaped escape hatches, control runs on a frontier model to confirm the test is actually solvable.

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

*Last updated: 2026-04-28. Update at every architectural decision, every learned constraint, every shipped version.*
