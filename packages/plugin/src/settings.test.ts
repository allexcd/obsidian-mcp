import { afterEach, describe, expect, it, vi } from "vitest";
import type ObsidianMcpPlugin from "./main.js";
import { resolveRuntimeCommand } from "./settings.js";

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
      expect(script).toContain("/opt/homebrew/bin");
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
});

type ExecCallback = (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;

function createPlugin(): ObsidianMcpPlugin {
  return {
    settings: {
      nodeCommandOverride: "",
      npmCommandOverride: ""
    }
  } as ObsidianMcpPlugin;
}
