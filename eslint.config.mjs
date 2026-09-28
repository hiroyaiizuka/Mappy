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

/**
 * Node's globals that the browser doesn't have, and the `NodeJS` namespace `recommended` adds beside them, turned
 * off (a later config's `"off"` removes an earlier global).
 */
function nodeOnlyGlobalsOff() {
  return Object.fromEntries([...Object.keys(globals.node).filter(name => !(name in globals.browser)), "NodeJS"]
    .map(name => [name, "off"]));
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
    files: ["tests/**/*.ts", "*.mts"],
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
    // Root `.mts` files are tool configs (vitest.config.mts): they run in Node, not in the page.
    files: ["*.mts"],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
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
    // `recommended` reads manifest.json and, when `isDesktopOnly` is true, turns off no-nodejs-modules, stops
    // regex-lookbehind reporting and adds Node's globals. Mappy is desktop only for now only because mobile hasn't
    // been tried (LEV-249), not because it may use Node, so these stay on whatever the manifest says
    // (tests/tooling/mobile-lint.test.mjs).
    files: ["src/**/*.ts"],
    languageOptions: { globals: nodeOnlyGlobalsOff() },
    rules: {
      "obsidianmd/no-nodejs-modules": "error",
      "obsidianmd/regex-lookbehind": ["error", { isDesktopOnly: false }],
      "no-restricted-imports": ["error", {
        patterns: [{ group: ["node:*", "electron"], message: "Runtime must work on mobile." }],
      }],
      // The guidelines want only errors in the default console; `recommended` also lets warn and debug through.
      // Narrowed where `recommended` wraps `no-console`, so a call is reported once, with the guideline's link.
      "obsidianmd/rule-custom-message": consoleErrorsOnly(),
    },
  },
);
