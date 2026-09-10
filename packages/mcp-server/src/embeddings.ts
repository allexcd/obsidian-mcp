import { sha256 } from "./hash.js";
import type { EmbeddingConfig } from "./config.js";
import type { VaultDatabase } from "./database.js";
import { requestJson } from "./http-json.js";

export class EmbeddingClient {
  constructor(private readonly config: EmbeddingConfig) {}

  get configurationError(): string | null {
    return this.config.enabled && (!this.config.baseUrl || !this.config.model)
      ? "An embedding endpoint and model identifier are required for search by meaning." : null;
  }

  get enabled(): boolean {
    return Boolean(this.config.enabled && this.config.baseUrl && this.config.model);
  }

  get provider(): string {
    return `${this.config.provider}:${sha256(JSON.stringify([this.config.baseUrl?.replace(/\/+$/, ""), this.config.model, this.prefix("query"), this.prefix("document"), "embedding-v2"]))}`;
  }

  get model(): string {
    return this.config.model ?? "";
  }

  private prefix(kind: "query" | "document"): string {
    const configured = kind === "query" ? this.config.queryPrefix : this.config.documentPrefix;
    return configured ?? (this.model.includes("nomic-embed-text") ? `search_${kind}: ` : "");
  }

  async embed(input: string[], kind: "query" | "document" = "query"): Promise<number[][]> {
    if (!this.enabled || !this.config.baseUrl || !this.config.model) {
      throw new Error("Embeddings are disabled or incomplete.");
    }
    const response = await requestJson<{ data?: Array<{ embedding?: number[]; index?: number }>; error?: { message?: string } }>(
      new URL("embeddings", ensureTrailingSlash(this.config.baseUrl)),
      {
      headers: {
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {})
      },
      body: {
        model: this.config.model,
        input: input.map(text => this.prefix(kind) + text)
      }
      }
    );

    const payload = response.body;
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `Embedding request failed with ${response.status}`);
    }
    const data = payload.data;
    if (!data || data.length !== input.length) throw new Error("Embedding provider returned an unexpected response.");
    const indexed = data.some(item => item.index !== undefined);
    if (indexed && (data.some(item => !Number.isInteger(item.index) || item.index! < 0 || item.index! >= input.length) || new Set(data.map(item => item.index)).size !== input.length)) {
      throw new Error("Embedding provider returned invalid response indexes.");
    }
    const vectors = (indexed ? [...data].sort((a, b) => a.index! - b.index!) : data).map(item => item.embedding);
    const dimension = vectors[0]?.length ?? 0;
    if (!dimension || !vectors.every((vector): vector is number[] => Array.isArray(vector) && vector.length === dimension && vector.every(Number.isFinite) && vector.some(value => value !== 0))) {
      throw new Error("Embedding provider returned invalid or inconsistent vectors.");
    }
    return vectors;
  }
}

export async function backfillEmbeddings(db: VaultDatabase, client: EmbeddingClient, batchSize = 32): Promise<number> {
  if (!client.enabled) {
    return 0;
  }
  const chunks = db.chunksMissingEmbeddings(client.provider, client.model, batchSize);
  if (chunks.length === 0) {
    return 0;
  }
  const vectors = await client.embed(chunks.map((chunk) => chunk.content), "document");
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const vector = vectors[i];
    if (chunk && vector) {
      db.upsertEmbedding(chunk.contentHash, client.provider, client.model, vector);
    }
  }
  return chunks.length;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}
