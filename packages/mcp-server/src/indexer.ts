import type { PruneEmbeddingsResult } from "@obsidian-mcp/shared";
import type { BridgeClient } from "./bridge-client.js";
import type { VaultDatabase } from "./database.js";
import { backfillEmbeddings, type EmbeddingClient } from "./embeddings.js";

export interface RefreshResult {
  indexedNotes: number;
  embeddingChunks: number;
  maintenance?: {
    prunedEmbeddings: number;
    orphanedEmbeddingsRemaining: number;
    estimatedBytesFreed: number;
    summary: string;
  };
}

export interface IndexerStatus {
  indexing: boolean;
  lastError: string | null;
  lastResult: RefreshResult | null;
}

export class VaultIndexer {
  private refreshInFlight: Promise<RefreshResult> | null = null;
  private lastError: string | null = null;
  private lastResult: RefreshResult | null = null;

  constructor(
    private readonly bridge: BridgeClient,
    private readonly db: VaultDatabase,
    private readonly embeddings: EmbeddingClient,
    private readonly autoPruneEmbeddings = true
  ) {}

  async refresh(): Promise<RefreshResult> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.runRefresh();
    try {
      const result = await this.refreshInFlight;
      this.lastResult = result;
      this.lastError = null;
      return result;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.refreshInFlight = null;
    }
  }

  startBackgroundRefresh(): void {
    void this.refresh().catch(() => {
      // The error is retained in status so MCP clients can surface it without crashing startup.
    });
  }

  async refreshIfEmpty(): Promise<RefreshResult | null> {
    if (this.db.stats().noteCount > 0) {
      return null;
    }
    return this.refresh();
  }

  status(): IndexerStatus {
    return {
      indexing: this.refreshInFlight !== null,
      lastError: this.lastError,
      lastResult: this.lastResult
    };
  }

  private async runRefresh(): Promise<RefreshResult> {
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

    const maintenance = this.autoPruneEmbeddings ? formatMaintenance(this.db.pruneOrphanedEmbeddings()) : undefined;
    return {
      indexedNotes: notes.length,
      embeddingChunks,
      maintenance
    };
  }
}

function formatMaintenance(result: PruneEmbeddingsResult): RefreshResult["maintenance"] {
  return {
    prunedEmbeddings: result.deletedEmbeddings,
    orphanedEmbeddingsRemaining: result.orphanedAfterCount,
    estimatedBytesFreed: result.estimatedBytesFreed,
    summary:
      result.deletedEmbeddings > 0
        ? `Pruned ${result.deletedEmbeddings} orphaned embedding vector(s).`
        : "No orphaned embedding vectors to prune."
  };
}
