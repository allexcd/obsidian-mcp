import { describe, expect, it } from "vitest";
import { materializeRuntimeFiles, runtimePackageJsonText, type RuntimeFs } from "./runtime-files.js";

class MemoryFs implements RuntimeFs {
  readonly files = new Map<string, string>();
  writes = 0;

  async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) {
      throw new Error("missing");
    }
    return value;
  }

  async writeFile(path: string, data: string): Promise<void> {
    this.files.set(path, data);
    this.writes += 1;
  }
}

const path = {
  join: (...parts: string[]) => parts.join("/")
};

describe("runtime file materialization", () => {
  it("writes mcp-server.cjs and package.json when missing", async () => {
    const fs = new MemoryFs();

    const result = await materializeRuntimeFiles("/plugin", fs, path);

    expect(result).toMatchObject({
      mcpServerPath: "/plugin/mcp-server.cjs",
      packageJsonPath: "/plugin/package.json",
      wroteMcpServer: true,
      wrotePackageJson: true
    });
    expect(fs.files.get("/plugin/mcp-server.cjs")).toContain("MCP server launcher");
    expect(fs.files.get("/plugin/package.json")).toBe(runtimePackageJsonText());
  });

  it("rewrites stale mcp-server.cjs without rewriting unchanged package.json", async () => {
    const fs = new MemoryFs();
    fs.files.set("/plugin/mcp-server.cjs", "old");
    fs.files.set("/plugin/package.json", runtimePackageJsonText());

    const result = await materializeRuntimeFiles("/plugin", fs, path);

    expect(result.wroteMcpServer).toBe(true);
    expect(result.wrotePackageJson).toBe(false);
    expect(fs.files.get("/plugin/mcp-server.cjs")).toContain("MCP server launcher");
  });

  it("does not rewrite files that already match", async () => {
    const fs = new MemoryFs();
    await materializeRuntimeFiles("/plugin", fs, path);
    fs.writes = 0;

    const result = await materializeRuntimeFiles("/plugin", fs, path);

    expect(result.wroteMcpServer).toBe(false);
    expect(result.wrotePackageJson).toBe(false);
    expect(fs.writes).toBe(0);
  });
});
