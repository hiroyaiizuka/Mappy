import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { en } from "../../src/i18n/en.ts";
import { ja } from "../../src/i18n/ja.ts";

/**
 * The 操作 popover's two plugin items (§5 M3) are written in four places that no test loads together: the
 * plugin (src/main.ts) and the browser harness's stand-in, which both name them by their keys in src/i18n since LEV-235, the README and product-plan's M3 paragraph. The jsdom test renders its
 * own copy, so this pins the wording itself — LEV-84 changed one line and found five copies.
 */
const KEYS = [["cmdCallMap", "popCallDesc"], ["popExport", "popExportDesc"]];
const ITEMS = KEYS.map(([title, description]) => [ja[title], ja[description]]);

describe("the 操作 popover wording (§5 M3)", () => {
  it("the Japanese table still says what the docs quote", () => {
    expect(ITEMS).toEqual([["マップを検索して呼び出す", "他のマップを挿入する"], ["書き出す", "SVG／PNG に保存"]]);
    for (const [title, description] of KEYS) expect([en[title], en[description]].every(text => typeof text === "string" && text.length > 0)).toBe(true);
  });

  it.each(["src/main.ts", "harness/browser/main.ts"])("%s passes the items by their keys", async file => {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    for (const [title, description] of KEYS) expect(source).toContain(`{ title: t().${title}, description: t().${description},`);
  });

  it("README's gear row and product-plan's M3 paragraph name the same lines", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    const row = readme.split("\n").find(line => line.startsWith("| 歯車 |")) ?? "";
    const plan = await readFile(new URL("../../docs/product-plan.md", import.meta.url), "utf8");
    const paragraph = plan.split("\n").find(line => line.startsWith("**現在の実装（操作ポップオーバー")) ?? "";
    for (const text of [row, paragraph]) {
      expect(text).toContain(`「${ja.toMarkdown}（${ja.toMarkdownDesc}）」`);
      for (const [title, description] of ITEMS) expect(text).toContain(`「${title}（${description}）」`);
    }
  });
});
