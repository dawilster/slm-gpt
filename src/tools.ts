/**
 * Tools — the registry and built-in implementations.
 *
 * A tool is: a name, a description (what tells the model when to call it),
 * a JSON-Schema for parameters, and an async execute function.
 *
 * The registry holds them by name and provides the definition list that
 * gets shipped to the model alongside each chat completion request.
 */

import { Profile } from "./profile";
import type { EmbeddingClient } from "./embeddings";
import type { IndexStore, ScoredChunk } from "./index_store";
import type { ShortcutsClient } from "./shortcuts";

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
};

export interface Tool {
  readonly definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  definitions(): ToolDefinition[] {
    return this.list().map((t) => t.definition);
  }

  size(): number {
    return this.tools.size;
  }
}

/**
 * Validate parsed tool arguments against the tool's declared schema.
 * Tiny hand-rolled validator — covers required fields + primitive types.
 * Returns an error message that's specific enough for the model to
 * self-correct on the next iteration of the agent loop.
 *
 * This is the v3.5 follow-up: a 3B model occasionally passes malformed
 * args (missing required fields, wrong types). Without validation, the
 * tool either silently misbehaves or throws an unhelpful internal error;
 * with validation, the model gets a structured nudge to try again.
 */
export function validateArgs(
  args: unknown,
  schema: ToolDefinition["parameters"],
): { ok: true } | { ok: false; error: string } {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { ok: false, error: "Arguments must be a JSON object." };
  }
  const obj = args as Record<string, unknown>;

  for (const req of schema.required ?? []) {
    if (!(req in obj)) return { ok: false, error: `Missing required field: '${req}'.` };
    const v = obj[req];
    if (v === undefined || v === null || (typeof v === "string" && v.length === 0)) {
      return { ok: false, error: `Required field '${req}' is missing or empty.` };
    }
  }

  for (const [name, def] of Object.entries(schema.properties)) {
    if (!(name in obj)) continue;
    const val = obj[name];
    const expected = def.type;
    const got = Array.isArray(val) ? "array" : val === null ? "null" : typeof val;
    if (expected === "string" && got !== "string") return { ok: false, error: `Field '${name}' must be a string, got ${got}.` };
    if (expected === "number" && got !== "number") return { ok: false, error: `Field '${name}' must be a number, got ${got}.` };
    if (expected === "integer" && (got !== "number" || !Number.isInteger(val))) return { ok: false, error: `Field '${name}' must be an integer, got ${got}.` };
    if (expected === "boolean" && got !== "boolean") return { ok: false, error: `Field '${name}' must be a boolean, got ${got}.` };
    if (expected === "object" && got !== "object") return { ok: false, error: `Field '${name}' must be an object, got ${got}.` };
    if (expected === "array" && got !== "array") return { ok: false, error: `Field '${name}' must be an array, got ${got}.` };
  }

  return { ok: true };
}

// ─── built-in tools ──────────────────────────────────────────────────

// Tool descriptions kept terse on principle: smaller models cope better
// with concise schemas, and a one-line description tends to be all the
// information the model needs to decide whether to call. (Earlier
// Qwen 2.5-3B was actively brittle to verbose descriptions; Qwen 3-4B
// is robust either way, but terse is still the better default.)
export const getCurrentTimeTool: Tool = {
  definition: {
    name: "get_current_time",
    description: "Get the current date and time as ISO 8601.",
    parameters: { type: "object", properties: {} },
  },
  execute: async () => new Date().toISOString(),
};

/**
 * remember(key, value) — write a stable fact about the user to the profile.
 *
 * Writes are auto-saved. Returns a confirmation that mentions the prior
 * value when overwriting, so the model has signal that an update happened
 * vs. a new entry was created.
 *
 * The profile is rendered into the system prompt at the start of each
 * user turn (see src/index.ts), so a fact written this turn becomes
 * "always known" on the next turn without needing a separate lookup tool.
 */
export function makeRememberTool(profile: Profile): Tool {
  return {
    definition: {
      name: "remember",
      description:
        "Save a stable fact about the user (preferences, relationships, places). Overwrites any prior value for the same key.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Short label, e.g., 'dog name', 'eggs', 'home'." },
          value: { type: "string", description: "The fact's value, e.g., 'Buddy', 'dislike', 'Cairns'." },
        },
        required: ["key", "value"],
      },
    },
    execute: async (args) => {
      const k = Profile.validateKey(args.key);
      if (!k.ok) return `Error: ${k.error}`;
      const v = Profile.validateValue(args.value);
      if (!v.ok) return `Error: ${v.error}`;
      const r = profile.set(k.key, v.value);
      await profile.save();
      if (r.prev !== undefined && r.prev !== r.value) {
        return `Saved '${r.key}: ${r.value}' (overwrote '${r.prev}').`;
      }
      return `Saved '${r.key}: ${r.value}'.`;
    },
  };
}

/**
 * forget(key) — remove a fact from the profile. Useful when the user
 * tells the assistant a previously-saved fact no longer applies and
 * has no replacement (otherwise prefer remember(...) to overwrite).
 */
export function makeForgetTool(profile: Profile): Tool {
  return {
    definition: {
      name: "forget",
      description: "Remove a fact from the user's profile by key.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "The key to forget, e.g., 'eggs'." },
        },
        required: ["key"],
      },
    },
    execute: async (args) => {
      const k = Profile.validateKey(args.key);
      if (!k.ok) return `Error: ${k.error}`;
      const normalized = Profile.normalizeKey(k.key);
      const removed = profile.delete(normalized);
      if (!removed) return `No fact under '${normalized}' — nothing to forget.`;
      await profile.save();
      return `Forgot '${normalized}'.`;
    },
  };
}

/**
 * search_corpus(query) — semantic search over indexed notes + past sessions.
 *
 * The model calls this when the user asks about content not currently in
 * chat context — "what did I write about X", "have we discussed Y before",
 * "summarize the brisbane note". Returns the top-K chunks above a similarity
 * threshold, formatted with their source attribution so the model can cite back.
 *
 * The retrieval cap is deliberately small (k=3) and the threshold conservative
 * (sim >= 0.3): at a 4K budget, dropping 10 mediocre chunks into context costs
 * more than it surfaces. Better to retrieve nothing than retrieve noise.
 */
export function makeSearchCorpusTool(opts: {
  store: IndexStore;
  embedder: EmbeddingClient;
}): Tool {
  return {
    definition: {
      name: "search_corpus",
      description:
        "Semantic search across the user's notes and past sessions. Call for questions about things they've written, said, or discussed (incl. 'what is X' / 'tell me about Y' if they may have notes on it). Returns up to 3 passages with source tags.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to find — a question, topic, or phrase." },
        },
        required: ["query"],
      },
    },
    execute: async (args) => {
      const query = args.query;
      if (typeof query !== "string" || query.trim().length === 0) {
        return "Error: 'query' must be a non-empty string.";
      }
      let queryEmbedding: Float32Array;
      try {
        queryEmbedding = await opts.embedder.embed(query);
      } catch (e: any) {
        return `Error: embedding failed: ${e?.message ?? e}`;
      }
      const results = opts.store.search(queryEmbedding, { k: 3, minSimilarity: 0.3 });
      if (results.length === 0) return `(no relevant content found for '${query}')`;
      return formatResults(results);
    },
  };
}

function formatResults(results: ScoredChunk[]): string {
  const blocks = results.map((r, i) => {
    const sim = r.similarity.toFixed(2);
    return `[${i + 1}] sim=${sim}\n${r.displayText}`;
  });
  return blocks.join("\n\n---\n\n");
}

/**
 * list_shortcuts — enumerate the user's macOS Shortcuts library.
 *
 * The model uses this to discover what's runnable; the Mac app uses
 * the same underlying ShortcutsClient via GET /v1/shortcuts.
 */
export function makeListShortcutsTool(client: ShortcutsClient): Tool {
  return {
    definition: {
      name: "list_shortcuts",
      description:
        "List the user's installed macOS Shortcuts. Call before run_shortcut if unsure of the exact name.",
      parameters: { type: "object", properties: {} },
    },
    execute: async () => {
      const r = await client.list();
      if (!r.ok) return `Error: could not list shortcuts: ${r.error}`;
      if (r.shortcuts.length === 0) return "(no shortcuts installed)";
      return r.shortcuts.map((s) => s.name).join("\n");
    },
  };
}

/**
 * run_shortcut — execute a Shortcut by name, optionally piping in text.
 *
 * Errors are designed for the v3.5 self-correct loop: an unknown name
 * returns "Available: …" and a "Closest matches" line so the model can
 * retry with the corrected name on the next iteration. A first-run
 * permission failure surfaces a clear "approve in the dialog" message
 * the model can pass on to the user verbatim.
 */
export function makeRunShortcutTool(client: ShortcutsClient): Tool {
  return {
    definition: {
      name: "run_shortcut",
      description:
        "Run a macOS Shortcut by exact name. Pass user-provided content as `input` (note body, timer duration, message) — without it the shortcut will prompt the user.",
      parameters: {
        type: "object",
        properties: {
          name:  { type: "string", description: "Exact shortcut name." },
          input: { type: "string", description: "Text content for the shortcut. Required when the user gave you content." },
        },
        required: ["name"],
      },
    },
    execute: async (args) => {
      const name = args.name;
      if (typeof name !== "string" || name.trim().length === 0) {
        return "Error: 'name' is required and must be a non-empty string.";
      }
      const input = typeof args.input === "string" ? args.input : undefined;

      const r = await client.run(name, input);
      if (r.ok) {
        const out = r.output.trimEnd();
        return out.length === 0 ? `Ran '${name}' (no output).` : `Ran '${name}'. Output:\n${out}`;
      }

      if (r.kind === "missing") {
        // Keep this payload SMALL — past versions returned the full library
        // alongside fuzzy matches and the redundancy collapsed Qwen 3-4B's
        // attention on chains. Top 3 suggestions only; if none, fall through
        // to a hint that list_shortcuts exists.
        const suggestions = await client.fuzzyMatches(name, 3);
        if (suggestions.length > 0) {
          return `Error: shortcut '${name}' not found. Did you mean: ${suggestions.join(", ")}? Retry with the exact name.`;
        }
        return `Error: shortcut '${name}' not found, and no close matches. Call list_shortcuts to see what's available.`;
      }

      if (r.kind === "permission") {
        return `Error: macOS hasn't authorized '${name}' yet. Tell the user to approve the permission dialog that just appeared (or run the shortcut manually once), then ask them to retry.`;
      }

      if (r.kind === "timeout") {
        return `Error: ${r.error}. Tell the user the shortcut is taking too long and may need to be invoked manually.`;
      }

      return `Error running '${name}': ${r.error}`;
    },
  };
}
