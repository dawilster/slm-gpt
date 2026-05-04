/**
 * Substrate — the chat loop's contract with the model server.
 *
 * v0 had no novel behavior; this verifies the foundation everything else
 * builds on:
 *   - the server is reachable and a chat model is loaded
 *   - latency / tok-per-sec baseline (informational)
 *   - separate conversations have NO cross-talk (statelessness lesson)
 *   - same conversation DOES recall earlier turns
 *   - prompt_tokens grows monotonically across turns
 */

import OpenAI from "openai";
import { describe, it, info } from "../lib/suite";
import { expect, assert } from "../lib/expect";
import { BASE_URL, API_KEY } from "../lib/fixtures";

const client = new OpenAI({ baseURL: BASE_URL, apiKey: API_KEY, timeout: 30_000 });

type Msg = { role: "system" | "user" | "assistant"; content: string };

async function chat(model: string, messages: Msg[]) {
  const t0 = Date.now();
  const resp = await client.chat.completions.create({ model, messages, temperature: 0.0 });
  const elapsedMs = Date.now() - t0;
  const reply = resp.choices[0]?.message.content ?? "";
  const usage = resp.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return { reply, usage, elapsedMs };
}

describe("substrate", () => {
  let model: string;

  it("server reachable and chat model loaded", async () => {
    const list = await client.models.list();
    const chatModel = list.data.find((m) => !m.id.toLowerCase().includes("embed"));
    assert(chatModel != null, "no chat model loaded");
    model = chatModel!.id;
  }, { needsModel: true });

  info("latency baseline (3 short prompts)", async () => {
    if (!model) return;
    const lats: number[] = [];
    const tps: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await chat(model, [{ role: "user", content: "Reply with exactly one short sentence." }]);
      lats.push(r.elapsedMs);
      tps.push((r.usage.completion_tokens / r.elapsedMs) * 1000);
    }
    const median = [...lats].sort((a, b) => a - b)[1]!;
    const avgTps = tps.reduce((a, b) => a + b, 0) / tps.length;
    return { detail: `median=${median}ms, avg=${avgTps.toFixed(1)} tok/s` };
  });

  it("statelessness: separate conversations have no shared memory", async () => {
    if (!model) throw new Error("model not discovered");
    await chat(model, [{ role: "user", content: "My name is William. Remember it." }]);
    const fresh = await chat(model, [{ role: "user", content: "What is my name? Answer in one word, or say 'unknown'." }]);
    expect(fresh.reply).not.toMatch(/\bwilliam\b/i);
  }, { needsModel: true });

  it("in-context recall: same conversation recalls earlier turns", async () => {
    if (!model) throw new Error("model not discovered");
    const convo: Msg[] = [{ role: "user", content: "My name is William." }];
    let r = await chat(model, convo);
    convo.push({ role: "assistant", content: r.reply });
    convo.push({ role: "user", content: "I am a software engineer." });
    r = await chat(model, convo);
    convo.push({ role: "assistant", content: r.reply });
    convo.push({ role: "user", content: "What is my name? Answer in one word." });
    r = await chat(model, convo);
    expect(r.reply).toMatch(/\bwilliam\b/i);
  }, { needsModel: true });

  it("prompt_tokens grows monotonically across turns", async () => {
    if (!model) throw new Error("model not discovered");
    const convo: Msg[] = [];
    const seq: number[] = [];
    for (const text of ["Hi.", "How are you?", "What's the weather like in your imagination?", "Thanks."]) {
      convo.push({ role: "user", content: text });
      const r = await chat(model, convo);
      convo.push({ role: "assistant", content: r.reply });
      seq.push(r.usage.prompt_tokens);
    }
    for (let i = 1; i < seq.length; i++) {
      assert(seq[i]! > seq[i - 1]!, `prompt_tokens not monotonic: ${seq.join(" → ")}`);
    }
  }, { needsModel: true });
});
