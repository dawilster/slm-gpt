/**
 * Shortcuts (Apple Shortcuts) — system bridge.
 *
 * This is the multi-tool eval today. The fixture library is 12 shortcuts
 * behind 2 tools (list_shortcuts + run_shortcut), plus get_current_time +
 * remember + forget = 5 live tools — exactly the §5 "8+" cliff territory.
 *
 * Six categories, each with its own threshold (per design.md §6.1 / §8):
 *   simple   — direct 1:1 invocation (≥80%)
 *   naming   — picks by intent + default tag, no name match required (≥66%)
 *   content  — user-provided text reaches the `input` arg (≥66%)
 *   rich     — markdown checklists / numbered lists travel as input (≥66%)
 *   chain    — multi-step requests fan out into the right sequence (≥50%)
 *   skip     — pure questions / off-library asks fire NO shortcut (100%)
 *
 * Plus deterministic fuzzy-ranking unit checks (no model).
 */

import { describe, scenario, beforeAll, afterAll } from "../lib/suite";
import { rankShortcutsByFuzzy } from "../../src/shortcuts";
import type { ShortcutEntry } from "../../src/shortcuts";
import type { Intent } from "../../src/shortcut_meta";
import { Profile } from "../../src/profile";
import {
  Workspace,
  THINKING,
  getModel,
  newAssistant,
  observedCallsInLastTurn,
  MockShortcutsClient,
} from "../lib/fixtures";

// ─── Fixture library ──────────────────────────────────────────

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
const FIXTURE_NAMES = FIXTURE_LIBRARY.map((e) => e.name);
const FIXTURE_ENTRIES: ShortcutEntry[] = FIXTURE_LIBRARY.map((e) => ({ ...e }));

// ─── BASE_SYSTEM (mirrors src/server.ts; keep in sync) ────────

const SHORTCUTS_BASE = [
  "You are a helpful personal assistant. Be concise and direct. If you don't know or don't remember, say so. Never invent facts about the user.",
  "Tools are real function calls — invoke them through the tool-call mechanism. Never write a tool name and arguments as plain text in your reply.",
  "Memory: invoke `remember(key, value)` when the user states a stable fact about themselves — preferences, identity, defaults. Action requests (notes, timers, reminders, calendar, lights, etc.) go through `run_shortcut`, never `remember`. Invoke `forget` only when a fact no longer applies and has no replacement.",
  "Retrieval: invoke `search_corpus` for questions about the user's content. Skip retrieval for action requests. Don't query the same thing twice in one turn.",
  "Actions: world-changing actions go through `run_shortcut(name, input?)`. Each shortcut in the list below carries an `intent` tag. Pick the shortcut whose intent matches the user's request; when two share an intent, prefer the one tagged `default`. Pass user-provided content as `input`. Chain by calling `run_shortcut` once per step.",
  "Output formats: todo list / checklist / checkboxes → format items as `- [ ] item`. Numbered steps → `1. step`. Otherwise plain prose.",
  "Recovery: when a tool returns an Error, immediately invoke the tool again with corrected arguments. Don't narrate intent.",
].join("\n");

function shortcutsSystemPrompt(profile?: Profile): string {
  const lines = FIXTURE_ENTRIES.map((e) => {
    const intentTag = e.intent ? `intent: ${e.intent}` : "intent: other";
    const defaultTag = e.isDefault ? ", default" : "";
    return `- ${e.name}  [${intentTag}${defaultTag}]`;
  });
  const sections = [SHORTCUTS_BASE];
  if (profile) {
    const facts = profile.renderForSystemPrompt();
    if (facts) sections.push(facts);
  }
  sections.push(
    `Available shortcuts (pass exact name as the \`name\` arg of run_shortcut). Pick by intent matching the user's request; when two shortcuts share an intent, prefer the one tagged "default":\n${lines.join("\n")}`,
  );
  return sections.join("\n\n");
}

// ─── Helpers ───────────────────────────────────────────────────

let ws: Workspace;

function makeAssistant(seedProfile: Record<string, string> = {}) {
  const mock = new MockShortcutsClient(FIXTURE_ENTRIES);
  const profile = new Profile(ws.path(`profile-${Math.random().toString(36).slice(2, 8)}.json`));
  for (const [k, v] of Object.entries(seedProfile)) profile.set(k, v);
  const bundle = newAssistant({
    systemPrompt: shortcutsSystemPrompt(profile),
    profile,
    shortcuts: { client: mock, entries: FIXTURE_ENTRIES },
  });
  return { ...bundle, mock };
}

function runCalls(ctx: ReturnType<typeof newAssistant>["context"]) {
  return observedCallsInLastTurn(ctx).filter((c) => c.name === "run_shortcut");
}

// ─── DSL ───────────────────────────────────────────────────────

describe("shortcuts", () => {
  beforeAll(async () => { ws = await Workspace.create("shortcuts"); });
  afterAll(async () => { await ws.cleanup(); });

  scenario("fuzzy ranking (deterministic; no model)", {
    threshold: [9, 9],
    needsModel: false,
    prompts: [
      "create note", "new note", "bear", "pomodoro", "lights on", "lights off",
      "calendar", "speak", "imessage",
    ],
    judge: ({ prompt }) => {
      const acceptable: Record<string, string[]> = {
        "create note": ["Create Note with Date"],
        "new note":    ["Create Note with Date", "Add to Bear Note"],
        "bear":        ["Add to Bear Note"],
        "pomodoro":    ["Start Pomodoro Timer"],
        "lights on":   ["Toggle Lights On"],
        "lights off":  ["Toggle Lights Off"],
        "calendar":    ["Add to Calendar"],
        "speak":       ["Speak Text"],
        "imessage":    ["Send iMessage"],
      };
      const ranked = rankShortcutsByFuzzy(prompt, FIXTURE_NAMES, 3);
      const top = ranked[0];
      const expected = acceptable[prompt]!;
      if (!top || !expected.includes(top)) {
        throw new Error(`expected one of [${expected.join(",")}], got [${ranked.join(", ") || "(none)"}]`);
      }
      return { detail: `top: ${ranked.join(", ")}` };
    },
  });

  // ─── A. Simple invocation ─────────────────────────────────────

  scenario("simple invocation", {
    threshold: [4, 5],
    prompts: [
      "start a pomodoro",
      "turn on the lights",
      "turn the lights off",
      "run a backup",
      "speak this aloud: hello",
    ],
    judge: async ({ prompt, index }) => {
      const expected: Array<{ name: string; expectsInput?: boolean }> = [
        { name: "Start Pomodoro Timer" },
        { name: "Toggle Lights On" },
        { name: "Toggle Lights Off" },
        { name: "Run Backup" },
        { name: "Speak Text", expectsInput: true },
      ];
      await getModel();
      const exp = expected[index]!;
      const { assistant, context } = makeAssistant();
      await assistant.chat(prompt, { enableThinking: THINKING, onToken: () => {} });
      const calls = runCalls(context);
      const matched = calls.find((c) => c.args.name === exp.name);
      if (!matched) {
        throw new Error(`picked [${calls.map((c) => c.args.name ?? "?").join(", ") || "none"}]`);
      }
      if (exp.expectsInput) {
        const v = matched.args.input;
        if (!v || String(v).trim().length === 0) throw new Error("input was empty");
      }
      return { detail: `→ ${exp.name}` };
    },
  });

  // ─── B. Naming variation (intent-default selection) ───────────

  scenario("naming variation — intent + default", {
    threshold: [4, 6],
    prompts: [
      "remind me to take out the trash tomorrow",
      "put dinner with mum on my calendar for friday",
      "add 'don't forget the milk' to my Bear notes",
      "create a note",
      "make a quick note",
      "save a note",
    ],
    judge: async ({ prompt, index }) => {
      const expected = [
        "Set Reminder",
        "Add to Calendar",
        "Add to Bear Note",
        "Create Note with Date",
        "Create Note with Date",
        "Create Note with Date",
      ];
      await getModel();
      const want = expected[index]!;
      const { assistant, context } = makeAssistant();
      await assistant.chat(prompt, { enableThinking: THINKING, onToken: () => {} });
      const calls = runCalls(context);
      const success = calls.find((c) => c.result.startsWith("Ran"));
      if (!success || success.args.name !== want) {
        throw new Error(`picked [${calls.map((c) => c.args.name ?? "?").join(" → ") || "none"}]`);
      }
      return { detail: `→ ${want}` };
    },
  });

  // ─── C. Content pass-through ──────────────────────────────────

  scenario("content pass-through", {
    threshold: [2, 3],
    prompts: [
      "create a note that says today went really well, finished the eval",
      "send 'on my way home' to mum",
      "speak the words 'system check complete' out loud",
    ],
    judge: async ({ prompt, index }) => {
      const expected: Array<{ name: string; mustContain: RegExp[] }> = [
        { name: "Create Note with Date", mustContain: [/today went/i, /eval/i] },
        { name: "Send iMessage",         mustContain: [/on my way home/i] },
        { name: "Speak Text",            mustContain: [/system check complete/i] },
      ];
      await getModel();
      const exp = expected[index]!;
      const { assistant, context } = makeAssistant({ notes_app: "Create Note with Date" });
      await assistant.chat(prompt, { enableThinking: THINKING, onToken: () => {} });
      const calls = runCalls(context);
      const matched = calls.find((c) => c.args.name === exp.name && typeof c.args.input === "string");
      if (!matched) {
        throw new Error(`wrong/no run_shortcut: [${calls.map((c) => c.args.name ?? "?").join(", ") || "none"}]`);
      }
      const input = (matched.args.input as string) ?? "";
      const missing = exp.mustContain.filter((re) => !re.test(input));
      if (missing.length > 0) {
        throw new Error(`input missing ${missing.map((r) => r.source).join(", ")}; got "${input.slice(0, 60)}"`);
      }
      return { detail: `input="${input.slice(0, 60)}…"` };
    },
  });

  // ─── D. Rich content ──────────────────────────────────────────

  function isMarkdownChecklist(input: string, minItems: number) {
    const lines = input.match(/^\s*[-*]\s*\[\s*[xX ]?\s*\]/gm) ?? [];
    if (lines.length < minItems) throw new Error(`${lines.length} checkbox lines (need ≥${minItems})`);
  }
  function isNumberedList(input: string, minItems: number) {
    const lines = input.match(/^\s*\d+[.)]\s+\S+/gm) ?? [];
    if (lines.length < minItems) throw new Error(`${lines.length} numbered lines (need ≥${minItems})`);
  }

  scenario("rich content (todo / numbered / checklist)", {
    threshold: [2, 3],
    prompts: [
      "create a note with a todo list of ingredients to make spaghetti bolognaise",
      "create a note with a numbered list of steps to brew a v60 pourover",
      "create a note with a packing checklist for a weekend trip",
    ],
    judge: async ({ prompt, index }) => {
      await getModel();
      const { assistant, context } = makeAssistant({ notes_app: "Create Note with Date" });
      await assistant.chat(prompt, { enableThinking: THINKING, onToken: () => {} });
      const calls = runCalls(context);
      const matched = calls.find((c) => c.args.name === "Create Note with Date" && typeof c.args.input === "string");
      if (!matched) {
        throw new Error(`no run_shortcut(Create Note with Date) — saw [${calls.map((c) => c.args.name).join(", ") || "none"}]`);
      }
      const input = matched.args.input as string;
      if (index === 0) {
        isMarkdownChecklist(input, 5);
        if (!/(beef|mince|tomato|onion|garlic|pasta|spaghetti|carrot|celery)/i.test(input)) {
          throw new Error("no recognisable ingredient terms");
        }
      } else if (index === 1) {
        isNumberedList(input, 4);
      } else {
        isMarkdownChecklist(input, 5);
      }
      return { detail: `${input.split("\n").length} lines` };
    },
  });

  // ─── E. Chains ────────────────────────────────────────────────

  scenario("multi-step chains", {
    threshold: [1, 2],
    prompts: [
      "create a note with the lasagna ingredients then start a 30 minute timer",
      "remind me to take my meds at 8am and add it to my calendar too",
    ],
    judge: async ({ prompt, index }) => {
      const expected: string[][] = [
        ["Create Note with Date", "Start Pomodoro Timer"],
        ["Set Reminder", "Add to Calendar"],
      ];
      await getModel();
      const want = expected[index]!;
      const { assistant, context } = makeAssistant({ notes_app: "Create Note with Date" });
      await assistant.chat(prompt, { maxSteps: 8, enableThinking: THINKING, onToken: () => {} });
      const calls = runCalls(context);
      const ran = calls.filter((c) => c.result.startsWith("Ran")).map((c) => String(c.args.name ?? ""));
      if (!want.every((n) => ran.includes(n))) {
        throw new Error(`got [${ran.join(", ")}]; expected [${want.join(", ")}]`);
      }
      return { detail: `→ ${ran.join(" → ")}` };
    },
  });

  // ─── F. Skip / refusal ────────────────────────────────────────

  scenario("skip / refusal — no run_shortcut should fire", {
    threshold: [3, 3],
    prompts: [
      "what time is it?",
      "what's 2 plus 2?",
      "send a tweet saying hello world",
    ],
    judge: async ({ prompt }) => {
      await getModel();
      const { assistant, mock } = makeAssistant();
      await assistant.chat(prompt, { enableThinking: THINKING, onToken: () => {} });
      if (mock.runCalls.length > 0) {
        throw new Error(`unexpectedly ran: [${mock.runCalls.map((c) => c.name).join(", ")}]`);
      }
      return { detail: "no run_shortcut" };
    },
  });

});
