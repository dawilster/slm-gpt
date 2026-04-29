/**
 * Embeddings — thin client over an OpenAI-compatible /v1/embeddings endpoint.
 *
 * Used at v6 for RAG. LM Studio already serves text-embedding-nomic-embed-text-v1.5
 * (768-dim) alongside the chat model — same host, same auth, no new infra.
 *
 * Vectors are returned as Float32Array because (a) we'll dot-product thousands
 * of them at query time and Float32 ops are faster, and (b) sqlite stores them
 * as raw bytes via .buffer.
 *
 * **Nomic prefix quirk** (v6 hard-won finding): nomic-embed-text-v1.5 is
 * instruction-tuned and expects task-specific prefixes:
 *   - "search_document: " for indexed corpus content
 *   - "search_query: " for queries
 * Without these, similarity scores collapse to ~0.05–0.15 even for content
 * that should match obviously. The first v6 eval run hit 2/30 with no
 * prefixes; adding them fixed the retrieval. We auto-detect "nomic" in the
 * model id and apply prefixes; other models pass through unchanged.
 */

import OpenAI from "openai";

export type EmbeddingClientOpts = {
  baseURL: string;
  apiKey: string;
  model: string;
};

export class EmbeddingClient {
  private client: OpenAI;
  readonly model: string;
  private readonly needsPrefix: boolean;
  /** Set after the first call so callers can size storage. */
  private _dim = 0;

  constructor(opts: EmbeddingClientOpts) {
    this.client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey });
    this.model = opts.model;
    this.needsPrefix = opts.model.toLowerCase().includes("nomic");
  }

  get dim(): number {
    return this._dim;
  }

  /** Embed a query (the user's question / search term). */
  async embed(text: string): Promise<Float32Array> {
    return this.embedOne(this.applyPrefix(text, "query"));
  }

  /** Embed indexed-corpus content. Prefer over embed(...) at index time. */
  async embedDocument(text: string): Promise<Float32Array> {
    return this.embedOne(this.applyPrefix(text, "document"));
  }

  /** Batch embed documents. Cheaper for bulk indexing. */
  async embedMany(texts: string[], kind: "query" | "document" = "document"): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const prefixed = texts.map((t) => this.applyPrefix(t, kind));
    // encoding_format: "float" is critical here — the OpenAI SDK defaults to
    // base64 for bandwidth, but LM Studio's compat layer doesn't round-trip
    // base64 cleanly: vectors come back as zero-filled arrays of the wrong
    // length (192 instead of 768). Forcing "float" yields proper JSON arrays.
    const resp = await this.client.embeddings.create({
      model: this.model,
      input: prefixed,
      encoding_format: "float",
    });
    const out = resp.data
      .sort((a, b) => a.index - b.index)
      .map((d) => normalize(Float32Array.from(d.embedding as number[])));
    if (this._dim === 0 && out[0]) this._dim = out[0].length;
    return out;
  }

  private async embedOne(text: string): Promise<Float32Array> {
    const resp = await this.client.embeddings.create({
      model: this.model,
      input: text,
      encoding_format: "float",
    });
    const vec = resp.data[0]?.embedding as number[] | undefined;
    if (!vec) throw new Error("embedding response had no vector");
    const out = normalize(Float32Array.from(vec));
    if (this._dim === 0) this._dim = out.length;
    return out;
  }

  private applyPrefix(text: string, kind: "query" | "document"): string {
    if (!this.needsPrefix) return text;
    return kind === "query" ? `search_query: ${text}` : `search_document: ${text}`;
  }
}

/** Pre-normalize so cosine similarity is just a dot product. */
function normalize(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) sumSq += v[i]! * v[i]!;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

/** Cosine similarity between two pre-normalized vectors. */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/** Discover the first embedding model exposed at the endpoint. */
export async function discoverEmbeddingModel(baseURL: string, apiKey: string): Promise<string | null> {
  const client = new OpenAI({ baseURL, apiKey });
  const list = await client.models.list();
  const emb = list.data.find((m) => m.id.toLowerCase().includes("embed"));
  return emb?.id ?? null;
}
