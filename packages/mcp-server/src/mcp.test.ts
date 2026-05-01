import { describe, expect, it, vi } from "vitest";
import type { SearchResult } from "@obsidian-mcp/shared";
import type { IndexedNote, IndexStats } from "./database.js";
import type { McpRuntime } from "./mcp.js";
import { retrieveVaultQuestion } from "./mcp.js";

const indexStats: IndexStats = {
  noteCount: 2,
  chunkCount: 4,
  embeddingCount: 4,
  lastIndexedAt: "2026-01-01T00:00:00.000Z"
};

const lexicalResult: SearchResult = {
  path: "Notes/Lexical.md",
  title: "Lexical",
  mtime: 1,
  tags: ["search"],
  score: 0.2,
  snippet: "Exact words matched here."
};

const semanticResult: SearchResult = {
  path: "Notes/Semantic.md",
  title: "Semantic",
  mtime: 2,
  tags: ["theme"],
  score: 0.9,
  snippet: "Conceptually related idea."
};

describe("retrieveVaultQuestion", () => {
  it("uses hybrid semantic retrieval when embeddings and vectors are available", async () => {
    const embed = vi.fn(() => Promise.resolve([[1, 0, 0]]));
    const semanticSearch = vi.fn(() => [semanticResult]);
    const runtime = createRuntime({
      embeddingsEnabled: true,
      stats: indexStats,
      embed,
      semanticSearch,
      searchFts: () => [lexicalResult]
    });

    const result = await retrieveVaultQuestion(runtime, "common themes", 5);

    expect(embed).toHaveBeenCalledWith(["common themes"]);
    expect(semanticSearch).toHaveBeenCalledWith([1, 0, 0], "openai-compatible", "local-embedding", 5);
    expect(result).toMatchObject({
      question: "common themes",
      retrievalMode: "hybrid",
      semanticAvailable: true,
      embeddingCount: 4
    });
    expect(result.results[0]?.path).toBe("Notes/Semantic.md");
  });

  it("does not call embeddings when enabled but no vectors are stored yet", async () => {
    const embed = vi.fn(() => Promise.resolve([[1, 0, 0]]));
    const runtime = createRuntime({
      embeddingsEnabled: true,
      stats: { ...indexStats, embeddingCount: 0 },
      embed,
      searchFts: () => [lexicalResult]
    });

    const result = await retrieveVaultQuestion(runtime, "common themes", 5);

    expect(embed).not.toHaveBeenCalled();
    expect(result.retrievalMode).toBe("lexical");
    expect(result.semanticAvailable).toBe(false);
    expect(result.hint).toContain("refresh_index");
  });

  it("falls back to indexed note metadata when embeddings and full-text matches are unavailable", async () => {
    const runtime = createRuntime({
      embeddingsEnabled: false,
      stats: indexStats,
      searchFts: () => [],
      listNotes: () => [
        {
          path: "Notes/Overview.md",
          title: "Overview",
          mtime: 3,
          size: 10,
          tags: ["overview"],
          aliases: [],
          frontmatter: {},
          outlinks: [],
          embeds: [],
          backlinks: [],
          contentHash: "hash",
          indexedAt: "2026-01-01T00:00:00.000Z"
        }
      ]
    });

    const result = await retrieveVaultQuestion(runtime, "common themes", 5);

    expect(result.retrievalMode).toBe("metadata");
    expect(result.results[0]?.path).toBe("Notes/Overview.md");
  });
});

function createRuntime(options: {
  embeddingsEnabled: boolean;
  stats: IndexStats;
  embed?: (input: string[]) => Promise<number[][]>;
  searchFts?: () => SearchResult[];
  semanticSearch?: () => SearchResult[];
  listNotes?: () => IndexedNote[];
}): McpRuntime {
  return {
    config: {
      bridgeUrl: "http://127.0.0.1:27125",
      token: "token",
      dbPath: "/tmp/index.sqlite",
      dbPathSource: "env",
      maxResults: 20,
      autoIndex: true,
      embeddings: {
        enabled: options.embeddingsEnabled,
        baseUrl: options.embeddingsEnabled ? "http://127.0.0.1:1234/v1" : null,
        apiKey: null,
        model: options.embeddingsEnabled ? "local-embedding" : null,
        provider: "openai-compatible"
      }
    },
    bridge: {} as McpRuntime["bridge"],
    db: {
      stats: () => options.stats,
      searchFts: options.searchFts ?? (() => []),
      semanticSearch: options.semanticSearch ?? (() => []),
      listNotes: options.listNotes ?? (() => [])
    } as unknown as McpRuntime["db"],
    embeddings: {
      enabled: options.embeddingsEnabled,
      provider: "openai-compatible",
      model: options.embeddingsEnabled ? "local-embedding" : "",
      embed: options.embed ?? (() => Promise.resolve([]))
    } as unknown as McpRuntime["embeddings"],
    indexer: {
      status: () => ({ indexing: false, lastError: null })
    } as unknown as McpRuntime["indexer"]
  };
}
