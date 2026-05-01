import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@obsidian-mcp/shared": resolve("packages/shared/src/index.ts"),
      "virtual:mcp-server-payload": resolve("packages/plugin/src/test-mcp-server-payload.ts")
    }
  },
  test: {
    include: ["packages/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"]
    }
  }
});
