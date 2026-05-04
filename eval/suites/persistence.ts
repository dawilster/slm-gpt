/**
 * Persistence — sessions roundtrip safely across a simulated restart.
 *
 *   - Unit: SessionStore creates dir, generates IDs, lists sessions newest
 *     first, finds by prefix, loads turn records, Context.restore replays
 *     them.
 *   - Integration: chat → drop in-memory refs → load from disk → resumed
 *     assistant correctly recalls a fact stated before the "kill", and
 *     subsequent chat appends to the same session file.
 */

import { existsSync } from "node:fs";
import { describe, it, beforeAll, afterAll } from "../lib/suite";
import { expect, assert } from "../lib/expect";
import { Context } from "../../src/context";
import { Assistant } from "../../src/assistant";
import { SessionStore } from "../../src/sessions";
import { OpenAICompatClient } from "../../src/client";
import { Workspace, BASE_URL, API_KEY, getModel } from "../lib/fixtures";

let ws: Workspace;
let store: SessionStore;

describe("persistence", () => {
  beforeAll(async () => {
    ws = await Workspace.create("persistence");
    store = new SessionStore(ws.root);
    await store.ensure();
  });
  afterAll(async () => { await ws.cleanup(); });

  describe("SessionStore + Context.restore (unit)", () => {
    it("ensure() creates the store directory", () => {
      expect(existsSync(ws.root)).toBe(true);
    });

    let aId: string;
    let bId: string;

    it("creates two distinct session files", async () => {
      const a = store.newSession();
      await a.append({ role: "system", content: "sys A" });
      await a.append({ role: "user", content: "hello A" });
      await a.append({ role: "assistant", content: "hi A", model: "test", promptTokens: 5, completionTokens: 2, latencyMs: 100 });
      await new Promise((r) => setTimeout(r, 5));
      const b = store.newSession();
      await b.append({ role: "system", content: "sys B" });
      await b.append({ role: "user", content: "hello B" });
      aId = a.id; bId = b.id;
      assert(a.id !== b.id, `ids must be unique: ${a.id} vs ${b.id}`);
      assert(existsSync(a.path) && existsSync(b.path), "session files missing");
    });

    it("list returns both sessions, newest first", async () => {
      const listed = await store.list(10);
      expect(listed.length).toBe(2);
      expect(listed[0]?.id).toBe(bId);
    });

    it("metadata exposes turn count and first user message", async () => {
      const meta = await store.metadataFor(aId);
      expect(meta?.turnCount).toBe(2);
      expect(meta?.firstUserMessage).toBe("hello A");
    });

    it("findByPrefix resolves a unique prefix; returns null for unknown", async () => {
      const uniquePrefix = aId.slice(0, -2);
      expect(await store.findByPrefix(uniquePrefix)).toBe(aId);
      expect(await store.findByPrefix("doesnotexist-xxxxx")).toBe(null);
    });

    it("loadTurns + Context.restore: full roundtrip", async () => {
      const turns = await store.loadTurns(aId);
      expect(turns.length).toBe(3);
      expect(turns[0]?.role).toBe("system");
      expect(turns[1]?.role).toBe("user");
      expect(turns[2]?.role).toBe("assistant");
      expect(turns[2]?.promptTokens).toBe(5);
      expect(turns[2]?.completionTokens).toBe(2);
      expect(turns[2]?.model).toBe("test");

      const ctx = new Context({ systemPrompt: "default sys", budget: 4096 });
      ctx.restore(turns);
      const snap = ctx.snapshot();
      expect(snap.systemPrompt).toBe("sys A");
      expect(snap.historyCount).toBe(2);
      expect(snap.cumulativeIn).toBe(5);
      expect(snap.cumulativeOut).toBe(2);
    });
  });

  describe("integration: chat → kill → reload → recall", () => {
    it("model recalls a fact via on-disk session, and new turns append", async () => {
      const model = await getModel();
      const SYSTEM = "You are a test assistant. Be brief. If you don't remember something, say so plainly.";

      const ws2 = await Workspace.create("persistence-resume");
      try {
        const store2 = new SessionStore(ws2.root);
        const client = new OpenAICompatClient({ baseURL: BASE_URL, apiKey: API_KEY, model });

        const ctx1 = new Context({ systemPrompt: SYSTEM, budget: 4096 });
        const session1 = store2.newSession();
        await session1.append({ role: "system", content: SYSTEM });
        const a1 = new Assistant(ctx1, client, session1);
        await a1.chat("My favorite obscure word is 'petrichor'. Acknowledge.", { maxTokens: 30 });
        await a1.chat("And my dog's name is Maisy.", { maxTokens: 30 });
        const sessionId = session1.id;

        const turnsBefore = await store2.loadTurns(sessionId);
        assert(turnsBefore.length >= 5, `expected ≥5 turns on disk, got ${turnsBefore.length}`);

        const ctx2 = new Context({ systemPrompt: "default that should be overridden", budget: 4096 });
        ctx2.restore(turnsBefore);
        const a2 = new Assistant(ctx2, client, store2.open(sessionId));
        expect(ctx2.snapshot().systemPrompt).toBe(SYSTEM);

        const reply = await a2.chat(
          "Earlier I told you about an obscure word that is my favorite. What word was it?",
          { maxTokens: 30 },
        );
        assert(/petrichor/i.test(reply.reply), `expected reply to mention petrichor; got: ${reply.reply.slice(0, 80)}`);

        const turnsAfter = await store2.loadTurns(sessionId);
        assert(turnsAfter.length === turnsBefore.length + 2,
          `expected file growth 2 turns; before=${turnsBefore.length} after=${turnsAfter.length}`);
        return { detail: `before=${turnsBefore.length} → after=${turnsAfter.length} turns; reply mentioned petrichor` };
      } finally {
        await ws2.cleanup();
      }
    }, { needsModel: true });
  });
});
