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

  it("resolves the default database path from the Obsidian plugin folder", async () => {
    const config = loadConfig({ OBSIDIAN_MCP_TOKEN: "token" });
    const resolved = await resolveRuntimeConfig(config, {
      status: async () => ({
        ok: true,
        vaultName: "Test",
        pluginVersion: "0.1.0",
        bridgeVersion: "0.1.0",
        readOnly: true,
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
          includedNoteCount: 0,
          excludedNoteCount: 0
        },
        includedNoteCount: 0,
        maxNoteBytes: 120000,
        auditEnabled: true
      })
    } as never);

    expect(resolved.dbPath).toBe("/vault/.obsidian/plugins/mcp-vault-bridge/index.sqlite");
    expect(resolved.dbPathSource).toBe("bridge");
  });

  it("keeps explicit database paths", async () => {
    const config = loadConfig({ OBSIDIAN_MCP_DB: "/tmp/custom.sqlite" });
    const resolved = await resolveRuntimeConfig(config, {
      status: async () => {
        throw new Error("should not be called");
      }
    } as never);

    expect(resolved.dbPath).toBe("/tmp/custom.sqlite");
    expect(resolved.dbPathSource).toBe("env");
  });
});
