import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "build");
const outputDir = join(buildDir, "mcp-vault-bridge");
const files = [
  ["manifest.json", "manifest.json"],
  ["packages/plugin/main.js", "main.js"],
  ["packages/plugin/styles.css", "styles.css"]
];

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

for (const [source, destination] of files) {
  const sourcePath = join(root, source);
  await assertFile(sourcePath);
  await copyFile(sourcePath, join(outputDir, destination));
}

console.log(`Community-plugin-shaped Obsidian plugin folder: ${outputDir}`);
console.log("Only manifest.json, main.js, and styles.css are bundled. Runtime files are materialized by the plugin after install.");

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
