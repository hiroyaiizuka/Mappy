import { describe, expect, it } from "vitest";
import { applyEdits } from "../../src/core/commands";
import { parseMarkdown } from "../../src/core/markdown";
import { planListConversion } from "../../src/core/list-conversion";

function convert(source: string, title = "ノート"): string {
  const doc = parseMarkdown(source, title);
  return applyEdits(source, planListConversion(doc));
}

describe("explicit heading to list conversion", () => {
  it("normalizes one root to H2 and converts children using actual nesting depth", () => {
    const source = "# 講座\n\n説明\n\n### 第一章\n##### 子\n### 第二章\n";
    expect(convert(source)).toBe("## 講座\n\n説明\n\n- 第一章\n  - 子\n- 第二章\n");
  });

  it("handles a starting H2 with H3 descendants and keeps duplicate titles distinct", () => {
    const source = "## 講座\n### 同名\n#### 子\n### 同名\n";
    const converted = convert(source);
    expect(converted).toBe("## 講座\n- 同名\n  - 子\n- 同名\n");
    const parsed = parseMarkdown(converted, "ノート");
    expect(parsed.nodes.map(node => node.title)).toEqual(["講座", "同名", "子", "同名"]);
    expect(parsed.nodes[2]?.parentId).toBe(parsed.nodes[1]?.id);
  });

  it("adds a filename root for multiple top headings without rewriting YAML or preamble", () => {
    const prefix = "---\ntags: [abc]\ncustom: 'keep  spaces'\n---\n\n前書き  \n\n";
    const source = prefix + "# 第一章\n説明\n## 子\n# 第二章";
    expect(convert(source, "講座の構成")).toBe(prefix + "## 講座の構成\n\n- 第一章\n  説明\n  - 子\n- 第二章");
    const edits = planListConversion(parseMarkdown(source, "講座の構成"));
    expect(edits.every(edit => edit.from >= prefix.length)).toBe(true);
  });

  it("indents paragraphs, links, images and fenced code while preserving body bytes and blank lines", () => {
    const source = "# Root\n\n## One\nfirst  \n\n[[日本 語|表示名]]\n![[画像.png]]\n```ts\n# literal\n  const x = 1;\n```\n \t\n### Child\nbody\n";
    const expected = "## Root\n\n- One\n  first  \n\n  [[日本 語|表示名]]\n  ![[画像.png]]\n  ```ts\n  # literal\n    const x = 1;\n  ```\n \t\n  - Child\n    body\n";
    expect(convert(source)).toBe(expected);
  });

  it.each(["", "\r\n"])("preserves CRLF and EOF newline state %j", ending => {
    const source = `# Root\r\n\r\n## Child\r\ntext  ${ending}`;
    expect(convert(source)).toBe(`## Root\r\n\r\n- Child\r\n  text  ${ending}`);
  });

  it("supports one-line Setext headings without consuming their body or line ending", () => {
    const source = "Root\n====\n\nChild\n----\n本文";
    expect(convert(source)).toBe("## Root\n\n- Child\n  本文");
  });

  it("rejects multiline Setext headings with a specific reason", () => {
    expect(() => convert("Root\n====\n\nfirst\nsecond\n----\n")).toThrow(/複数行.*Setext/u);
  });

  it.each([
    "# Root\n## Child\n\n- ordinary body list\n",
    "# Root\n\n- root body list\n\n## Child\n",
    "- preamble list\n\n# Root\n## Child\n",
    "# Root\n## [ ] ambiguous task label\n",
  ])("rejects conversion when body syntax would create or change nodes: %j", source => {
    const doc = parseMarkdown(source, "ノート");
    expect(() => planListConversion(doc)).toThrow(/構造/u);
    expect(doc.source).toBe(source);
  });

  it("does not rewrite documents already using list format", () => {
    const source = "## Root\n- one\n  - two\n";
    expect(planListConversion(parseMarkdown(source, "ノート"))).toEqual([]);
    expect(convert(source)).toBe(source);
  });
});
