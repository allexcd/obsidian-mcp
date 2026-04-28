import esbuild from "esbuild";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "build");
const intermediateDir = join(buildDir, ".tmp");
const target = join(intermediateDir, "mcp-server.cjs");

await mkdir(intermediateDir, { recursive: true });
await esbuild.build({
  entryPoints: [join(root, "packages", "mcp-server", "src", "index.ts")],
  outfile: target,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  minify: true,
  treeShaking: true,
  legalComments: "none",
  external: ["better-sqlite3"],
  logLevel: "info"
});
await chmod(target, 0o755);
await writeFile(
  join(buildDir, "README.md"),
  `# Built Artifacts

- \`obsidian-mcp/\`: complete folder to copy or install into an Obsidian vault as the plugin.
- \`obsidian-mcp-*.zip\`: optional local archives created by \`npm run plugin:package\`.

Claude Desktop and LM Studio should point at \`obsidian-mcp/mcp-server.cjs\` after the plugin folder is installed in a vault.
`,
  "utf8"
);

console.log(`MCP server launcher: ${target}`);
