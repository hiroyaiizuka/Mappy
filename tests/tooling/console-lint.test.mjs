import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The plugin guidelines ask that, by default, the developer console shows only errors ("Avoid unnecessary
 * logging to console"). The official `recommended` config lets `warn`, `error` and `debug` through, so
 * eslint.config.mjs narrows `src/` to `console.error` (docs/harness.md「審査要件のチェック項目」, LEV-228).
 * This pins that narrowing: without it, `console.warn` and `console.debug` in `src/` pass the lint.
 */
describe("console calls in src/", () => {
  // One instance: each builds the type-aware program the config asks for.
  const eslint = new ESLint({ cwd: fileURLToPath(new URL("../../", import.meta.url)) });
  const lint = async text => {
    const [result] = await eslint.lintText(text, { filePath: "src/obsidian/document-store.ts" });
    return result.messages.filter(message => message.ruleId === "no-console").length;
  };

  it("refuses console.warn, console.debug, console.info and console.log", async () => {
    for (const method of ["warn", "debug", "info", "log"]) {
      expect(await lint(`export function f(): void { console.${method}("x"); }\n`), method).toBe(1);
    }
  }, 60_000);

  it("keeps console.error", async () => {
    expect(await lint('export function f(): void { console.error("x"); }\n')).toBe(0);
  }, 30_000);
});
