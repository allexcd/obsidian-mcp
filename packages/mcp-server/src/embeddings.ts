import type { EmbeddingConfig } from "./config.js";
import type { VaultDatabase } from "./database.js";

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
    const response = await fetch(new URL("embeddings", ensureTrailingSlash(this.config.baseUrl)), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: this.config.model,
        input
      })
    });

    const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }>; error?: { message?: string } };
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
