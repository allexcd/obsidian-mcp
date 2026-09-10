import { join } from "node:path";
import { DEFAULT_PAGE_LIMIT } from "@obsidian-mcp/shared";
import type { BridgeClient } from "./bridge-client.js";

export interface EmbeddingConfig {
  enabled: boolean;
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
  provider: string;
  queryPrefix?: string;
  documentPrefix?: string;
}

export interface ServerConfig {
  bridgeUrl: string;
  token: string | null;
  dbPath: string | null;
  dbPathSource: "env" | "bridge";
  maxResults: number;
  autoIndex: boolean;
  autoPruneEmbeddings: boolean;
  autoPruneEmbeddingsSource: "env" | "bridge";
  embeddings: EmbeddingConfig;
  embeddingOverrides?: string[];
  toolProfile?: "full" | "compact";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    bridgeUrl: env.OBSIDIAN_MCP_BRIDGE_URL ?? "http://127.0.0.1:27125",
    token: env.OBSIDIAN_MCP_TOKEN ?? null,
    dbPath: env.OBSIDIAN_MCP_DB ? expandHome(env.OBSIDIAN_MCP_DB) : null,
    dbPathSource: env.OBSIDIAN_MCP_DB ? "env" : "bridge",
    maxResults: clampNumber(env.OBSIDIAN_MCP_MAX_RESULTS, DEFAULT_PAGE_LIMIT, 1, 100),
    autoIndex: parseEnabled(env.OBSIDIAN_MCP_AUTO_INDEX, true),
    autoPruneEmbeddings: parseEnabled(env.OBSIDIAN_MCP_AUTO_PRUNE_EMBEDDINGS, true),
    autoPruneEmbeddingsSource: env.OBSIDIAN_MCP_AUTO_PRUNE_EMBEDDINGS === undefined ? "bridge" : "env",
    toolProfile: env.OBSIDIAN_MCP_TOOL_PROFILE === "compact" ? "compact" : env.OBSIDIAN_MCP_TOOL_PROFILE === "full" ? "full" : undefined,
    embeddingOverrides: Object.keys(env).filter(key => key === "OBSIDIAN_MCP_EMBEDDINGS" || key.startsWith("OBSIDIAN_MCP_EMBEDDING_")),
    embeddings: {
      queryPrefix: env.OBSIDIAN_MCP_EMBEDDING_QUERY_PREFIX,
      documentPrefix: env.OBSIDIAN_MCP_EMBEDDING_DOCUMENT_PREFIX,
      enabled: parseEnabled(env.OBSIDIAN_MCP_EMBEDDINGS, false),
      baseUrl: env.OBSIDIAN_MCP_EMBEDDING_BASE_URL ?? null,
      apiKey: env.OBSIDIAN_MCP_EMBEDDING_API_KEY ?? null,
      model: env.OBSIDIAN_MCP_EMBEDDING_MODEL ?? null,
      provider: env.OBSIDIAN_MCP_EMBEDDING_PROVIDER ?? "openai-compatible"
    }
  };
}

export async function resolveRuntimeConfig(config: ServerConfig, bridge: BridgeClient): Promise<ServerConfig & { dbPath: string }> {
  const status = await bridge.status();
  if (status.search) {
    const saved = await bridge.searchConfig();
    const overrides = new Set(config.embeddingOverrides ?? []);
    config = { ...config, toolProfile: config.toolProfile ?? status.toolProfile ?? "full", embeddings: {
      ...config.embeddings,
      enabled: overrides.has("OBSIDIAN_MCP_EMBEDDINGS") ? config.embeddings.enabled : saved.enabled,
      baseUrl: overrides.has("OBSIDIAN_MCP_EMBEDDING_BASE_URL") ? config.embeddings.baseUrl : saved.baseUrl,
      model: overrides.has("OBSIDIAN_MCP_EMBEDDING_MODEL") ? config.embeddings.model : saved.model,
      apiKey: overrides.has("OBSIDIAN_MCP_EMBEDDING_API_KEY") ? config.embeddings.apiKey : saved.apiKey
    } };
  }
  const autoPruneEmbeddings =
    config.autoPruneEmbeddingsSource === "env" ? config.autoPruneEmbeddings : status.autoPruneEmbeddings;
  if (config.dbPath) {
    return { ...config, dbPath: config.dbPath, autoPruneEmbeddings };
  }

  const dbPath = status.pluginDirectory.defaultDatabasePath;
  if (!dbPath) {
    throw new Error(
      "Could not discover the Obsidian plugin folder for SQLite storage. Keep Obsidian open on desktop, enable the MCP Vault Bridge plugin, or set OBSIDIAN_MCP_DB explicitly."
    );
  }

  return { ...config, dbPath, dbPathSource: "bridge", autoPruneEmbeddings };
}

function expandHome(path: string): string {
  if (path === "~") {
    return process.env.HOME ?? path;
  }
  if (path.startsWith("~/")) {
    return join(process.env.HOME ?? "~", path.slice(2));
  }
  return path;
}

function clampNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function parseEnabled(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.toLowerCase().trim();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}
