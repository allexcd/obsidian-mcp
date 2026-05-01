import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "build");
const pluginDir = join(buildDir, "mcp-vault-bridge");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const archiveName = `mcp-vault-bridge-${packageJson.version}.zip`;
const archivePath = join(buildDir, archiveName);

await assertDirectory(pluginDir, "Bundled plugin directory");
await mkdir(buildDir, { recursive: true });
await rm(archivePath, { force: true });
await run("zip", ["-r", archivePath, "mcp-vault-bridge"], buildDir);

console.log(`Community-plugin-shaped Obsidian plugin archive: ${archivePath}`);
console.log("Archive contains only manifest.json, main.js, and styles.css. Runtime files are materialized by the plugin after install.");

async function assertDirectory(path, label) {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      throw new Error(`${label} is not a directory: ${path}`);
    }
  } catch (error) {
    throw new Error(`${label} does not exist: ${path}`, { cause: error });
  }
}

function run(command, args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit"
    });

    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        rejectRun(
          new Error(
            "The zip command is not available. Install zip, or share the build/mcp-vault-bridge folder directly."
          )
        );
        return;
      }
      rejectRun(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`${command} exited with code ${code}.`));
    });
  });
}
