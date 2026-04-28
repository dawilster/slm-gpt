/**
 * v2 eval — persistence.
 *
 *   1. unit: SessionStore creates dir, generates IDs, lists sessions
 *   2. unit: Session.append writes valid JSONL, one line per turn
 *   3. unit: SessionStore.loadTurns roundtrips append→read
 *   4. unit: SessionStore.findByPrefix matches partial IDs
 *   5. unit: Context.restore replaces in-memory state from saved turns
 *   6. integration: chat → kill (drop all in-memory state) → reload from
 *      disk → assistant correctly recalls a fact stated before the "kill"
 *
 * Tests use a tmpdir so the user's real ~/.assistant/ is untouched.
 *
 * Run with:  bun run eval/v2.ts
 * Exit code: 0 if all pass, 1 otherwise.
 */

import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAICompatClient, discoverModel } from "../src/client";
import { Context } from "../src/context";
import { Assistant } from "../src/assistant";
import { SessionStore } from "../src/sessions";

const BASE_URL = process.env.MODEL_BASE_URL ?? "http://localhost:1234/v1";
const API_KEY = process.env.MODEL_API_KEY ?? "lm-studio";

const TEST_ROOT = join(tmpdir(), `assistant-v2-test-${process.pid}-${Date.now()}`);

type CheckResult = { name: string; passed: boolean; detail?: string };
const results: CheckResult[] = [];

function record(name: string, passed: boolean, detail?: string) {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function header(title: string) {
  console.log(`\n§ ${title}`);
}

function summarize() {
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  console.log("\n" + "═".repeat(50));
  console.log(`${passed}/${total} checks passed`);
  if (passed < total) {
    console.log("failures:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ✗ ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    }
    process.exitCode = 1;
  }
}

async function unitChecks() {
  header("unit: SessionStore + Session + Context.restore");

  const store = new SessionStore(TEST_ROOT);
  await store.ensure();
  record("ensure() creates store directory", existsSync(TEST_ROOT));

  // Two distinct sessions; ids should be unique and lexically sortable by start time.
  const a = store.newSession();
  await a.append({ role: "system", content: "sys A" });
  await a.append({ role: "user", content: "hello A" });
  await a.append({ role: "assistant", content: "hi A", model: "test", promptTokens: 5, completionTokens: 2, latencyMs: 100 });

  // Tiny pause to make timestamps order-stable across systems with coarse clocks.
  await new Promise((r) => setTimeout(r, 5));

  const b = store.newSession();
  await b.append({ role: "system", content: "sys B" });
  await b.append({ role: "user", content: "hello B" });

  record("session ids are distinct", a.id !== b.id, `a=${a.id} b=${b.id}`);
  record("session files exist on disk", existsSync(a.path) && existsSync(b.path));

  // listing is most-recent-first
  const listed = await store.list(10);
  record("list returns both sessions", listed.length === 2);
  record("list orders newest first", listed[0]?.id === b.id);

  // metadata
  const metaA = await store.metadataFor(a.id);
  record(
    "metadata reads turn count and first user message",
    metaA?.turnCount === 2 && metaA?.firstUserMessage === "hello A",
    `turnCount=${metaA?.turnCount} firstUser='${metaA?.firstUserMessage}'`,
  );

  // findByPrefix — slice past the timestamp into the random suffix so the
  // prefix is unique to session a (otherwise both a and b share the same
  // date/hour/minute prefix and findByPrefix correctly returns the newer one).
  const uniquePrefix = a.id.slice(0, -2);
  const matched = await store.findByPrefix(uniquePrefix);
  record("findByPrefix resolves a unique prefix", matched === a.id, `prefix=${uniquePrefix}`);
  const noMatch = await store.findByPrefix("doesnotexist-xxxxx");
  record("findByPrefix returns null for unknown prefix", noMatch === null);

  // loadTurns roundtrip
  const turns = await store.loadTurns(a.id);
  record("loadTurns yields 3 records", turns.length === 3);
  record(
    "system / user / assistant order preserved",
    turns[0]?.role === "system" && turns[1]?.role === "user" && turns[2]?.role === "assistant",
  );
  record(
    "assistant turn carries metadata",
    turns[2]?.promptTokens === 5 && turns[2]?.completionTokens === 2 && turns[2]?.model === "test",
  );

  // Context.restore
  const ctx = new Context({ systemPrompt: "default sys", budget: 4096 });
  ctx.restore(turns);
  const snap = ctx.snapshot();
  record(
    "Context.restore overrides default system prompt with stored one",
    snap.systemPrompt === "sys A",
  );
  record(
    "Context.restore loads non-system turns into history",
    snap.historyCount === 2,
    `historyCount=${snap.historyCount}`,
  );
  record(
    "Context.restore replays cumulative usage counters",
    snap.cumulativeIn === 5 && snap.cumulativeOut === 2,
  );
}

async function integrationCheck() {
  header("integration: chat → kill → reload → recall");

  let model: string;
  try {
    model = await discoverModel(BASE_URL, API_KEY);
  } catch (e: any) {
    record("model server reachable", false, e?.message ?? String(e));
    return;
  }
  record("model server reachable", true, `model=${model}`);

  const SYSTEM = [
    "You are a test assistant. Be brief.",
    "If you don't remember something, say so plainly.",
  ].join(" ");

  const store = new SessionStore(TEST_ROOT);
  const client = new OpenAICompatClient({ baseURL: BASE_URL, apiKey: API_KEY, model });

  // ─── pre-kill: tell the assistant a memorable fact ───
  const ctx1 = new Context({ systemPrompt: SYSTEM, budget: 4096 });
  const session1 = store.newSession();
  await session1.append({ role: "system", content: SYSTEM });
  const a1 = new Assistant(ctx1, client, session1);

  await a1.chat("My favorite obscure word is 'petrichor'. Acknowledge.", { maxTokens: 30 });
  await a1.chat("And my dog's name is Maisy.", { maxTokens: 30 });

  const sessionId = session1.id;

  // ─── simulate kill: drop all references; the file on disk is the only state ───
  // (in-memory ctx1, a1, session1 still exist as JS objects but we don't use them)

  // ─── post-kill: load from disk into a fresh Context + Assistant ───
  const turnsBefore = await store.loadTurns(sessionId);
  record("session has turns on disk after pre-kill chat", turnsBefore.length >= 5, `turns=${turnsBefore.length}`);

  const ctx2 = new Context({ systemPrompt: "default that should be overridden", budget: 4096 });
  ctx2.restore(turnsBefore);
  const a2 = new Assistant(ctx2, client, store.open(sessionId));

  record("restored context has the right system prompt", ctx2.snapshot().systemPrompt === SYSTEM);

  // Ask the recall question. The model has not seen the fact in this process —
  // it can only know via the restored conversation history.
  const reply = await a2.chat(
    "Earlier I told you about an obscure word that is my favorite. What word was it?",
    { maxTokens: 30 },
  );
  console.log(`  reply: ${JSON.stringify(reply.reply.slice(0, 100))}`);
  record(
    "model recalls the fact from the resumed session",
    /petrichor/i.test(reply.reply),
    /petrichor/i.test(reply.reply) ? "remembered" : `did not recall: ${reply.reply.slice(0, 80)}`,
  );

  // The new turn should also be appended to the same session file.
  const turnsAfter = await store.loadTurns(sessionId);
  record(
    "post-resume chat appended to the same session file",
    turnsAfter.length === turnsBefore.length + 2,
    `before=${turnsBefore.length} after=${turnsAfter.length}`,
  );
}

async function main() {
  console.log("v2 eval — persistence");
  console.log("═".repeat(50));

  try {
    await mkdir(TEST_ROOT, { recursive: true });
    await unitChecks();
    await integrationCheck();
  } finally {
    await rm(TEST_ROOT, { recursive: true, force: true });
  }

  summarize();
}

main().catch((e) => {
  console.error("\nunexpected error:", e);
  process.exit(2);
});
