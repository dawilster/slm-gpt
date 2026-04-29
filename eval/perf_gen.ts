/**
 * perf_gen — long-form generation eval.
 *
 * Question: how much coherent text can the local model produce in one
 * shot before stopping (naturally, or by hitting the context ceiling),
 * and does throughput hold up as the KV cache fills during generation?
 *
 * Design: small prompt + huge max_tokens budget. The model is asked to
 * write a long short story. We stream the output and time it in
 * 500-token windows, so we can see whether tok/s decays as the KV
 * cache grows turn by turn (each generated token gets appended).
 *
 * Per prompt we record:
 *   - prompt_tokens, completion_tokens, finish_reason
 *   - total ms, TTFT, overall tok/s
 *   - tok/s per 500-token window (decay curve)
 *   - approx word count, paragraph count
 *   - the full story text, written to a sidecar file for inspection
 *
 * Usage:
 *   bun run eval/perf_gen.ts                  # run all prompts
 *   bun run eval/perf_gen.ts --label foo      # custom label in output filenames
 */

import OpenAI from "openai";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const BASE_URL = process.env.MODEL_BASE_URL ?? "http://localhost:1234/v1";
const RUNS_DIR = resolve(import.meta.dir, "runs");

const argv = process.argv.slice(2);
const labelIdx = argv.indexOf("--label");
const label = labelIdx >= 0 ? argv[labelIdx + 1]! : "default";

const client = new OpenAI({ baseURL: BASE_URL, apiKey: process.env.MODEL_API_KEY ?? "lm-studio" });

// A small variety. Different genres/structures stress different parts
// of long-form coherence (plot tracking vs. dialogue vs. description).
const PROMPTS = [
  {
    id: "lighthouse",
    title: "the lighthouse keeper",
    user:
      "Write a long, vivid short story about a lighthouse keeper who discovers a message in a bottle " +
      "containing a chart to an underwater city. Include rich descriptions, internal monologue, " +
      "dialogue with at least one other character, and a clear beginning, middle, and end. " +
      "Aim for roughly 3000–4000 words. Take your time and write the full story now.",
  },
  {
    id: "robot_chef",
    title: "the robot chef",
    user:
      "Write a long, detailed short story about a worn-out kitchen robot in a 24-hour diner who " +
      "decides to enter a high-stakes televised cooking competition. Include the diner's regulars, " +
      "the robot's training montage, the contest itself, and the aftermath. Use dialogue. " +
      "Aim for roughly 3000–4000 words. Begin the story now.",
  },
  {
    id: "tide_clock",
    title: "the tide clock",
    user:
      "Write a long, atmospheric short story about a young woman in a coastal village who inherits a " +
      "strange clock from her grandmother. The clock's hands move with the tides, not with time. " +
      "Develop the setting, the family history, and what she discovers. " +
      "Aim for 3000–4000 words. Write the entire story start to finish.",
  },
];

// Window size for throughput-decay measurement.
const WINDOW_TOKENS = 500;

type WindowSample = { window: number; tokensInWindow: number; ms: number; tokPerSec: number };

type GenResult = {
  id: string;
  title: string;
  promptTokens: number;
  completionTokens: number;
  finishReason: string | null;
  ttftMs: number | null;
  totalMs: number;
  overallTokPerSec: number;
  wordCount: number;
  paragraphCount: number;
  hitContextCeiling: boolean;
  windows: WindowSample[];
  story: string;
  error?: string;
};

type RunRecord = {
  label: string;
  timestamp: string;
  baseURL: string;
  modelId: string;
  loadedContextLength: number | null;
  results: GenResult[];
};

async function probeServer() {
  const root = BASE_URL.replace(/\/v1\/?$/, "");
  const resp = await fetch(`${root}/api/v0/models`);
  if (!resp.ok) throw new Error(`probe failed: ${resp.status}`);
  const data = (await resp.json()) as {
    data: Array<{ id: string; type?: string; state?: string; loaded_context_length?: number }>;
  };
  const loaded = data.data.find((m) => m.state === "loaded" && m.type !== "embeddings");
  if (!loaded) throw new Error("no chat model loaded");
  return { modelId: loaded.id, loadedContextLength: loaded.loaded_context_length ?? null };
}

async function generateStory(modelId: string, prompt: typeof PROMPTS[number], maxTokens: number): Promise<GenResult> {
  const t0 = Date.now();
  let ttft: number | null = null;
  let firstTokenSeen = false;
  let story = "";

  // Window timing: tokens are not delivered one-per-chunk — they come in
  // small bursts. We approximate by counting characters delivered and
  // re-checking against `usage.completion_tokens` at the end. For
  // intra-stream throughput we time chunks and use a rolling
  // chars-per-token ratio derived from final usage.
  const chunkTimes: { atMs: number; chars: number }[] = [];
  let totalChars = 0;

  let usage: { prompt_tokens?: number; completion_tokens?: number } = {};
  let finishReason: string | null = null;

  try {
    const stream = await client.chat.completions.create({
      model: modelId,
      messages: [
        {
          role: "system",
          content:
            "You are a creative short-story writer. When asked to write a long story, you write a full, " +
            "complete, well-paced story. You do NOT stop early. You do NOT give a summary or outline.",
        },
        { role: "user", content: prompt.user },
      ],
      temperature: 0.8,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta && !firstTokenSeen) {
        ttft = Date.now() - t0;
        firstTokenSeen = true;
      }
      if (delta) {
        story += delta;
        totalChars += delta.length;
        chunkTimes.push({ atMs: Date.now() - t0, chars: totalChars });
      }
      const fr = chunk.choices[0]?.finish_reason;
      if (fr) finishReason = fr;
      if (chunk.usage) usage = chunk.usage;
    }
  } catch (e: any) {
    return {
      id: prompt.id,
      title: prompt.title,
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      finishReason,
      ttftMs: ttft,
      totalMs: Date.now() - t0,
      overallTokPerSec: 0,
      wordCount: story.trim().split(/\s+/).filter(Boolean).length,
      paragraphCount: story.split(/\n\s*\n/).filter((p) => p.trim()).length,
      hitContextCeiling: false,
      windows: [],
      story,
      error: e?.message ?? String(e),
    };
  }

  const totalMs = Date.now() - t0;
  const completionTokens = usage.completion_tokens ?? 0;
  const promptTokens = usage.prompt_tokens ?? 0;
  const overallTokPerSec = (completionTokens / totalMs) * 1000;

  // Build windows by mapping char positions back to approximate token positions.
  const charsPerToken = completionTokens > 0 ? totalChars / completionTokens : 4;
  const windows: WindowSample[] = [];
  let nextWindow = 1;
  let prevWindowEndMs = ttft ?? 0;
  let prevWindowEndTokens = 0;
  for (const { atMs, chars } of chunkTimes) {
    const tokensSoFar = chars / charsPerToken;
    while (tokensSoFar >= nextWindow * WINDOW_TOKENS) {
      const windowMs = atMs - prevWindowEndMs;
      const tokensInWindow = nextWindow * WINDOW_TOKENS - prevWindowEndTokens;
      windows.push({
        window: nextWindow,
        tokensInWindow,
        ms: windowMs,
        tokPerSec: windowMs > 0 ? (tokensInWindow / windowMs) * 1000 : 0,
      });
      prevWindowEndMs = atMs;
      prevWindowEndTokens = nextWindow * WINDOW_TOKENS;
      nextWindow++;
    }
  }

  const wordCount = story.trim().split(/\s+/).filter(Boolean).length;
  const paragraphCount = story.split(/\n\s*\n/).filter((p) => p.trim()).length;
  // "length" finish reason from the API means we hit max_tokens — which is
  // effectively the context ceiling here, since max_tokens was set to the budget.
  const hitContextCeiling = finishReason === "length";

  return {
    id: prompt.id,
    title: prompt.title,
    promptTokens,
    completionTokens,
    finishReason,
    ttftMs: ttft,
    totalMs,
    overallTokPerSec,
    wordCount,
    paragraphCount,
    hitContextCeiling,
    windows,
    story,
  };
}

function fmt(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function renderStoriesMarkdown(rec: RunRecord): string {
  const lines: string[] = [];
  lines.push(`# perf_gen — generated stories (${rec.label})`);
  lines.push(``);
  lines.push(`- model: \`${rec.modelId}\``);
  lines.push(`- loaded context: ${rec.loadedContextLength}`);
  lines.push(`- timestamp: ${rec.timestamp}`);
  lines.push(``);
  for (const r of rec.results) {
    lines.push(`---`);
    lines.push(``);
    lines.push(`## ${r.title}`);
    lines.push(``);
    lines.push(
      `> ${r.completionTokens} tokens · ${r.wordCount} words · ${r.paragraphCount} paragraphs · ` +
        `${(r.totalMs / 1000).toFixed(1)}s · ${r.overallTokPerSec.toFixed(1)} tok/s · ` +
        `finish=${r.finishReason ?? "—"}${r.hitContextCeiling ? " (hit ceiling)" : ""}`,
    );
    if (r.error) {
      lines.push(``);
      lines.push(`> **error:** ${r.error}`);
    }
    lines.push(``);
    lines.push(r.story.trim() || "(empty)");
    lines.push(``);
  }
  return lines.join("\n");
}

async function main() {
  console.log(`perf_gen eval — label="${label}"  (${BASE_URL})`);
  console.log("═".repeat(60));

  const { modelId, loadedContextLength } = await probeServer();
  console.log(`model: ${modelId}`);
  console.log(`loaded context length: ${loadedContextLength}`);

  // Reserve ~250 tokens for the prompt; spend the rest on output.
  const maxTokens = loadedContextLength != null ? Math.max(512, loadedContextLength - 300) : 3500;
  console.log(`max_tokens budget per generation: ${maxTokens}`);

  // Warm-up.
  console.log("\nwarming up...");
  await client.chat.completions.create({
    model: modelId,
    messages: [{ role: "user", content: "Reply with 'ok'." }],
    temperature: 0,
    max_tokens: 4,
  });

  const results: GenResult[] = [];
  for (const p of PROMPTS) {
    process.stdout.write(`\n  generating "${p.title}"... `);
    const r = await generateStory(modelId, p, maxTokens);
    results.push(r);
    process.stdout.write(
      `${r.completionTokens} tok / ${r.wordCount} words / ${r.totalMs / 1000}s / ` +
        `${r.overallTokPerSec.toFixed(1)} tok/s / finish=${r.finishReason ?? "—"}` +
        `${r.hitContextCeiling ? " (HIT CEILING)" : ""}\n`,
    );
  }

  const rec: RunRecord = {
    label,
    timestamp: new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, ""),
    baseURL: BASE_URL,
    modelId,
    loadedContextLength,
    results,
  };

  await mkdir(RUNS_DIR, { recursive: true });
  const jsonPath = resolve(RUNS_DIR, `perf_gen_${label}_${rec.timestamp}.json`);
  await writeFile(jsonPath, JSON.stringify(rec, null, 2));
  console.log(`\nsaved: ${jsonPath}`);

  const mdPath = resolve(RUNS_DIR, `perf_gen_${label}_${rec.timestamp}.stories.md`);
  await writeFile(mdPath, renderStoriesMarkdown(rec));
  console.log(`saved: ${mdPath}`);

  // Summary table.
  console.log("\n  title                       tokens  words  finish    tok/s   time");
  console.log("  --------------------------  ------  -----  --------  ------  -------");
  for (const r of rec.results) {
    console.log(
      `  ${r.title.padEnd(26)}  ${String(r.completionTokens).padEnd(6)}  ${String(r.wordCount).padEnd(5)}  ` +
        `${(r.finishReason ?? "—").padEnd(8)}  ${fmt(r.overallTokPerSec, 1).padEnd(6)}  ${(r.totalMs / 1000).toFixed(1)}s` +
        (r.hitContextCeiling ? "  ← ceiling" : "") +
        (r.error ? `  err: ${r.error}` : ""),
    );
  }

  // Throughput-decay table (overall, mean of all prompts).
  console.log("\n  throughput by 500-tok window (mean across prompts)");
  console.log("  window#   mean tok/s");
  const byWin = new Map<number, number[]>();
  for (const r of rec.results) for (const w of r.windows) {
    const arr = byWin.get(w.window) ?? [];
    arr.push(w.tokPerSec);
    byWin.set(w.window, arr);
  }
  for (const [w, vs] of [...byWin.entries()].sort((a, b) => a[0] - b[0])) {
    const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
    console.log(`  ${String(w).padEnd(8)}  ${mean.toFixed(1)}  (n=${vs.length})`);
  }
}

main().catch((e) => {
  console.error("\nunexpected error:", e);
  process.exit(1);
});
