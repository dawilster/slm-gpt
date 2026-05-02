/**
 * shortcut-meta — typed contract layer over the user's Apple Shortcuts library.
 *
 * Why this exists: the agent-facing contract for Shortcuts is just a string
 * name with no schema, no intent tag. v6.5 eval surfaced that without
 * metadata the model has to disambiguate purely from name + user phrasing,
 * which fails at 4B (see design.md §5.1). Hardcoding examples in the system
 * prompt to compensate is library-specific and brittle.
 *
 * The metadata layer fills the gap: each shortcut name is tagged with an
 * `intent` (a fixed enum) and an optional `is_default` flag. The agent picks
 * shortcuts by intent matching, not by name guessing. Defaults are picked
 * programmatically (first-seen of an intent), sidestepping the three-step
 * ask-save-act flow that broke the 4B model.
 *
 * Lifecycle:
 *   - At server boot (and on every shortcut cache refresh), diff the live
 *     library against the stored meta. New names → classify via local LLM,
 *     store. Removed names → garbage-collect.
 *   - Almost never runs: a typical user library changes weekly at most.
 *
 * Storage: ~/.assistant/shortcut-meta.json — flat object keyed by exact
 * shortcut name (matches macOS shortcuts list output).
 */

import type { ModelClient } from "./client";

/** The fixed intent enum. Add to this list when new categories of shortcut
 *  appear; the LLM classifier picks `other` for anything outside it.
 *
 *  Intentionally narrow: ten or so high-frequency intents cover almost any
 *  real shortcut library. Wider enums make classification noisier without
 *  better routing. */
export const INTENTS = [
  "create_note",
  "edit_note",
  "start_timer",
  "set_reminder",
  "send_message",
  "add_calendar",
  "start_recording",
  "control_lights",
  "run_backup",
  "search_web",
  "speak_text",
  "launch_app",
  "other",
] as const;

export type Intent = (typeof INTENTS)[number];

export type ShortcutMetaEntry = {
  intent: Intent;
  /** Among shortcuts that share this intent, is this the user's default? */
  isDefault: boolean;
  /** "auto" if classified by the LLM; "user" if hand-edited via UI. */
  classifiedBy: "auto" | "user";
  /** ISO timestamp; lets us re-classify entries that predate enum changes. */
  classifiedAt: string;
};

export type ShortcutMetaMap = Record<string, ShortcutMetaEntry>;

const SYSTEM_PROMPT_FOR_CLASSIFIER = [
  "You are a classifier. Given the name of a macOS Shortcut, output exactly one intent label from this list:",
  INTENTS.map((i) => `- ${i}`).join("\n"),
  "Output ONLY the label string, nothing else. No explanation, no punctuation.",
  "Examples:",
  "  Name: 'Start Pomodoro Timer'  →  start_timer",
  "  Name: 'Add to Bear Note'      →  create_note",
  "  Name: 'Turn Lights On'        →  control_lights",
  "  Name: 'Compress for AirDrop'  →  other",
].join("\n");

export class ShortcutMetaStore {
  private map: ShortcutMetaMap = {};

  constructor(public readonly path: string) {}

  /** Load from disk; missing or corrupt file starts empty (fail-soft). */
  static async load(path: string): Promise<ShortcutMetaStore> {
    const s = new ShortcutMetaStore(path);
    const f = Bun.file(path);
    if (!(await f.exists())) return s;
    try {
      const raw = await f.json();
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
          const e = entry as Partial<ShortcutMetaEntry>;
          if (
            typeof name === "string" && name.length > 0 &&
            e && typeof e.intent === "string" && (INTENTS as readonly string[]).includes(e.intent)
          ) {
            s.map[name] = {
              intent: e.intent as Intent,
              isDefault: Boolean(e.isDefault),
              classifiedBy: e.classifiedBy === "user" ? "user" : "auto",
              classifiedAt: typeof e.classifiedAt === "string" ? e.classifiedAt : new Date().toISOString(),
            };
          }
        }
      }
    } catch {
      // Corrupt: start empty.
    }
    return s;
  }

  async save(): Promise<void> {
    await Bun.write(this.path, JSON.stringify(this.map, null, 2) + "\n");
  }

  get(name: string): ShortcutMetaEntry | undefined {
    return this.map[name];
  }

  entries(): Array<[string, ShortcutMetaEntry]> {
    return Object.entries(this.map);
  }

  size(): number {
    return Object.keys(this.map).length;
  }

  /** Remove a name (e.g. user deleted it from Shortcuts.app). */
  delete(name: string): boolean {
    if (!(name in this.map)) return false;
    delete this.map[name];
    return true;
  }

  /** Replace or upsert an entry. Used by the classifier and by UI edits. */
  set(name: string, entry: ShortcutMetaEntry): void {
    this.map[name] = entry;
  }

  /** Mark a specific name as the default for its intent (clearing the flag
   *  on any other entry with the same intent). UI uses this; runtime uses
   *  it programmatically when seeding defaults during a diff fill. */
  promoteDefault(name: string): void {
    const e = this.map[name];
    if (!e) return;
    for (const [n, other] of Object.entries(this.map)) {
      if (other.intent === e.intent && n !== name && other.isDefault) {
        other.isDefault = false;
      }
    }
    e.isDefault = true;
  }

  /**
   * Diff the live library against the meta store and bring it up to date:
   *   - For each name not in the meta: classify via the model and add it.
   *     The first-seen entry of an intent becomes the default.
   *   - For each name in the meta but not in the library: garbage-collect.
   * Returns counts so callers can log. Persists once at the end.
   */
  async syncWithLibrary(
    libraryNames: string[],
    classify: (name: string) => Promise<Intent>,
  ): Promise<{ added: number; removed: number }> {
    const libSet = new Set(libraryNames);
    let added = 0;
    let removed = 0;

    // Garbage-collect missing entries.
    for (const name of Object.keys(this.map)) {
      if (!libSet.has(name)) {
        delete this.map[name];
        removed++;
      }
    }

    // Track which intents already have a default so first-seen logic works.
    const intentsWithDefault = new Set<Intent>();
    for (const e of Object.values(this.map)) {
      if (e.isDefault) intentsWithDefault.add(e.intent);
    }

    // Classify new names.
    for (const name of libraryNames) {
      if (this.map[name]) continue;
      let intent: Intent = "other";
      try {
        intent = await classify(name);
      } catch {
        // Classifier failed (model unreachable etc.) — drop in as "other".
        // Better to surface in UI than block boot.
      }
      const isDefault = !intentsWithDefault.has(intent) && intent !== "other";
      if (isDefault) intentsWithDefault.add(intent);
      this.map[name] = {
        intent,
        isDefault,
        classifiedBy: "auto",
        classifiedAt: new Date().toISOString(),
      };
      added++;
    }

    if (added > 0 || removed > 0) await this.save();
    return { added, removed };
  }
}

/**
 * Returns a `classify(name)` function bound to a model client. Fits the
 * shape `ShortcutMetaStore.syncWithLibrary` expects.
 *
 * One short completion per name. ~20 prompt tokens out, ~5 response tokens.
 * Runs at most a handful of times in a user's lifetime (when their library
 * grows or gets renamed) — this is intentionally a non-hot path.
 */
export function makeClassifier(client: ModelClient): (name: string) => Promise<Intent> {
  return async (name: string): Promise<Intent> => {
    const r = await client.complete(
      [
        { role: "system", content: SYSTEM_PROMPT_FOR_CLASSIFIER },
        { role: "user",   content: `Name: '${name}'` },
      ],
      { temperature: 0 },
    );
    const raw = r.reply.trim().toLowerCase().replace(/[^a-z_]/g, "");
    return (INTENTS as readonly string[]).includes(raw) ? (raw as Intent) : "other";
  };
}
