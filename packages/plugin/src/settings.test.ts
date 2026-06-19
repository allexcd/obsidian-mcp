import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSystemAdapter } from "obsidian";
import path from "node:path";
import type ObsidianMcpPlugin from "./main.js";
import { buildClientConfig, resolveClientNodeCommand, resolveRuntimeCommand } from "./settings.js";

describe("runtime command resolution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("finds node through macOS manager fallback paths when Obsidian has a bare PATH", async () => {
    vi.stubEnv("HOME", "/Users/alex");
    vi.stubEnv("SHELL", "/bin/zsh");
    vi.stubGlobal("window", {
      require: (moduleName: string) => {
        if (moduleName !== "child_process") {
          throw new Error(`Unexpected module ${moduleName}`);
        }
        return { execFile };
      }
    });

    const execFile = vi.fn((command: string, args: readonly string[], _options: unknown, callback: ExecCallback) => {
      if (command === "node") {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        callback(error, "", "");
        return;
      }

      expect(command).toBe("/bin/zsh");
      expect(args[0]).toBe("-lc");
      const script = String(args[1]);
      expect(script).toContain("$HOME/.nvm/versions/node");
      expect(script).toContain("nvm_current=\"$(nvm current 2>/dev/null || true)\"");
      expect(script).toContain("append_path \"$node_bin\"");
      expect(script).toContain("/opt/homebrew/bin");
      expect(script).not.toContain("prepend_path \"$node_bin\"");
      expectLineBefore(script, "[ -n \"${NVM_BIN:-}\" ]", "find \"$HOME/.nvm/versions/node\"");
      expectLineBefore(script, "[ -n \"${VOLTA_HOME:-}\" ]", "find \"$HOME/.volta/tools/image/node\"");
      expectLineBefore(script, "asdf which \"$command_name\"", "find \"$HOME/.asdf/installs/nodejs\"");
      expectLineBefore(script, "fnm_current=\"$(fnm current 2>/dev/null || true)\"", "find \"$fnm_root/node-versions\"");
      expectLineBefore(script, "mise which \"$command_name\"", "find \"$HOME/.local/share/mise/installs/node\"");
      expectLineBefore(script, "brew shellenv", "for brew_root in /opt/homebrew /usr/local /opt/local");
      callback(
        null,
        [
          "__OBSIDIAN_MCP_COMMAND__=/Users/alex/.nvm/versions/node/v24.14.1/bin/node",
          "__OBSIDIAN_MCP_PATH__=/Users/alex/.nvm/versions/node/v24.14.1/bin:/usr/bin:/bin",
          "v24.14.1"
        ].join("\n"),
        ""
      );
    });

    const status = await resolveRuntimeCommand(createPlugin(), "node", ["--version"], "");

    expect(status).toMatchObject({
      ok: true,
      command: "/Users/alex/.nvm/versions/node/v24.14.1/bin/node",
      source: "shell",
      envPath: "/Users/alex/.nvm/versions/node/v24.14.1/bin:/usr/bin:/bin"
    });
    expect(status.detail).toContain("v24.14.1");
  });

  it("uses the resolved node command in copied MCP client config", () => {
    const config = JSON.parse(
      buildClientConfig(createPlugin(), false, "/Users/alex/.nvm/versions/node/v24.14.1/bin/node")
    ) as ClientConfig;

    expect(config.mcpServers["obsidian-vault"].command).toBe("/Users/alex/.nvm/versions/node/v24.14.1/bin/node");
  });

  it("prefers an absolute shell-resolved node for MCP client configs", async () => {
    vi.stubEnv("HOME", "/Users/alex");
    vi.stubEnv("SHELL", "/bin/zsh");
    vi.stubGlobal("window", {
      require: (moduleName: string) => {
        if (moduleName !== "child_process") {
          throw new Error(`Unexpected module ${moduleName}`);
        }
        return { execFile };
      }
    });

    const execFile = vi.fn((command: string, args: readonly string[], _options: unknown, callback: ExecCallback) => {
      expect(command).toBe("/bin/zsh");
      expect(args[0]).toBe("-lc");
      callback(
        null,
        [
          "__OBSIDIAN_MCP_COMMAND__=/Users/alex/.nvm/versions/node/v24.14.1/bin/node",
          "__OBSIDIAN_MCP_PATH__=/Users/alex/.nvm/versions/node/v24.14.1/bin:/usr/bin:/bin",
          "v24.14.1"
        ].join("\n"),
        ""
      );
    });

    const status = await resolveClientNodeCommand(createPlugin());

    expect(status.command).toBe("/Users/alex/.nvm/versions/node/v24.14.1/bin/node");
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("prefers a Node command that can load the installed SQLite runtime", async () => {
    vi.stubEnv("HOME", "/Users/alex");
    vi.stubEnv("SHELL", "/bin/zsh");
    vi.stubGlobal("window", {
      require: (moduleName: string) => {
        if (moduleName === "child_process") {
          return { execFile };
        }
        if (moduleName === "fs/promises") {
          return { access: vi.fn(() => Promise.resolve()) };
        }
        if (moduleName === "path") {
          return path;
        }
        throw new Error(`Unexpected module ${moduleName}`);
      }
    });

    const execFile = vi.fn((command: string, args: readonly string[], _options: unknown, callback: ExecCallback) => {
      if (command === "/bin/zsh") {
        callback(
          null,
          [
            "__OBSIDIAN_MCP_COMMAND__=/Users/alex/.nvm/versions/node/v24.14.1/bin/node",
            "__OBSIDIAN_MCP_PATH__=/Users/alex/.nvm/versions/node/v24.14.1/bin:/Users/alex/.nvm/versions/node/v20.20.2/bin:/usr/bin:/bin",
            "v24.14.1"
          ].join("\n"),
          ""
        );
        return;
      }

      if (command === "/Users/alex/.nvm/versions/node/v24.14.1/bin/node") {
        const error = new Error("native module mismatch") as NodeJS.ErrnoException;
        callback(error, "", "NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 137.");
        return;
      }

      expect(command).toBe("/Users/alex/.nvm/versions/node/v20.20.2/bin/node");
      expect(args[0]).toBe("-e");
      callback(null, "v20.20.2 abi 115", "");
    });

    const status = await resolveClientNodeCommand(createPluginWithFilesystemVault());

    expect(status.command).toBe("/Users/alex/.nvm/versions/node/v20.20.2/bin/node");
    expect(status.detail).toContain("SQLite-compatible");
  });
});

type ExecCallback = (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;

interface ClientConfig {
  mcpServers: {
    "obsidian-vault": {
      command: string;
    };
  };
}

function createPlugin(): ObsidianMcpPlugin {
  return {
    app: {
      vault: {
        adapter: {},
        configDir: "config-dir"
      }
    },
    settings: {
      port: 27125,
      nodeCommandOverride: "",
      npmCommandOverride: ""
    }
  } as ObsidianMcpPlugin;
}

function createPluginWithFilesystemVault(): ObsidianMcpPlugin {
  const adapter = new FileSystemAdapter();
  adapter.getBasePath = () => "/Users/alex/Vault";
  return {
    app: {
      vault: {
        adapter,
        configDir: [".", "obsidian"].join("")
      }
    },
    manifest: {
      id: "mcp-vault-bridge"
    },
    settings: {
      port: 27125,
      nodeCommandOverride: "",
      npmCommandOverride: ""
    }
  } as unknown as ObsidianMcpPlugin;
}

function expectLineBefore(script: string, earlier: string, later: string): void {
  expect(script).toContain(earlier);
  expect(script).toContain(later);
  expect(script.indexOf(earlier)).toBeLessThan(script.indexOf(later));
}
