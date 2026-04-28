# Personal Assistant on Local SLMs

A local-first personal assistant. Brain is **Qwen 3-4B-Instruct-2507** (4-bit MLX, ~2.4GB) served by LM Studio. ~20 tok/s on an M1 with 8GB RAM.

For the architecture, the version trajectory, and the decision log, see [`design.md`](./design.md). For a visual map, see [`architecture.svg`](./architecture.svg).

## Quick start

```bash
# Start LM Studio, load Qwen 3-4B-Instruct-2507, start the Developer server.
bun install
bun run src/index.ts                    # new session
bun run src/index.ts --resume           # load the most recent session
bun run src/index.ts --load <id-prefix> # load a specific session

# Inside the REPL:
/quit  /clear  /new  /history  /tokens  /context  /budget [n]
/sessions  /load <id>  /resume  /tools  /profile  /forget <key>

# Run an eval (each version's pass conditions live in design.md §6.1):
bun run eval/v0.ts   # substrate
bun run eval/v1.ts   # context management
bun run eval/v2.ts   # persistence
bun run eval/v3.ts   # tool calling
bun run eval/v4.ts   # multi-tool routing
bun run eval/v5.ts   # profile (mutable current truth)
```

State lives at `~/.assistant/`:
- `sessions/*.jsonl` — per-session append-only chat history
- `notes/*.md` — markdown notes the model can read, list, write, search
- `profile.json` — flat key→value facts loaded into every system prompt

## Known gotchas (Qwen 3-4B at this size)

These are empirical findings from the per-version evals. Knowing them changes how you should phrase things.

### What works well
- **Tool calling at 7 tools.** v4 eval (5 tools): 30/30 right tool with valid args, 5/5 correctly skip-tool on chitchat. The over-call bias from older Qwen 2.5 is gone. v5 added 2 more (`remember`, `forget`) without regression.
- **Tool calls are visible.** The REPL prints `· tool_name(args) → result preview [Nms · step N]` after each tool execution, so multi-step flows aren't a black box. Errors get a `✗` prefix.
- **Profile recall.** Facts in `~/.assistant/profile.json` are surfaced into the system prompt every turn. v5 eval: 5/5 — "what's my dog's name?" works without any tool call when the fact is in the profile.
- **Saving facts when told.** "Remember X is Y" reliably triggers `remember(...)`. v5 write: 5/5.
- **Anti-confabulation.** With the prompt clause "if you don't know, say so plainly", the model gracefully admits ignorance instead of inventing answers. (Observed cliff in v1 with old Qwen 2.5; resolved.)

### What doesn't work well

- **Implicit change detection.** "I don't like eggs anymore" / "I changed my mind about X" — the model picks this up ~66% of the time (v5 supersession: 2/3). For reliable updates, use **explicit replacement language**: *"My X is now Y, not Z"* or *"Update X to Y"*. Or just `/forget <key>` and re-state.
- **Profile vs. recent-chat contradiction.** When something in the chat history contradicts a profile fact, the model often sides with chat (especially when the chat says "last week" / "now" / "actually"). This is genuinely ambiguous behavior; the eval doesn't gate on it. Workaround: when you mean a profile fact to be authoritative, restate it ("just to confirm, I dislike eggs — that's the current truth").
- **Multi-step reasoning past 3 hops.** Drift, lost premises, hallucinated intermediate steps. Decompose: ask for one step, get the answer, ask for the next.
- **Code generation > 30 lines.** Don't. Use a stronger model. (v7 routing will handle this automatically.)
- **Long context.** Past ~20 turns the model muddles older content even when it's still in the budget. `/clear` early; `/resume` only when the prior context is genuinely relevant.
- **Negation and quantifiers.** "All X except Y" → handles X, ignores Y. Phrase positively: list what *applies*, not what's excluded.
- **Plan-then-execute.** The model is much weaker at "outline a 5-step plan, then execute it" than at single steps. Drive the plan yourself; let the model do each step.

## Tips for getting the most out of it

1. **Be explicit on memory.** "Remember my home is Cairns" >> "btw I'm in Cairns". Both work, the explicit phrasing works *more reliably*.
2. **Use the profile for stable facts, notes for content.** Profile = preferences, names, locations, relationships (small, mutable). Notes = anything you'd write in a journal (large, append-mostly). They serve different jobs.
3. **One concept per turn.** "Read brisbane.md" works; "Read brisbane.md and ducks.md and tell me what they have in common" is at the edge of what 4B does well.
4. **Trust the "I don't know"** — when the model says it doesn't know, it usually doesn't. Don't argue with it; check the profile or notes.
5. **`/profile` often.** It's the cleanest way to see what the model "knows" about you. If something looks wrong there, the model's behavior will be wrong too.
6. **`/clear` between unrelated topics.** A fresh session is cheap and avoids context muddle.
7. **Give it nouns, not pronouns.** "What does brisbane.md say?" works; "What does it say?" — depends on whether "it" is still in context.
8. **Empty-profile sessions are fine.** The profile section only renders when there are facts; it doesn't fill context with placeholders.

## When to bail to a stronger model

If you're hitting any of these, this brain is the wrong tool — escalate:
- Code generation, refactoring, code review
- Reasoning chains over 3-4 steps
- Strict JSON / schema generation under load
- Anything where the answer must be *correct*, not just plausible

Until v7 routing arrives, the workflow is: do the rest with this assistant; copy the hard parts to a frontier model directly.

## Privacy

Profile, notes, and sessions are all local on the laptop. No telemetry, no third-party calls, no cloud. The privacy boundary becomes load-bearing at v7 when remote tiers are introduced — until then it's a side effect of being purely local.
