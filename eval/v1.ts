/**
 * v1 eval — context management.
 *
 * v0 substrate (eval/v0.ts) verified the model is reachable and stateless.
 * v1 verifies our Context class:
 *
 *   1. unit: budget enforced — oldest messages drop, system never drops
 *   2. unit: latest user message preserved when budget tight
 *   3. integration: long conversation stays under configured budget
 *   4. capability cost: a fact stated early IS forgotten once it ages out
 *      of the window — proving the tradeoff is real, not just mechanical
 *
 * Run with:  bun run eval/v1.ts
 * Exit code: 0 if all pass, 1 otherwise.
 */

import { OpenAICompatClient, discoverModel, probeServerCapabilities } from "../src/client";
import { Context } from "../src/context";
import { Assistant } from "../src/assistant";

const BASE_URL = process.env.MODEL_BASE_URL ?? "http://localhost:1234/v1";
const API_KEY = process.env.MODEL_API_KEY ?? "lm-studio";

// Mirrors the strengthened system prompt in src/index.ts. The anti-confabulation
// instruction is the v1 fix; eval verifies it actually changes behavior.
const RECALL_SYSTEM = [
  "Reply concisely.",
  "If you don't know or don't remember something, say so plainly.",
  "Never invent facts about the user that weren't established in this conversation.",
].join(" ");

type CheckResult = { name: string; passed: boolean; detail?: string };
const results: CheckResult[] = [];

function record(name: string, passed: boolean, detail?: string) {
  results.push({ name, passed, detail });
  const mark = passed ? "✓" : "✗";
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ""}`);
}

function header(title: string) {
  console.log(`\n§ ${title}`);
}

// ─── unit checks (no model needed) ────────────────────────────────────

function unitChecks() {
  header("unit: Context budget enforcement");

  // 1. With ample budget, nothing is trimmed.
  {
    const c = new Context({ systemPrompt: "sys", budget: 4096 });
    for (let i = 0; i < 5; i++) {
      c.addUser(`user msg ${i}`);
      c.addAssistant(`assistant reply ${i}`);
    }
    const sent = c.messagesForRequest();
    record(
      "no trim under generous budget",
      sent.length === c.all().length,
      `sent=${sent.length} total=${c.all().length}`,
    );
  }

  // 2. With a tight budget, oldest messages drop, system stays first.
  {
    const c = new Context({ systemPrompt: "sys", budget: 80, reservedForResponse: 16 });
    // Each message is ~10 chars → ~3 tokens + 4 overhead = 7 tokens.
    // budget 80 - reserved 16 - sys ~5 = 59 available for history.
    for (let i = 0; i < 12; i++) {
      c.addUser(`u${i}_${"x".repeat(10)}`);
      c.addAssistant(`a${i}_${"y".repeat(10)}`);
    }
    const sent = c.messagesForRequest();
    record(
      "history trimmed under tight budget",
      sent.length < c.all().length,
      `sent=${sent.length} total=${c.all().length}`,
    );
    record(
      "system message preserved as first element",
      sent[0]?.role === "system" && sent[0]?.content === "sys",
    );
    // The latest user message should be the last in 'sent'
    const last = sent[sent.length - 1];
    record(
      "latest message preserved",
      last?.role === "assistant" && last?.content.startsWith("a11_"),
      `last=${last?.role}:${last?.content.slice(0, 12)}…`,
    );
  }

  // 3. Clear resets history and counters.
  {
    const c = new Context({ systemPrompt: "sys", budget: 4096 });
    c.addUser("hello");
    c.addAssistant("hi");
    c.recordUsage(50, 10);
    c.clear();
    const s = c.snapshot();
    record(
      "clear() resets history and cumulative counters",
      s.historyCount === 0 && s.cumulativeIn === 0 && s.cumulativeOut === 0,
    );
  }
}

// ─── integration checks (requires running model) ──────────────────────

async function integrationChecks() {
  let model: string;
  try {
    model = await discoverModel(BASE_URL, API_KEY);
  } catch (e: any) {
    record("model server reachable", false, e.message ?? String(e));
    return;
  }
  record("model server reachable", true, `model=${model}`);

  // Sanity guard: refuse to run the recall test if the server's context is
  // smaller than 8192. Otherwise the "ample budget" arm gets silently
  // truncated and we mistake a config bug for a model failure (v1 finding).
  const caps = await probeServerCapabilities(BASE_URL);
  if (caps) {
    record(
      "server's loaded context is large enough for ample-budget arm",
      caps.contextLimit >= 8192,
      `server contextLimit=${caps.contextLimit}`,
    );
    if (caps.contextLimit < 8192) {
      console.log("  (capability-cost section will be skipped to avoid a misleading result)\n");
      return;
    }
  } else {
    console.log("  (server caps probe unavailable; assuming context is sufficient)");
  }

  const client = new OpenAICompatClient({ baseURL: BASE_URL, apiKey: API_KEY, model });

  // Integration 1: long conversation stays under configured budget.
  header("integration: long conversation respects budget");
  {
    const budget = 600;
    const ctx = new Context({ systemPrompt: "Reply in one short sentence.", budget });
    const assistant = new Assistant(ctx, client);

    const turns = [
      "Hi.",
      "What's two plus two?",
      "Tell me a fact about the ocean.",
      "Recommend a fruit.",
      "Pick a color.",
      "Pick another color.",
      "Say goodbye.",
    ];
    let anyTrimmed = false;
    let maxPromptTokens = 0;
    for (const t of turns) {
      const r = await assistant.chat(t, { maxTokens: 50 });
      if (r.trimmed) anyTrimmed = true;
      maxPromptTokens = Math.max(maxPromptTokens, r.promptTokens);
    }

    record(
      "context activated trimming during long conversation",
      anyTrimmed,
      `budget=${budget} max_prompt_tokens=${maxPromptTokens}`,
    );
    record(
      "actual prompt_tokens never exceeded budget",
      maxPromptTokens <= budget,
      `max_observed=${maxPromptTokens} budget=${budget}`,
    );
  }

  // Integration 2: capability cost — old facts age out.
  // First half: small budget, fact stated early should be lost.
  // Second half: ample budget, same fact should be remembered.
  header("capability cost: facts age out under tight budget");

  const fact = "My favorite obscure word is 'petrichor'.";
  // Neutral distractors that don't generate fact-shaped content competing with the fact under test.
  const distractors = [
    "Tell me a short joke.",
    "Suggest a name for a pet hamster.",
    "Make up a haiku about wind.",
    "What's a creative way to greet a friend?",
    "Pick a color and describe it in five words.",
    "Recommend a fun weekend activity.",
    "Suggest a dish to cook tonight.",
    "Describe your ideal afternoon in one sentence.",
  ];

  async function runWithBudget(budget: number): Promise<{ trimmed: boolean; remembered: boolean; admitsUncertainty: boolean; reply: string }> {
    const ctx = new Context({ systemPrompt: RECALL_SYSTEM, budget });
    const a = new Assistant(ctx, client);
    await a.chat(fact, { maxTokens: 30 });
    let trimmed = false;
    for (const d of distractors) {
      const r = await a.chat(d, { maxTokens: 60 });
      if (r.trimmed) trimmed = true;
    }
    // No escape hatch in the question — force the model to commit or refuse.
    const final = await a.chat(
      "Earlier in this conversation, I told you what my favorite obscure word was. What was that word?",
      { maxTokens: 30 },
    );
    const admitsUncertainty =
      /(don't|do not|cannot|can't|haven't|have not|didn't|did not)\s+(know|remember|recall|told|tell|mention)|not sure|unsure|no idea|don't have (that|the) (info|information)/i.test(
        final.reply,
      );
    return {
      trimmed,
      remembered: /petrichor/i.test(final.reply),
      admitsUncertainty,
      reply: final.reply,
    };
  }

  const tight = await runWithBudget(400);
  console.log(`  tight (budget=400): trimmed=${tight.trimmed} reply=${JSON.stringify(tight.reply.slice(0, 100))}`);
  const ample = await runWithBudget(8192);
  console.log(`  ample (budget=8192): trimmed=${ample.trimmed} reply=${JSON.stringify(ample.reply.slice(0, 100))}`);

  record("tight budget caused trimming", tight.trimmed, "early fact should now be dropped");
  record("ample budget did not cause trimming", !ample.trimmed);
  record(
    "the cost of trimming is real (early fact forgotten under tight budget)",
    !tight.remembered,
    tight.remembered ? "model recalled despite trim — fact may have survived in window" : "fact correctly aged out",
  );
  record(
    "with ample budget the fact is recalled",
    ample.remembered,
    ample.remembered ? "remembered" : `model said: ${ample.reply.slice(0, 60)}`,
  );

  // Anti-confabulation: when the fact is gone from window, model should admit
  // it doesn't know rather than invent a plausible-sounding wrong answer.
  // This is the v1 fix being verified — strengthened system prompt should
  // induce graceful "I don't remember" rather than confident hallucination.
  record(
    "model admits uncertainty under context loss (vs. confabulating)",
    tight.admitsUncertainty,
    tight.admitsUncertainty
      ? `reply: ${tight.reply.slice(0, 80)}`
      : `did NOT admit uncertainty — likely confabulated. reply: ${tight.reply.slice(0, 80)}`,
  );
}

function summarize() {
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  console.log("\n" + "═".repeat(50));
  console.log(`${passed}/${total} checks passed`);
  if (passed < total) {
    console.log("failures:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ✗ ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

async function main() {
  console.log("v1 eval — context management");
  console.log("═".repeat(50));

  unitChecks();
  await integrationChecks();
  summarize();
}

main().catch((e) => {
  console.error("\nunexpected error:", e);
  process.exit(2);
});
