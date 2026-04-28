/**
 * Assistant — top-level orchestrator.
 *
 * Holds a Context and a ModelClient. One method matters: chat().
 * Future versions add: tool dispatch (v3), summarization (v2-ish),
 * router-driven tier selection (v7). The class signature should
 * stay stable as long as possible.
 */

import type { CompletionOptions, ModelClient } from "./client";
import type { Context } from "./context";

export type TurnResult = {
  reply: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  /** number of messages actually sent (may be < total after budget trim) */
  sentMessages: number;
  /** total messages held in context (incl. system) */
  totalMessages: number;
  /** true if budget caused history to be trimmed for this request */
  trimmed: boolean;
};

export class Assistant {
  constructor(
    private context: Context,
    private client: ModelClient,
  ) {}

  async chat(userText: string, options: CompletionOptions = {}): Promise<TurnResult> {
    this.context.addUser(userText);

    const messagesToSend = this.context.messagesForRequest();
    const totalMessages = this.context.all().length;
    const trimmed = messagesToSend.length < totalMessages;

    const result = await this.client.complete(messagesToSend, options);
    this.context.addAssistant(result.reply);
    this.context.recordUsage(result.usage.promptTokens, result.usage.completionTokens);

    return {
      reply: result.reply,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      latencyMs: result.latencyMs,
      sentMessages: messagesToSend.length,
      totalMessages,
      trimmed,
    };
  }

  get state(): Context {
    return this.context;
  }

  get modelId(): string {
    return this.client.id;
  }
}
