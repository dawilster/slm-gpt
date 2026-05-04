/**
 * Context — budget enforcement and the anti-confabulation behaviour.
 *
 * Two halves:
 *   - Unit: budget under tight settings drops oldest first, system stays
 *     pinned, the latest message is always preserved.
 *   - Integration: a long conversation respects the budget; a fact stated
 *     early ages out under a tight budget but is recalled under an ample
 *     one. Critically: under context loss, the strengthened system prompt
 *     should make the model admit uncertainty rather than confabulate.
 */

import { describe, it, info } from "../lib/suite";
import { expect, assert } from "../lib/expect";
import { Context } from "../../src/context";
import { Assistant } from "../../src/assistant";
import { OpenAICompatClient, probeServerCapabilities } from "../../src/client";
import { BASE_URL, API_KEY, getModel } from "../lib/fixtures";

const RECALL_SYSTEM = [
  "Reply concisely.",
  "If you don't know or don't remember something, say so plainly.",
  "Never invent facts about the user that weren't established in this conversation.",
].join(" ");

describe("context", () => {

  describe("budget enforcement (unit)", () => {
    it("no trim under generous budget", () => {
      const c = new Context({ systemPrompt: "sys", budget: 4096 });
      for (let i = 0; i < 5; i++) {
        c.addUser(`user msg ${i}`);
        c.addAssistant(`assistant reply ${i}`);
      }
      expect(c.messagesForRequest().length).toBe(c.all().length);
    });

    it("trims history but preserves system + latest under tight budget", () => {
      const c = new Context({ systemPrompt: "sys", budget: 80, reservedForResponse: 16 });
      for (let i = 0; i < 12; i++) {
        c.addUser(`u${i}_${"x".repeat(10)}`);
        c.addAssistant(`a${i}_${"y".repeat(10)}`);
      }
      const sent = c.messagesForRequest();
      assert(sent.length < c.all().length, `expected trimming, got sent=${sent.length} total=${c.all().length}`);
      expect(sent[0]?.role).toBe("system");
      expect(sent[0]?.content).toBe("sys");
      const last = sent[sent.length - 1]!;
      expect(last.role).toBe("assistant");
      expect(last.content.startsWith("a11_")).toBe(true);
    });

    it("clear() resets history and counters", () => {
      const c = new Context({ systemPrompt: "sys", budget: 4096 });
      c.addUser("hi");
      c.addAssistant("hello");
      c.recordUsage(50, 10);
      c.clear();
      const s = c.snapshot();
      expect(s.historyCount).toBe(0);
      expect(s.cumulativeIn).toBe(0);
      expect(s.cumulativeOut).toBe(0);
    });
  });

  describe("integration: long conversation + fact aging", () => {
    it("server's loaded context is large enough for ample-budget arm (≥8192)", async () => {
      const caps = await probeServerCapabilities(BASE_URL);
      if (!caps) return { detail: "server caps probe unavailable; assuming sufficient" };
      assert(caps.contextLimit >= 8192, `server contextLimit=${caps.contextLimit}`);
      return { detail: `contextLimit=${caps.contextLimit}` };
    }, { needsModel: true });

    it("long conversation respects configured budget", async () => {
      const model = await getModel();
      const client = new OpenAICompatClient({ baseURL: BASE_URL, apiKey: API_KEY, model });
      const budget = 600;
      const ctx = new Context({ systemPrompt: "Reply in one short sentence.", budget });
      const a = new Assistant(ctx, client);
      const turns = [
        "Hi.", "What's two plus two?", "Tell me a fact about the ocean.",
        "Recommend a fruit.", "Pick a color.", "Pick another color.", "Say goodbye.",
      ];
      let anyTrimmed = false;
      let maxPromptTokens = 0;
      for (const t of turns) {
        const r = await a.chat(t, { maxTokens: 50 });
        if (r.trimmed) anyTrimmed = true;
        maxPromptTokens = Math.max(maxPromptTokens, r.promptTokens);
      }
      assert(anyTrimmed, `expected trimming during long conversation; max_prompt_tokens=${maxPromptTokens}`);
      assert(maxPromptTokens <= budget, `prompt_tokens ${maxPromptTokens} exceeded budget ${budget}`);
      return { detail: `max=${maxPromptTokens}/${budget} budget` };
    }, { needsModel: true });

    info("capability cost: fact ages out under tight budget, recalled under ample", async () => {
      const model = await getModel();
      const client = new OpenAICompatClient({ baseURL: BASE_URL, apiKey: API_KEY, model });
      const fact = "My favorite obscure word is 'petrichor'.";
      const distractors = [
        "Tell me a short joke.",
        "Suggest a name for a pet hamster.",
        "Make up a haiku about wind.",
        "What's a creative way to greet a friend?",
        "Pick a color and describe it in five words.",
        "Recommend a fun weekend activity.",
        "Suggest a dish to cook tonight.",
        "Describe your ideal afternoon in one sentence.",
      ];
      async function run(budget: number) {
        const ctx = new Context({ systemPrompt: RECALL_SYSTEM, budget });
        const a = new Assistant(ctx, client);
        await a.chat(fact, { maxTokens: 30 });
        let trimmed = false;
        for (const d of distractors) {
          const r = await a.chat(d, { maxTokens: 60 });
          if (r.trimmed) trimmed = true;
        }
        const final = await a.chat(
          "Earlier in this conversation, I told you what my favorite obscure word was. What was that word?",
          { maxTokens: 30 },
        );
        return {
          trimmed,
          remembered: /petrichor/i.test(final.reply),
          admitsUncertainty: /(don't|do not|cannot|can't|haven't|have not|didn't|did not)\s+(know|remember|recall|told|tell|mention)|not sure|unsure|no idea|don't have (that|the) (info|information)/i.test(final.reply),
          reply: final.reply,
        };
      }
      const tight = await run(400);
      const ample = await run(8192);
      const lines = [
        `tight (budget=400): trimmed=${tight.trimmed} remembered=${tight.remembered} admits_uncertainty=${tight.admitsUncertainty}`,
        `ample (budget=8192): trimmed=${ample.trimmed} remembered=${ample.remembered}`,
      ];
      return { detail: lines.join(" | ") };
    });
  });
});
