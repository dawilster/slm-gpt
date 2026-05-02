/**
 * Synthetic tool-call recovery.
 *
 * Smaller local models (Qwen 3 4B in particular) sometimes emit tool calls
 * as plain text in their reply instead of using the OpenAI `tool_calls`
 * API — even when the structured option is right there in the prompt.
 *
 * Without help, the runtime can't tell those calls apart from any other
 * narrative paragraph: the assistant returns "I'll write a note for you,"
 * proceeds to print `write_note("foo.md", "...")`, and nothing actually
 * runs.
 *
 * This module recovers that case. It scans an assistant reply for
 * `name(args…)` patterns, looks each up in the registry, parses the
 * arguments (positional strings → schema-keyed object, or pseudo-JSON)
 * and rebuilds them as proper ToolCallReq objects so the agent loop
 * can execute them like the model intended.
 *
 * Conservative on purpose: only matches names that resolve to a registered
 * tool, only parses arguments shapes we can ground in the schema, and
 * leaves the surrounding narrative text untouched as the assistant's
 * preamble.
 */

import type { ToolCallReq } from "./client";
import type { ToolDefinition, ToolRegistry } from "./tools";

export type SyntheticParse = {
  /** Text before/after/between the function calls — kept as-is, modulo
   *  whitespace cleanup. Persisted as the assistant's narrative turn. */
  preamble: string;
  /** Synthesized calls, ready to feed back into the agent loop. */
  calls: ToolCallReq[];
};

/**
 * Find synthetic tool calls in `text` and return them plus the cleaned-up
 * narrative. Returns null if nothing usable was found.
 */
export function parseSyntheticToolCalls(
  text: string,
  registry: ToolRegistry,
): SyntheticParse | null {
  const calls: ToolCallReq[] = [];
  const removed: Array<[number, number]> = [];

  let pos = 0;
  while (pos < text.length) {
    const found = findFunctionCall(text, pos);
    if (!found) break;

    const tool = registry.get(found.name);
    if (!tool) {
      pos = found.end;
      continue;
    }
    const args = parseArgs(found.argsRaw, tool.definition);
    if (!args) {
      pos = found.end;
      continue;
    }

    calls.push({
      id: `synthetic_${calls.length}_${Date.now().toString(36)}`,
      type: "function",
      function: {
        name: found.name,
        arguments: JSON.stringify(args),
      },
    });
    removed.push([found.start, found.end]);
    pos = found.end;
  }

  if (calls.length === 0) return null;

  // Reassemble the surrounding text minus the synthesized ranges.
  let preamble = "";
  let cursor = 0;
  for (const [start, end] of removed) {
    preamble += text.slice(cursor, start);
    cursor = end;
  }
  preamble += text.slice(cursor);

  // Tidy: collapse 3+ blank lines to 2, trim ends.
  preamble = preamble.replace(/\n{3,}/g, "\n\n").trim();

  return { preamble, calls };
}

// ─── Internals ─────────────────────────────────────────

type Found = { name: string; argsRaw: string; start: number; end: number };

/**
 * Scan from `fromIndex` for the next `identifier(...)` expression. The
 * argument span is consumed by tracking parenthesis depth and quote state
 * so parens or commas inside `"strings"` don't confuse the boundaries.
 */
function findFunctionCall(text: string, fromIndex: number): Found | null {
  const idRegex = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  idRegex.lastIndex = fromIndex;
  const m = idRegex.exec(text);
  if (!m) return null;

  const name = m[1]!;
  const start = m.index;
  let i = idRegex.lastIndex;        // just past the '('
  const argsStart = i;
  let depth = 1;
  let inString = false;

  while (i < text.length && depth > 0) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\" && i + 1 < text.length) { i += 2; continue; }
      if (c === '"') { inString = false; i++; continue; }
      i++;
    } else if (c === '"') {
      inString = true; i++;
    } else if (c === "(") {
      depth++; i++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) {
        return { name, argsRaw: text.slice(argsStart, i), start, end: i + 1 };
      }
      i++;
    } else {
      i++;
    }
  }
  // Unbalanced parens — bail rather than guess.
  return null;
}

/**
 * Map a raw argument string to a JSON-shaped record matching the tool's
 * schema. Two formats supported:
 *   - JSON object literal:  `{"name": "x", "input": "y"}`
 *   - Positional strings:   `"x", "y"`  → keys in schema-declared order
 */
function parseArgs(raw: string, def: ToolDefinition): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};

  // JSON object literal
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to positional
    }
  }

  // Positional strings, mapped by the schema's declared key order.
  const positional = parsePositionalStrings(trimmed);
  if (!positional) return null;

  const propKeys = Object.keys(def.parameters?.properties ?? {});
  const required = def.parameters?.required ?? [];
  // Required first (declared order), then any optional — matches how
  // schemas tend to list params.
  const orderedKeys = [
    ...required.filter((k) => propKeys.includes(k)),
    ...propKeys.filter((k) => !required.includes(k)),
  ];

  const out: Record<string, unknown> = {};
  for (let i = 0; i < positional.length && i < orderedKeys.length; i++) {
    out[orderedKeys[i]!] = positional[i];
  }
  return out;
}

/**
 * Tokenize a comma-separated list of double-quoted strings, decoding
 * common backslash escapes (\n, \t, \r, \", \\). Returns null if the
 * input contains anything that isn't a quoted string — we'd rather
 * skip than hallucinate args.
 */
function parsePositionalStrings(s: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i]!)) i++;
    if (i >= s.length) break;
    if (s[i] !== '"') return null;
    i++; // opening quote
    let cur = "";
    while (i < s.length) {
      const c = s[i]!;
      if (c === "\\" && i + 1 < s.length) {
        const n = s[i + 1]!;
        if      (n === "n")  cur += "\n";
        else if (n === "t")  cur += "\t";
        else if (n === "r")  cur += "\r";
        else if (n === '"')  cur += '"';
        else if (n === "\\") cur += "\\";
        else cur += n;
        i += 2;
      } else if (c === '"') {
        i++; // closing quote
        break;
      } else {
        cur += c;
        i++;
      }
    }
    out.push(cur);
  }
  return out;
}
