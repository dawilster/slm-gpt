/**
 * v0 eval — verify the bare chat loop's contract with the model endpoint.
 *
 * v0 has no novel behavior of its own; what we test here is the *substrate*
 * everything else builds on:
 *   1. the model server is reachable and a chat model is loaded
 *   2. round-trip latency and tokens-per-second baseline
 *   3. the statelessness lesson: separate conversations have no memory
 *   4. the in-context memory: same conversation does remember
 *   5. prompt_tokens grows turn-by-turn (the v0 token-cost lesson, empirical)
 *
 * Run with:  bun run eval/v0.ts
 * Exit code: 0 if all pass, 1 otherwise.
 */

import OpenAI from "openai";

const BASE_URL = process.env.MODEL_BASE_URL ?? "http://localhost:1234/v1";
const SHORT_TIMEOUT_MS = 30_000;

const client = new OpenAI({
  baseURL: BASE_URL,
  apiKey: process.env.MODEL_API_KEY ?? "lm-studio",
  timeout: SHORT_TIMEOUT_MS,
});

type Msg = { role: "system" | "user" | "assistant"; content: string };

type CheckResult = { name: string; passed: boolean; detail?: string };
const results: CheckResult[] = [];

function record(name: string, passed: boolean, detail?: string) {
  results.push({ name, passed, detail });
  const mark = passed ? "✓" : "✗";
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function chat(model: string, messages: Msg[]) {
  const t0 = Date.now();
  const resp = await client.chat.completions.create({
    model,
    messages,
    temperature: 0.0, // deterministic for eval stability
  });
  const elapsedMs = Date.now() - t0;
  const reply = resp.choices[0]?.message.content ?? "";
  const usage = resp.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return { reply, usage, elapsedMs };
}

function header(title: string) {
  console.log(`\n§ ${title}`);
}

async function main() {
  console.log(`v0 eval — ${BASE_URL}`);
  console.log("═".repeat(50));

  // ─── 1. health check ─────────────────────────────────────────────
  header("health check");
  let model: string;
  try {
    const list = await client.models.list();
    const chatModel = list.data.find((m) => !m.id.toLowerCase().includes("embed"));
    if (!chatModel) throw new Error("no chat model loaded");
    model = chatModel.id;
    record("server reachable", true);
    record("chat model loaded", true, model);
  } catch (e: any) {
    record("server reachable", false, e.message ?? String(e));
    return summarize();
  }

  // ─── 2. latency baseline ─────────────────────────────────────────
  header("latency baseline (3 short prompts, fresh convo each)");
  const latencies: number[] = [];
  const tokRates: number[] = [];
  for (let i = 1; i <= 3; i++) {
    try {
      const { usage, elapsedMs } = await chat(model, [
        { role: "user", content: "Reply with exactly one short sentence." },
      ]);
      latencies.push(elapsedMs);
      const tps = (usage.completion_tokens / elapsedMs) * 1000;
      tokRates.push(tps);
      console.log(
        `  turn ${i}: ${elapsedMs} ms  (gen ${usage.completion_tokens} tok, ${tps.toFixed(1)} tok/s)`,
      );
    } catch (e: any) {
      record(`latency turn ${i}`, false, e.message ?? String(e));
      return summarize();
    }
  }
  const median = [...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)]!;
  const avgTps = tokRates.reduce((a, b) => a + b, 0) / tokRates.length;
  record("latency baseline collected", true, `median=${median} ms, avg=${avgTps.toFixed(1)} tok/s`);

  // ─── 3. statelessness across separate conversations ──────────────
  header("statelessness (negative test — separate conversations)");
  await chat(model, [{ role: "user", content: "My name is William. Remember it." }]);
  const fresh = await chat(model, [{ role: "user", content: "What is my name? Answer in one word, or say 'unknown'." }]);
  console.log(`  reply: ${JSON.stringify(fresh.reply.slice(0, 120))}`);
  const remembered = /\bwilliam\b/i.test(fresh.reply);
  record(
    "no memory across separate conversations",
    !remembered,
    remembered ? "model leaked state somehow" : "model correctly has no cross-conversation memory",
  );

  // ─── 4. in-context memory within one conversation ────────────────
  header("in-context memory (positive test — same conversation)");
  const convo: Msg[] = [
    { role: "user", content: "My name is William." },
  ];
  let r = await chat(model, convo);
  convo.push({ role: "assistant", content: r.reply });
  convo.push({ role: "user", content: "I am a software engineer." });
  r = await chat(model, convo);
  convo.push({ role: "assistant", content: r.reply });
  convo.push({ role: "user", content: "What is my name? Answer in one word." });
  r = await chat(model, convo);
  console.log(`  reply: ${JSON.stringify(r.reply.slice(0, 120))}`);
  const recalled = /\bwilliam\b/i.test(r.reply);
  record("recalls earlier turn within one conversation", recalled);

  // ─── 5. prompt_tokens grows turn-by-turn ─────────────────────────
  header("token growth across turns (v0 lesson, empirical)");
  const growthConvo: Msg[] = [];
  const promptTokens: number[] = [];
  const turns = ["Hi.", "How are you?", "What's the weather like in your imagination?", "Thanks."];
  for (const text of turns) {
    growthConvo.push({ role: "user", content: text });
    const { reply, usage } = await chat(model, growthConvo);
    growthConvo.push({ role: "assistant", content: reply });
    promptTokens.push(usage.prompt_tokens);
    console.log(`  turn ${promptTokens.length}: prompt_tokens=${usage.prompt_tokens}`);
  }
  let monotonic = true;
  for (let i = 1; i < promptTokens.length; i++) {
    if (promptTokens[i]! <= promptTokens[i - 1]!) {
      monotonic = false;
      break;
    }
  }
  record(
    "prompt_tokens grows monotonically",
    monotonic,
    `${promptTokens.join(" → ")}`,
  );

  summarize();
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

main().catch((e) => {
  console.error("\nunexpected error:", e);
  process.exit(2);
});
