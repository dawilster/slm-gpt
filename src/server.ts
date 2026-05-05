/**
 * HTTP bridge for the Halo Mac app.
 *
 * Exposes the existing Assistant + tools + RAG over a tiny SSE API so the
 * SwiftUI app can drive a real chat against the local model loaded in
 * LM Studio (or any OpenAI-compatible endpoint).
 *
 * Endpoints:
 *   GET  /v1/health             — { ok, model, port, embeddings, sessions }
 *   GET  /v1/sessions           — list of recent saved sessions
 *   GET  /v1/profile            — every fact the assistant remembers
 *   DELETE /v1/profile/<key>    — forget a single fact
 *   GET  /v1/shortcuts          — { shortcuts: [{name}], cachedAt, fromCache }
 *   POST /v1/chat               — { message, sessionId? } → SSE stream:
 *       event: session   { sessionId }
 *       event: status    { state: "thinking" }
 *       event: thinking  { text }              ← reasoning content delta (Qwen-3.5 thinking mode)
 *       event: tool      { step, name, args, result, latencyMs, isError }
 *       event: token     { text }              ← reply text delta
 *       event: done      { promptTokens, completionTokens, latencyMs, steps,
 *                          toolCallsExecuted, thinkingChars }
 *       event: error     { message }
 *
 * Token-by-token streaming will land later — the `token` event is shaped so
 * the wire protocol won't have to change when it does.
 *
 * Bootstrap mirrors `src/index.ts` so the server has the same model, tools,
 * profile, and corpus the REPL has.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { OpenAICompatClient, discoverModel, probeServerCapabilities } from "./client";
import type { ToolCallReq } from "./client";
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
import { ShortcutsClient } from "./shortcuts";
import { ShortcutMetaStore, makeClassifier } from "./shortcut_meta";
import { EventLog } from "./events";

// ─── Config ──────────────────────────────────────────────

const PORT          = Number(process.env.HALO_PORT ?? 7878);
const BASE_URL      = process.env.MODEL_BASE_URL ?? "http://localhost:1234/v1";
const API_KEY       = process.env.MODEL_API_KEY ?? "lm-studio";
const ASSISTANT_HOME = process.env.ASSISTANT_HOME ?? join(process.env.HOME ?? "", ".assistant");
const DEFAULT_BUDGET = Number(process.env.CONTEXT_BUDGET ?? 4096);
const QUIET          = process.env.HALO_LOG_QUIET === "1";
const THINKING       = process.env.HALO_THINKING === "1";

// Death-pact with the parent (the Mac app). When the runtime is spawned by
// HaloApp, HALO_PARENT_PID is set to the app's pid. We poll that pid every
// 2s and exit cleanly if the parent is gone — guards against the parent
// crashing or being SIGKILLed without a chance to tear us down (in which
// case the OS reparents us to launchd and we'd otherwise live forever).
//
// kill(pid, 0) with signal 0 doesn't actually send a signal — it only
// checks whether the target exists and we have permission to signal it.
// ESRCH means "no such process" → parent is gone.
const PARENT_PID = Number(process.env.HALO_PARENT_PID ?? 0) || null;
if (PARENT_PID !== null) {
  setInterval(() => {
    try {
      process.kill(PARENT_PID, 0);
    } catch {
      console.error(`[halo ${ts()}] parent pid ${PARENT_PID} is gone — exiting`);
      process.exit(0);
    }
  }, 2000).unref();
}

// ─── Logging ─────────────────────────────────────────────

/** HH:MM:SS.sss — keeps log lines grep-able without taking too much width. */
function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

/** First 8 chars of a session id, padded for column alignment. */
function shortSid(sid: string | null | undefined): string {
  if (!sid) return "—       ";
  return (sid.length > 8 ? sid.slice(0, 8) : sid).padEnd(8);
}

/** Single-line preview of any text — collapses whitespace, truncates. */
function preview(s: string, max = 80): string {
  const oneline = s.replace(/\s+/g, " ").trim();
  return oneline.length <= max ? oneline : oneline.slice(0, max - 1) + "…";
}

/** Compact rendering of tool args: "name='x' input=42 chars". */
function fmtArgs(args: Record<string, unknown> | null): string {
  if (args === null) return "<malformed args>";
  const keys = Object.keys(args);
  if (keys.length === 0) return "()";
  return keys.map((k) => {
    const v = args[k];
    if (typeof v === "string") {
      return v.length > 40 ? `${k}=${v.length} chars` : `${k}=${JSON.stringify(v)}`;
    }
    return `${k}=${JSON.stringify(v)}`;
  }).join(", ");
}

function log(...parts: unknown[]): void {
  if (QUIET) return;
  console.log(`[halo ${ts()}]`, ...parts);
}

function logErr(...parts: unknown[]): void {
  console.error(`[halo ${ts()}] ✗`, ...parts);
}

let requestCounter = 0;

// ─── LM Studio CLI probe (model size, params, quant) ─────
//
// LM Studio's HTTP `/api/v0/models` endpoint exposes context length and
// quant name, but not the loaded-model file size or parameter count. The
// `lms` CLI does — `lms ps --json` returns a per-model object with
// `sizeBytes`, `paramsString`, and friends. We shell out, cache the
// result for a few seconds, and serve the merged shape on /v1/health.
//
// **Disabled by default.** Two reasons:
//   1. Invoking the `lms` binary triggers macOS to auto-launch LM Studio
//      (LM Studio registers a launch agent that wakes the GUI on `lms`
//      use). That's correct for someone using LM Studio as their model
//      backend — wrong for someone using our bundled server, who'd see
//      LM Studio pop up every time the Mac app boots.
//   2. `lms ps` is an IPC call to LM Studio. While LM Studio is cold-
//      starting (~30s), the call blocks. /v1/health then blocks, the
//      Mac app's URLSession probe times out at 60s, and the menubar
//      flips to "Offline" even though chat works fine.
//
// Opt back in with `HALO_USE_LMS=1` if you actually use LM Studio. In
// bundled mode (the Mac app's default), size/params/quant come from
// HALO_MODEL_* env vars the Mac app sets from the catalog manifest —
// see the boot-time read of MODEL_META below.
const LMS_ENABLED = process.env.HALO_USE_LMS === "1";

// ─── Catalog metadata from spawn env ─────────────────────
//
// In bundled mode the Mac app spawns the harness with model metadata
// pulled straight from catalog.json — size in bytes, params string
// ("1.7B"), quant ("4-bit MLX"), display name. We surface these on
// /v1/health so the menubar's Speed/RAM/Context block populates
// without needing the lms probe.
//
// Empty/missing → null on the wire. The Mac app already gracefully
// renders "—" for nulls.
type ModelMeta = {
  displayName: string | null;
  paramsString: string | null;
  quantization: string | null;
  sizeBytes: number | null;
};
const MODEL_META: ModelMeta = {
  displayName: process.env.HALO_MODEL_DISPLAY_NAME || null,
  paramsString: process.env.HALO_MODEL_PARAMS || null,
  quantization: process.env.HALO_MODEL_QUANT || null,
  sizeBytes: process.env.HALO_MODEL_SIZE_BYTES
    ? Number(process.env.HALO_MODEL_SIZE_BYTES) || null
    : null,
};

type LoadedModelInfo = {
  identifier: string;       // matches the OpenAI-compat model id
  displayName: string;
  paramsString: string | null;
  quantization: string | null;
  sizeBytes: number;
  contextLength: number;
  status: string;
};

// Loaded-model info is essentially static for the lifetime of an LM Studio
// load — sizeBytes, paramsString, and the configured context don't drift.
// Cache long so we're not spawning `lms` on every health probe.
const LMS_CACHE_TTL_MS = 60_000;
let lmsCache: { at: number; data: LoadedModelInfo[] } | null = null;
let lmsBinResolved: string | null = null;

function resolveLmsBin(): string {
  if (lmsBinResolved) return lmsBinResolved;
  const override = process.env.LMS_BIN;
  if (override && existsSync(override)) { lmsBinResolved = override; return override; }
  const home = homedir();
  for (const p of [`${home}/.lmstudio/bin/lms`, `${home}/.cache/lm-studio/bin/lms`]) {
    if (existsSync(p)) { lmsBinResolved = p; return p; }
  }
  // Last resort — let Bun.spawn resolve via PATH; if that fails the probe
  // returns [] and we serve null fields, which the client renders as "—".
  lmsBinResolved = "lms";
  return "lms";
}

async function probeLoadedModels(): Promise<LoadedModelInfo[]> {
  // Disabled by default — see LMS_ENABLED comment above for why.
  // In bundled mode the menubar stats come from MODEL_META instead.
  if (!LMS_ENABLED) return [];

  const now = Date.now();
  if (lmsCache && now - lmsCache.at < LMS_CACHE_TTL_MS) return lmsCache.data;

  let data: LoadedModelInfo[] = [];
  try {
    const proc = Bun.spawn([resolveLmsBin(), "ps", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    if (code === 0 && stdout.trim().length > 0) {
      const arr = JSON.parse(stdout) as Array<any>;
      data = arr
        .filter((m) => m && m.type !== "embeddings")
        .map((m) => ({
          identifier: String(m.identifier ?? m.modelKey ?? ""),
          displayName: String(m.displayName ?? m.modelKey ?? ""),
          paramsString: typeof m.paramsString === "string" ? m.paramsString : null,
          quantization: typeof m.quantization?.name === "string" ? m.quantization.name : null,
          sizeBytes: Number(m.sizeBytes ?? 0),
          contextLength: Number(m.contextLength ?? m.maxContextLength ?? 0),
          status: String(m.status ?? "unknown"),
        }));
    }
  } catch {
    // lms not installed / not on PATH / json schema drift — fall through to []
  }
  lmsCache = { at: now, data };
  return data;
}

function findLoadedModel(modelId: string, models: LoadedModelInfo[]): LoadedModelInfo | null {
  return models.find((m) => m.identifier === modelId) ?? models[0] ?? null;
}

// ─── Rolling tok/s tracker ───────────────────────────────
//
// Updated after each chat turn — the client polls /v1/health and shows
// the rolling avg as the "Speed" stat. Bounded buffer so a slow run
// from hours ago can't pollute the displayed number once you've used
// the assistant a few times since. The UI shows this as "~N tok/s" to
// signal it's an average across recent turns, not the instantaneous
// rate of the current generation.

const TPS_BUFFER_SIZE = 10;
const tpsBuffer: number[] = [];

function recordTps(tps: number): void {
  if (!Number.isFinite(tps) || tps <= 0) return;
  tpsBuffer.push(tps);
  if (tpsBuffer.length > TPS_BUFFER_SIZE) tpsBuffer.shift();
}

function avgTps(): number | null {
  if (tpsBuffer.length === 0) return null;
  let sum = 0;
  for (const v of tpsBuffer) sum += v;
  return sum / tpsBuffer.length;
}

// Same base prompt as the REPL — kept in sync deliberately. If we move it to
// a shared module, both index.ts and server.ts should switch together.
const BASE_SYSTEM = [
  "You are a helpful personal assistant. Be concise and direct. If you don't know or don't remember, say so. Never invent facts about the user.",
  "Tools are real function calls — invoke them through the tool-call mechanism. Never write a tool name and arguments as plain text in your reply.",
  "Memory: invoke `remember(key, value)` when the user states a stable fact about themselves — preferences, identity, defaults. Action requests (notes, timers, reminders, calendar, lights, etc.) go through `run_shortcut`, never `remember`. Invoke `forget` only when a fact no longer applies and has no replacement.",
  "Retrieval: invoke `search_corpus` for questions about the user's content. Skip retrieval for action requests. Don't query the same thing twice in one turn.",
  "Actions: world-changing actions go through `run_shortcut(name, input?)`. Each shortcut in the list below carries an `intent` tag. Pick the shortcut whose intent matches the user's request; when two share an intent, prefer the one tagged `default`. Pass user-provided content as `input`. Chain by calling `run_shortcut` once per step.",
  "Output formats: todo list / checklist / checkboxes → format items as `- [ ] item`. Numbered steps → `1. step`. Otherwise plain prose.",
  "Recovery: when a tool returns an Error, immediately invoke the tool again with corrected arguments. Don't narrate intent.",
].join("\n");

// ─── Bootstrap (once on launch) ──────────────────────────

let modelId: string;
try {
  modelId = await discoverModel(BASE_URL, API_KEY);
} catch {
  logErr(`could not reach model server at ${BASE_URL}`);
  logErr(`start LM Studio's Developer server (or set MODEL_BASE_URL).`);
  process.exit(1);
}

const caps = await probeServerCapabilities(BASE_URL);
if (caps && DEFAULT_BUDGET > caps.contextLimit) {
  log(`⚠ context budget (${DEFAULT_BUDGET}) > server ctx (${caps.contextLimit}); will silently truncate`);
}

const profile = await Profile.load(join(ASSISTANT_HOME, "profile.json"));
const notesRoot    = join(ASSISTANT_HOME, "notes");
const sessionsRoot = join(ASSISTANT_HOME, "sessions");
await mkdir(notesRoot, { recursive: true });
await mkdir(sessionsRoot, { recursive: true });

// Append-only telemetry log. Captures things that don't already live in
// sessions/profile/notes (per-request timings, errors, tool-call detail,
// classifier outcomes). Surfaces nothing yet — this is observability for
// later analysis. See src/events.ts for the rationale.
const events = new EventLog(join(ASSISTANT_HOME, "events.sqlite"));

const store = new SessionStore(sessionsRoot);
await store.ensure();

const embeddingModelId = await discoverEmbeddingModel(BASE_URL, API_KEY);
let indexStore: IndexStore | null = null;
let embedder: EmbeddingClient | null = null;
if (embeddingModelId) {
  embedder = new EmbeddingClient({ baseURL: BASE_URL, apiKey: API_KEY, model: embeddingModelId });
  indexStore = new IndexStore(join(ASSISTANT_HOME, "index.sqlite"));
}

const shortcuts = new ShortcutsClient();

// Wire the metadata layer: each shortcut name carries an intent + default
// flag, so the model picks by intent matching rather than name guessing
// (see design.md §5.1 / §7 / §8 for the full rationale). The classifier is
// the same local model the brain uses — runs only on first sight of a name,
// almost never fires once a user's library is steady.
const metaPath = join(ASSISTANT_HOME, "shortcut-meta.json");
const metaStore = await ShortcutMetaStore.load(metaPath);
const metaClassifierClient = new OpenAICompatClient({ baseURL: BASE_URL, apiKey: API_KEY, model: modelId });
shortcuts.setMetaBinding({
  store: metaStore,
  classify: makeClassifier(metaClassifierClient),
  onSync: ({ added, removed, total }) => {
    if (added > 0 || removed > 0) {
      log(`shortcut-meta sync: +${added} -${removed}  (library has ${total})`);
      events.record("meta_change", { added, removed, libraryTotal: total });
    }
  },
});

// Prime the shortcuts cache so the very first system prompt build has the
// real names to inline. First call also classifies any new names against
// the meta store; subsequent calls within the 30s TTL just read the cache.
{
  const r = await shortcuts.list();
  if (!r.ok) {
    log(`⚠ couldn't prime shortcut list: ${r.error}`);
  } else {
    const tagged = r.shortcuts.filter((s) => s.intent && s.intent !== "other").length;
    const defaults = r.shortcuts.filter((s) => s.isDefault).length;
    log(`  shortcuts:   ${r.shortcuts.length} cached  ·  ${tagged} tagged with intent  ·  ${defaults} marked default`);
  }
}

const registry = new ToolRegistry();
registry.register(getCurrentTimeTool);
registry.register(makeRememberTool(profile));
registry.register(makeForgetTool(profile));
registry.register(makeListShortcutsTool(shortcuts));
registry.register(makeRunShortcutTool(shortcuts));
if (indexStore && embedder) {
  registry.register(makeSearchCorpusTool({ store: indexStore, embedder }));
}

function buildSystemPrompt(): string {
  const sections: string[] = [BASE_SYSTEM];

  // Profile facts — stable across turns when unchanged, so they sit cleanly
  // inside the prompt cache.
  const profileSection = profile.renderForSystemPrompt();
  if (profileSection) sections.push(profileSection);

  // Available shortcuts, rendered with intent + default flag from the meta
  // store. The model picks by intent matching, preferring entries marked
  // [default] when more than one shortcut shares an intent. This replaces
  // the library-specific examples we had earlier in BASE_SYSTEM.
  const entries = shortcuts.cachedEntries();
  if (entries && entries.length > 0) {
    const lines = entries.map((e) => {
      const intentTag = e.intent ? `intent: ${e.intent}` : "intent: other";
      const defaultTag = e.isDefault ? ", default" : "";
      return `- ${e.name}  [${intentTag}${defaultTag}]`;
    });
    sections.push(
      `Available shortcuts (pass exact name as the \`name\` arg of run_shortcut). Pick by intent matching the user's request; when two shortcuts share an intent, prefer the one tagged "default":\n${lines.join("\n")}`,
    );
  }

  return sections.join("\n\n");
}

/**
 * Last-resort tool resolver for the §5.1 "shortcut-name as tool-name" 4B
 * failure mode: the model emits a structured tool_call whose name IS a
 * shortcut name (e.g. `Create Note`), instead of using `run_shortcut` with
 * that name as an argument. This catches it at runtime: fuzzy-match the
 * unknown name against the shortcuts cache, then transparently route the
 * call through the real `run_shortcut` tool.
 *
 * Returns a result string that begins with `(routed from <X>)` so the model
 * sees what happened in the next turn's context — useful self-correction
 * signal without polluting BASE_SYSTEM.
 */
async function shortcutFallback(tc: ToolCallReq): Promise<string | null> {
  const requested = tc.function.name;
  if (typeof requested !== "string" || requested.length === 0) return null;

  const entries = shortcuts.cachedEntries();
  if (!entries || entries.length === 0) return null;

  // Exact match first (case-sensitive — that's what the user's library uses);
  // then case-insensitive; then fuzzy as a last-resort suggestion.
  let matched = entries.find((e) => e.name === requested)?.name;
  if (!matched) {
    const lower = requested.toLowerCase();
    matched = entries.find((e) => e.name.toLowerCase() === lower)?.name;
  }
  if (!matched) {
    const ranked = await shortcuts.fuzzyMatches(requested, 1);
    matched = ranked[0];
  }
  if (!matched) return null;

  // Pull the run_shortcut tool from the registry to delegate. If it's not
  // registered (shouldn't happen in normal config) we have nothing to do.
  const runShortcut = registry.get("run_shortcut");
  if (!runShortcut) return null;

  // Map whatever args the model passed into the run_shortcut shape:
  //   - if the model already passed `name` / `input`, honour them
  //   - else look for common content keys (text, body, content, message, value)
  //   - else treat the longest string value as `input`
  let parsedArgs: Record<string, unknown> = {};
  try {
    if (tc.function.arguments) parsedArgs = JSON.parse(tc.function.arguments);
  } catch { /* ignore — empty args */ }

  let input: string | undefined;
  if (typeof parsedArgs.input === "string") input = parsedArgs.input;
  else {
    for (const key of ["text", "body", "content", "message", "value", "note"]) {
      const v = parsedArgs[key];
      if (typeof v === "string" && v.length > 0) { input = v; break; }
    }
  }
  if (input === undefined) {
    const stringVals = Object.values(parsedArgs)
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .sort((a, b) => b.length - a.length);
    if (stringVals.length > 0) input = stringVals[0];
  }

  const synthesized: Record<string, unknown> = { name: matched };
  if (input !== undefined) synthesized.input = input;

  log(`unknown-tool fallback: '${requested}' → run_shortcut(name='${matched}'${input ? `, input=${input.length} chars` : ""})`);
  events.record("fallback_route", {
    requestedName: requested,
    routedTo: matched,
    inputChars: input?.length ?? 0,
  });

  try {
    const result = await runShortcut.execute(synthesized);
    // Prefix so the conversation context shows what was rerouted; the model
    // can use this as a hint for next turn's tool selection.
    return `(routed from '${requested}' → run_shortcut) ${result}`;
  } catch (e: any) {
    events.record("error", {
      scope: "fallback_route",
      requestedName: requested,
      routedTo: matched,
      message: e?.message ?? String(e),
    });
    return `Error in fallback for '${requested}': ${e?.message ?? e}`;
  }
}

// In-memory map of live assistants by session id. Persists across requests
// while the server runs, so the same session keeps its full context.
const liveAssistants = new Map<string, Assistant>();

async function createAssistant(): Promise<Assistant> {
  const client = new OpenAICompatClient({ baseURL: BASE_URL, apiKey: API_KEY, model: modelId });
  const context = new Context({ systemPrompt: buildSystemPrompt(), budget: DEFAULT_BUDGET });
  const session = store.newSession();
  await session.append({ role: "system", content: buildSystemPrompt() });
  return new Assistant(context, client, session, registry);
}

async function loadAssistant(sessionId: string): Promise<Assistant | null> {
  const id = await store.findByPrefix(sessionId);
  if (!id) return null;
  const turns = await store.loadTurns(id);
  const client = new OpenAICompatClient({ baseURL: BASE_URL, apiKey: API_KEY, model: modelId });
  const context = new Context({ systemPrompt: buildSystemPrompt(), budget: DEFAULT_BUDGET });
  context.restore(turns);
  context.setSystemPrompt(buildSystemPrompt());
  return new Assistant(context, client, store.open(id), registry);
}

// ─── HTTP / SSE plumbing ─────────────────────────────────

type SSEEvent = { event: string; data: unknown };

function sseStream(produce: (send: (e: SSEEvent) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: SSEEvent) => {
        const chunk = `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
        controller.enqueue(encoder.encode(chunk));
      };
      try {
        await produce(send);
      } catch (err: any) {
        try {
          send({ event: "error", data: { message: err?.message ?? String(err) } });
        } catch { /* ignore */ }
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...corsHeaders, ...(init.headers ?? {}) },
  });
}

// ─── Server ──────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  // Disable Bun's idle timeout — long replies from local models routinely
  // run past 10 seconds. The Mac client has its own resource timeout (600s).
  idleTimeout: 0,
  fetch: async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    const url = new URL(req.url);
    const t0 = Date.now();
    const reqId = ++requestCounter;
    const tag = `#${String(reqId).padStart(4, "0")}`;

    // Helper to log a non-SSE response on its way out.
    const respond = (resp: Response, note?: string): Response => {
      const dt = Date.now() - t0;
      const noteStr = note ? ` ${note}` : "";
      log(`${tag} ${req.method} ${url.pathname} → ${resp.status} (${dt}ms)${noteStr}`);
      events.record("request", {
        method: req.method,
        path: url.pathname,
        status: resp.status,
        latencyMs: dt,
      }, { requestId: reqId });
      return resp;
    };

    // GET /v1/health
    if (req.method === "GET" && url.pathname === "/v1/health") {
      // probeLoadedModels short-circuits to [] unless HALO_USE_LMS=1.
      // In bundled mode (the default), MODEL_META populates the
      // size/params/quant fields; lms isn't touched, so LM Studio
      // doesn't get poked into life on every probe.
      const loaded = await probeLoadedModels();
      const me = findLoadedModel(modelId, loaded);
      // contextLimit: prefer the live `lms ps` value (when enabled),
      // then the boot-time HTTP probe (`/api/v0/models`).
      const ctxLimit = me?.contextLength || caps?.contextLimit || null;
      return respond(json({
        ok: true,
        port: PORT,
        model: modelId,
        contextLimit: ctxLimit,
        embeddings: embeddingModelId ?? null,
        liveSessions: liveAssistants.size,
        modelDisplay: me?.displayName ?? MODEL_META.displayName,
        quantization: me?.quantization ?? MODEL_META.quantization,
        paramsString: me?.paramsString ?? MODEL_META.paramsString,
        sizeBytes: me?.sizeBytes ?? MODEL_META.sizeBytes,
        tokensPerSec: avgTps(),
      }));
    }

    // GET /v1/sessions
    if (req.method === "GET" && url.pathname === "/v1/sessions") {
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const list = await store.list(limit);
      return respond(json({ sessions: list }), `(${list.length} sessions, limit=${limit})`);
    }

    // GET /v1/sessions/<id> — full transcript.
    //
    // System + tool turns are internal and dropped. Multiple assistant
    // turn records can belong to a single user→assistant "round" (the
    // model emits a tool-calling assistant turn, then a terminal text
    // turn, possibly with several rounds of each). On the wire we
    // collapse each round back to one assistant message so the loaded
    // view matches what the user saw live: one bubble per round, with
    // cumulative thinking across all of its rounds and the model's
    // reply text concatenated in arrival order.
    if (req.method === "GET" && url.pathname.startsWith("/v1/sessions/")) {
      const idOrPrefix = decodeURIComponent(url.pathname.slice("/v1/sessions/".length));
      const id = await store.findByPrefix(idOrPrefix);
      if (!id) return respond(json({ error: "session not found" }, { status: 404 }), `prefix=${idOrPrefix}`);
      const turns = await store.loadTurns(id);
      type WireMsg = { role: "user" | "assistant"; text: string; ts: string; thinking?: string };
      const messages: WireMsg[] = [];
      for (const t of turns) {
        if (t.role !== "user" && t.role !== "assistant") continue;
        const last = messages[messages.length - 1];
        if (t.role === "assistant" && last?.role === "assistant") {
          // Same round — fold into the previous assistant message.
          if (t.content && t.content.length > 0) {
            last.text = last.text.length > 0 ? `${last.text}\n\n${t.content}` : t.content;
          }
          if (t.thinking && t.thinking.length > 0) {
            last.thinking = last.thinking
              ? `${last.thinking}\n\n--- step ---\n\n${t.thinking}`
              : t.thinking;
          }
          last.ts = t.ts;
        } else {
          messages.push({
            role: t.role,
            text: t.content,
            ts: t.ts,
            thinking: t.thinking && t.thinking.length > 0 ? t.thinking : undefined,
          });
        }
      }
      const meta = await store.metadataFor(id);
      return respond(json({ id, messages, meta }), `sid=${shortSid(id)} turns=${messages.length}`);
    }

    // GET /v1/profile — what the assistant remembers about the user.
    if (req.method === "GET" && url.pathname === "/v1/profile") {
      const facts = profile.entries().map(([key, value]) => ({ key, value }));
      return respond(json({ facts, path: profile.path }), `(${facts.length} facts)`);
    }

    // DELETE /v1/profile/<key> — forget a single fact.
    if (req.method === "DELETE" && url.pathname.startsWith("/v1/profile/")) {
      const key = decodeURIComponent(url.pathname.slice("/v1/profile/".length));
      const deleted = profile.delete(key);
      if (deleted) await profile.save();
      return respond(json({ deleted, key }), `key='${key}' deleted=${deleted}`);
    }

    // GET /v1/shortcuts — the user's installed Shortcuts library, cached
    // ~30s in-process. ?force=1 invalidates the cache (e.g. user just
    // added/renamed one in the Shortcuts app).
    if (req.method === "GET" && url.pathname === "/v1/shortcuts") {
      const force = url.searchParams.get("force") === "1";
      const r = await shortcuts.list({ force });
      if (!r.ok) {
        logErr(`${tag} shortcuts.list failed: ${r.error}`);
        return respond(json({ error: r.error }, { status: 500 }));
      }
      return respond(
        json({ shortcuts: r.shortcuts, cachedAt: r.cachedAt, fromCache: r.fromCache }),
        `(${r.shortcuts.length} shortcuts, cache=${r.fromCache ? "hit" : "miss"}${force ? ", forced" : ""})`,
      );
    }

    // POST /v1/chat — SSE stream of session/status/tool/token/done/error events.
    if (req.method === "POST" && url.pathname === "/v1/chat") {
      let body: { message?: string; sessionId?: string };
      try {
        body = (await req.json()) as { message?: string; sessionId?: string };
      } catch {
        return respond(json({ error: "invalid JSON body" }, { status: 400 }));
      }

      const message = (body.message ?? "").trim();
      if (!message) return respond(json({ error: "message is required" }, { status: 400 }));

      // Resolve / create the session-bound Assistant.
      const requestedSid = body.sessionId;
      let assistant: Assistant | null = null;
      let sessionState: "live" | "loaded" | "new" = "new";
      if (requestedSid) {
        const fromMemory = liveAssistants.get(requestedSid);
        if (fromMemory) {
          assistant = fromMemory;
          sessionState = "live";
        } else {
          assistant = await loadAssistant(requestedSid);
          if (assistant) sessionState = "loaded";
        }
      }
      if (!assistant) {
        assistant = await createAssistant();
        sessionState = "new";
      }
      const sid = assistant.sessionId!;
      liveAssistants.set(sid, assistant);

      // Refresh the profile + shortcut surfaces so newly remembered facts
      // and newly added Shortcuts show up on this turn. shortcuts.list()
      // hits its own 30s cache, so this is a no-op most of the time.
      await shortcuts.list();
      assistant.state.setSystemPrompt(buildSystemPrompt());

      log(`${tag} POST /v1/chat sid=${shortSid(sid)} ${sessionState.padEnd(6)} msg="${preview(message, 100)}"`);

      return sseStream(async (send) => {
        send({ event: "session", data: { sessionId: sid } });
        send({ event: "status",  data: { state: "thinking" } });

        try {
          const result = await assistant!.chat(message, {
            enableThinking: THINKING,
            onToken:    (text) => send({ event: "token", data: { text } }),
            onThinking: (text) => send({ event: "thinking", data: { text } }),
            onToolCall: (info) => {
              send({ event: "tool", data: info });
              const marker = info.isError ? "✗" : "·";
              const resultPreview = preview(info.result, 80);
              log(`${tag} sid=${shortSid(sid)}   ${marker} step ${info.step}: ${info.name}(${fmtArgs(info.args)}) → ${resultPreview} [${info.latencyMs}ms]`);
              const evtType = info.name === "run_shortcut" ? "shortcut_run" : "tool_call";
              events.record(evtType, {
                step: info.step,
                name: info.name,
                args: info.args,
                resultPreview: preview(info.result, 200),
                latencyMs: info.latencyMs,
                isError: info.isError,
              }, { sessionId: sid, requestId: reqId });
            },
            unknownToolFallback: shortcutFallback,
          });

          send({
            event: "done",
            data: {
              promptTokens:      result.promptTokens,
              completionTokens:  result.completionTokens,
              latencyMs:         result.latencyMs,
              steps:             result.steps,
              toolCallsExecuted: result.toolCallsExecuted,
              thinkingChars:     result.thinking.length,
              sessionId:         sid,
            },
          });

          const dt = Date.now() - t0;
          // tok/s is over generation time only — prefill is dominated by
          // prompt-eval and would dilute the number you actually care about
          // when comparing models.
          const tpsNum = result.generationMs > 0
            ? result.completionTokens * 1000 / result.generationMs
            : 0;
          recordTps(tpsNum);
          const tps = tpsNum > 0 ? tpsNum.toFixed(1) : "—";
          const thinkNote = result.thinking.length > 0 ? `, thinking=${result.thinking.length}c` : "";
          log(
            `${tag} sid=${shortSid(sid)}   ← reply (${result.reply.length} chars, ` +
            `tok in/out=${result.promptTokens}/${result.completionTokens}, ` +
            `prefill=${result.prefillMs}ms, gen=${result.generationMs}ms @ ${tps} tok/s, ` +
            `tools=${result.toolCallsExecuted}, steps=${result.steps}, ` +
            `total=${dt}ms${thinkNote}${result.trimmed ? `, trimmed ${result.totalMessages - result.sentMessages}` : ""})`,
          );
          if (result.reply.length > 0) {
            log(`${tag} sid=${shortSid(sid)}     "${preview(result.reply, 120)}"`);
          }
          events.record("chat_turn", {
            userMessagePreview: preview(message, 200),
            replyChars: result.reply.length,
            replyPreview: preview(result.reply, 200),
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
            prefillMs: result.prefillMs,
            generationMs: result.generationMs,
            tokensPerSec: result.generationMs > 0
              ? Number((result.completionTokens * 1000 / result.generationMs).toFixed(1))
              : null,
            steps: result.steps,
            toolCallsExecuted: result.toolCallsExecuted,
            totalLatencyMs: dt,
            sessionState,
            trimmedMessages: result.trimmed ? result.totalMessages - result.sentMessages : 0,
            thinkingChars: result.thinking.length,
            thinkingPreview: result.thinking.length > 0 ? preview(result.thinking, 300) : null,
          }, { sessionId: sid, requestId: reqId });
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          logErr(`${tag} sid=${shortSid(sid)} chat failed: ${msg}`);
          events.record("error", {
            scope: "chat",
            message: msg,
            stack: e?.stack ?? null,
          }, { sessionId: sid, requestId: reqId });
          throw e;
        }
      });
    }

    return respond(json({ error: "not found" }, { status: 404 }));
  },
  error: (err) => {
    logErr(`unhandled fetch error: ${err?.message ?? err}`);
    events.record("error", {
      scope: "fetch",
      message: err?.message ?? String(err),
      stack: (err as any)?.stack ?? null,
    });
    return new Response("internal error", { status: 500, headers: corsHeaders });
  },
});

log(`listening on http://localhost:${server.port}`);
log(`  model:       ${modelId}`);
log(`  embeddings:  ${embeddingModelId ?? "(off — search_corpus disabled)"}`);
log(`  budget:      ${DEFAULT_BUDGET}${caps?.contextLimit ? ` (server ctx ${caps.contextLimit})` : ""}`);
log(`  tools:       ${registry.size()} (${registry.list().map((t) => t.definition.name).join(", ")})`);
log(`  sessions:    ${ASSISTANT_HOME}/sessions`);
log(`  notes root:  ${notesRoot}`);
log(`  events:      ${events.count()} accumulated`);
log(`  log level:   ${QUIET ? "quiet (HALO_LOG_QUIET=1)" : "verbose — set HALO_LOG_QUIET=1 to silence"}`);
log(`  thinking:    ${THINKING ? "ON  (HALO_THINKING=1 — Qwen-3.5 only)" : "off — set HALO_THINKING=1 to enable for Qwen 3.5"}`);

events.record("boot", {
  port: server.port,
  model: modelId,
  embeddings: embeddingModelId,
  contextBudget: DEFAULT_BUDGET,
  serverContextLimit: caps?.contextLimit ?? null,
  toolCount: registry.size(),
  toolNames: registry.list().map((t) => t.definition.name),
  shortcutCount: shortcuts.cachedNames()?.length ?? 0,
});
