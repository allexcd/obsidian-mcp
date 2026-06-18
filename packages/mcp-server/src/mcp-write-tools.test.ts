import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WriteNoteResponse } from "@obsidian-mcp/shared";
import type { McpRuntime } from "./mcp.js";
import { startMcpServer } from "./mcp.js";

type ToolConfig = { title?: string; description?: string; inputSchema?: Record<string, unknown> };
type ToolHandler = (input: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

const sdkMock = vi.hoisted(() => {
  const registeredTools = new Map<
    string,
    {
      config: ToolConfig;
      handler: ToolHandler;
    }
  >();
  const connect = vi.fn(() => Promise.resolve());

  return {
    registeredTools,
    connect,
    McpServer: vi.fn().mockImplementation(function () {
      return {
        registerTool: vi.fn((name: string, config: ToolConfig, handler: ToolHandler) => {
          registeredTools.set(name, { config, handler });
        }),
        connect
      };
    }),
    StdioServerTransport: vi.fn()
  };
});

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: sdkMock.McpServer
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: sdkMock.StdioServerTransport
}));

describe("MCP write tools", () => {
  beforeEach(() => {
    sdkMock.registeredTools.clear();
    sdkMock.connect.mockClear();
    sdkMock.McpServer.mockClear();
    sdkMock.StdioServerTransport.mockClear();
  });

  it("registers separate write tools with focused tool schemas", async () => {
    await startMcpServer(createRuntime());

    expect(Array.from(sdkMock.registeredTools.keys())).toEqual(
      expect.arrayContaining(["create_note", "append_note", "replace_note_text", "delete_note_text", "rewrite_note"])
    );
    expect(sdkMock.registeredTools.get("replace_note_text")?.config.inputSchema).toHaveProperty("oldText");
    expect(sdkMock.registeredTools.get("replace_note_text")?.config.inputSchema).toHaveProperty("newText");
    expect(sdkMock.registeredTools.get("delete_note_text")?.config.inputSchema).toHaveProperty("text");
    expect(sdkMock.registeredTools.get("create_note")?.config.inputSchema).toHaveProperty("overwrite");
  });

  it("create_note calls the bridge, then updates the local index", async () => {
    const runtime = createRuntime();
    await startMcpServer(runtime);

    const tool = sdkMock.registeredTools.get("create_note");
    if (!tool) {
      throw new Error("create_note was not registered");
    }
    const result = await tool.handler({ path: "Notes/New.md", content: "# New", overwrite: false });
    const parsed = JSON.parse(result.content[0]!.text) as WriteNoteResponse & {
      index: { noteCount: number };
      maintenance?: { summary: string };
    };

    expect(mockCalls(runtime.bridge, "createNote")).toEqual([["Notes/New.md", "# New", false]]);
    expect(mockCalls(runtime.db, "upsertNote")[0]?.[0]).toEqual(expect.objectContaining({ path: "Notes/New.md", content: "# New" }));
    expect(mockCalls(runtime.db, "pruneOrphanedEmbeddings")).toHaveLength(1);
    expect(parsed.operation).toBe("create");
    expect(parsed.index.noteCount).toBe(1);
    expect(parsed.maintenance?.summary).toContain("No orphaned");
  });

  it("replace_note_text preserves occurrenceIndex and returns an embedding refresh hint", async () => {
    const runtime = createRuntime({ embeddingsEnabled: true });
    await startMcpServer(runtime);

    const tool = sdkMock.registeredTools.get("replace_note_text");
    if (!tool) {
      throw new Error("replace_note_text was not registered");
    }
    const result = await tool.handler({ path: "Notes/New.md", oldText: "old", newText: "new", occurrenceIndex: 1 });
    const parsed = JSON.parse(result.content[0]!.text) as WriteNoteResponse & { hint?: string };

    expect(mockCalls(runtime.bridge, "replaceNoteText")).toEqual([["Notes/New.md", "old", "new", 1]]);
    expect(mockCalls(runtime.db, "upsertNote").length).toBeGreaterThan(0);
    expect(parsed.hint).toContain("refresh_index");
  });

  it("registers prune_embeddings and returns cleanup counts", async () => {
    const runtime = createRuntime({ orphanedEmbeddings: 2 });
    await startMcpServer(runtime);

    const tool = sdkMock.registeredTools.get("prune_embeddings");
    if (!tool) {
      throw new Error("prune_embeddings was not registered");
    }
    const result = await tool.handler({});
    const parsed = JSON.parse(result.content[0]!.text) as { maintenance: { prunedEmbeddings: number }; index: { orphanedEmbeddingCount: number } };

    expect(mockCalls(runtime.db, "pruneOrphanedEmbeddings")).toHaveLength(1);
    expect(parsed.maintenance.prunedEmbeddings).toBe(2);
    expect(parsed.index.orphanedEmbeddingCount).toBe(0);
  });
});

function createRuntime(options: { embeddingsEnabled?: boolean; orphanedEmbeddings?: number } = {}): McpRuntime {
  const embeddingsEnabled = options.embeddingsEnabled ?? false;
  let orphanedEmbeddings = options.orphanedEmbeddings ?? 0;
  const note = createWrittenNote("Notes/New.md", "# New");
  const configDir = [".", "obsidian"].join("");
  return {
    config: {
      bridgeUrl: "http://127.0.0.1:27125",
      token: "token",
      dbPath: "/tmp/index.sqlite",
      dbPathSource: "env",
      maxResults: 20,
      autoIndex: false,
      autoPruneEmbeddings: true,
      autoPruneEmbeddingsSource: "bridge",
      embeddings: {
        enabled: embeddingsEnabled,
        baseUrl: embeddingsEnabled ? "http://127.0.0.1:1234/v1" : null,
        apiKey: null,
        model: embeddingsEnabled ? "local-embedding" : null,
        provider: "openai-compatible"
      }
    },
    bridge: {
      status: vi.fn(() =>
        Promise.resolve({
          ok: true,
          vaultName: "Test Vault",
          pluginVersion: "0.4.3",
          bridgeVersion: "0.4.3",
          readOnly: false,
          writeToolsEnabled: true,
          autoPruneEmbeddings: true,
          pluginDirectory: {
            vaultPath: `${configDir}/plugins/mcp-vault-bridge`,
            filesystemPath: `/vault/${configDir}/plugins/mcp-vault-bridge`,
            defaultDatabasePath: `/vault/${configDir}/plugins/mcp-vault-bridge/index.sqlite`
          },
          scope: { excludedFolders: [], excludedFiles: [], excludedTags: [] },
          vaultPreview: {
            detectedFolders: [],
            detectedFiles: [],
            detectedTags: [],
            includedNoteCount: 1,
            excludedNoteCount: 0
          },
          includedNoteCount: 1,
          maxNoteBytes: 120000,
          auditEnabled: true
        })
      ),
      createNote: vi.fn(() => Promise.resolve({ operation: "create", note })),
      appendNote: vi.fn(() => Promise.resolve({ operation: "append", note })),
      replaceNoteText: vi.fn(() => Promise.resolve({ operation: "replace", note })),
      deleteNoteText: vi.fn(() => Promise.resolve({ operation: "delete_text", note })),
      rewriteNote: vi.fn(() => Promise.resolve({ operation: "rewrite", note }))
    } as unknown as McpRuntime["bridge"],
    db: {
      stats: vi.fn(() => ({
        noteCount: 1,
        chunkCount: 1,
        embeddingCount: orphanedEmbeddings,
        orphanedEmbeddingCount: orphanedEmbeddings,
        lastIndexedAt: "2026-01-01T00:00:00.000Z"
      })),
      upsertNote: vi.fn(),
      pruneOrphanedEmbeddings: vi.fn(() => {
        const deletedEmbeddings = orphanedEmbeddings;
        orphanedEmbeddings = 0;
        return {
          beforeCount: deletedEmbeddings,
          afterCount: 0,
          orphanedBeforeCount: deletedEmbeddings,
          orphanedAfterCount: 0,
          deletedEmbeddings,
          estimatedBytesFreed: deletedEmbeddings * 128
        };
      })
    } as unknown as McpRuntime["db"],
    embeddings: {
      enabled: embeddingsEnabled,
      provider: "openai-compatible",
      model: embeddingsEnabled ? "local-embedding" : ""
    } as unknown as McpRuntime["embeddings"],
    indexer: {
      status: vi.fn(() => ({ indexing: false, lastError: null, lastResult: null }))
    } as unknown as McpRuntime["indexer"]
  };
}

function createWrittenNote(path: string, content: string): WriteNoteResponse["note"] {
  return {
    path,
    title: "New",
    mtime: 1,
    size: content.length,
    tags: [],
    aliases: [],
    frontmatter: {},
    content,
    truncated: false,
    metadata: {
      path,
      title: "New",
      basename: "New",
      extension: "md",
      stat: {
        ctime: 1,
        mtime: 1,
        size: content.length
      },
      frontmatter: {},
      tags: [],
      aliases: [],
      outlinks: [],
      embeds: [],
      backlinks: []
    }
  };
}

function mockCalls<T extends object>(object: T, key: keyof T): unknown[][] {
  return (object[key] as { mock: { calls: unknown[][] } }).mock.calls;
}
