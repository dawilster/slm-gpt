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
 *   /profile             show stored facts about the user
 *   /forget <key>        remove a fact from the profile
 *   /reindex             rebuild the corpus index over notes + sessions
 *   /corpus              list the indexed sources
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
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { OpenAICompatClient, discoverModel, probeServerCapabilities } from "./client";
import { Context } from "./context";
import { Assistant } from "./assistant";
import { SessionStore, type Session } from "./sessions";
import {
  ToolRegistry,
  getCurrentTimeTool,
  makeForgetTool,
  makeListShortcutsTool,
  makeRememberTool,
  makeRunShortcutTool,
  makeSearchCorpusTool,
} from "./tools";
import { Profile } from "./profile";
import { EmbeddingClient, discoverEmbeddingModel } from "./embeddings";
import { IndexStore } from "./index_store";
import { indexAll } from "./indexer";
import { ShortcutsClient } from "./shortcuts";

const BASE_URL = process.env.MODEL_BASE_URL ?? "http://localhost:1234/v1";
const API_KEY = process.env.MODEL_API_KEY ?? "lm-studio";
const ASSISTANT_HOME = process.env.ASSISTANT_HOME ?? join(process.env.HOME ?? "", ".assistant");

// Base system prompt. The profile is appended dynamically (see buildSystemPrompt
// below) so new facts saved via the remember tool appear on the next turn.
//
// The memory rules below are deliberately verbose and example-driven. The
// terse one-liner version ("update facts when they change") missed implicit
// changes like "I don't like eggs anymore" at 4B scale (v5 eval supersession
// went 1/3). Explicit example phrases shifted that meaningfully.
const BASE_SYSTEM = [
  "You are a helpful personal assistant. Be concise and direct.",
  "If you don't know or don't remember something, say so plainly.",
  "Never invent facts about the user that weren't established in this conversation.",
  "Memory rules:",
  "- When the user states a stable fact about themselves (preference, name, location, relationship), call remember(key, value).",
  "- When the user signals a change to a known fact — including phrasings like 'I don't like X anymore', 'I now prefer Y', 'I take it Z now', 'actually, I W' — call remember(key, value) with the NEW value to overwrite the old one. Don't just acknowledge verbally; call the tool.",
  "- Only call forget(key) if the fact no longer applies AND has no replacement.",
  "Retrieval rules:",
  "- DEFAULT TO RETRIEVAL for QUESTIONS about the user's content. Skip search_corpus for action requests ('create/run/start/do X') — act, don't retrieve.",
  "- This applies even to questions that *look* like general knowledge: 'what is X', 'how does Y work', 'tell me about Z' — the user may have notes on X/Y/Z. Search first, then synthesize. If nothing relevant comes back, then answer from general knowledge AND say so.",
  "- Never call search_corpus twice with the same query in one turn — one retrieval is the answer.",
  "Action rules:",
  "- All world-changing actions (creating notes, timers, reminders, launching apps) go through run_shortcut(name, input?). You have no other write surface.",
  "- When the user provides content for the action ('create a note WITH the list', 'set a timer FOR 20 min'), pass that content as `input`. Never call run_shortcut with no input when the user gave you content — the shortcut will prompt them, defeating the point.",
  "- If you don't know the exact shortcut name, call list_shortcuts first, then run_shortcut with the closest match.",
  "- Chain by calling run_shortcut once per step.",
].join("\n");

function buildSystemPrompt(profile: Profile): string {
  const profileSection = profile.renderForSystemPrompt();
  return profileSection ? `${BASE_SYSTEM}\n\n${profileSection}` : BASE_SYSTEM;
}

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

  const profile = await Profile.load(join(ASSISTANT_HOME, "profile.json"));

  const client = new OpenAICompatClient({ baseURL: BASE_URL, apiKey: API_KEY, model: modelId });
  const context = new Context({ systemPrompt: buildSystemPrompt(profile), budget: DEFAULT_BUDGET });
  const store = new SessionStore(join(ASSISTANT_HOME, "sessions"));
  await store.ensure();

  // Notes folder + tool registry. v6 adds the search_corpus tool for
  // semantic retrieval over notes + past sessions (8 tools total). The
  // embedding client targets the same LM Studio endpoint as the chat model.
  const notesRoot = join(ASSISTANT_HOME, "notes");
  const sessionsRoot = join(ASSISTANT_HOME, "sessions");
  await mkdir(notesRoot, { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });

  const embeddingModel = await discoverEmbeddingModel(BASE_URL, API_KEY);
  let indexStore: IndexStore | null = null;
  let embedder: EmbeddingClient | null = null;
  if (embeddingModel) {
    embedder = new EmbeddingClient({ baseURL: BASE_URL, apiKey: API_KEY, model: embeddingModel });
    indexStore = new IndexStore(join(ASSISTANT_HOME, "index.sqlite"));
  } else {
    console.warn("⚠ no embedding model loaded at " + BASE_URL + " — search_corpus disabled.");
    console.warn("  Load text-embedding-nomic-embed-text-v1.5 in LM Studio to enable RAG.\n");
  }

  const shortcuts = new ShortcutsClient();

  const registry = new ToolRegistry();
  registry.register(getCurrentTimeTool);
  registry.register(makeRememberTool(profile));
  registry.register(makeForgetTool(profile));
  registry.register(makeListShortcutsTool(shortcuts));
  registry.register(makeRunShortcutTool(shortcuts));
  if (indexStore && embedder) {
    registry.register(makeSearchCorpusTool({ store: indexStore, embedder }));
  }

  // Decide initial session based on CLI args.
  let session: Session;
  const mode = parseArgs(process.argv);
  if (mode.kind === "resume") {
    const recent = (await store.list(1))[0];
    if (recent) {
      const turns = await store.loadTurns(recent.id);
      context.restore(turns);
      // Profile is current truth — override whatever system prompt was
      // persisted with this session at its original creation time.
      context.setSystemPrompt(buildSystemPrompt(profile));
      session = store.open(recent.id);
      console.log(`resumed session ${recent.id} (${turns.length} turns from ${recent.startedAt})`);
    } else {
      session = await freshSession(store, profile);
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
    context.setSystemPrompt(buildSystemPrompt(profile));
    session = store.open(id);
    console.log(`loaded session ${id} (${turns.length} turns)`);
  } else {
    session = await freshSession(store, profile);
  }

  const assistant = new Assistant(context, client, session, registry);

  // Lazy on-launch indexing. Skip the currently-open session — it's mid-write
  // and already in chat context, so indexing it now would be redundant. It
  // gets picked up on the next launch.
  if (indexStore && embedder) {
    try {
      const r = await indexAll({
        store: indexStore,
        embedder,
        notesRoot,
        sessionsRoot,
        excludeSessionId: session.id,
      });
      const indexedSomething = r.notesIndexed + r.sessionsIndexed > 0;
      if (indexedSomething) {
        console.log(
          `[index] +${r.chunksAdded} chunks  (${r.notesIndexed} notes, ${r.sessionsIndexed} sessions, ${r.skipped} unchanged)`,
        );
      }
    } catch (e: any) {
      console.warn(`[index] failed: ${e?.message ?? e} — search_corpus may return stale or empty results`);
    }
  }

  const ctxNote = caps ? `  ·  server ctx: ${caps.contextLimit}` : "";
  const indexNote = indexStore ? `  ·  corpus: ${indexStore.chunkCount()} chunks` : "  ·  corpus: off";
  console.log(`assistant v6  ·  model: ${modelId}  ·  budget: ${DEFAULT_BUDGET}${ctxNote}`);
  console.log(`session: ${session.id}  ·  tools: ${registry.size()}  ·  profile: ${profile.size()} facts${indexNote}`);
  console.log("commands: /quit  /clear  /new  /history  /tokens  /context  /budget [n]  /sessions  /load <id>  /resume  /tools  /profile  /forget <key>  /reindex  /corpus\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    const input = (await rl.question("you: ")).trim();
    if (!input) continue;

    if (input === "/quit") break;

    if (input === "/clear" || input === "/new") {
      context.clear();
      // Re-render in case profile changed since startup (e.g. via tool calls
      // in the previous session). Cheap; correctness is worth it.
      context.setSystemPrompt(buildSystemPrompt(profile));
      const fresh = await freshSession(store, profile);
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
      context.setSystemPrompt(buildSystemPrompt(profile));
      assistant.setSession(store.open(id));
      console.log(`  loaded ${id} (${turns.length} turns)\n`);
      continue;
    }

    if (input === "/reindex") {
      if (!indexStore || !embedder) {
        console.log("  (corpus indexing is off — no embedding model loaded)\n");
        continue;
      }
      try {
        const r = await indexAll({
          store: indexStore,
          embedder,
          notesRoot,
          sessionsRoot,
          excludeSessionId: assistant.sessionId ?? undefined,
        });
        console.log(
          `  reindexed: +${r.chunksAdded} chunks  (${r.notesIndexed} notes, ${r.sessionsIndexed} sessions, ${r.skipped} unchanged)\n`,
        );
      } catch (e: any) {
        console.log(`  [error] ${e?.message ?? e}\n`);
      }
      continue;
    }

    if (input === "/corpus") {
      if (!indexStore) {
        console.log("  (corpus indexing is off)\n");
        continue;
      }
      const sources = indexStore.listSources();
      console.log(`  ${indexStore.chunkCount()} chunks across ${sources.length} sources:`);
      for (const s of sources) {
        console.log(`    [${s.source_type}] ${s.source_path}`);
      }
      console.log();
      continue;
    }

    if (input === "/profile") {
      if (profile.size() === 0) {
        console.log("  (no facts saved)\n");
      } else {
        for (const [k, v] of profile.entries()) {
          console.log(`  ${k}: ${v}`);
        }
        console.log(`  (${profile.size()} facts at ${profile.path})\n`);
      }
      continue;
    }

    if (input.startsWith("/forget")) {
      const parts = input.split(/\s+/);
      if (parts.length < 2 || !parts[1]) {
        console.log("  usage: /forget <key>\n");
        continue;
      }
      const key = parts.slice(1).join(" ");
      const removed = profile.delete(key);
      if (!removed) {
        console.log(`  no fact under '${Profile.normalizeKey(key)}'\n`);
      } else {
        await profile.save();
        context.setSystemPrompt(buildSystemPrompt(profile));
        console.log(`  forgot '${Profile.normalizeKey(key)}'\n`);
      }
      continue;
    }

    if (input === "/tools") {
      const tools = registry.list();
      if (tools.length === 0) {
        console.log("  (no tools registered)\n");
      } else {
        for (const t of tools) {
          const params = Object.keys(t.definition.parameters.properties);
          const sig = params.length === 0 ? "()" : `(${params.join(", ")})`;
          console.log(`  ${t.definition.name}${sig}`);
          console.log(`     ${t.definition.description.slice(0, 100)}${t.definition.description.length > 100 ? "…" : ""}`);
        }
        console.log();
      }
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
      context.setSystemPrompt(buildSystemPrompt(profile));
      assistant.setSession(store.open(candidate.id));
      console.log(`  resumed ${candidate.id} (${turns.length} turns)\n`);
      continue;
    }

    // Refresh the system prompt before each turn so any facts written via
    // remember/forget on the previous turn become "always known" now. The
    // model only sees the system prompt at the start of each request, so
    // updating in-place between requests is the cheapest correct option.
    context.setSystemPrompt(buildSystemPrompt(profile));

    try {
      const r = await assistant.chat(input, { onToolCall: printToolCall });
      console.log(`\nassistant: ${r.reply}`);
      const trimNote = r.trimmed ? `  ⚠ trimmed: sent ${r.sentMessages} of ${r.totalMessages}` : "";
      const toolNote = r.toolCallsExecuted > 0 ? `  tools=${r.toolCallsExecuted}  steps=${r.steps}` : "";
      console.log(
        `  └─ prompt_tokens=${r.promptTokens}  completion_tokens=${r.completionTokens}  ` +
          `latency=${r.latencyMs}ms${toolNote}${trimNote}\n`,
      );
    } catch (e: any) {
      console.log(`[error] ${e?.message ?? e}\n`);
    }
  }

  rl.close();
}

async function freshSession(store: SessionStore, profile: Profile): Promise<Session> {
  const s = store.newSession();
  // Persist the system prompt as it stands now (with current profile facts)
  // so a future restore reproduces the original conversation faithfully.
  await s.append({ role: "system", content: buildSystemPrompt(profile) });
  return s;
}

/**
 * REPL-side tool-call observer. Prints one line per tool execution as it
 * happens, between the user's input and the model's final reply. Without
 * this, multi-step tool flows (list_notes → read_note → reply) were
 * invisible — you'd see only the final synthesis with no idea what the
 * model actually did to get there.
 *
 * Args are abbreviated: object keys/values are truncated to ~60 chars to
 * keep the line scannable. Errors get a different prefix so they jump out.
 */
function printToolCall(info: {
  step: number;
  name: string;
  args: Record<string, unknown> | null;
  result: string;
  latencyMs: number;
  isError: boolean;
}): void {
  const argsStr = info.args === null
    ? "<malformed args>"
    : Object.keys(info.args).length === 0
    ? ""
    : Object.entries(info.args)
        .map(([k, v]) => {
          const s = typeof v === "string" ? v : JSON.stringify(v);
          const trimmed = s.length > 40 ? s.slice(0, 40) + "…" : s;
          return `${k}: ${trimmed}`;
        })
        .join(", ");
  const resultPreview = info.result
    .replace(/\n/g, " ")
    .slice(0, 70);
  const truncated = info.result.length > 70 ? "…" : "";
  const prefix = info.isError ? "  ✗" : "  ·";
  console.log(`${prefix} ${info.name}(${argsStr}) → ${resultPreview}${truncated}  [${info.latencyMs}ms · step ${info.step}]`);
}

main();
