# LinkedIn post ideas — local SLM assistant project

Drafts to share progress on building a personal assistant on a small local model (Qwen3-4B-Instruct, M1 Air, 8GB). Each post stands on its own; pick the angles that fit best.

## Viral title candidates

**Strongest overall (capstone-thesis territory):**
- AI didn't replace software engineers. It promoted them.
- The coding part of my job is being commoditized. The engineering part isn't. The difference matters.
- Software engineers haven't been displaced. The job description shifted by one word: *non-deterministic*.
- I built an AI assistant on a 4-year-old laptop with 8GB of RAM. It convinced me my job is more important than ever.
- Stop confusing "the model can code" with "the model can ship a system."
- If you tested a few prompts and shipped to production — I have bad news.
- The decade I spent on distributed systems was the prerequisite for the AI era. Not the casualty.

**For #1 — distributed systems → AI runtime:**
- I spent 10 years designing fault-tolerant distributed systems. Then I tried running an LLM on an 8GB laptop.
- Running a local LLM is a distributed-systems problem in disguise.
- Cloud inference asks "where should this run?" Local inference asks "where AND is now the right time?"
- My MLX worker crashed mid-stream at 6K tokens. Every reflex from a decade of on-call kicked in.

**For #2 — context management throwback:**
- 200K-token context windows are spoiling us. Here's what 4K taught me.
- Programmers used to count bytes. Then we stopped. AI features are dragging that habit back.
- Frontier APIs feel like an infinite memory buffet. I built a system without it, and the discipline is back.
- "Context is a resource, not a free buffet." The most useful sentence I've written this year.

**For #3 — weaving inference in and out of a busy laptop:**
- Local inference is cooperative multitasking, rediscovered.
- The line between "AI runs in the background" and "AI makes my laptop unusable" is one design decision.
- Polite is also correct: how I made an LLM share my laptop without breaking it.
- An AI runtime that doesn't yield is an AI runtime that gets uninstalled.

**For #4 — the honest map of a 4B model:**
- What a 4B model on a 4-year-old MacBook can (and can't) actually do.
- I stopped asking "is local as good as Opus?" Here's the better question.
- 30/30 on tool calling. 23/30 on RAG. The honest map of a small model.
- The interesting question isn't whether local matches the frontier. It's where the gap is small enough to stop paying.

**For #5 — memory as two systems:**
- "Give the AI memory" usually means embeddings. That's the wrong half to build first.
- I built memory into a 4B model. The trick was solving it at write-time, not retrieval-time.
- Profile vs RAG: two systems, two jobs. Why the cheaper one ships first.
- The hardest problem in AI memory disappears if you stop asking the model to solve it.

**For #6 — frontier models as test infrastructure:**
- The most underrated use of a frontier model in 2026 isn't generation. It's grading.
- I'm using Claude as a test harness for a smaller model. It changed how I ship.
- LLM-as-judge isn't a research curiosity. It's how I sleep at night.
- Cheap, capable graders make small models legible. That's the unlock.

**For #7 — eval discipline for non-deterministic systems:**
- TDD doesn't work for AI features. Here's what does.
- My AI eval discipline looks more like SLO monitoring than unit testing. That's the right shape.
- I caught a 20% performance regression in my AI assistant this morning. The trick was running the same eval I ran six weeks ago.
- Performance is part of correctness — especially for AI features.
- "Pass conditions, not assertions." The mental shift that made AI shippable for me.

**For #8 — the capstone thesis:**
- Frontier models hide what LLMs aren't good at. Small models show you the edges.
- I learned more about LLM capabilities by designing for a 4B model than by using GPT-5.
- Resilient AI systems aren't built by people good at prompts. They're built by people good at systems.
- The components got non-deterministic. The architecture got more important, not less.

---


## Summary

- **Distributed systems brain meets AI runtime.** A decade of fault-tolerance reflexes — single-track queueing, pre-flight checks, backoff, pressure-driven routing — turns out to be exactly the right toolkit for running inference on shared local hardware.
- **Context management as a throwback.** Before infinite-context APIs, every byte was scarce. Building a 4K-token sliding-window context manager felt like writing for a 90s machine. Old constraints, fresh again.
- **Weaving inference in and out of a busy laptop.** The model shares RAM and CPU with everything else the user is doing. Cooperative multitasking, idle-time grooming, model lifecycle (unload after N idle, reload on demand) — old OS primitives, new application.
- **The honest map of a 4B model on old hardware.** What's easy (tool calling, classification, summarization), what cliffs (encyclopedic queries skip retrieval, supersession, code past 30 lines), and the framing question that actually matters: which of my frontier-model tasks is local *good enough* for?
- **Memory is two systems, not one.** Profile (current truth, mutable, written into every prompt) plus RAG (episodic, retrieval). Solving supersession at write-time, not retrieval-time, is what makes a small model viable as a memory store.
- **Frontier models as test infrastructure.** LLM-as-judge, capability-gradient generation, oracle labels for routing, eval-prompt review. The frontier model isn't the product — it's the harness that makes the small model legible.
- **Eval discipline for non-deterministic systems.** Pass conditions instead of assertions, mandatory regression suites, performance as part of correctness, decision logs over inline comments. The discipline transfers from reliability engineering; the rituals don't.
- **Small models clarify the edges; the SWE role didn't go away.** Frontier capabilities (huge context, deep thinking, agent loops) hide where LLMs actually cliff. Designing for a 4B local model forces you to see those edges. The thesis: coding is being commoditized, but resilient systems, telemetry, pipelines, regression testing, architecture — those matter more than ever. We're just testing on non-deterministic machines now.

---

## 1. Designing fault-tolerant distributed systems prepared me to build AI runtimes

**Hook:** I spent a decade designing systems for the failure modes of distributed infrastructure. Now I'm running a small language model on an M1 MacBook Air with 8GB of RAM, and every one of those reflexes is paying off.

**Body:**
- Local inference on shared hardware is a sporadic-resource problem. The model competes with the user's browser, IDE, and video calls. RAM headroom isn't a constant — it's a signal.
- I had to rebuild old habits in a new context: single-track queueing (one inference at a time), pre-flight resource checks, backoff-and-reroute on worker crash, pressure-driven routing ("the model *could* answer, but is now the right time?"), graceful degradation when the KV cache fills.
- Concrete finding: my MLX worker crashes mid-stream at ~6K-token prompts on 8GB; throughput decays ~20% as one long completion fills the cache. None of that fails loudly — it fails in the cloud-DS playbook way: silent, cascading, harder to debug after the fact than to design for upfront.

**Closer:** Cloud routing asks "where should this run?" once. Local routing asks "where should this run *and is now the right time?*" — every request. That sentence should feel familiar to anyone who's run a service.

---

## 2. Context management is a throwback to the days before abundant memory

**Hook:** Frontier APIs have spoiled us. 200K-token context windows feel like an infinite buffet, and we write code that assumes we can shovel in whatever we want. Building an assistant on a 4K-token local model dragged me back to a discipline I hadn't needed in 15 years: actually managing memory.

**Body:**
- Context is a resource, not a free buffet. Every turn appends to the conversation, and you ship the *whole thing* every request. Without active management, you blow the budget by turn 20.
- The toolkit looks ancient on purpose: a sliding window, summarization-on-eviction, pinning salient facts that must survive, probing the server's actual capacity at startup so you don't get silently truncated.
- One of my early evals failed because LM Studio loaded the model at 4K context while my budget said 8K. The server quietly chopped the oldest turns. The model "forgot" facts not because it was a bad model, but because the substrate had eaten them. A whole class of bugs that doesn't exist when memory is infinite.

**Closer:** Programmers used to count bytes. Then we stopped, because we could. Now AI features are dragging that habit back into application code, and honestly — it's nice to think this carefully again.

---

## 3. Running an LLM locally means weaving inference in and out of a busy machine

**Hook:** A cloud LLM owns its slice of a GPU. A local model on my laptop shares unified memory with my browser, my IDE, my video calls, and three language servers. The interesting engineering question isn't "can the model run?" — it's "can the model run *and not make my laptop unusable for the actual work?*"

**Body:**
- Single-track queueing: never two outstanding inference requests at once. Background tasks (indexing, grooming) explicitly wait behind foreground work.
- Pre-flight resource checks: sample free RAM before each request. Below threshold, refuse with a clear message, defer, or trim context preemptively. A simple gate that prevents whole classes of silent OOM crashes.
- Model lifecycle: after N idle minutes, unload the model and give the user back ~2.4GB. Reload on next request (cost: ~3 seconds, once). The brain owns this decision, not the user.
- Background work yields aggressively: scheduled tasks (daily summary, proactive grooming) run at idle, throttle on user activity, pause during memory pressure. The line between "the assistant runs in the background" and "the assistant makes my laptop unusable" is exactly this discipline.

**Closer:** Half of this is rediscovering cooperative multitasking. The other half is rediscovering that on shared hardware, the polite thing is also the correct thing. AI runtimes that don't yield well are AI runtimes that get uninstalled.

---

## 4. A 4B model on an old laptop: the honest map of what it can and can't do

**Hook:** I've been running Qwen3-4B-Instruct on a 4-year-old MacBook Air, deliberately forcing myself to design around the constraints instead of waiting for bigger hardware. Here's what I've learned about the edges.

**What comes easy:**
- Tool calling: 30/30 on a 5-tool routing eval, including 2-step composition (`list_notes` → `read_note`). Models in this generation are dramatically better at structured output than they were 12 months ago.
- Summarization, classification, extraction, conversational shells over local data — fast, free per token, fully private.
- Following an explicit "if you don't know, say so" instruction. One sentence in the system prompt flips confabulation off cleanly at this scale.

**Where it cliffs:**
- RAG: 23/30 on a practical eval. Two failure modes: the model treats encyclopedic-sounding queries ("what is petrichor?") as general knowledge and skips retrieval entirely; and when it *does* retrieve, the genuinely-relevant chunk isn't always ranked first.
- Implicit profile updates: "I don't like eggs anymore" lands ~2/3 of the time. Explicit "X is now Y, not Z" lands reliably. Phrasing matters.
- Anything past 4-hop reasoning, code generation past 30 lines, large tool sets (the cliff is somewhere past 5 — I haven't found it yet).

**Closer:** The interesting question isn't "is local as good as Opus?" (no, it isn't). It's "for which of my Opus tasks is the gap small enough that local wins on cost, privacy, and latency?" That list is longer than I expected.

---

## 5. Memory, for a small model, is two systems — not one

**Hook:** When you say "give the assistant memory," people picture embeddings and a vector store. After shipping the memory layer for my local assistant, I'm convinced that's only half the answer — and the wrong half to build first.

**Body:**
- I split it into two systems with different jobs. The **profile** holds *current truth* — flat key→value, mutable, written into every system prompt: "dog: Buddy", "diet: vegetarian". The **episodic store** is RAG over notes and past sessions — for "what did I write about Brisbane last week?"
- The insight that made the design click: supersession (the user changed their mind) is *unsolvable* at retrieval time with a 4B model. Asking it to reason about which fact is more recent across overlapping passages is exactly the kind of multi-hop reasoning small models break on.
- Solving it at write-time is trivial: `remember("diet", "vegetarian")` overwrites the previous value. The model never sees a contradiction. The hard problem becomes a one-line tool call.

**Closer:** I shipped the profile (v5) before the RAG layer (v6) for this reason. Sequencing matters. The cheaper system that solves the harder problem goes first.

---

## 6. Using frontier models as test infrastructure for small models

**Hook:** The most underrated use of a frontier model in 2026 isn't generation. It's grading. I'm using Claude as part of my eval loop for a much smaller local model, and it's changed how I think about testing AI systems.

**Patterns I've actually shipped:**
- **LLM-as-judge.** Small model produces an answer; the frontier model scores it on a rubric (factual? hallucinations? schema-valid?). Imperfect, biased, but consistent enough to track regressions across versions.
- **Capability-gradient generation.** Easy / medium / hard variants for each new capability, written by the frontier model. Find the cliff, name it, design for it.
- **Oracle labels for routing.** Once I add a router (local vs mid vs frontier), the frontier model labels the "correct" tier per request — so I can score the router's accuracy.
- **Eval-prompt review.** Frontier model sanity-checks my own eval prompts for unintended escape hatches. I caught more than one case where the test was easier than I thought.

**Closer:** The mental shift: cheap, capable graders make small models *legible*. You can ship an SLM with confidence not because the model is reliable, but because your harness around it tells you when it isn't.

---

## 7. The eval discipline I built for distributed systems doesn't survive non-determinism — and that's OK

**Hook:** Test-driven development assumes a deterministic system under test. AI features aren't that. After 6 versions of building an assistant on a small local model, the testing discipline I evolved looks more like SLO monitoring than unit testing — and I think that's the right shape.

**What changed:**
- **Pass conditions, not assertions.** Every version of my assistant ships with a numerical pass condition: "≥22/30 on the multi-tool eval", "needle recalled at 4K context". I don't ship until the bar is met. I *do* ship at 23/30 sometimes, with the gap explicitly logged.
- **Regression suites are non-negotiable.** Every new version runs every prior version's eval. Capability regressions (caused by a prompt tweak, a context change, anything) get surfaced before the merge — same way an SLO regression would.
- **Performance is part of correctness.** I just ran my perf eval after suspecting response times had grown — TTFT regressed ~20% at small prompts and ~35% at larger ones, scaling with prompt length. That's a fingerprint of a per-token prefill regression, not a fixed startup cost. Without baseline runs to compare to, I'd never have known.
- **Decision logs > comments.** Every architectural call goes in a dated decision log with the reason. Future-me reads "we deferred constrained decoding because Qwen 3-4B was empirically reliable enough" instead of guessing.

**Closer:** Testing AI features isn't testing software. It's running a small experimental program every day, with the same discipline a reliability engineer brings to a production service. The skills transfer — the rituals do not.

---

## 8. Small models clarified what LLMs are actually good at — and why my job hasn't changed

**Hook:** Frontier models with 200K-token context windows, deep thinking modes, and built-in agent loops make it really easy to forget where LLMs actually have edges. The bigger and more capable the model gets, the harder it is to see what's still hard for it. Designing a system around a 4B local model has been the clearest window I've had into what these models are *actually* good at — and what scale has been quietly papering over.

**What scale hides:**
- Huge context windows turn "what's relevant?" into "just throw it all in." A 4K-token budget puts that discipline back where it belongs.
- Reasoning modes let you skip decomposing problems into steps the model can actually do. A non-thinking 4B model demands you do that decomposition explicitly.
- Built-in agent loops paper over failure modes: "the model will retry until it works." On constrained hardware, retries are expensive and you have to design for the failure modes directly.
- Massive tool sets and large APIs ride on the assumption "the model will pick the right one." At 4B, tool selection collapses past a small number — so you build routing classifiers, discrimination tests, and structured tool schemas. Then you realise the frontier models would benefit from those too.

Once you've seen the shape of where a small model cliffs — retrieval skipped on encyclopedic queries, supersession failing under implicit phrasing, multi-hop chains drifting, tool over-calling — you start to see those same shapes in frontier models. They're the same edges. Just at a different scale, hidden by enough headroom that you don't notice until production.

**The thesis:**
The coding part of software engineering is being commoditized. That's real, and I think it's good. What isn't changing is everything else:
- **Telemetry.** You log what your model decided, why, and how confident it was — the same way you logged what your service did, why, and how long it took.
- **Pipelines.** Data in, transform, validate, output. Same shape as it ever was.
- **Regression suites.** Every version runs every prior version's eval. Same discipline that kept production services from silently degrading across releases.
- **Architecture.** Boundaries, contracts, abstractions — *more* important now, because the components inside the boundaries are non-deterministic.

You don't try a few prompts in a playground and ship to production. You build a system around the model — eval gates, regression tracking, observability, fallbacks, escalation tiers, privacy boundaries, resource pressure handling — and you ship the system. The model is one component. The engineering is the discipline around it.

**Closer:** Software engineers haven't been displaced. The job description has shifted by exactly one word: we now build resilient, observable, well-tested systems on top of *non-deterministic* machines. The decade we spent learning how to do that for distributed systems wasn't wasted. It was the prerequisite.
