# Obsidian MCP

[![CI](https://github.com/allexcd/obsidian-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/allexcd/obsidian-mcp/actions/workflows/ci.yml)
[![Release](https://github.com/allexcd/obsidian-mcp/actions/workflows/tag-release.yml/badge.svg)](https://github.com/allexcd/obsidian-mcp/actions/workflows/tag-release.yml)
[![License: MIT](https://img.shields.io/github/license/allexcd/obsidian-mcp)](LICENSE)
[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![Latest release](https://img.shields.io/github/v/release/allexcd/obsidian-mcp?include_prereleases&sort=semver)](https://github.com/allexcd/obsidian-mcp/releases)

This repository contains a secure, read-only developer preview for exposing Obsidian vault knowledge to MCP hosts such as Claude Desktop and LM Studio.

The user-facing artifact is a standalone Obsidian plugin folder named `obsidian-mcp`. That one folder contains everything this project needs at runtime:

- `manifest.json`, `main.js`, and `styles.css`: loaded by Obsidian.
- `mcp-server.cjs`: launched by Claude Desktop or LM Studio.
- `package.json`: pinned runtime dependencies installed from the plugin settings.

Users should install the whole `obsidian-mcp` folder into a vault at:

```text
Your Vault/.obsidian/plugins/obsidian-mcp/
```

Claude Desktop and LM Studio still need to launch a local MCP process, but that process now lives inside the installed plugin folder:

```text
Your Vault/.obsidian/plugins/obsidian-mcp/mcp-server.cjs
```

That means non-technical users should not need this source repository, `npm install`, or a separate server checkout when using a prepared plugin archive.

Developer-preview packaging note: the plugin archive does not include `node_modules`. Users install the SQLite runtime from the plugin settings after enabling the plugin. This requires Node.js 20+, npm, and network access.

## Security Defaults

- No write, delete, shell, command execution, or arbitrary filesystem tools.
- Regular Markdown notes are included by default; users can exclude folders, exact files, or tags in the plugin settings.
- Hidden folders, `.obsidian`, `.trash`, `.git`, and traversal-style paths are always denied.
- Tool output is capped and paginated.
- Embeddings are disabled by default. Enabling a cloud embedding provider may send chunks of notes to that provider.
- No telemetry is included.

Vault text returned through MCP may be processed by the host/model. Claude Desktop runs the MCP server locally, but Claude model calls may be cloud-side. LM Studio can remain local when local chat and embedding models are used.

## Install

For prepared releases, download the plugin zip, unzip it, and copy the complete `obsidian-mcp` folder into:

```text
Your Vault/.obsidian/plugins/obsidian-mcp/
```

Then restart Obsidian or reload community plugins, enable **Obsidian MCP**, open the plugin settings, review the detected folders/files/tags, add exclusions if needed, and copy the generated MCP token.

Before connecting Claude Desktop or LM Studio, click **Check runtime**, then **Install SQLite runtime** in the plugin settings. That button runs `npm install` with pinned runtime dependencies inside the installed plugin folder.

For local development:

```bash
npm install
npm run build
npm test
```

## Obsidian Plugin Developer Install

Fast path:

```bash
npm run plugin:install -- --vault "/absolute/path/to/Test Vault"
```

This builds the standalone plugin folder at `build/obsidian-mcp/` and copies it to:

```text
/absolute/path/to/Test Vault/.obsidian/plugins/obsidian-mcp/
```

The installed folder includes the Obsidian plugin, the MCP server launcher, and pinned runtime dependency metadata. It does not include `node_modules`.

If you prefer manual install, run:

```bash
npm run plugin:bundle
```

Then copy the whole `build/obsidian-mcp/` folder into your vault's `.obsidian/plugins/` folder.

To create a release-style zip from the standalone plugin folder:

```bash
npm run plugin:package
```

The zip is written to `build/`. It does not include `node_modules`; users install runtime dependencies from the plugin settings. If Node.js or npm is missing, the settings screen reports that and users should install Node.js 20 or newer before trying again.

Do not develop or test this plugin against your only copy of a real vault.

## Repository Hygiene

Commit source, docs, scripts, `package-lock.json`, and `LICENSE`. Do not commit generated `build/`, package `dist/` folders, local SQLite indexes, `node_modules`, or local editor/app settings.

## Vault Scope And Exclusions

The plugin scans the vault through Obsidian and shows detected folders, Markdown files, and tags in its settings. Regular Markdown notes are included by default.

Use exclusions when something should never be exposed through MCP:

- **Excluded folders:** hides every note inside a folder, for example `Private` or `Archive/Old`.
- **Excluded files:** hides exact note paths, for example `Inbox/Secret.md`.
- **Excluded tags:** hides notes with a tag, for example `#private` or `#journal`.

After editing exclusions, click **Refresh preview** in the plugin settings to update the included/excluded counts. Then run `refresh_index` from the MCP host so SQLite and embeddings reflect the new scope.

## MCP Server Environment

The MCP adapter reads configuration from environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `OBSIDIAN_MCP_BRIDGE_URL` | `http://127.0.0.1:27125` | Obsidian bridge URL. |
| `OBSIDIAN_MCP_TOKEN` | none | Required bearer token from the plugin settings. |
| `OBSIDIAN_MCP_DB` | plugin folder `index.sqlite` | Optional override for the SQLite cache path. By default, the MCP asks the Obsidian bridge for the installed plugin folder and writes `.obsidian/plugins/obsidian-mcp/index.sqlite`. |
| `OBSIDIAN_MCP_MAX_RESULTS` | `20` | Default result cap for list/search tools. |
| `OBSIDIAN_MCP_EMBEDDINGS` | `off` | Set to `on` to enable embeddings. |
| `OBSIDIAN_MCP_EMBEDDING_BASE_URL` | none | OpenAI-compatible base URL, for example `http://127.0.0.1:1234/v1`. |
| `OBSIDIAN_MCP_EMBEDDING_API_KEY` | none | Optional API key. |
| `OBSIDIAN_MCP_EMBEDDING_MODEL` | none | Embedding model name. |

## Claude Desktop

1. Install the complete standalone `obsidian-mcp` plugin folder into your vault at `.obsidian/plugins/obsidian-mcp/`.
2. Keep Obsidian open with **Obsidian MCP** enabled.
3. In the plugin settings, click **Check runtime**. If SQLite runtime is missing, click **Install SQLite runtime**.
4. Review detected folders/files/tags, add exclusions if needed, and copy the MCP token.
5. Open Claude Desktop settings, go to **Developer**, edit the MCP configuration, and add the server object below.
6. Restart Claude Desktop.

Use absolute paths. Replace the token and paths with your local values.

On macOS and Linux, the path must start with `/`. If it starts with a folder name like `My Drive/...`, Claude Desktop or LM Studio may treat it as relative to their own application folder.

In JSON, do not escape spaces with `\`. A macOS path with spaces should look like this:

```json
"/absolute/path/to/Obsidian Vault/.obsidian/plugins/obsidian-mcp/mcp-server.cjs"
```

not this:

```text
"/absolute/path/to/Obsidian\ Vault/.obsidian/plugins/obsidian-mcp/mcp-server.cjs"
```

On Windows, backslashes must be doubled, or you can use forward slashes:

```json
"C:\\absolute\\path\\to\\Obsidian Vault\\.obsidian\\plugins\\obsidian-mcp\\mcp-server.cjs"
```

The `args` path points to the installed plugin folder inside your vault:

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
        "OBSIDIAN_MCP_TOKEN": "PASTE_TOKEN_FROM_OBSIDIAN_PLUGIN"
      }
    }
  }
}
```

Claude Desktop runs the MCP server locally, but note content returned by tools may be sent to Claude. Exclude private folders, files, or tags before connecting Claude Desktop.

## LM Studio With Embeddings

Embeddings make vault search semantic. Without embeddings, this MCP still uses SQLite full-text search, which is good for exact words and phrases. With embeddings, a local model turns note chunks into vectors, so searches can find related ideas even when the exact words do not match.

Recommended first model: `nomic-ai/nomic-embed-text-v1.5`.

LM Studio's own embedding docs use this model as a starter option, and it works with LM Studio's OpenAI-compatible `/v1/embeddings` endpoint. In the MCP config, the model name is usually `nomic-embed-text-v1.5`, which is the loaded model identifier LM Studio exposes locally.

### 1. Install The Standalone Obsidian Plugin

Copy the complete `obsidian-mcp` plugin folder into your vault at `.obsidian/plugins/obsidian-mcp/`.

For local development from this repository, the fast install command is:

```bash
npm run plugin:install -- --vault "/absolute/path/to/Test Vault"
```

Then in Obsidian:

1. Reload Obsidian or reload community plugins.
2. Enable **Obsidian MCP**.
3. Open the plugin settings.
4. Click **Check runtime**. If SQLite runtime is missing, click **Install SQLite runtime**.
5. Review the detected folders, files, and tags.
6. Add excluded folders, files, or tags if needed.
7. Copy the MCP token.

Keep Obsidian open while using LM Studio. The MCP server talks to the Obsidian plugin through `http://127.0.0.1:27125`.

### 2. Download An Embedding Model In LM Studio

In LM Studio, download an embedding model:

```bash
lms get nomic-ai/nomic-embed-text-v1.5
```

You can also search for `nomic-ai/nomic-embed-text-v1.5` inside LM Studio and download it from the UI.

### 3. Start LM Studio's Local Server

In LM Studio:

1. Load `nomic-embed-text-v1.5` as an embedding model.
2. Start the local server.
3. Use the default server URL unless you changed it:

```text
http://127.0.0.1:1234/v1
```

Quick sanity check:

```bash
curl http://127.0.0.1:1234/v1/models
```

You should see the embedding model listed. If the model identifier is different, use that exact value for `OBSIDIAN_MCP_EMBEDDING_MODEL`.

### 4. Add This To LM Studio `mcp.json`

In LM Studio, open the MCP settings and edit `mcp.json`. Use absolute paths and paste the real token from Obsidian. If your path has spaces, type the spaces normally. Do not write `My\ Drive` in JSON.

If the vault is in Google Drive on macOS, the real absolute path often starts with something like `/Users/USERNAME/Library/CloudStorage/GoogleDrive-ACCOUNT/My Drive/...`. The important part is that the value starts with `/`, not `My Drive`.

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

Then restart or reload MCP servers in LM Studio.

The SQLite database will be created inside the installed Obsidian plugin folder:

```text
/absolute/path/to/Your Vault/.obsidian/plugins/obsidian-mcp/index.sqlite
```

Set `OBSIDIAN_MCP_DB` only if you want to store the index somewhere else.

### 5. Build The Vault Index

Once LM Studio sees the `obsidian-vault` MCP server, ask it to run the index refresh tool:

```text
Use the Obsidian vault tool to refresh the index.
```

The first refresh reads non-excluded notes from Obsidian, chunks them, stores metadata and full-text search data in SQLite, and sends chunks to LM Studio's local embedding endpoint. Embeddings are cached in the SQLite database, so later refreshes are faster unless notes changed.

After that, try:

```text
Search my Obsidian vault for notes related to long-term project risks.
```

or:

```text
Find related notes for Projects/My Project.md.
```

### Troubleshooting LM Studio Embeddings

- **Cannot find module and the path starts with `.lmstudio/extensions/plugins/mcp/...`:** the `args` path is relative. Use the full absolute path to `mcp-server.cjs`. On macOS/Linux it should start with `/`, for example `/absolute/path/to/Obsidian Vault/.obsidian/plugins/obsidian-mcp/mcp-server.cjs`.
- **Cannot find module `better-sqlite3`:** the SQLite runtime is missing. In Obsidian plugin settings, click **Check runtime**, then **Install SQLite runtime**. If that fails, install Node.js 20 or newer and make sure npm is available.
- **`node` command is missing:** install Node.js 20 or newer, or set the MCP host `command` to an absolute path to a Node.js executable.
- **LM Studio says the MCP server is disconnected:** check that `.obsidian/plugins/obsidian-mcp/mcp-server.cjs` exists in your vault by running `npm run plugin:install -- --vault "/absolute/path/to/Your Vault"`.
- **The MCP server cannot reach Obsidian:** keep Obsidian open, enable the plugin, and check that the bridge status says it is running on `127.0.0.1:27125`.
- **Unauthorized errors:** copy a fresh token from the Obsidian plugin settings and paste it into `OBSIDIAN_MCP_TOKEN`.
- **Embedding errors:** confirm LM Studio's local server is running and `curl http://127.0.0.1:1234/v1/models` lists your embedding model.
- **Model not found:** replace `nomic-embed-text-v1.5` with the exact model identifier shown by LM Studio.
- **You want no embeddings yet:** remove `OBSIDIAN_MCP_EMBEDDINGS`, `OBSIDIAN_MCP_EMBEDDING_BASE_URL`, and `OBSIDIAN_MCP_EMBEDDING_MODEL`. The MCP will keep using SQLite full-text search.

References: [LM Studio MCP docs](https://lmstudio.ai/docs/app/mcp/), [LM Studio OpenAI-compatible endpoints](https://lmstudio.ai/docs/developer/openai-compat), and [LM Studio embedding docs](https://lmstudio.ai/docs/python/embedding).

## MCP Tools

- `vault_status`
- `refresh_index`
- `index_status`
- `list_notes`
- `search_vault`
- `read_note`
- `get_note_metadata`
- `get_note_links`
- `related_notes`

Every tool returns JSON text. Note content is explicitly marked as untrusted so hosts should not treat note text as instructions.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch-name and commit-subject conventions, the local development workflow, and how to cut a release. The pre-push hook (activated automatically by `npm install`) enforces those conventions; CI re-checks them on every PR.

## Release

Releases are gated through PRs. Never tag manually.

```bash
git checkout main
git pull
npm run release
```

Pick `patch | minor | major` when prompted. The script bumps every version-carrying file (`package.json`, `manifest.json`, `packages/plugin/manifest.json`, `versions.json`), runs `npm run build`, opens a release PR, and stops. Once the PR is merged, the `Tag and Release` workflow tags `X.Y.Z` (no `v` prefix — Obsidian convention), creates a GitHub Release with auto-generated notes, and uploads four assets:

- `main.js`
- `manifest.json`
- `styles.css`
- `obsidian-mcp-X.Y.Z.zip`

The first three are required by the [Obsidian Community Plugins submission rules](https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins). The zip is a convenience for drop-in installs. See `CONTRIBUTING.md` for the full submission flow.

## License

MIT
