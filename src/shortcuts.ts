/**
 * Shortcuts — bridge to the macOS `shortcuts` CLI.
 *
 * Two responsibilities:
 *   1. List the user's shortcuts (cached).
 *   2. Run a shortcut by name, optionally with text input, capturing
 *      stdout + stderr with a timeout.
 *
 * Both are surfaced to the model via the `list_shortcuts` /
 * `run_shortcut` tools (see src/tools.ts), and the list is also exposed
 * directly to the Mac app via GET /v1/shortcuts.
 *
 * Trust posture (v6.5): we trust the user's library wholesale. Every
 * invocation is already visible in the chat UI via the existing
 * tool-event SSE stream. See design.md §3.7 for the rationale.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHORTCUTS_BIN = "/usr/bin/shortcuts";
const LIST_CACHE_TTL_MS = 30_000;
const DEFAULT_RUN_TIMEOUT_MS = 30_000;

export type ShortcutEntry = {
  name: string;
};

export type RunErrorKind = "missing" | "permission" | "timeout" | "exit" | "spawn";

export type RunShortcutResult =
  | { ok: true; output: string }
  | { ok: false; error: string; kind: RunErrorKind };

export type ListShortcutsResult =
  | { ok: true; shortcuts: ShortcutEntry[]; cachedAt: number; fromCache: boolean }
  | { ok: false; error: string };

export class ShortcutsClient {
  private cache: { at: number; shortcuts: ShortcutEntry[] } | null = null;

  /**
   * List the user's installed shortcuts. Cached for LIST_CACHE_TTL_MS so
   * the Mac app can repaint without re-spawning the CLI per render.
   */
  async list(opts: { force?: boolean } = {}): Promise<ListShortcutsResult> {
    const now = Date.now();
    if (!opts.force && this.cache && now - this.cache.at < LIST_CACHE_TTL_MS) {
      return { ok: true, shortcuts: this.cache.shortcuts, cachedAt: this.cache.at, fromCache: true };
    }

    const proc = Bun.spawn([SHORTCUTS_BIN, "list"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      return { ok: false, error: stderr.trim() || `shortcuts list exited ${code}` };
    }

    const names = stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const shortcuts = names.map((name) => ({ name }));

    this.cache = { at: now, shortcuts };
    return { ok: true, shortcuts, cachedAt: now, fromCache: false };
  }

  /**
   * Run a shortcut by name. If `input` is provided, it's written to a
   * temp file and passed via `-i`. stdout is returned as `output`.
   *
   * Errors are classified for caller-side messaging:
   *   - missing:    the named shortcut isn't installed
   *   - permission: macOS prompted for approval (first-run dialog)
   *   - timeout:    we aborted after timeoutMs
   *   - exit:       shortcut ran but exited non-zero
   *   - spawn:      we couldn't even start the process
   */
  async run(
    name: string,
    input?: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<RunShortcutResult> {
    if (!name || name.trim().length === 0) {
      return { ok: false, error: "shortcut name must be non-empty", kind: "spawn" };
    }
    const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;

    let workdir: string | null = null;
    let inputPath: string | null = null;
    if (input !== undefined && input.length > 0) {
      workdir = await mkdtemp(join(tmpdir(), "halo-shortcut-"));
      inputPath = join(workdir, "input.txt");
      await Bun.write(inputPath, input);
    }

    const args = [SHORTCUTS_BIN, "run", name];
    if (inputPath) args.push("-i", inputPath);

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    } catch (e: any) {
      if (workdir) await rm(workdir, { recursive: true, force: true });
      return { ok: false, error: `could not spawn shortcuts CLI: ${e?.message ?? e}`, kind: "spawn" };
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch { /* already exited */ }
    }, timeoutMs);

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (workdir) await rm(workdir, { recursive: true, force: true });

    if (timedOut) {
      return {
        ok: false,
        error: `shortcut '${name}' did not finish within ${timeoutMs}ms`,
        kind: "timeout",
      };
    }

    if (code !== 0) {
      const msg = stderr.trim() || stdout.trim() || `exited ${code}`;
      const kind: RunErrorKind = classifyError(msg);
      // Invalidate the list cache on a missing-name error — the user may
      // have just renamed/added a shortcut and we want fresh fuzzy matches
      // on the next attempt.
      if (kind === "missing") this.cache = null;
      return { ok: false, error: msg, kind };
    }

    return { ok: true, output: stdout };
  }

  /**
   * Top-N fuzzy matches for an unknown name. Used to populate the error
   * message when the model passes a name that doesn't resolve, so it can
   * self-correct on the next loop iteration (mirrors the v3.5 unknown-tool
   * primitive in src/assistant.ts).
   */
  async fuzzyMatches(query: string, n = 5): Promise<string[]> {
    const list = await this.list();
    if (!list.ok) return [];
    const q = query.toLowerCase();
    // 0.25 is a deliberate compromise: low enough that "Set Tymer" still
    // surfaces "Start pomodoro timer" (overlap ~0.3 once length differs);
    // high enough to drop the worst long-tail noise. Suggestions are a
    // hint, not the only signal — the full available-list is also in the
    // error string, so a borderline-relevant suggestion costs nothing.
    const MIN_SIM = 0.25;
    return list.shortcuts
      .map((s) => ({ name: s.name, score: similarity(q, s.name.toLowerCase()) }))
      .filter((s) => s.score >= MIN_SIM)
      .sort((a, b) => b.score - a.score)
      .slice(0, n)
      .map((s) => s.name);
  }

  /** Force a reload on the next list() call. */
  invalidateCache(): void {
    this.cache = null;
  }
}

function classifyError(msg: string): RunErrorKind {
  // Normalise smart-quote variants the macOS error string uses ("Couldn't"
  // with U+2019) so plain ASCII matchers don't miss them.
  const lower = msg.toLowerCase().replace(/[‘’]/g, "'");
  if (lower.includes("couldn't find") || lower.includes("no shortcut") || lower.includes("not found")) {
    return "missing";
  }
  if (lower.includes("not authorized") || lower.includes("permission") || lower.includes("approve")) {
    return "permission";
  }
  return "exit";
}

/**
 * Fuzzy similarity tuned for shortcut-name matching:
 * - exact / substring → 1.0 / 0.9
 * - shared whole words ("note", "timer") dominate, because users describe
 *   shortcuts by content word ("create note") not by morphology
 * - bigram overlap is a tiebreaker for typos ("Set Tymer" → "Set Timer")
 *
 * Word-overlap-first matters: with bigrams alone, "create note" prefers
 * "Create Recording" (5 chars overlap on 'create') over "New Note with
 * Date" or "Add to Bear Note", which is the wrong suggestion for a note
 * action.
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.9;

  const aw = words(a);
  const bw = words(b);
  let sharedWords = 0;
  for (const w of aw) if (bw.has(w)) sharedWords++;
  const wordScore = aw.size === 0 ? 0 : sharedWords / aw.size;

  const ag = bigrams(a);
  const bg = bigrams(b);
  let intersect = 0;
  for (const g of ag) if (bg.has(g)) intersect++;
  const bigramScore = (ag.size + bg.size) === 0 ? 0 : (2 * intersect) / (ag.size + bg.size);

  // Heavy weight on word overlap; bigrams as tiebreaker.
  return 0.75 * wordScore + 0.25 * bigramScore;
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Tokens of length >= 3, lowercased — drops "a", "to", "of" noise. */
function words(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
}
