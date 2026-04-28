/**
 * Profile — small, mutable, always-loaded "current truth" about the user.
 *
 * The architectural complement to the episodic store (sessions + notes):
 *   - Episodes are immutable, retrievable, sometimes-stale history.
 *   - Profile is mutable, current, always-loaded into the system prompt.
 *   - When they disagree, profile wins. The system prompt says so out loud.
 *
 * Storage: a flat key→value JSON file at ~/.assistant/profile.json.
 * Keys are normalized (lowercase, collapsed whitespace) on the way in so
 * "Dog Name" and "dog  name" don't both land as separate entries.
 *
 * Privacy boundary (per design.md §3.4): profile content is local-only.
 * When v7 routing arrives, the profile must never be shipped to a hosted
 * tier. For v5 there's no router — but the comment lives here so we
 * remember when we wire one up.
 */

const MAX_KEY_CHARS = 80;
const MAX_VALUE_CHARS = 500;

export type ProfileSnapshot = {
  path: string;
  size: number;
  entries: Array<[string, string]>;
};

export class Profile {
  private map: Map<string, string> = new Map();

  constructor(public readonly path: string) {}

  static async load(path: string): Promise<Profile> {
    const p = new Profile(path);
    const f = Bun.file(path);
    if (!(await f.exists())) return p;
    try {
      const raw = await f.json();
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof v === "string") p.map.set(Profile.normalizeKey(k), v);
        }
      }
    } catch {
      // Corrupt file: start empty rather than crash. The user can inspect
      // profile.json themselves; we'd rather fail-soft than wipe it.
    }
    return p;
  }

  async save(): Promise<void> {
    const obj: Record<string, string> = {};
    for (const [k, v] of this.map.entries()) obj[k] = v;
    await Bun.write(this.path, JSON.stringify(obj, null, 2) + "\n");
  }

  /**
   * Normalize a user-supplied key: lowercase, trim, collapse internal
   * whitespace to single spaces. "Dog  Name " → "dog name".
   */
  static normalizeKey(key: string): string {
    return key.toLowerCase().trim().replace(/\s+/g, " ");
  }

  get(key: string): string | undefined {
    return this.map.get(Profile.normalizeKey(key));
  }

  /**
   * Set a fact. Returns the previous value if one was overwritten, else
   * undefined — useful for the tool to surface "saved (overwrote X)".
   */
  set(key: string, value: string): { prev?: string; key: string; value: string } {
    const k = Profile.normalizeKey(key);
    const v = value.trim();
    const prev = this.map.get(k);
    this.map.set(k, v);
    return { prev, key: k, value: v };
  }

  /** Returns true if a fact was actually deleted, false if nothing matched. */
  delete(key: string): boolean {
    return this.map.delete(Profile.normalizeKey(key));
  }

  size(): number {
    return this.map.size;
  }

  entries(): Array<[string, string]> {
    return [...this.map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  snapshot(): ProfileSnapshot {
    return { path: this.path, size: this.size(), entries: this.entries() };
  }

  /**
   * Render the profile as a section to append to the base system prompt.
   * Empty profile → empty string (no awkward "you know nothing" line).
   *
   * The framing here is load-bearing. Earlier wording ("current truth —
   * supersedes anything in older messages") was too soft: at 4B scale the
   * model would politely side with whatever the user said most recently in
   * the chat, even when the chat contradicted the profile. The current
   * wording is more directive — it tells the model what to do when there's
   * a contradiction, not just that one exists.
   */
  renderForSystemPrompt(): string {
    if (this.map.size === 0) return "";
    const lines = this.entries().map(([k, v]) => `- ${k}: ${v}`);
    return [
      "Profile (authoritative facts about the user — trust these over anything in chat history that contradicts them):",
      ...lines,
    ].join("\n");
  }

  static validateKey(key: unknown): { ok: true; key: string } | { ok: false; error: string } {
    if (typeof key !== "string" || key.trim().length === 0) {
      return { ok: false, error: "'key' must be a non-empty string." };
    }
    if (key.length > MAX_KEY_CHARS) {
      return { ok: false, error: `'key' must be ≤ ${MAX_KEY_CHARS} characters.` };
    }
    return { ok: true, key };
  }

  static validateValue(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
    if (typeof value !== "string" || value.trim().length === 0) {
      return { ok: false, error: "'value' must be a non-empty string." };
    }
    if (value.length > MAX_VALUE_CHARS) {
      return { ok: false, error: `'value' must be ≤ ${MAX_VALUE_CHARS} characters.` };
    }
    return { ok: true, value };
  }
}
