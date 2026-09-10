import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WriteNoteResponse } from "@obsidian-mcp/shared";
import type { McpRuntime } from "./mcp.js";
import { indexWrittenNote, startMcpServer } from "./mcp.js";

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

  it.each(["ask_vault", "search_vault", "list_notes", "related_notes", "analyze_vault"])("%s rejects cached content after live authorization changes", async name => {
    const runtime = createRuntime();
    const note = createWrittenNote("Private.md", "PRIVATE_CACHE_SENTINEL");
    const row = { ...note, score: 1, snippet: "PRIVATE_CACHE_SENTINEL", contentHash: "revision", outlinks: [], backlinks: [], embeds: [], indexedAt: "2026-09-09T00:00:00Z" };
    runtime.indexer.verifyAccess = vi.fn(async () => undefined);
    runtime.db.getNote = vi.fn(() => row);
    runtime.db.listNotes = vi.fn(() => [row]);
    runtime.db.searchFts = vi.fn(() => [row]);
    runtime.db.relatedNotes = vi.fn(() => [row]);
    runtime.db.deleteNote = vi.fn();
    runtime.bridge.authorize = vi.fn(async () => []);
    await startMcpServer(runtime);
    const response = await sdkMock.registeredTools.get(name)!.handler({query:"private", question:"private", path:"Private.md", limit:5});
    expect(JSON.stringify(response)).not.toContain("PRIVATE_CACHE_SENTINEL");
    expect(mockCalls(runtime.bridge,"authorize")).toEqual([[["Private.md"]]]);
    expect(mockCalls(runtime.db,"deleteNote")).toEqual([["Private.md"]]);
    runtime.bridge.authorize = vi.fn(async () => { throw new Error("offline"); });
    await expect(sdkMock.registeredTools.get(name)!.handler({query:"private", question:"private", path:"Private.md", limit:5})).rejects.toThrow("offline");
  });

  it("passes retry IDs and revisions through every note write tool", async () => {
    const runtime = createRuntime();
    await startMcpServer(runtime);
    const cases = [
      ["create_note", "createNote", { path: "Notes/New.md", content: "new", overwrite: true }],
      ["append_note", "appendNote", { path: "Notes/New.md", content: "new" }],
      ["rewrite_note", "rewriteNote", { path: "Notes/New.md", content: "new" }],
      ["replace_note_text", "replaceNoteText", { path: "Notes/New.md", oldText: "old", newText: "new" }],
      ["delete_note_text", "deleteNoteText", { path: "Notes/New.md", text: "old" }],
      ["set_note_properties", "setNoteProperties", { path: "Notes/New.md", properties: { title: "new" } }]
    ] as const;
    for (const [name, method, input] of cases) {
      await sdkMock.registeredTools.get(name)!.handler({ ...input, expectedRevision: "revision", operationId: "write-1" });
      expect(mockCalls(runtime.bridge, method).at(-1)?.slice(-2)).toEqual(["revision", "write-1"]);
    }
    await sdkMock.registeredTools.get("create_base_file")!.handler({ scope: { kind: "vault" }, operationId: "base-1" });
    expect(mockCalls(runtime.bridge, "createBaseFile").at(-1)?.at(-1)).toBe("base-1");
  });

  it("does not index historical content from a replayed write receipt", () => {
    const runtime = createRuntime();
    const response = { operation: "append" as const, note: createWrittenNote("Notes/New.md", "old snapshot"), replayed: true };
    const result = indexWrittenNote(runtime, response);
    expect(mockCalls(runtime.db, "upsertNote")).toHaveLength(0);
    expect(result.completionGuidance.verification).toContain("may have changed since");
  });

  it("compact profile hides maintenance and disabled write tools", async () => {
    const runtime = createRuntime();
    runtime.config.toolProfile = "compact";
    const status = await runtime.bridge.status();
    runtime.bridge.status = vi.fn(async () => ({...status,writeToolsEnabled:false,readOnly:true}));
    await startMcpServer(runtime);
    expect(sdkMock.registeredTools.has("search_vault")).toBe(true);
    for (const name of ["refresh_index","prune_embeddings","analyze_vault","append_note","create_note"]) expect(sdkMock.registeredTools.has(name)).toBe(false);
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

    expect(mockCalls(runtime.bridge, "createNote")).toEqual([["Notes/New.md", "# New", false, undefined, undefined]]);
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
        false,
        undefined
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

    expect(mockCalls(runtime.bridge, "replaceNoteText")).toEqual([["Notes/New.md", "old", "new", 1, undefined, undefined]]);
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

  it("rewrite_note rejects blank and missing paths even after reading a note", async () => {
    const runtime = createRuntime();
    await startMcpServer(runtime);

    const readTool = sdkMock.registeredTools.get("read_note");
    const rewriteTool = sdkMock.registeredTools.get("rewrite_note");
    if (!readTool || !rewriteTool) {
      throw new Error("read_note or rewrite_note was not registered");
    }

    await readTool.handler({ path: "Notes/New.md" });
    const result = await rewriteTool.handler({ path: "", content: "# Full replacement" });
    const parsed = JSON.parse(result.content[0]!.text) as { error: { code: string } };
    expect(parsed.error.code).toBe("missing_path");
    await rewriteTool.handler({ content: "# Full replacement" });
    expect(mockCalls(runtime.bridge, "rewriteNote")).toHaveLength(0);

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

    expect(mockCalls(runtime.bridge, "setNoteProperties")).toEqual([["Notes/New.md", properties, undefined, undefined]]);
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
