/**
 * Profile — mutable "current truth" facts injected into every system prompt.
 *
 *   - Unit: Profile primitives (normalisation, validation, persistence,
 *     overwrite semantics, render-into-system-prompt format, corrupt-file
 *     tolerance, the remember/forget tool wrappers).
 *   - Write: when told to remember X, the model calls remember(...) with
 *     reasonable args.
 *   - Recall: pre-seeded profile, fresh session — does the model just know?
 *   - Supersession: when a known fact changes, the model overwrites it.
 *   - Override (info-only): chat history says one thing, profile another.
 *     Inherently ambiguous; we surface the result without gating.
 */

import { writeFile } from "node:fs/promises";
import { describe, it, scenario, info, beforeAll, afterAll } from "../lib/suite";
import { expect, assert } from "../lib/expect";
import { Profile } from "../../src/profile";
import { makeRememberTool, makeForgetTool } from "../../src/tools";
import { Workspace, getModel, newAssistant } from "../lib/fixtures";

const BASE_SYSTEM_PROFILE = [
  "You are a helpful personal assistant. Be concise and direct.",
  "If you don't know or don't remember something, say so plainly.",
  "Never invent facts about the user that weren't established in this conversation.",
  "Memory rules:",
  "- When the user states a stable fact about themselves (preference, name, location, relationship), call remember(key, value).",
  "- When the user signals a change to a known fact — including phrasings like 'I don't like X anymore', 'I now prefer Y', 'I take it Z now', 'actually, I W' — call remember(key, value) with the NEW value to overwrite the old one. Don't just acknowledge verbally; call the tool.",
  "- Only call forget(key) if the fact no longer applies AND has no replacement.",
].join("\n");

function buildSystemPrompt(profile: Profile): string {
  const section = profile.renderForSystemPrompt();
  return section ? `${BASE_SYSTEM_PROFILE}\n\n${section}` : BASE_SYSTEM_PROFILE;
}

function freshAssistant(profile: Profile) {
  return newAssistant({
    systemPrompt: buildSystemPrompt(profile),
    profile,
  });
}

let ws: Workspace;

describe("profile", () => {
  beforeAll(async () => { ws = await Workspace.create("profile"); });
  afterAll(async () => { await ws.cleanup(); });

  describe("Profile primitives (unit)", () => {
    it("normalizeKey lowercases + trims + collapses whitespace", () => {
      expect(Profile.normalizeKey("  Dog  Name ")).toBe("dog name");
    });
    it("normalizeKey is idempotent", () => {
      expect(Profile.normalizeKey(Profile.normalizeKey("Eggs"))).toBe("eggs");
    });
    it("validateKey / validateValue boundary checks", () => {
      expect(Profile.validateKey("").ok).toBe(false);
      expect(Profile.validateKey("   ").ok).toBe(false);
      expect(Profile.validateKey("dog name").ok).toBe(true);
      expect(Profile.validateValue("").ok).toBe(false);
      expect(Profile.validateKey("x".repeat(200)).ok).toBe(false);
      expect(Profile.validateValue("y".repeat(2000)).ok).toBe(false);
    });

    it("persistence: saved entries reload correctly", async () => {
      const path = ws.path("profile.json");
      const a = new Profile(path);
      a.set("Dog Name", "Buddy");
      a.set("eggs", "dislike");
      await a.save();
      const b = await Profile.load(path);
      expect(b.size()).toBe(2);
      expect(b.get("dog name")).toBe("Buddy");
      expect(b.get("eggs")).toBe("dislike");
    });

    it("set surfaces overwrite vs insert", async () => {
      const path = ws.path("profile-set.json");
      const p = new Profile(path);
      p.set("eggs", "dislike");
      const r1 = p.set("eggs", "like");
      expect(r1.prev).toBe("dislike");
      expect(r1.value).toBe("like");
      const r2 = p.set("coffee", "black");
      expect(r2.prev).toBe(undefined);
      expect(r2.value).toBe("black");
    });

    it("delete returns true when found, false otherwise", () => {
      const p = new Profile(ws.path("profile-del.json"));
      p.set("eggs", "x");
      expect(p.delete("eggs")).toBe(true);
      expect(p.delete("nonexistent")).toBe(false);
    });

    it("renderForSystemPrompt: empty → empty; populated → authoritative bullets", () => {
      const empty = new Profile(ws.path("profile-empty.json"));
      expect(empty.renderForSystemPrompt()).toBe("");
      const p = new Profile(ws.path("profile-rend.json"));
      p.set("coffee", "black");
      const rendered = p.renderForSystemPrompt();
      expect(rendered).toContain("authoritative");
      expect(rendered).toContain("trust these");
      expect(rendered).toContain("- coffee: black");
    });

    it("load tolerates corrupt JSON (returns empty profile)", async () => {
      const bad = ws.path("profile-bad.json");
      await writeFile(bad, "{this is not json", "utf-8");
      const c = await Profile.load(bad);
      expect(c.size()).toBe(0);
    });

    it("remember/forget tool wrappers behave correctly", async () => {
      const profile = await Profile.load(ws.path("profile-tool.json"));
      const remember = makeRememberTool(profile);
      const forget = makeForgetTool(profile);

      expect((await remember.execute({ key: "Dog Name", value: "Buddy" })).startsWith("Saved 'dog name: Buddy'")).toBe(true);
      const overwrite = await remember.execute({ key: "dog name", value: "Rex" });
      expect(overwrite).toContain("overwrote 'Buddy'");
      const reload = await Profile.load(profile.path);
      expect(reload.get("dog name")).toBe("Rex");

      expect((await remember.execute({ key: "", value: "x" })).startsWith("Error:")).toBe(true);
      expect((await remember.execute({ key: "k", value: "" })).startsWith("Error:")).toBe(true);

      expect((await forget.execute({ key: "DOG NAME" })).startsWith("Forgot 'dog name'")).toBe(true);
      expect((await forget.execute({ key: "nope" })).includes("nothing to forget")).toBe(true);
    });
  });

  // ─── stochastic categories ──────────────────────────────────

  scenario("write: model calls remember(...) when told to save a fact", {
    threshold: [4, 5],
    prompts: [
      "Remember my dog's name is Buddy.",
      "Please remember I prefer coffee black, no sugar.",
      "Save this fact: my favorite color is teal.",
      "Remember that my home is in Cairns.",
      "Remember: I dislike eggs.",
    ],
    judge: async ({ prompt, index }) => {
      const expectations: Array<{ keyContains: string; valueContains: string[] }> = [
        { keyContains: "dog",    valueContains: ["buddy"] },
        { keyContains: "coffee", valueContains: ["black"] },
        { keyContains: "color",  valueContains: ["teal"] },
        { keyContains: "home",   valueContains: ["cairns"] },
        { keyContains: "egg",    valueContains: ["dislike", "don't like", "do not like", "no"] },
      ];
      const exp = expectations[index]!;
      await getModel();
      const profile = new Profile(ws.path(`write-${index}-${Date.now()}.json`));
      const { assistant } = freshAssistant(profile);
      await assistant.chat(prompt, { temperature: 0.2, maxTokens: 80 });
      assert(profile.size() > 0, "no fact was saved");
      const match = profile.entries().find(([k]) => k.toLowerCase().includes(exp.keyContains));
      assert(match != null, `no key matched '${exp.keyContains}': ${JSON.stringify(profile.entries())}`);
      const v = match![1].toLowerCase();
      const hit = exp.valueContains.some((e) => v.includes(e));
      assert(hit, `value '${match![1]}' did not contain any of [${exp.valueContains.join("|")}]`);
      return { detail: `${match![0]}=${match![1]}` };
    },
  });

  scenario("recall: pre-seeded profile, fresh session — model just knows", {
    threshold: [4, 5],
    prompts: [
      "What's my dog's name?",
      "Do I like eggs?",
      "Where do I live?",
      "How do I take my coffee?",
      "What's my favorite color?",
    ],
    judge: async ({ prompt, index }) => {
      const seeds: Array<[Record<string, string>, RegExp]> = [
        [{ "dog name": "Buddy" }, /buddy/i],
        [{ eggs: "dislike" }, /(don't|do not|dis)/i],
        [{ home: "Cairns" }, /cairns/i],
        [{ coffee: "black, no sugar" }, /black/i],
        [{ "favorite color": "teal" }, /teal/i],
      ];
      const [seed, expected] = seeds[index]!;
      await getModel();
      const path = ws.path(`recall-${index}-${Date.now()}.json`);
      const p = new Profile(path);
      for (const [k, v] of Object.entries(seed)) p.set(k, v);
      await p.save();
      const reload = await Profile.load(path);
      const { assistant } = freshAssistant(reload);
      const r = await assistant.chat(prompt, { temperature: 0.2, maxTokens: 60 });
      assert(expected.test(r.reply), `reply did not match ${expected}: "${r.reply.slice(0, 80)}"`);
      return { detail: `reply: "${r.reply.replace(/\n/g, " ").slice(0, 60)}"` };
    },
  });

  scenario("supersession: known fact changes — model overwrites it", {
    threshold: [2, 3],
    prompts: [
      "Actually, I don't like eggs anymore.",
      "My dog's name has changed — it's Buddy now, not Rex.",
      "I take my coffee black now — no cream, no sugar.",
    ],
    judge: async ({ prompt, index }) => {
      const seeds: Array<{ initial: Record<string, string>; keyContains: string; oldValue: string }> = [
        { initial: { eggs: "like" },                       keyContains: "egg",    oldValue: "like" },
        { initial: { "dog name": "Rex" },                  keyContains: "dog",    oldValue: "rex" },
        { initial: { coffee: "with cream and sugar" },     keyContains: "coffee", oldValue: "cream" },
      ];
      const c = seeds[index]!;
      await getModel();
      const path = ws.path(`super-${index}-${Date.now()}.json`);
      const p = new Profile(path);
      for (const [k, v] of Object.entries(c.initial)) p.set(k, v);
      await p.save();
      const reload = await Profile.load(path);
      const { assistant } = freshAssistant(reload);
      await assistant.chat(prompt, { temperature: 0.2, maxTokens: 80 });
      const after = await Profile.load(path);
      const match = after.entries().find(([k]) => k.toLowerCase().includes(c.keyContains));
      assert(match != null, `no key matched '${c.keyContains}'; entries=${JSON.stringify(after.entries())}`);
      assert(!match![1].toLowerCase().includes(c.oldValue),
        `value still contains '${c.oldValue}': '${match![1]}'`);
      return { detail: `updated to '${match![1]}'` };
    },
  });

  // Override is intentionally ambiguous — see design.md §5 / §8 entry on
  // "Profile-vs-recent-chat contradiction resolution". Surface the result;
  // never gate.
  info("override (chat history contradicts profile)", async () => {
    const model = await getModel();
    type Case = {
      profileFact: [string, string];
      setupUser: string;
      setupAssistant: string;
      query: string;
      expectInReply: RegExp;
      rejectInReply?: RegExp;
    };
    const cases: Case[] = [
      {
        profileFact: ["eggs", "dislike"],
        setupUser: "I love eggs, they're my favorite food.",
        setupAssistant: "Got it.",
        query: "Quick check — do I currently like eggs or not?",
        expectInReply: /(don't|do not|dis)/i,
        rejectInReply: /(love|favorite)/i,
      },
      {
        profileFact: ["dog name", "Buddy"],
        setupUser: "By the way, I named my dog Rex last week.",
        setupAssistant: "Noted.",
        query: "What's the name of my dog?",
        expectInReply: /buddy/i,
        rejectInReply: /rex/i,
      },
    ];
    let passed = 0;
    const lines: string[] = [];
    for (const c of cases) {
      const path = ws.path(`override-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
      const p = new Profile(path);
      p.set(c.profileFact[0], c.profileFact[1]);
      await p.save();
      const reload = await Profile.load(path);
      const { assistant, context } = freshAssistant(reload);
      context.addUser(c.setupUser);
      context.addAssistant(c.setupAssistant);
      const r = await assistant.chat(c.query, { temperature: 0.2, maxTokens: 80 });
      const wants = c.expectInReply.test(r.reply);
      const rejects = c.rejectInReply ? c.rejectInReply.test(r.reply) : false;
      if (wants && !rejects) passed++;
      lines.push(`profile={${c.profileFact[0]}: ${c.profileFact[1]}} → ${wants && !rejects ? "✓" : "—"} ${r.reply.replace(/\n/g, " ").slice(0, 50)}`);
      void model;
    }
    return { detail: `${passed}/${cases.length} preferred profile · ${lines.join(" | ")}` };
  });
});
