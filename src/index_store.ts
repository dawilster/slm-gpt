/**
 * IndexStore — bun:sqlite-backed chunk + embedding store.
 *
 * Schema is intentionally tiny — two tables. `sources` tracks which files
 * we've seen and their mtime so re-indexing can skip unchanged content.
 * `chunks` holds the actual embedded units. Embeddings are stored as raw
 * BLOBs (Float32Array.buffer); querying runs a brute-force cosine-similarity
 * pass in JS over all chunks. For a personal corpus (hundreds to thousands
 * of chunks) this is plenty fast — <50ms per query — and avoids pulling in
 * sqlite-vec, which has patchy MLX-stack compatibility.
 *
 * Embeddings are pre-normalized at insert time, so cosine similarity
 * collapses to a plain dot product at query time.
 */

import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { Chunk } from "./chunker";
import { cosineSim } from "./embeddings";

export type SourceType = "note" | "session";

export type SourceRow = {
  source_type: SourceType;
  source_path: string;
  mtime: number;
  indexed_at: number;
};

export type ScoredChunk = {
  sourceType: SourceType;
  sourcePath: string;
  chunkIndex: number;
  headingPath: string;
  displayText: string;
  similarity: number;
  /** Source-file mtime, denormalized onto the chunk for cheap recency filtering / boosting. */
  sourceMtime: number | null;
  /** "When the content is *about*" (YYYY-MM-DD). Distinct from mtime for transcripts/sessions. */
  contentDate: string | null;
  /** Decomposed-thought tag (e.g. "TODO", "fact"). Null for plain notes / sessions. */
  intent: string | null;
};

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sources (
    source_type TEXT NOT NULL,
    source_path TEXT NOT NULL,
    mtime INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL,
    PRIMARY KEY (source_type, source_path)
  );

  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL,
    source_path TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    heading_path TEXT,
    display_text TEXT NOT NULL,
    embedding BLOB NOT NULL,
    source_mtime INTEGER,
    content_date TEXT,
    intent TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_type, source_path);
`;

export class IndexStore {
  private db: Database;

  constructor(public readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(SCHEMA_SQL);
    this.migrateChunkColumns();
  }

  /**
   * Additive ALTER for the chunks table. SQLite's `CREATE TABLE IF NOT EXISTS`
   * doesn't add columns to a table that already exists, so any DB created
   * before source_mtime / content_date / intent landed needs them grafted on.
   * All three are nullable, so existing rows stay valid; re-indexing a source
   * fills the new columns going forward.
   */
  private migrateChunkColumns(): void {
    const cols = this.db
      .query<{ name: string }, []>("PRAGMA table_info(chunks)")
      .all()
      .map((r) => r.name);
    if (!cols.includes("source_mtime")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN source_mtime INTEGER");
    }
    if (!cols.includes("content_date")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN content_date TEXT");
    }
    if (!cols.includes("intent")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN intent TEXT");
    }
  }

  /** Lookup the recorded mtime for a source, or null if unknown. */
  getSourceMtime(type: SourceType, path: string): number | null {
    const row = this.db
      .query<{ mtime: number }, [string, string]>(
        "SELECT mtime FROM sources WHERE source_type = ? AND source_path = ?",
      )
      .get(type, path);
    return row?.mtime ?? null;
  }

  /**
   * Replace all chunks for a source atomically. Deletes prior chunks,
   * inserts the new set, and updates the source row. Run inside a single
   * transaction so partial failures don't leave dangling chunks.
   */
  replaceSource(
    type: SourceType,
    path: string,
    mtime: number,
    chunks: Array<{ chunk: Chunk; embedding: Float32Array }>,
  ): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db.run("DELETE FROM chunks WHERE source_type = ? AND source_path = ?", [type, path]);
      const insertChunk = this.db.query(
        "INSERT INTO chunks (source_type, source_path, chunk_index, heading_path, display_text, embedding, source_mtime, content_date, intent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const { chunk, embedding } of chunks) {
        insertChunk.run(
          type,
          path,
          chunk.index,
          chunk.headingPath,
          chunk.displayText,
          new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength),
          mtime,
          chunk.contentDate ?? null,
          chunk.intent ?? null,
        );
      }
      this.db.run(
        "INSERT INTO sources (source_type, source_path, mtime, indexed_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(source_type, source_path) DO UPDATE SET mtime = excluded.mtime, indexed_at = excluded.indexed_at",
        [type, path, mtime, now],
      );
    });
    tx();
  }

  /** Drop a source and its chunks (e.g., file was deleted). */
  deleteSource(type: SourceType, path: string): void {
    const tx = this.db.transaction(() => {
      this.db.run("DELETE FROM chunks WHERE source_type = ? AND source_path = ?", [type, path]);
      this.db.run("DELETE FROM sources WHERE source_type = ? AND source_path = ?", [type, path]);
    });
    tx();
  }

  listSources(): SourceRow[] {
    return this.db
      .query<SourceRow, []>("SELECT source_type, source_path, mtime, indexed_at FROM sources")
      .all();
  }

  chunkCount(): number {
    return this.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM chunks").get()?.c ?? 0;
  }

  /**
   * Brute-force top-K cosine search. Loads all chunks (optionally pre-filtered
   * by SQL on cheap columns), scores against the query embedding, returns the
   * K highest above `minSimilarity`.
   *
   * Filters:
   *   - `sourceTypes`: limit to e.g. notes only.
   *   - `intent`: limit to chunks tagged with a given decomposed-thought intent.
   *   - `sinceMtime`: drop chunks whose source mtime predates this epoch ms
   *     (e.g., "only consider files modified in the last 30 days").
   */
  search(
    queryEmbedding: Float32Array,
    opts: {
      k?: number;
      minSimilarity?: number;
      sourceTypes?: SourceType[];
      intent?: string;
      sinceMtime?: number;
    } = {},
  ): ScoredChunk[] {
    const k = opts.k ?? 3;
    const minSim = opts.minSimilarity ?? 0.3;

    let sql =
      "SELECT source_type, source_path, chunk_index, heading_path, display_text, embedding, source_mtime, content_date, intent FROM chunks";
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.sourceTypes && opts.sourceTypes.length > 0) {
      where.push(`source_type IN (${opts.sourceTypes.map(() => "?").join(",")})`);
      params.push(...opts.sourceTypes);
    }
    if (opts.intent) {
      where.push("intent = ?");
      params.push(opts.intent);
    }
    if (opts.sinceMtime != null) {
      where.push("source_mtime >= ?");
      params.push(opts.sinceMtime);
    }
    if (where.length > 0) sql += " WHERE " + where.join(" AND ");

    type Row = {
      source_type: string;
      source_path: string;
      chunk_index: number;
      heading_path: string;
      display_text: string;
      embedding: Uint8Array;
      source_mtime: number | null;
      content_date: string | null;
      intent: string | null;
    };
    const rows = this.db.query<Row, (string | number)[]>(sql).all(...params);

    const scored: ScoredChunk[] = [];
    for (const r of rows) {
      const emb = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
      const sim = cosineSim(queryEmbedding, emb);
      if (sim < minSim) continue;
      scored.push({
        sourceType: r.source_type as SourceType,
        sourcePath: r.source_path,
        chunkIndex: r.chunk_index,
        headingPath: r.heading_path,
        displayText: r.display_text,
        similarity: sim,
        sourceMtime: r.source_mtime,
        contentDate: r.content_date,
        intent: r.intent,
      });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, k);
  }

  close(): void {
    this.db.close();
  }
}
