# Changelog

All notable changes to this project are documented here. Future entries are appended on each release; the GitHub Release for each tag also carries auto-generated notes.

## [Unreleased]

- Add `create_folder` for empty folders, with exclusion checks, write permissions and safe repeated calls. Reload MCP clients to discover the tool.

- Require explicit `rewrite_note` paths and revisions for `create_note(overwrite=true)` on existing notes. Reload MCP clients to pick up updated schemas.
- Add optional operation IDs to all write tools for safe retries within a plugin session; reject conflicting ID reuse and recheck access before replay. Historical receipts cannot roll back the search index.

- Enforce live access checks before returning cached vault results; reconcile exclusions and follow a revisioned Obsidian change feed.
- Synchronize text automatically, process embeddings separately, and report adapter activity and search readiness in Settings.
- Add atomic existing-note edits with optional content-revision conflicts and section/line reads.
- Combine keyword and semantic rankings by rank; deduplicate before pagination, return explicit no-match results, and distinguish sampled overviews from exhaustive analysis.
- Keep embeddings optional, add saved endpoint/model settings and a connection test, preserve environment overrides, and isolate vector caches by endpoint/model/preprocessing.
- Validate vector responses and use model-appropriate Nomic query/document prefixes; standard search survives embedding failures.
- Copy complete client configurations with masked previews, move editing permissions to Vault access, and keep token rotation in Advanced.
- Add compact tool profiles and update setup, search, privacy, and reference documentation.

Upgrade: reload MCP clients after updating the plugin. Existing connection configurations remain supported. Explicit embedding environment variables override saved settings. The changed vector cache identity requires rebuilding embeddings; standard search remains available. No vault-note migration is required.

## [0.1.0] - 2026-04-28

Initial developer-preview release.

- Read-only, exclusion-based bridge from an Obsidian vault to MCP clients (Claude Desktop, LM Studio).
- Per-vault MCP token, stored in Obsidian SecretStorage when available.
- Folder, file, and tag exclusions.
- SQLite cache and optional embeddings via OpenAI-compatible endpoints.
- Standalone plugin folder including `mcp-server.cjs` for the MCP host to launch.
