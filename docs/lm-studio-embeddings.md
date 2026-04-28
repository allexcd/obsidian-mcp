# LM Studio with Embeddings

Embeddings make vault search semantic. Without them the MCP uses SQLite full-text search, which matches exact words and phrases. With a local embedding model, searches find related ideas even when the exact words do not appear.

Recommended model: [`nomic-ai/nomic-embed-text-v1.5`](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) — a good default that works with LM Studio's OpenAI-compatible `/v1/embeddings` endpoint.

## 1. Install the plugin

Follow the [main install steps](../README.md#install) first. Make sure the SQLite runtime is installed and the plugin is enabled before continuing.

## 2. Download an embedding model in LM Studio

```bash
lms get nomic-ai/nomic-embed-text-v1.5
```

Or search for `nomic-ai/nomic-embed-text-v1.5` in the LM Studio UI and download from there.

## 3. Start LM Studio's local server

1. Load `nomic-embed-text-v1.5` as an embedding model.
2. Start the local server (default URL: `http://127.0.0.1:1234/v1`).
3. Verify it is running:

```bash
curl http://127.0.0.1:1234/v1/models
```

Note the exact model identifier in the response — use that value for `OBSIDIAN_MCP_EMBEDDING_MODEL` if it differs from `nomic-embed-text-v1.5`.

## 4. Configure LM Studio `mcp.json`

Open the LM Studio MCP settings and edit `mcp.json`. Use the full absolute path to `mcp-server.cjs` and paste the token from Obsidian plugin settings.

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/Your Vault/.obsidian/plugins/obsidian-mcp/mcp-server.cjs"
      ],
      "env": {
        "OBSIDIAN_MCP_BRIDGE_URL": "http://127.0.0.1:27125",
        "OBSIDIAN_MCP_TOKEN": "PASTE_TOKEN_FROM_OBSIDIAN_PLUGIN",
        "OBSIDIAN_MCP_EMBEDDINGS": "on",
        "OBSIDIAN_MCP_EMBEDDING_BASE_URL": "http://127.0.0.1:1234/v1",
        "OBSIDIAN_MCP_EMBEDDING_MODEL": "nomic-embed-text-v1.5"
      }
    }
  }
}
```

> **Paths on macOS/Linux:** use the full path starting with `/`. Spaces are fine in JSON — do not escape them with `\`. If your vault is in Google Drive the real path starts with `/Users/USERNAME/Library/CloudStorage/GoogleDrive-ACCOUNT/My Drive/...`, not `My Drive/...`.

Reload MCP servers in LM Studio after saving.

## 5. Build the vault index

Ask LM Studio to run the index refresh tool:

```text
Use the Obsidian vault tool to refresh the index.
```

The first run reads all included notes, chunks them, stores metadata and full-text data in SQLite, and sends chunks to the embedding endpoint. Embeddings are cached so later refreshes only process changed notes.

After indexing, try:

```text
Search my Obsidian vault for notes related to long-term project risks.
```

```text
Find notes related to Projects/My Project.md.
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `args` path starts with `.lmstudio/extensions/...` | The path is relative. Use the full absolute path to `mcp-server.cjs`. |
| `Cannot find module 'better-sqlite3'` | SQLite runtime is missing. In Obsidian plugin settings: **Check runtime → Install SQLite runtime**. Requires Node.js 20+. |
| `node` command not found | Install Node.js 20+ or set `command` to the absolute path of the `node` executable. |
| MCP server disconnected in LM Studio | Confirm `mcp-server.cjs` exists at the configured path. Run `npm run plugin:install -- --vault "/path/to/vault"` to reinstall. |
| MCP server cannot reach Obsidian | Keep Obsidian open with the plugin enabled. Bridge must be running on `127.0.0.1:27125`. |
| Unauthorized errors | Copy a fresh token from Obsidian plugin settings and update `OBSIDIAN_MCP_TOKEN`. |
| Embedding errors | Confirm LM Studio's local server is running and `curl http://127.0.0.1:1234/v1/models` lists the embedding model. |
| Model not found | Replace `nomic-embed-text-v1.5` with the exact identifier shown by LM Studio. |
| Want to disable embeddings | Remove `OBSIDIAN_MCP_EMBEDDINGS`, `OBSIDIAN_MCP_EMBEDDING_BASE_URL`, and `OBSIDIAN_MCP_EMBEDDING_MODEL`. Full-text search continues to work. |

## References

- [LM Studio MCP docs](https://lmstudio.ai/docs/app/mcp/)
- [LM Studio OpenAI-compatible endpoints](https://lmstudio.ai/docs/developer/openai-compat)
- [LM Studio embedding docs](https://lmstudio.ai/docs/python/embedding)
