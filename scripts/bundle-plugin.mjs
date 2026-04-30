import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "build");
const outputDir = join(buildDir, "mcp-vault-bridge");
const files = [
  ["manifest.json", "manifest.json"],
  ["packages/plugin/main.js", "main.js"],
  ["packages/plugin/styles.css", "styles.css"],
  ["build/.tmp/mcp-server.cjs", "mcp-server.cjs"]
];
const runtimeDependencies = {
  "better-sqlite3": "12.9.0",
  bindings: "1.5.0",
  "file-uri-to-path": "1.0.0"
};

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

for (const [source, destination] of files) {
  const sourcePath = join(root, source);
  await assertFile(sourcePath);
  await copyFile(sourcePath, join(outputDir, destination));
}

await writeRuntimePackageJson(outputDir);

await writeFile(
  join(outputDir, "README.md"),
  `# Obsidian MCP

This whole folder is the standalone local Obsidian plugin. Copy the complete \`mcp-vault-bridge\` folder into:

\`\`\`text
Your Vault/.obsidian/plugins/mcp-vault-bridge/
\`\`\`

Keep these files together:

- \`manifest.json\`, \`main.js\`, and \`styles.css\` are loaded by Obsidian.
- \`mcp-server.cjs\` is launched by Claude Desktop or LM Studio.
- \`package.json\` pins the runtime dependencies used by the settings install button.

After enabling the plugin in Obsidian, open its settings, click \`Check runtime\`, then click \`Install SQLite runtime\`.
After the runtime is installed, copy the MCP token from settings.

Claude Desktop and LM Studio should run:

\`\`\`text
node /absolute/path/to/Your Vault/.obsidian/plugins/mcp-vault-bridge/mcp-server.cjs
\`\`\`

Use the copied token as \`OBSIDIAN_MCP_TOKEN\`. Keep Obsidian open while the MCP server is in use.
`,
  "utf8"
);

console.log(`Ready-to-install Obsidian plugin folder: ${outputDir}`);
console.log("Runtime node_modules are not bundled. Use the plugin settings install button to download runtime dependencies.");

async function assertFile(path) {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      throw new Error(`${path} is not a file.`);
    }
  } catch (error) {
    throw new Error(`Missing plugin artifact: ${path}. Run npm run plugin:bundle after dependencies are installed.`, {
      cause: error
    });
  }
}

async function writeRuntimePackageJson(directory) {
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "mcp-vault-bridge-runtime",
        version: "0.1.0",
        private: true,
        description: "Runtime dependencies for the Obsidian MCP server bundled inside the Obsidian plugin.",
        dependencies: runtimeDependencies
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}
