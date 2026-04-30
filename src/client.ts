/**
 * ModelClient — typed wrapper around an OpenAI-compatible endpoint.
 *
 * The brain only ever talks to a ModelClient. This is the seam where
 * model tiers (local / mid / frontier) plug in — each tier is just
 * another implementation of this interface.
 *
 * For now there's one impl (OpenAICompatClient). When we add routing
 * at v7 we'll have a Router that holds multiple ModelClients and
 * picks one per request.
 */

import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ToolDefinition } from "./tools";

export type Role = "system" | "user" | "assistant" | "tool";

/** A request to call a tool, as emitted by the model. */
export type ToolCallReq = {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON-encoded arguments. */
    arguments: string;
  };
};

/**
 * Internal message shape. Covers regular text turns, assistant turns
 * that carry tool_calls (model wants to invoke a tool), and tool turns
 * (the result of one of those calls being fed back to the model).
 */
export type Msg = {
  role: Role;
  content: string;
  /** Assistant turns only — present when the assistant requested tool calls. */
  toolCalls?: ToolCallReq[];
  /** Tool turns only — the id of the tool_call this message answers. */
  toolCallId?: string;
};

export type Usage = {
  promptTokens: number;
  completionTokens: number;
};

export type CompletionResult = {
  /** The assistant's text reply. May be empty when only tool calls are emitted. */
  reply: string;
  /** Tool calls the model emitted, if any. */
  toolCalls?: ToolCallReq[];
  usage: Usage;
  latencyMs: number;
};

export type CompletionOptions = {
  temperature?: number;
  maxTokens?: number;
  /** Tools available to the model for this request. */
  tools?: ToolDefinition[];
};

/**
 * Token-streaming variant. The client yields incremental text chunks via
 * `onToken` (each is a piece of the assistant's reply, in arrival order)
 * and resolves with the same final shape as `complete()`. Tool calls are
 * accumulated across deltas and surfaced atomically in the resolved
 * `CompletionResult` — they never partially reach the caller.
 */
export type StreamingOptions = CompletionOptions & {
  onToken?: (text: string) => void;
};

export interface ModelClient {
  /** stable identifier for telemetry/routing logs */
  readonly id: string;
  complete(messages: Msg[], options?: CompletionOptions): Promise<CompletionResult>;
  /**
   * Streaming variant. Implementations may delegate to `complete()` if the
   * underlying transport doesn't support streaming — callers should treat
   * the absence of token deltas as "model returned in one go".
   */
  completeStreaming(messages: Msg[], options?: StreamingOptions): Promise<CompletionResult>;
}

/** Convert an internal Msg to the OpenAI API's expected message shape. */
function toApiMessage(m: Msg): ChatCompletionMessageParam {
  if (m.role === "tool") {
    return {
      role: "tool",
      tool_call_id: m.toolCallId ?? "",
      content: m.content,
    };
  }
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    };
  }
  return { role: m.role as "system" | "user" | "assistant", content: m.content };
}

export class OpenAICompatClient implements ModelClient {
  readonly id: string;
  private client: OpenAI;
  private model: string;

  constructor(opts: { baseURL: string; apiKey: string; model: string; id?: string }) {
    this.client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey });
    this.model = opts.model;
    this.id = opts.id ?? `${new URL(opts.baseURL).host}/${opts.model}`;
  }

  async complete(messages: Msg[], options: CompletionOptions = {}): Promise<CompletionResult> {
    const t0 = Date.now();
    const resp = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map(toApiMessage),
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens,
      tools: options.tools?.map((t) => ({ type: "function" as const, function: t })),
    });
    const latencyMs = Date.now() - t0;
    const choice = resp.choices[0];
    const message = choice?.message;
    const reply = message?.content ?? "";
    const rawToolCalls = message?.tool_calls;
    const toolCalls: ToolCallReq[] | undefined = rawToolCalls
      ?.filter((tc): tc is typeof tc & { function: { name: string; arguments: string } } =>
        tc.type === "function" && tc.function?.name != null,
      )
      .map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.function.name, arguments: tc.function.arguments ?? "{}" },
      }));
    const usage = resp.usage;
    return {
      reply,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      latencyMs,
      usage: {
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
      },
    };
  }

  /**
   * Streaming completion. Yields text deltas via `onToken` as the model
   * generates them; accumulates tool-call deltas (which arrive fragmented:
   * the function name lands first, then arguments arrive a few chars at a
   * time across chunks) and surfaces them only in the final resolved value.
   */
  async completeStreaming(messages: Msg[], options: StreamingOptions = {}): Promise<CompletionResult> {
    const t0 = Date.now();
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map(toApiMessage),
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens,
      tools: options.tools?.map((t) => ({ type: "function" as const, function: t })),
      stream: true,
      stream_options: { include_usage: true },
    });

    let reply = "";
    // Tool calls stream as deltas indexed by `index`; we collate them as we go.
    const toolBuf = new Map<number, { id?: string; name?: string; args: string }>();
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;

      if (delta?.content) {
        reply += delta.content;
        options.onToken?.(delta.content);
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (typeof tc.index !== "number") continue;
          const slot = toolBuf.get(tc.index) ?? { args: "" };
          if (tc.id)              slot.id   = tc.id;
          if (tc.function?.name)  slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          toolBuf.set(tc.index, slot);
        }
      }
      // Final chunk on streaming includes usage when stream_options requested it.
      if (chunk.usage) {
        promptTokens     = chunk.usage.prompt_tokens     ?? promptTokens;
        completionTokens = chunk.usage.completion_tokens ?? completionTokens;
      }
    }

    const latencyMs = Date.now() - t0;
    const toolCalls: ToolCallReq[] = [];
    // Stable order — keys are the model-assigned indices.
    const indices = [...toolBuf.keys()].sort((a, b) => a - b);
    for (const i of indices) {
      const slot = toolBuf.get(i)!;
      if (!slot.id || !slot.name) continue;          // skip incomplete entries
      toolCalls.push({
        id: slot.id,
        type: "function",
        function: { name: slot.name, arguments: slot.args || "{}" },
      });
    }

    return {
      reply,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      latencyMs,
      usage: { promptTokens, completionTokens },
    };
  }
}

/** Discover the first non-embedding model loaded at the endpoint. */
export async function discoverModel(baseURL: string, apiKey: string): Promise<string> {
  const client = new OpenAI({ baseURL, apiKey });
  const list = await client.models.list();
  const chat = list.data.find((m) => !m.id.toLowerCase().includes("embed"));
  if (!chat) throw new Error("No chat model loaded at " + baseURL);
  return chat.id;
}

/**
 * Server-side capabilities for the *currently loaded* model, when the
 * server exposes them. LM Studio exposes this via `/api/v0/models`
 * (separate from the OpenAI-compat `/v1/models`). Other servers may
 * not — return null cleanly so callers can treat it as best-effort.
 */
export type ServerCapabilities = {
  modelId: string;
  contextLimit: number;
  capabilities: string[];
};

export async function probeServerCapabilities(baseURL: string): Promise<ServerCapabilities | null> {
  const root = baseURL.replace(/\/v1\/?$/, "");
  try {
    const resp = await fetch(`${root}/api/v0/models`, { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      data?: Array<{
        id: string;
        type?: string;
        state?: string;
        loaded_context_length?: number;
        capabilities?: string[];
      }>;
    };
    const loaded = data.data?.find((m) => m.state === "loaded" && m.type !== "embeddings");
    if (!loaded?.loaded_context_length) return null;
    return {
      modelId: loaded.id,
      contextLimit: loaded.loaded_context_length,
      capabilities: loaded.capabilities ?? [],
    };
  } catch {
    return null;
  }
}
