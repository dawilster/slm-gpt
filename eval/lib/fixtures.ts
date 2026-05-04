/**
 * Common fixtures shared across suites — assistant construction, the mock
 * shortcuts client, corpus seeding, scratch-dir helpers.
 *
 * The point of this file is that each suite imports a one-liner and gets a
 * working assistant + clean tmpdir, instead of re-inlining ~40 lines of
 * setup like every old eval did.
 */

import { mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAICompatClient, discoverModel } from "../../src/client";
import type { Msg, ToolCallReq } from "../../src/client";
import { Context } from "../../src/context";
import { Assistant } from "../../src/assistant";
import { Profile } from "../../src/profile";
import {
  ToolRegistry,
  getCurrentTimeTool,
  makeForgetTool,
  makeRememberTool,
  makeRunShortcutTool,
  makeListShortcutsTool,
  makeSearchCorpusTool,
} from "../../src/tools";
import type { EmbeddingClient } from "../../src/embeddings";
import type { IndexStore } from "../../src/index_store";
import { rankShortcutsByFuzzy } from "../../src/shortcuts";
import type { ListShortcutsResult, RunShortcutResult, ShortcutEntry } from "../../src/shortcuts";

export const BASE_URL = process.env.MODEL_BASE_URL ?? "http://localhost:1234/v1";
export const API_KEY = process.env.MODEL_API_KEY ?? "lm-studio";
export const THINKING = process.env.HALO_THINKING === "1";

/** Mirrors src/server.ts BASE_SYSTEM. Suites that need to override pass their own. */
export const BASE_SYSTEM = [
  "You are a helpful personal assistant. Be concise and direct. If you don't know or don't remember, say so. Never invent facts about the user.",
  "Tools are real function calls — invoke them through the tool-call mechanism. Never write a tool name and arguments as plain text in your reply.",
  "Memory: invoke `remember(key, value)` when the user states a stable fact about themselves — preferences, identity, defaults. Action requests (notes, timers, reminders, calendar, lights, etc.) go through `run_shortcut`, never `remember`. Invoke `forget` only when a fact no longer applies and has no replacement.",
  "Retrieval: invoke `search_corpus` for questions about the user's content. Skip retrieval for action requests. Don't query the same thing twice in one turn.",
  "Actions: world-changing actions go through `run_shortcut(name, input?)`. Each shortcut in the list below carries an `intent` tag. Pick the shortcut whose intent matches the user's request; when two share an intent, prefer the one tagged `default`. Pass user-provided content as `input`. Chain by calling `run_shortcut` once per step.",
  "Output formats: todo list / checklist / checkboxes → format items as `- [ ] item`. Numbered steps → `1. step`. Otherwise plain prose.",
  "Recovery: when a tool returns an Error, immediately invoke the tool again with corrected arguments. Don't narrate intent.",
].join("\n");

// ─── Workspace ────────────────────────────────────────────────

export class Workspace {
  constructor(public readonly root: string) {}
  static async create(label: string): Promise<Workspace> {
    const root = join(tmpdir(), `assistant-eval-${label}-${process.pid}-${Date.now()}`);
    await mkdir(root, { recursive: true });
    return new Workspace(root);
  }
  path(...parts: string[]): string { return join(this.root, ...parts); }
  async cleanup(): Promise<void> { await rm(this.root, { recursive: true, force: true }); }
}

// ─── Model + assistant builder ────────────────────────────────

export type AssistantOpts = {
  systemPrompt?: string;
  budget?: number;
  profile?: Profile;
  shortcuts?: { client: ShortcutsClientLike; entries?: readonly ShortcutEntry[] };
  corpus?: { store: IndexStore; embedder: EmbeddingClient };
  /** Add `get_current_time`. Default true. */
  withTime?: boolean;
  /** Override the discovered model. */
  model?: string;
};

export type AssistantBundle = {
  assistant: Assistant;
  context: Context;
  registry: ToolRegistry;
  profile: Profile | null;
};

let cachedModel: string | null = null;
export async function getModel(): Promise<string> {
  if (cachedModel) return cachedModel;
  cachedModel = await discoverModel(BASE_URL, API_KEY);
  return cachedModel;
}

export function newAssistant(opts: AssistantOpts = {}): AssistantBundle {
  if (!cachedModel) throw new Error("call getModel() before newAssistant() so the model is discovered once per run");
  const client = new OpenAICompatClient({ baseURL: BASE_URL, apiKey: API_KEY, model: opts.model ?? cachedModel });
  const ctx = new Context({ systemPrompt: opts.systemPrompt ?? BASE_SYSTEM, budget: opts.budget ?? 4096 });
  const registry = new ToolRegistry();
  if (opts.withTime ?? true) registry.register(getCurrentTimeTool);
  if (opts.profile) {
    registry.register(makeRememberTool(opts.profile));
    registry.register(makeForgetTool(opts.profile));
  }
  if (opts.shortcuts) {
    registry.register(makeListShortcutsTool(opts.shortcuts.client as never));
    registry.register(makeRunShortcutTool(opts.shortcuts.client as never));
  }
  if (opts.corpus) {
    registry.register(makeSearchCorpusTool(opts.corpus));
  }
  return {
    assistant: new Assistant(ctx, client, null, registry),
    context: ctx,
    registry,
    profile: opts.profile ?? null,
  };
}

// ─── Tool-call introspection ──────────────────────────────────

export type ObservedCall = {
  name: string;
  args: Record<string, unknown>;
  result: string;
};

export function observedCallsInLastTurn(ctx: Context): ObservedCall[] {
  const all = ctx.all();
  let userIdx = all.length - 1;
  while (userIdx >= 0 && all[userIdx]?.role !== "user") userIdx--;
  const calls: ObservedCall[] = [];
  for (let j = userIdx + 1; j < all.length; j++) {
    const m: Msg | undefined = all[j];
    if (m?.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls as ToolCallReq[]) {
        const res = all.slice(j + 1).find((mm) => mm.role === "tool" && mm.toolCallId === tc.id);
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(tc.function.arguments || "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        } catch { /* malformed; leave empty */ }
        calls.push({ name: tc.function.name, args, result: res?.content ?? "" });
      }
    }
  }
  return calls;
}

export function toolNamesCalled(ctx: Context): string[] {
  return observedCallsInLastTurn(ctx).map((c) => c.name);
}

// ─── Mock Shortcuts client ────────────────────────────────────

export interface ShortcutsClientLike {
  list(opts?: { force?: boolean }): Promise<ListShortcutsResult>;
  run(name: string, input?: string): Promise<RunShortcutResult>;
  fuzzyMatches(query: string, n?: number): Promise<string[]>;
  cachedNames(): string[] | null;
  cachedEntries(): ShortcutEntry[] | null;
  invalidateCache(): void;
}

export class MockShortcutsClient implements ShortcutsClientLike {
  public runCalls: Array<{ name: string; input?: string }> = [];
  constructor(private readonly entries: readonly ShortcutEntry[]) {}

  async list(): Promise<ListShortcutsResult> {
    return {
      ok: true,
      shortcuts: this.entries.map((e) => ({ ...e })),
      cachedAt: Date.now(),
      fromCache: false,
    };
  }
  async run(name: string, input?: string): Promise<RunShortcutResult> {
    if (!this.entries.some((e) => e.name === name)) {
      return { ok: false, error: `shortcut '${name}' not found`, kind: "missing" };
    }
    this.runCalls.push({ name, input });
    return { ok: true, output: "" };
  }
  async fuzzyMatches(query: string, n = 3): Promise<string[]> {
    return rankShortcutsByFuzzy(query, this.entries.map((e) => e.name), n);
  }
  cachedNames(): string[] { return this.entries.map((e) => e.name); }
  cachedEntries(): ShortcutEntry[] { return this.entries.map((e) => ({ ...e })); }
  invalidateCache(): void { /* no-op */ }
}

// ─── Corpus seeding ───────────────────────────────────────────

export async function writeNote(ws: Workspace, name: string, body: string): Promise<string> {
  const dir = ws.path("notes");
  await mkdir(dir, { recursive: true });
  const p = join(dir, name);
  await writeFile(p, body, "utf-8");
  return p;
}

export async function writeSession(
  ws: Workspace,
  id: string,
  turns: Array<{ role: "system" | "user" | "assistant"; content: string; ts?: string }>,
): Promise<string> {
  const dir = ws.path("sessions");
  await mkdir(dir, { recursive: true });
  const p = join(dir, `${id}.jsonl`);
  for (const t of turns) {
    await appendFile(p, JSON.stringify({ ts: new Date().toISOString(), ...t }) + "\n", "utf-8");
  }
  return p;
}
