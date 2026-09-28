import { readFile } from "node:fs/promises";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The plugin's language comes from one line in `onload` (src/i18n). No test runs `onload` (vitest sets `ja` for
 * every file in tests/setup-language.ts), so this pins the line by its shape: the first statement of `onload`,
 * before anything that can show text (the settings tab, a notice from `loadData`).
 */
describe("the plugin picks its language first thing in onload", () => {
  it("src/main.ts: onload starts with setLanguage(getLanguage()), getLanguage from obsidian", async () => {
    const text = await readFile(new URL("../../src/main.ts", import.meta.url), "utf8");
    const file = ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true);
    let first = "";
    const visit = node => {
      if (ts.isMethodDeclaration(node) && node.name.getText(file) === "onload" && node.body) first = node.body.statements[0]?.getText(file) ?? "";
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(first).toBe("setLanguage(getLanguage());");
    const fromObsidian = file.statements.find(statement => ts.isImportDeclaration(statement) && statement.moduleSpecifier.getText(file) === '"obsidian"');
    expect(fromObsidian?.getText(file)).toMatch(/\bgetLanguage\b/u);
  });
});
