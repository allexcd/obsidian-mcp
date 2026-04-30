# Contributing

Thanks for taking the time to contribute. This project follows a small set of conventions so the history stays readable and CI stays predictable.

## Local setup

```bash
git clone https://github.com/allexcd/obsidian-mcp.git
cd obsidian-mcp
npm install
```

`npm install` runs `git config core.hooksPath .githooks` automatically (via the `prepare` script), which activates the pre-push hook.

## Conventions

### Branch names

```
<type>/<short-description>
```

- `type` is one of: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `hotfix`
- `short-description` is lowercase with hyphens

Examples:

- `feat/add-token-rotation`
- `fix/embedding-batch-overflow`
- `docs/clarify-runtime-install`

`main` is protected; nothing is pushed directly to it. Release branches (`release/X.Y.Z`) are created by the release script and exempt from the type-prefix rule.

### Commit subjects

```
<type>(<scope>): [TICKET-123] - <short description>
```

- `type` from the same set as branch names.
- Scope and ticket are optional.
- Subject is **≤50 characters**, lowercase, no trailing period.

Examples:

- `feat(plugin): add audit log retention setting`
- `fix(server): handle empty embedding response`
- `chore: bump esbuild to 0.25.4`

The pre-push hook validates both the branch name and every commit subject pushed. If you really need to bypass it once: `git push --no-verify`.

### PR titles

Same format as commit subjects. The `pr-title` workflow checks them on every PR.

## Running checks locally

```bash
npm run lint        # eslint
npm run typecheck   # tsc -b
npm test            # vitest
npm run build       # full build + plugin bundle + zip
```

Run all four before pushing if your change crosses package boundaries. The pre-push hook does not run these (it only checks naming) — CI does.

## Cutting a release

Releases are version-controlled and gated through PRs. Never tag manually.

```bash
git checkout main
git pull
npm run release
```

The script:

1. Confirms a clean `main` branch.
2. Asks for `patch | minor | major`.
3. Creates `release/X.Y.Z` (no `v` prefix; matches the Obsidian tag convention).
4. Bumps `package.json`, `package-lock.json`, `manifest.json`, `packages/plugin/manifest.json`, and appends to `versions.json`.
5. Runs `npm run build` to confirm the bundle still produces a clean zip.
6. Commits, pushes, and opens a PR.

After the PR is merged, the `Tag and Release` workflow:

1. Tags `X.Y.Z` (read from `manifest.json`).
2. Creates a GitHub Release with auto-generated notes.
3. Uploads four assets: `main.js`, `manifest.json`, `styles.css`, and `mcp-vault-bridge-X.Y.Z.zip`.

The first three are required by the [Obsidian Community Plugins submission rules](https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins). The zip is a convenience for drop-in installs.

## Submitting to the Obsidian Community Plugins directory

Once a release is shipped and field-tested, submit a PR to [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases) adding an entry to `community-plugins.json`:

```json
{
  "id": "mcp-vault-bridge",
  "name": "Obsidian MCP",
  "author": "allexcd",
  "description": "Read-only, exclusion-based local bridge for using an Obsidian vault through MCP clients.",
  "repo": "allexcd/obsidian-mcp"
}
```

Obsidian's reviewers will check that `manifest.json` at the repo root matches the latest release tag and that the assets exist at top level — both conditions are guaranteed by the release flow above.
