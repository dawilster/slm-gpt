/**
 * Assistant — the agent loop orchestrator.
 *
 * chat() runs:
 *   user message → model call → if tool_calls, execute, append, recurse
 *                              → else return final reply
 *
 * Tool calls and their results are added to context AND persisted, so
 * a resumed session sees the full history including the model's
 * intermediate tool reasoning.
 *
 * maxSteps prevents infinite loops if the model keeps calling tools
 * (default 5 — tighten/loosen as we learn what's reasonable).
 */

import type { CompletionOptions, ModelClient, ToolCallReq } from "./client";
import type { Context } from "./context";
import type { Session } from "./sessions";
import { validateArgs, type ToolRegistry } from "./tools";

export type TurnResult = {
  reply: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  /** number of messages actually sent on the LAST round-trip after budget trim */
  sentMessages: number;
  /** total messages held in context (incl. system) */
  totalMessages: number;
  /** true if budget caused history to be trimmed for this request */
  trimmed: boolean;
  /** how many model calls happened (1 = no tool use; >1 = each loop iteration) */
  steps: number;
  /** tool calls executed during this turn */
  toolCallsExecuted: number;
};

const DEFAULT_MAX_STEPS = 5;

export class Assistant {
  constructor(
    private context: Context,
    private client: ModelClient,
    private session: Session | null = null,
    private registry: ToolRegistry | null = null,
  ) {}

  setSession(s: Session | null) {
    this.session = s;
  }

  setRegistry(r: ToolRegistry | null) {
    this.registry = r;
  }

  get sessionId(): string | null {
    return this.session?.id ?? null;
  }

  async chat(userText: string, options: CompletionOptions & { maxSteps?: number } = {}): Promise<TurnResult> {
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    const tools = this.registry && this.registry.size() > 0 ? this.registry.definitions() : undefined;

    this.context.addUser(userText);
    await this.persistTurn({ role: "user", content: userText });

    let totalIn = 0;
    let totalOut = 0;
    let totalLatency = 0;
    let toolCallsExecuted = 0;
    let steps = 0;
    let lastSent = 0;
    let lastTrimmed = false;

    while (steps < maxSteps) {
      steps++;

      const messagesToSend = this.context.messagesForRequest();
      lastSent = messagesToSend.length;
      lastTrimmed = lastSent < this.context.all().length;

      const result = await this.client.complete(messagesToSend, { ...options, tools });
      totalIn += result.usage.promptTokens;
      totalOut += result.usage.completionTokens;
      totalLatency += result.latencyMs;

      // Tool-call branch: execute, append, loop.
      if (result.toolCalls && result.toolCalls.length > 0) {
        this.context.addAssistantToolCalls(result.reply, result.toolCalls);
        await this.persistTurn({
          role: "assistant",
          content: result.reply,
          model: this.client.id,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          latencyMs: result.latencyMs,
          toolCalls: result.toolCalls.map((tc) => ({ ...tc })),
        });

        for (const tc of result.toolCalls) {
          toolCallsExecuted++;
          const toolResult = await this.executeToolCall(tc);
          this.context.addToolResult(tc.id, toolResult);
          await this.persistTurn({
            role: "tool",
            content: toolResult,
            toolCallId: tc.id,
          });
        }
        continue;
      }

      // Text-reply branch: terminal.
      this.context.addAssistant(result.reply);
      this.context.recordUsage(totalIn, totalOut);
      await this.persistTurn({
        role: "assistant",
        content: result.reply,
        model: this.client.id,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        latencyMs: result.latencyMs,
      });

      return {
        reply: result.reply,
        promptTokens: totalIn,
        completionTokens: totalOut,
        latencyMs: totalLatency,
        sentMessages: lastSent,
        totalMessages: this.context.all().length,
        trimmed: lastTrimmed,
        steps,
        toolCallsExecuted,
      };
    }

    // We hit max steps without a terminal reply. Surface a synthetic
    // assistant turn so the conversation isn't left in a tool-call state.
    const exhaustedReply = `(Stopped after ${maxSteps} steps without a final reply — likely caught in a tool-call loop.)`;
    this.context.addAssistant(exhaustedReply);
    this.context.recordUsage(totalIn, totalOut);
    await this.persistTurn({
      role: "assistant",
      content: exhaustedReply,
      model: this.client.id,
      promptTokens: totalIn,
      completionTokens: totalOut,
      latencyMs: totalLatency,
    });

    return {
      reply: exhaustedReply,
      promptTokens: totalIn,
      completionTokens: totalOut,
      latencyMs: totalLatency,
      sentMessages: lastSent,
      totalMessages: this.context.all().length,
      trimmed: lastTrimmed,
      steps,
      toolCallsExecuted,
    };
  }

  private async executeToolCall(tc: ToolCallReq): Promise<string> {
    const tool = this.registry?.get(tc.function.name);
    if (!tool) {
      const available = this.registry ? this.registry.list().map((t) => t.definition.name).join(", ") : "(none)";
      return `Error: tool '${tc.function.name}' is not registered. Available tools: ${available}.`;
    }
    let args: unknown;
    try {
      args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch (e: any) {
      return `Error: tool '${tc.function.name}' was called with invalid JSON arguments: ${e?.message ?? e}. The arguments must be a JSON object.`;
    }
    const validation = validateArgs(args, tool.definition.parameters);
    if (!validation.ok) {
      return `Error calling '${tc.function.name}': ${validation.error}`;
    }
    try {
      return await tool.execute(args as Record<string, unknown>);
    } catch (e: any) {
      return `Error executing '${tc.function.name}': ${e?.message ?? e}`;
    }
  }

  private async persistTurn(record: {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    latencyMs?: number;
    toolCalls?: ToolCallReq[];
    toolCallId?: string;
  }): Promise<void> {
    if (!this.session) return;
    try {
      await this.session.append(record);
    } catch (e: any) {
      console.warn(`[persist warning] could not append to session ${this.session.id}: ${e?.message ?? e}`);
    }
  }

  get state(): Context {
    return this.context;
  }

  get modelId(): string {
    return this.client.id;
  }
}
