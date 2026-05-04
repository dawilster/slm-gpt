/**
 * index_metadata eval — verify the metadata + filter additions to IndexStore
 * (source_mtime, content_date, intent) actually flow end-to-end.
 *
 * Out of scope: embedding quality, retrieval quality on real corpora —
 * those live in eval/v6.ts. This eval is the cheap correctness gate
 * that catches "I added a column but forgot to populate it" bugs.
 *
 * Doesn't need a model server: a stub embedder returns deterministic
 * vectors so we can assert exactly which chunks search() returns.
 *
 * Run with:  bun run eval/perf/index_metadata.ts
 * Exit 0 if all checks pass.
 */

import { mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { IndexStore } from "../../src/index_store";
import { indexAll } from "../../src/indexer";
import { chunkMarkdown } from "../../src/chunker";

const TEST_ROOT = join(tmpdir(), `assistant-index-meta-${process.pid}-${Date.now()}`);
const NOTES_ROOT = join(TEST_ROOT, "notes");
const SESSIONS_ROOT = join(TEST_ROOT, "sessions");
const DB_PATH = join(TEST_ROOT, "index.sqlite");

const EMBED_DIM = 8; // tiny — we control the vectors anyway

// Deterministic vector generator: hash text into a fixed-dim Float32Array, then normalize.
function fakeVector(text: string): Float32Array {
  const v = new Float32Array(EMBED_DIM);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  for (let i = 0; i < EMBED_DIM; i++) {
    h = Math.imul(h, 16777619) ^ i;
    v[i] = ((h >>> 0) % 10000) / 10000;
  }
  // normalize
  let n = 0;
  for (let i = 0; i < EMBED_DIM; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < EMBED_DIM; i++) v[i] = v[i]! / n;
  return v;
}

// Stub embedder — duck-typed; cast at call sites as the real EmbeddingClient class
// has private fields that prevent structural assignment.
const stubEmbedder = {
  embedMany: async (texts: string[]): Promise<Float32Array[]> =>
    texts.map((t) => fakeVector(t)),
  embed: async (text: string): Promise<Float32Array> => fakeVector(text),
};

type CheckResult = { name: string; passed: boolean; detail?: string };
const results: CheckResult[] = [];

function record(name: string, passed: boolean, detail?: string) {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function header(title: string) {
  console.log(`\n§ ${title}`);
}

async function setupCorpus() {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(NOTES_ROOT, { recursive: true });
  await mkdir(SESSIONS_ROOT, { recursive: true });

  // Two notes with different mtimes: one "old" (1 year ago), one "new" (now).
  await writeFile(
    join(NOTES_ROOT, "old-trip.md"),
    "# Brisbane trip\n\n## Bridges\n\nWalked the Story Bridge at sunset.\n",
  );
  await writeFile(
    join(NOTES_ROOT, "new-recipe.md"),
    "# Sourdough\n\n## Method\n\nAutolyse for 1 hour, then bulk ferment 4 hours.\n",
  );
  // Backdate the trip note so we can test sinceMtime cutoffs.
  const yearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const yearAgoSec = yearAgo / 1000;
  await utimes(join(NOTES_ROOT, "old-trip.md"), yearAgoSec, yearAgoSec);

  // One session — JSONL of turn records (matches src/sessions.ts shape).
  const sessionId = "20260415T120000";
  const sessionTurns = [
    { ts: "2026-04-15T12:00:00.000Z", role: "user", content: "what's a good freediving location near brisbane?" },
    { ts: "2026-04-15T12:00:01.000Z", role: "assistant", content: "Try Mooloolaba — protected reef, easy access." },
  ];
  const jsonl = sessionTurns.map((t) => JSON.stringify(t)).join("\n") + "\n";
  await writeFile(join(SESSIONS_ROOT, `${sessionId}.jsonl`), jsonl);
  return { sessionId, oldNoteMtime: yearAgo };
}

async function main() {
  console.log("index_metadata eval");
  console.log("═".repeat(50));

  // ─── 1. schema migration on a legacy DB ────────────────────────────
  header("schema migration: legacy DB gets new columns");
  const legacyPath = join(tmpdir(), `assistant-index-legacy-${process.pid}-${Date.now()}.sqlite`);
  {
    // Hand-build a "v1 schema" DB without the new columns.
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        source_path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        heading_path TEXT,
        display_text TEXT NOT NULL,
        embedding BLOB NOT NULL
      );
    `);
    // Insert a legacy row to confirm migration preserves data.
    legacy.run(
      "INSERT INTO chunks (source_type, source_path, chunk_index, heading_path, display_text, embedding) VALUES (?, ?, ?, ?, ?, ?)",
      ["note", "legacy.md", 0, "(intro)", "old content", new Uint8Array(8 * 4)],
    );
    legacy.close();
  }
  // Reopen via IndexStore — constructor should ALTER TABLE for the missing columns.
  const migrated = new IndexStore(legacyPath);
  const cols = new Database(legacyPath).query<{ name: string }, []>("PRAGMA table_info(chunks)").all().map((r) => r.name);
  record("chunks.source_mtime present after migration", cols.includes("source_mtime"));
  record("chunks.content_date present after migration", cols.includes("content_date"));
  record("chunks.intent present after migration", cols.includes("intent"));
  const legacyRowCount = migrated["db" as keyof IndexStore] != null
    ? new Database(legacyPath).query<{ c: number }, []>("SELECT COUNT(*) as c FROM chunks").get()?.c ?? 0
    : 0;
  record("legacy row preserved through migration", legacyRowCount === 1, `count=${legacyRowCount}`);
  migrated.close();
  await rm(legacyPath, { force: true });
  await rm(`${legacyPath}-wal`, { force: true });
  await rm(`${legacyPath}-shm`, { force: true });

  // ─── 2. seed corpus + run real indexer with stub embedder ──────────
  header("indexing with stub embedder");
  const { sessionId, oldNoteMtime } = await setupCorpus();
  const store = new IndexStore(DB_PATH);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await indexAll({
    store,
    embedder: stubEmbedder as any,
    notesRoot: NOTES_ROOT,
    sessionsRoot: SESSIONS_ROOT,
  });
  record(
    "indexed 2 notes + 1 session",
    result.notesIndexed === 2 && result.sessionsIndexed === 1,
    `notes=${result.notesIndexed} sessions=${result.sessionsIndexed} chunks=${result.chunksAdded}`,
  );

  // ─── 3. source_mtime denormalized onto every chunk ─────────────────
  header("source_mtime denormalization");
  const rawDb = new Database(DB_PATH);
  type ChunkRow = {
    source_type: string;
    source_path: string;
    source_mtime: number | null;
    content_date: string | null;
    intent: string | null;
  };
  const rows = rawDb
    .query<ChunkRow, []>("SELECT source_type, source_path, source_mtime, content_date, intent FROM chunks")
    .all();
  const allHaveMtime = rows.every((r) => typeof r.source_mtime === "number" && r.source_mtime > 0);
  record("every chunk has source_mtime set", allHaveMtime, `${rows.length} chunks total`);

  // ─── 4. content_date — sessions populated, notes null ──────────────
  header("content_date population");
  const noteRows = rows.filter((r) => r.source_type === "note");
  const sessionRows = rows.filter((r) => r.source_type === "session");
  record("note chunks have content_date NULL", noteRows.every((r) => r.content_date === null));
  record(
    "session chunks have content_date = YYYY-MM-DD",
    sessionRows.length > 0 && sessionRows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.content_date ?? "")),
    sessionRows[0]?.content_date ?? "(no session rows)",
  );

  // ─── 5. intent — null on everything (no producer yet) ──────────────
  header("intent column");
  record("all current chunks have intent NULL", rows.every((r) => r.intent === null));

  // ─── 6. search filter: sourceTypes ─────────────────────────────────
  header("search filters");
  // Pick a query vector that overlaps with one of the actual stored vectors
  // so we know we have search hits to filter against.
  const queryVec = fakeVector("Note: old-trip.md\nSection: Brisbane trip > Bridges\n\nWalked the Story Bridge at sunset.");
  const allHits = store.search(queryVec, { k: 10, minSimilarity: 0 });
  record("search returns hits across both source types when unfiltered", allHits.length >= 2,
    `hits=${allHits.length}`);

  const notesOnly = store.search(queryVec, { k: 10, minSimilarity: 0, sourceTypes: ["note"] });
  record(
    "sourceTypes=['note'] returns notes only",
    notesOnly.length > 0 && notesOnly.every((h) => h.sourceType === "note"),
    `n=${notesOnly.length}`,
  );

  const sessionsOnly = store.search(queryVec, { k: 10, minSimilarity: 0, sourceTypes: ["session"] });
  record(
    "sourceTypes=['session'] returns sessions only",
    sessionsOnly.length > 0 && sessionsOnly.every((h) => h.sourceType === "session"),
    `n=${sessionsOnly.length}`,
  );

  // ─── 7. search filter: sinceMtime ──────────────────────────────────
  // Old trip note backdated 1 year; new recipe + session = recent.
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days
  const recentOnly = store.search(queryVec, { k: 10, minSimilarity: 0, sinceMtime: cutoff });
  const hasOldTrip = recentOnly.some((h) => h.sourcePath === "old-trip.md");
  record("sinceMtime cutoff drops the year-old note", !hasOldTrip,
    hasOldTrip ? `unexpectedly returned old-trip.md (mtime=${oldNoteMtime})` : "old-trip.md correctly excluded");
  record("sinceMtime keeps recent content", recentOnly.length > 0, `kept ${recentOnly.length} hit(s)`);

  // ─── 8. search filter: intent ──────────────────────────────────────
  // Inject a chunk with intent='TODO' via the public API to test filtering.
  // Build a synthetic chunk with intent set and replaceSource it as a 3rd "fake source".
  const todoChunk = {
    index: 0,
    headingPath: "(synthetic)",
    embedText: "TODO: book dentist",
    displayText: "TODO: book dentist",
    intent: "TODO",
    contentDate: "2026-04-29",
  };
  store.replaceSource("note", "synthetic-todos.md", Date.now(), [
    { chunk: todoChunk, embedding: fakeVector(todoChunk.embedText) },
  ]);

  const todoQuery = fakeVector("TODO: book dentist");
  const todoHits = store.search(todoQuery, { k: 10, minSimilarity: 0, intent: "TODO" });
  record(
    "intent='TODO' returns only TODO-tagged chunks",
    todoHits.length === 1 && todoHits[0]?.intent === "TODO",
    `n=${todoHits.length}, intent=${todoHits[0]?.intent ?? "(none)"}`,
  );

  const noTodoHits = store.search(queryVec, { k: 10, minSimilarity: 0, intent: "fact" });
  record("intent='fact' returns nothing (no fact-tagged chunks exist)", noTodoHits.length === 0);

  // ─── 9. ScoredChunk surfaces all metadata ──────────────────────────
  header("ScoredChunk shape");
  const sample = store.search(queryVec, { k: 1, minSimilarity: 0 })[0];
  record(
    "ScoredChunk surfaces sourceMtime, contentDate, intent",
    sample != null
      && "sourceMtime" in sample
      && "contentDate" in sample
      && "intent" in sample,
  );

  // ─── cleanup ─────────────────────────────────────────────────────
  store.close();
  rawDb.close();
  await rm(TEST_ROOT, { recursive: true, force: true });

  // ─── summary ─────────────────────────────────────────────────────
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  console.log("\n" + "═".repeat(50));
  console.log(`${passed}/${total} checks passed`);
  if (passed < total) {
    console.log("failures:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ✗ ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("\nunexpected error:", e);
  process.exit(2);
});
