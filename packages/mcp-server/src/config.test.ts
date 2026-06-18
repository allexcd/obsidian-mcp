import { describe, expect, it } from "vitest";
import { loadConfig, resolveRuntimeConfig } from "./config.js";

describe("loadConfig", () => {
  it("keeps embeddings off by default", () => {
    const config = loadConfig({});
    expect(config.embeddings.enabled).toBe(false);
    expect(config.bridgeUrl).toBe("http://127.0.0.1:27125");
    expect(config.dbPath).toBeNull();
    expect(config.dbPathSource).toBe("bridge");
    expect(config.autoIndex).toBe(true);
    expect(config.autoPruneEmbeddings).toBe(true);
    expect(config.autoPruneEmbeddingsSource).toBe("bridge");
  });

  it("requires explicit embedding opt-in", () => {
    const config = loadConfig({
      OBSIDIAN_MCP_EMBEDDINGS: "on",
      OBSIDIAN_MCP_EMBEDDING_BASE_URL: "http://127.0.0.1:1234/v1",
      OBSIDIAN_MCP_EMBEDDING_MODEL: "local"
    });
    expect(config.embeddings.enabled).toBe(true);
    expect(config.embeddings.model).toBe("local");
  });

  it("allows auto-indexing to be disabled", () => {
    const config = loadConfig({ OBSIDIAN_MCP_AUTO_INDEX: "off" });
    expect(config.autoIndex).toBe(false);
  });

  it("allows automatic embedding pruning to be disabled by env", () => {
    const config = loadConfig({ OBSIDIAN_MCP_AUTO_PRUNE_EMBEDDINGS: "off" });
    expect(config.autoPruneEmbeddings).toBe(false);
    expect(config.autoPruneEmbeddingsSource).toBe("env");
  });

  it("resolves the default database path from the Obsidian plugin folder", async () => {
    const config = loadConfig({ OBSIDIAN_MCP_TOKEN: "token" });
    const resolved = await resolveRuntimeConfig(config, {
      status: () => Promise.resolve(createBridgeStatus({ autoPruneEmbeddings: false }))
    } as never);

    expect(resolved.dbPath).toBe("/vault/custom-config/plugins/mcp-vault-bridge/index.sqlite");
    expect(resolved.dbPathSource).toBe("bridge");
    expect(resolved.autoPruneEmbeddings).toBe(false);
  });

  it("keeps explicit database paths", async () => {
    const config = loadConfig({ OBSIDIAN_MCP_DB: "/tmp/custom.sqlite" });
    const resolved = await resolveRuntimeConfig(config, {
      status: () => Promise.resolve(createBridgeStatus({ autoPruneEmbeddings: false }))
    } as never);

    expect(resolved.dbPath).toBe("/tmp/custom.sqlite");
    expect(resolved.dbPathSource).toBe("env");
    expect(resolved.autoPruneEmbeddings).toBe(false);
  });

  it("lets the env pruning override win over plugin status", async () => {
    const config = loadConfig({
      OBSIDIAN_MCP_DB: "/tmp/custom.sqlite",
      OBSIDIAN_MCP_AUTO_PRUNE_EMBEDDINGS: "off"
    });
    const resolved = await resolveRuntimeConfig(config, {
      status: () => Promise.resolve(createBridgeStatus({ autoPruneEmbeddings: true }))
    } as never);

    expect(resolved.dbPath).toBe("/tmp/custom.sqlite");
    expect(resolved.autoPruneEmbeddings).toBe(false);
    expect(resolved.autoPruneEmbeddingsSource).toBe("env");
  });
});

function createBridgeStatus(options: { autoPruneEmbeddings: boolean }) {
  return {
    ok: true,
    vaultName: "Test",
    pluginVersion: "0.4.2",
    bridgeVersion: "0.4.2",
    readOnly: true,
    writeToolsEnabled: false,
    autoPruneEmbeddings: options.autoPruneEmbeddings,
    pluginDirectory: {
      vaultPath: "custom-config/plugins/mcp-vault-bridge",
      filesystemPath: "/vault/custom-config/plugins/mcp-vault-bridge",
      defaultDatabasePath: "/vault/custom-config/plugins/mcp-vault-bridge/index.sqlite"
    },
    scope: { excludedFolders: [], excludedFiles: [], excludedTags: [] },
    vaultPreview: {
      detectedFolders: [],
      detectedFiles: [],
      detectedTags: [],
      includedNoteCount: 0,
      excludedNoteCount: 0
    },
    includedNoteCount: 0,
    maxNoteBytes: 120000,
    auditEnabled: true
  };
}
