import { setInterval, clearInterval, setTimeout } from "node:timers";
import type { BridgeSync, PruneEmbeddingsResult } from "@obsidian-mcp/shared";
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

export class VaultIndexer {
  private refreshInFlight: Promise<RefreshResult> | null = null;
  private embeddingInFlight = false;
  private lastError: string | null = null;
  private embeddingError: string | null = null;
  private lastResult: RefreshResult | null = null;
  private cursor: BridgeSync | null = null;
  private lastSyncedAt: string | null = null;
  private pending = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly bridge: BridgeClient,
    private readonly db: VaultDatabase,
    private readonly embeddings: EmbeddingClient,
    private readonly autoPruneEmbeddings = true
  ) {}

  async verifyAccess(): Promise<void> {
    const snapshot = await this.bridge.sync();
    this.db.retainAllowed(snapshot.allowedPaths);
  }

  async refresh(): Promise<RefreshResult> {
    const result = await this.synchronize(true);
    void this.updateEmbeddings();
    return result;
  }

  async synchronize(full = false): Promise<RefreshResult> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    this.refreshInFlight = this.db.withSyncLock(() => this.runRefresh(full));
    try {
      void this.bridge.report(this.status()).catch(() => undefined);
      const result = await this.refreshInFlight;
      this.lastResult = result;
      this.lastError = null;
      this.lastSyncedAt = new Date().toISOString();
      return result;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot synchronize or verify vault access. Keep Obsidian open and check the bridge connection. ${this.lastError}`);
    } finally {
      this.refreshInFlight = null;
      void this.bridge.report(this.status()).catch(() => undefined);
    }
  }

  startBackgroundRefresh(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.refreshInFlight) return;
      void this.synchronize().then(() => this.updateEmbeddings()).catch(() => undefined);
    };
    tick();
    this.timer = setInterval(tick, 2000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refreshIfEmpty(): Promise<RefreshResult | null> {
    return this.db.stats().noteCount === 0 ? this.refresh() : null;
  }

  status() {
    return {
      indexing: this.refreshInFlight !== null,
      lastError: this.lastError,
      lastResult: this.lastResult,
      lastSyncedAt: this.lastSyncedAt,
      pending: this.pending,
      embeddingError: this.embeddingError ?? this.embeddings.configurationError,
      searchState: this.embeddings.configurationError ? "Semantic search unavailable—using standard search" : !this.embeddings.enabled ? "Standard search" : this.embeddingError
        ? "Semantic search unavailable—using standard search" : this.embeddingInFlight || this.db.chunksMissingEmbeddings(this.embeddings.provider, this.embeddings.model, 1).length > 0
          ? "Building semantic index" : "Semantic search ready"
    };
  }

  private async runRefresh(full: boolean): Promise<RefreshResult> {
    const snapshot = await this.bridge.sync(this.cursor?.epoch, this.cursor?.revision);
    this.db.retainAllowed(snapshot.allowedPaths);
    const rebuild = full || !this.cursor || snapshot.reset || snapshot.policyRevision !== this.cursor.policyRevision || snapshot.refreshRequest !== this.cursor.refreshRequest || snapshot.paths.includes("");
    let count = 0;
    if (rebuild) {
      const notes = [];
      let offset = 0;
      while (offset >= 0) {
        const response = await this.bridge.exportNotes(50, offset);
        notes.push(...response.notes);
        this.pending = Math.max(0, snapshot.allowedPaths.length - notes.length);
        await this.bridge.report(this.status());
        if (response.nextOffset === null) break;
        offset = response.nextOffset;
      }
      // Never commit a paged snapshot spanning a policy or vault change.
      const after = await this.bridge.sync(snapshot.epoch, snapshot.revision);
      if (after.policyRevision !== snapshot.policyRevision || after.revision !== snapshot.revision || after.epoch !== snapshot.epoch) {
        this.cursor = null;
        throw new Error("Vault changed during reconciliation; synchronization will retry.");
      }
      this.db.replaceNotes(notes);
      count = notes.length;
    } else {
      const allowed = new Set(snapshot.allowedPaths);
      this.pending = snapshot.paths.length;
      for (const path of snapshot.paths) {
        if (allowed.has(path)) this.db.upsertNote(await this.bridge.readNote(path));
        else this.db.deleteNote(path);
        this.pending -= 1;
        count += 1;
      }
    }
    this.cursor = snapshot;
    this.pending = 0;
    return {
      indexedNotes: count, embeddingChunks: 0,
      maintenance: this.autoPruneEmbeddings ? formatMaintenance(this.db.pruneOrphanedEmbeddings()) : undefined
    };
  }

  private async updateEmbeddings(): Promise<void> {
    if (!this.embeddings.enabled || this.embeddingInFlight) return;
    this.embeddingInFlight = true;
    try {
      // One batch per tick keeps maintenance bounded and text synchronization responsive.
      await this.db.withSyncLock(async () => {
        const snapshot = await this.bridge.sync();
        this.db.retainAllowed(snapshot.allowedPaths);
        const chunks = this.db.chunksMissingEmbeddings(this.embeddings.provider, this.embeddings.model, 32);
        const paths = [...new Set(chunks.map(chunk => chunk.path))];
        const allowed = new Set(await this.bridge.authorize(paths));
        for (const path of paths) if (!allowed.has(path)) this.db.deleteNote(path);
        await backfillEmbeddings(this.db, this.embeddings);
      }, 2);
      this.embeddingError = null;
      if (this.db.chunksMissingEmbeddings(this.embeddings.provider, this.embeddings.model, 1).length) {
        const next = setTimeout(() => { void this.updateEmbeddings(); }, 2000);
        next.unref();
      }
    } catch (error) {
      this.embeddingError = error instanceof Error ? error.message : String(error);
    } finally {
      this.embeddingInFlight = false;
      await this.bridge.report(this.status()).catch(() => undefined);
    }
  }
}

function formatMaintenance(result: PruneEmbeddingsResult): RefreshResult["maintenance"] {
  return {
    prunedEmbeddings: result.deletedEmbeddings,
    orphanedEmbeddingsRemaining: result.orphanedAfterCount,
    estimatedBytesFreed: result.estimatedBytesFreed,
    summary: result.deletedEmbeddings > 0 ? `Pruned ${result.deletedEmbeddings} orphaned embedding vector(s).` : "No orphaned embedding vectors to prune."
  };
}
