import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * The 操作 popover's two plugin items (§5 M3) are written in three places that no test loads together: the
 * plugin (src/main.ts), the browser harness's stand-in and the README. The jsdom test renders its own copy,
 * so this pins the wording itself — LEV-84 changed one line and found five copies.
 */
const ITEMS = [
  ["マップを検索して呼び出す", "他のマップを挿入する"],
  ["書き出す", "SVG／PNG に保存"],
];

describe("the 操作 popover wording (§5 M3)", () => {
  it.each(["src/main.ts", "harness/browser/main.ts"])("%s passes the items with product-plan's lines", async file => {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    for (const [title, description] of ITEMS) {
      expect(source).toContain(`{ title: ${JSON.stringify(title)}, description: ${JSON.stringify(description)},`);
    }
  });

  it("README's gear row names the same lines", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    const row = readme.split("\n").find(line => line.startsWith("| 歯車 |")) ?? "";
    expect(row).toContain("「Markdown に切り替え（同じタブで本文を開く）」");
    for (const [title, description] of ITEMS) expect(row).toContain(`「${title}（${description}）」`);
  });
});
