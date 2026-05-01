import type { EmbeddingConfig } from "./config.js";
import type { VaultDatabase } from "./database.js";
import { requestJson } from "./http-json.js";

export class EmbeddingClient {
  constructor(private readonly config: EmbeddingConfig) {}

  get enabled(): boolean {
    return Boolean(this.config.enabled && this.config.baseUrl && this.config.model);
  }

  get provider(): string {
    return this.config.provider;
  }

  get model(): string {
    return this.config.model ?? "";
  }

  async embed(input: string[]): Promise<number[][]> {
    if (!this.enabled || !this.config.baseUrl || !this.config.model) {
      throw new Error("Embeddings are disabled or incomplete.");
    }
    const response = await requestJson<{ data?: Array<{ embedding?: number[] }>; error?: { message?: string } }>(
      new URL("embeddings", ensureTrailingSlash(this.config.baseUrl)),
      {
      headers: {
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {})
      },
      body: {
        model: this.config.model,
        input
      }
      }
    );

    const payload = response.body;
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `Embedding request failed with ${response.status}`);
    }
    const vectors = payload.data?.map((item) => item.embedding).filter((item): item is number[] => Array.isArray(item));
    if (!vectors || vectors.length !== input.length) {
      throw new Error("Embedding provider returned an unexpected response.");
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
  const vectors = await client.embed(chunks.map((chunk) => chunk.content));
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
