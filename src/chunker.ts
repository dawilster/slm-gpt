/**
 * Chunkers — turn raw notes / sessions into retrievable units.
 *
 * Two strategies, one per source type:
 *
 *   - Markdown notes: heading-section chunks. Carry the heading path
 *     ("Brisbane > Bridges") so the embedded text captures topical
 *     structure, not just raw content. Sections that exceed MAX_CHUNK_CHARS
 *     are split on paragraph boundaries with overlap.
 *
 *   - Sessions (JSONL turn records): user+assistant pair chunks. Tool and
 *     system messages are skipped — they're operational noise that hurts
 *     retrieval (the model would surface tool-call internals when asked
 *     "what did we talk about last week?").
 *
 * Chunks are split into two text fields:
 *   - `embedText`: what we send to the embedding model. Includes provenance
 *     (filename, heading path) so semantically similar content from
 *     unrelated notes doesn't collide on retrieval.
 *   - `displayText`: what we hand back to the chat model when retrieved.
 *     Same content but formatted as "(from notes/foo.md, ## Bar): ...".
 */

import type { TurnRecord } from "./sessions";

export type Chunk = {
  /** Logical position within the source — used for stable upsert ordering. */
  index: number;
  /** Path used for retrieval+embedding context (filename, heading path, session id). */
  headingPath: string;
  /** Pre-formatted content fed to the embedding model. Includes provenance. */
  embedText: string;
  /** Content shown to the chat model when this chunk is retrieved. */
  displayText: string;
  /**
   * "When the content is *about*", as YYYY-MM-DD, when derivable from the
   * source itself rather than from file mtime. Sessions get this from the
   * timestamp embedded in their id; transcripts will get it from recording
   * time. Notes leave it undefined — the source mtime is the only signal.
   */
  contentDate?: string;
  /**
   * Decomposed-thought tag for downstream filtering — e.g. "TODO", "fact",
   * "idea", "decision", "reminder". Set by the Pebble pipeline's decompose
   * step (§3.6, planned); undefined for everything that's not an atomic
   * decomposed unit.
   */
  intent?: string;
};

const MAX_CHUNK_CHARS = 1600; // ~400 tokens — comfortable in a 4K budget
const OVERLAP_CHARS = 200;

// ─── markdown ─────────────────────────────────────────────────────────

/**
 * Split a markdown document into heading-section chunks.
 *
 * A new chunk starts at every heading line (`#`, `##`, `###`, …). Content
 * before any heading goes into a synthetic "(intro)" chunk. Sections that
 * exceed MAX_CHUNK_CHARS are split with overlap so a long aside still
 * surfaces in retrieval rather than being silently truncated.
 */
export function chunkMarkdown(filename: string, content: string): Chunk[] {
  type Section = { headingPath: string[]; lines: string[] };
  const sections: Section[] = [];
  const stack: string[] = []; // current heading path by level (1-based; index 0 unused)

  let current: Section = { headingPath: [], lines: [] };
  sections.push(current);

  for (const line of content.split("\n")) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      const level = m[1]!.length;
      const text = m[2]!;
      // Truncate the heading stack to current level - 1, then append.
      stack.length = level - 1;
      stack[level - 1] = text;
      // Compact null entries (skipped levels).
      const path = stack.filter((s): s is string => typeof s === "string");
      current = { headingPath: [...path], lines: [] };
      sections.push(current);
      continue;
    }
    current.lines.push(line);
  }

  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const sec of sections) {
    const body = sec.lines.join("\n").trim();
    if (body.length === 0) continue;

    const headingPath = sec.headingPath.length > 0 ? sec.headingPath.join(" > ") : "(intro)";
    const splits = splitWithOverlap(body, MAX_CHUNK_CHARS, OVERLAP_CHARS);

    for (let i = 0; i < splits.length; i++) {
      const part = splits[i]!;
      const partLabel = splits.length > 1 ? ` (part ${i + 1}/${splits.length})` : "";
      const fullHeading = `${headingPath}${partLabel}`;
      chunks.push({
        index: chunkIndex++,
        headingPath: fullHeading,
        embedText: `Note: ${filename}\nSection: ${fullHeading}\n\n${part}`,
        displayText: `(from notes/${filename}, ${fullHeading})\n${part}`,
      });
    }
  }

  return chunks;
}

// ─── sessions ─────────────────────────────────────────────────────────

/**
 * Chunk a session's turns into user+assistant pairs. System and tool
 * turns are dropped from the index — they're either boilerplate (system
 * prompts) or operational noise (tool calls / results) that pollutes
 * retrieval. The chat model can always re-derive operational context
 * if a referenced session is reloaded.
 *
 * If the assistant turn is unusually long (> MAX_CHUNK_CHARS), it's split
 * with overlap and the user turn is repeated as preamble — keeps the
 * "what was the user asking?" context attached to every shard.
 */
export function chunkSession(sessionId: string, turns: TurnRecord[]): Chunk[] {
  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    if (t.role !== "user") continue;
    // Find the next assistant turn (skip tool turns in between).
    let assistantTurn: TurnRecord | undefined;
    for (let j = i + 1; j < turns.length; j++) {
      const next = turns[j]!;
      if (next.role === "assistant") {
        assistantTurn = next;
        break;
      }
      if (next.role === "user") break; // unanswered user turn
    }
    if (!assistantTurn) continue;

    const userText = t.content.trim();
    const asstText = assistantTurn.content.trim();
    if (userText.length === 0 || asstText.length === 0) continue;

    const date = t.ts.slice(0, 10); // YYYY-MM-DD
    const headingPath = `${date}, turn ${i + 1}`;
    const combined = `User: ${userText}\nAssistant: ${asstText}`;
    const splits = splitWithOverlap(combined, MAX_CHUNK_CHARS, OVERLAP_CHARS);

    for (let s = 0; s < splits.length; s++) {
      const part = splits[s]!;
      const partLabel = splits.length > 1 ? ` (part ${s + 1}/${splits.length})` : "";
      const fullHeading = `${headingPath}${partLabel}`;
      chunks.push({
        index: chunkIndex++,
        headingPath: fullHeading,
        embedText: `Session: ${sessionId}\nDate: ${date}\n\n${part}`,
        displayText: `(from session ${sessionId}, ${fullHeading})\n${part}`,
        contentDate: date,
      });
    }
  }

  return chunks;
}

// ─── shared ───────────────────────────────────────────────────────────

/**
 * Split text on paragraph boundaries when possible, falling back to
 * fixed-size windows with overlap when a single paragraph blows the
 * cap. Overlap exists so a sentence straddling a window boundary
 * still appears whole in at least one chunk.
 */
function splitWithOverlap(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) return [text];

  // First try paragraph splits — markdown / chat content is naturally paragraphed.
  const paragraphs = text.split(/\n\n+/);
  if (paragraphs.length > 1) {
    const out: string[] = [];
    let current = "";
    for (const p of paragraphs) {
      if (current.length + p.length + 2 > maxChars && current.length > 0) {
        out.push(current);
        current = "";
      }
      current = current.length === 0 ? p : `${current}\n\n${p}`;
      if (current.length > maxChars) {
        // Single paragraph overflowed; force a window split on it.
        for (const w of windowSplit(current, maxChars, overlap)) out.push(w);
        current = "";
      }
    }
    if (current.length > 0) out.push(current);
    return out;
  }

  return windowSplit(text, maxChars, overlap);
}

function windowSplit(text: string, maxChars: number, overlap: number): string[] {
  const out: string[] = [];
  const stride = Math.max(1, maxChars - overlap);
  for (let i = 0; i < text.length; i += stride) {
    out.push(text.slice(i, i + maxChars));
    if (i + maxChars >= text.length) break;
  }
  return out;
}
