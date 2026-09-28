import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import globals from "globals";
import obsidianmd from "eslint-plugin-obsidianmd";
import json from "@eslint/json";
import tseslint from "typescript-eslint";

/**
 * `recommended`'s `obsidianmd/rule-custom-message` for TypeScript, with its wrapped `no-console` allowing only
 * `error`. Taken from the installed plugin's config rather than restated, so whatever else `recommended` wraps
 * there (today `no-new-func`) stays as that version has it. The wrapper drops a report its message table doesn't
 * name, so the table is rekeyed to the message `no-console` gives for the narrower list; if a new version words
 * it differently, tests/tooling/console-lint.test.mjs fails rather than the calls going unreported.
 */
function consoleErrorsOnly() {
  const entry = obsidianmd.configs.recommended
    .find(config => config.files?.includes("**/*.{ts,cts,mts,tsx}") && config.rules?.["obsidianmd/rule-custom-message"])
    ?.rules["obsidianmd/rule-custom-message"];
  const [severity, wrapped] = Array.isArray(entry) ? entry : [];
  if (!wrapped?.["no-console"]) {
    throw new Error("eslint-plugin-obsidianmd's recommended no longer wraps no-console for TypeScript: revisit eslint.config.mjs");
  }
  const messages = Object.fromEntries(Object.entries(wrapped["no-console"].messages)
    .map(([original, custom]) => [original.replace(/allowed: .*\.$/u, "allowed: error."), custom]));
  return [severity, { ...wrapped, "no-console": { ...wrapped["no-console"], messages, options: [{ allow: ["error"] }] } }];
}

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
    // The English table is the one `recommended` leaves out: this rule sits only in `recommendedWithLocalesEn`
    // (docs/architecture.md §9e). It reads the plain strings, not the functions that splice values in.
    files: ["src/i18n/en.ts"],
    plugins: { obsidianmd },
    rules: {
      // Only `ignoreWords` extends the defaults; passing `brands` or `acronyms` replaces the built-in lists (Markdown, SVG...).
      "obsidianmd/ui/sentence-case-locale-module": ["error", { ignoreWords: ["ATX", "H2", "Enter", "Tab", "F2", "MB"] }],
    },
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
      // The guidelines want only errors in the default console; `recommended` also lets warn and debug through.
      // Narrowed where `recommended` wraps `no-console`, so a call is reported once, with the guideline's link.
      "obsidianmd/rule-custom-message": consoleErrorsOnly(),
    },
  },
);
