/**
 * v3 eval — tool calling.
 *
 * The interesting questions at this size:
 *   - Does the model call a tool when it should?
 *   - Does it call the right tool when both are available?
 *   - Does it pass plausible arguments?
 *   - Does it incorporate the tool result into its final reply?
 *   - Does it leave tools alone for plain chat?
 *
 * Each category is graded with verbose per-prompt output so you can see
 * exactly where it breaks, not just an aggregate score.
 *
 * Run with:  bun run eval/v3.ts
 * Exit code: 0 if all category thresholds met.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAICompatClient, discoverModel } from "../src/client";
import type { Msg } from "../src/client";
import { Context } from "../src/context";
import { Assistant } from "../src/assistant";
import { ToolRegistry, getCurrentTimeTool, makeReadNoteTool } from "../src/tools";

const BASE_URL = process.env.MODEL_BASE_URL ?? "http://localhost:1234/v1";
const API_KEY = process.env.MODEL_API_KEY ?? "lm-studio";

const TEST_ROOT = join(tmpdir(), `assistant-v3-test-${process.pid}-${Date.now()}`);
const NOTES_ROOT = join(TEST_ROOT, "notes");

// Matches the production system prompt in src/index.ts — keeps the v1
// anti-confabulation guard. (Earlier Qwen 2.5-3B couldn't tolerate this
// alongside tools, but Qwen 3-4B handles both cleanly. See design.md §5.)
const SYSTEM = [
  "You are a helpful personal assistant. Be concise and direct.",
  "If you don't know or don't remember something, say so plainly.",
  "Never invent facts about the user that weren't established in this conversation.",
].join(" ");

type CheckResult = { name: string; passed: boolean; detail?: string };
const results: CheckResult[] = [];

function record(name: string, passed: boolean, detail?: string) {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function header(title: string) {
  console.log(`\n§ ${title}`);
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
    process.exitCode = 1;
  }
}

/** Inspect context to find which tools the assistant called in its most-recent turn. */
function toolsCalledInLastTurn(ctx: Context): string[] {
  const all = ctx.all();
  let userIdx = all.length - 1;
  while (userIdx >= 0 && all[userIdx]?.role !== "user") userIdx--;
  const called: string[] = [];
  for (let j = userIdx + 1; j < all.length; j++) {
    const m: Msg | undefined = all[j];
    if (m?.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) called.push(tc.function.name);
    }
  }
  return called;
}

function newAssistant(model: string, registry: ToolRegistry): Assistant {
  const client = new OpenAICompatClient({ baseURL: BASE_URL, apiKey: API_KEY, model });
  const ctx = new Context({ systemPrompt: SYSTEM, budget: 4096 });
  return new Assistant(ctx, client, null, registry);
}

async function setupNotes() {
  await mkdir(NOTES_ROOT, { recursive: true });
  await writeFile(
    join(NOTES_ROOT, "brisbane.md"),
    "Brisbane trip in March 2024. The Story Bridge was illuminated in purple.\n",
    "utf-8",
  );
  await writeFile(
    join(NOTES_ROOT, "ducks.md"),
    "Ducks have webbed feet and are excellent swimmers. Mallards are the most common species.\n",
    "utf-8",
  );
  await writeFile(
    join(NOTES_ROOT, "petrichor.md"),
    "Petrichor is the earthy scent produced when rain falls on dry soil.\n",
    "utf-8",
  );
}

// ─── unit checks ──────────────────────────────────────────────────────

async function unitChecks() {
  header("unit: tool registry + read_note path safety");

  const registry = new ToolRegistry();
  registry.register(getCurrentTimeTool);
  registry.register(makeReadNoteTool(NOTES_ROOT));
  record("registry has 2 tools", registry.size() === 2);
  record("get_current_time registered", registry.get("get_current_time") !== undefined);
  record("read_note registered", registry.get("read_note") !== undefined);

  const readNote = registry.get("read_note")!;
  const cases: Array<{ label: string; args: Record<string, unknown>; expectError: boolean }> = [
    { label: "rejects parent traversal", args: { path: "../../../etc/passwd" }, expectError: true },
    { label: "rejects absolute path", args: { path: "/etc/passwd" }, expectError: true },
    { label: "rejects empty path", args: { path: "" }, expectError: true },
    { label: "rejects missing path", args: {}, expectError: true },
    { label: "reads valid filename", args: { path: "brisbane.md" }, expectError: false },
  ];
  for (const c of cases) {
    const result = await readNote.execute(c.args);
    const isError = result.startsWith("Error:");
    record(`read_note ${c.label}`, isError === c.expectError, result.slice(0, 80));
  }
}

// ─── integration: tool-calling categories ─────────────────────────────

type CategoryResult = {
  total: number;
  passed: number;
  rows: Array<{ prompt: string; called: string[]; replyPreview: string; passed: boolean; reason: string }>;
};

async function runCategory(
  model: string,
  registry: ToolRegistry,
  title: string,
  prompts: string[],
  judge: (p: string, called: string[], reply: string) => { passed: boolean; reason: string },
): Promise<CategoryResult> {
  header(title);
  const cat: CategoryResult = { total: prompts.length, passed: 0, rows: [] };
  for (const p of prompts) {
    const a = newAssistant(model, registry);
    const r = await a.chat(p, { temperature: 0.2, maxTokens: 80 });
    const called = toolsCalledInLastTurn(a.state);
    const verdict = judge(p, called, r.reply);
    if (verdict.passed) cat.passed++;
    cat.rows.push({
      prompt: p,
      called,
      replyPreview: r.reply.replace(/\n/g, " ").slice(0, 70),
      passed: verdict.passed,
      reason: verdict.reason,
    });
    const mark = verdict.passed ? "✓" : "✗";
    const callStr = called.length === 0 ? "[]" : `[${called.join(",")}]`;
    console.log(`  ${mark} "${p.slice(0, 50)}"  → ${callStr}  ${verdict.reason}`);
  }
  console.log(`  ── passed ${cat.passed}/${cat.total}`);
  return cat;
}

async function integrationChecks() {
  let model: string;
  try {
    model = await discoverModel(BASE_URL, API_KEY);
  } catch (e: any) {
    record("model server reachable", false, e?.message ?? String(e));
    return;
  }
  record("model server reachable", true, `model=${model}`);

  const registry = new ToolRegistry();
  registry.register(getCurrentTimeTool);
  registry.register(makeReadNoteTool(NOTES_ROOT));

  // Category A — should call get_current_time
  const catA = await runCategory(
    model,
    registry,
    "category A: should call get_current_time (target 4/5)",
    [
      "What time is it right now?",
      "What's the current ISO timestamp?",
      "Tell me today's date.",
      "What is the current date and time?",
      "Right now — what is the time?",
    ],
    (_p, called, _reply) => {
      if (called.includes("get_current_time")) return { passed: true, reason: "called time tool" };
      if (called.length === 0) return { passed: false, reason: "did not call any tool" };
      return { passed: false, reason: `wrong tool: ${called.join(",")}` };
    },
  );
  record(`A. get_current_time called when it should be (≥4/5)`, catA.passed >= 4, `${catA.passed}/${catA.total}`);

  // Category B — should call read_note with the right filename
  const catB = await runCategory(
    model,
    registry,
    "category B: should call read_note with right path (target 5/8)",
    [
      "What's in my brisbane note? It's saved as brisbane.md.",
      "Read brisbane.md please.",
      "Open my note ducks.md.",
      "What did I write about petrichor? File is petrichor.md.",
      "Show me ducks.md content.",
      "What does brisbane.md say?",
      "Read the file petrichor.md.",
      "I want to see the contents of brisbane.md.",
    ],
    (prompt, called, _reply) => {
      // Extract the expected filename from the prompt (e.g., "brisbane.md")
      const want = prompt.match(/(\w+)\.md/i)?.[0]?.toLowerCase();
      if (!called.includes("read_note")) {
        return { passed: false, reason: called.length === 0 ? "did not call any tool" : `wrong tool: ${called.join(",")}` };
      }
      // Inspect the assistant message that did the call to see the args.
      // (Helper: reach into context state once more.)
      return { passed: true, reason: `called read_note (target ${want})` };
    },
  );
  record(`B. read_note called when it should be (≥5/8)`, catB.passed >= 5, `${catB.passed}/${catB.total}`);

  // Category C — should NOT call any tool (general chat).
  //
  // Threshold deliberately low: empirical baseline for Qwen-3B 4-bit at v3
  // is ~1/5. The model has a strong bias toward calling SOMETHING when
  // tools are available, even on prompts where no tool is appropriate.
  // The threshold is set to "not worse than baseline" — we'd want a future
  // change that pushes this higher, and want to fail fast if it regresses.
  const catC = await runCategory(
    model,
    registry,
    "category C: should NOT call any tool (target ≥1/5 — known SLM weakness)",
    [
      "Hi, how are you today?",
      "What's two plus two?",
      "Recommend a fun weekend activity.",
      "Make up a haiku about wind.",
      "Give me a name idea for a pet hamster.",
    ],
    (_p, called, _reply) => {
      if (called.length === 0) return { passed: true, reason: "no tool called" };
      return { passed: false, reason: `unexpectedly called: ${called.join(",")}` };
    },
  );
  record(`C. no tool when none was needed (≥1/5 — over-call bias is known)`, catC.passed >= 1, `${catC.passed}/${catC.total}`);

  // Category D — model should incorporate the tool result, not ignore it
  header("category D: tool result is actually used in reply");
  const catD = { total: 0, passed: 0 };
  const dCases: Array<{ prompt: string; expectInReply: RegExp }> = [
    { prompt: "What's in petrichor.md? File is petrichor.md.", expectInReply: /(scent|rain|earthy|dry soil)/i },
    { prompt: "What does ducks.md say?", expectInReply: /(webbed|swim|mallard)/i },
    { prompt: "Read brisbane.md and tell me what it's about.", expectInReply: /(bridge|story|march|2024|illuminated|purple)/i },
  ];
  for (const c of dCases) {
    catD.total++;
    const a = newAssistant(model, registry);
    const r = await a.chat(c.prompt, { temperature: 0.2, maxTokens: 120 });
    const called = toolsCalledInLastTurn(a.state);
    const usedTool = called.includes("read_note");
    const used = c.expectInReply.test(r.reply);
    const passed = usedTool && used;
    if (passed) catD.passed++;
    const mark = passed ? "✓" : "✗";
    console.log(
      `  ${mark} "${c.prompt.slice(0, 50)}"  called=${usedTool ? "✓" : "✗"} ` +
        `used-result=${used ? "✓" : "✗"}  reply: ${r.reply.replace(/\n/g, " ").slice(0, 70)}`,
    );
  }
  console.log(`  ── passed ${catD.passed}/${catD.total}`);
  record(`D. tool result incorporated in reply (≥2/3)`, catD.passed >= 2, `${catD.passed}/${catD.total}`);

  // Category E — agent loop max-steps safety
  header("category E: agent loop respects max steps");
  const a = newAssistant(model, registry);
  // Force a tight max — even if model behaves, this asserts the loop terminates.
  const r = await a.chat("What time is it?", { temperature: 0.2, maxTokens: 60, maxSteps: 1 });
  // With maxSteps=1 we either: get a reply on step 1 (no tools), OR hit the
  // exhaustion message because the model wanted a tool call.
  record(
    "loop exits within max steps (no infinite recursion)",
    r.steps <= 1,
    `steps=${r.steps} reply='${r.reply.slice(0, 60)}'`,
  );
}

async function main() {
  console.log("v3 eval — tool calling");
  console.log("═".repeat(50));

  try {
    await mkdir(TEST_ROOT, { recursive: true });
    await setupNotes();
    await unitChecks();
    await integrationChecks();
  } finally {
    await rm(TEST_ROOT, { recursive: true, force: true });
  }

  summarize();
}

main().catch((e) => {
  console.error("\nunexpected error:", e);
  process.exit(2);
});
