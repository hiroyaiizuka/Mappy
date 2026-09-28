import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * `ui/sentence-case-locale-module` is not in the `recommended` config eslint.config.mjs extends, only in
 * `recommendedWithLocalesEn` (docs/architecture.md §9e). This pins the block that turns it on for the English
 * table, and that the built-in brand and acronym lists still apply there.
 */
describe("the English table's lint", () => {
  const lint = async text => {
    const eslint = new ESLint({ cwd: new URL("../../", import.meta.url).pathname });
    const [result] = await eslint.lintText(text, { filePath: "src/i18n/en.ts" });
    return result.messages.map(message => message.ruleId);
  };

  it("refuses title case in src/i18n/en.ts", async () => {
    expect(await lint('export const en = { a: "Open The Map" };\n')).toContain("obsidianmd/ui/sentence-case-locale-module");
  }, 30_000);

  it("keeps Markdown, SVG and the words the table allows", async () => {
    const text = 'export const en = { a: "Check the Markdown syntax.", b: "Export as SVG.", c: "Use an ATX heading under an H2 root." };\n';
    expect(await lint(text)).not.toContain("obsidianmd/ui/sentence-case-locale-module");
  }, 30_000);
});
