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
  makeListNotesTool,
  makeReadNoteTool,
  makeRememberTool,
  makeSearchCorpusTool,
  makeSearchNotesByFilenameTool,
  makeWriteNoteTool,
} from "./tools";
import { Profile } from "./profile";
import { EmbeddingClient, discoverEmbeddingModel } from "./embeddings";
import { IndexStore } from "./index_store";

// ─── Config ──────────────────────────────────────────────

const PORT          = Number(process.env.HALO_PORT ?? 7878);
const BASE_URL      = process.env.MODEL_BASE_URL ?? "http://localhost:1234/v1";
const API_KEY       = process.env.MODEL_API_KEY ?? "lm-studio";
const ASSISTANT_HOME = process.env.ASSISTANT_HOME ?? join(process.env.HOME ?? "", ".assistant");
const DEFAULT_BUDGET = Number(process.env.CONTEXT_BUDGET ?? 4096);

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
  "- DEFAULT TO RETRIEVAL. Before answering ANY question that could even tangentially involve the user's content, call search_corpus first.",
  "- For questions about places, preferences, names, experiences, recipes, or anything personal: always retrieve.",
].join("\n");

// ─── Bootstrap (once on launch) ──────────────────────────

let modelId: string;
try {
  modelId = await discoverModel(BASE_URL, API_KEY);
} catch {
  console.error(`[halo-server] Could not reach model server at ${BASE_URL}.`);
  console.error("Start LM Studio's Developer server (or set MODEL_BASE_URL).");
  process.exit(1);
}

const caps = await probeServerCapabilities(BASE_URL);
if (caps && DEFAULT_BUDGET > caps.contextLimit) {
  console.warn(`[halo-server] context budget (${DEFAULT_BUDGET}) > server ctx (${caps.contextLimit}); will silently truncate.`);
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

const registry = new ToolRegistry();
registry.register(getCurrentTimeTool);
registry.register(makeReadNoteTool(notesRoot));
registry.register(makeListNotesTool(notesRoot));
registry.register(makeWriteNoteTool(notesRoot));
registry.register(makeSearchNotesByFilenameTool(notesRoot));
registry.register(makeRememberTool(profile));
registry.register(makeForgetTool(profile));
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

    // GET /v1/health
    if (req.method === "GET" && url.pathname === "/v1/health") {
      return json({
        ok: true,
        port: PORT,
        model: modelId,
        contextLimit: caps?.contextLimit ?? null,
        embeddings: embeddingModelId ?? null,
        liveSessions: liveAssistants.size,
      });
    }

    // GET /v1/sessions
    if (req.method === "GET" && url.pathname === "/v1/sessions") {
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const list = await store.list(limit);
      return json({ sessions: list });
    }

    // GET /v1/profile — what the assistant remembers about the user.
    if (req.method === "GET" && url.pathname === "/v1/profile") {
      const facts = profile.entries().map(([key, value]) => ({ key, value }));
      return json({ facts, path: profile.path });
    }

    // DELETE /v1/profile/<key> — forget a single fact.
    if (req.method === "DELETE" && url.pathname.startsWith("/v1/profile/")) {
      const key = decodeURIComponent(url.pathname.slice("/v1/profile/".length));
      const deleted = profile.delete(key);
      if (deleted) await profile.save();
      return json({ deleted, key });
    }

    // POST /v1/chat — SSE stream of session/status/tool/token/done/error events.
    if (req.method === "POST" && url.pathname === "/v1/chat") {
      let body: { message?: string; sessionId?: string };
      try {
        body = (await req.json()) as { message?: string; sessionId?: string };
      } catch {
        return json({ error: "invalid JSON body" }, { status: 400 });
      }

      const message = (body.message ?? "").trim();
      if (!message) return json({ error: "message is required" }, { status: 400 });

      // Resolve / create the session-bound Assistant.
      let assistant: Assistant | null = null;
      if (body.sessionId) {
        assistant = liveAssistants.get(body.sessionId)
          ?? await loadAssistant(body.sessionId);
      }
      if (!assistant) {
        assistant = await createAssistant();
      }
      const sid = assistant.sessionId!;
      liveAssistants.set(sid, assistant);

      // Profile may have changed since this session started — refresh the
      // system prompt so newly remembered facts show up immediately.
      assistant.state.setSystemPrompt(buildSystemPrompt());

      return sseStream(async (send) => {
        send({ event: "session", data: { sessionId: sid } });
        send({ event: "status",  data: { state: "thinking" } });

        const result = await assistant!.chat(message, {
          onToken:    (text) => send({ event: "token", data: { text } }),
          onToolCall: (info) => send({ event: "tool",  data: info }),
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
      });
    }

    return json({ error: "not found" }, { status: 404 });
  },
});

console.log(
  `[halo-server] http://localhost:${server.port}  ·  model: ${modelId}  ·  ` +
  `embeddings: ${embeddingModelId ?? "off"}  ·  budget: ${DEFAULT_BUDGET}`
);
