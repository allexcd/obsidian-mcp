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
      expect.arrayContaining([
        "create_note",
        "create_base_file",
        "append_note",
        "replace_note_text",
        "set_note_properties",
        "delete_note_text",
        "rewrite_note"
      ])
    );
    expect(sdkMock.registeredTools.get("replace_note_text")?.config.inputSchema).toHaveProperty("oldText");
    expect(sdkMock.registeredTools.get("replace_note_text")?.config.inputSchema).toHaveProperty("newText");
    expect(sdkMock.registeredTools.get("set_note_properties")?.config.inputSchema).toHaveProperty("properties");
    expect(sdkMock.registeredTools.get("delete_note_text")?.config.inputSchema).toHaveProperty("text");
    expect(sdkMock.registeredTools.get("create_note")?.config.inputSchema).toHaveProperty("overwrite");
    expect(sdkMock.registeredTools.get("create_base_file")?.config.inputSchema).toHaveProperty("scope");
    expect(sdkMock.registeredTools.get("create_base_file")?.config.inputSchema).toHaveProperty("filters");
    expect(sdkMock.registeredTools.get("create_base_file")?.config.inputSchema).toHaveProperty("excludePaths");
    expect(sdkMock.registeredTools.get("create_base_file")?.config.inputSchema).toHaveProperty("includeExtensions");
    expect(sdkMock.registeredTools.get("create_base_file")?.config.inputSchema).toHaveProperty("views");
    expect(sdkMock.registeredTools.get("set_note_properties")?.config.description).toContain("Obsidian Properties");
    expect(sdkMock.registeredTools.get("set_note_properties")?.config.description).toContain("tags, aliases, and cssclasses");
    expect(sdkMock.registeredTools.get("set_note_properties")?.config.description).toContain("[[Note Name]]");
    expect(sdkMock.registeredTools.get("list_notes")?.config.description).toContain("resolve user-mentioned Obsidian folders");
    expect(sdkMock.registeredTools.get("get_note_metadata")?.config.description).toContain("Use this before editing properties");
    expect(sdkMock.registeredTools.get("get_note_links")?.config.description).toContain("headings, or blocks");
    expect(sdkMock.registeredTools.get("create_base_file")?.config.description).toContain("resolve the real folder/file paths first");
    expect(sdkMock.registeredTools.get("create_base_file")?.config.description).toContain("Use scope.kind='vault' only");
    expect(sdkMock.registeredTools.get("create_base_file")?.config.description).toContain("excludePaths");
    expect(sdkMock.registeredTools.get("create_base_file")?.config.description).toContain("views[].sort");
    expect(sdkMock.registeredTools.get("create_base_file")?.config.description).toContain("preserve the requested order");
    expect(sdkMock.registeredTools.get("create_base_file")?.config.description).toContain("Does not index");
    expect(sdkMock.registeredTools.get("set_note_properties")?.config.description).toContain("template properties");
    expect(sdkMock.registeredTools.get("set_note_properties")?.config.description).toContain("flat JSON object");
    expect(sdkMock.registeredTools.get("replace_note_text")?.config.description).toContain("Preferred tool for partial body-text edits");
    expect(sdkMock.registeredTools.get("replace_note_text")?.config.description).toContain("replace a template");
    expect(sdkMock.registeredTools.get("replace_note_text")?.config.description).toContain("Do not use this tool to add or update Obsidian Properties");
    expect(sdkMock.registeredTools.get("rewrite_note")?.config.description).toContain("Last-resort whole-note replacement tool");
    expect(sdkMock.registeredTools.get("rewrite_note")?.config.description).toContain("For partial edits, use replace_note_text instead");
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

  it("create_base_file calls the bridge without updating the note index", async () => {
    const runtime = createRuntime();
    await startMcpServer(runtime);

    const tool = sdkMock.registeredTools.get("create_base_file");
    if (!tool) {
      throw new Error("create_base_file was not registered");
    }
    const result = await tool.handler({
      path: "Bases/Reading",
      scope: { kind: "folder", folder: "Reading" },
      views: [{ type: "table", name: "Table", order: ["title", "author", "url"] }]
    });
    const parsed = JSON.parse(result.content[0]!.text) as {
      operation: string;
      path: string;
      status?: string;
      completionGuidance?: { nextAction: string };
    };

    expect(mockCalls(runtime.bridge, "createBaseFile")).toEqual([
      [
        "Bases/Reading",
        {
          scope: { kind: "folder", folder: "Reading" },
          filters: undefined,
          excludePaths: undefined,
          includeExtensions: undefined,
          excludeExtensions: undefined,
          includeBaseFiles: false,
          properties: undefined,
          formulas: undefined,
          summaries: undefined,
          views: [{ type: "table", name: "Table", order: ["title", "author", "url"] }]
        },
        false,
        false
      ]
    ]);
    expect(mockCalls(runtime.db, "upsertNote")).toHaveLength(0);
    expect(parsed.operation).toBe("create_base");
    expect(parsed.path).toBe("Bases/Reading.base");
    expect(parsed.status).toBe("success");
    expect(parsed.completionGuidance?.nextAction).toContain("Answer the user now");
  });

  it("create_base_file accepts shorthand folder scope from MCP hosts", async () => {
    const runtime = createRuntime();
    await startMcpServer(runtime);

    const tool = sdkMock.registeredTools.get("create_base_file");
    if (!tool) {
      throw new Error("create_base_file was not registered");
    }
    await tool.handler({
      scope: { folder: "Articles/Science" }
    });

    expect(mockCalls(runtime.bridge, "createBaseFile")[0]?.[0]).toBeUndefined();
    expect(mockCalls(runtime.bridge, "createBaseFile")[0]?.[1]).toEqual({
      scope: { kind: "folder", folder: "Articles/Science" },
      filters: undefined,
      excludePaths: undefined,
      includeExtensions: undefined,
      excludeExtensions: undefined,
      includeBaseFiles: false,
      properties: undefined,
      formulas: undefined,
      summaries: undefined,
      views: undefined
    });
  });

  it("create_base_file passes structured base filters and sorting controls", async () => {
    const runtime = createRuntime();
    await startMcpServer(runtime);

    const tool = sdkMock.registeredTools.get("create_base_file");
    if (!tool) {
      throw new Error("create_base_file was not registered");
    }
    await tool.handler({
      scope: { folder: "Articles/Politics" },
      filters: 'tags.contains("politics")',
      excludePaths: ["Articles/Politics/Politics.base"],
      includeExtensions: ["md"],
      excludeExtensions: ["canvas"],
      views: [
        {
          type: "table",
          name: "All Politics Files",
          order: ["file.name", "title", "author"],
          sort: [{ property: "date", direction: "DESC" }]
        }
      ]
    });

    expect(mockCalls(runtime.bridge, "createBaseFile")[0]?.[1]).toEqual({
      scope: { kind: "folder", folder: "Articles/Politics" },
      filters: 'tags.contains("politics")',
      excludePaths: ["Articles/Politics/Politics.base"],
      includeExtensions: ["md"],
      excludeExtensions: ["canvas"],
      includeBaseFiles: false,
      properties: undefined,
      formulas: undefined,
      summaries: undefined,
      views: [
        {
          type: "table",
          name: "All Politics Files",
          order: ["file.name", "title", "author"],
          sort: [{ property: "date", direction: "DESC" }]
        }
      ]
    });
  });

  it("replace_note_text preserves occurrenceIndex and returns completion guidance", async () => {
    const runtime = createRuntime({ embeddingsEnabled: true });
    await startMcpServer(runtime);

    const tool = sdkMock.registeredTools.get("replace_note_text");
    if (!tool) {
      throw new Error("replace_note_text was not registered");
    }
    const result = await tool.handler({ path: "Notes/New.md", oldText: "old", newText: "new", occurrenceIndex: 1 });
    const parsed = JSON.parse(result.content[0]!.text) as WriteNoteResponse & {
      status?: string;
      completionGuidance?: { nextAction: string; embeddingMaintenance?: string };
      hint?: string;
    };

    expect(mockCalls(runtime.bridge, "replaceNoteText")).toEqual([["Notes/New.md", "old", "new", 1]]);
    expect(mockCalls(runtime.db, "upsertNote").length).toBeGreaterThan(0);
    expect(parsed.status).toBe("success");
    expect(parsed.completionGuidance?.nextAction).toContain("answer the user now");
    expect(parsed.completionGuidance?.embeddingMaintenance).toContain("Optional");
    expect(parsed.hint).toContain("refresh_index");
    expect(parsed.hint).toContain("edit is complete");
  });

  it("rewrite_note returns a recoverable error when path is blank", async () => {
    const runtime = createRuntime();
    await startMcpServer(runtime);

    const tool = sdkMock.registeredTools.get("rewrite_note");
    if (!tool) {
      throw new Error("rewrite_note was not registered");
    }
    const result = await tool.handler({ path: "", content: "# Full replacement" });
    const parsed = JSON.parse(result.content[0]!.text) as {
      error?: { code: string; message: string };
      guidance?: string;
    };

    expect(mockCalls(runtime.bridge, "rewriteNote")).toHaveLength(0);
    expect(parsed.error?.code).toBe("missing_path");
    expect(parsed.guidance).toContain("exact note path");
    expect(parsed.guidance).toContain("path before content");
  });

  it("rewrite_note uses the last read note path when path is blank", async () => {
    const runtime = createRuntime();
    await startMcpServer(runtime);

    const readTool = sdkMock.registeredTools.get("read_note");
    const rewriteTool = sdkMock.registeredTools.get("rewrite_note");
    if (!readTool || !rewriteTool) {
      throw new Error("read_note or rewrite_note was not registered");
    }

    await readTool.handler({ path: "Notes/New.md" });
    const result = await rewriteTool.handler({ path: "", content: "# Full replacement" });
    const parsed = JSON.parse(result.content[0]!.text) as WriteNoteResponse & {
      pathResolvedFrom?: string;
    };

    expect(mockCalls(runtime.bridge, "readNote")).toEqual([["Notes/New.md", undefined]]);
    expect(mockCalls(runtime.bridge, "rewriteNote")).toEqual([["Notes/New.md", "# Full replacement"]]);
    expect(parsed.operation).toBe("rewrite");
    expect(parsed.pathResolvedFrom).toBe("last_read_note");
  });

  it("set_note_properties calls the bridge, then updates the local index", async () => {
    const runtime = createRuntime();
    await startMcpServer(runtime);

    const tool = sdkMock.registeredTools.get("set_note_properties");
    if (!tool) {
      throw new Error("set_note_properties was not registered");
    }
    const properties = {
      title: "Bhutan PM",
      summary: null,
      image: "[[image]]",
      tags: []
    };
    const result = await tool.handler({ path: "Notes/New.md", properties });
    const parsed = JSON.parse(result.content[0]!.text) as WriteNoteResponse & {
      status?: string;
      index: { noteCount: number };
    };

    expect(mockCalls(runtime.bridge, "setNoteProperties")).toEqual([["Notes/New.md", properties]]);
    expect(mockCalls(runtime.db, "upsertNote").length).toBeGreaterThan(0);
    expect(parsed.operation).toBe("properties");
    expect(parsed.status).toBe("success");
    expect(parsed.index.noteCount).toBe(1);
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
      readNote: vi.fn(() => Promise.resolve(note)),
      createNote: vi.fn(() => Promise.resolve({ operation: "create", note })),
      createBaseFile: vi.fn((path: string | undefined, base: { scope?: { kind?: string; folder?: string } }) =>
        Promise.resolve({
          operation: "create_base",
          path:
            path && path.endsWith(".base")
              ? path
              : path
                ? `${path}.base`
                : base.scope?.kind === "folder" && base.scope.folder
                  ? `${base.scope.folder}/${base.scope.folder.split("/").pop()}.base`
                  : "Vault.base",
          content: "views:\n  - type: table\n",
          overwritten: false,
          createdFolders: []
        })
      ),
      appendNote: vi.fn(() => Promise.resolve({ operation: "append", note })),
      replaceNoteText: vi.fn(() => Promise.resolve({ operation: "replace", note })),
      deleteNoteText: vi.fn(() => Promise.resolve({ operation: "delete_text", note })),
      rewriteNote: vi.fn(() => Promise.resolve({ operation: "rewrite", note })),
      setNoteProperties: vi.fn(() => Promise.resolve({ operation: "properties", note }))
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
