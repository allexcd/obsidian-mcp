# Development validation

This record describes development-branch checks performed on 2026-09-09. It is not a blanket compatibility guarantee for every Obsidian, LM Studio, Node, or model version.

## Automated checks

The regression suite has 114 passing tests across 15 files. Typecheck, both lint configurations, and the production build also pass. The suite covers cached-result authorization across all five cached tools, offline authorization, content-revision conflicts, current-content tag checks, synchronization and reconnects, two database connections competing for a lease, alias/phrase/Unicode retrieval, chunk deduplication, rank fusion, post-fusion pagination, explicit semantic-mode fallback, malformed embedding responses, compact profiles, and complete versus masked configurations.

Run:

```bash
npm test
npm run typecheck
npm run lint
npm run lint:obsidian
npm run build
```

## Live checks completed

- Loaded the bundled plugin in a disposable Obsidian vault containing synthetic project, wellbeing, and excluded private notes. The running Obsidian UI reported version 1.13.4.
- Inspected the Setup screen, including access counts, connection components, bridge state, config copying, and activity controls.
- Copied the actual generated configuration through the Settings button; it contained the token and compatible Node executable without manual token editing. The selected Node version was 24.14.1.
- Connected the official MCP TypeScript SDK client to the bundled stdio adapter and verified tool discovery, keyword/alias search, excluded-content absence, a heading read, revision-conflict protection, an external edit becoming searchable, and overview coverage.
- Tested the bundled adapter with LM Studio 0.4.20+1's local embedding endpoint and `text-embedding-nomic-embed-text-v1.5@f32`. The semantic query “burnout and fatigue” ranked the synthetic wellbeing note first and reported readiness.

## Limits of the live checks

The LM Studio chat-host check was attempted but did not complete: API-based MCP invocation was denied by existing LM Studio permissions, and the disposable Obsidian bridge was no longer listening during the UI attempt. Its temporary MCP configuration entry was removed; existing server entries were preserved. Neither this attempt nor a running bridge is recorded as a successful LM Studio chat-tool round trip.

Claude Desktop has not been manually validated for this development version. Its generated configuration follows the existing stdio format, and protocol behavior was checked with the SDK client.

No production vault was modified by the automated smoke-test script. No release was published or version bumped. Screenshots are omitted until a final release UI capture can be taken with all setup states verified.


## Write hardening validation (2026-09-10)

123 tests across 16 files pass, plus typecheck, both lint checks, and the production build. Regression coverage includes explicit rewrite paths after a read, revision-protected create overwrites, concurrent duplicate appends, request ID mismatch, scope and permission changes, receipt eviction/capacity, ambiguous failures, ID forwarding, and preventing historical receipt content from replacing the index. These changes have not been retested interactively in LM Studio. Retry receipts last for the current plugin session only.
