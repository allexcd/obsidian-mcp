import obsidianmd from "eslint-plugin-obsidianmd";
import { fileURLToPath } from "node:url";

const tsconfigRootDir = fileURLToPath(new URL(".", import.meta.url));

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/build/**",
      "**/dist/**",
      "packages/plugin/main.js",
      "packages/plugin/main.js.map"
    ]
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir
      }
    }
  },
  {
    files: ["packages/mcp-server/**/*.ts", "scripts/**/*.mjs"],
    rules: {
      "obsidianmd/no-nodejs-modules": "off"
    }
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "obsidianmd/ui/sentence-case": "off"
    }
  }
];
