import { createServer } from "node:net";
import { request } from "node:http";
import { TFile, TFolder } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type ObsidianMcpPlugin from "./main.js";
import { createBridgeServer, type BridgeServerHandle } from "./server.js";

describe("plugin bridge write routes", () => {
  let handles: BridgeServerHandle[] = [];

  beforeEach(() => {
    vi.stubGlobal("window", { require });
  });

  afterEach(async () => {
    await Promise.all(handles.map((handle) => handle.close()));
    handles = [];
    vi.restoreAllMocks();
  });

  it("checks write authorization before append content validation", async () => {
    const port = await getFreePort();
    const { plugin, audit } = createPlugin({ port, writeToolsEnabled: false });
    const handle = await createBridgeServer(plugin, "token");
    handles.push(handle);

    const response = await postJson(port, "/notes/append", { path: "Notes/Test.md", content: "" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Write tools are disabled in the Obsidian plugin settings." });
    expect(audit).toHaveBeenCalledWith({
      route: "/notes/append",
      path: "Notes/Test.md",
      allowed: false,
      reason: "writes_disabled"
    });
  });

  it("rejects creating content that introduces an excluded tag", async () => {
    const port = await getFreePort();
    const { plugin, vault, audit } = createPlugin({ port, excludedTags: ["private"] });
    const handle = await createBridgeServer(plugin, "token");
    handles.push(handle);

    const response = await postJson(port, "/notes/create", { path: "Notes/New.md", content: "# New\n#private" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Written note content would be excluded by the current vault scope." });
    expect(vault.create.mock.calls).toHaveLength(0);
    expect(audit).toHaveBeenCalledWith({
      route: "/notes/create",
      path: "Notes/New.md",
      allowed: false,
      reason: "post_write_scope_denied"
    });
  });

  it("rejects rewriting content that introduces an excluded tag", async () => {
    const port = await getFreePort();
    const { plugin, vault, file } = createPlugin({
      port,
      excludedTags: ["private"],
      files: [{ path: "Notes/Existing.md", content: "# Existing" }]
    });
    const handle = await createBridgeServer(plugin, "token");
    handles.push(handle);

    const response = await postJson(port, "/notes/rewrite", { path: "Notes/Existing.md", content: "# Existing\n#private" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Written note content would be excluded by the current vault scope." });
    expect(vault.modify.mock.calls).toHaveLength(0);
    expect(file?.content).toBe("# Existing");
  });

  it("rejects appending content that introduces an excluded tag", async () => {
    const port = await getFreePort();
    const { plugin, vault, file } = createPlugin({
      port,
      excludedTags: ["private"],
      files: [{ path: "Notes/Existing.md", content: "# Existing" }]
    });
    const handle = await createBridgeServer(plugin, "token");
    handles.push(handle);

    const response = await postJson(port, "/notes/append", { path: "Notes/Existing.md", content: "#private" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Written note content would be excluded by the current vault scope." });
    expect(vault.modify.mock.calls).toHaveLength(0);
    expect(file?.content).toBe("# Existing");
  });

  it("sets note properties through Obsidian frontmatter processing", async () => {
    const port = await getFreePort();
    const { plugin, file } = createPlugin({
      port,
      files: [{ path: "Notes/Article.md", content: "# Article\nBody" }]
    });
    const handle = await createBridgeServer(plugin, "token");
    handles.push(handle);

    const response = await postJson(port, "/notes/properties", {
      path: "Notes/Article.md",
      properties: {
        title: "Bhutan PM",
        summary: null,
        image: "[[image]]",
        tags: []
      }
    });

    expect(response.status).toBe(200);
    expect((response.body as { operation?: string }).operation).toBe("properties");
    expect(file?.content).toContain("---\ntitle: Bhutan PM\nsummary:\nimage: \"[[image]]\"\ntags: []\n---\n# Article");
  });

  it("rejects properties that introduce an excluded tag", async () => {
    const port = await getFreePort();
    const { plugin, file } = createPlugin({
      port,
      excludedTags: ["private"],
      files: [{ path: "Notes/Article.md", content: "# Article\nBody" }]
    });
    const handle = await createBridgeServer(plugin, "token");
    handles.push(handle);

    const response = await postJson(port, "/notes/properties", {
      path: "Notes/Article.md",
      properties: {
        tags: ["private"]
      }
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Written note properties would be excluded by the current vault scope." });
    expect(file?.content).toBe("# Article\nBody");
  });

  it("rolls back property writes that fail post-write scope validation", async () => {
    const port = await getFreePort();
    const original = "# Article\nBody";
    const { plugin, file, vault } = createPlugin({
      port,
      excludedTags: ["private"],
      files: [{ path: "Notes/Article.md", content: original }]
    });
    const handle = await createBridgeServer(plugin, "token");
    handles.push(handle);

    const response = await postJson(port, "/notes/properties", {
      path: "Notes/Article.md",
      properties: {
        summary: "#private"
      }
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Written note properties would be excluded by the current vault scope." });
    expect(vault.modify).toHaveBeenCalledWith(file, original);
    expect(file?.content).toBe(original);
  });

  it("repairs malformed existing frontmatter when setting note properties", async () => {
    const port = await getFreePort();
    const { plugin, file } = createPlugin({
      port,
      frontmatterParseFails: true,
      files: [
        {
          path: "Notes/Article.md",
          content: "---\ntitle: Bhutan PM on leading the first carbon-negative nation: 'The wellbeing of our people'\n---\n# Article\nBody"
        }
      ]
    });
    const handle = await createBridgeServer(plugin, "token");
    handles.push(handle);

    const response = await postJson(port, "/notes/properties", {
      path: "Notes/Article.md",
      properties: {
        title: "Bhutan PM on leading the first carbon-negative nation: 'The wellbeing of our people'",
        summary: null,
        image: "[[image]]",
        tags: []
      }
    });

    expect(response.status).toBe(200);
    expect((response.body as { operation?: string }).operation).toBe("properties");
    expect(file?.content).toContain(
      `---\ntitle: "Bhutan PM on leading the first carbon-negative nation: 'The wellbeing of our people'"\nsummary:\nimage: "[[image]]"\ntags: []\n---\n# Article`
    );
  });

  it("creates a folder-scoped base file with requested table columns", async () => {
    const port = await getFreePort();
    const { plugin, vault, files, folders } = createPlugin({ port, folders: ["Bases"] });
    const handle = await createBridgeServer(plugin, "token");
    handles.push(handle);

    const response = await postJson(port, "/bases/create", {
      path: "Bases/Folder X",
      scope: { kind: "folder", folder: "Folder X" },
      createFolder: true,
      views: [{ type: "table", name: "Table", order: ["title", "author", "url", "file.name"] }]
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      operation: "create_base",
      path: "Bases/Folder X.base",
      overwritten: false,
      createdFolders: []
    });
    expect(vault.create).toHaveBeenCalledWith(
      "Bases/Folder X.base",
      [
        "filters:",
        "  and:",
        "    - and:",
        "        - 'file.inFolder(\"Folder X\")'",
        "    - 'file.ext != \"base\"'",
        "views:",
        "  - type: table",
        "    name: Table",
        "    order:",
        "      - title",
        "      - author",
        "      - url",
        "      - file.name",
        ""
      ].join("\n")
    );
    expect(files.get("Bases/Folder X.base")?.extension).toBe("base");
    expect(folders.has("Bases")).toBe(true);
  });

  it("defaults folder-scoped base files inside the scoped folder", async () => {
    const port = await getFreePort();
    const { plugin, vault, files, folders } = createPlugin({
      port,
      folders: ["Articles", "Articles/Science"],
      files: [{ path: "Articles/Science/Article.md", content: "# Article" }]
    });
    const handle = await createBridgeServer(plugin, "token");
    handles.push(handle);

    const response = await postJson(port, "/bases/create", {
      scope: { folder: "Articles/Science" }
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      operation: "create_base",
      path: "Articles/Science/Science.base",
      overwritten: false,
      createdFolders: []
    });
    expect(vault.create).toHaveBeenCalledWith("Articles/Science/Science.base", expect.stringContaining('file.inFolder("Articles/Science")'));
    expect(files.get("Articles/Science/Science.base")?.extension).toBe("base");
    expect(folders.has("Articles/Science")).toBe(true);
  });

  it("resolves a unique folder basename instead of creating a root folder", async () => {
    const port = await getFreePort();
    const { plugin, vault, files, folders } = createPlugin({
      port,
      folders: ["Articles", "Articles/Politics"],
      files: [{ path: "Articles/Politics/Article.md", content: "# Article" }]
    });
    const handle = await createBridgeServer(plugin, "token");
    handles.push(handle);

    const response = await postJson(port, "/bases/create", {
      scope: { folder: "Politics" }
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      operation: "create_base",
      path: "Articles/Politics/Politics.base",
      overwritten: false,
      createdFolders: []
    });
    expect(vault.create).toHaveBeenCalledWith("Articles/Politics/Politics.base", expect.stringContaining('file.inFolder("Articles/Politics")'));
    expect(vault.create).toHaveBeenCalledWith("Articles/Politics/Politics.base", expect.stringContaining('file.ext != "base"'));
    expect(files.get("Articles/Politics/Politics.base")?.extension).toBe("base");
    expect(folders.has("Politics")).toBe(false);
  });

  it("serializes explicit base filters, excluded paths, extensions, and view sorting", async () => {
    const port = await getFreePort();
    const { plugin, vault } = createPlugin({
      port,
      folders: ["Articles", "Articles/Politics"],
      files: [{ path: "Articles/Politics/Article.md", content: "# Article" }]
    });
    const handle = await createBridgeServer(plugin, "token");
    handles.push(handle);

    const response = await postJson(port, "/bases/create", {
      scope: { folder: "Politics" },
      filters: 'tags.contains("politics")',
      excludePaths: ["Articles/Politics/Politics.base"],
      includeExtensions: ["md"],
      excludeExtensions: ["canvas"],
      views: [
        {
          type: "table",
          name: "All Politics Files",
          order: ["file.name", "title", "author", "date", "tags"],
          sort: [{ property: "date", direction: "DESC" }]
        }
      ]
    });

    expect(response.status).toBe(200);
    const content = (response.body as { content?: string }).content ?? "";
    expect(content).toContain('file.inFolder("Articles/Politics")');
    expect(content).toContain('tags.contains("politics")');
    expect(content).toContain('file.path != "Articles/Politics/Politics.base"');
    expect(content).toContain('file.ext == "md"');
    expect(content).toContain('file.ext != "canvas"');
    expect(content).toContain('file.ext != "base"');
    expect(content).toContain("sort:");
    expect(content).toContain("property: date");
    expect(content).toContain("direction: DESC");
    expect(vault.create).toHaveBeenCalledWith("Articles/Politics/Politics.base", content);
  });

  it("overrides auto-derived root paths after resolving a folder basename", async () => {
    const port = await getFreePort();
    const { plugin, vault, files, folders } = createPlugin({
      port,
      folders: ["Articles", "Articles/Politics"],
      files: [{ path: "Articles/Politics/Article.md", content: "# Article" }]
    });
    const handle = await createBridgeServer(plugin, "token");
    handles.push(handle);

    const response = await postJson(port, "/bases/create", {
      path: "Politics/Politics.base",
      scope: { folder: "Politics" }
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      operation: "create_base",
      path: "Articles/Politics/Politics.base",
      overwritten: false,
      createdFolders: []
    });
    expect(vault.create).toHaveBeenCalledWith("Articles/Politics/Politics.base", expect.stringContaining('file.inFolder("Articles/Politics")'));
    expect(files.get("Articles/Politics/Politics.base")?.extension).toBe("base");
    expect(folders.has("Politics")).toBe(false);
  });

  it("overrides auto-derived parent paths after resolving a folder basename", async () => {
    const port = await getFreePort();
    const { plugin, vault, files } = createPlugin({
      port,
      folders: ["Articles", "Articles/Politics"],
      files: [{ path: "Articles/Politics/Article.md", content: "# Article" }]
    });
    const handle = await createBridgeServer(plugin, "token");
    handles.push(handle);

    const response = await postJson(port, "/bases/create", {
      path: "Articles/Politics.base",
      scope: { folder: "Politics" }
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      operation: "create_base",
      path: "Articles/Politics/Politics.base",
      overwritten: false,
      createdFolders: []
    });
    expect(vault.create).toHaveBeenCalledWith("Articles/Politics/Politics.base", expect.stringContaining('file.inFolder("Articles/Politics")'));
    expect(files.get("Articles/Politics/Politics.base")?.extension).toBe("base");
  });

  it.each([
    {
      label: "topic folder basename",
      requested: "Politics",
      resolved: "Articles/Politics",
      inputs: [
        "Politics",
        "Politics.base",
        "Politics/Politics",
        "Politics/Politics.base",
        "Politics/Politics Overview.base",
        "Articles/Politics",
        "Articles/Politics.base",
        "Articles/Politics Base.base",
        "Articles/Politics files.base"
      ]
    },
    {
      label: "folder basename with spaces",
      requested: "Nina Lakhani",
      resolved: "Articles/Authors/Nina Lakhani",
      inputs: [
        "Nina Lakhani",
        "Nina Lakhani.base",
        "Nina Lakhani/Nina Lakhani.base",
        "Articles/Authors/Nina Lakhani",
        "Articles/Authors/Nina Lakhani.base",
        "Articles/Authors/Nina Lakhani files.base"
      ]
    },
    {
      label: "hyphenated folder basename",
      requested: "Long-Term Planning",
      resolved: "Projects/Research/Long-Term Planning",
      inputs: [
        "Long-Term Planning",
        "Long-Term Planning.base",
        "Long-Term Planning/Long-Term Planning.base",
        "Projects/Research/Long-Term Planning",
        "Projects/Research/Long-Term Planning.base",
        "Projects/Research/Long-Term Planning overview.base"
      ]
    }
  ])("overrides auto-derived paths after resolving %s", async ({ requested, resolved, inputs }) => {
    const port = await getFreePort();
    const { plugin, vault, files, folders } = createPlugin({
      port,
      folders: parentFoldersForTest(resolved),
      files: [{ path: `${resolved}/Article.md`, content: "# Article" }]
    });
    const handle = await createBridgeServer(plugin, "token");
    handles.push(handle);

    for (const inputPath of inputs) {
      vault.create.mockClear();
      const response = await postJson(port, "/bases/create", {
        path: inputPath,
        scope: { folder: requested }
      });

      const basename = resolved.split("/").pop()!;
      const expectedPath = `${resolved}/${basename}.base`;
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        operation: "create_base",
        path: expectedPath,
        overwritten: false,
        createdFolders: []
      });
      expect(vault.create).toHaveBeenCalledWith(expectedPath, expect.stringContaining(`file.inFolder("${resolved}")`));
      expect(files.get(expectedPath)?.extension).toBe("base");
      expect(folders.has(requested)).toBe(false);
      files.delete(expectedPath);
    }
  });

  it("keeps deliberate custom base paths after resolving a folder basename", async () => {
    const port = await getFreePort();
    const { plugin, vault, files } = createPlugin({
      port,
      folders: ["Articles", "Articles/Politics", "Bases"],
      files: [{ path: "Articles/Politics/Article.md", content: "# Article" }]
    });
    const handle = await createBridgeServer(plugin, "token");
    handles.push(handle);

    const response = await postJson(port, "/bases/create", {
      path: "Bases/Politics Overview.base",
      scope: { folder: "Politics" }
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      operation: "create_base",
      path: "Bases/Politics Overview.base",
      overwritten: false,
      createdFolders: []
    });
    expect(vault.create).toHaveBeenCalledWith("Bases/Politics Overview.base", expect.stringContaining('file.inFolder("Articles/Politics")'));
    expect(files.get("Bases/Politics Overview.base")?.extension).toBe("base");
  });

  it("rejects base creation without an explicit scope", async () => {
    const port = await getFreePort();
    const { plugin, vault, audit } = createPlugin({ port });
    const handle = await createBridgeServer(plugin, "token");
    handles.push(handle);

    const response = await postJson(port, "/bases/create", {});

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error:
        'Base scope is required. Resolve the user\'s intended folder or files first, or pass { kind: "vault" } only when the user explicitly asks for the whole vault.'
    });
    expect(vault.create).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith({
      route: "/bases/create",
      path: "",
      allowed: false,
      reason: "missing_base_scope"
    });
  });

  it("rejects unresolved folder scopes by default", async () => {
    const port = await getFreePort();
    const { plugin, vault, folders } = createPlugin({ port });
    const handle = await createBridgeServer(plugin, "token");
    handles.push(handle);

    const response = await postJson(port, "/bases/create", { scope: { folder: "Politics" } });

    expect(response.status).toBe(400);
    expect((response.body as { error?: string }).error).toContain('Folder "Politics" was not found');
    expect(vault.create).not.toHaveBeenCalled();
    expect(vault.createFolder).not.toHaveBeenCalled();
    expect(folders.has("Politics")).toBe(false);
  });

  it("creates missing parent folders only when explicitly requested", async () => {
    const port = await getFreePort();
    const { plugin, vault, folders } = createPlugin({ port });
    const handle = await createBridgeServer(plugin, "token");
    handles.push(handle);

    const response = await postJson(port, "/bases/create", {
      path: "Bases/Projects/All",
      scope: { kind: "vault" },
      createFolder: true
    });

    expect(response.status).toBe(200);
    expect((response.body as { createdFolders?: string[] }).createdFolders).toEqual(["Bases", "Bases/Projects"]);
    expect(vault.createFolder).toHaveBeenCalledWith("Bases");
    expect(vault.createFolder).toHaveBeenCalledWith("Bases/Projects");
    expect(folders.has("Bases/Projects")).toBe(true);
  });

  it("rejects base file writes in excluded folders", async () => {
    const port = await getFreePort();
    const { plugin, vault } = createPlugin({ port, excludedFolders: ["Private"] });
    const handle = await createBridgeServer(plugin, "token");
    handles.push(handle);

    const response = await postJson(port, "/bases/create", { path: "Private/View.base", scope: { kind: "vault" } });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Writable base file path is not allowed." });
    expect(vault.create).not.toHaveBeenCalled();
  });
});

function postJson(port: number, path: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const requestBody = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          Authorization: "Bearer token",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(requestBody)
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
          });
        });
      }
    );
    req.on("error", reject);
    req.end(requestBody);
  });
}

interface TestFile {
  path: string;
  content: string;
  basename: string;
  extension: string;
  stat: { ctime: number; mtime: number; size: number };
}

interface PluginFixture {
  plugin: ObsidianMcpPlugin;
  audit: ReturnType<typeof vi.fn>;
  vault: {
    create: ReturnType<typeof vi.fn>;
    createFolder: ReturnType<typeof vi.fn>;
    modify: ReturnType<typeof vi.fn>;
  };
  files: Map<string, TestFile>;
  folders: Map<string, TestFolder>;
  file: TestFile | undefined;
}

interface TestFolder {
  path: string;
}

function createPlugin(
  options: {
    port: number;
    writeToolsEnabled?: boolean;
    excludedFolders?: string[];
    excludedFiles?: string[];
    excludedTags?: string[];
    frontmatterParseFails?: boolean;
    folders?: string[];
    files?: Array<{ path: string; content: string }>;
  }
): PluginFixture {
  const configDir = [".", "obsidian"].join("");
  const audit = vi.fn(() => Promise.resolve());
  const files = new Map<string, TestFile>();
  const folders = new Map<string, TestFolder>();
  for (const folder of options.folders ?? []) {
    folders.set(folder, makeFolder(folder));
  }
  for (const item of options.files ?? []) {
    files.set(item.path, makeFile(item.path, item.content));
  }
  const create = vi.fn((path: string, content: string) => {
    const file = makeFile(path, content);
    files.set(path, file);
    return Promise.resolve(file);
  });
  const createFolder = vi.fn((path: string) => {
    const folder = makeFolder(path);
    folders.set(path, folder);
    return Promise.resolve(folder);
  });
  const modify = vi.fn((file: TestFile, content: string) => {
    file.content = content;
    file.stat.size = content.length;
    return Promise.resolve();
  });
  const processFrontMatter = vi.fn((file: TestFile, callback: (frontmatter: Record<string, unknown>) => void) => {
    if (options.frontmatterParseFails) {
      return Promise.reject(new Error("Nested mappings are not allowed in compact mappings at line 1, column 8"));
    }
    const frontmatter = parseFrontmatterForTest(file.content);
    callback(frontmatter);
    file.content = writeFrontmatterForTest(file.content, frontmatter);
    file.stat.size = file.content.length;
    return Promise.resolve();
  });
  const firstFile = files.values().next().value;
  return {
    plugin: {
      manifest: {
        id: "mcp-vault-bridge",
        version: "0.4.3"
      },
      settings: {
        bridgeEnabled: true,
        port: options.port,
        excludedFolders: options.excludedFolders ?? [],
        excludedFiles: options.excludedFiles ?? [],
        excludedTags: options.excludedTags ?? [],
        maxNoteBytes: 120000,
        writeToolsEnabled: options.writeToolsEnabled ?? true,
        autoPruneEmbeddings: true,
        auditEnabled: true,
        tokenSecretName: "obsidian-mcp-bridge-token",
        nodeCommandOverride: "",
        npmCommandOverride: ""
      },
      app: {
        vault: {
          configDir,
          getName: () => "Test Vault",
          getMarkdownFiles: () => Array.from(files.values()).filter((file) => file.extension === "md"),
          getAbstractFileByPath: (path: string) => files.get(path) ?? folders.get(path) ?? null,
          cachedRead: vi.fn((file: TestFile) => Promise.resolve(file.content)),
          create,
          createFolder,
          modify
        },
        fileManager: {
          processFrontMatter
        },
        metadataCache: {
          getFileCache: () => null,
          resolvedLinks: {}
        }
      },
      audit
    } as unknown as ObsidianMcpPlugin,
    audit,
    vault: { create, createFolder, modify },
    files,
    folders,
    file: firstFile
  };
}

function parseFrontmatterForTest(content: string): Record<string, unknown> {
  if (!content.startsWith("---\n")) {
    return {};
  }
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) {
    return {};
  }
  const frontmatter: Record<string, unknown> = {};
  for (const line of content.slice(4, end).split("\n")) {
    const [key, ...rest] = line.split(":");
    if (!key) {
      continue;
    }
    const value = rest.join(":").trim();
    frontmatter[key.trim()] = value || null;
  }
  return frontmatter;
}

function writeFrontmatterForTest(content: string, frontmatter: Record<string, unknown>): string {
  const body = content.startsWith("---\n") && content.indexOf("\n---\n", 4) >= 0 ? content.slice(content.indexOf("\n---\n", 4) + 5) : content;
  const yaml = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${formatYamlValueForTest(value)}`.trimEnd())
    .join("\n");
  return `---\n${yaml}\n---\n${body}`;
}

function formatYamlValueForTest(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[${value.map(formatYamlValueForTest).join(", ")}]`;
  }
  if (typeof value === "string" && (value.includes("[[") || value.includes(":"))) {
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return "";
}

function makeFile(path: string, content: string): TestFile {
  const filename = path.split("/").pop() ?? path;
  const extension = filename.includes(".") ? (filename.split(".").pop() ?? "") : "md";
  const basename = filename.replace(new RegExp(`\\.${extension}$`, "i"), "");
  const file = new TFile() as unknown as TestFile;
  file.path = path;
  file.content = content;
  file.basename = basename;
  file.extension = extension;
  file.stat = {
    ctime: 1,
    mtime: 1,
    size: content.length
  };
  return file;
}

function makeFolder(path: string): TestFolder {
  const folder = new TFolder() as unknown as TestFolder;
  folder.path = path;
  return folder;
}

function parentFoldersForTest(path: string): string[] {
  const parts = path.split("/");
  const folders: string[] = [];
  for (let index = 1; index <= parts.length; index += 1) {
    folders.push(parts.slice(0, index).join("/"));
  }
  return folders;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a local port.")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}
