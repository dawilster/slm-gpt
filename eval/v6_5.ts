/**
 * v6.5 eval — Apple Shortcuts invocation.
 *
 * What we test:
 *   1. The model picks the right SHORTCUT NAME from a fixture library that
 *      contains realistic ambiguity (e.g. "Create Note with Date" vs
 *      "Add to Bear Note" — both note creators).
 *   2. The model passes user-provided content through to `input` rather
 *      than letting the shortcut prompt the user manually.
 *   3. The model produces structurally rich content (markdown todo lists,
 *      numbered lists, packing checklists) when asked.
 *   4. Multi-step requests fan out into the right sequence of calls.
 *   5. Pure questions / off-library requests do NOT hallucinate a shortcut
 *      invocation.
 *   6. Fuzzy ranking (the recovery path when the model picks a wrong name)
 *      surfaces the right candidate first — tested directly, no model.
 *
 * Hermetic by default: a MockShortcutsClient implements the same shape as
 * the real one but records calls instead of firing /usr/bin/shortcuts. The
 * model never actually creates a note or starts a timer on your machine.
 *
 * Run with:  bun run eval/v6_5.ts
 * Exit code 0 if all category thresholds met.
 */

import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpenAICompatClient, discoverModel } from "../src/client";
import type { Msg, ToolCallReq } from "../src/client";
import { Context } from "../src/context";
import { Assistant } from "../src/assistant";
import { Profile } from "../src/profile";
import { rankShortcutsByFuzzy } from "../src/shortcuts";
import type { ListShortcutsResult, RunShortcutResult, ShortcutEntry } from "../src/shortcuts";
import type { Intent } from "../src/shortcut_meta";
import {
  ToolRegistry,
  getCurrentTimeTool,
  makeForgetTool,
  makeListShortcutsTool,
  makeRememberTool,
  makeRunShortcutTool,
} from "../src/tools";

// ─── Config ───────────────────────────────────────────────

const BASE_URL = process.env.MODEL_BASE_URL ?? "http://localhost:1234/v1";
const API_KEY  = process.env.MODEL_API_KEY  ?? "lm-studio";
const TEST_ROOT = join(tmpdir(), `assistant-v6_5-test-${process.pid}-${Date.now()}`);

// Fixture library — same names as before, now with intent metadata to mirror
// what the real ShortcutMetaStore would produce. This is the typed contract
// that replaced the hard-coded prompt examples (see design.md §5.1, §8).
//
// The Apple Notes shortcut is the default for `create_note`; Bear is not.
// Paired Toggle Lights On/Off are both default for control_lights only by
// virtue of being first-seen (in real use, only one would be default; for
// the eval we want the model to disambiguate by name within the intent).
type FixtureEntry = { name: string; intent: Intent; isDefault: boolean };
const FIXTURE_LIBRARY: FixtureEntry[] = [
  { name: "Create Note with Date", intent: "create_note",     isDefault: true  },
  { name: "Add to Bear Note",      intent: "create_note",     isDefault: false },
  { name: "Start Pomodoro Timer",  intent: "start_timer",     isDefault: true  },
  { name: "Set Reminder",          intent: "set_reminder",    isDefault: true  },
  { name: "Send iMessage",         intent: "send_message",    isDefault: true  },
  { name: "Add to Calendar",       intent: "add_calendar",    isDefault: true  },
  { name: "Start Recording",       intent: "start_recording", isDefault: true  },
  { name: "Toggle Lights On",      intent: "control_lights",  isDefault: true  },
  { name: "Toggle Lights Off",     intent: "control_lights",  isDefault: false },
  { name: "Run Backup",            intent: "run_backup",      isDefault: true  },
  { name: "Search the Web",        intent: "search_web",      isDefault: true  },
  { name: "Speak Text",            intent: "speak_text",      isDefault: true  },
];

const FIXTURE_SHORTCUTS = FIXTURE_LIBRARY.map((e) => e.name);
const FIXTURE_ENTRIES: ShortcutEntry[] = FIXTURE_LIBRARY.map((e) => ({
  name: e.name, intent: e.intent, isDefault: e.isDefault,
}));

// ─── BASE_SYSTEM (mirrors src/server.ts; keep in sync) ───

const BASE_SYSTEM = [
  "You are a helpful personal assistant. Be concise and direct. If you don't know or don't remember, say so. Never invent facts about the user.",
  "Tools are real function calls — invoke them through the tool-call mechanism. Never write a tool name and arguments as plain text in your reply.",
  "Memory: invoke `remember(key, value)` when the user states a stable fact about themselves — preferences, identity, defaults. Action requests (notes, timers, reminders, calendar, lights, etc.) go through `run_shortcut`, never `remember`. Invoke `forget` only when a fact no longer applies and has no replacement.",
  "Retrieval: invoke `search_corpus` for questions about the user's content. Skip retrieval for action requests. Don't query the same thing twice in one turn.",
  "Actions: world-changing actions go through `run_shortcut(name, input?)`. Each shortcut in the list below carries an `intent` tag. Pick the shortcut whose intent matches the user's request; when two share an intent, prefer the one tagged `default`. Pass user-provided content as `input`. Chain by calling `run_shortcut` once per step.",
  "Output formats: todo list / checklist / checkboxes → format items as `- [ ] item`. Numbered steps → `1. step`. Otherwise plain prose.",
  "Recovery: when a tool returns an Error, immediately invoke the tool again with corrected arguments. Don't narrate intent.",
].join("\n");

function buildSystemPrompt(entries: ShortcutEntry[], profile?: Profile): string {
  const sections: string[] = [BASE_SYSTEM];
  if (profile) {
    const facts = profile.renderForSystemPrompt();
    if (facts) sections.push(facts);
  }
  const lines = entries.map((e) => {
    const intentTag = e.intent ? `intent: ${e.intent}` : "intent: other";
    const defaultTag = e.isDefault ? ", default" : "";
    return `- ${e.name}  [${intentTag}${defaultTag}]`;
  });
  sections.push(
    `Available shortcuts (pass exact name as the \`name\` arg of run_shortcut). Pick by intent matching the user's request; when two shortcuts share an intent, prefer the one tagged "default":\n${lines.join("\n")}`,
  );
  return sections.join("\n\n");
}

// ─── Mock client ──────────────────────────────────────────

/**
 * Drop-in replacement for ShortcutsClient that records `run` calls and
 * never spawns /usr/bin/shortcuts. Structurally compatible with the
 * tools' expected interface.
 */
class MockShortcutsClient {
  public runCalls: Array<{ name: string; input?: string }> = [];

  async list(_opts: { force?: boolean } = {}): Promise<ListShortcutsResult> {
    return {
      ok: true,
      shortcuts: FIXTURE_ENTRIES.map((e) => ({ ...e })),
      cachedAt: Date.now(),
      fromCache: false,
    };
  }

  async run(name: string, input?: string): Promise<RunShortcutResult> {
    if (!FIXTURE_SHORTCUTS.includes(name)) {
      return { ok: false, error: `shortcut '${name}' not found`, kind: "missing" };
    }
    this.runCalls.push({ name, input });
    return { ok: true, output: "" };
  }

  async fuzzyMatches(query: string, n = 3): Promise<string[]> {
    return rankShortcutsByFuzzy(query, FIXTURE_SHORTCUTS, n);
  }

  cachedNames(): string[] | null {
    return [...FIXTURE_SHORTCUTS];
  }

  cachedEntries(): ShortcutEntry[] | null {
    return FIXTURE_ENTRIES.map((e) => ({ ...e }));
  }

  invalidateCache(): void { /* no-op */ }
}

// ─── Result tracking ──────────────────────────────────────

type CheckResult = { category: string; name: string; passed: boolean; detail?: string };
const results: CheckResult[] = [];

function record(category: string, name: string, passed: boolean, detail?: string) {
  results.push({ category, name, passed, detail });
  console.log(`  ${passed ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function header(title: string) {
  console.log(`\n§ ${title}`);
}

// ─── Per-turn helpers ─────────────────────────────────────

function newAssistant(
  model: string,
  mock: MockShortcutsClient,
  seedProfile: Record<string, string> = {},
): { assistant: Assistant; profile: Profile } {
  const client = new OpenAICompatClient({ baseURL: BASE_URL, apiKey: API_KEY, model });
  const profile = new Profile(join(TEST_ROOT, `profile-${Math.random().toString(36).slice(2, 8)}.json`));
  for (const [k, v] of Object.entries(seedProfile)) profile.set(k, v);
  const ctx = new Context({ systemPrompt: buildSystemPrompt(FIXTURE_ENTRIES, profile), budget: 4096 });
  const registry = new ToolRegistry();
  registry.register(getCurrentTimeTool);
  registry.register(makeRememberTool(profile));
  registry.register(makeForgetTool(profile));
  // Structural typing — the mock has the same surface the tools call.
  registry.register(makeListShortcutsTool(mock as any));
  registry.register(makeRunShortcutTool(mock as any));
  return { assistant: new Assistant(ctx, client, null, registry), profile };
}

type ObservedCall = { name: string; args: Record<string, unknown>; result: string };

/** Pull every tool call (with parsed args + result) from the most recent turn. */
function toolCallsInLastTurn(ctx: Context): ObservedCall[] {
  const all = ctx.all();
  let userIdx = all.length - 1;
  while (userIdx >= 0 && all[userIdx]?.role !== "user") userIdx--;
  const calls: ObservedCall[] = [];
  for (let j = userIdx + 1; j < all.length; j++) {
    const m: Msg | undefined = all[j];
    if (m?.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls as ToolCallReq[]) {
        const result = all.slice(j + 1).find((mm) => mm.role === "tool" && mm.toolCallId === tc.id);
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(tc.function.arguments || "{}");
          if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
        } catch { /* malformed args; leave empty */ }
        calls.push({ name: tc.function.name, args, result: result?.content ?? "" });
      }
    }
  }
  return calls;
}

const RUN_CALL = (calls: ObservedCall[]) => calls.filter((c) => c.name === "run_shortcut");

// ─── Category A — Simple invocation ───────────────────────

type SimpleCase = {
  prompt: string;
  expectedName: string;
  expectsInput?: boolean;     // true = there must be a non-empty input arg
};

const SIMPLE_CASES: SimpleCase[] = [
  { prompt: "start a pomodoro",           expectedName: "Start Pomodoro Timer" },
  { prompt: "turn on the lights",          expectedName: "Toggle Lights On" },
  { prompt: "turn the lights off",         expectedName: "Toggle Lights Off" },
  { prompt: "run a backup",                expectedName: "Run Backup" },
  { prompt: "speak this aloud: hello",     expectedName: "Speak Text", expectsInput: true },
];

async function runSimple(model: string) {
  header(`A. Simple invocation (${SIMPLE_CASES.length} prompts)`);
  for (const c of SIMPLE_CASES) {
    const mock = new MockShortcutsClient();
    const { assistant } = newAssistant(model, mock);
    const r = await assistant.chat(c.prompt);
    const calls = RUN_CALL(toolCallsInLastTurn(assistant.state));
    const matched = calls.find((tc) => tc.args.name === c.expectedName);
    const inputOk = c.expectsInput ? Boolean(matched?.args.input && String(matched.args.input).trim().length > 0) : true;
    const passed = Boolean(matched) && inputOk;
    const detail = passed
      ? `→ run_shortcut(${c.expectedName})`
      : `picked ${calls.map((c) => c.args.name ?? "?").join(", ") || "(none)"}; reply="${r.reply.slice(0, 60)}"`;
    record("simple", `"${c.prompt}"`, passed, detail);
  }
}

// ─── Category B — Naming variation ────────────────────────

// Naming variation tests "the bug" — model picks the right shortcut
// from a phrase that doesn't match the name verbatim.
//
// Two flavours covered here:
//   - Unambiguous: only one shortcut matches the intent (reminder,
//     calendar). Model should fire silently.
//   - User-disambiguated: user named the app explicitly ("my Bear notes").
//     No need to ask — pick the named one.
//   - Profile-disambiguated: profile has a saved preference (notes_app).
//     Model should silently use it. This is the steady state after the
//     user answered a disambiguation question once.
//
// The "cold-start ambiguous" case (e.g. "create a note" with empty
// profile) lives in Category G — that's a multi-turn flow.
// Three flavours of selection:
//   - Unambiguous intent (reminder, calendar): only one shortcut tags it.
//   - User-named the app explicitly ("my Bear notes"): pick the named one.
//   - Ambiguous intent + metadata default: two shortcuts share an intent
//     (create_note); one is tagged `default`. Model should pick the default.
//     This used to need a seeded profile preference; now metadata covers it.
type NamingCase = { prompt: string; expectedName: string };
const NAMING_CASES: NamingCase[] = [
  // Unambiguous
  { prompt: "remind me to take out the trash tomorrow",      expectedName: "Set Reminder" },
  { prompt: "put dinner with mum on my calendar for friday", expectedName: "Add to Calendar" },
  // User-named the app + provided content
  { prompt: "add 'don't forget the milk' to my Bear notes",  expectedName: "Add to Bear Note" },
  // Ambiguous intent — relies on metadata default for create_note
  { prompt: "create a note",                                 expectedName: "Create Note with Date" },
  { prompt: "make a quick note",                             expectedName: "Create Note with Date" },
  { prompt: "save a note",                                   expectedName: "Create Note with Date" },
];

async function runNaming(model: string) {
  header(`B. Naming variation (${NAMING_CASES.length} prompts) — intent-default selection`);
  for (const c of NAMING_CASES) {
    const mock = new MockShortcutsClient();
    const { assistant } = newAssistant(model, mock);
    const r = await assistant.chat(c.prompt);
    const calls = RUN_CALL(toolCallsInLastTurn(assistant.state));
    const finalSuccess = calls.find((tc) => tc.result.startsWith("Ran"));
    const passed = Boolean(finalSuccess && finalSuccess.args.name === c.expectedName);
    const picked = calls.map((c) => c.args.name ?? "?").join(" → ") || "(none)";
    const detail = passed
      ? `→ ${c.expectedName}`
      : `picked ${picked}; reply="${r.reply.slice(0, 60)}"`;
    record("naming", `"${c.prompt}"`, passed, detail);
  }
}

// ─── Category C — Content pass-through ────────────────────

// User gives content; it MUST end up as `input`. If it doesn't, the
// shortcut prompts the user manually — defeating the point.
type ContentCase = {
  prompt: string;
  expectedName: string;
  inputMustContain: RegExp[];
};
const CONTENT_CASES: ContentCase[] = [
  {
    prompt: "create a note that says today went really well, finished the eval",
    expectedName: "Create Note with Date",
    inputMustContain: [/today went/i, /eval/i],
  },
  {
    prompt: "send 'on my way home' to mum",
    expectedName: "Send iMessage",
    inputMustContain: [/on my way home/i],
  },
  {
    prompt: "speak the words 'system check complete' out loud",
    expectedName: "Speak Text",
    inputMustContain: [/system check complete/i],
  },
];

async function runContent(model: string) {
  header(`C. Content pass-through (${CONTENT_CASES.length} prompts)`);
  for (const c of CONTENT_CASES) {
    const mock = new MockShortcutsClient();
    const { assistant } = newAssistant(model, mock, { notes_app: "Create Note with Date" });
    const r = await assistant.chat(c.prompt);
    const calls = RUN_CALL(toolCallsInLastTurn(assistant.state));
    const matched = calls.find((tc) => tc.args.name === c.expectedName && typeof tc.args.input === "string");
    const input = (matched?.args.input as string | undefined) ?? "";
    const missing = c.inputMustContain.filter((re) => !re.test(input));
    const passed = Boolean(matched) && missing.length === 0;
    const detail = passed
      ? `→ input="${input.slice(0, 60)}…"`
      : matched
        ? `input missing ${missing.map((r) => r.source).join(", ")}; got="${input.slice(0, 60)}"`
        : `wrong/no run_shortcut: ${calls.map((c) => c.args.name ?? "?").join(", ") || "(none)"}`;
    record("content", `"${c.prompt}"`, passed, detail);
  }
}

// ─── Category D — Structured rich content ─────────────────

// The user's explicit ask: a todo list of ingredients should arrive as
// markdown checkboxes in `input`, not as a dialog prompt.
type RichCase = {
  prompt: string;
  expectedName: string;
  inputAssert: (input: string) => { ok: boolean; reason?: string };
};

function isMarkdownChecklist(input: string, minItems = 4): { ok: boolean; reason?: string } {
  const checkboxLines = input.match(/^\s*[-*]\s*\[\s*[xX ]?\s*\]/gm) ?? [];
  if (checkboxLines.length < minItems) {
    return { ok: false, reason: `${checkboxLines.length} checkbox lines (need ≥${minItems})` };
  }
  return { ok: true };
}

function isNumberedList(input: string, minItems = 4): { ok: boolean; reason?: string } {
  const lines = input.match(/^\s*\d+[.)]\s+\S+/gm) ?? [];
  if (lines.length < minItems) {
    return { ok: false, reason: `${lines.length} numbered lines (need ≥${minItems})` };
  }
  return { ok: true };
}

const RICH_CASES: RichCase[] = [
  {
    prompt: "create a note with a todo list of ingredients to make spaghetti bolognaise",
    expectedName: "Create Note with Date",
    inputAssert: (input) => {
      const list = isMarkdownChecklist(input, 5);
      if (!list.ok) return list;
      // A reasonable bolognese mentions at least one of these ingredients.
      const hasIngredient = /(beef|mince|tomato|onion|garlic|pasta|spaghetti|carrot|celery)/i.test(input);
      return hasIngredient ? { ok: true } : { ok: false, reason: "no recognisable ingredient terms" };
    },
  },
  {
    prompt: "create a note with a numbered list of steps to brew a v60 pourover",
    expectedName: "Create Note with Date",
    inputAssert: isNumberedList,
  },
  {
    prompt: "create a note with a packing checklist for a weekend trip",
    expectedName: "Create Note with Date",
    inputAssert: (input) => isMarkdownChecklist(input, 5),
  },
];

async function runRich(model: string) {
  header(`D. Structured rich content (${RICH_CASES.length} prompts) — todo lists, numbered, checklists`);
  for (const c of RICH_CASES) {
    const mock = new MockShortcutsClient();
    const { assistant } = newAssistant(model, mock, { notes_app: "Create Note with Date" });
    const r = await assistant.chat(c.prompt);
    const calls = RUN_CALL(toolCallsInLastTurn(assistant.state));
    const matched = calls.find((tc) => tc.args.name === c.expectedName && typeof tc.args.input === "string");
    if (!matched) {
      record("rich", `"${c.prompt}"`, false, `no run_shortcut(${c.expectedName}) with input — saw ${calls.map((c) => c.args.name).join(", ") || "(none)"}`);
      continue;
    }
    const input = matched.args.input as string;
    const verdict = c.inputAssert(input);
    const detail = verdict.ok
      ? `→ ${input.split("\n").length} lines, looks structured`
      : `${verdict.reason}; first 120 chars: "${input.slice(0, 120).replace(/\n/g, " ↩ ")}"`;
    record("rich", `"${c.prompt}"`, verdict.ok, detail);
  }
}

// ─── Category E — Multi-step chains ───────────────────────

type ChainCase = {
  prompt: string;
  expectedSequence: string[];   // ordered shortcut names that should appear
};

const CHAIN_CASES: ChainCase[] = [
  {
    prompt: "create a note with the lasagna ingredients then start a 30 minute timer",
    expectedSequence: ["Create Note with Date", "Start Pomodoro Timer"],
  },
  {
    prompt: "remind me to take my meds at 8am and add it to my calendar too",
    expectedSequence: ["Set Reminder", "Add to Calendar"],
  },
];

async function runChain(model: string) {
  header(`E. Multi-step chains (${CHAIN_CASES.length} prompts)`);
  for (const c of CHAIN_CASES) {
    const mock = new MockShortcutsClient();
    const { assistant } = newAssistant(model, mock, { notes_app: "Create Note with Date" });
    const r = await assistant.chat(c.prompt, { maxSteps: 8 });
    const calls = RUN_CALL(toolCallsInLastTurn(assistant.state));
    const successfulNames = calls
      .filter((tc) => tc.result.startsWith("Ran"))
      .map((tc) => String(tc.args.name ?? ""));
    const passed = c.expectedSequence.every((n) => successfulNames.includes(n));
    const detail = passed
      ? `→ ${successfulNames.join(" → ")}`
      : `got [${successfulNames.join(", ")}]; expected [${c.expectedSequence.join(", ")}]`;
    record("chain", `"${c.prompt}"`, passed, detail);
  }
}

// ─── Category F — Skip on question / refusal ──────────────

type SkipCase = {
  prompt: string;
  // None of these should produce ANY run_shortcut call.
  notes?: string;
};
const SKIP_CASES: SkipCase[] = [
  { prompt: "what time is it?" },
  { prompt: "what's 2 plus 2?" },
  { prompt: "send a tweet saying hello world", notes: "no Twitter shortcut in fixture" },
];

async function runSkip(model: string) {
  header(`F. Skip / refusal (${SKIP_CASES.length} prompts) — no run_shortcut should fire`);
  for (const c of SKIP_CASES) {
    const mock = new MockShortcutsClient();
    const { assistant } = newAssistant(model, mock);
    const r = await assistant.chat(c.prompt);
    const ranAny = mock.runCalls.length > 0;
    const passed = !ranAny;
    const detail = passed
      ? `(no run_shortcut)${c.notes ? ` — ${c.notes}` : ""}`
      : `unexpectedly ran: ${mock.runCalls.map((c) => c.name).join(", ")}`;
    record("skip", `"${c.prompt}"`, passed, detail);
  }
}

// ─── Category G — DELETED with the meta-layer architecture ────────
//
// Earlier this category tested a cold-start "ask user → remember → act"
// flow at 4B. With shortcut-meta.json (see design.md §5.1, §7, §8) the
// runtime picks defaults programmatically (first-seen-of-an-intent gets
// `isDefault=true`) and the model never has to ask. The user overrides
// wrong defaults via UI — that's the path to agency, not a chat flow
// the model has to execute.
//
// The behaviour Category G used to test ("with two note shortcuts, model
// picks the right one silently") is now covered by Category B's seeded
// cases AND by the intent metadata in every prompt.
async function _runDisambiguation_DELETED(model: string) {
  header(`G. Disambiguation memory (multi-turn, cold start)`);
  const mock = new MockShortcutsClient();
  const profile = new Profile(join(TEST_ROOT, `profile-disambig-${Date.now()}.json`));
  const client = new OpenAICompatClient({ baseURL: BASE_URL, apiKey: API_KEY, model });
  const ctx = new Context({ systemPrompt: buildSystemPrompt(FIXTURE_ENTRIES, profile), budget: 4096 });
  const registry = new ToolRegistry();
  registry.register(getCurrentTimeTool);
  registry.register(makeRememberTool(profile));
  registry.register(makeForgetTool(profile));
  registry.register(makeListShortcutsTool(mock as any));
  registry.register(makeRunShortcutTool(mock as any));
  const assistant = new Assistant(ctx, client, null, registry);

  // ── Turn 1: bare ambiguous "create a note" — no body, no extra context.
  // Acceptable behaviours (UX-wise both are reasonable):
  //   (a) ASK the user to choose, no run_shortcut yet, OR
  //   (b) act on a default AND immediately remember a preference for next time.
  // We accept either as a pass — what we DON'T accept is acting silently
  // without saving any preference, which leaves us no better off next time.
  ctx.setSystemPrompt(buildSystemPrompt(FIXTURE_ENTRIES, profile));
  const r1 = await assistant.chat("create a note");
  const t1Calls = toolCallsInLastTurn(ctx);
  const t1Run = t1Calls.filter((c) => c.name === "run_shortcut");
  const t1Remember = t1Calls.filter((c) => c.name === "remember");
  const askedQuestion = /\?/.test(r1.reply);
  const acted = t1Run.length > 0;
  const remembered = t1Remember.some((c) =>
    typeof c.args.key === "string" &&
    /note/i.test(c.args.key) &&
    typeof c.args.value === "string" &&
    FIXTURE_SHORTCUTS.includes(c.args.value as string),
  );
  const t1Pass = (askedQuestion && !acted) || (acted && remembered);
  record("disambig", "T1: asks OR (acts + remembers preference)", t1Pass,
    `run=[${t1Run.map((c) => c.args.name).join(",")}]; remember=[${t1Remember.map((c) => `${c.args.key}=${c.args.value}`).join(", ")}]; asked=${askedQuestion}; reply="${r1.reply.slice(0, 80)}"`);

  // ── Turn 2: if T1 asked, the user answers. We expect remember + run_shortcut.
  // If T1 already remembered AND ran, this turn is a follow-up that should
  // not re-ask anything.
  ctx.setSystemPrompt(buildSystemPrompt(FIXTURE_ENTRIES, profile));
  const r2 = await assistant.chat("Apple Notes please. Note body: morning run was great.");
  const t2Calls = toolCallsInLastTurn(ctx);
  const t2Remember = t2Calls.filter((c) => c.name === "remember");
  const t2Run = t2Calls.filter((c) => c.name === "run_shortcut");
  const ranNote = t2Run.find((c) => c.args.name === "Create Note with Date");
  // Pass condition: by the END of T2, the profile has a notes-related entry
  // pointing to "Create Note with Date" (saved either this turn or T1).
  const profileHasPref = profile.entries().some(
    ([k, v]) => /note/i.test(k) && v === "Create Note with Date",
  );
  const t2Pass = Boolean(ranNote) && profileHasPref;
  record("disambig", "T2: ran note shortcut + profile records exact name", t2Pass,
    `remember(this-turn)=[${t2Remember.map((c) => `${c.args.key}=${c.args.value}`).join(", ")}]; run=[${t2Run.map((c) => c.args.name).join(", ")}]; profile=[${profile.entries().map(([k, v]) => `${k}=${v}`).join(", ")}]`);

  // ── Turn 3: ambiguous-shape request — should use saved pref silently
  // (no question mark in reply).
  ctx.setSystemPrompt(buildSystemPrompt(FIXTURE_ENTRIES, profile));
  const r3 = await assistant.chat("save another quick note: lunch was good");
  const t3Calls = toolCallsInLastTurn(ctx);
  const t3Run = t3Calls.filter((c) => c.name === "run_shortcut");
  const askedAgain = /\?/.test(r3.reply);
  const ranWithSaved = t3Run.find((c) => c.args.name === "Create Note with Date");
  const t3Pass = Boolean(ranWithSaved) && !askedAgain;
  record("disambig", "T3: uses saved pref, no question", t3Pass,
    `run=[${t3Run.map((c) => c.args.name).join(",")}]; asked=${askedAgain}; reply="${r3.reply.slice(0, 80)}"`);
}

// ─── Fuzzy ranking unit checks (no model) ─────────────────

// Some queries have a single right answer ("pomodoro" → only one shortcut
// has that token). Others are intrinsically ambiguous ("new note" — both
// note-creating shortcuts are defensible recoveries) — for those, any of
// the listed names being top-1 counts as a pass. The full top-3 is logged
// so a regression that drops a name out of suggestions entirely surfaces
// as a different-shape failure.
type FuzzyCase = { query: string; acceptableTops: string[] };
const FUZZY_CASES: FuzzyCase[] = [
  { query: "create note",   acceptableTops: ["Create Note with Date"] },
  { query: "new note",      acceptableTops: ["Create Note with Date", "Add to Bear Note"] },
  { query: "bear",          acceptableTops: ["Add to Bear Note"] },
  { query: "pomodoro",      acceptableTops: ["Start Pomodoro Timer"] },
  { query: "lights on",     acceptableTops: ["Toggle Lights On"] },
  { query: "lights off",    acceptableTops: ["Toggle Lights Off"] },
  { query: "calendar",      acceptableTops: ["Add to Calendar"] },
  { query: "speak",         acceptableTops: ["Speak Text"] },
  { query: "imessage",      acceptableTops: ["Send iMessage"] },
];
// Note: typo cases ("tymer" → "Start Pomodoro Timer") are deliberately
// out of scope. Word-overlap + bigram fuzzy doesn't catch them; we'd need
// edit distance, and real users rarely emit single-character typos in
// model-generated tool args. If this becomes a problem, add Levenshtein.

function runFuzzyChecks() {
  header(`Fuzzy ranking unit checks (${FUZZY_CASES.length} cases — no model involved)`);
  for (const c of FUZZY_CASES) {
    const ranked = rankShortcutsByFuzzy(c.query, FIXTURE_SHORTCUTS, 3);
    const top = ranked[0];
    const passed = top !== undefined && c.acceptableTops.includes(top);
    const detail = passed
      ? `top: ${ranked.join(", ")}`
      : `expected one of [${c.acceptableTops.join(", ")}], got [${ranked.join(", ") || "(none)"}]`;
    record("fuzzy", `"${c.query}"`, passed, detail);
  }
}

// ─── Summary ──────────────────────────────────────────────

const CATEGORY_THRESHOLDS: Record<string, number> = {
  simple:   0.8,
  naming:   0.66,   // hardest category — the actual bug; lower bar
  content:  0.66,
  rich:     0.66,
  chain:    0.5,    // 4B chains are stretchy; tolerate one miss
  skip:     1.0,    // hallucinated tool calls are unacceptable
  fuzzy:    1.0,    // deterministic — no excuse for misses
};

function summarize() {
  const byCat = new Map<string, CheckResult[]>();
  for (const r of results) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category)!.push(r);
  }

  console.log("\n" + "═".repeat(60));
  console.log("v6.5 eval summary — Apple Shortcuts invocation");
  console.log("═".repeat(60));
  let allPassed = true;
  for (const [cat, rs] of byCat) {
    const pass = rs.filter((r) => r.passed).length;
    const tot  = rs.length;
    const ratio = pass / tot;
    const threshold = CATEGORY_THRESHOLDS[cat] ?? 0.8;
    const ok = ratio >= threshold;
    if (!ok) allPassed = false;
    console.log(`  ${ok ? "✓" : "✗"} ${cat.padEnd(8)} ${pass}/${tot}  (need ≥${(threshold * 100).toFixed(0)}%)`);
  }
  const totalPass = results.filter((r) => r.passed).length;
  console.log(`\n  total: ${totalPass}/${results.length}`);
  if (!allPassed) {
    console.log("\nFailures:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ✗ [${r.category}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    }
    process.exitCode = 1;
  } else {
    console.log("\nAll category thresholds met.");
  }
}

// ─── Main ─────────────────────────────────────────────────

async function main() {
  await mkdir(TEST_ROOT, { recursive: true });

  console.log("v6.5 eval — Apple Shortcuts invocation");
  console.log("═".repeat(60));

  // Fuzzy is independent of the model — run first so even an LM Studio
  // outage can't mask a fuzzy-ranking regression.
  runFuzzyChecks();

  let model: string;
  try {
    model = await discoverModel(BASE_URL, API_KEY);
  } catch {
    console.log("\n(no model loaded at " + BASE_URL + " — skipping model-driven categories)");
    summarize();
    await rm(TEST_ROOT, { recursive: true, force: true });
    return;
  }
  console.log(`\nmodel: ${model}\nfixture library: ${FIXTURE_SHORTCUTS.length} shortcuts`);

  await runSimple(model);
  await runNaming(model);
  await runContent(model);
  await runRich(model);
  await runChain(model);
  await runSkip(model);

  summarize();
  await rm(TEST_ROOT, { recursive: true, force: true });
}

main().catch((e) => {
  console.error("eval crashed:", e?.stack ?? e);
  process.exit(2);
});
