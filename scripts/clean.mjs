import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = [
  "build",
  "dist",
  ".DS_Store",
  "packages/shared/dist",
  "packages/mcp-server/dist",
  "packages/plugin/dist",
  "packages/plugin/main.js",
  "packages/plugin/main.js.map"
];

for (const path of paths) {
  await rm(join(root, path), { recursive: true, force: true });
}

console.log("Removed generated build artifacts.");
