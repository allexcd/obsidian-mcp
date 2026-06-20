# MCP Vault Bridge

[![CI](https://github.com/allexcd/obsidian-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/allexcd/obsidian-mcp/actions/workflows/ci.yml)
[![Release](https://github.com/allexcd/obsidian-mcp/actions/workflows/tag-release.yml/badge.svg)](https://github.com/allexcd/obsidian-mcp/actions/workflows/tag-release.yml)
[![License: MIT](https://img.shields.io/github/license/allexcd/obsidian-mcp)](LICENSE)
[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![Latest release](https://img.shields.io/github/v/release/allexcd/obsidian-mcp?include_prereleases&sort=semver)](https://github.com/allexcd/obsidian-mcp/releases)

MCP Vault Bridge connects Obsidian to MCP clients such as Claude Desktop and LM Studio. It lets an assistant search, read, summarize, organize, and optionally edit the notes you choose to expose.

The bridge is local, token-protected, and read-only by default.

## Quick Start

1. Install **MCP Vault Bridge** from Obsidian Community Plugins, or download the latest zip from [Releases](https://github.com/allexcd/obsidian-mcp/releases).
2. Enable the plugin in Obsidian.
3. Open the plugin settings.
4. Click **Check runtime**.
5. Click **Install SQLite runtime**.
6. Copy the generated MCP client config from the plugin settings into Claude Desktop, LM Studio, or another MCP host.
7. Restart or reload your MCP client.
8. Ask the client: `Refresh my Obsidian vault index.`

Then try prompts like:

- "What notes do I have in my vault?"
- "Find notes about project planning."
- "Read Projects/Roadmap.md and summarize it."
- "What themes appear across my notes?"

## What It Can Do

- Read and summarize notes.
- List notes by folder, tag, path, or metadata.
- Search note text.
- Answer broad questions across the vault.
- Show links, backlinks, tags, aliases, and related notes.
- Use optional semantic search with local embeddings.
- Use optional write tools to create and edit Markdown notes.
- Create Obsidian Bases (`.base`) for folders, tags, file lists, custom filters, or the whole vault.

## Connect A Client

Prefer the generated config in the Obsidian plugin settings. It includes the correct token, bridge URL, and local runtime path.

Manual config shape:

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/Your Vault/.obsidian/plugins/mcp-vault-bridge/mcp-server.cjs"
      ],
      "env": {
        "OBSIDIAN_MCP_BRIDGE_URL": "http://127.0.0.1:27125",
        "OBSIDIAN_MCP_TOKEN": "PASTE_TOKEN_FROM_OBSIDIAN_PLUGIN"
      }
    }
  }
}
```

Use a full absolute path for `mcp-server.cjs`. Keep Obsidian open while the MCP client is using the vault.

## Main Tools

Most users do not call tools by name. The MCP client chooses them from your prompt.

| Tool | Use it for |
|---|---|
| `vault_status` | Check bridge health, visible note count, exclusions, and detected folders. |
| `refresh_index` | Rebuild the local index after vault or exclusion changes. |
| `index_status` | Check whether the index and embeddings are ready. |
| `ask_vault` | Natural questions, summaries, themes, and broad vault questions. |
| `list_notes` | Folder, tag, path, and metadata lists. |
| `search_vault` | Text search, with semantic search when embeddings are configured. |
| `read_note` | Read one note by exact vault path. |
| `get_note_metadata` | Frontmatter, tags, aliases, links, embeds, and backlinks. |
| `get_note_links` | Outlinks, embeds, and backlinks. |
| `related_notes` | Notes related by links and shared tags. |
| `analyze_vault` | Deeper vault-wide synthesis. |
| `prune_embeddings` | Clean stale embedding cache entries. Usually automatic. |

## Optional Write Tools

Write tools are disabled by default. Enable **Enable write tools** in the Obsidian plugin settings only for MCP clients you trust.

| Tool | Use it for |
|---|---|
| `create_note` | Create a Markdown note. |
| `append_note` | Add Markdown to an existing note. |
| `replace_note_text` | Replace exact body text in an existing note. |
| `delete_note_text` | Delete exact body text in an existing note. |
| `set_note_properties` | Add or update Obsidian Properties/frontmatter. |
| `rewrite_note` | Replace an entire note. |
| `create_base_file` | Create an Obsidian `.base` file. |

Write tools only modify non-excluded Markdown notes and `.base` files. They do not expose file deletion or shell commands.

## Obsidian Bases

Use `create_base_file` for prompts like:

- "Create a base file for the Science folder inside Articles."
- "Create a base for notes tagged `#book`."
- "Create a table for these files with title, author, URL, and date."
- "Create a base in the root of the vault for everything in the vault."

Base behavior to know:

- Every base needs an explicit scope: folder, files, tag, filter, or whole vault.
- If a prompt mentions a folder by name, the client should resolve the real path first with `vault_status` or `list_notes`.
- Folder bases are created inside the resolved folder by default. `Articles/Science` becomes `Articles/Science/Science.base`.
- Missing folders are created only when the request clearly asks for a new folder.
- Generated bases exclude `.base` files by default so a base does not list itself.
- Columns, filters, sorting, formulas, summaries, and views can be translated into the generated `.base` file.

## Privacy Basics

- Read-only by default.
- Token-gated local bridge on `127.0.0.1`.
- User-configured excluded folders, files, and tags are hidden from tools.
- Hidden folders, `.obsidian`, `.trash`, `.git`, and path traversal are always blocked.
- No telemetry.

MCP hosts may send tool results to their model. Claude Desktop runs the MCP server locally, but Claude model calls are cloud-side. LM Studio can remain fully local when both chat and embeddings use local models.

See [Security Notes](docs/security.md) for more detail.

## Exclusions And Indexing

Regular Markdown notes are included by default. In plugin settings, you can exclude:

- folders,
- exact file paths,
- tags.

After changing exclusions, click **Refresh preview** in Obsidian, then ask your MCP client to run `refresh_index`.

The SQLite index is a rebuildable cache. Your Obsidian notes remain the source of truth.

## Optional Semantic Search

Without embeddings, search uses local SQLite full-text search. This is fast and works well for exact words, titles, folders, tags, and phrases.

With embeddings, search can also find related ideas when the same words are not used. Local LM Studio embeddings are a good privacy-preserving setup.

See [LM Studio with embeddings](docs/lm-studio-embeddings.md) for setup.

## Troubleshooting

| Problem | Check |
|---|---|
| Client cannot connect | Obsidian is open, plugin is enabled, bridge URL is `http://127.0.0.1:27125`. |
| Unauthorized error | Copy a fresh token from plugin settings. |
| `mcp-server.cjs` missing | Rebuild or reinstall the plugin, then run **Check runtime**. |
| `better-sqlite3` error | Click **Install SQLite runtime**. |
| `node` not found | Install Node.js 20+ or use the absolute Node path shown in settings. |
| Search looks stale | Run `refresh_index`. |
| A note is missing | Check exclusions, refresh preview, then refresh the index. |
| Write request fails | Enable write tools and confirm the path is not excluded. |

## Environment Variables

Most users only need the generated client config. These variables are available for manual setups:

| Variable | Description |
|---|---|
| `OBSIDIAN_MCP_BRIDGE_URL` | Local Obsidian bridge URL. Default: `http://127.0.0.1:27125`. |
| `OBSIDIAN_MCP_TOKEN` | Required bearer token from plugin settings. |
| `OBSIDIAN_MCP_DB` | Optional SQLite cache path override. |
| `OBSIDIAN_MCP_MAX_RESULTS` | Default result cap for list and search tools. |
| `OBSIDIAN_MCP_AUTO_PRUNE_EMBEDDINGS` | Override automatic stale embedding pruning. |
| `OBSIDIAN_MCP_EMBEDDINGS` | Set to `on` to enable semantic search. |
| `OBSIDIAN_MCP_EMBEDDING_BASE_URL` | OpenAI-compatible embedding endpoint. |
| `OBSIDIAN_MCP_EMBEDDING_API_KEY` | Optional API key for the embedding endpoint. |
| `OBSIDIAN_MCP_EMBEDDING_MODEL` | Embedding model name. |

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
npm run lint
npm run lint:obsidian
```

Install a development build into a local vault:

```bash
npm run plugin:install -- --vault "/absolute/path/to/Test Vault"
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch conventions and release steps.

## License

MIT
