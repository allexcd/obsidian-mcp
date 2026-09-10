# Configuration and tool reference

## Client configuration

Prefer **Copy config** in the plugin settings: it inserts the existing token and a Node executable compatible with the installed SQLite runtime. Visible previews and checked-in examples use a placeholder.

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/Vault/.obsidian/plugins/mcp-vault-bridge/mcp-server.cjs"],
      "env": {
        "OBSIDIAN_MCP_BRIDGE_URL": "http://127.0.0.1:27125",
        "OBSIDIAN_MCP_TOKEN": "PASTE_TOKEN_FROM_OBSIDIAN_PLUGIN"
      }
    }
  }
}
```

Merge the server entry into existing `mcpServers`; do not replace unrelated entries. Each open vault needs its own server key and bridge port. Reload clients after changing connection, search, or tool-profile settings. Do not share an index database between different vaults.

## Environment variables

Explicit embedding variables override the corresponding plugin setting. Omitted variables use plugin defaults; the adapter reports override **names**, not credentials. These values are resolved when the adapter starts.

| Variable | Default / meaning |
|---|---|
| `OBSIDIAN_MCP_BRIDGE_URL` | `http://127.0.0.1:27125` |
| `OBSIDIAN_MCP_TOKEN` | Required token; generated config supplies it. |
| `OBSIDIAN_MCP_DB` | Plugin directory's `index.sqlite`; optional custom cache path. |
| `OBSIDIAN_MCP_MAX_RESULTS` | Default result cap when omitted by the caller; 1–100. |
| `OBSIDIAN_MCP_AUTO_INDEX` | On; reconcile at startup and follow changes. Off is manual text indexing; cached results still require live authorization. |
| `OBSIDIAN_MCP_AUTO_PRUNE_EMBEDDINGS` | Plugin setting; controls routine orphan maintenance. Exclusion enforcement may remove inaccessible cache data regardless. |
| `OBSIDIAN_MCP_TOOL_PROFILE` | Plugin setting: `full` by default, or `compact`. |
| `OBSIDIAN_MCP_EMBEDDINGS` | Plugin setting; off by default. |
| `OBSIDIAN_MCP_EMBEDDING_BASE_URL` | Plugin setting; OpenAI-compatible base URL ending in `/v1`. |
| `OBSIDIAN_MCP_EMBEDDING_MODEL` | Plugin setting; exact embedding model identifier. |
| `OBSIDIAN_MCP_EMBEDDING_API_KEY` | Optional credential, otherwise plugin secret storage. |
| `OBSIDIAN_MCP_EMBEDDING_PROVIDER` | `openai-compatible`; namespace label included in cache identity. |
| `OBSIDIAN_MCP_EMBEDDING_QUERY_PREFIX` | Automatic `search_query: ` for identifiers containing `nomic-embed-text`; otherwise empty. Explicit empty string disables it. |
| `OBSIDIAN_MCP_EMBEDDING_DOCUMENT_PREFIX` | Automatic `search_document: ` for Nomic identifiers; otherwise empty. Explicit empty string disables it. |

If your server applies task prefixes itself, disable automatic prefixes with explicit empty values. Other models may require different prefixes; follow the model author's instructions. Endpoint, model, and prefix changes use a separate vector cache identity. Old vectors are not mixed into the new search space.

## Tools

| Tool | Behavior |
|---|---|
| `vault_status` | Bridge availability, access rules, and index status. |
| `index_status` | Synchronization, semantic readiness, errors, and environment override names. |
| `refresh_index` | Full text reconciliation; automatic background work builds embeddings separately. |
| `prune_embeddings` | Remove orphaned vectors. |
| `ask_vault` | Hybrid evidence retrieval, with standard-search fallback and explicit no-match results. |
| `search_vault` | Select lexical, semantic, or hybrid retrieval. Even explicit semantic mode falls back if unavailable, reporting actual mode and reason. |
| `analyze_vault` | Folder/date-distributed sample with represented/total counts. An overview, not exhaustive synthesis. |
| `list_notes` | Filter indexed metadata by path/title, folder, or tag. |
| `read_note` | Read an exact path; optionally specify `heading` or inclusive, one-based `startLine`/`endLine`. Ambiguous headings require line ranges. Limits and truncation still apply. |
| `get_note_metadata` | Live Obsidian Properties and link metadata. |
| `get_note_links` | Live outlinks, embeds, and backlinks. |
| `related_notes` | Indexed link and tag relationships, checked against current access. |
| `create_note` | Create Markdown; existing-note overwrite requires `expectedRevision`. |
| `append_note` | Append to an existing note. |
| `replace_note_text` | Replace an exact body-text match; ambiguous matches need a zero-based occurrence index. |
| `delete_note_text` | Remove exact text, not the file. |
| `set_note_properties` | Atomically merge Properties, preserving valid existing YAML values; malformed frontmatter is repaired using supplied properties. |
| `rewrite_note` | Whole-note replacement for an explicit rewrite request. |
| `create_base_file` | Structured `.base` authoring with explicit folder/files/tag/custom/vault scope. |

Full profile preserves all tool names. Compact omits `refresh_index`, `prune_embeddings`, and `analyze_vault`, and omits authoring tools when writes are disabled at connection time. Settings-based refresh remains available with automatic indexing. Reload clients after profile/access changes to update the offered tool list; bridge permissions always enforce current write access.

### Evidence and edits

Retrieval returns paths, available headings/line locations, revisions, and truncation information. A bounded `linkedResults` list is labeled separately from direct evidence. Keyword and semantic rankings are fused by rank, deduplicated by note, then paginated. Evidence is capped at approximately 20 KB per response, with `nextOffset` for continuation; overview samples are capped at 20 notes. A changing vault can change subsequent pages.

`read_note` and successful writes return a SHA-256 `revision` of the full note. Pass it as `expectedRevision` on existing-note edits. A stale revision produces `revision_conflict` / HTTP 409 without writing. Older callers may omit it, but then cannot protect against changes since their earlier read. Edits still run against current content atomically. Full-note overwrites through `create_note(overwrite=true)` now require `expectedRevision` and use the same atomic conflict check; prefer `rewrite_note` for existing notes. `rewrite_note` requires an explicit, nonblank path and never falls back to the last-read note.


All seven write tools accept optional `operationId` (1–128 characters). Supply a unique ID for each intended write; retry with the same ID and identical arguments. The plugin serializes writes across adapters and returns the original receipt with `replayed: true` for a recognized retry, without repeating the edit. Reusing an ID for different arguments returns `operation_id_conflict`. A replay is a historical receipt: its content may no longer be current and is not reindexed. Read again before a new edit.

Receipts are shared by clients for the current plugin session and survive bridge restarts, but **not plugin reloads or Obsidian restarts**. Requests without an ID retain legacy behavior and have no retry protection. After a plugin restart or an uncertain result, read the file before deciding whether another edit is needed. The adapter does not automatically retry writes. Access and write permissions are checked before replay; changed exclusion rules invalidate old receipts.

Receipt storage is bounded to 4,096 attempted IDs and 16 MiB of response bodies. Evicted bodies leave tombstones: `operation_result_expired` tells the client to inspect the file, never to repeat the write blindly. At the ID limit, new identified writes are rejected with `operation_capacity` before execution; verify outstanding edits before restarting the plugin. An unexpected failure after an attempted write also leaves a tombstone.

## Synchronization protocol

The authenticated bridge exposes `/sync` with a session epoch, monotonic change revision, policy revision, changed paths, allowed paths, and maintenance-request sequence. The adapter polls every two seconds, coalesces changed paths, reconciles after restart or a cursor gap, and applies incremental changes otherwise. Large or actively changing vaults can take longer than one poll to settle.

`/authorize` validates candidate paths against current content and scope before cached results leave the adapter. `/adapter/report` supplies recent activity and progress to Settings. `/search/config` supplies embedding defaults and credentials to the authenticated local adapter; status responses omit credentials.

SQLite transactions protect note/chunk/FTS mutations. Expiring, heartbeated database leases serialize reconciliation and embedding batches across adapters. Vector inserts ignore chunks deleted while the request was running. Notes and settings are never migrated destructively; derived index structures are created as needed and text is reconciled on connection.
