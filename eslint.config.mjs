import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import globals from "globals";
import obsidianmd from "eslint-plugin-obsidianmd";
import json from "@eslint/json";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores([
    "node_modules/**", "dist/**", "coverage/**", "artifacts/**", "test-vault/**",
    "main.js", "build-meta.json", "package-lock.json",
  ]),
  {
    files: ["src/**/*.ts"],
    extends: obsidianmd.configs.recommended,
  },
  {
    files: ["tests/**/*.ts", "harness/**/*.ts", "vitest.config.ts"],
    extends: tseslint.configs.recommendedTypeChecked,
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["*.json"],
    plugins: { json },
    language: "json/json",
    extends: ["json/recommended"],
  },
  {
    files: ["**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{ group: ["node:*", "electron"], message: "Runtime must work on mobile." }],
      }],
    },
  },
);
