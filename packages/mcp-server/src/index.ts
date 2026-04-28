#!/usr/bin/env node
import { BridgeClient } from "./bridge-client.js";
import { loadConfig, resolveRuntimeConfig } from "./config.js";
import { VaultDatabase } from "./database.js";
import { EmbeddingClient } from "./embeddings.js";
import { VaultIndexer } from "./indexer.js";
import { startMcpServer } from "./mcp.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const bridge = new BridgeClient(config.bridgeUrl, config.token);
  const runtimeConfig = await resolveRuntimeConfig(config, bridge);
  const db = new VaultDatabase(runtimeConfig.dbPath);
  const embeddings = new EmbeddingClient(config.embeddings);
  const indexer = new VaultIndexer(bridge, db, embeddings);

  await startMcpServer({ config: runtimeConfig, bridge, db, embeddings, indexer });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
