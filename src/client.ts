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

export type Role = "system" | "user" | "assistant";
export type Msg = { role: Role; content: string };

export type Usage = {
  promptTokens: number;
  completionTokens: number;
};

export type CompletionResult = {
  reply: string;
  usage: Usage;
  latencyMs: number;
};

export type CompletionOptions = {
  temperature?: number;
  maxTokens?: number;
};

export interface ModelClient {
  /** stable identifier for telemetry/routing logs */
  readonly id: string;
  complete(messages: Msg[], options?: CompletionOptions): Promise<CompletionResult>;
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
      messages: messages as ChatCompletionMessageParam[],
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens,
    });
    const latencyMs = Date.now() - t0;
    const reply = resp.choices[0]?.message.content ?? "";
    const usage = resp.usage;
    return {
      reply,
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
