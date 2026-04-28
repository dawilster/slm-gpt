/**
 * Tools — the registry and built-in implementations.
 *
 * A tool is: a name, a description (what tells the model when to call it),
 * a JSON-Schema for parameters, and an async execute function.
 *
 * The registry holds them by name and provides the definition list that
 * gets shipped to the model alongside each chat completion request.
 */

import { readdir } from "node:fs/promises";
import { normalize, resolve } from "node:path";
import { Profile } from "./profile";

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
 * Resolve a user-supplied filename against the notes root, refusing
 * parent traversal, absolute paths, and any resolved path that escapes
 * the root. Returns the absolute filesystem path on success or an error
 * message string on rejection. Used by every notes-touching tool.
 */
function resolveNotePath(root: string, path: unknown): { ok: true; full: string } | { ok: false; error: string } {
  if (typeof path !== "string" || path.length === 0) {
    return { ok: false, error: "Error: 'path' argument is required and must be a non-empty string." };
  }
  if (path.includes("..") || path.startsWith("/")) {
    return { ok: false, error: "Error: path must be a filename within the notes folder, not a parent or absolute path." };
  }
  const full = resolve(root, normalize(path));
  if (!full.startsWith(root + "/") && full !== root) {
    return { ok: false, error: "Error: path escapes the notes folder." };
  }
  return { ok: true, full };
}

/**
 * Read a note from the user's notes directory.
 */
export function makeReadNoteTool(notesRoot: string): Tool {
  const root = resolve(notesRoot);
  return {
    definition: {
      name: "read_note",
      description: "Read a note file by filename (e.g., 'brisbane.md').",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Filename, e.g., 'brisbane.md'." },
        },
        required: ["path"],
      },
    },
    execute: async (args) => {
      const r = resolveNotePath(root, args.path);
      if (!r.ok) return r.error;
      try {
        return await Bun.file(r.full).text();
      } catch (e: any) {
        return `Error: could not read '${args.path}': ${e?.message ?? e}`;
      }
    },
  };
}

/**
 * List markdown notes in the notes directory. Returns a newline-delimited
 * list of filenames. No arguments — broad-stroke "what's there?" lookup.
 */
export function makeListNotesTool(notesRoot: string): Tool {
  const root = resolve(notesRoot);
  return {
    definition: {
      name: "list_notes",
      description: "List the filenames of all notes in the user's notes folder.",
      parameters: { type: "object", properties: {} },
    },
    execute: async () => {
      try {
        const entries = await readdir(root);
        const notes = entries.filter((e) => e.endsWith(".md")).sort();
        if (notes.length === 0) return "(no notes)";
        return notes.join("\n");
      } catch (e: any) {
        return `Error: could not list notes: ${e?.message ?? e}`;
      }
    },
  };
}

/**
 * Write (or overwrite) a markdown note. Restricted to `.md` files inside
 * the notes root. Same path-safety guarantees as read_note.
 */
export function makeWriteNoteTool(notesRoot: string): Tool {
  const root = resolve(notesRoot);
  return {
    definition: {
      name: "write_note",
      description: "Write a new note or overwrite an existing one. Filename must end in '.md'.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Filename, e.g., 'shopping.md'." },
          content: { type: "string", description: "Markdown body to save." },
        },
        required: ["path", "content"],
      },
    },
    execute: async (args) => {
      const r = resolveNotePath(root, args.path);
      if (!r.ok) return r.error;
      if (!r.full.endsWith(".md")) {
        return "Error: filename must end in '.md'.";
      }
      const content = args.content;
      if (typeof content !== "string") {
        return "Error: 'content' argument is required and must be a string.";
      }
      try {
        await Bun.write(r.full, content);
        return `Wrote ${args.path} (${content.length} chars).`;
      } catch (e: any) {
        return `Error: could not write '${args.path}': ${e?.message ?? e}`;
      }
    },
  };
}

/**
 * Search notes by filename substring (case-insensitive). Returns matching
 * filenames newline-delimited. Doesn't search content — that's RAG (v5).
 */
export function makeSearchNotesByFilenameTool(notesRoot: string): Tool {
  const root = resolve(notesRoot);
  return {
    definition: {
      name: "search_notes_by_filename",
      description: "Find notes whose filename contains the given substring (case-insensitive).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring to match against filenames." },
        },
        required: ["query"],
      },
    },
    execute: async (args) => {
      const query = args.query;
      if (typeof query !== "string" || query.length === 0) {
        return "Error: 'query' argument is required and must be a non-empty string.";
      }
      try {
        const entries = await readdir(root);
        const q = query.toLowerCase();
        const matches = entries
          .filter((e) => e.endsWith(".md") && e.toLowerCase().includes(q))
          .sort();
        if (matches.length === 0) return `(no notes match '${query}')`;
        return matches.join("\n");
      } catch (e: any) {
        return `Error: could not search notes: ${e?.message ?? e}`;
      }
    },
  };
}

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
