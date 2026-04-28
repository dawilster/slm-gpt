/**
 * SessionStore — append-only persistence for conversations.
 *
 * Each session is one JSONL file at ~/.assistant/sessions/<id>.jsonl.
 * Each line is a turn record (system, user, or assistant) with an
 * ISO timestamp and per-turn metadata for assistant turns.
 *
 * Append-only because: it's simple, it's grep-able, it's recoverable
 * if anything goes wrong, and it scales to thousands of turns without
 * rewriting the file each turn.
 */

import { appendFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type TurnRole = "system" | "user" | "assistant";

export type TurnRecord = {
  role: TurnRole;
  content: string;
  ts: string; // ISO 8601
  // assistant-only metadata:
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number;
};

export type SessionMeta = {
  id: string;
  path: string;
  startedAt: string;
  turnCount: number;
  firstUserMessage?: string;
};

function newSessionId(): string {
  // Millisecond-precision so sessions created within the same second
  // still sort correctly by creation order.
  const stamp = new Date().toISOString().slice(0, 23).replace(/[:.]/g, "");
  // e.g. 2026-04-28T044357123
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}

export class SessionStore {
  readonly root: string;

  constructor(root?: string) {
    this.root = root ?? join(homedir(), ".assistant", "sessions");
  }

  async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  /** Create a new session handle. Caller should persist the system prompt as the first turn. */
  newSession(): Session {
    const id = newSessionId();
    return new Session(id, join(this.root, `${id}.jsonl`));
  }

  /** Open an existing session by id (no validation here — caller checks via list/loadTurns). */
  open(id: string): Session {
    return new Session(id, join(this.root, `${id}.jsonl`));
  }

  /** Most-recent-first list of session metadata. */
  async list(limit = 20): Promise<SessionMeta[]> {
    if (!existsSync(this.root)) return [];
    const files = await readdir(this.root);
    const ids = files
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(/\.jsonl$/, ""))
      .sort()
      .reverse()
      .slice(0, limit);

    const out: SessionMeta[] = [];
    for (const id of ids) {
      const meta = await this.metadataFor(id);
      if (meta) out.push(meta);
    }
    return out;
  }

  async metadataFor(id: string): Promise<SessionMeta | null> {
    const path = join(this.root, `${id}.jsonl`);
    if (!existsSync(path)) return null;
    const text = await Bun.file(path).text();
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    let startedAt = "";
    let turnCount = 0;
    let firstUserMessage: string | undefined;
    for (const line of lines) {
      try {
        const r = JSON.parse(line) as TurnRecord;
        if (!startedAt) startedAt = r.ts;
        if (r.role !== "system") turnCount++;
        if (!firstUserMessage && r.role === "user") {
          firstUserMessage = r.content.slice(0, 80);
        }
      } catch {
        /* tolerate malformed lines */
      }
    }
    return { id, path, startedAt, turnCount, firstUserMessage };
  }

  async loadTurns(id: string): Promise<TurnRecord[]> {
    const path = join(this.root, `${id}.jsonl`);
    const text = await Bun.file(path).text();
    return text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as TurnRecord);
  }

  /** Resolve a partial id to a full id (most recent match). */
  async findByPrefix(prefix: string): Promise<string | null> {
    const sessions = await this.list(100);
    const match = sessions.find((s) => s.id.startsWith(prefix));
    return match?.id ?? null;
  }
}

export class Session {
  constructor(
    readonly id: string,
    readonly path: string,
  ) {}

  async append(record: Omit<TurnRecord, "ts"> & { ts?: string }): Promise<void> {
    const r: TurnRecord = { ...record, ts: record.ts ?? new Date().toISOString() } as TurnRecord;
    await appendFile(this.path, JSON.stringify(r) + "\n", "utf-8");
  }
}
