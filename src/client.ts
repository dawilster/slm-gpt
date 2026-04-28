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

export interface ModelClient {
  /** stable identifier for telemetry/routing logs */
  readonly id: string;
  complete(messages: Msg[], options?: CompletionOptions): Promise<CompletionResult>;
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
