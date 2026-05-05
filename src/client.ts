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
  /**
   * Streaming only: ms from request issued to first response chunk. Dominated
   * by prompt-eval (prefill) on local SLMs. Knowing this separately from the
   * total tells you whether long requests are paying for prefill or for
   * generation — the two need different optimisations.
   */
  firstTokenMs?: number;
  /**
   * Reasoning trace from thinking-mode models. LM Studio's MLX runtime
   * exposes this as a separate `reasoning_content` field on the chat
   * message (and `delta.reasoning_content` during streaming). Empty string
   * when the model didn't emit any thinking.
   */
  thinking?: string;
};

export type CompletionOptions = {
  temperature?: number;
  maxTokens?: number;
  /** Tools available to the model for this request. */
  tools?: ToolDefinition[];
  /**
   * Qwen 3.5 family: enable the model's "thinking" mode by passing
   * `enable_thinking: true` in the request's extra_body. The model emits a
   * `<think>...</think>` block before the actual reply. We strip it from the
   * persisted reply so downstream consumers (eval, persistence, synthetic-
   * call recovery) only see the answer; raw stream tokens still flow
   * through `onToken` so the UI can render thinking if desired.
   */
  enableThinking?: boolean;
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
  /**
   * Token observer for thinking-mode reasoning content (LM Studio's
   * `delta.reasoning_content`). Fires before `onToken` for the same turn —
   * the model thinks, then answers. UIs can use this to render the
   * thinking trace in a separate (e.g. collapsible) surface.
   */
  onThinking?: (text: string) => void;
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
    // `enable_thinking` is a Qwen-3.5 extra_body field. The OpenAI Node SDK
    // forwards unknown fields, so we splat it in via an any-typed param object.
    const params: any = {
      model: this.model,
      messages: messages.map(toApiMessage),
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens,
      tools: options.tools?.map((t) => ({ type: "function" as const, function: t })),
    };
    if (options.enableThinking) params.enable_thinking = true;
    const resp = await this.client.chat.completions.create(params);
    const latencyMs = Date.now() - t0;
    const choice = resp.choices[0];
    const message = choice?.message;
    const rawReply = message?.content ?? "";
    // LM Studio's MLX runtime puts thinking-mode reasoning into a separate
    // `reasoning_content` field on the message — extract it. Older models
    // that emit `<think>...</think>` inline get caught by stripThinking()
    // as a fallback.
    const reasoningField = (message as any)?.reasoning_content;
    const thinking = typeof reasoningField === "string" ? reasoningField : "";
    // Always strip — see streaming path for rationale.
    const reply = stripThinking(rawReply);
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
      thinking: thinking || undefined,
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
    const baseParams = {
      model: this.model,
      messages: messages.map(toApiMessage),
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens,
      tools: options.tools?.map((t) => ({ type: "function" as const, function: t })),
      stream: true as const,
      stream_options: { include_usage: true },
    };
    const params = options.enableThinking
      ? { ...baseParams, enable_thinking: true } as typeof baseParams
      : baseParams;
    const stream = await this.client.chat.completions.create(params);

    let reply = "";
    let thinking = "";
    // Tool calls stream as deltas indexed by `index`; we collate them as we go.
    const toolBuf = new Map<number, { id?: string; name?: string; args: string }>();
    let promptTokens = 0;
    let completionTokens = 0;
    let firstTokenMs: number | undefined;

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const delta: any = choice?.delta;

      // Stamp the moment the model produces its first observable output —
      // text token OR reasoning token OR tool-call delta. Everything before
      // this is prefill. (Thinking models open with reasoning, so excluding
      // it would over-attribute prefill time.)
      const sawFirst = (delta?.content && delta.content.length > 0)
        || (delta?.reasoning_content && delta.reasoning_content.length > 0)
        || (delta?.tool_calls && delta.tool_calls.length > 0);
      if (sawFirst && firstTokenMs === undefined) {
        firstTokenMs = Date.now() - t0;
      }

      // LM Studio streams `delta.reasoning_content` for thinking-mode
      // reasoning, separate from `delta.content` (the answer). Route them
      // to different observers so the UI can render the trace in a
      // collapsible block.
      if (delta?.reasoning_content) {
        thinking += delta.reasoning_content;
        options.onThinking?.(delta.reasoning_content);
      }
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

    // Always strip — defensive against the model emitting `<think>`
    // even when we asked the template to suppress it. No-op when no
    // tags present. Same belt-and-braces as the non-streaming path.
    const cleanReply = stripThinking(reply);

    return {
      reply: cleanReply,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      latencyMs,
      firstTokenMs,
      thinking: thinking || undefined,
      usage: { promptTokens, completionTokens },
    };
  }
}

/**
 * Strip Qwen-3.5 `<think>...</think>` blocks from a reply. The model emits
 * its meta-reasoning inside these tags before the actual answer; we keep
 * them out of the persisted reply so:
 *   - the eval / synthetic-call recovery doesn't get fooled by pseudo-code
 *     in the thinking
 *   - downstream prompts (next agent loop iteration) don't accumulate noise
 *   - the chat UI sees a clean answer
 *
 * Streaming `onToken` still emits raw thinking tokens so callers can
 * render them separately if they want; this only affects the resolved
 * `reply` field.
 */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
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
