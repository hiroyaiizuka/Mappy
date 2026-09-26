import { describe, expect, it } from 'vitest';
import { applyEdits, planEdit, type EditCommand } from '../../src/core/commands';
import { parseMarkdown, type MindDocument, type MindNode } from '../../src/core/markdown';
import { plainTitle } from '../../src/core/plain-text';
import { displayTitle, storedTitle } from '../../src/core/title-breaks';

function find(doc: MindDocument, title: string): MindNode {
  const node = doc.nodes.find((candidate) => candidate.title === title);
  if (!node) throw new Error(`Missing fixture node: ${title}`);
  return node;
}

function renamed(source: string, title: string, draft: string, format?: MindDocument['format']): string {
  const doc = parseMarkdown(source, 'Note', undefined, format);
  const command: EditCommand = { type: 'rename', nodeId: find(doc, title).id, title: draft };
  return applyEdits(source, planEdit(doc, command).edits);
}

describe('line breaks inside a node (LEV-202)', () => {
  it.each([
    ['温泉<br>旅行', '温泉\n旅行'],
    ['温泉<br/>旅行', '温泉\n旅行'],
    ['温泉<br />旅行', '温泉\n旅行'],
    ['温泉<BR>旅行', '温泉\n旅行'],
    ['温泉 <br>  旅行', '温泉\n旅行'],
    ['aaa<br>aaa<br>zsssss', 'aaa\naaa\nzsssss'],
    ['空行<br><br>のあと', '空行\n\nのあと'],
  ])('reads %j as the draft %j', (title, draft) => {
    expect(displayTitle(title)).toBe(draft);
  });

  // Not regressions (the rule is new in LEV-202): these pin what the rule must not read as a break.
  it.each(['`a<br>b`', 'a\\<br>b', 'a<bra>b', 'a<br class="x">b', 'a&lt;br&gt;b'])('leaves %j as text: no `<br>` tag the parser reads', (title) => {
    expect(displayTitle(title)).toBe(title);
  });

  it.each([
    ['温泉\n旅行', '温泉<br>旅行'],
    ['温泉\r\n旅行', '温泉<br>旅行'],
    ['温泉\r旅行', '温泉<br>旅行'],
    ['温泉 旅行', '温泉<br>旅行'],
    ['温泉 \n 旅行', '温泉<br>旅行'],
    ['\n温泉\n旅行\n', '温泉<br>旅行'],
    ['温泉', '温泉'],
  ])('writes the draft %j as %j', (draft, title) => {
    expect(storedTitle(draft, '別の名前')).toBe(title);
  });

  // What 「そのまま確定しても原文が変わらない」 rests on: a draft that reads as the title is the title as written.
  it.each(['温泉<BR/>旅行', '温泉 <br /> 旅行', '温泉<br>旅行'])('keeps %j as written when the draft is left as it opened', (title) => {
    expect(storedTitle(displayTitle(title), title)).toBe(title);
  });

  // 本人の操作（Shift+Enter で改行して確定）× 対象の形。確定前は assertSingleLine が
  // 「ノード名は改行を含まない文字列にしてください。」で拒否していた。
  it.each([
    ['a heading', '# 計画\n\n## 温泉旅行\n', '温泉旅行', '# 計画\n\n## 温泉<br>旅行\n', 'headings'],
    ['the body root (H1)', '# 温泉旅行\n\n## 予約\n', '温泉旅行', '# 温泉<br>旅行\n\n## 予約\n', 'headings'],
    ['a free topic', '# 計画\n\n# 温泉旅行\n', '温泉旅行', '# 計画\n\n# 温泉<br>旅行\n', 'headings'],
    ['a list item', '## 計画\n\n- 温泉旅行\n  - 予約\n', '温泉旅行', '## 計画\n\n- 温泉<br>旅行\n  - 予約\n', 'list'],
    ['an H2 section of a list note', '## 温泉旅行\n\n- 予約\n', '温泉旅行', '## 温泉<br>旅行\n\n- 予約\n', 'list'],
    ['an empty list item', '## 計画\n\n-\n- 次\n', '', '## 計画\n\n- 温泉<br>旅行\n- 次\n', 'list'],
    ['an empty heading', '# 計画\n\n##\n', '', '# 計画\n\n## 温泉<br>旅行\n', 'headings'],
  ] as const)('writes a break typed in %s as `<br>` in its one line', (_shape, source, title, expected, format) => {
    const written = renamed(source, title, '温泉\n旅行', format);
    expect(written).toBe(expected);
    const reread = parseMarkdown(written, 'Note', undefined, format);
    expect(reread.nodes).toHaveLength(parseMarkdown(source, 'Note', undefined, format).nodes.length);
    expect(displayTitle(find(reread, '温泉<br>旅行').title)).toBe('温泉\n旅行');
  });

  it('rewrites nothing when a title with breaks is confirmed as it opened', () => {
    const source = '# 計画\n\n## 温泉 <BR/> 旅行 ##\n本文\n';
    const doc = parseMarkdown(source, 'Note', undefined, 'headings');
    const node = find(doc, '温泉 <BR/> 旅行');
    const plan = planEdit(doc, { type: 'rename', nodeId: node.id, title: displayTitle(node.title) });
    expect(applyEdits(source, plan.edits)).toBe(source);
  });

  it('writes only the title range when one line of a broken title changes', () => {
    const source = '---\nmappy: true\n---\n## 計画\r\n\r\n- 温泉<BR/>旅行 [[宿]]\r\n  本文\r\n';
    expect(renamed(source, '温泉<BR/>旅行 [[宿]]', '温泉\n一泊旅行 [[宿]]', 'list'))
      .toBe(source.replace('温泉<BR/>旅行 [[宿]]', '温泉<br>一泊旅行 [[宿]]'));
  });

  it('keeps a free topic\'s stored position under its new title', () => {
    const source = '---\nmappy-topics:\n  温泉旅行: { mindmap: [10, 20] }\n---\n# 計画\n\n# 温泉旅行\n';
    const written = renamed(source, '温泉旅行', '温泉\n旅行', 'headings');
    expect(written).toContain('# 温泉<br>旅行\n');
    expect(written).toMatch(/^ {2}温泉<br>旅行: \{ mindmap: \[10, 20\] \}$/mu);
    expect(written).not.toMatch(/^ {2}温泉旅行:/mu);
  });

  it('refuses a break in a Setext heading, whose lines are the note\'s own', () => {
    const doc = parseMarkdown('温泉旅行\n===\n', 'Note', undefined, 'headings');
    expect(() => planEdit(doc, { type: 'rename', nodeId: find(doc, '温泉旅行').id, title: '温泉\n旅行' })).toThrow('Setext');
  });

  it('leaves a multi-line Setext heading as written when its draft is confirmed untouched', () => {
    const source = '温泉\n旅行\n===\n';
    const doc = parseMarkdown(source, 'Note', undefined, 'headings');
    const node = find(doc, '温泉\n旅行');
    expect(applyEdits(source, planEdit(doc, { type: 'rename', nodeId: node.id, title: displayTitle(node.title) }).edits)).toBe(source);
  });

  it('tells same-titled broken nodes apart only by their text, as any other title', () => {
    const doc = parseMarkdown('## 計画\n\n- 温泉<br>旅行\n- 温泉<br/>旅行\n', 'Note', undefined, 'list');
    expect(doc.nodes.filter((node) => displayTitle(node.title) === '温泉\n旅行')).toHaveLength(2);
  });

  it('gives renderers without Markdown the break as a line break', () => {
    expect(plainTitle('温泉 <br> **旅行**').text).toBe('温泉\n旅行');
    expect(plainTitle('`a<br>b`').text).toBe('a<br>b');
  });
});
