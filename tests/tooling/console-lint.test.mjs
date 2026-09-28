import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The plugin guidelines ask that, by default, the developer console shows only errors ("Avoid unnecessary
 * logging to console"). The official `recommended` config lets `warn`, `error` and `debug` through, so
 * eslint.config.mjs narrows `src/` to `console.error` (docs/harness.md「審査要件のチェック項目」, LEV-228) by
 * narrowing the `no-console` that `recommended`'s `obsidianmd/rule-custom-message` wraps.
 *
 * The regression test is the first one: without the narrowing `console.warn` and `console.debug` pass, and with a
 * bare `no-console` added beside `recommended` instead, `console.log` and `console.info` are reported twice. The
 * other two pass with the narrowing reverted too (`recommended` already allows `console.error` and refuses the
 * `Function` constructor); they pin what the narrowing must keep: `console.error` allowed, and the rest of what
 * the same rule wraps.
 *
 * `no-console` reads `console.x(...)` only: `window.console.warn(...)` or `const { warn } = console` pass it, so
 * harness.md keeps the grep beside the lint.
 */
describe("console calls in src/", () => {
  // One instance: each builds the type-aware program the config asks for.
  const eslint = new ESLint({ cwd: fileURLToPath(new URL("../../", import.meta.url)) });
  // An existing file of the TypeScript project: a path outside it fails to parse, and would report nothing.
  const lint = async text => {
    const [result] = await eslint.lintText(text, { filePath: "src/obsidian/document-store.ts" });
    expect(result.messages.filter(message => message.fatal)).toEqual([]);
    return result.messages;
  };
  const consoleReports = messages => messages.filter(message => /console/u.test(message.message));

  it("refuses console.warn, console.debug, console.info and console.log, once each", async () => {
    for (const method of ["warn", "debug", "info", "log"]) {
      const reports = consoleReports(await lint(`export function f(): void { console.${method}("x"); }\n`));
      expect(reports.map(message => message.ruleId), method).toEqual(["obsidianmd/rule-custom-message"]);
    }
  }, 60_000);

  it("keeps console.error", async () => {
    expect(consoleReports(await lint('export function f(): void { console.error("x"); }\n'))).toEqual([]);
  }, 30_000);

  it("still refuses the Function constructor", async () => {
    // Only linted, never run.
    const constructorCall = ["export const f = new ", "Function", '("return 1");\n'].join("");
    const messages = await lint(constructorCall);
    expect(messages.map(message => message.message).join("\n")).toContain("Function` constructor is dangerous");
  }, 30_000);
});
