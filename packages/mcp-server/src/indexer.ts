import type { BridgeClient } from "./bridge-client.js";
import type { VaultDatabase } from "./database.js";
import { backfillEmbeddings, type EmbeddingClient } from "./embeddings.js";

export interface RefreshResult {
  indexedNotes: number;
  embeddingChunks: number;
}

export class VaultIndexer {
  constructor(
    private readonly bridge: BridgeClient,
    private readonly db: VaultDatabase,
    private readonly embeddings: EmbeddingClient
  ) {}

  async refresh(): Promise<RefreshResult> {
    const notes = [];
    let offset = 0;
    const limit = 50;
    while (true) {
      const response = await this.bridge.exportNotes(limit, offset);
      notes.push(...response.notes);
      if (response.nextOffset === null) {
        break;
      }
      offset = response.nextOffset;
    }
    this.db.replaceNotes(notes);

    let embeddingChunks = 0;
    while (this.embeddings.enabled) {
      const indexed = await backfillEmbeddings(this.db, this.embeddings);
      embeddingChunks += indexed;
      if (indexed === 0) {
        break;
      }
    }

    return {
      indexedNotes: notes.length,
      embeddingChunks
    };
  }
}

