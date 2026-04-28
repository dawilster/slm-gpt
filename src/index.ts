/**
 * Entry point — wires the assistant together and runs the REPL.
 *
 * Slash commands:
 *   /quit                exit
 *   /clear /new          start a fresh session (current is closed; preserved on disk)
 *   /history             dump message array
 *   /tokens              cumulative token counts
 *   /context             snapshot of context budget vs use
 *   /budget [n]          show or set the token budget
 *   /sessions            list recent saved sessions
 *   /load <id-prefix>    switch to a saved session
 *   /resume              load the most recent session that isn't the current one
 *
 * CLI flags:
 *   --resume             start by loading the most recent saved session
 *   --load <id-prefix>   start by loading a specific session
 *
 * Env:
 *   MODEL_BASE_URL     default http://localhost:1234/v1
 *   MODEL_API_KEY      default lm-studio
 *   CONTEXT_BUDGET     default 4096
 *   ASSISTANT_HOME     override session storage location (default ~/.assistant)
 */

import * as readline from "node:readline/promises";
import { join } from "node:path";
import { OpenAICompatClient, discoverModel, probeServerCapabilities } from "./client";
import { Context } from "./context";
import { Assistant } from "./assistant";
import { SessionStore, type Session } from "./sessions";

const BASE_URL = process.env.MODEL_BASE_URL ?? "http://localhost:1234/v1";
const API_KEY = process.env.MODEL_API_KEY ?? "lm-studio";
const ASSISTANT_HOME = process.env.ASSISTANT_HOME ?? join(process.env.HOME ?? "", ".assistant");

const SYSTEM = [
  "You are a helpful personal assistant. Be concise and direct.",
  "If you don't know or don't remember something, say so plainly.",
  "Never invent facts about the user that weren't established in this conversation.",
].join(" ");

const DEFAULT_BUDGET = Number(process.env.CONTEXT_BUDGET ?? 4096);

type StartupMode =
  | { kind: "new" }
  | { kind: "resume" }
  | { kind: "load"; idPrefix: string };

function parseArgs(argv: string[]): StartupMode {
  const args = argv.slice(2);
  if (args[0] === "--resume") return { kind: "resume" };
  if (args[0] === "--load" && args[1]) return { kind: "load", idPrefix: args[1] };
  return { kind: "new" };
}

async function main() {
  let modelId: string;
  try {
    modelId = await discoverModel(BASE_URL, API_KEY);
  } catch {
    console.error(`Could not reach model server at ${BASE_URL}.`);
    console.error("Start LM Studio's Developer server, or set MODEL_BASE_URL.");
    process.exit(1);
  }

  const caps = await probeServerCapabilities(BASE_URL);
  if (caps && DEFAULT_BUDGET > caps.contextLimit) {
    console.warn(
      `\n⚠ context budget (${DEFAULT_BUDGET}) exceeds server's loaded context length (${caps.contextLimit}).` +
        ` Server will silently truncate the prompt.`,
    );
    console.warn(`  Fix: lower CONTEXT_BUDGET, or raise context length in LM Studio and reload.\n`);
  }

  const client = new OpenAICompatClient({ baseURL: BASE_URL, apiKey: API_KEY, model: modelId });
  const context = new Context({ systemPrompt: SYSTEM, budget: DEFAULT_BUDGET });
  const store = new SessionStore(join(ASSISTANT_HOME, "sessions"));
  await store.ensure();

  // Decide initial session based on CLI args.
  let session: Session;
  const mode = parseArgs(process.argv);
  if (mode.kind === "resume") {
    const recent = (await store.list(1))[0];
    if (recent) {
      const turns = await store.loadTurns(recent.id);
      context.restore(turns);
      session = store.open(recent.id);
      console.log(`resumed session ${recent.id} (${turns.length} turns from ${recent.startedAt})`);
    } else {
      session = await freshSession(store);
      console.log(`(no prior session to resume — started new ${session.id})`);
    }
  } else if (mode.kind === "load") {
    const id = await store.findByPrefix(mode.idPrefix);
    if (!id) {
      console.error(`no session matching prefix '${mode.idPrefix}'`);
      process.exit(1);
    }
    const turns = await store.loadTurns(id);
    context.restore(turns);
    session = store.open(id);
    console.log(`loaded session ${id} (${turns.length} turns)`);
  } else {
    session = await freshSession(store);
  }

  const assistant = new Assistant(context, client, session);

  const ctxNote = caps ? `  ·  server ctx: ${caps.contextLimit}` : "";
  console.log(`assistant v2  ·  model: ${modelId}  ·  budget: ${DEFAULT_BUDGET}${ctxNote}`);
  console.log(`session: ${session.id}`);
  console.log("commands: /quit  /clear  /new  /history  /tokens  /context  /budget [n]  /sessions  /load <id>  /resume\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    const input = (await rl.question("you: ")).trim();
    if (!input) continue;

    if (input === "/quit") break;

    if (input === "/clear" || input === "/new") {
      context.clear();
      const fresh = await freshSession(store);
      assistant.setSession(fresh);
      console.log(`[new session ${fresh.id}]\n`);
      continue;
    }

    if (input === "/history") {
      const all = context.all();
      all.forEach((m, i) => {
        const preview = m.content.replace(/\n/g, " ").slice(0, 90);
        console.log(`  ${String(i).padStart(2)} [${m.role.padEnd(9)}] ${preview}`);
      });
      console.log();
      continue;
    }

    if (input === "/tokens") {
      const s = context.snapshot();
      console.log(`  cumulative: in=${s.cumulativeIn}  out=${s.cumulativeOut}  total=${s.cumulativeIn + s.cumulativeOut}`);
      console.log(`  history: ${s.historyCount} messages  est. prompt: ~${s.estimatedPromptTokens} tokens (budget ${s.budget})\n`);
      continue;
    }

    if (input === "/context") {
      const s = context.snapshot();
      const wouldSend = context.messagesForRequest().length;
      const wouldTrim = context.wouldTrim();
      console.log(`  total: ${s.historyCount + 1} messages (incl. system)`);
      console.log(`  would send: ${wouldSend}${wouldTrim ? "  (trimmed)" : ""}`);
      console.log(`  budget: ${s.budget}  reserved for response: ${s.reservedForResponse}\n`);
      continue;
    }

    if (input.startsWith("/budget")) {
      const parts = input.split(/\s+/);
      if (parts.length === 1) {
        console.log(`  current budget: ${context.budget}\n`);
      } else {
        const n = Number(parts[1]);
        if (!Number.isFinite(n) || n <= 0) {
          console.log("  usage: /budget [positive number]\n");
        } else {
          context.budget = n;
          console.log(`  budget set to ${n}\n`);
        }
      }
      continue;
    }

    if (input === "/sessions") {
      const list = await store.list(10);
      if (list.length === 0) {
        console.log("  (no saved sessions)\n");
      } else {
        for (const s of list) {
          const marker = s.id === assistant.sessionId ? "*" : " ";
          const preview = s.firstUserMessage ?? "(no user turns yet)";
          console.log(`  ${marker} ${s.id}  turns=${s.turnCount.toString().padStart(3)}  ${preview}`);
        }
        console.log();
      }
      continue;
    }

    if (input.startsWith("/load")) {
      const parts = input.split(/\s+/);
      if (parts.length < 2 || !parts[1]) {
        console.log("  usage: /load <id-prefix>\n");
        continue;
      }
      const id = await store.findByPrefix(parts[1]);
      if (!id) {
        console.log(`  no session matching '${parts[1]}'\n`);
        continue;
      }
      const turns = await store.loadTurns(id);
      context.restore(turns);
      assistant.setSession(store.open(id));
      console.log(`  loaded ${id} (${turns.length} turns)\n`);
      continue;
    }

    if (input === "/resume") {
      const list = await store.list(10);
      const candidate = list.find((s) => s.id !== assistant.sessionId);
      if (!candidate) {
        console.log("  (no other sessions to resume)\n");
        continue;
      }
      const turns = await store.loadTurns(candidate.id);
      context.restore(turns);
      assistant.setSession(store.open(candidate.id));
      console.log(`  resumed ${candidate.id} (${turns.length} turns)\n`);
      continue;
    }

    try {
      const r = await assistant.chat(input);
      console.log(`\nassistant: ${r.reply}`);
      const trimNote = r.trimmed ? `  ⚠ trimmed: sent ${r.sentMessages} of ${r.totalMessages}` : "";
      console.log(
        `  └─ prompt_tokens=${r.promptTokens}  completion_tokens=${r.completionTokens}  ` +
          `latency=${r.latencyMs}ms${trimNote}\n`,
      );
    } catch (e: any) {
      console.log(`[error] ${e?.message ?? e}\n`);
    }
  }

  rl.close();
}

async function freshSession(store: SessionStore): Promise<Session> {
  const s = store.newSession();
  await s.append({ role: "system", content: SYSTEM });
  return s;
}

main();
