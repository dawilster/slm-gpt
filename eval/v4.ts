/**
 * v4 eval — multi-tool routing.
 *
 * v3 asked: "does the agent loop work with one or two tools?". v4 asks:
 * "does tool selection still work at 5 tools, when several look similar?"
 *
 * Tools available:
 *   - get_current_time           (no args)
 *   - read_note(path)            read a specific .md file
 *   - list_notes()               enumerate notes
 *   - write_note(path, content)  create / overwrite a .md file
 *   - search_notes_by_filename(query)   substring filename match
 *
 * The hard part isn't read vs. time — it's read vs. list vs. search.
 * Those three overlap semantically and a 3-4B model can collapse them
 * into "the notes tool" if the prompt is even slightly ambiguous.
 *
 * Headline metric (per design.md §6.1):
 *   30 prompts across 4 tools, ≥22 pick the right tool with valid args.
 *
 * We use 5 tools (target distribution ~6/category) and additionally log:
 *   - over-call control (general chat that should call nothing)
 *   - 2-step composition (list → read in a single user request)
 *
 * Run with:  bun run eval/v4.ts
 * Exit code 0 if all category thresholds met; 1 otherwise.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAICompatClient, discoverModel } from "../src/client";
import type { Msg, ToolCallReq } from "../src/client";
import { Context } from "../src/context";
import { Assistant } from "../src/assistant";
import {
  ToolRegistry,
  getCurrentTimeTool,
  makeListNotesTool,
  makeReadNoteTool,
  makeSearchNotesByFilenameTool,
  makeWriteNoteTool,
} from "../src/tools";

const BASE_URL = process.env.MODEL_BASE_URL ?? "http://localhost:1234/v1";
const API_KEY = process.env.MODEL_API_KEY ?? "lm-studio";

const TEST_ROOT = join(tmpdir(), `assistant-v4-test-${process.pid}-${Date.now()}`);
const NOTES_ROOT = join(TEST_ROOT, "notes");

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
  console.log(`${passed}/${total} category checks passed`);
  if (passed < total) {
    console.log("failures:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ✗ ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    }
    process.exitCode = 1;
  }
}

/**
 * Pull every tool call the assistant made after the most recent user
 * message, with arguments parsed from JSON when possible. Empty args
 * become {}; malformed args become null (which the judge treats as
 * an arg-validation failure).
 */
function toolCallsInLastTurn(ctx: Context): Array<{ name: string; args: Record<string, unknown> | null }> {
  const all = ctx.all();
  let userIdx = all.length - 1;
  while (userIdx >= 0 && all[userIdx]?.role !== "user") userIdx--;
  const calls: Array<{ name: string; args: Record<string, unknown> | null }> = [];
  for (let j = userIdx + 1; j < all.length; j++) {
    const m: Msg | undefined = all[j];
    if (m?.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls as ToolCallReq[]) {
        let args: Record<string, unknown> | null = {};
        const raw = tc.function.arguments;
        if (raw && raw.length > 0) {
          try {
            const parsed = JSON.parse(raw);
            args = (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
              ? (parsed as Record<string, unknown>)
              : null;
          } catch {
            args = null;
          }
        }
        calls.push({ name: tc.function.name, args });
      }
    }
  }
  return calls;
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
  await writeFile(
    join(NOTES_ROOT, "cairns.md"),
    "Cairns is the gateway to the Great Barrier Reef. Hot, humid, mangroves.\n",
    "utf-8",
  );
}

// ─── headline: 30 prompts across the 5 tools ──────────────────────────

type Prompt = {
  text: string;
  expectedTool: string;
  /** Predicate over parsed args; receives `null` if args were malformed. */
  argsValid: (args: Record<string, unknown> | null) => boolean;
};

/** Args present, non-null, and includes a non-empty `path`. */
const pathPresent = (args: Record<string, unknown> | null): boolean =>
  !!args && typeof args.path === "string" && (args.path as string).length > 0;

/** Args is an object (possibly empty) — for nullary tools. */
const argsAreObject = (args: Record<string, unknown> | null): boolean => args !== null;

/** Path must include a specific filename substring (case-insensitive). */
const pathIncludes = (sub: string) => (args: Record<string, unknown> | null): boolean =>
  pathPresent(args) && (args!.path as string).toLowerCase().includes(sub.toLowerCase());

/** write_note: needs path AND non-empty content. */
const writeArgsValid = (args: Record<string, unknown> | null): boolean =>
  pathPresent(args) && typeof args!.content === "string" && (args!.content as string).length > 0;

/** search query must include the expected substring. */
const queryIncludes = (sub: string) => (args: Record<string, unknown> | null): boolean =>
  !!args && typeof args.query === "string" && (args.query as string).toLowerCase().includes(sub.toLowerCase());

const prompts: Prompt[] = [
  // A — get_current_time (5)
  { text: "What time is it right now?", expectedTool: "get_current_time", argsValid: argsAreObject },
  { text: "What's the current ISO timestamp?", expectedTool: "get_current_time", argsValid: argsAreObject },
  { text: "Tell me today's date.", expectedTool: "get_current_time", argsValid: argsAreObject },
  { text: "What is the current date and time?", expectedTool: "get_current_time", argsValid: argsAreObject },
  { text: "Right now — what is the time?", expectedTool: "get_current_time", argsValid: argsAreObject },

  // B — read_note (6) — phrasing makes it explicit you want THIS file's contents
  { text: "Read brisbane.md please.", expectedTool: "read_note", argsValid: pathIncludes("brisbane") },
  { text: "Open my note ducks.md.", expectedTool: "read_note", argsValid: pathIncludes("ducks") },
  { text: "What's in petrichor.md?", expectedTool: "read_note", argsValid: pathIncludes("petrichor") },
  { text: "Show me the contents of cairns.md.", expectedTool: "read_note", argsValid: pathIncludes("cairns") },
  { text: "Read the file brisbane.md and tell me what it says.", expectedTool: "read_note", argsValid: pathIncludes("brisbane") },
  { text: "I want to see ducks.md.", expectedTool: "read_note", argsValid: pathIncludes("ducks") },

  // C — list_notes (6) — phrasing avoids any specific filename
  { text: "What notes do I have?", expectedTool: "list_notes", argsValid: argsAreObject },
  { text: "List my notes.", expectedTool: "list_notes", argsValid: argsAreObject },
  { text: "Show me everything in my notes folder.", expectedTool: "list_notes", argsValid: argsAreObject },
  { text: "Which notes are saved?", expectedTool: "list_notes", argsValid: argsAreObject },
  { text: "Give me an overview of all my notes by name.", expectedTool: "list_notes", argsValid: argsAreObject },
  { text: "What's in my notes folder?", expectedTool: "list_notes", argsValid: argsAreObject },

  // D — write_note (7) — explicit "save as X.md", with content provided
  {
    text: "Save this as shopping.md: milk, eggs, bread.",
    expectedTool: "write_note",
    argsValid: (a) => writeArgsValid(a) && (a!.path as string).toLowerCase().includes("shopping"),
  },
  {
    text: "Create a note called gym.md with the content: squats Monday, deadlifts Thursday.",
    expectedTool: "write_note",
    argsValid: (a) => writeArgsValid(a) && (a!.path as string).toLowerCase().includes("gym"),
  },
  {
    text: "Write a new note movies.md saying: watch Dune part two.",
    expectedTool: "write_note",
    argsValid: (a) => writeArgsValid(a) && (a!.path as string).toLowerCase().includes("movies"),
  },
  {
    text: "Save 'practice scales daily' as a note named guitar.md.",
    expectedTool: "write_note",
    argsValid: (a) => writeArgsValid(a) && (a!.path as string).toLowerCase().includes("guitar"),
  },
  {
    text: "Make a note called todo.md with: file taxes, renew passport.",
    expectedTool: "write_note",
    argsValid: (a) => writeArgsValid(a) && (a!.path as string).toLowerCase().includes("todo"),
  },
  {
    text: "Add a note named ideas.md containing: build a personal assistant.",
    expectedTool: "write_note",
    argsValid: (a) => writeArgsValid(a) && (a!.path as string).toLowerCase().includes("ideas"),
  },
  {
    text: "Store this in a note called recipe.md: 200g flour, 100ml water, 1 egg.",
    expectedTool: "write_note",
    argsValid: (a) => writeArgsValid(a) && (a!.path as string).toLowerCase().includes("recipe"),
  },

  // E — search_notes_by_filename (6) — phrasing emphasises filename match
  {
    text: "Find notes whose filename contains 'bris'.",
    expectedTool: "search_notes_by_filename",
    argsValid: queryIncludes("bris"),
  },
  {
    text: "Search my notes for any filename with 'duck' in it.",
    expectedTool: "search_notes_by_filename",
    argsValid: queryIncludes("duck"),
  },
  {
    text: "Which of my note filenames include the word 'cairns'?",
    expectedTool: "search_notes_by_filename",
    argsValid: queryIncludes("cairns"),
  },
  {
    text: "Look for notes whose name matches 'petri'.",
    expectedTool: "search_notes_by_filename",
    argsValid: queryIncludes("petri"),
  },
  {
    text: "Do I have any notes with 'shopping' in the filename?",
    expectedTool: "search_notes_by_filename",
    argsValid: queryIncludes("shopping"),
  },
  {
    text: "List notes whose filename contains 'gym'.",
    expectedTool: "search_notes_by_filename",
    argsValid: queryIncludes("gym"),
  },
];

async function headlineCheck(model: string, registry: ToolRegistry) {
  header(`headline: 30 prompts across 5 tools (target ≥22/30 right tool + valid args)`);

  let passed = 0;
  const perTool: Record<string, { right: number; total: number }> = {};

  for (const p of prompts) {
    const a = newAssistant(model, registry);
    const r = await a.chat(p.text, { temperature: 0.2, maxTokens: 80 });
    const calls = toolCallsInLastTurn(a.state);

    perTool[p.expectedTool] ??= { right: 0, total: 0 };
    perTool[p.expectedTool]!.total++;

    const matching = calls.find((c) => c.name === p.expectedTool);
    let verdict: { ok: boolean; reason: string };
    if (!matching) {
      const others = calls.map((c) => c.name).join(",") || "[]";
      verdict = { ok: false, reason: `wrong tool: ${others}` };
    } else if (!p.argsValid(matching.args)) {
      verdict = { ok: false, reason: `right tool, bad args: ${JSON.stringify(matching.args)}` };
    } else {
      verdict = { ok: true, reason: "ok" };
      passed++;
      perTool[p.expectedTool]!.right++;
    }

    const mark = verdict.ok ? "✓" : "✗";
    const callStr = calls.length === 0 ? "[]" : calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(",");
    console.log(`  ${mark} "${p.text.slice(0, 60)}" → ${callStr.slice(0, 80)}  ${verdict.reason}`);
    // light reply preview helps debug semantic vs. selection errors
    console.log(`      reply: ${r.reply.replace(/\n/g, " ").slice(0, 70)}`);
  }

  console.log("\n  per-tool breakdown:");
  for (const [tool, stat] of Object.entries(perTool)) {
    console.log(`    ${tool.padEnd(28)} ${stat.right}/${stat.total}`);
  }
  console.log(`  ── headline: ${passed}/${prompts.length}`);
  record("headline ≥22/30 (right tool + valid args)", passed >= 22, `${passed}/${prompts.length}`);
}

// ─── over-call control ────────────────────────────────────────────────

async function overCallControl(model: string, registry: ToolRegistry) {
  header("control: should NOT call any tool (target ≥1/5 — known SLM weakness, parity with v3)");
  const cases = [
    "Hi, how are you today?",
    "What's two plus two?",
    "Recommend a fun weekend activity.",
    "Make up a haiku about wind.",
    "Give me a name idea for a pet hamster.",
  ];
  let passed = 0;
  for (const text of cases) {
    const a = newAssistant(model, registry);
    await a.chat(text, { temperature: 0.2, maxTokens: 80 });
    const calls = toolCallsInLastTurn(a.state);
    const ok = calls.length === 0;
    if (ok) passed++;
    const mark = ok ? "✓" : "✗";
    const callStr = calls.length === 0 ? "[]" : `[${calls.map((c) => c.name).join(",")}]`;
    console.log(`  ${mark} "${text.slice(0, 50)}" → ${callStr}`);
  }
  console.log(`  ── control: ${passed}/${cases.length}`);
  record("control ≥1/5 (no tool when none needed)", passed >= 1, `${passed}/${cases.length}`);
}

// ─── 2-step composition stress ────────────────────────────────────────

async function compositionCheck(model: string, registry: ToolRegistry) {
  header("composition: 2-step task in a single user request");
  // The prompt names a tool family ("list") and then asks for a follow-up
  // that requires reading one specific note. A well-behaved agent loop
  // should make at least one call, then a second call (in this turn or the
  // next iteration) that reads brisbane.md.
  const prompt = "List my notes, then read whichever one is about Brisbane.";
  const a = newAssistant(model, registry);
  const r = await a.chat(prompt, { temperature: 0.2, maxTokens: 200, maxSteps: 4 });
  const all = a.state.all();
  // Collect every tool call across the full turn (not just the last user-bounded slice).
  const toolNames: string[] = [];
  for (const m of all) {
    if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls as ToolCallReq[]) toolNames.push(tc.function.name);
    }
  }
  const listed = toolNames.includes("list_notes") || toolNames.includes("search_notes_by_filename");
  const read = toolNames.includes("read_note");
  const mentionsBrisbane = /(bridge|story|march|2024|illuminated|purple)/i.test(r.reply);
  console.log(`  tools called: [${toolNames.join(",") || "—"}]`);
  console.log(`  reply: ${r.reply.replace(/\n/g, " ").slice(0, 120)}`);
  console.log(`  steps=${r.steps}  listed=${listed}  read=${read}  reply-mentions-brisbane-content=${mentionsBrisbane}`);
  // Soft check: counts as passed if the model managed both halves OR clearly
  // chained read_note correctly. Composition is a stretch goal at this size.
  record(
    "composition: enumerated AND read",
    listed && read,
    `tools=[${toolNames.join(",")}] steps=${r.steps}`,
  );
}

// ─── unit checks for new tools ────────────────────────────────────────

async function unitChecks() {
  header("unit: new tool primitives");

  const registry = new ToolRegistry();
  registry.register(getCurrentTimeTool);
  registry.register(makeReadNoteTool(NOTES_ROOT));
  registry.register(makeListNotesTool(NOTES_ROOT));
  registry.register(makeWriteNoteTool(NOTES_ROOT));
  registry.register(makeSearchNotesByFilenameTool(NOTES_ROOT));
  record("registry has 5 tools", registry.size() === 5, `size=${registry.size()}`);

  const list = registry.get("list_notes")!;
  const listOut = await list.execute({});
  record("list_notes returns seeded notes", listOut.includes("brisbane.md") && listOut.includes("ducks.md"), listOut.replace(/\n/g, ","));

  const search = registry.get("search_notes_by_filename")!;
  const sOut = await search.execute({ query: "bris" });
  record("search matches brisbane.md", sOut.includes("brisbane.md"), sOut.slice(0, 80));
  const sNone = await search.execute({ query: "zzznotreal" });
  record("search returns no-match message", sNone.includes("no notes match"), sNone.slice(0, 80));
  const sBad = await search.execute({ query: "" });
  record("search rejects empty query", sBad.startsWith("Error:"), sBad.slice(0, 80));

  const write = registry.get("write_note")!;
  const wOut = await write.execute({ path: "scratch.md", content: "hello world" });
  record("write_note writes a new note", !wOut.startsWith("Error:"), wOut.slice(0, 80));
  const wRead = await registry.get("read_note")!.execute({ path: "scratch.md" });
  record("write_note round-trips through read_note", wRead === "hello world", wRead);
  const wNonMd = await write.execute({ path: "no-extension", content: "x" });
  record("write_note rejects non-.md path", wNonMd.startsWith("Error:"), wNonMd.slice(0, 80));
  const wTraversal = await write.execute({ path: "../escape.md", content: "x" });
  record("write_note rejects parent traversal", wTraversal.startsWith("Error:"), wTraversal.slice(0, 80));
}

async function main() {
  console.log("v4 eval — multi-tool routing");
  console.log("═".repeat(50));

  await mkdir(TEST_ROOT, { recursive: true });
  await setupNotes();

  try {
    await unitChecks();

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
    registry.register(makeListNotesTool(NOTES_ROOT));
    registry.register(makeWriteNoteTool(NOTES_ROOT));
    registry.register(makeSearchNotesByFilenameTool(NOTES_ROOT));

    await headlineCheck(model, registry);
    await overCallControl(model, registry);
    await compositionCheck(model, registry);
  } finally {
    await rm(TEST_ROOT, { recursive: true, force: true });
  }

  summarize();
}

main().catch((e) => {
  console.error("\nunexpected error:", e);
  process.exit(2);
});
