import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type ObsidianMcpPlugin from "./main.js";
import { createBridgeServer, type BridgeServerHandle } from "./server.js";

describe("plugin bridge write routes", () => {
  let handles: BridgeServerHandle[] = [];

  beforeEach(() => {
    (globalThis as unknown as { window: { require: NodeJS.Require } }).window = { require };
  });

  afterEach(async () => {
    await Promise.all(handles.map((handle) => handle.close()));
    handles = [];
    vi.restoreAllMocks();
  });

  it("checks write authorization before append content validation", async () => {
    const port = await getFreePort();
    const plugin = createPlugin({ port, writeToolsEnabled: false });
    const handle = await createBridgeServer(plugin, "token");
    handles.push(handle);

    const response = await fetch(`http://127.0.0.1:${port}/notes/append`, {
      method: "POST",
      headers: {
        Authorization: "Bearer token",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ path: "Notes/Test.md", content: "" })
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Write tools are disabled in the Obsidian plugin settings." });
    expect(plugin.audit).toHaveBeenCalledWith({
      route: "/notes/append",
      path: "Notes/Test.md",
      allowed: false,
      reason: "writes_disabled"
    });
  });
});

function createPlugin(options: { port: number; writeToolsEnabled: boolean }): ObsidianMcpPlugin {
  return {
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
        configDir: ".obsidian",
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
    audit: vi.fn(() => Promise.resolve())
  } as unknown as ObsidianMcpPlugin;
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
