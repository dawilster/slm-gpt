/**
 * Tool-loop mechanics — the parts of the old v3 eval that survived v6.5's
 * tool drop. We no longer have read_note / list_notes / write_note /
 * search_notes_by_filename, so the bulk of v3 (path safety, "read this
 * file") is gone with them. What still matters:
 *
 *   - Schema guards: validateArgs rejects malformed args at the boundary
 *     (this is the v3.5 validate-and-retry primitive — it lets the model
 *     self-correct on the next loop iteration instead of crashing).
 *   - Discrimination: when given a tool, the model still calls it for the
 *     prompts it's appropriate for, and leaves it alone for prompts it
 *     isn't. Tested on get_current_time, the simplest live tool.
 *   - Loop guard: maxSteps actually terminates the agent loop.
 *
 * Multi-tool routing (v4's role) lives in suites/shortcuts.ts now.
 */

import { describe, it, scenario } from "../lib/suite";
import { expect } from "../lib/expect";
import { calledTool, calledNothing } from "../lib/judges";
import { getModel, newAssistant, observedCallsInLastTurn } from "../lib/fixtures";
import { getCurrentTimeTool, validateArgs } from "../../src/tools";

describe("tool loop", () => {

  describe("schema guards (unit)", () => {
    const schema = {
      type: "object",
      properties: {
        key:   { type: "string", description: "" },
        value: { type: "string", description: "" },
        n:     { type: "integer", description: "" },
      },
      required: ["key", "value"],
    } as const;

    it("rejects non-object args", () => {
      expect(validateArgs("not an object", schema as never).ok).toBe(false);
      expect(validateArgs(null, schema as never).ok).toBe(false);
      expect(validateArgs([], schema as never).ok).toBe(false);
    });
    it("rejects missing required field", () => {
      expect(validateArgs({ key: "k" }, schema as never).ok).toBe(false);
    });
    it("rejects empty required string", () => {
      expect(validateArgs({ key: "", value: "v" }, schema as never).ok).toBe(false);
    });
    it("rejects wrong type", () => {
      const r = validateArgs({ key: "k", value: "v", n: "not a number" }, schema as never);
      expect(r.ok).toBe(false);
    });
    it("accepts valid args", () => {
      expect(validateArgs({ key: "k", value: "v" }, schema as never).ok).toBe(true);
      expect(validateArgs({ key: "k", value: "v", n: 3 }, schema as never).ok).toBe(true);
    });
  });

  describe("model behaviour", () => {
    let model: string;
    // beforeAll only runs on entry; gate it on "needs model" so --offline can
    // skip the whole inner block cleanly via the it/scenario needsModel flags.
    // We still resolve the model lazily so a missing server doesn't crash.

    scenario("calls get_current_time when prompted for the time", {
      threshold: [4, 5],
      prompts: [
        "What time is it right now?",
        "What's the current ISO timestamp?",
        "Tell me today's date.",
        "What is the current date and time?",
        "Right now — what is the time?",
      ],
      judge: async ({ prompt }) => {
        await getModel();
        const { assistant, context, registry } = newAssistant({ withTime: false });
        registry.register(getCurrentTimeTool);
        await assistant.chat(prompt, { temperature: 0.2, maxTokens: 80 });
        return calledTool(observedCallsInLastTurn(context), "get_current_time");
      },
    });

    // The v3 baseline: a 4B with a single tool registered still over-calls
    // for chitchat about 4/5 times. Threshold 1/5 isn't a goal, it's a
    // tripwire — if the model regresses below it, we want to know.
    scenario("leaves tools alone for chit-chat (over-call tripwire)", {
      threshold: [1, 5],
      prompts: [
        "Hi, how are you today?",
        "What's two plus two?",
        "Recommend a fun weekend activity.",
        "Make up a haiku about wind.",
        "Give me a name idea for a pet hamster.",
      ],
      judge: async ({ prompt }) => {
        await getModel();
        const { assistant, context, registry } = newAssistant({ withTime: false });
        registry.register(getCurrentTimeTool);
        await assistant.chat(prompt, { temperature: 0.2, maxTokens: 80 });
        return calledNothing(observedCallsInLastTurn(context));
      },
    });

    it("agent loop terminates within maxSteps", async () => {
      await getModel();
      const { assistant } = newAssistant({ withTime: true });
      const r = await assistant.chat("What time is it?", { temperature: 0.2, maxTokens: 60, maxSteps: 1 });
      expect(r.steps).toBeLessThanOrEqual(1);
    }, { needsModel: true });
  });
});
