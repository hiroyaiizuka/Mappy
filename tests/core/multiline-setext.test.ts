import { describe, expect, it } from 'vitest';
import { nodeBody } from '../../src/core/body';
import { applyEdits, planEdit } from '../../src/core/commands';
import { findSection } from '../../src/core/embed';
import { planListConversion } from '../../src/core/list-conversion';
import { parseMarkdown, projectMap, type MindDocument, type MindNode } from '../../src/core/markdown';
import { locateSubpath } from '../../src/core/subpath';

// LEV-208（本人の決定 2026-09-27）: Obsidian は複数行の Setext 見出し（2 行以上の段落の直後に === / ---）を見出しとして
// 読まない。閲覧モードでは段落（`===` はその段落の文字、`---` は続けて水平線）で、metadataCache の headings にも出ない。
// 1 行の Setext（`<br>` を含む 1 行も）は見出し（Obsidian 1.14.2。artifacts/lev-202-node-line-break/record.md「2 回目」、
// artifacts/lev-208-multiline-setext/record.md）。Mappy も同じに読み、その行は段落として上のノードの本文に入る。
// 修正前はどの行も「複数行の見出しのノード」ができて落ちた（artifacts/lev-208-multiline-setext/before-fix.log）。

function outline(doc: MindDocument): string[] {
  const lines: string[] = [];
  const walk = (node: MindNode, depth: number): void => {
    for (const child of node.children) {
      lines.push(`${'  '.repeat(depth)}${child.kind}:${child.level}:${child.title}`);
      walk(child, depth + 1);
    }
  };
  walk(doc.root, 0);
  return lines;
}

function find(doc: MindDocument, title: string): MindNode {
  const node = doc.nodes.find((candidate) => candidate.title === title);
  if (!node) throw new Error(`Missing fixture node: ${title}`);
  return node;
}

describe('a multi-line Setext heading is a paragraph, as Obsidian reads it (LEV-208)', () => {
  it.each([
    ['===', '# 前\n\n複数\n行の見出し\n===\n\n## 後\n', ['atx:1:前', '  atx:2:後']],
    ['---', '# 前\n\n複数\n行の見出し\n---\n\n## 後\n', ['atx:1:前', '  atx:2:後']],
    ['three lines', '# 前\n\n一\n二\n三\n===\n', ['atx:1:前']],
    ['an indented line', '# 前\n\n複数\n   行の見出し\n---\n', ['atx:1:前']],
    ['a hard break (two spaces)', '# 前\n\n複数  \n行の見出し\n===\n', ['atx:1:前']],
    ['a `<br>` and a line', '# 前\n\n設<br>定\nです\n---\n', ['atx:1:前']],
    ['CRLF', '# 前\r\n\r\n複数\r\n行の見出し\r\n===\r\n\r\n## 後\r\n', ['atx:1:前', '  atx:2:後']],
    ['before any heading', '複数\n行の見出し\n===\n\n# 後\n', ['atx:1:後']],
  ])('headings format, %s: no node, the lines stay in the body above', (_case, source, expected) => {
    const doc = parseMarkdown(source, 'Note', undefined, 'headings');
    expect(outline(doc)).toEqual(expected);
    // The paragraph and its underline are the body of the node above (the root before any heading).
    const holder = doc.nodes.find((node) => node.title === '前') ?? doc.root;
    const underline = source.search(/^(?:===|---)\r?$/mu);
    expect(holder.bodyFrom <= underline && underline < holder.bodyTo).toBe(true);
    expect(nodeBody(doc, holder)).toMatch(/(?:===|---)/u);
  });

  it('keeps a node that follows under the section the paragraph sits in, not under a heading made of it', () => {
    // 修正前は `複数 行`（H1）ができて `後`（H2）がその子になり、`前` の子ではなかった。
    const doc = parseMarkdown('# 前\n本文\n\n複数\n行\n===\n\n## 後\n', 'Note', undefined, 'headings');
    expect(find(doc, '後').parentId).toBe(find(doc, '前').id);
    expect(doc.source.slice(find(doc, '前').bodyFrom, find(doc, '前').bodyTo)).toBe('本文\n\n複数\n行\n===\n\n');
  });

  it.each([
    ['===', '一行\n===\n', 'setext:1:一行'],
    ['---', '一行\n---\n', 'setext:2:一行'],
    ['a `<br>` in the one line', '設<br>定\n---\n', 'setext:2:設<br>定'],
    ['after a blank line below a paragraph', '段落\nです\n\n一行\n===\n', 'setext:1:一行'],
  ])('keeps a one-line Setext heading a heading: %s (held before LEV-208 too; pins the one-line side)', (_case, source, expected) => {
    expect(outline(parseMarkdown(source, 'Note', undefined, 'headings'))).toEqual([expected]);
  });

  it('list format: a multi-line `---` is no H2 section, the lines stay in the section above', () => {
    const doc = parseMarkdown('## 区画\n- 項目\n\n複数\n行\n---\n\n- 次\n', 'Note');
    expect(doc.format).toBe('list');
    expect(outline(doc)).toEqual(['atx:2:区画', '  list:3:項目', '  list:3:次']);
  });

  it('a note whose only other heading is a multi-line `===` stays in the list format', () => {
    // 修正前は `複数 行`（H1）があるので見出し形式になった。
    const doc = parseMarkdown('## 区画\n- 項目\n\n複数\n行\n===\n', 'Note');
    expect(doc.format).toBe('list');
    expect(outline(doc)).toEqual(['atx:2:区画', '  list:3:項目']);
  });

  it('inside a list item the lines were never a node and still are not (held before LEV-208 too)', () => {
    const doc = parseMarkdown('## 区画\n- 項目\n  複数\n  行\n  ---\n- 次\n', 'Note');
    expect(outline(doc)).toEqual(['atx:2:区画', '  list:3:項目', '  list:3:次']);
  });

  it('a free topic is not made of one: the lines after the body are the body\'s', () => {
    const doc = parseMarkdown('---\nmappy: true\n---\n## 本体\n- a\n\n別の\n二行\n---\n', 'Note');
    expect(projectMap(doc).topics).toEqual([]);
  });

  it('a link to its text finds nothing, as Obsidian\'s metadataCache has no such heading', () => {
    const source = '# 前\n\n複数\n行の見出し\n===\n\n一行\n---\n';
    expect(locateSubpath(source, '#複数 行の見出し')).toBeNull();
    expect(locateSubpath(source, '#一行')).toBe(source.indexOf('一行'));
    const doc = parseMarkdown(source, 'Note', undefined, 'headings');
    expect(findSection(doc, '複数 行の見出し')).toBeNull();
    expect(findSection(doc, '一行')?.title).toBe('一行');
  });

  // Code review of LEV-208 (round 1): the map reads the note with `%%…%%` blanked out and the link resolution read it
  // raw, so a comment line above a one-line Setext heading made it two lines to one and one line to the other.
  it.each([
    ['a comment line above', '# 前\n\n%%memo%%\nTitle\n===\n'],
    // Held before the fix too (the frontmatter's closing `---` ends the paragraph either way): pins the other mask.
    ['a frontmatter right above', '---\nk: v\n---\nTitle\n===\n'],
  ])('the map and a link read the same heading with %s', (_case, source) => {
    const doc = parseMarkdown(source, 'Note', undefined, 'headings');
    const title = doc.nodes.find((node) => node.title === 'Title');
    expect(title).toBeDefined();
    expect(locateSubpath(source, '#Title')).toBe(title?.from);
  });
});

// The rename, add-child and delete rows held before LEV-208 too (the paragraph was a node then, and none of these edits
// reached into it): they pin how an edit next to the paragraph writes now that it is body, not a regression. The
// conversion row failed before (the multi-line heading was refused).
describe('editing around a multi-line Setext paragraph (LEV-208 × LEV-202)', () => {
  const source = '# 前\n本文\n\n複数\n行\n---\n\n## 後\n';

  it('renaming the node that holds it rewrites only that title', () => {
    const doc = parseMarkdown(source, 'Note', undefined, 'headings');
    const written = applyEdits(source, planEdit(doc, { type: 'rename', nodeId: find(doc, '前').id, title: '温泉\n旅行' }).edits);
    expect(written).toBe('# 温泉<br>旅行\n本文\n\n複数\n行\n---\n\n## 後\n');
  });

  it('renaming the node after it does not reach into it', () => {
    const doc = parseMarkdown(source, 'Note', undefined, 'headings');
    const written = applyEdits(source, planEdit(doc, { type: 'rename', nodeId: find(doc, '後').id, title: '次' }).edits);
    expect(written).toBe('# 前\n本文\n\n複数\n行\n---\n\n## 次\n');
  });

  it('adding a child writes a new heading after the paragraph and its rule, which stay as they were', () => {
    const doc = parseMarkdown('# 前\n\n複数\n行\n---\n', 'Note', undefined, 'headings');
    const written = applyEdits(doc.source, planEdit(doc, { type: 'add-child', nodeId: find(doc, '前').id, title: '子' }).edits);
    expect(written).toBe('# 前\n\n複数\n行\n---\n\n## 子\n');
  });

  it('a delete that would join a paragraph onto a one-line Setext heading keeps a blank line, so the heading survives', () => {
    // 修正前は `para` と `B\n---` がつながって見出し `para B` になり、題名の照合で弾かれて空行を足していた。修正後は
    // つながった形が段落＋水平線になり B が消えるので、件数の照合で弾かれて同じく空行を足す（結果は同じ）。
    const doc = parseMarkdown('# T\npara\n## A\nB\n---\n', 'Note', undefined, 'headings');
    const written = applyEdits(doc.source, planEdit(doc, { type: 'delete', nodeId: find(doc, 'A').id }).edits);
    expect(outline(parseMarkdown(written, 'Note', undefined, 'headings'))).toEqual(['atx:1:T', '  setext:2:B']);
  });

  it('converting to the list format carries the paragraph over as the section\'s body text', () => {
    const doc = parseMarkdown('# 前\n\n複数\n行\n===\n\n## 後\n', 'Note', undefined, 'headings');
    const converted = applyEdits(doc.source, planListConversion(doc));
    const reread = parseMarkdown(converted, 'Note');
    expect(outline(reread)).toEqual(['atx:2:前', '  list:3:後']);
    expect(converted).toContain('複数');
  });
});
