/**
 * Indexer — walks notes/ and sessions/, decides what's new or changed
 * via mtime, chunks each source, embeds chunks in batches, upserts.
 *
 * "Lazy on launch" is the indexing trigger: the REPL calls this once
 * at startup before the first user prompt. Cost is bounded — only
 * changed files are re-embedded — and the user sees a small "(indexed
 * N chunks)" line so they know it ran.
 *
 * Sessions are indexed up to but not including the currently-active
 * one — that file is being appended to in real time and is already
 * in the chat context, so retrieving over it would be redundant. It
 * gets indexed on the next launch.
 */

import { stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { EmbeddingClient } from "./embeddings";
import type { IndexStore, SourceType } from "./index_store";
import { chunkMarkdown, chunkSession, type Chunk } from "./chunker";
import { SessionStore } from "./sessions";

export type IndexResult = {
  notesIndexed: number;
  sessionsIndexed: number;
  chunksAdded: number;
  skipped: number;
};

export async function indexAll(opts: {
  store: IndexStore;
  embedder: EmbeddingClient;
  notesRoot: string;
  sessionsRoot: string;
  /** Session id to skip (the currently-open one, mid-write). */
  excludeSessionId?: string;
}): Promise<IndexResult> {
  const result: IndexResult = { notesIndexed: 0, sessionsIndexed: 0, chunksAdded: 0, skipped: 0 };

  // ── notes ──
  const noteFiles = await listMarkdownFiles(opts.notesRoot);
  for (const filename of noteFiles) {
    const fullPath = join(opts.notesRoot, filename);
    const fileStat = await stat(fullPath).catch(() => null);
    if (!fileStat) continue;
    const mtime = fileStat.mtimeMs;
    const recorded = opts.store.getSourceMtime("note", filename);
    if (recorded !== null && recorded >= mtime) {
      result.skipped++;
      continue;
    }
    const content = await Bun.file(fullPath).text();
    const chunks = chunkMarkdown(filename, content);
    if (chunks.length === 0) {
      // Empty note — drop any prior index entries.
      opts.store.deleteSource("note", filename);
      continue;
    }
    const withEmbeddings = await embedChunks(chunks, opts.embedder);
    opts.store.replaceSource("note", filename, mtime, withEmbeddings);
    result.notesIndexed++;
    result.chunksAdded += chunks.length;
  }

  // ── sessions ──
  const sessionStore = new SessionStore(opts.sessionsRoot);
  const sessionFiles = await listJsonlFiles(opts.sessionsRoot);
  for (const filename of sessionFiles) {
    const id = filename.replace(/\.jsonl$/, "");
    if (opts.excludeSessionId === id) {
      result.skipped++;
      continue;
    }
    const fullPath = join(opts.sessionsRoot, filename);
    const fileStat = await stat(fullPath).catch(() => null);
    if (!fileStat) continue;
    const mtime = fileStat.mtimeMs;
    const recorded = opts.store.getSourceMtime("session", id);
    if (recorded !== null && recorded >= mtime) {
      result.skipped++;
      continue;
    }
    let turns;
    try {
      turns = await sessionStore.loadTurns(id);
    } catch {
      continue;
    }
    const chunks = chunkSession(id, turns);
    if (chunks.length === 0) {
      opts.store.deleteSource("session", id);
      continue;
    }
    const withEmbeddings = await embedChunks(chunks, opts.embedder);
    opts.store.replaceSource("session", id, mtime, withEmbeddings);
    result.sessionsIndexed++;
    result.chunksAdded += chunks.length;
  }

  // Prune: any source rows whose underlying file no longer exists.
  const known = opts.store.listSources();
  for (const row of known) {
    const exists = await sourceExists(row.source_type, row.source_path, opts.notesRoot, opts.sessionsRoot);
    if (!exists) opts.store.deleteSource(row.source_type, row.source_path);
  }

  return result;
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root);
    return entries.filter((e) => e.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

async function listJsonlFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root);
    return entries.filter((e) => e.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
}

async function sourceExists(
  type: SourceType,
  path: string,
  notesRoot: string,
  sessionsRoot: string,
): Promise<boolean> {
  const fullPath =
    type === "note" ? join(notesRoot, path) : join(sessionsRoot, `${path}.jsonl`);
  return await Bun.file(fullPath).exists();
}

/**
 * Embed chunks in batches. nomic via LM Studio handles batches of 8-32
 * comfortably; we use a conservative 16 to keep latency predictable
 * (one big batch can stall the chat model's KV cache).
 */
async function embedChunks(
  chunks: Chunk[],
  embedder: EmbeddingClient,
): Promise<Array<{ chunk: Chunk; embedding: Float32Array }>> {
  const batchSize = 16;
  const out: Array<{ chunk: Chunk; embedding: Float32Array }> = [];
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const vectors = await embedder.embedMany(batch.map((c) => c.embedText));
    for (let j = 0; j < batch.length; j++) {
      out.push({ chunk: batch[j]!, embedding: vectors[j]! });
    }
  }
  return out;
}
