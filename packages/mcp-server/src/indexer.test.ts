import { describe, expect, it, vi } from "vitest";
import type { VaultNote } from "@obsidian-mcp/shared";
import type { BridgeClient } from "./bridge-client.js";
import type { IndexStats, VaultDatabase } from "./database.js";
import type { EmbeddingClient } from "./embeddings.js";
import { VaultIndexer } from "./indexer.js";

const sampleNote: VaultNote = {
  path: "Notes/Test.md",
  title: "Test",
  content: "# Test",
  mtime: 1,
  size: 6,
  tags: [],
  aliases: [],
  frontmatter: {},
  truncated: false,
  metadata: {
    path: "Notes/Test.md",
    title: "Test",
    basename: "Test",
    extension: "md",
    stat: {
      ctime: 1,
      mtime: 1,
      size: 6
    },
    frontmatter: {},
    tags: [],
    aliases: [],
    outlinks: [],
    embeds: [],
    backlinks: []
  }
};

describe("VaultIndexer", () => {
  it("refreshes an empty index on demand", async () => {
    let noteCount = 0;
    const bridge = createBridge();
    const db = createDb(() => noteCount, (notes) => {
      noteCount = notes.length;
    });
    const indexer = new VaultIndexer(bridge, db, createEmbeddings());

    const result = await indexer.refreshIfEmpty();

    expect(result).toEqual({ indexedNotes: 1, embeddingChunks: 0 });
    expect(bridge.exportNotes).toHaveBeenCalledOnce();
    expect(indexer.status()).toMatchObject({ indexing: false, lastError: null });
  });

  it("does not refresh a non-empty index from refreshIfEmpty", async () => {
    const bridge = createBridge();
    const indexer = new VaultIndexer(bridge, createDb(() => 1), createEmbeddings());

    const result = await indexer.refreshIfEmpty();

    expect(result).toBeNull();
    expect(bridge.exportNotes).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent refreshes", async () => {
    const bridge = createBridge();
    const indexer = new VaultIndexer(bridge, createDb(() => 0), createEmbeddings());

    const [left, right] = await Promise.all([indexer.refresh(), indexer.refresh()]);

    expect(left).toEqual(right);
    expect(bridge.exportNotes).toHaveBeenCalledOnce();
  });
});

function createBridge(): BridgeClient {
  return {
    exportNotes: vi.fn(async () => ({ notes: [sampleNote], nextOffset: null }))
  } as unknown as BridgeClient;
}

function createDb(getNoteCount: () => number, onReplace: (notes: VaultNote[]) => void = () => undefined): VaultDatabase {
  return {
    stats: (): IndexStats => ({
      noteCount: getNoteCount(),
      chunkCount: getNoteCount(),
      embeddingCount: 0,
      lastIndexedAt: getNoteCount() > 0 ? "2026-01-01T00:00:00.000Z" : null
    }),
    replaceNotes: vi.fn(onReplace)
  } as unknown as VaultDatabase;
}

function createEmbeddings(): EmbeddingClient {
  return {
    enabled: false
  } as EmbeddingClient;
}
