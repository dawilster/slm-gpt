/**
 * Entry point — wires the assistant together and runs the REPL.
 *
 * Slash commands: /quit /clear /history /tokens /context /budget [n]
 *
 * Env:
 *   MODEL_BASE_URL    OpenAI-compat base URL    (default: http://localhost:1234/v1)
 *   MODEL_API_KEY     api key                   (default: lm-studio, accepted by LM Studio)
 *   CONTEXT_BUDGET    token budget for history  (default: 4096)
 */

import * as readline from "node:readline/promises";
import { OpenAICompatClient, discoverModel } from "./client";
import { Context } from "./context";
import { Assistant } from "./assistant";

const BASE_URL = process.env.MODEL_BASE_URL ?? "http://localhost:1234/v1";
const API_KEY = process.env.MODEL_API_KEY ?? "lm-studio";
const SYSTEM = "You are a helpful personal assistant. Be concise and direct.";
const DEFAULT_BUDGET = Number(process.env.CONTEXT_BUDGET ?? 4096);

async function main() {
  let modelId: string;
  try {
    modelId = await discoverModel(BASE_URL, API_KEY);
  } catch (e) {
    console.error(`Could not reach model server at ${BASE_URL}.`);
    console.error("Start LM Studio's Developer server, or set MODEL_BASE_URL.");
    process.exit(1);
  }

  const client = new OpenAICompatClient({ baseURL: BASE_URL, apiKey: API_KEY, model: modelId });
  const context = new Context({ systemPrompt: SYSTEM, budget: DEFAULT_BUDGET });
  const assistant = new Assistant(context, client);

  console.log(`assistant v1  ·  model: ${modelId}  ·  budget: ${DEFAULT_BUDGET} tokens`);
  console.log("commands: /quit  /clear  /history  /tokens  /context  /budget [n]\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    const input = (await rl.question("you: ")).trim();
    if (!input) continue;

    if (input === "/quit") break;

    if (input === "/clear") {
      context.clear();
      console.log("[history cleared]\n");
      continue;
    }

    if (input === "/history") {
      const all = context.all();
      all.forEach((m, i) => {
        const preview = m.content.replace(/\n/g, " ").slice(0, 90);
        console.log(`  ${String(i).padStart(2)} [${m.role.padEnd(9)}] ${preview}`);
      });
      console.log();
      continue;
    }

    if (input === "/tokens") {
      const s = context.snapshot();
      console.log(`  cumulative: in=${s.cumulativeIn}  out=${s.cumulativeOut}  total=${s.cumulativeIn + s.cumulativeOut}`);
      console.log(`  history: ${s.historyCount} messages  est. prompt: ~${s.estimatedPromptTokens} tokens (budget ${s.budget})\n`);
      continue;
    }

    if (input === "/context") {
      const s = context.snapshot();
      const wouldSend = context.messagesForRequest().length;
      const wouldTrim = context.wouldTrim();
      console.log(`  total: ${s.historyCount + 1} messages (incl. system)`);
      console.log(`  would send: ${wouldSend}${wouldTrim ? "  (trimmed)" : ""}`);
      console.log(`  budget: ${s.budget}  reserved for response: ${s.reservedForResponse}\n`);
      continue;
    }

    if (input.startsWith("/budget")) {
      const parts = input.split(/\s+/);
      if (parts.length === 1) {
        console.log(`  current budget: ${context.budget}\n`);
      } else {
        const n = Number(parts[1]);
        if (!Number.isFinite(n) || n <= 0) {
          console.log("  usage: /budget [positive number]\n");
        } else {
          context.budget = n;
          console.log(`  budget set to ${n}\n`);
        }
      }
      continue;
    }

    try {
      const r = await assistant.chat(input);
      console.log(`\nassistant: ${r.reply}`);
      const trimNote = r.trimmed ? `  ⚠ trimmed: sent ${r.sentMessages} of ${r.totalMessages}` : "";
      console.log(
        `  └─ prompt_tokens=${r.promptTokens}  completion_tokens=${r.completionTokens}  ` +
          `latency=${r.latencyMs}ms${trimNote}\n`,
      );
    } catch (e: any) {
      console.log(`[error] ${e?.message ?? e}\n`);
    }
  }

  rl.close();
}

main();
