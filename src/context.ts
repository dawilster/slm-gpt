/**
 * Context — manages the conversation state sent to the model.
 *
 * v1 responsibility: enforce a token budget. The model has a fixed
 * context window, but more importantly: every token in the prompt
 * costs latency and (eventually) money. Context lets old turns age
 * out gracefully via a sliding window.
 *
 * Strategy at v1: when estimated prompt tokens exceed the budget,
 * drop the oldest user/assistant pair and try again. Never drop
 * the system message. Never drop the latest user message.
 *
 * Future versions will layer in: summarization of dropped turns
 * (v2-ish), pinned facts, durable memory promotion.
 */

import type { Msg, ToolCallReq } from "./client";
import type { TurnRecord } from "./sessions";

/**
 * Estimate token count from char count. Cheap approximation,
 * good for budget management at ~10% accuracy for English.
 *
 * Real tokenization needs the model's tokenizer; we'll wire that
 * in if/when char/4 proves too imprecise (track via eval).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Per-message overhead (role tokens, message separators). */
const MSG_OVERHEAD_TOKENS = 4;

export type ContextOptions = {
  systemPrompt: string;
  /** total token budget for system + history sent to the model */
  budget?: number;
  /** tokens reserved for the model's response, kept out of history budget */
  reservedForResponse?: number;
};

export type ContextSnapshot = {
  systemPrompt: string;
  historyCount: number;
  estimatedPromptTokens: number;
  budget: number;
  reservedForResponse: number;
  cumulativeIn: number;
  cumulativeOut: number;
};

export class Context {
  private system: Msg;
  private messages: Msg[] = [];
  private _budget: number;
  private reservedForResponse: number;
  cumulativeIn = 0;
  cumulativeOut = 0;

  constructor(opts: ContextOptions) {
    this.system = { role: "system", content: opts.systemPrompt };
    this._budget = opts.budget ?? 4096;
    this.reservedForResponse = opts.reservedForResponse ?? 512;
  }

  get budget(): number {
    return this._budget;
  }

  set budget(n: number) {
    if (!Number.isFinite(n) || n <= 0) throw new Error("budget must be a positive number");
    this._budget = n;
  }

  get historyLength(): number {
    return this.messages.length;
  }

  setSystemPrompt(text: string) {
    this.system = { role: "system", content: text };
  }

  addUser(text: string) {
    this.messages.push({ role: "user", content: text });
  }

  addAssistant(text: string) {
    this.messages.push({ role: "assistant", content: text });
  }

  /** Append an assistant turn that's requesting one or more tool calls. */
  addAssistantToolCalls(text: string, toolCalls: ToolCallReq[]) {
    this.messages.push({ role: "assistant", content: text, toolCalls });
  }

  /** Append the result of a previously-requested tool call. */
  addToolResult(toolCallId: string, result: string) {
    this.messages.push({ role: "tool", content: result, toolCallId });
  }

  /** Reset history; preserve system prompt and reset cumulative counters. */
  clear() {
    this.messages = [];
    this.cumulativeIn = 0;
    this.cumulativeOut = 0;
  }

  /**
   * Replace in-memory state with a saved sequence of turn records.
   * The session's stored system prompt overrides the constructor's
   * default — restoring is meant to recreate the original conversation.
   */
  restore(records: TurnRecord[]) {
    this.messages = [];
    this.cumulativeIn = 0;
    this.cumulativeOut = 0;
    for (const r of records) {
      if (r.role === "system") {
        this.system = { role: "system", content: r.content };
      } else if (r.role === "user") {
        this.messages.push({ role: "user", content: r.content });
      } else if (r.role === "assistant") {
        this.messages.push({
          role: "assistant",
          content: r.content,
          toolCalls: r.toolCalls,
        });
        this.cumulativeIn += r.promptTokens ?? 0;
        this.cumulativeOut += r.completionTokens ?? 0;
      } else if (r.role === "tool") {
        this.messages.push({
          role: "tool",
          content: r.content,
          toolCallId: r.toolCallId,
        });
      }
    }
  }

  recordUsage(promptTokens: number, completionTokens: number) {
    this.cumulativeIn += promptTokens;
    this.cumulativeOut += completionTokens;
  }

  /** Full message array including system, untrimmed. */
  all(): Msg[] {
    return [this.system, ...this.messages];
  }

  /**
   * Messages to send for the next request. Applies sliding window:
   * drops the oldest "logical turn" until the estimate fits the budget.
   *
   * A logical turn = a user message and everything that follows it up to
   * (but not including) the next user message. This means tool calls and
   * tool results stay grouped with their originating user request and
   * never orphan-leak into the request as a tool message without its
   * tool_call ancestor (which the API would reject).
   *
   * System message is never dropped. Latest user message is never dropped.
   */
  messagesForRequest(): Msg[] {
    const allowedHistory = this._budget - this.reservedForResponse - this.tokensFor([this.system]);
    let history = [...this.messages];

    while (this.tokensFor(history) > allowedHistory && history.length > 1) {
      // Find the start of the second logical turn — the next user message
      // after index 0. Slicing from there drops the entire first turn.
      let nextUserIdx = -1;
      for (let i = 1; i < history.length; i++) {
        if (history[i]?.role === "user") {
          nextUserIdx = i;
          break;
        }
      }
      if (nextUserIdx < 0) {
        // Only one user message in history (the current one). Can't drop
        // a turn while preserving the latest. Stop trimming here; if it
        // still doesn't fit, the model server will be the next line of
        // defense (and probeServerCapabilities warned us at startup).
        break;
      }
      history = history.slice(nextUserIdx);
    }

    return [this.system, ...history];
  }

  /** True if the next request would trim history. */
  wouldTrim(): boolean {
    return this.messagesForRequest().length < this.all().length;
  }

  /** Estimate token cost of a message array including per-message overhead. */
  private tokensFor(msgs: Msg[]): number {
    return msgs.reduce((sum, m) => sum + estimateTokens(m.content) + MSG_OVERHEAD_TOKENS, 0);
  }

  snapshot(): ContextSnapshot {
    return {
      systemPrompt: this.system.content,
      historyCount: this.messages.length,
      estimatedPromptTokens: this.tokensFor(this.all()),
      budget: this._budget,
      reservedForResponse: this.reservedForResponse,
      cumulativeIn: this.cumulativeIn,
      cumulativeOut: this.cumulativeOut,
    };
  }
}
