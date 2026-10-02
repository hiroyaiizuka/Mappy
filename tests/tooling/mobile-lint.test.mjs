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
