import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * The 操作 popover's two plugin items (§5 M3) are written in four places that no test loads together: the
 * plugin (src/main.ts), the browser harness's stand-in, the README and product-plan's M3 paragraph. The
 * jsdom test renders its own copy, so this pins the wording itself — LEV-84 changed one line and found five copies.
 */
const ITEMS = [
  ["マップを検索して呼び出す", "他のマップを挿入する"],
  ["書き出す", "SVG／PNG に保存"],
];

describe("the 操作 popover wording (§5 M3)", () => {
  it.each(["src/main.ts", "harness/browser/main.ts"])("%s passes the items with the same lines", async file => {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    for (const [title, description] of ITEMS) {
      expect(source).toContain(`{ title: ${JSON.stringify(title)}, description: ${JSON.stringify(description)},`);
    }
  });

  // LEV-227: README.md is English and README.ja.md Japanese. The English lines are LEV-235's proposal; once
  // src/main.ts names the items by their keys in src/i18n/en.ts, read them from there instead of repeating them.
  it("the English README's gear row names the same items in English", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    const row = readme.split("\n").find(line => line.startsWith("| Gear |")) ?? "";
    for (const [title, description] of [
      ["Switch to Markdown", "Open the note in this tab"],
      ["Search and insert a map", "Insert another map"],
      ["Export", "Save as SVG or PNG"],
    ]) expect(row).toContain(`**${title}** (${description})`);
  });

  it("the Japanese README's gear row and product-plan's M3 paragraph name the same lines", async () => {
    const readme = await readFile(new URL("../../README.ja.md", import.meta.url), "utf8");
    const row = readme.split("\n").find(line => line.startsWith("| 歯車 |")) ?? "";
    const plan = await readFile(new URL("../../docs/product-plan.md", import.meta.url), "utf8");
    const paragraph = plan.split("\n").find(line => line.startsWith("**現在の実装（操作ポップオーバー")) ?? "";
    for (const text of [row, paragraph]) {
      expect(text).toContain("「Markdown に切り替え（同じタブで本文を開く）」");
      for (const [title, description] of ITEMS) expect(text).toContain(`「${title}（${description}）」`);
    }
  });
});
