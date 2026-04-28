/**
 * v0: bare chat loop against an OpenAI-compatible endpoint.
 *
 * Teaches one thing: the model has no memory. You ship the entire
 * conversation on every turn. Watch prompt_tokens grow each turn
 * and you'll feel it.
 *
 * Commands:
 *   /quit      exit
 *   /clear     reset history (keep system prompt)
 *   /history   dump message array
 *   /tokens    cumulative token counts
 */

import OpenAI from "openai";
import * as readline from "node:readline/promises";

const BASE_URL = process.env.MODEL_BASE_URL ?? "http://localhost:1234/v1";
const SYSTEM = "You are a helpful personal assistant. Be concise and direct.";

type Msg = { role: "system" | "user" | "assistant"; content: string };

const client = new OpenAI({
  baseURL: BASE_URL,
  apiKey: process.env.MODEL_API_KEY ?? "lm-studio", // LM Studio ignores the key
});

async function discoverModel(): Promise<string> {
  const list = await client.models.list();
  const chat = list.data.find((m) => !m.id.toLowerCase().includes("embed"));
  if (!chat) throw new Error("No chat model loaded at " + BASE_URL);
  return chat.id;
}

async function main() {
  let model: string;
  try {
    model = await discoverModel();
  } catch (e) {
    console.error(`Could not reach model server at ${BASE_URL}.`);
    console.error("Start LM Studio's Developer server, or set MODEL_BASE_URL.");
    process.exit(1);
  }

  const messages: Msg[] = [{ role: "system", content: SYSTEM }];
  let totalIn = 0;
  let totalOut = 0;

  console.log(`loop v0  ·  model: ${model}  ·  endpoint: ${BASE_URL}`);
  console.log("type /quit to exit, /clear, /history, /tokens\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    const user = (await rl.question("you: ")).trim();
    if (!user) continue;

    if (user === "/quit") break;
    if (user === "/clear") {
      messages.length = 0;
      messages.push({ role: "system", content: SYSTEM });
      totalIn = totalOut = 0;
      console.log("[history cleared]\n");
      continue;
    }
    if (user === "/history") {
      messages.forEach((m, i) => {
        const preview = m.content.replace(/\n/g, " ").slice(0, 90);
        console.log(`  ${String(i).padStart(2)} [${m.role.padEnd(9)}] ${preview}`);
      });
      console.log();
      continue;
    }
    if (user === "/tokens") {
      console.log(`  cumulative: in=${totalIn}  out=${totalOut}  total=${totalIn + totalOut}`);
      console.log(`  messages in history: ${messages.length}\n`);
      continue;
    }

    messages.push({ role: "user", content: user });

    try {
      const resp = await client.chat.completions.create({
        model,
        messages,
        temperature: 0.7,
      });
      const reply = resp.choices[0]?.message.content ?? "";
      const usage = resp.usage;
      if (usage) {
        totalIn += usage.prompt_tokens;
        totalOut += usage.completion_tokens;
      }
      messages.push({ role: "assistant", content: reply });
      console.log(`\nassistant: ${reply}`);
      console.log(
        `  └─ prompt_tokens=${usage?.prompt_tokens ?? "?"}  ` +
          `completion_tokens=${usage?.completion_tokens ?? "?"}  ` +
          `history_msgs=${messages.length}\n`,
      );
    } catch (e: any) {
      console.log(`[error] ${e.message ?? e}\n`);
      messages.pop();
    }
  }

  rl.close();
}

main();
