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
import type { Session } from "./sessions";

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
    private session: Session | null = null,
  ) {}

  /** Swap the active session (e.g., after /load or /new). */
  setSession(s: Session | null) {
    this.session = s;
  }

  get sessionId(): string | null {
    return this.session?.id ?? null;
  }

  async chat(userText: string, options: CompletionOptions = {}): Promise<TurnResult> {
    this.context.addUser(userText);

    const messagesToSend = this.context.messagesForRequest();
    const totalMessages = this.context.all().length;
    const trimmed = messagesToSend.length < totalMessages;

    const result = await this.client.complete(messagesToSend, options);
    this.context.addAssistant(result.reply);
    this.context.recordUsage(result.usage.promptTokens, result.usage.completionTokens);

    // Persist both turns to the active session, best-effort.
    // We surface failures as warnings rather than crashing the chat loop —
    // the in-memory conversation is the authoritative state mid-session.
    if (this.session) {
      try {
        await this.session.append({ role: "user", content: userText });
        await this.session.append({
          role: "assistant",
          content: result.reply,
          model: this.client.id,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          latencyMs: result.latencyMs,
        });
      } catch (e: any) {
        console.warn(`[persist warning] could not append to session ${this.session.id}: ${e?.message ?? e}`);
      }
    }

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
