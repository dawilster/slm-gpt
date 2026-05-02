/**
 * Events log — append-only sqlite store for system telemetry.
 *
 * The discipline (per design.md / project conversation 2026-05-02): capture
 * richly, surface nothing yet. We don't know what visualizations or
 * analyses will be honest until we have several months of real usage data;
 * shipping dashboards now is solving for an imagined product.
 *
 * What lands here that wasn't already persisted:
 *   - per-request runtime telemetry (prefill ms, gen ms, tokens)
 *   - per-tool-call timing + result preview
 *   - errors and refusals
 *   - shortcut-meta classifier outcomes
 *   - profile updates summarised
 *
 * What is NOT duplicated here: chat content (already in
 * ~/.assistant/sessions/*.jsonl), notes (already markdown files), profile
 * (already json). Events references those by session_id rather than
 * mirroring the bytes.
 *
 * Persistence failures must never block the chat path — `record` swallows
 * errors and logs a warning. The events log is observability, not
 * load-bearing state.
 */

import { Database } from "bun:sqlite";

export type EventType =
  /** A user/assistant exchange completed. Payload summarises tokens, prefill,
   *  generation, tools fired, reply length, trim status. */
  | "chat_turn"
  /** Each tool invocation inside a chat turn (one tool, one record). */
  | "tool_call"
  /** Subset of tool_call: when run_shortcut fires. Indexed separately so the
   *  shortcut usage shape is queryable without unpacking payloads. */
  | "shortcut_run"
  /** The unknown-tool fallback fired (model called a shortcut name as a
   *  tool name; runtime rerouted). Worth tracking — high signal of model
   *  confusion + how often the rescue path actually saves the turn. */
  | "fallback_route"
  /** Shortcut-meta classifier ran on a new shortcut name. */
  | "classifier"
  /** A change to shortcut metadata (auto-classify or user override). */
  | "meta_change"
  /** Profile write/delete. */
  | "profile_change"
  /** Any error path (model crash, classifier fail, shortcut error,
   *  unhandled fetch error). */
  | "error"
  /** Every HTTP request to the server (access log). */
  | "request"
  /** Server boot — captures version, model, library size, etc. for
   *  long-term "what was the system at the time" forensics. */
  | "boot";

export type EventRecord = {
  id: number;
  ts: string;
  type: EventType;
  sessionId: string | null;
  requestId: number | null;
  payload: Record<string, unknown>;
};

export type RecordOptions = {
  sessionId?: string;
  requestId?: number;
};

export class EventLog {
  private db: Database;
  private insertStmt: ReturnType<Database["prepare"]>;

  constructor(public readonly path: string) {
    this.db = new Database(path);
    // WAL keeps writes from blocking concurrent reads (e.g. an ad-hoc
    // sqlite3 query against the same file while the server is running).
    this.db.exec(`PRAGMA journal_mode = WAL;`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          TEXT    NOT NULL,
        type        TEXT    NOT NULL,
        session_id  TEXT,
        request_id  INTEGER,
        payload     TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts        ON events(ts);
      CREATE INDEX IF NOT EXISTS idx_events_type_ts   ON events(type, ts);
      CREATE INDEX IF NOT EXISTS idx_events_session   ON events(session_id) WHERE session_id IS NOT NULL;
    `);
    this.insertStmt = this.db.prepare(
      `INSERT INTO events (ts, type, session_id, request_id, payload) VALUES (?, ?, ?, ?, ?)`,
    );
  }

  /**
   * Append an event. Errors are swallowed (with a console warning) so
   * persistence failures never break the chat loop.
   */
  record(type: EventType, payload: Record<string, unknown>, opts: RecordOptions = {}): void {
    try {
      this.insertStmt.run(
        new Date().toISOString(),
        type,
        opts.sessionId ?? null,
        opts.requestId ?? null,
        JSON.stringify(payload),
      );
    } catch (e: any) {
      console.warn(`[events] failed to record ${type}: ${e?.message ?? e}`);
    }
  }

  recent(n = 50, type?: EventType): EventRecord[] {
    const rows = type
      ? this.db.prepare(`SELECT * FROM events WHERE type = ? ORDER BY id DESC LIMIT ?`).all(type, n)
      : this.db.prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ?`).all(n);
    return (rows as any[]).map(rowToRecord);
  }

  count(type?: EventType): number {
    const r = type
      ? this.db.prepare(`SELECT COUNT(*) AS c FROM events WHERE type = ?`).get(type)
      : this.db.prepare(`SELECT COUNT(*) AS c FROM events`).get();
    return (r as any).c;
  }

  /** Total events grouped by type — quick health check for boot logs. */
  countsByType(): Record<string, number> {
    const rows = this.db.prepare(`SELECT type, COUNT(*) AS c FROM events GROUP BY type`).all() as any[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.type] = r.c;
    return out;
  }

  close(): void {
    this.db.close();
  }
}

function rowToRecord(row: any): EventRecord {
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(row.payload); } catch { /* corrupted row — skip */ }
  return {
    id: row.id,
    ts: row.ts,
    type: row.type,
    sessionId: row.session_id,
    requestId: row.request_id,
    payload,
  };
}
