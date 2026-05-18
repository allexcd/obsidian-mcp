import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WriteNoteResponse } from "@obsidian-mcp/shared";
import type { McpRuntime } from "./mcp.js";
import { startMcpServer } from "./mcp.js";

const sdkMock = vi.hoisted(() => {
  const registeredTools = new Map<
    string,
    {
      config: { title?: string; description?: string; inputSchema?: Record<string, unknown> };
      handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
    }
  >();
  const connect = vi.fn(() => Promise.resolve());

  return {
    registeredTools,
    connect,
    McpServer: vi.fn().mockImplementation(() => ({
      registerTool: vi.fn((name, config, handler) => {
        registeredTools.set(name, { config, handler });
      }),
      connect
    })),
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
    const parsed = JSON.parse(result.content[0]!.text) as WriteNoteResponse & { index: { noteCount: number } };

    expect(runtime.bridge.createNote).toHaveBeenCalledWith("Notes/New.md", "# New", false);
    expect(runtime.db.upsertNote).toHaveBeenCalledWith(expect.objectContaining({ path: "Notes/New.md", content: "# New" }));
    expect(parsed.operation).toBe("create");
    expect(parsed.index.noteCount).toBe(1);
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

    expect(runtime.bridge.replaceNoteText).toHaveBeenCalledWith("Notes/New.md", "old", "new", 1);
    expect(runtime.db.upsertNote).toHaveBeenCalled();
    expect(parsed.hint).toContain("refresh_index");
  });
});

function createRuntime(options: { embeddingsEnabled?: boolean } = {}): McpRuntime {
  const embeddingsEnabled = options.embeddingsEnabled ?? false;
  const note = createWrittenNote("Notes/New.md", "# New");
  return {
    config: {
      bridgeUrl: "http://127.0.0.1:27125",
      token: "token",
      dbPath: "/tmp/index.sqlite",
      dbPathSource: "env",
      maxResults: 20,
      autoIndex: false,
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
          pluginDirectory: {
            vaultPath: ".obsidian/plugins/mcp-vault-bridge",
            filesystemPath: "/vault/.obsidian/plugins/mcp-vault-bridge",
            defaultDatabasePath: "/vault/.obsidian/plugins/mcp-vault-bridge/index.sqlite"
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
        embeddingCount: embeddingsEnabled ? 0 : 0,
        lastIndexedAt: "2026-01-01T00:00:00.000Z"
      })),
      upsertNote: vi.fn()
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
