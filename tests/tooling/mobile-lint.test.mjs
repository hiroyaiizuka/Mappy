import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * eslint-plugin-obsidianmd's `recommended` reads manifest.json: with `isDesktopOnly: true` it turns
 * `obsidianmd/no-nodejs-modules` off, stops `obsidianmd/regex-lookbehind` reporting, and adds Node's globals
 * (`process`, `Buffer`, `require`...). LEV-249 set `isDesktopOnly: true` because mobile hadn't been tried, and on
 * 2026-10-02 the owner decided Mappy stays desktop only (docs/community-submission.md §4.4). Neither means Mappy may
 * use Node (AGENTS.md: the runtime stays browser-compatible), which is why the Node module and global checks stay on;
 * regex-lookbehind guards old iOS WebKit and stays on as it was (see eslint.config.mjs). So eslint.config.mjs keeps
 * the three checks on for `src/` whatever the manifest says, and this pins them. Without that block, all three cases fail while the manifest says `true`.
 */
describe("mobile-safety lint in src/ does not follow isDesktopOnly", () => {
  // One instance: each builds the type-aware program the config asks for.
  const eslint = new ESLint({ cwd: fileURLToPath(new URL("../../", import.meta.url)) });
  // An existing file of the TypeScript project: a path outside it fails to parse, and would report nothing.
  const lint = async text => {
    const [result] = await eslint.lintText(text, { filePath: "src/obsidian/document-store.ts" });
    expect(result.messages.filter(message => message.fatal)).toEqual([]);
    return result.messages.map(message => message.ruleId);
  };

  it("refuses a Node built-in module without the node: prefix", async () => {
    expect(await lint('import { readFileSync } from "fs";\nexport const read = readFileSync;\n'))
      .toContain("obsidianmd/no-nodejs-modules");
  }, 60_000);

  it("refuses a regular expression lookbehind (iOS before 16.4)", async () => {
    expect(await lint("export const pattern = /(?<=x)y/u;\n")).toContain("obsidianmd/regex-lookbehind");
  }, 30_000);

  it("does not know Node's globals", async () => {
    expect(await lint("export const platform: unknown = process.platform;\n")).toContain("no-undef");
  }, 30_000);
});

/**
 * The one way to Node (docs/architecture.md §11.1): `loadNode()` in src/ai/host/node-host.ts. Elsewhere in `src/`,
 * including the rest of src/ai/host/, every spelling of `window.require`, the renderer's `process` through a global or
 * a cast, and Node's and Electron's module names are refused by `no-restricted-syntax`; Obsidian's `vault.process`,
 * Mappy's own `process` method and `createSvg("path")` are not. What the lint cannot see (an alias taken first, a name
 * built at run time) is left to the tests of §11.7, as eslint.config.mjs says. The exception covers that one file and
 * drops nothing `recommended` forbids there (`fetch`). Without the block in eslint.config.mjs every "refuses" case fails.
 */
describe("Node is reached only from src/ai/host/node-host.ts", () => {
  const eslint = new ESLint({ cwd: fileURLToPath(new URL("../../", import.meta.url)) });
  const lint = async (text, filePath) => {
    const [result] = await eslint.lintText(text, { filePath });
    expect(result.messages.filter(message => message.fatal)).toEqual([]);
    return result.messages.map(message => message.ruleId);
  };
  const other = "src/ai/host/cli-process.ts";
  const host = "src/ai/host/node-host.ts";
  const tick = "`";

  const refused = {
    "window.require": "export const take = (window as unknown as { require(id: string): unknown }).require;\n",
    "a cast's require call": "type W = { require(id: string): unknown };\nexport const take = (window as unknown as W).require('os');\n",
    "window['require']": "export const take: unknown = (window as unknown as Record<string, unknown>)['require'];\n",
    "window[`require`]": `export const take: unknown = (window as unknown as Record<string, unknown>)[${tick}require${tick}];\n`,
    "globalThis.require": "export const take: unknown = (globalThis as unknown as { require: unknown }).require;\n",
    "activeWindow.require": "export const take: unknown = (activeWindow as unknown as { require: unknown }).require;\n",
    "a bare require()": "declare const require: (id: string) => unknown;\nexport const os = require('os');\n",
    "window.process": "export const env: unknown = (window as unknown as { process: { env: unknown } }).process.env;\n",
    "(window as …).process": "type W = { process: { pid: number } };\nexport const pid = (window as unknown as W).process.pid;\n",
    "window['process']": "export const p: unknown = (window as unknown as Record<string, unknown>)['process'];\n",
    "a destructured require": "const { require: take } = window as unknown as { require(id: string): unknown };\nexport const os = take('os');\n",
    "a destructured process": "const { process: p } = window as unknown as { process: { env: unknown } };\nexport const env = p.env;\n",
    "the string 'child_process'": "export const name = 'child_process';\n",
    "the template `child_process`": `export const name = ${tick}child_process${tick};\n`,
    "the string 'electron'": "export const name = 'electron';\n",
    "a node: module name": "export const name = 'node:fs';\n",
  };
  for (const [name, text] of Object.entries(refused)) {
    it(`refuses ${name} outside node-host.ts`, async () => {
      expect(await lint(text, other)).toContain("no-restricted-syntax");
    }, 60_000);
  }

  it("leaves Obsidian's vault.process, a class's own process method and createSvg(\"path\") alone", async () => {
    const text = [
      "declare const vault: { process(file: unknown, fn: (data: string) => string): Promise<string> };",
      "declare function createSvg(tag: string): unknown;",
      "class Embeds { process(source: string): string { return source; } run(): string { return this.process('x'); } }",
      "export const done = vault.process(null, data => data);",
      "export const svg = createSvg(\"path\");",
      "export const embeds = new Embeds().run();",
      "export const names = ['fs', 'os', 'path'];",
      "",
    ].join("\n");
    expect(await lint(text, other)).not.toContain("no-restricted-syntax");
  }, 60_000);

  it("allows window.require and window.process in node-host.ts", async () => {
    const text = "type W = { require(id: string): unknown; process: unknown };\nexport const cp = (window as unknown as W).require('child_process');\nexport const p = (window as unknown as W).process;\n";
    expect(await lint(text, host)).not.toContain("no-restricted-syntax");
  }, 60_000);

  it("still refuses a bare fetch and a Node import in node-host.ts", async () => {
    expect(await lint("export const get = fetch('https://example.com');\n", host)).toContain("no-restricted-globals");
    expect(await lint('import { readFileSync } from "fs";\nexport const read = readFileSync;\n', host)).toContain("obsidianmd/no-nodejs-modules");
  }, 60_000);
});
