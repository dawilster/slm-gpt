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
 *       event: tool      { step, name, args, result, latencyMs, isError }
 *       event: token     { text }              ← full reply (single chunk for now)
 *       event: done      { promptTokens, completionTokens, latencyMs, steps,
 *                          toolCallsExecuted }
 *       event: error     { message }
 *
 * Token-by-token streaming will land later — the `token` event is shaped so
 * the wire protocol won't have to change when it does.
 *
 * Bootstrap mirrors `src/index.ts` so the server has the same model, tools,
 * profile, and corpus the REPL has.
 */

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
import { ShortcutsClient } from "./shortcuts";

// ─── Config ──────────────────────────────────────────────

const PORT          = Number(process.env.HALO_PORT ?? 7878);
const BASE_URL      = process.env.MODEL_BASE_URL ?? "http://localhost:1234/v1";
const API_KEY       = process.env.MODEL_API_KEY ?? "lm-studio";
const ASSISTANT_HOME = process.env.ASSISTANT_HOME ?? join(process.env.HOME ?? "", ".assistant");
const DEFAULT_BUDGET = Number(process.env.CONTEXT_BUDGET ?? 4096);
const QUIET          = process.env.HALO_LOG_QUIET === "1";

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

// Same base prompt as the REPL — kept in sync deliberately. If we move it to
// a shared module, both index.ts and server.ts should switch together.
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
  "- Never call search_corpus twice with the same query in one turn — one retrieval is the answer.",
  "Action rules:",
  "- All world-changing actions (creating notes, timers, reminders, launching apps) go through run_shortcut(name, input?). You have no other write surface.",
  "- When the user provides content for the action ('create a note WITH the list', 'set a timer FOR 20 min'), pass that content as `input`. Never call run_shortcut with no input when the user gave you content — the shortcut will prompt them, defeating the point.",
  "- If you don't know the exact shortcut name, call list_shortcuts first, then run_shortcut with the closest match.",
  "- Chain by calling run_shortcut once per step.",
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
  const profileSection = profile.renderForSystemPrompt();
  return profileSection ? `${BASE_SYSTEM}\n\n${profileSection}` : BASE_SYSTEM;
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
      return resp;
    };

    // GET /v1/health
    if (req.method === "GET" && url.pathname === "/v1/health") {
      return respond(json({
        ok: true,
        port: PORT,
        model: modelId,
        contextLimit: caps?.contextLimit ?? null,
        embeddings: embeddingModelId ?? null,
        liveSessions: liveAssistants.size,
      }));
    }

    // GET /v1/sessions
    if (req.method === "GET" && url.pathname === "/v1/sessions") {
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const list = await store.list(limit);
      return respond(json({ sessions: list }), `(${list.length} sessions, limit=${limit})`);
    }

    // GET /v1/sessions/<id> — full transcript (user + assistant messages
    // only; system + tool turns are internal and not displayed).
    if (req.method === "GET" && url.pathname.startsWith("/v1/sessions/")) {
      const idOrPrefix = decodeURIComponent(url.pathname.slice("/v1/sessions/".length));
      const id = await store.findByPrefix(idOrPrefix);
      if (!id) return respond(json({ error: "session not found" }, { status: 404 }), `prefix=${idOrPrefix}`);
      const turns = await store.loadTurns(id);
      const messages = turns
        .filter((t) => t.role === "user" || t.role === "assistant")
        .map((t) => ({
          role: t.role as "user" | "assistant",
          text: t.content,
          ts: t.ts,
        }));
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

      // Profile may have changed since this session started — refresh the
      // system prompt so newly remembered facts show up immediately.
      assistant.state.setSystemPrompt(buildSystemPrompt());

      log(`${tag} POST /v1/chat sid=${shortSid(sid)} ${sessionState.padEnd(6)} msg="${preview(message, 100)}"`);

      return sseStream(async (send) => {
        send({ event: "session", data: { sessionId: sid } });
        send({ event: "status",  data: { state: "thinking" } });

        try {
          const result = await assistant!.chat(message, {
            onToken:    (text) => send({ event: "token", data: { text } }),
            onToolCall: (info) => {
              send({ event: "tool", data: info });
              const marker = info.isError ? "✗" : "·";
              const resultPreview = preview(info.result, 80);
              log(`${tag} sid=${shortSid(sid)}   ${marker} step ${info.step}: ${info.name}(${fmtArgs(info.args)}) → ${resultPreview} [${info.latencyMs}ms]`);
            },
          });

          send({
            event: "done",
            data: {
              promptTokens:      result.promptTokens,
              completionTokens:  result.completionTokens,
              latencyMs:         result.latencyMs,
              steps:             result.steps,
              toolCallsExecuted: result.toolCallsExecuted,
              sessionId:         sid,
            },
          });

          const dt = Date.now() - t0;
          log(
            `${tag} sid=${shortSid(sid)}   ← reply (${result.reply.length} chars, ` +
            `tok in/out=${result.promptTokens}/${result.completionTokens}, ` +
            `tools=${result.toolCallsExecuted}, steps=${result.steps}, ` +
            `total=${dt}ms${result.trimmed ? `, trimmed ${result.totalMessages - result.sentMessages}` : ""})`,
          );
          if (result.reply.length > 0) {
            log(`${tag} sid=${shortSid(sid)}     "${preview(result.reply, 120)}"`);
          }
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          logErr(`${tag} sid=${shortSid(sid)} chat failed: ${msg}`);
          throw e;
        }
      });
    }

    return respond(json({ error: "not found" }, { status: 404 }));
  },
  error: (err) => {
    logErr(`unhandled fetch error: ${err?.message ?? err}`);
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
log(`  log level:   ${QUIET ? "quiet (HALO_LOG_QUIET=1)" : "verbose — set HALO_LOG_QUIET=1 to silence"}`);
