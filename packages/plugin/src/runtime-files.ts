import { MCP_SERVER_CJS } from "virtual:mcp-server-payload";

export const RUNTIME_DEPENDENCIES = {
  "better-sqlite3": "12.9.0",
  bindings: "1.5.0",
  "file-uri-to-path": "1.0.0"
};

export interface RuntimeFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
}

export interface RuntimePath {
  join(...paths: string[]): string;
}

export interface RuntimeMaterializationResult {
  mcpServerPath: string;
  packageJsonPath: string;
  wroteMcpServer: boolean;
  wrotePackageJson: boolean;
}

export async function materializeRuntimeFiles(
  pluginDirectory: string,
  fs: RuntimeFs,
  path: RuntimePath,
  version = "0.0.0"
): Promise<RuntimeMaterializationResult> {
  if (!MCP_SERVER_CJS.trim()) {
    throw new Error("The embedded MCP server payload is empty. Rebuild the plugin package.");
  }

  const mcpServerPath = path.join(pluginDirectory, "mcp-server.cjs");
  const packageJsonPath = path.join(pluginDirectory, "package.json");
  const wroteMcpServer = await writeIfChanged(fs, mcpServerPath, MCP_SERVER_CJS);
  const wrotePackageJson = await writeIfChanged(fs, packageJsonPath, runtimePackageJsonText(version));

  return {
    mcpServerPath,
    packageJsonPath,
    wroteMcpServer,
    wrotePackageJson
  };
}

export function runtimePackageJsonText(version = "0.0.0"): string {
  return `${JSON.stringify(
    {
      name: "mcp-vault-bridge-runtime",
      version,
      private: true,
      description: "Runtime dependencies for the MCP Vault Bridge server materialized by the Obsidian plugin.",
      dependencies: RUNTIME_DEPENDENCIES
    },
    null,
    2
  )}\n`;
}

async function writeIfChanged(fs: RuntimeFs, filePath: string, contents: string): Promise<boolean> {
  try {
    const existing = await fs.readFile(filePath, "utf8");
    if (existing === contents) {
      return false;
    }
  } catch {
    // Missing or unreadable files are repaired by writing the known-good payload.
  }

  await fs.writeFile(filePath, contents, "utf8");
  return true;
}
