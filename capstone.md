# Capstone — The intelligence layer Siri has been missing

A local-first personal assistant that ships as a first-class macOS app. Runs entirely on-device on Apple Silicon, down to an M1 MacBook Air with 8GB. Uses Apple Shortcuts as its action surface — the same primitives Siri exposes, but driven by a small language model that can actually plan, remember, and chain.

The brain we've been building in this repo (see `design.md`) is the substrate. This document is the product that wraps it.

> If it runs on a 2020 MacBook Air, it runs on every M-series Mac shipped since.

---

## 1. Why this exists — the pain we're answering

Siri has been the default voice/text assistant on Mac and iOS for fifteen years. Every engineer in our network has the same complaints. We don't need to invent the gap; the gap is well-documented and currently unfilled. Each of the items below is a real, sourced user pain point that maps to a feature in this spec.

### Siri

| Pain point | What it actually means | Source |
|---|---|---|
| **No real multi-turn context.** "Set a 5-min timer and add milk to my list" fails — it can't compose two intents in one turn. Multi-request handling was punted to a future iOS. | Stateless invocation; each request is fresh. | [MacRumors](https://www.macrumors.com/2026/03/31/siri-ios-27-multiple-requests/) |
| **"I found this on the web" fallback.** For substantive factual queries — current exchange rates, today's tide, an election result — Siri dumps a Safari list instead of answering. | Siri is a router to first-party domains plus Safari. It does not synthesize. | [Apple Discussions](https://discussions.apple.com/thread/253237982) · [Medium](https://medium.com/@meglio/simple-questions-siri-still-cant-answer-9e5574e48f8) |
| **Brittle, literal language understanding.** "Set a timer for four minutes" works; "set a timer for 4am" silently becomes an alarm. Phrase-order brittleness, not intent understanding. | No semantic reasoning over the request. | [TidBITS](https://tidbits.com/2023/06/13/beware-of-siri-creating-alarms-instead-of-timers/) |
| **Wrong-contact calls.** Siri transcribes the contact name correctly on screen but dials a different person. Doesn't learn from corrections. | No memory, no preference signal back into the model. | [Apple Discussions](https://discussions.apple.com/thread/255608878) |
| **No persistent memory of preferences.** Same misrecognitions, same wrong song, same disliked artist — repeated indefinitely across years of use. | No profile, no episodic memory. | [Apple Discussions](https://discussions.apple.com/thread/255608878) |
| **SiriKit domain wall — third-party apps locked out.** Apps can only invoke Siri via Apple's predefined intent domains. Most workflows have no domain available, so most apps don't integrate. | Closed extensibility model. | [Fast Company](https://www.fastcompany.com/40580297/why-dont-more-apps-work-with-siri) |
| **iOS 15 actually *removed* third-party domains.** Ride-booking, to-do app integrations cut. Capabilities went backward. | The platform is not trending toward openness. | [MacRumors](https://www.macrumors.com/2021/07/28/ios-15-limiting-siri-for-third-party-apps/) |
| **Privacy boundary unclear.** Black Hat 2025 research showed messages dictated via Siri to E2EE apps like WhatsApp transit Apple servers — undermining the encryption guarantee. The user has no way to predict which privacy regime applies. | Hybrid local/cloud routing without user-visible signals. | [CyberScoop](https://cyberscoop.com/apple-intelligence-privacy-siri-whatsapp-lumia-security-black-hat-2025/) |
| **$95M settlement over inadvertent recording.** Class action over Siri capturing conversations without "Hey Siri" trigger. Durable trust deficit. | Trust, once lost, doesn't come back from a marketing page. | [HewardMills](https://www.hewardmills.com/a-dpos-perspective-apple-siri-privacy-lawsuit-and-lessons-learnt/) |
| **False activation.** "Hey Sarah," "hey seriously," ambient noise, sweat on AirPods sensors — disruptive in meetings and public. | Wake-word matching tuned for recall over precision. | [PhoneArena](https://www.phonearena.com/news/hey-seriously-and-other-phrases-that-may-trigger-siri-by-accident_id139337) |

### Apple Intelligence

| Pain point | What it actually means | Source |
|---|---|---|
| **"More Personalized Siri" delayed to spring 2026.** On-screen awareness, personal context, deeper in-app actions — promised at WWDC 2024, missed iOS 18 entirely. Apple admitted features "did not converge in quality." Class actions filed. | The thing this spec is about — and Apple won't ship it. | [Daring Fireball](https://daringfireball.net/2025/03/apple_is_delaying_the_more_personalized_siri_apple_intelligence_features) · [CNBC](https://www.cnbc.com/2025/03/07/apple-delays-siri-ai-improvements-to-2026.html) |
| **Notification summaries fabricated news.** Apple Intelligence falsely reported Luigi Mangione had shot himself, Luke Littler had won the PDC final, invented a Rafael Nadal story — all citing the BBC. Apple disabled News/Entertainment summaries in iOS 18.3. | Summarization without confidence calibration. | [The Register](https://www.theregister.com/2025/02/12/bbc_ai_news_accuracy/) · [CBC](https://www.cbc.ca/news/business/apple-news-summaries-fake-headlines-1.7434136) |
| **Writing Tools refuse mild profanity.** "Was not designed to handle this type of content" on adult words. Useless for real prose. | Over-tuned safety classifier. | [Yahoo Finance](https://finance.yahoo.com/news/apple-intelligences-writing-tools-stumble-160009720.html) |
| **Writing Tools blocked in Meta apps.** Facebook, Instagram, WhatsApp, Threads, Messenger all suppress the UI — exactly where users compose most text. | Platform-politics tax on the user. | [AppleInsider](https://appleinsider.com/articles/25/04/17/facebook-whatsapp-and-instagram-block-use-of-apple-intelligence) |
| **Genmoji / Image Playground feel "shallow and soulless."** Two styles only; aggressive guardrails block generic terms; battery drains noticeably. | The on-device privacy story has a real-world energy cost. | [Six Colors](https://sixcolors.com/post/2024/12/ios-18-2-macos-15-2-review-picture-not-so-perfect/) |

### Spotlight

| Pain point | What it actually means | Source |
|---|---|---|
| **Keyword-only matching, no semantic search.** No concept/synonym matching out of the box. Apple's own WWDC24 talk concedes this and adds *opt-in* semantic search for individual app developers. | The default is dumb. | [WWDC24](https://developer.apple.com/videos/play/wwdc2024/10131/) · [Fenn](https://www.usefenn.com/blog/semantic-vs-keyword-search-on-mac) |
| **PDF body text often missing.** Long-running complaint. Spotlight lists PDFs as indexable; body content frequently doesn't surface. | Index gaps the user can't see. | [Apple Discussions](https://discussions.apple.com/thread/7421018) |
| **Stops at the file boundary.** Finds which PDF/video contains content but not the page, timestamp, or moment. | No "the part where X is discussed." | [Fenn](https://www.usefenn.com/blog/fix-spotlight-mac-sequoia) |
| **Index breakage on Sequoia / Tahoe.** Widespread reports of apps disappearing from results, irrelevant code files outranking matches, processes that need killing after every reboot. Mail search depends on Spotlight, so Mail breaks too. | A core macOS service is regressing. | [BGR](https://www.bgr.com/tech/macos-sequoias-spotlight-search-is-broken-and-apple-users-are-so-mad/) · [MacRumors](https://forums.macrumors.com/threads/what-the-hell-is-up-with-spotlight.2469857/) |
| **mds_stores resource burn.** Background indexer spikes CPU/fans during video rendering, compiling, recording — invisibly, with no UI to pause it. | The system fights the user. | [Fenn](https://www.usefenn.com/blog/disable-spotlight-on-mac) |
| **Tahoe Quick Keys are Actions-only.** The new 12-char text shortcuts apply only to Actions, not files/apps/contacts. Customization still trails Alfred / Raycast / LaunchBar by years. | Even the upgrade is partial. | [Six Colors](https://sixcolors.com/post/2026/04/im-switching-back-from-spotlight-at-least-for-now/) |

### What this product attacks, in one paragraph

The clearest gaps a local SLM + Shortcuts assistant can fill: **(1)** real multi-turn dialog with persistent memory across sessions; **(2)** semantic search inside file contents, email, and notes; **(3)** free-form action chaining without the SiriKit domain wall — anything Shortcuts can do, the model can drive; **(4)** a privacy boundary the user can *see*, with no surprise round-trips to Apple servers; **(5)** factual answers from local context instead of "I found this on the web"; **(6)** writing assistance that handles real prose; **(7)** summarization with calibrated confidence — when it doesn't know, it says so; **(8)** an app that *visibly* yields to the user's other work instead of fighting it for resources.

---

## 2. The pitch (one paragraph for the LinkedIn post)

A personal AI that *actually runs on your laptop*. No cloud, no subscription, no telemetry. Plug it into Apple Shortcuts and it can text, schedule, remind, summarize, search your files, and chain actions Siri has never been able to. Ships as a sleek native Mac app. Runs on a 2020 MacBook Air with 8GB of RAM. If it runs there, it runs on every M-series Mac. Try it: download the `.dmg`, double-click, talk to it.

---

## 3. Hard requirements — the bar to clear

These are the constraints that define the product. If a feature breaks one of these, the feature loses.

### 3.1 Hardware floor: M1 MacBook Air, 8GB RAM

Every architectural decision must be tested against the worst supported machine. The model footprint, the app footprint, the indexing pipeline, the UI rendering — all of it has to leave room for the user's actual work (browser tabs, IDE, Zoom, builds).

| Resource | Hard cap on M1 8GB |
|---|---|
| Model weights resident in RAM | ≤ 2.6 GB |
| App + brain process steady state (no inference) | ≤ 250 MB |
| Idle CPU draw | ≤ 2% |
| First-token latency (model loaded, warm) | ≤ 1.5 s |
| Streaming throughput | ≥ 18 tok/s on M1 (currently ~20 tok/s with Qwen 3-4B) |
| Disk footprint of the .app + model + index | ≤ 5 GB |
| Battery cost: 100 tokens generated | ≤ measurable budget TBD via instrumentation in the eval suite |

The 8GB rule is the forcing function. It's also the marketing line: *runs on the cheapest M-series Apple still sells*.

### 3.2 Local-first, no compromises

- **No telemetry by default.** Period. An opt-in crash reporter (file-based, batched, user-readable before send) is the most we ship.
- **No cloud dependency for core functionality.** The app must work offline, on a plane, with no router. Web search and any escalation tier are *additive*, never load-bearing.
- **The privacy boundary is visible.** Every request the user makes shows where it ran — local, web (search tool), or remote tier (if the user opted in). No surprise round-trips. This is a direct response to the WhatsApp / Siri privacy leak research above.

### 3.3 First-class macOS app

- Native shell (SwiftUI, AppKit where it earns it). No Electron. No web view chrome.
- Code-signed, notarized, ships as a `.dmg`. App Store distribution evaluated separately.
- Spotlight-style global hotkey (default `⌥ Space`, configurable, doesn't fight Raycast/Alfred).
- Menu bar agent + dock app modes; user picks.
- macOS 14+ (Sonoma) baseline, since that's the floor for serviceable Apple Silicon support.

### 3.4 Apple Shortcuts as the action surface

- The model can invoke any Shortcut on the user's machine via `shortcuts run "Name" -i <input>` (CLI) or the `shortcuts://` URL scheme.
- Tools register Shortcuts dynamically: at launch the app enumerates available Shortcuts and exposes them to the model as a structured catalog.
- The user can mark Shortcuts as *destructive* (sends a message, makes a payment, deletes a file). Destructive shortcuts always require explicit confirmation in the UI before invocation, regardless of model confidence. **No autopilot for things that touch the world.**
- The user can mark Shortcuts as *private* (the input never leaves the local model). The privacy router from `design.md` §3.4 enforces this before any escalation tier sees the request.

### 3.5 Eval-driven model selection

We do not ship the model that "feels good." We ship the model that wins the published eval suite — see §8. The current incumbent is Qwen 3-4B-Instruct-2507; that's the floor candidate, not necessarily the shipped one.

---

## 4. Elasticity — shrink and expand with system load

**The rule: never crash. Slow down, defer, refuse, queue — but stay alive.**

A cloud LLM owns its slice of GPU and RAM. A local SLM on an 8GB M1 Air shares everything with the rest of the user's machine. The available envelope is sporadic, not stable (`design.md` §3.5). Most apps assume they're alone on the machine; this one cannot. The user is editing video, on a Zoom call, doing a Webpack build, watching YouTube in 4K — the assistant has to yield, shrink, queue, and resume. Elasticity isn't a polish step; it's the architectural stance.

### 4.1 What other apps get right

Patterns worth stealing from:

- **Time Machine** backs off during user activity, runs during idle. *Foreground always wins.*
- **Lightroom / Photos** generate previews in a background queue, pause on user input, resume on idle. *Heavy work is queued, not blocking.*
- **Xcode** stops indexing during a build. *Don't fight the user's other tools for the same resource.*
- **Chrome / Safari** discard background tabs under memory pressure. *Shed cold parts to save hot parts.*
- **macOS App Nap** throttles off-screen apps. *The OS already wants to help; cooperate with it.*
- **Final Cut** drops to lower-resolution proxies during scrubbing, full quality for export. *Trade quality before availability.*

The cautionary tale is **Spotlight's `mds_stores`** — the indexer that famously *doesn't* yield, spiking CPU during video renders and compiles ([Fenn](https://www.usefenn.com/blog/disable-spotlight-on-mac)). Users hate it because it's invisible, persistent, and resource-greedy at exactly the wrong time. We do not want to be `mds_stores`.

### 4.2 The elasticity ladder

When pressure rises, the app sheds capability in this order. Each rung is independent — we drop only as far as the system demands.

| Rung | Pressure signal | What we shed | User-visible state |
|---|---|---|---|
| 0 | None — system idle, ≥ 4 GB free | Nothing. Fully expanded. | **Idle** |
| 1 | Light — 2–4 GB free, normal CPU | Background indexing pauses. Embedding generation queued. | **Background paused** |
| 2 | Moderate — 1–2 GB free, or CPU > 50% sustained | Daemon defers scheduled work. Context budget shrinks (8K → 4K). UI animations reduced. | **Conserving** |
| 3 | High — < 1 GB free | Refuse new background work entirely. Foreground inference still runs. New requests queue, never overlap. | **Pressure** |
| 4 | Severe — pressure persists, KV cache near limit | Aggressive context trim. Refuse over-budget prompts with a clear "ask shorter or `/clear`" message. | **Pressure** + tooltip |
| 5 | Critical — sustained pressure or recent inference crash | **Unload the model.** Free 2.4 GB instantly. Watchdog watches for recovery. New requests queue; queue depth visible. | **Sleeping** + queue badge |
| 6 | Recovery — pressure drops, idle ≥ N seconds | Watchdog reloads (~3 s). Queued requests resume in order. | **Waking** (animated transition) |

Two principles run through the ladder:

1. **Trade quality before availability.** A shorter context window or a deferred index pass is a worse experience than a crashed app by an order of magnitude. Always shrink first.
2. **Recovery is automatic and visible.** The user never restarts the app to come back from pressure. The state indicator shows the comeback, not just the slowdown.

### 4.3 The watchdog

A small, separate process — a few hundred KB — that supervises the brain and is itself almost impossible to kill. Its only jobs:

- **Heartbeat the brain.** If the brain stops responding (crash, hang, OOM-kill by the OS), the watchdog notices within seconds.
- **Restart with state.** State persists *before* execution (`design.md` §3.6 #2), so the watchdog resumes the queue rather than losing it.
- **Throttle restarts.** Exponential backoff on repeated crashes from the same prompt. After two crashes on the same prompt the user gets "this couldn't be answered locally — try later, shorter, or escalate" — not an infinite loop.
- **Sample system pressure.** macOS `memory_pressure`, `vm_stat` derivations, CPU%, currently-loaded model. Feeds the elasticity ladder above. (`design.md` Q18 is the open question on whether these signals are actually predictive — the watchdog is also where we measure that.)
- **Wake on demand.** When pressure clears and there's queued foreground work, the watchdog signals the brain to reload the model and resume.
- **Own the user-facing socket.** The UI talks to the watchdog, not the brain. So even when the brain is restarting, the UI still has someone to talk to — the watchdog answers with state and queue depth, not silence.

The watchdog is the answer to "the app must never crash." The brain *can* crash — local SLMs on 8GB occasionally will, and we measured it (`eval/perf_kv.ts` already documents one path). The *app* doesn't, because the watchdog owns the queue and the UI state, and the brain is the part it can replace.

### 4.4 The user always knows why

The whole point of being elastic is wasted if the user reads "slow" as "broken." Every shed rung above maps to a state in §11. When the model is sleeping under pressure, the indicator says so and the queue badge shows what's waiting. When it's waking, the indicator animates. When background work is paused, hovering the indicator explains why — "indexing paused: video editing detected" or "model unloaded: 800 MB free."

This is a direct response to the Spotlight critique in §1: users hate `mds_stores` not because it uses CPU but because it uses CPU *invisibly*, while they're trying to render a video, with no way to see what it's doing or stop it. **We treat resource use as a UI concern, not a system concern.**

### 4.5 What the eval suite has to prove

Elasticity isn't real until it's measured. New evals layered onto §8:

- `eval/capstone_pressure.ts` — synthesize memory pressure, verify the ladder fires in order, the model unloads, the queue holds, the brain recovers.
- `eval/capstone_concurrent.ts` — extended: with 10 Chrome tabs + a Webpack build + Zoom, the brain still serves foreground requests, even if at rung 3.
- `eval/capstone_watchdog.ts` — kill the brain mid-conversation; verify the watchdog restarts it, the queue replays, no message is silently lost.
- `eval/capstone_no_crash.ts` — soak test. Run the prompts that historically crashed `eval/perf_kv.ts` on a constrained-memory machine. Pass = the *app* survives. The brain is allowed to lose a single completion; the app is not allowed to die.

---

## 5. Considerations & non-goals

What we are not doing for v1, so the scope stays sharp:

- **Not voice in.** Whisper.cpp integration is aspirational (§10). v1 is text-first. Voice introduces a second hard stack (audio pipeline, wake-word, STT model RAM budget) that distracts from the core thesis.
- **Not iOS.** The same architecture maps to iPhone, but Apple's on-device model APIs and the Shortcuts surface differ enough that iOS is a separate v-bump.
- **Not multi-user.** One user per install. Profile and notes are not shared.
- **Not training.** No fine-tuning, no RLHF, no LoRAs. The model is a frozen weight; personalization happens via the profile + RAG, not gradient descent.
- **Not a Raycast replacement.** Raycast is a launcher with extensions. This is a conversational agent that happens to have a launcher-shaped front door. They can coexist on the same machine; many users will run both.
- **Not "Apple Intelligence at home" feature parity.** Genmoji, Image Playground, etc. are out of scope. We compete on the parts of the assistant Apple has *failed* to deliver, not the cosmetic parts they have.
- **Not selling data.** Stating the obvious so it appears in the spec.

---

## 6. The model question — what's the smallest SLM that ticks the boxes?

The 8GB RAM ceiling is the gate. After macOS, browser, IDE, and the app itself, ~3.5–4 GB is available for the model. That puts us firmly in the "small model" category — 3B to 8B parameters at 4-bit quantization.

### 6.1 The shortlist (to be evaluated, not picked yet)

| Model | Approx 4-bit size | Tool calling | Notes |
|---|---|---|---|
| **Qwen 3-4B-Instruct-2507** *(incumbent)* | ~2.4 GB | Strong (30/30 on our v4 eval) | Current baseline. Tool-calling reliable, anti-confab works, ~20 tok/s on M1. Floor candidate. |
| Qwen 3-1.7B-Instruct | ~1.1 GB | Unknown — must test | Half the RAM. If tool calling holds, this is the M1 8GB sweet spot. Probable cliff: multi-tool selection collapses below 3B. |
| Qwen 3-4B-Thinking-2507 | ~2.4 GB | Strong | Same family, post-trained for `<think>` reasoning. Probably better on hard prompts; 5–10× latency on easy ones. Candidate for offline/grooming work, not foreground turns (see `design.md` Q16). |
| Phi-3.5-mini-instruct | ~2.3 GB (3.8B params) | Mid | Microsoft's small-model bet. Strong on reasoning benchmarks, mid on tool calling per public evals. Worth a head-to-head. |
| Gemma 3-4B-it | ~2.5 GB | Unknown — must test | Google's recent small model. Multimodal capable; the vision side isn't in scope, but the text quality may justify the slot. |
| Llama 3.2-3B-Instruct | ~1.8 GB | Weak | Already empirically worse than Qwen at tool calling on this stack. Listed for completeness; unlikely to win. |
| SmolLM3-3B | ~1.8 GB | Unknown — must test | HuggingFace's open small-model effort. Cheap to evaluate. |
| Apple Foundation Models (Apple Intelligence on-device) | N/A | Apple-controlled | If Apple opens the on-device model to third-party apps in a usable way, we evaluate it on equal footing with the rest. *We do not bet on this.* |

### 6.2 What "ticks the boxes" means precisely

A model is shippable if it meets *all* of:

1. **Footprint.** ≤ 2.6 GB resident at 4-bit MLX quantization.
2. **Tool calling.** ≥ 90% on a 30-prompt multi-tool eval against the shipped Shortcuts catalog (see §8).
3. **Refusal / honesty.** ≥ 90% on an "I don't know" eval — the model says it doesn't know rather than confabulating.
4. **Streaming throughput.** ≥ 18 tok/s sustained on M1 8GB at 4K context.
5. **First-token latency.** ≤ 1.5 s warm on M1 8GB.
6. **Multi-step composition.** Successfully chains 2 tool calls in ≥ 80% of a 10-prompt composition test (e.g. "find the doc Sarah sent → summarize it → text her the summary").
7. **Battery.** ≤ TBD Wh per 1000 tokens generated, measured via `powermetrics`.

We ship the smallest model that passes. If two models pass and one is half the RAM, the smaller one wins by default — that's RAM the user gets back for their work.

---

## 7. Flagship Shortcuts — the demos that sell it

These are the *nine* user stories the launch demo has to nail. Each one is a single user utterance that produces a visible, useful result, and each is a thing Siri *cannot* reliably do today. Picked to cover composition, memory, ambient context, and writing.

### 7.1 The composition demo
> **"Text Sarah I'll be 10 minutes late, then add a 25-minute Pomodoro."**

Two intents in one turn. Siri can't. The model decomposes into `send_message(Sarah, ...)` + `run_shortcut("Pomodoro 25")`. The destructive action (sending the message) prompts a confirmation banner; the timer doesn't.

### 7.2 The "I know you" demo
> **"Schedule a focus block tomorrow morning."**

The model knows from the profile that "morning" means 8–10 for this user (saved from a prior session via `remember`). Creates the calendar event without asking.

### 7.3 The semantic file search demo
> **"Find that PDF Sarah sent me last week with the budget."**

RAG over the user's `~/Documents` (opt-in indexed) finds a PDF whose body mentions "Q3 budget" — even though "budget" isn't in the filename. Spotlight famously can't.

### 7.4 The synthesis demo
> **"What's on my calendar tomorrow, and which of those should I prep for?"**

Lists events, then reasons about them — "the 9am with Marcus is a check-in; the 2pm interview probably needs notes." Siri stops at the listing.

### 7.5 The journaling demo
> **"What did I write about Cairns this month?"**

Episodic recall over `~/.assistant/notes` and prior sessions. The brain we already have does this.

### 7.6 The Shortcuts library demo
> **"Run my morning routine."**

The model invokes a user-defined Shortcut by name. Demonstrates that *every* Shortcut the user has built is now a tool the model can call — the catalog is theirs, not ours.

### 7.7 The honest "I don't know" demo
> **"Who won the Australian election yesterday?"**

The model says it doesn't know — recent events aren't in its weights — and offers to run a `web_search` tool (only if the user has enabled it). **Siri here just throws Safari at you.** This demo is intentionally about what we *don't* hallucinate.

### 7.8 The memory demo
> **(Day 1)** "I'm vegetarian."
> **(Day 7)** "What should I order for the team lunch on Friday?"

The model remembers across sessions and factors it in. Profile + RAG. Siri has never done this.

### 7.9 The "no internet" demo

The presenter turns off Wi-Fi on stage. Asks the model to summarize their notes from yesterday, draft a follow-up email, and run their evening Shortcut. Everything still works. **This single moment is the whole pitch.**

---

## 8. Eval suite — how we pick a model and prove the product works

Extends the existing eval discipline in `design.md` §6 with capstone-specific tests. Every candidate model runs the full suite; results published in the repo. Current trajectory evals (v0–v6) stay in place; the suite below adds product-level evals.

### 8.1 Functional evals

| Eval | What it measures | Pass bar |
|---|---|---|
| `eval/capstone_shortcuts.ts` | Tool selection across the user's actual installed Shortcuts (catalog typically 30–80 entries). Synthetic prompts targeting each. | ≥ 90% correct selection, ≥ 95% valid args |
| `eval/capstone_compose.ts` | 2-step and 3-step composition (the §7.1 / §7.9 shape) | ≥ 80% on 2-step, ≥ 60% on 3-step |
| `eval/capstone_idk.ts` | "I don't know" calibration — recent events, nonsense questions, ambiguous references | ≥ 90% honest refusal vs confabulation |
| `eval/capstone_destructive.ts` | The model proposes destructive actions that route through the confirmation banner — *never* auto-confirms a destructive Shortcut | 100%, no exceptions |
| `eval/capstone_privacy.ts` | Synthetic sensitive prompts (SSNs, account numbers, `:private` tagged) — verify zero escalation to remote tier when configured | 100%, no exceptions |

### 8.2 Performance evals (extends `eval/perf_*` already in repo)

| Eval | What it measures | Pass bar (M1 8GB) |
|---|---|---|
| `eval/capstone_ttfb.ts` | First-token latency, cold and warm | ≤ 4 s cold, ≤ 1.5 s warm |
| `eval/capstone_throughput.ts` | tok/s sustained over a 4K-token completion (we already see KV decay; this is the regression gate) | ≥ 18 tok/s |
| `eval/capstone_memory.ts` | RSS during typical session: 10 turns, mix of tool calls and chat | Peak ≤ 3.5 GB total (model + brain + UI) |
| `eval/capstone_battery.ts` | Wh per 1000 generated tokens, via `powermetrics` | TBD baseline; regression gate after first run |
| `eval/capstone_concurrent.ts` | Performance with 10 Chrome tabs, IDE, Slack open — the realistic load | ≥ 80% of clean-machine throughput, no crashes (see §4.5) |

### 8.3 Elasticity evals (the §4 promise, in code)

| Eval | What it measures | Pass bar |
|---|---|---|
| `eval/capstone_pressure.ts` | Synthesized memory pressure walks the elasticity ladder in order; rungs fire at the right thresholds; recovery returns to rung 0 | All 7 rungs observable; no skipped rungs; recovery within N seconds of pressure clearing |
| `eval/capstone_watchdog.ts` | Kill the brain mid-stream; watchdog detects, restarts, replays the queue | No silently-lost messages; UI never goes dead |
| `eval/capstone_no_crash.ts` | Soak test: hours of `perf_kv` prompts on a memory-constrained machine | The brain may lose a completion; the app may not die. Period. |

### 8.4 The model bake-off

`eval/capstone_bakeoff.ts` runs §8.1 + §8.2 across the §6.1 shortlist and emits a single comparison table: model, RAM, throughput, scores per category, total. **This file is the answer to "which model do we ship?"** It is reproducible, public, and re-run on every candidate update.

### 8.5 Frontier-as-judge (per `design.md` §6.2)

Open-ended responses (writing assistance, summarization) graded by Claude on a fixed rubric. Same pattern we already use for v0–v6 evals.

---

## 9. Architecture — how the app wraps the brain

```
┌────────────────────────────────────────────────────────┐
│  Native shell (SwiftUI / AppKit)                       │
│   - global hotkey, command bar, conversation panel     │
│   - state indicator (see §11)                          │
│   - confirmation banner for destructive actions        │
│   - settings, onboarding                               │
└───────────────────────────────┬────────────────────────┘
                                │ Unix-domain socket (JSON-RPC)
                                ▼
┌────────────────────────────────────────────────────────┐
│  Watchdog (tiny supervisor — the never-dies process)   │
│   - owns the user-facing socket; queues requests       │
│   - heartbeats + restarts the brain with state         │
│   - samples memory_pressure / vm_stat / CPU            │
│   - drives the §4 elasticity ladder                    │
│   - signals brain to unload / reload on pressure       │
└───────────────────────────────┬────────────────────────┘
                                │ supervises ↓
┌────────────────────────────────────────────────────────┐
│  Brain (Bun / TypeScript) — the existing repo brain    │
│   - chat loop, tools, profile, RAG                     │
│   - Shortcuts catalog discovery + tool registration    │
│   - daemon loop for scheduled / background work        │
└───────────────────────────────┬────────────────────────┘
                                │ OpenAI-compat HTTP
                                ▼
┌────────────────────────────────────────────────────────┐
│  Inference (MLX, embedded)                             │
│   - mlx-lm or successor, in-process, no LM Studio dep  │
│   - model weights bundled or first-run downloaded      │
└────────────────────────────────────────────────────────┘
```

**Why this shape:**

- **The brain stays in TS.** Don't rewrite a working orchestrator in Swift. Bun-the-binary is small enough to bundle; a Unix socket is the right amount of plumbing.
- **The watchdog is the part that doesn't die.** A few hundred KB. Owns the user-facing socket so the UI never sees "process gone." The brain is the part that's allowed to crash — the watchdog brings it back.
- **Inference embedded, not LM Studio.** LM Studio is great for development; for the shipped app, we embed `mlx-lm` (or its successor) so there's no second app to install. This is the meaningful packaging change between "dev tool" and "product."
- **Shortcuts catalog is dynamic.** The brain enumerates `shortcuts list` at launch and on a watcher; new Shortcuts the user creates appear as available tools without a restart.
- **Model lifecycle is a real feature, not a bug.** Idle for N minutes → unload, free 2.4 GB. Pressure rises → watchdog forces unload. Re-enter → reload, ~3 s, with clear UI state (see §11). This is the §3.5 strategy from `design.md`, surfaced in the UI.

**What ships in the .app bundle:** the SwiftUI shell, the watchdog, the bundled Bun runtime + brain, the embedded MLX inference server, default model weights (or a first-run download with progress UI), the default Shortcut tool wrappers, an onboarding flow that asks the user which Shortcuts to expose.

---

## 10. Aspirational features (post-v1)

The roadmap once the floor is solid. Listed in rough priority order; none of these block v1.

1. **Voice input via local Whisper.cpp.** Push-to-talk hotkey. Whisper-small.en is ~470 MB at 4-bit; budget needs revisiting. Voice answers a real Siri use-case (driving, hands-busy) but introduces non-trivial RAM and latency overhead.
2. **A second tier on-device.** Qwen 3-4B-Thinking for hard prompts, escalated by the router (`design.md` §3.4 + Q16). Same RAM footprint, ~10× latency budget on the prompts that actually need it. Privacy boundary stays intact — both tiers are local.
3. **Live screen awareness.** What Apple promised at WWDC 2024 and delayed: the model can answer "what does this email mean?" when you have an email open. Implemented via Accessibility APIs, with explicit per-app opt-in. Big trust surface; ship slowly.
4. **Scheduled / background tasks (`design.md` §3.6).** "Every morning at 8, summarize my unread important emails and surface anything time-sensitive." Daemon mode, system notifications, focus-mode-aware delivery.
5. **iCloud-synced profile + notes (inference stays local).** The user's *facts* sync; the *model* never does. Inference happens on whichever device is asked.
6. **Plugin / Shortcut marketplace.** A curated set of high-quality Shortcuts pre-built for common workflows (calendar, email, files, HomeKit). The catalog grows without forking the app.
7. **Custom personalities / system prompt presets.** "Be terse." "Be a sparring partner, not a yes-man." A small surface area; users currently DIY this in the system prompt.
8. **iPhone companion (the v10+ shape).** Same brain, same profile, smaller model. The honest constraint here is that iOS hasn't shipped a friendly enough on-device model API for third parties — we evaluate when it does.
9. **Web search tool.** A `web_search` tool the user explicitly enables. Privacy-respecting search backend (Brave, Kagi, DuckDuckGo). Only invoked when the model decides — and visibly, in the conversation log.
10. **Time-machine queries.** "What did I do last Tuesday?" — synthesis over sessions + notes + calendar. Largely already possible with v6 RAG; needs UI affordance.
11. **Proactive grooming (`design.md` Q15).** Periodically scan past sessions for stable facts, surface them for one-tap save into the profile.

---

## 11. Interface principles — make state legible

A local SLM lives inside a sporadic resource envelope (`design.md` §3.5, capstone §4). Sometimes it's loaded and warm. Sometimes the OS evicted it under memory pressure. Sometimes it's mid-inference. Sometimes it's thinking with `<think>` tokens that won't be shown. Sometimes it's running a Shortcut and waiting for system permission. Sometimes the daemon is grooming in the background. Sometimes the watchdog just had to restart it.

**If the user can't see what the model is doing, they will assume it's broken.** The single most important UX decision in this product is making the model's state legible at a glance. Every state in §4's elasticity ladder maps to something the user can see, hover, and understand.

### 11.1 The state indicator

A small indicator in the menu bar (and again in the app's title bar when open) that always reflects the brain's current state. One source of truth: the watchdog. Eight states, eight visual treatments:

| State | Visual | What it means | Triggered by (rung) |
|---|---|---|---|
| **Idle** | dim solid dot | Model loaded, waiting for input. The default. | rung 0 |
| **Background working** | small offset dot | Daemon is doing scheduled work (indexing, grooming). Visible because surprise CPU is the thing users hate (§1, Spotlight). Click to pause. | rung 0–1 |
| **Conserving** | dim dot with amber tint | Background paused, context shrunk, animations reduced. Foreground still serves but the system is asking us to behave. | rungs 1–2 |
| **Thinking** | gentle pulse | Generating tokens. Streaming into the UI; the indicator just confirms the system is alive. | any |
| **Tool-calling** | small glyph overlay (the tool's icon) | Brain dispatched a tool. Demystifies "why did it pause?" | any |
| **Pressure** | amber dot | Memory pressure detected (rungs 3–4). Foreground inference may queue or refuse over-budget prompts. Hover for detail. | rungs 3–4 |
| **Sleeping** | hollow dot, optional queue badge | Model unloaded — by idle timeout *or* under pressure. Next request pays a ~3s reload. Pre-warm by tapping. Queue depth shown if requests are pending. | rung 5 (and idle-timeout) |
| **Waking** | hollow dot expanding into solid, soft animation | The watchdog is reloading the model. ~3 s. Queued requests resume in order. | rung 6 |

The states correspond directly to `design.md` §3.5 (resource awareness) + §3.6 (background runtime) and to the §4 elasticity ladder. The watchdog is the single source of truth — it samples pressure, fires the ladder, and emits state changes. **The indicator is just a window onto what the watchdog already knows.**

Hovering the indicator opens a small popover with the current rung, the active reason ("indexing paused: video editing detected"), free RAM, queue depth, and a one-click "pause background work" / "wake the model now" / "snooze for 10 minutes" control. The user is not a passenger.

### 11.2 Conversation legibility

- **Tool calls render inline.** "📍 Calendar checked → 3 events tomorrow" — the same structured trace `assistant.ts` already prints to the REPL, just styled. The user always sees what the model did, not just what it said.
- **The privacy boundary is visible per request.** Every assistant message has a small "ran on" tag — `local`, `web`, `mid-tier (cloud)`. No ambiguity about where the words came from. Direct answer to the WhatsApp / Siri privacy leak research.
- **Confidence cues.** When the model answers from RAG, cite the chunk inline. When it answers from profile, mark it *(from your profile)*. When it doesn't know, it says so plainly — and the UI doesn't dress that up.
- **Queue state is visible.** If the model is sleeping or under pressure and a request is queued, the conversation shows "waiting for the model to wake up… (#2 in queue)" rather than a frozen cursor. *Silence is the failure; queued is fine.*
- **Destructive actions stop the flow.** A confirmation banner with the literal command that's about to execute. No "tap to send" hidden under a menu. The model proposes; the user disposes.

### 11.3 Visual identity

- **Native materials.** SwiftUI vibrancy, system fonts (SF Pro / SF Mono for the conversation log), system colors, Dark Mode that matches Big Sur+ aesthetic without trying to over-design. The pitch is "it belongs on this machine" — that's a discipline, not a flourish.
- **Keyboard-first.** Every action has a key. Mouse is for confirming, not driving.
- **Sparse motion.** The state indicator pulses; the wake animation plays once. Nothing else animates without reason. Battery and visual calm both win.
- **Spotlight-shaped front door.** Global hotkey opens a command bar. The full conversation panel is a separate view — invoked when the user wants the receipts, not in the way when they don't.

### 11.4 Onboarding

- **First run: 60 seconds, three steps.** (1) Pick a Shortcuts catalog ("here are the Shortcuts on your machine; check the ones I can drive"). (2) Optional: index a notes folder. (3) Try a demo prompt. **No account, no email, no cloud signup.**
- **Model download is honest about size.** 2.4 GB is not nothing; show it, show the progress, let the user pause.
- **Privacy explanation is one screen, written in English.** Not a EULA. Not a checkbox. A paragraph, plus a button to read more.
- **The state indicator is introduced in onboarding.** A 10-second animation walks through what each state means. Users learn the language before they need it.

---

## 12. Distribution

- **GitHub repo, public.** Code, evals, and weights references in the open. The eval suite (§8) is the receipts.
- **Direct `.dmg` download from a project page.** Notarized, code-signed, drag-to-Applications. No installer.
- **App Store evaluated separately.** The sandbox model interacts awkwardly with `shortcuts run` and arbitrary file access; we don't promise an App Store version in v1.
- **Auto-update via Sparkle (the macOS standard).** Signed update manifests, no telemetry on the update channel.
- **Open beta.** Distribute via LinkedIn, HN, the usual channels. The 8GB constraint means the audience is "every M-series Mac owner," which is a lot of engineers.

---

## 13. Risks & open questions

Listed honestly so future-William can come back to them.

1. **Will Apple change the Shortcuts CLI / URL scheme out from under us?** Plausible. Mitigation: abstract the Shortcuts adapter behind an interface; one well-understood point of breakage.
2. **Will Apple ship Apple Intelligence to a state that makes this redundant?** Their public delay schedule (§1) suggests not by the time we ship v1. But we should explicitly track Apple's WWDC announcements as a risk input — the day Apple opens the on-device model to third-party tool calling with a sensible permission model, the calculus changes.
3. **Sandboxing.** A model that can run Shortcuts can do real damage. The destructive-action confirmation flow is the safety rail. We will *never* ship a "let it just do things" mode in v1.
4. **Model quality below the 4B floor.** If the §8.4 bake-off shows nothing under 4B passes, we ship Qwen 3-4B and accept the 2.4 GB footprint. The bake-off result is the answer; this question is whether to *want* a smaller answer.
5. **Battery.** Local inference is power-hungry. The §8.2 battery eval is the gate. If we measure and it's bad, we ship a "battery saver" mode that idles the model more aggressively (rung 1 by default on battery).
6. **Notification fatigue (post-v1).** The lesson from Apple Intelligence summary fabrications (§1) is that proactive output without confidence calibration destroys trust. When we add scheduled tasks (§10 #4), they ship with the same "ran on / confidence / source" cues as conversation.
7. **The privacy promise depends on the user trusting the binary.** We ship reproducible builds eventually; in the meantime, the code is open and the network calls are auditable with Little Snitch.
8. **Shortcut permissions.** macOS may prompt the user the first time the app invokes Shortcuts; that needs to be a planned, documented onboarding moment, not a surprise dialog mid-conversation.
9. **Model file licensing.** Qwen 3 is Apache-2.0; Phi is MIT; Gemma is Gemma-licensed (more restrictive); Llama is community-licensed. Bake-off needs a legal column, not just a quality column.
10. **Are macOS pressure signals actually predictive?** `design.md` Q18: does `memory_pressure` / `vm_stat` correlate with inference-worker crash risk, or is the only honest signal the crash itself? The watchdog is where we measure this — if signals are noisy, we lean harder on retroactive backoff (rung 5 triggered by crash, not by sample).
11. **The thing we haven't thought of.** Listed for honesty. The eval suite is what catches things we didn't anticipate.

---

## 14. Capstone milestones

The product trajectory, in the same shape as `design.md` §4. Each milestone introduces exactly one new capability and ships only when its eval passes.

| m | Concept | What we add | Eval gate |
|---|---|---|---|
| **m0** | Native shell over the existing brain | SwiftUI command bar, IPC to Bun, conversation panel | Brain reachable from the UI; existing v0–v6 evals still pass through the IPC path |
| **m1** | Shortcuts as tools | Catalog discovery, dynamic tool registration, single-shortcut invocation | `eval/capstone_shortcuts.ts` ≥ 90% on a 30-prompt set |
| **m2** | Embedded inference | mlx-lm (or successor) embedded; LM Studio dependency removed | First-token + throughput evals match LM Studio baseline ±10% |
| **m3** | State indicator + privacy tags | The §11 UX shipped; every conversation has a "ran on" tag; indicator reflects watchdog state | Manual UX review; states map 1:1 to brain telemetry |
| **m4** | Destructive-action gating | Confirmation banner, Shortcut classification UI, allowlist | `eval/capstone_destructive.ts` 100% |
| **m5** | Elasticity ladder + watchdog | The full §4 stance: watchdog process, system-pressure sampling, all 7 ladder rungs, queue, automatic recovery, never-crash promise | `eval/capstone_pressure.ts` + `eval/capstone_watchdog.ts` + `eval/capstone_no_crash.ts` all pass on M1 8GB |
| **m6** | Onboarding + .dmg | First-run flow, packaging, notarization, Sparkle updates | Fresh install → demo prompt working in ≤ 90 s on a clean M1 8GB |
| **m7** | Model bake-off | §8.4 run across the §6.1 shortlist; published results | Decision logged in `design.md` decision log |
| **m8** | Public beta | LinkedIn launch post, GitHub repo public, eval results published | Outside engineers download, run, and complete the §7 demo flows |

m0 → m8 is the v1 shape. Everything in §10 lives past m8.

---

*Last updated: 2026-04-30. Update at every architectural decision, every learned constraint, every shipped milestone. Pair with `design.md` — that's the brain spec, this is the product spec.*
