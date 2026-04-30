import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vaultPath = resolveVaultPath();
const sourceDir = join(root, "build", "mcp-vault-bridge");
const targetDir = join(vaultPath, ".obsidian", "plugins", "mcp-vault-bridge");

await assertDirectory(vaultPath, "Vault path");
await assertDirectory(sourceDir, "Bundled plugin directory");
await mkdir(join(vaultPath, ".obsidian", "plugins"), { recursive: true });
await rm(targetDir, { recursive: true, force: true });
await cp(sourceDir, targetDir, { recursive: true, force: true });

console.log(`Installed MCP Vault Bridge to: ${targetDir}`);
console.log(`Use this MCP server path in Claude Desktop or LM Studio: ${join(targetDir, "mcp-server.cjs")}`);
console.log("Restart Obsidian or reload community plugins, then enable MCP Vault Bridge.");

function resolveVaultPath() {
  const args = process.argv.slice(2);
  const vaultFlagIndex = args.findIndex((arg) => arg === "--vault" || arg === "-v");
  const flaggedVault = vaultFlagIndex >= 0 ? args[vaultFlagIndex + 1] : null;
  const positionalVault = args.find((arg) => !arg.startsWith("-"));
  const value = flaggedVault ?? process.env.OBSIDIAN_VAULT_PATH ?? process.env.OBSIDIAN_VAULT ?? positionalVault;

  if (!value) {
    console.error("Usage: npm run plugin:install -- --vault /absolute/path/to/YourVault");
    console.error("You can also set OBSIDIAN_VAULT_PATH=/absolute/path/to/YourVault.");
    process.exit(1);
  }

  return resolve(value);
}

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
