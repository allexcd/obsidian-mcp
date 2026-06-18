import { createServer } from "node:net";
import { request } from "node:http";
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

function createPlugin(options: { port: number; writeToolsEnabled: boolean }): { plugin: ObsidianMcpPlugin; audit: ReturnType<typeof vi.fn> } {
  const configDir = [".", "obsidian"].join("");
  const audit = vi.fn(() => Promise.resolve());
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
        excludedTags: [],
        maxNoteBytes: 120000,
        writeToolsEnabled: options.writeToolsEnabled,
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
          getMarkdownFiles: () => [],
          getAbstractFileByPath: () => null,
          cachedRead: vi.fn(),
          create: vi.fn(),
          modify: vi.fn()
        },
        metadataCache: {
          getFileCache: () => null,
          resolvedLinks: {}
        }
      },
      audit
    } as unknown as ObsidianMcpPlugin,
    audit
  };
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
