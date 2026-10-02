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
    // MAPPY_AI_DEV_UNLOCK is esbuild's `define` (src/build-flags.d.ts), replaced by a literal in every bundle.
    languageOptions: { globals: { ...nodeOnlyGlobalsOff(), MAPPY_AI_DEV_UNLOCK: "readonly" } },
    rules: {
      "obsidianmd/no-nodejs-modules": "error",
      "obsidianmd/regex-lookbehind": ["error", { isDesktopOnly: false }],
      "no-restricted-imports": ["error", {
        patterns: [{ group: ["node:*", "electron"], message: "Runtime must work on mobile." }],
      }],
      // The guidelines want only errors in the default console; `recommended` also lets warn and debug through.
      // Narrowed where `recommended` wraps `no-console`, so a call is reported once, with the guideline's link.
      "obsidianmd/rule-custom-message": consoleErrorsOnly(),
      "no-restricted-syntax": ["error", ...nodeAccessSelectors()],
    },
  },
  {
    // The one exception (docs/architecture.md §11.1): `loadNode()` takes Node's modules at run time here, and only
    // here. The Node import rules above stay on (this file imports nothing), and so does `recommended`'s
    // `no-restricted-globals` (fetch, localStorage).
    files: ["src/ai/host/node-host.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
);

/**
 * Reaching Node without an import (docs/architecture.md §11.1), which the import rules don't see: `window.require`
 * however it is spelled (`window['require']`, `` window[`require`] ``, `globalThis.require`, through a type cast), the
 * renderer's `process` through a global or a cast, and the module names that only Node or Electron give. A bare
 * `process` is already undefined (`nodeOnlyGlobalsOff`). `vault.process(…)` and `this.process(…)` are Obsidian's and
 * Mappy's own and stay allowed, and so do `fs`/`os`/`path` as strings (`createSvg("path")`): without `require` the name
 * alone reaches nothing. This deters; the proof that the free state stays away from Node is the tests (§11.7). What
 * it cannot see without types: an alias taken first (`const w = window as …; w.process`) and a name built at run
 * time (`Reflect.get(window, 'req' + 'uire')`).
 * `no-restricted-globals` is not used: `recommended` sets it (app, fetch, localStorage), and options given again in a
 * later block would replace that list.
 */
function nodeAccessSelectors() {
  const message = "Node is reached only through loadNode() in src/ai/host/node-host.ts (docs/architecture.md §11.1).";
  const globalObject = "[object.name=/^(window|globalThis|activeWindow|self)$/]";
  const castObject = "[object.type=/^TS(As|NonNull|TypeAssertion|Satisfies)Expression$/]";
  return [
    "MemberExpression[property.name='require'][computed=false]",
    "MemberExpression[computed=true][property.value='require']",
    "MemberExpression[computed=true] > TemplateLiteral.property[expressions.length=0][quasis.0.value.cooked='require']",
    "CallExpression[callee.name='require']",
    `MemberExpression[property.name='process'][computed=false]:matches(${globalObject}, ${castObject})`,
    `MemberExpression[computed=true][property.value='process']:matches(${globalObject}, ${castObject})`,
    `MemberExpression[computed=true]:matches(${globalObject}, ${castObject}) > TemplateLiteral.property[expressions.length=0][quasis.0.value.cooked='process']`,
    // Destructuring takes the name without a member expression: `const { require: r } = window as …`, from anything.
    "ObjectPattern > Property[key.name='require']",
    "ObjectPattern > Property[key.value='require']",
    // `const { process } = window` (or a cast): only from a global name or a cast, as for the member form above.
    `VariableDeclarator:matches([init.name=/^(window|globalThis|activeWindow|self)$/], [init.type=/^TS(As|NonNull|TypeAssertion|Satisfies)Expression$/]) > ObjectPattern > Property[key.name='process']`,
    "Literal[value=/^(child_process|electron|node:.*)$/]",
    "TemplateLiteral[expressions.length=0][quasis.0.value.cooked=/^(child_process|electron|node:.*)$/]",
  ].map(selector => ({ selector, message }));
}
