/**
 * Tools — the registry and built-in implementations.
 *
 * A tool is: a name, a description (what tells the model when to call it),
 * a JSON-Schema for parameters, and an async execute function.
 *
 * The registry holds them by name and provides the definition list that
 * gets shipped to the model alongside each chat completion request.
 */

import { join, normalize, resolve } from "node:path";

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
 * Read a note from the user's notes directory.
 *
 * Path safety: rejects parent traversal (`..`), absolute paths, and any
 * resolved path that escapes the notes root. The model can only read
 * files inside the configured notes directory.
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
      const path = args.path;
      if (typeof path !== "string" || path.length === 0) {
        return "Error: 'path' argument is required and must be a non-empty string.";
      }
      if (path.includes("..") || path.startsWith("/")) {
        return "Error: path must be a filename within the notes folder, not a parent or absolute path.";
      }
      const full = resolve(root, normalize(path));
      // Belt-and-braces: confirm the resolved path is still inside the root.
      if (!full.startsWith(root + "/") && full !== root) {
        return "Error: path escapes the notes folder.";
      }
      try {
        const content = await Bun.file(full).text();
        return content;
      } catch (e: any) {
        return `Error: could not read '${path}': ${e?.message ?? e}`;
      }
    },
  };
}
