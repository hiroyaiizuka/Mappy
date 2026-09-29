import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { en } from "../../src/i18n/en.ts";
import { ja } from "../../src/i18n/ja.ts";

/**
 * LEV-259: Mappy is in the community plugins directory, so both READMEs install from there and no longer send
 * users to BRAT. The side-by-side command always opens the new pane on the left (`createLeafBySplit(…, "vertical",
 * true)` in `open` and in `showSource`), so run from Markdown the map is on the left and run from a map the Markdown
 * is. The README row used to say only the first half. This pins the row to both halves and to the `true` argument,
 * so flipping the argument sends you back to the README. It does not check the wording beyond the key phrases.
 * Each README links its language's documentation twice, next to the language links and at the end of the
 * installation section; whether those pages answer is not checked here.
 */
const READMES = [
  { file: "README.md", heading: "## Installation", docs: "https://obsidian.levers.co.jp/mappy", row: `| ${en.cmdOpenSplit} |`, phrases: ["Run from a Markdown note, the map is on the left", "Run from a map, the Markdown opens on the left"] },
  { file: "README.ja.md", heading: "## 導入", docs: "https://obsidian.levers.co.jp/ja/mappy", row: `| ${ja.cmdOpenSplit} |`, phrases: ["Markdown のノートから実行すると、左にマップ", "マップから実行すると、左に Markdown"] },
];

const read = file => readFile(new URL(`../../${file}`, import.meta.url), "utf8");

describe("the READMEs' installation and side-by-side command (LEV-259)", () => {
  it.each(READMES)("$file installs from the community plugins directory, not BRAT", async ({ file, heading }) => {
    const readme = await read(file);
    expect(readme).not.toMatch(/brat/i);
    const lines = readme.split("\n");
    expect(lines.filter(line => line === heading)).toHaveLength(1);
  });

  it.each(READMES)("$file says which side the new pane opens on, from either side", async ({ file, row, phrases }) => {
    const rows = (await read(file)).split("\n").filter(line => line.startsWith(row));
    expect(rows).toHaveLength(1);
    for (const phrase of phrases) expect(rows[0]).toContain(phrase);
  });

  it.each(READMES)("$file links its documentation by the language links and after the installation steps", async ({ file, heading, docs }) => {
    const readme = await read(file);
    const link = `](${docs})`;
    expect(readme.split("\n")[2]).toContain(link);
    const install = readme.split(`${heading}\n`)[1]?.split("\n## ")[0] ?? "";
    expect(install.trimEnd().split("\n").at(-1)).toContain(link);
  });

  it.each([
    ["src/main.ts", "workspace.createLeafBySplit(current, \"vertical\", true)"],
    ["src/ui/mindmap-view.ts", "this.app.workspace.createLeafBySplit(this.leaf, \"vertical\", true)"],
  ])("%s opens the new pane before (left of) the current one", async (file, call) => {
    expect(await read(file)).toContain(call);
  });
});
