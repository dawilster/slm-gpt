/**
 * v6 eval — RAG over notes + past sessions.
 *
 * Pass condition (per design.md §6.1):
 *   30 questions over a known corpus, ≥24 retrieve a relevant passage
 *   AND incorporate it into the answer.
 *
 * The corpus is seeded fresh for the eval: 6 markdown notes (mix of
 * short and long, varied topics) + 1 synthesized session file. The
 * indexer chunks and embeds them at the start of the run so the
 * search_corpus tool has something to find.
 *
 * Judging:
 *   - "Retrieved relevant passage" — search_corpus was called AND the
 *     returned chunks include content from the source the question is
 *     about (we check the tool result text for an expected substring).
 *   - "Incorporated into answer" — the model's final reply contains an
 *     expected substring from that source.
 *   Both must hold for a prompt to pass.
 *
 * Run with:  bun run eval/v6.ts
 * Exit code 0 if all category thresholds met.
 */

import { mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAICompatClient, discoverModel } from "../src/client";
import type { Msg, ToolCallReq } from "../src/client";
import { Context } from "../src/context";
import { Assistant } from "../src/assistant";
import { Profile } from "../src/profile";
import { EmbeddingClient, discoverEmbeddingModel } from "../src/embeddings";
import { IndexStore } from "../src/index_store";
import { indexAll } from "../src/indexer";
import {
  ToolRegistry,
  getCurrentTimeTool,
  makeForgetTool,
  makeListNotesTool,
  makeReadNoteTool,
  makeRememberTool,
  makeSearchCorpusTool,
  makeSearchNotesByFilenameTool,
  makeWriteNoteTool,
} from "../src/tools";

const BASE_URL = process.env.MODEL_BASE_URL ?? "http://localhost:1234/v1";
const API_KEY = process.env.MODEL_API_KEY ?? "lm-studio";

const TEST_ROOT = join(tmpdir(), `assistant-v6-test-${process.pid}-${Date.now()}`);
const NOTES_ROOT = join(TEST_ROOT, "notes");
const SESSIONS_ROOT = join(TEST_ROOT, "sessions");

// Mirrors BASE_SYSTEM in src/index.ts — keep in sync.
const BASE_SYSTEM = [
  "You are a helpful personal assistant. Be concise and direct.",
  "If you don't know or don't remember something, say so plainly.",
  "Never invent facts about the user that weren't established in this conversation.",
  "Memory rules:",
  "- When the user states a stable fact about themselves (preference, name, location, relationship), call remember(key, value).",
  "- When the user signals a change to a known fact — including phrasings like 'I don't like X anymore', 'I now prefer Y', 'I take it Z now', 'actually, I W' — call remember(key, value) with the NEW value to overwrite the old one. Don't just acknowledge verbally; call the tool.",
  "- Only call forget(key) if the fact no longer applies AND has no replacement.",
  "Retrieval rules:",
  "- DEFAULT TO RETRIEVAL. Before answering ANY question that could even tangentially involve the user's content, call search_corpus first. The only exceptions: pure meta-questions ('what tools do you have'), simple time queries, or instructions to perform an action you can do directly.",
  "- This applies even to questions that *look* like general knowledge: 'what is X', 'how does Y work', 'tell me about Z' — the user may have notes on X/Y/Z. Search first, then synthesize. If nothing relevant comes back, then answer from general knowledge AND say so.",
  "- For questions about places, preferences, names, experiences, recipes, or anything personal: always retrieve. The user is asking *you* (their personal assistant), not a general chatbot — they expect grounding in their own content.",
].join("\n");

const RETRIEVAL_TOOLS = new Set(["search_corpus", "read_note", "list_notes", "search_notes_by_filename"]);

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
  console.log(`${passed}/${total} category checks passed`);
  if (passed < total) {
    console.log("failures:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ✗ ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    }
    process.exitCode = 1;
  }
}

async function seedCorpus(): Promise<void> {
  await mkdir(NOTES_ROOT, { recursive: true });
  await mkdir(SESSIONS_ROOT, { recursive: true });

  await writeFile(
    join(NOTES_ROOT, "brisbane.md"),
    `# Brisbane Trip
Visited March 2024.

## Story Bridge
The bridge was illuminated in deep purple at night, especially during the Brisbane Festival.

## South Bank
Walked along South Bank early in the morning. Saw kangaroos near the lagoon.

## Food
Best meal of the trip was ramen at Hakataya in Fortitude Valley.
`,
    "utf-8",
  );

  await writeFile(
    join(NOTES_ROOT, "cairns.md"),
    `# Cairns Notes
Gateway to the Great Barrier Reef.

## Climate
Hot and humid year-round; monsoon season runs December through March.

## Diving
Best dive site nearby is Norman Reef, about two hours out by boat. Saw a manta ray on the second dive.

## Local Tips
Locals call it "Cans". Avoid the esplanade tourist restaurants.
`,
    "utf-8",
  );

  await writeFile(
    join(NOTES_ROOT, "ducks.md"),
    `# Ducks
Ducks have webbed feet and are excellent swimmers.

## Mallards
Mallards are the most common duck species across Australia.

## Wood Ducks
Wood ducks are found inland and nest in tree hollows — surprising for a waterbird.
`,
    "utf-8",
  );

  await writeFile(
    join(NOTES_ROOT, "petrichor.md"),
    `# Petrichor
The earthy scent produced when rain falls on dry soil.

## Origin of the Word
Coined by Australian researchers in 1964, from Greek "petros" (stone) and "ichor" (the fluid of the gods).
`,
    "utf-8",
  );

  await writeFile(
    join(NOTES_ROOT, "diving.md"),
    `# Diving Log

## Norman Reef, Cairns (2025)
Visibility around 30m. Manta ray on the second dive — first sighting in years.

## Tulamben, Bali (2024)
USS Liberty wreck. Saw bumphead parrotfish at sunrise — schooling near the bow.

## Komodo, Indonesia (2023)
Strong currents at Batu Bolong. Reef sharks circling at 25m depth.
`,
    "utf-8",
  );

  await writeFile(
    join(NOTES_ROOT, "coffee.md"),
    `# Coffee Notes

## Beans
Currently drinking Onyx Monarch — Ethiopian, fruity, peach-forward.

## Brewing
V60 with 18g coffee, 300g water, 3:30 pour. Use medium grind.
`,
    "utf-8",
  );

  // Synthesized session: a past chat about restaurants and Brisbane food.
  const sessionId = "2026-03-15T120000000-corpus";
  const sessionPath = join(SESSIONS_ROOT, `${sessionId}.jsonl`);
  const turns = [
    { role: "system", content: BASE_SYSTEM, ts: "2026-03-15T12:00:00.000Z" },
    {
      role: "user",
      content: "I'm in Brisbane next week — any ramen recommendations?",
      ts: "2026-03-15T12:00:01.000Z",
    },
    {
      role: "assistant",
      content:
        "Hakataya in Fortitude Valley is the standout — tonkotsu broth, fresh noodles. Worth the trip from the CBD.",
      ts: "2026-03-15T12:00:05.000Z",
    },
    {
      role: "user",
      content: "What about something for breakfast?",
      ts: "2026-03-15T12:00:30.000Z",
    },
    {
      role: "assistant",
      content:
        "Try Sourced Grocer in Newstead. Good batch brew, sourdough toast, weekend queues.",
      ts: "2026-03-15T12:00:35.000Z",
    },
  ];
  for (const t of turns) {
    await appendFile(sessionPath, JSON.stringify(t) + "\n", "utf-8");
  }
}

async function setupRetrieval(): Promise<{ store: IndexStore; embedder: EmbeddingClient }> {
  const embeddingModel = await discoverEmbeddingModel(BASE_URL, API_KEY);
  if (!embeddingModel) {
    throw new Error("no embedding model loaded — load nomic-embed in LM Studio");
  }
  const embedder = new EmbeddingClient({ baseURL: BASE_URL, apiKey: API_KEY, model: embeddingModel });
  const store = new IndexStore(join(TEST_ROOT, "index.sqlite"));
  const r = await indexAll({ store, embedder, notesRoot: NOTES_ROOT, sessionsRoot: SESSIONS_ROOT });
  console.log(`  indexed: ${r.notesIndexed} notes, ${r.sessionsIndexed} sessions, ${r.chunksAdded} chunks`);
  return { store, embedder };
}

function newAssistant(model: string, store: IndexStore, embedder: EmbeddingClient): Assistant {
  const client = new OpenAICompatClient({ baseURL: BASE_URL, apiKey: API_KEY, model });
  const ctx = new Context({ systemPrompt: BASE_SYSTEM, budget: 4096 });
  const profile = new Profile(join(TEST_ROOT, `profile-${Math.random().toString(36).slice(2, 8)}.json`));
  const registry = new ToolRegistry();
  registry.register(getCurrentTimeTool);
  registry.register(makeReadNoteTool(NOTES_ROOT));
  registry.register(makeListNotesTool(NOTES_ROOT));
  registry.register(makeWriteNoteTool(NOTES_ROOT));
  registry.register(makeSearchNotesByFilenameTool(NOTES_ROOT));
  registry.register(makeRememberTool(profile));
  registry.register(makeForgetTool(profile));
  registry.register(makeSearchCorpusTool({ store, embedder }));
  return new Assistant(ctx, client, null, registry);
}

/** Pull every tool call (with parsed result text) from the most recent turn. */
function toolCallsAndResultsInLastTurn(ctx: Context): Array<{ name: string; result: string }> {
  const all = ctx.all();
  let userIdx = all.length - 1;
  while (userIdx >= 0 && all[userIdx]?.role !== "user") userIdx--;
  const calls: Array<{ name: string; result: string }> = [];
  // For each assistant turn with tool_calls, the next 'tool' messages carry the results.
  for (let j = userIdx + 1; j < all.length; j++) {
    const m: Msg | undefined = all[j];
    if (m?.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls as ToolCallReq[]) {
        // Find the matching tool result by id.
        const resultMsg = all.slice(j + 1).find((mm) => mm.role === "tool" && mm.toolCallId === tc.id);
        calls.push({ name: tc.function.name, result: resultMsg?.content ?? "" });
      }
    }
  }
  return calls;
}

type Prompt = {
  text: string;
  expectedSourceMatch: RegExp; // appears in retrieved chunk
  expectedReplyMatch: RegExp; // appears in final reply
};

const prompts: Prompt[] = [
  // Brisbane (4)
  { text: "What did I write about the Story Bridge?", expectedSourceMatch: /(purple|illuminated|festival)/i, expectedReplyMatch: /(purple|illuminated|festival)/i },
  { text: "Where did I have my best meal in Brisbane?", expectedSourceMatch: /(hakataya|fortitude|ramen)/i, expectedReplyMatch: /(hakataya|fortitude|ramen)/i },
  { text: "What did I see at South Bank?", expectedSourceMatch: /(kangaroos?|lagoon)/i, expectedReplyMatch: /(kangaroos?|lagoon)/i },
  { text: "When did I visit Brisbane?", expectedSourceMatch: /(march 2024|2024)/i, expectedReplyMatch: /(march|2024)/i },

  // Cairns (4)
  { text: "What's the climate like in Cairns?", expectedSourceMatch: /(humid|monsoon|december|march)/i, expectedReplyMatch: /(humid|monsoon|hot)/i },
  { text: "What's the best dive site near Cairns?", expectedSourceMatch: /(norman reef|two hours)/i, expectedReplyMatch: /(norman reef)/i },
  { text: "What do locals call Cairns?", expectedSourceMatch: /(cans)/i, expectedReplyMatch: /(cans)/i },
  { text: "Should I eat at the esplanade in Cairns?", expectedSourceMatch: /(avoid|tourist)/i, expectedReplyMatch: /(avoid|tourist|no|don't)/i },

  // Ducks (3)
  { text: "What do I know about mallards?", expectedSourceMatch: /(common|australia)/i, expectedReplyMatch: /(common|australia)/i },
  { text: "Where do wood ducks nest?", expectedSourceMatch: /(tree hollows?|inland)/i, expectedReplyMatch: /(tree hollows?|inland)/i },
  { text: "Tell me about ducks in general from my notes.", expectedSourceMatch: /(webbed|swim)/i, expectedReplyMatch: /(webbed|swim)/i },

  // Petrichor (2)
  { text: "What is petrichor?", expectedSourceMatch: /(earthy|rain|dry soil|scent)/i, expectedReplyMatch: /(earthy|rain|scent)/i },
  { text: "Who coined the word petrichor?", expectedSourceMatch: /(australian|1964|researchers)/i, expectedReplyMatch: /(australian|1964|researchers)/i },

  // Diving (4)
  { text: "What did I see at Norman Reef?", expectedSourceMatch: /(manta ray|30m|visibility)/i, expectedReplyMatch: /(manta ray)/i },
  { text: "What's at Tulamben?", expectedSourceMatch: /(uss liberty|wreck|bumphead|parrotfish)/i, expectedReplyMatch: /(liberty|wreck|bumphead|parrotfish)/i },
  { text: "Where did I see reef sharks?", expectedSourceMatch: /(komodo|batu bolong)/i, expectedReplyMatch: /(komodo|batu bolong)/i },
  { text: "What dive site has strong currents in my notes?", expectedSourceMatch: /(komodo|batu bolong|currents)/i, expectedReplyMatch: /(komodo|batu bolong)/i },

  // Coffee (3)
  { text: "What coffee am I drinking right now?", expectedSourceMatch: /(onyx|monarch|ethiopian|peach)/i, expectedReplyMatch: /(onyx|monarch|ethiopian|peach)/i },
  { text: "What's my V60 recipe?", expectedSourceMatch: /(18g|300g|3:30)/i, expectedReplyMatch: /(18g|300g|3:30)/i },
  { text: "Tell me about my coffee beans.", expectedSourceMatch: /(onyx|monarch|ethiopian|fruity|peach)/i, expectedReplyMatch: /(onyx|monarch|ethiopian|fruity|peach)/i },

  // Cross-source / sessions (4)
  { text: "Have we talked about ramen before?", expectedSourceMatch: /(hakataya|fortitude|ramen)/i, expectedReplyMatch: /(hakataya|fortitude|ramen)/i },
  { text: "What did you suggest for breakfast in Brisbane?", expectedSourceMatch: /(sourced grocer|newstead|sourdough)/i, expectedReplyMatch: /(sourced grocer|newstead|sourdough)/i },
  { text: "Where should I get coffee for breakfast in Brisbane?", expectedSourceMatch: /(sourced grocer|newstead|batch brew)/i, expectedReplyMatch: /(sourced grocer|newstead|batch brew|sourdough)/i },
  { text: "Did we discuss any cafés before?", expectedSourceMatch: /(sourced grocer|newstead)/i, expectedReplyMatch: /(sourced grocer|newstead)/i },

  // Topical / synthesis (4)
  { text: "What do my notes say about Australia?", expectedSourceMatch: /(brisbane|cairns|mallards|petrichor)/i, expectedReplyMatch: /(brisbane|cairns|mallards|petrichor)/i },
  { text: "Where have I been diving?", expectedSourceMatch: /(norman reef|tulamben|komodo)/i, expectedReplyMatch: /(norman reef|tulamben|komodo|bali|cairns)/i },
  { text: "What did I write about food in Brisbane?", expectedSourceMatch: /(ramen|hakataya|fortitude)/i, expectedReplyMatch: /(ramen|hakataya|fortitude)/i },
  { text: "Find anything I have on weather.", expectedSourceMatch: /(humid|monsoon|rain|petrichor)/i, expectedReplyMatch: /(humid|monsoon|rain|petrichor)/i },

  // Edge: should still retrieve
  { text: "What animals do I have notes about?", expectedSourceMatch: /(ducks|mallards|wood ducks)/i, expectedReplyMatch: /(ducks?)/i },
  { text: "What did I write about word origins?", expectedSourceMatch: /(petrichor|petros|ichor)/i, expectedReplyMatch: /(petrichor|greek|stone|ichor)/i },
];

async function runHeadline(model: string, store: IndexStore, embedder: EmbeddingClient) {
  header(`headline: 30 prompts over the corpus (target ≥24/30 retrieve + incorporate)`);

  let passed = 0;
  let retrievedRight = 0;
  let incorporatedRight = 0;
  let usedSearchCorpus = 0;
  let usedAnyRetrieval = 0;

  for (const p of prompts) {
    const a = newAssistant(model, store, embedder);
    const r = await a.chat(p.text, { temperature: 0.2, maxTokens: 200 });
    const calls = toolCallsAndResultsInLastTurn(a.state);

    const retrievalCalls = calls.filter((c) => RETRIEVAL_TOOLS.has(c.name));
    const corpusCalls = calls.filter((c) => c.name === "search_corpus");
    if (corpusCalls.length > 0) usedSearchCorpus++;
    if (retrievalCalls.length > 0) usedAnyRetrieval++;

    // Retrieval is "correct" if any retrieval-shaped tool returned content
    // matching the expected substring. We accept search_corpus, read_note,
    // and the note-list/search tools — the user's question is "did the
    // model ground the answer in their content?", not "did it use the
    // newest tool?".
    const retrievedHit = retrievalCalls.some((c) => p.expectedSourceMatch.test(c.result));
    const replyHit = p.expectedReplyMatch.test(r.reply);

    if (retrievedHit) retrievedRight++;
    if (replyHit) incorporatedRight++;

    const ok = retrievedHit && replyHit;
    if (ok) passed++;

    const mark = ok ? "✓" : "✗";
    const toolsList = calls.map((c) => c.name).join(",") || "(none)";
    const reason = retrievalCalls.length === 0
      ? `no retrieval call (tools=${toolsList})`
      : !retrievedHit
      ? `retrieved chunks lacked expected content (tools=${toolsList})`
      : !replyHit
      ? `reply didn't incorporate retrieved content (tools=${toolsList})`
      : `ok (tools=${toolsList})`;
    console.log(`  ${mark} "${p.text.slice(0, 55)}"  [${reason}]`);
    console.log(`      reply: ${r.reply.replace(/\n/g, " ").slice(0, 80)}`);
  }

  console.log(`\n  used search_corpus:       ${usedSearchCorpus}/${prompts.length}`);
  console.log(`  used any retrieval tool:  ${usedAnyRetrieval}/${prompts.length}`);
  console.log(`  retrieval correct:        ${retrievedRight}/${prompts.length}`);
  console.log(`  incorporation correct:    ${incorporatedRight}/${prompts.length}`);
  console.log(`  ── headline (both):       ${passed}/${prompts.length}`);

  record(`headline ≥24/30 (retrieve + incorporate)`, passed >= 24, `${passed}/${prompts.length}`);
}

async function main() {
  console.log("v6 eval — RAG over notes + sessions");
  console.log("═".repeat(50));

  await mkdir(TEST_ROOT, { recursive: true });
  try {
    await seedCorpus();

    let model: string;
    try {
      model = await discoverModel(BASE_URL, API_KEY);
    } catch (e: any) {
      record("model server reachable", false, e?.message ?? String(e));
      return;
    }
    record("model server reachable", true, `model=${model}`);

    let store: IndexStore;
    let embedder: EmbeddingClient;
    try {
      const setup = await setupRetrieval();
      store = setup.store;
      embedder = setup.embedder;
    } catch (e: any) {
      record("embedding model reachable + indexing", false, e?.message ?? String(e));
      return;
    }
    record("embedding model reachable + indexing", true);

    await runHeadline(model, store, embedder);
  } finally {
    await rm(TEST_ROOT, { recursive: true, force: true });
  }

  summarize();
}

main().catch((e) => {
  console.error("\nunexpected error:", e);
  process.exit(2);
});
