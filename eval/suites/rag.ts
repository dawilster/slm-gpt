/**
 * RAG — search_corpus over a seeded notes + sessions corpus.
 *
 * Pass condition (per design.md §6.1, ≥24/30 in the original framing):
 *   30 prompts, each must (a) trigger a retrieval call whose result
 *   contains the expected source content, AND (b) the model's reply must
 *   incorporate the retrieved content. Both halves count.
 *
 * The 24/30 bar from v6 is preserved as the threshold here. Failures
 * cluster on two known shapes: model treating an encyclopedic-sounding
 * query as general knowledge (no retrieval), or wrong chunks ranked first.
 */

import { describe, it, scenario, beforeAll, afterAll } from "../lib/suite";
import { expect, assert } from "../lib/expect";
import { OpenAICompatClient } from "../../src/client";
import { Context } from "../../src/context";
import { Assistant } from "../../src/assistant";
import { Profile } from "../../src/profile";
import { EmbeddingClient, discoverEmbeddingModel } from "../../src/embeddings";
import { IndexStore } from "../../src/index_store";
import { indexAll } from "../../src/indexer";
import {
  ToolRegistry,
  getCurrentTimeTool,
  makeForgetTool,
  makeRememberTool,
  makeSearchCorpusTool,
} from "../../src/tools";
import {
  Workspace,
  BASE_URL,
  API_KEY,
  getModel,
  observedCallsInLastTurn,
  writeNote,
  writeSession,
} from "../lib/fixtures";

const RAG_SYSTEM = [
  "You are a helpful personal assistant. Be concise and direct.",
  "If you don't know or don't remember something, say so plainly.",
  "Never invent facts about the user that weren't established in this conversation.",
  "Retrieval rules:",
  "- DEFAULT TO RETRIEVAL. Before answering ANY question that could even tangentially involve the user's content, call search_corpus first. The only exceptions: pure meta-questions ('what tools do you have'), simple time queries, or instructions to perform an action you can do directly.",
  "- This applies even to questions that *look* like general knowledge: 'what is X', 'how does Y work', 'tell me about Z' — the user may have notes on X/Y/Z. Search first, then synthesize. If nothing relevant comes back, then answer from general knowledge AND say so.",
  "- For questions about places, preferences, names, experiences, recipes, or anything personal: always retrieve. The user is asking *you* (their personal assistant), not a general chatbot — they expect grounding in their own content.",
].join("\n");

let ws: Workspace;
let store: IndexStore | null = null;
let embedder: EmbeddingClient | null = null;

async function seedCorpus(ws: Workspace): Promise<void> {
  await writeNote(ws, "brisbane.md",
`# Brisbane Trip
Visited March 2024.

## Story Bridge
The bridge was illuminated in deep purple at night, especially during the Brisbane Festival.

## South Bank
Walked along South Bank early in the morning. Saw kangaroos near the lagoon.

## Food
Best meal of the trip was ramen at Hakataya in Fortitude Valley.
`);
  await writeNote(ws, "cairns.md",
`# Cairns Notes
Gateway to the Great Barrier Reef.

## Climate
Hot and humid year-round; monsoon season runs December through March.

## Diving
Best dive site nearby is Norman Reef, about two hours out by boat. Saw a manta ray on the second dive.

## Local Tips
Locals call it "Cans". Avoid the esplanade tourist restaurants.
`);
  await writeNote(ws, "ducks.md",
`# Ducks
Ducks have webbed feet and are excellent swimmers.

## Mallards
Mallards are the most common duck species across Australia.

## Wood Ducks
Wood ducks are found inland and nest in tree hollows — surprising for a waterbird.
`);
  await writeNote(ws, "petrichor.md",
`# Petrichor
The earthy scent produced when rain falls on dry soil.

## Origin of the Word
Coined by Australian researchers in 1964, from Greek "petros" (stone) and "ichor" (the fluid of the gods).
`);
  await writeNote(ws, "diving.md",
`# Diving Log

## Norman Reef, Cairns (2025)
Visibility around 30m. Manta ray on the second dive — first sighting in years.

## Tulamben, Bali (2024)
USS Liberty wreck. Saw bumphead parrotfish at sunrise — schooling near the bow.

## Komodo, Indonesia (2023)
Strong currents at Batu Bolong. Reef sharks circling at 25m depth.
`);
  await writeNote(ws, "coffee.md",
`# Coffee Notes

## Beans
Currently drinking Onyx Monarch — Ethiopian, fruity, peach-forward.

## Brewing
V60 with 18g coffee, 300g water, 3:30 pour. Use medium grind.
`);
  await writeSession(ws, "2026-03-15T120000000-corpus", [
    { role: "system", content: RAG_SYSTEM },
    { role: "user", content: "I'm in Brisbane next week — any ramen recommendations?" },
    { role: "assistant", content: "Hakataya in Fortitude Valley is the standout — tonkotsu broth, fresh noodles. Worth the trip from the CBD." },
    { role: "user", content: "What about something for breakfast?" },
    { role: "assistant", content: "Try Sourced Grocer in Newstead. Good batch brew, sourdough toast, weekend queues." },
  ]);
}

function newRagAssistant(model: string, store: IndexStore, embedder: EmbeddingClient) {
  const client = new OpenAICompatClient({ baseURL: BASE_URL, apiKey: API_KEY, model });
  const ctx = new Context({ systemPrompt: RAG_SYSTEM, budget: 4096 });
  const profile = new Profile(ws.path(`profile-${Math.random().toString(36).slice(2, 8)}.json`));
  const registry = new ToolRegistry();
  registry.register(getCurrentTimeTool);
  registry.register(makeRememberTool(profile));
  registry.register(makeForgetTool(profile));
  registry.register(makeSearchCorpusTool({ store, embedder }));
  return { assistant: new Assistant(ctx, client, null, registry), context: ctx };
}

const RAG_PROMPTS: Array<{ text: string; sourceMatch: RegExp; replyMatch: RegExp }> = [
  // Brisbane (4)
  { text: "What did I write about the Story Bridge?", sourceMatch: /(purple|illuminated|festival)/i, replyMatch: /(purple|illuminated|festival)/i },
  { text: "Where did I have my best meal in Brisbane?", sourceMatch: /(hakataya|fortitude|ramen)/i, replyMatch: /(hakataya|fortitude|ramen)/i },
  { text: "What did I see at South Bank?", sourceMatch: /(kangaroos?|lagoon)/i, replyMatch: /(kangaroos?|lagoon)/i },
  { text: "When did I visit Brisbane?", sourceMatch: /(march 2024|2024)/i, replyMatch: /(march|2024)/i },
  // Cairns (4)
  { text: "What's the climate like in Cairns?", sourceMatch: /(humid|monsoon|december|march)/i, replyMatch: /(humid|monsoon|hot)/i },
  { text: "What's the best dive site near Cairns?", sourceMatch: /(norman reef|two hours)/i, replyMatch: /(norman reef)/i },
  { text: "What do locals call Cairns?", sourceMatch: /(cans)/i, replyMatch: /(cans)/i },
  { text: "Should I eat at the esplanade in Cairns?", sourceMatch: /(avoid|tourist)/i, replyMatch: /(avoid|tourist|no|don't)/i },
  // Ducks (3)
  { text: "What do I know about mallards?", sourceMatch: /(common|australia)/i, replyMatch: /(common|australia)/i },
  { text: "Where do wood ducks nest?", sourceMatch: /(tree hollows?|inland)/i, replyMatch: /(tree hollows?|inland)/i },
  { text: "Tell me about ducks in general from my notes.", sourceMatch: /(webbed|swim)/i, replyMatch: /(webbed|swim)/i },
  // Petrichor (2)
  { text: "What is petrichor?", sourceMatch: /(earthy|rain|dry soil|scent)/i, replyMatch: /(earthy|rain|scent)/i },
  { text: "Who coined the word petrichor?", sourceMatch: /(australian|1964|researchers)/i, replyMatch: /(australian|1964|researchers)/i },
  // Diving (4)
  { text: "What did I see at Norman Reef?", sourceMatch: /(manta ray|30m|visibility)/i, replyMatch: /(manta ray)/i },
  { text: "What's at Tulamben?", sourceMatch: /(uss liberty|wreck|bumphead|parrotfish)/i, replyMatch: /(liberty|wreck|bumphead|parrotfish)/i },
  { text: "Where did I see reef sharks?", sourceMatch: /(komodo|batu bolong)/i, replyMatch: /(komodo|batu bolong)/i },
  { text: "What dive site has strong currents in my notes?", sourceMatch: /(komodo|batu bolong|currents)/i, replyMatch: /(komodo|batu bolong)/i },
  // Coffee (3)
  { text: "What coffee am I drinking right now?", sourceMatch: /(onyx|monarch|ethiopian|peach)/i, replyMatch: /(onyx|monarch|ethiopian|peach)/i },
  { text: "What's my V60 recipe?", sourceMatch: /(18g|300g|3:30)/i, replyMatch: /(18g|300g|3:30)/i },
  { text: "Tell me about my coffee beans.", sourceMatch: /(onyx|monarch|ethiopian|fruity|peach)/i, replyMatch: /(onyx|monarch|ethiopian|fruity|peach)/i },
  // Cross-source / sessions (4)
  { text: "Have we talked about ramen before?", sourceMatch: /(hakataya|fortitude|ramen)/i, replyMatch: /(hakataya|fortitude|ramen)/i },
  { text: "What did you suggest for breakfast in Brisbane?", sourceMatch: /(sourced grocer|newstead|sourdough)/i, replyMatch: /(sourced grocer|newstead|sourdough)/i },
  { text: "Where should I get coffee for breakfast in Brisbane?", sourceMatch: /(sourced grocer|newstead|batch brew)/i, replyMatch: /(sourced grocer|newstead|batch brew|sourdough)/i },
  { text: "Did we discuss any cafés before?", sourceMatch: /(sourced grocer|newstead)/i, replyMatch: /(sourced grocer|newstead)/i },
  // Topical / synthesis (4)
  { text: "What do my notes say about Australia?", sourceMatch: /(brisbane|cairns|mallards|petrichor)/i, replyMatch: /(brisbane|cairns|mallards|petrichor)/i },
  { text: "Where have I been diving?", sourceMatch: /(norman reef|tulamben|komodo)/i, replyMatch: /(norman reef|tulamben|komodo|bali|cairns)/i },
  { text: "What did I write about food in Brisbane?", sourceMatch: /(ramen|hakataya|fortitude)/i, replyMatch: /(ramen|hakataya|fortitude)/i },
  { text: "Find anything I have on weather.", sourceMatch: /(humid|monsoon|rain|petrichor)/i, replyMatch: /(humid|monsoon|rain|petrichor)/i },
  // Edge: should still retrieve
  { text: "What animals do I have notes about?", sourceMatch: /(ducks|mallards|wood ducks)/i, replyMatch: /(ducks?)/i },
  { text: "What did I write about word origins?", sourceMatch: /(petrichor|petros|ichor)/i, replyMatch: /(petrichor|greek|stone|ichor)/i },
];

const RETRIEVAL_TOOLS = new Set(["search_corpus"]);

describe("rag", () => {
  beforeAll(async () => { ws = await Workspace.create("rag"); });
  afterAll(async () => { await ws.cleanup(); });

  it("setup: corpus seeded and indexed", async () => {
    await seedCorpus(ws);
    await getModel();
    const embeddingModel = await discoverEmbeddingModel(BASE_URL, API_KEY);
    assert(embeddingModel != null, "no embedding model loaded — load nomic-embed in LM Studio");
    embedder = new EmbeddingClient({ baseURL: BASE_URL, apiKey: API_KEY, model: embeddingModel });
    store = new IndexStore(ws.path("index.sqlite"));
    const r = await indexAll({ store, embedder, notesRoot: ws.path("notes"), sessionsRoot: ws.path("sessions") });
    assert(r.chunksAdded > 0, `no chunks indexed: ${JSON.stringify(r)}`);
    return { detail: `${r.notesIndexed} notes, ${r.sessionsIndexed} sessions, ${r.chunksAdded} chunks` };
  }, { needsModel: true });

  scenario("retrieve + incorporate (≥24/30)", {
    threshold: [24, RAG_PROMPTS.length],
    prompts: RAG_PROMPTS.map((p) => p.text),
    judge: async ({ prompt, index }) => {
      assert(store && embedder, "rag setup did not run");
      const model = await getModel();
      const p = RAG_PROMPTS[index]!;
      const { assistant, context } = newRagAssistant(model, store!, embedder!);
      const r = await assistant.chat(p.text, { temperature: 0.2, maxTokens: 200 });
      const calls = observedCallsInLastTurn(context);
      const retrieval = calls.filter((c) => RETRIEVAL_TOOLS.has(c.name));
      const retrievedHit = retrieval.some((c) => p.sourceMatch.test(c.result));
      const replyHit = p.replyMatch.test(r.reply);
      const tools = calls.map((c) => c.name).join(",") || "(none)";
      assert(retrieval.length > 0, `no retrieval call (tools=${tools})`);
      assert(retrievedHit, `retrieved chunks lacked expected content (tools=${tools})`);
      assert(replyHit, `reply did not incorporate retrieved content (tools=${tools})`);
      return { detail: `tools=[${tools}]` };
    },
  });
});
