/**
 * perf_kv — measure the cost of conversation length, with and without
 * KV-cache optimization (LM Studio toggle).
 *
 * Why: design.md cites "Practical ceiling ~4K–8K tokens (KV cache eats
 * RAM at long context)" as a hardware-imposed constraint. KV-cache
 * quantization should push that ceiling out by storing K/V tensors in
 * fewer bits — at some cost in throughput and (in theory) quality.
 *
 * What it measures, per requested context size:
 *   - actual prompt_tokens (from server) vs. requested
 *   - TTFT (ms to first streamed token) — proxy for prompt-eval cost
 *   - steady-state tok/s during generation
 *   - total request latency
 *   - system "memory used" delta (top PhysMem) before vs. after
 *   - needle-in-haystack correctness: a marker placed near the start
 *     of the prompt; the model must echo it back. Catches quality
 *     regressions introduced by aggressive KV quantization.
 *
 * Memory caveats: on Apple silicon with MLX, the model + KV cache live
 * in unified memory via Metal allocations. Process RSS (ps) often
 * undercounts these; `top`'s PhysMem total is the more honest signal.
 * Both are recorded.
 *
 * Usage:
 *   bun run eval/perf_kv.ts --label baseline      # KV cache opt OFF
 *   bun run eval/perf_kv.ts --label optimized     # KV cache opt ON
 *
 * Output: eval/runs/perf_kv_<label>_<timestamp>.json + printed summary.
 * If both labels exist on disk, prints a side-by-side delta table.
 */

import OpenAI from "openai";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

const BASE_URL = process.env.MODEL_BASE_URL ?? "http://localhost:1234/v1";
const RUNS_DIR = resolve(import.meta.dir, "runs");

// Target *requested* prompt sizes (we ask the server for ~this much).
// Sized to exercise an 8K-loaded-context model; the runner skips any
// size that wouldn't leave headroom for the reply.
const TARGET_SIZES = [1024, 2048, 4096, 6144, 7500];

// Approx characters per token for English filler (Qwen tokenizer ≈ 3.8).
const CHARS_PER_TOK = 3.8;

const NEEDLE_PHRASE = "BANANA-CARNIVAL-9417";

const argv = process.argv.slice(2);
const labelIdx = argv.indexOf("--label");
const label = labelIdx >= 0 ? argv[labelIdx + 1] : "unlabeled";
if (!label || label.startsWith("--")) {
  console.error("usage: bun run eval/perf_kv.ts --label <baseline|optimized|...>");
  process.exit(2);
}

const client = new OpenAI({
  baseURL: BASE_URL,
  apiKey: process.env.MODEL_API_KEY ?? "lm-studio",
});

type SizeResult = {
  requestedTokens: number;
  promptTokens: number;
  completionTokens: number;
  ttftMs: number | null;
  totalMs: number;
  genTokPerSec: number;
  needleRecalled: boolean;
  reply: string;
  /** Just the question portion of the prompt — filler is omitted since it's repetitive. */
  question: string;
  preamble: string;
  memBeforeMB: number | null;
  memAfterMB: number | null;
  memDeltaMB: number | null;
  workerRssBeforeMB: number | null;
  workerRssAfterMB: number | null;
  error?: string;
};

type RunRecord = {
  label: string;
  timestamp: string;
  baseURL: string;
  modelId: string;
  loadedContextLength: number | null;
  results: SizeResult[];
};

async function probeServer() {
  const root = BASE_URL.replace(/\/v1\/?$/, "");
  const resp = await fetch(`${root}/api/v0/models`);
  if (!resp.ok) throw new Error(`probe failed: ${resp.status}`);
  const data = (await resp.json()) as {
    data: Array<{
      id: string;
      type?: string;
      state?: string;
      loaded_context_length?: number;
    }>;
  };
  const loaded = data.data.find((m) => m.state === "loaded" && m.type !== "embeddings");
  if (!loaded) throw new Error("no chat model loaded");
  return { modelId: loaded.id, loadedContextLength: loaded.loaded_context_length ?? null };
}

async function sampleSystemMemMB(): Promise<number | null> {
  // Parses `top -l 1 -n 0` PhysMem line. On macOS this looks like:
  //   "PhysMem: 7619M used (1234M wired, 567M compressor), 384M unused."
  try {
    const proc = Bun.spawn(["top", "-l", "1", "-n", "0"], { stdout: "pipe" });
    const txt = await new Response(proc.stdout).text();
    await proc.exited;
    const line = txt.split("\n").find((l) => l.startsWith("PhysMem:"));
    if (!line) return null;
    const m = line.match(/PhysMem:\s*(\d+(?:\.\d+)?)([MG])\s+used/);
    if (!m) return null;
    const n = Number(m[1]);
    return m[2] === "G" ? n * 1024 : n;
  } catch {
    return null;
  }
}

async function findInferenceWorkerPid(): Promise<number | null> {
  try {
    const proc = Bun.spawn(["pgrep", "-f", "llmworker.js"], { stdout: "pipe" });
    const txt = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    if (!txt) return null;
    // pgrep can return multiple; take the largest pid (most recently spawned)
    const pids = txt.split("\n").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    return pids.length ? Math.max(...pids) : null;
  } catch {
    return null;
  }
}

async function sampleProcessRssMB(pid: number | null): Promise<number | null> {
  if (pid == null) return null;
  try {
    const proc = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], { stdout: "pipe" });
    const txt = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    const kb = Number(txt);
    return Number.isFinite(kb) ? kb / 1024 : null;
  } catch {
    return null;
  }
}

function buildFiller(targetTokens: number, reservedForOverhead: number): string {
  // Reserve ~`reservedForOverhead` tokens for the system framing + needle + question.
  const fillerTok = Math.max(0, targetTokens - reservedForOverhead);
  const targetChars = Math.floor(fillerTok * CHARS_PER_TOK);
  const line = "This is filler line {n}; ignore it. The cat sat quietly on the mat.\n";
  const out: string[] = [];
  let chars = 0;
  let n = 1;
  while (chars < targetChars) {
    const s = line.replace("{n}", String(n++));
    out.push(s);
    chars += s.length;
  }
  return out.join("");
}

async function runOneSize(
  modelId: string,
  requestedTokens: number,
  workerPid: number | null,
): Promise<SizeResult> {
  // Frame: needle goes EARLY in the prompt, filler in the middle, question at end.
  // The early-position placement is the harder needle-in-haystack variant — it
  // tests whether the long context degrades recall of distant tokens.
  const preamble =
    `IMPORTANT BACKGROUND FACT: The codeword for today is "${NEEDLE_PHRASE}". ` +
    `Remember this exact codeword. ` +
    `What follows is unrelated filler context.\n\n`;
  const question =
    `\n\nEnd of filler. Question: what was the exact codeword given at the very ` +
    `beginning of this message? Reply with just the codeword and nothing else.`;

  const overheadTok = Math.ceil((preamble.length + question.length) / CHARS_PER_TOK) + 50; // sysprompt slack
  const filler = buildFiller(requestedTokens, overheadTok);
  const userContent = preamble + filler + question;

  const memBefore = await sampleSystemMemMB();
  const rssBefore = await sampleProcessRssMB(workerPid);

  const t0 = Date.now();
  let ttft: number | null = null;
  let firstTokenSeen = false;
  let reply = "";
  let usage: { prompt_tokens?: number; completion_tokens?: number } = {};

  try {
    const stream = await client.chat.completions.create({
      model: modelId,
      messages: [
        { role: "system", content: "You are a precise assistant. Answer exactly as instructed." },
        { role: "user", content: userContent },
      ],
      temperature: 0,
      max_tokens: 64,
      stream: true,
      stream_options: { include_usage: true },
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta && !firstTokenSeen) {
        ttft = Date.now() - t0;
        firstTokenSeen = true;
      }
      if (delta) reply += delta;
      if (chunk.usage) usage = chunk.usage;
    }
  } catch (e: any) {
    const totalMs = Date.now() - t0;
    return {
      requestedTokens,
      promptTokens: 0,
      completionTokens: 0,
      ttftMs: ttft,
      totalMs,
      genTokPerSec: 0,
      needleRecalled: false,
      reply: "",
      question,
      preamble,
      memBeforeMB: memBefore,
      memAfterMB: null,
      memDeltaMB: null,
      workerRssBeforeMB: rssBefore,
      workerRssAfterMB: null,
      error: e?.message ?? String(e),
    };
  }

  const totalMs = Date.now() - t0;
  // give the runtime a beat to settle Metal allocations before sampling
  await Bun.sleep(750);
  const memAfter = await sampleSystemMemMB();
  const rssAfter = await sampleProcessRssMB(workerPid);

  const completionTokens = usage.completion_tokens ?? 0;
  const promptTokens = usage.prompt_tokens ?? 0;
  const genMs = ttft != null ? Math.max(1, totalMs - ttft) : totalMs;
  const genTokPerSec = (completionTokens / genMs) * 1000;
  const needleRecalled = reply.toUpperCase().includes(NEEDLE_PHRASE);

  return {
    requestedTokens,
    promptTokens,
    completionTokens,
    ttftMs: ttft,
    totalMs,
    genTokPerSec,
    needleRecalled,
    reply: reply.trim(),
    question,
    preamble,
    memBeforeMB: memBefore,
    memAfterMB: memAfter,
    memDeltaMB: memBefore != null && memAfter != null ? memAfter - memBefore : null,
    workerRssBeforeMB: rssBefore,
    workerRssAfterMB: rssAfter,
  };
}

function renderResponsesMarkdown(rec: RunRecord): string {
  const lines: string[] = [];
  lines.push(`# perf_kv responses — label: ${rec.label}`);
  lines.push(``);
  lines.push(`- model: \`${rec.modelId}\``);
  lines.push(`- loaded context: ${rec.loadedContextLength}`);
  lines.push(`- timestamp: ${rec.timestamp}`);
  lines.push(`- needle: \`${NEEDLE_PHRASE}\``);
  lines.push(``);
  lines.push(`Each request placed the needle near the start of the prompt, followed by`);
  lines.push(`filler, then the question. Filler is omitted from this file (it's repetitive`);
  lines.push(`"this is filler line N" lines); see the JSON sidecar for raw metrics.`);
  lines.push(``);
  for (const r of rec.results) {
    lines.push(`---`);
    lines.push(``);
    lines.push(`## requested ${r.requestedTokens} tokens (actual prompt_tokens=${r.promptTokens})`);
    lines.push(``);
    lines.push(`- ttft: ${r.ttftMs ?? "—"} ms`);
    lines.push(`- total: ${r.totalMs} ms`);
    lines.push(`- gen tok/s: ${r.genTokPerSec.toFixed(1)}`);
    lines.push(`- completion tokens: ${r.completionTokens}`);
    lines.push(`- needle recalled: ${r.needleRecalled ? "✓" : "✗"}`);
    if (r.error) lines.push(`- **error:** ${r.error}`);
    lines.push(``);
    lines.push(`**preamble (sent first):**`);
    lines.push(``);
    lines.push("```");
    lines.push(r.preamble.trim());
    lines.push("```");
    lines.push(``);
    lines.push(`**question (sent last):**`);
    lines.push(``);
    lines.push("```");
    lines.push(r.question.trim());
    lines.push("```");
    lines.push(``);
    lines.push(`**model reply:**`);
    lines.push(``);
    lines.push("```");
    lines.push(r.reply || "(empty)");
    lines.push("```");
    lines.push(``);
  }
  return lines.join("\n");
}

function fmt(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function printRunTable(rec: RunRecord) {
  console.log(
    "\n  req     actual  ttft     total   tok/s   needle  sys-mem Δ  worker-rss Δ",
  );
  console.log("  ------- ------- -------- ------- ------- ------- ---------- -------------");
  for (const r of rec.results) {
    const rssDelta =
      r.workerRssBeforeMB != null && r.workerRssAfterMB != null
        ? r.workerRssAfterMB - r.workerRssBeforeMB
        : null;
    console.log(
      `  ${String(r.requestedTokens).padEnd(7)} ` +
        `${String(r.promptTokens).padEnd(7)} ` +
        `${(r.ttftMs == null ? "—" : `${fmt(r.ttftMs)}ms`).padEnd(8)} ` +
        `${`${fmt(r.totalMs)}ms`.padEnd(7)} ` +
        `${fmt(r.genTokPerSec, 1).padEnd(7)} ` +
        `${(r.needleRecalled ? "✓" : "✗").padEnd(7)} ` +
        `${(r.memDeltaMB != null ? `${r.memDeltaMB >= 0 ? "+" : ""}${fmt(r.memDeltaMB)}MB` : "—").padEnd(10)} ` +
        `${rssDelta != null ? `${rssDelta >= 0 ? "+" : ""}${fmt(rssDelta)}MB` : "—"}` +
        (r.error ? `  err: ${r.error}` : ""),
    );
  }
}

async function maybePrintComparison(currentLabel: string) {
  if (!existsSync(RUNS_DIR)) return;
  const files = (await readdir(RUNS_DIR)).filter((f) => f.startsWith("perf_kv_") && f.endsWith(".json"));
  // Find newest file per label.
  const byLabel = new Map<string, { file: string; rec: RunRecord }>();
  for (const f of files) {
    const m = f.match(/^perf_kv_(.+?)_\d{8}T\d{6}\.json$/);
    if (!m) continue;
    const lbl = m[1]!;
    const rec = JSON.parse(await readFile(resolve(RUNS_DIR, f), "utf8")) as RunRecord;
    const existing = byLabel.get(lbl);
    if (!existing || rec.timestamp > existing.rec.timestamp) byLabel.set(lbl, { file: f, rec });
  }
  if (byLabel.size < 2) return;
  // Pick "baseline" + currentLabel if both exist, else first two distinct.
  const otherLabel = [...byLabel.keys()].find((l) => l !== currentLabel);
  if (!otherLabel) return;
  const a = byLabel.get(otherLabel)!.rec;
  const b = byLabel.get(currentLabel)!.rec;

  console.log(`\n═══ comparison: ${otherLabel}  →  ${currentLabel} ═══`);
  console.log(`  (${otherLabel}: ${a.timestamp})`);
  console.log(`  (${currentLabel}: ${b.timestamp})`);
  console.log(
    `\n  req      ttft Δ%      tok/s Δ%     totalMs Δ%   sys-mem Δ% (after-before)   needle ${otherLabel}/${currentLabel}`,
  );
  console.log(
    "  -------  -----------  -----------  -----------  -----------------------------  -------",
  );
  const bByReq = new Map(b.results.map((r) => [r.requestedTokens, r]));
  for (const ar of a.results) {
    const br = bByReq.get(ar.requestedTokens);
    if (!br) continue;
    const dPct = (x: number | null | undefined, y: number | null | undefined) =>
      x != null && y != null && x > 0 ? `${(((y - x) / x) * 100).toFixed(1)}%` : "—";
    console.log(
      `  ${String(ar.requestedTokens).padEnd(7)}  ` +
        `${dPct(ar.ttftMs, br.ttftMs).padEnd(11)}  ` +
        `${dPct(ar.genTokPerSec, br.genTokPerSec).padEnd(11)}  ` +
        `${dPct(ar.totalMs, br.totalMs).padEnd(11)}  ` +
        `${(`${fmt(ar.memDeltaMB)}MB → ${fmt(br.memDeltaMB)}MB`).padEnd(29)}  ` +
        `${ar.needleRecalled ? "✓" : "✗"}/${br.needleRecalled ? "✓" : "✗"}`,
    );
  }
}

async function main() {
  console.log(`perf_kv eval — label="${label}"  (${BASE_URL})`);
  console.log("═".repeat(60));

  const { modelId, loadedContextLength } = await probeServer();
  console.log(`model: ${modelId}`);
  console.log(`loaded context length: ${loadedContextLength}`);

  // Filter requested sizes to what the loaded context will accept (need
  // ~200 tokens of headroom for system prompt + completion).
  const usableSizes = TARGET_SIZES.filter(
    (s) => loadedContextLength == null || s + 200 <= loadedContextLength,
  );
  if (usableSizes.length < TARGET_SIZES.length) {
    console.log(
      `  (skipping ${TARGET_SIZES.filter((s) => !usableSizes.includes(s)).join(", ")} — exceeds loaded context)`,
    );
  }

  const workerPid = await findInferenceWorkerPid();
  console.log(`inference worker pid: ${workerPid ?? "(not found — RSS samples will be null)"}`);

  // Warm-up: tiny call so the model is paged in and Metal kernels primed.
  console.log("\nwarming up...");
  await client.chat.completions.create({
    model: modelId,
    messages: [{ role: "user", content: "Reply with 'ok'." }],
    temperature: 0,
    max_tokens: 4,
  });

  const results: SizeResult[] = [];
  for (const size of usableSizes) {
    process.stdout.write(`\n  size=${size}... `);
    const r = await runOneSize(modelId, size, workerPid);
    results.push(r);
    process.stdout.write(
      `prompt=${r.promptTokens}  ttft=${r.ttftMs ?? "—"}ms  ` +
        `total=${r.totalMs}ms  needle=${r.needleRecalled ? "✓" : "✗"}\n`,
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
  const outPath = resolve(RUNS_DIR, `perf_kv_${label}_${rec.timestamp}.json`);
  await writeFile(outPath, JSON.stringify(rec, null, 2));
  console.log(`\nsaved: ${outPath}`);

  const mdPath = resolve(RUNS_DIR, `perf_kv_${label}_${rec.timestamp}.responses.md`);
  await writeFile(mdPath, renderResponsesMarkdown(rec));
  console.log(`saved: ${mdPath}`);

  printRunTable(rec);
  await maybePrintComparison(label);
}

main().catch((e) => {
  console.error("\nunexpected error:", e);
  process.exit(1);
});
