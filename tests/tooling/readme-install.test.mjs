import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { en } from "../../src/i18n/en.ts";
import { ja } from "../../src/i18n/ja.ts";

/**
 * LEV-259: Mappy is in the community plugins directory, so both READMEs install from there (or by hand) and no
 * longer send users to BRAT. The installation section names the directory's steps and the manifest's
 * `minAppVersion`; the wording around them is not checked, and neither is whether Obsidian's settings still use
 * those labels (they follow the author's published install page).
 *
 * The side-by-side command always opens the new pane on the left (`createLeafBySplit(…, "vertical", true)`) and
 * puts the other view there: run from Markdown, `open` puts the map in the new leaf; run from a map, `open` hands
 * over to `showSource(true)`, which puts the Markdown in the new leaf. The README row used to say only the first
 * half. This pins the row to both halves and those source lines (whitespace-insensitive), so changing the
 * direction or which view goes in the new leaf sends you back to the README.
 *
 * Each README links its language's documentation twice, on the language-links line and at the end of the
 * installation section; whether those pages answer is not checked here.
 */
const READMES = [
  {
    file: "README.md", heading: "## Installation", docs: "https://obsidian.levers.co.jp/mappy", row: `| ${en.cmdOpenSplit} |`,
    steps: ["Community plugins", "Browse", "`Mappy`", "Install", "Enable"],
    phrases: ["Run from a Markdown note, the map is on the left", "Run from a map, the Markdown opens on the left"],
  },
  {
    file: "README.ja.md", heading: "## 導入", docs: "https://obsidian.levers.co.jp/ja/mappy", row: `| ${ja.cmdOpenSplit} |`,
    steps: ["コミュニティプラグイン", "閲覧", "`Mappy`", "インストール", "有効化"],
    phrases: ["Markdown のノートから実行すると、左にマップ", "マップから実行すると、左に Markdown"],
  },
];

const read = file => readFile(new URL(`../../${file}`, import.meta.url), "utf8");
const section = (readme, heading) => readme.split(`${heading}\n`)[1]?.split("\n## ")[0] ?? "";
const squash = text => text.replace(/\s+/g, " ");

describe("the READMEs' installation and side-by-side command (LEV-259)", () => {
  it.each(READMES)("$file installs from the community plugins directory, not BRAT", async ({ file, heading, steps }) => {
    const readme = await read(file);
    expect(readme).not.toMatch(/\bbrat\b/i);
    expect(readme.split("\n").filter(line => line === heading)).toHaveLength(1);
    const install = section(readme, heading);
    for (const step of steps) expect(install).toContain(step);
    const { minAppVersion } = JSON.parse(await read("manifest.json"));
    expect(install).toMatch(new RegExp(`(?<![\\d.])${minAppVersion.replaceAll(".", "\\.")}(?![\\d.]*\\d)`));
  });

  it.each(READMES)("$file says which side the new pane opens on, from either side", async ({ file, row, phrases }) => {
    const rows = (await read(file)).split("\n").filter(line => line.startsWith(row));
    expect(rows).toHaveLength(1);
    for (const phrase of phrases) expect(rows[0]).toContain(phrase);
  });

  it.each(READMES)("$file links its documentation by the language links and after the installation steps", async ({ file, heading, docs }) => {
    const readme = await read(file);
    const link = `](${docs})`;
    const languages = readme.split("\n").filter(line => /\]\(README(\.ja)?\.md\)/.test(line));
    expect(languages).toHaveLength(1);
    expect(languages[0]).toContain(link);
    expect(section(readme, heading).trimEnd().split("\n").at(-1)).toContain(link);
  });

  it.each([
    ["src/main.ts", "if (split && map?.file === file) { return map.showSource(true); }"],
    ["src/main.ts", "const leaf = split ? workspace.createLeafBySplit(current, \"vertical\", true) : current; return this.router.openMap(leaf, file, true, layout);"],
    ["src/ui/mindmap-view.ts", "const leaf = split ? this.app.workspace.createLeafBySplit(this.leaf, \"vertical\", true) : this.leaf;"],
    ["src/ui/mindmap-view.ts", "await this.router.openMarkdown(leaf, file);"],
  ])("%s puts the other view in a new pane before (left of) the current one", async (file, code) => {
    expect(squash(await read(file))).toContain(code);
  });
});
