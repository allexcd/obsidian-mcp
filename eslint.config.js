import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

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
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: { ...globals.node }
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off"
    }
  },
  {
    files: ["packages/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }
      ],
      "@typescript-eslint/no-explicit-any": "off"
    }
  },
  {
    files: ["packages/**/*.test.ts", "packages/**/__tests__/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node }
    }
  }
];
