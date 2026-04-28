# Changelog

All notable changes to this project are documented here. Future entries are appended on each release; the GitHub Release for each tag also carries auto-generated notes.

## [Unreleased]

## [0.1.0] - 2026-04-28

Initial developer-preview release.

- Read-only, exclusion-based bridge from an Obsidian vault to MCP clients (Claude Desktop, LM Studio).
- Per-vault MCP token, stored in Obsidian SecretStorage when available.
- Folder, file, and tag exclusions.
- SQLite cache and optional embeddings via OpenAI-compatible endpoints.
- Standalone plugin folder including `mcp-server.cjs` for the MCP host to launch.
