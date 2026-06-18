import { createServer } from "node:net";
import { request } from "node:http";
import { TFile } from "obsidian";
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
    modify: ReturnType<typeof vi.fn>;
  };
  file: TestFile | undefined;
}

function createPlugin(
  options: {
    port: number;
    writeToolsEnabled?: boolean;
    excludedTags?: string[];
    files?: Array<{ path: string; content: string }>;
  }
): PluginFixture {
  const configDir = [".", "obsidian"].join("");
  const audit = vi.fn(() => Promise.resolve());
  const files = new Map<string, TestFile>();
  for (const item of options.files ?? []) {
    files.set(item.path, makeFile(item.path, item.content));
  }
  const create = vi.fn((path: string, content: string) => {
    const file = makeFile(path, content);
    files.set(path, file);
    return Promise.resolve(file);
  });
  const modify = vi.fn((file: TestFile, content: string) => {
    file.content = content;
    file.stat.size = content.length;
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
        excludedFolders: [],
        excludedFiles: [],
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
          getMarkdownFiles: () => Array.from(files.values()),
          getAbstractFileByPath: (path: string) => files.get(path) ?? null,
          cachedRead: vi.fn((file: TestFile) => Promise.resolve(file.content)),
          create,
          modify
        },
        metadataCache: {
          getFileCache: () => null,
          resolvedLinks: {}
        }
      },
      audit
    } as unknown as ObsidianMcpPlugin,
    audit,
    vault: { create, modify },
    file: firstFile
  };
}

function makeFile(path: string, content: string): TestFile {
  const basename = path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
  const file = new TFile() as unknown as TestFile;
  file.path = path;
  file.content = content;
  file.basename = basename;
  file.extension = "md";
  file.stat = {
    ctime: 1,
    mtime: 1,
    size: content.length
  };
  return file;
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
