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
  it.each(['`a<br>b`', 'a\\<br>b', 'a<bra>b', 'a&lt;br&gt;b'])('leaves %j as text: no `<br>` tag the parser reads', (title) => {
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

  // Review 2 of LEV-202: Obsidian's wiki links and math are not Markdown to the parser, so a break in them was
  // accepted and saved as a broken link (`[[no<br>te]]`).
  it.each(['[[no\nte]]', '[[note|a\nb]]', '![[図\n.png]]', '$a\nb$'])('refuses a break inside %j, where a tag is text', (draft) => {
    expect(() => storedTitle(draft, '元の名前')).toThrow('この位置では改行できません');
  });

  it.each(['[[note|a<br>b]]', '$a<br>b$'])('leaves the `<br>` inside %j as text', (title) => {
    expect(displayTitle(title)).toBe(title);
  });

  // Review 2 of LEV-202: parsed as a document of its own, a title that starts like a block lost its inline syntax.
  it.each([
    ['<div>a\nb', '<div>a<br>b'],
    ['```js\nb', '```js<br>b'],
    ['[a]: /u\nb', '[a]: /u<br>b'],
    ['<!-- c -->a\nb', '<!-- c -->a<br>b'],
  ])('reads %j as a heading\'s or an item\'s text, not as a block', (draft, stored) => {
    expect(storedTitle(draft, '元の名前')).toBe(stored);
    expect(displayTitle(stored)).toBe(draft);
  });

  // Review 2 of LEV-202: two tags walked over the same spaces, so rewriting them doubled the spaces between.
  it('keeps the spaces between two tags once', () => {
    expect(displayTitle('a <br> <br> b')).toBe('a\n\nb');
    expect(storedTitle('A\n\nb', 'a <br> <br> b')).toBe('A <br> <br> b');
  });

  // Review 3 of LEV-202: Obsidian draws a tag with attributes as a break, and hides a comment.
  it('reads `<br class="x">` as a break and a `<br>` in a %%comment%% as text', () => {
    expect(displayTitle('温泉<br class="x">旅行')).toBe('温泉\n旅行');
    expect(storedTitle('温泉\n一泊旅行', '温泉<br class="x">旅行')).toBe('温泉<br class="x">一泊旅行');
    expect(displayTitle('見出し %%a<br>b%%')).toBe('見出し %%a<br>b%%');
  });

  // Review 3 of LEV-202: the draft was trimmed of every break, so a `<br>` the note wrote at an end went on any edit.
  it.each([
    ['<br>見出し', '\n見出し2', '<br>見出し2'],
    ['項目<br>', '項目2\n', '項目2<br>'],
    // A title with no break at its ends still loses the breaks a paste brings there (the rows above `writes the draft`).
    ['項目', '\n項目2\n', '項目2'],
  ])('keeps the break %j starts or ends with when the draft becomes %j', (title, draft, stored) => {
    expect(storedTitle(draft, title)).toBe(stored);
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

  it('writes only the title range when one line of a broken title changes, keeping its tags as written', () => {
    const source = '---\nmappy: true\n---\n## 計画\r\n\r\n- 温泉<BR/>旅行 [[宿]]\r\n  本文\r\n';
    expect(renamed(source, '温泉<BR/>旅行 [[宿]]', '温泉\n一泊旅行 [[宿]]', 'list'))
      .toBe(source.replace('温泉<BR/>旅行 [[宿]]', '温泉<BR/>一泊旅行 [[宿]]'));
  });

  // Review of LEV-202: every tag of an edited draft was written again as `<br>`.
  it.each([
    ['a <BR/> b c', 'a\nb d', 'a <BR/> b d'],
    ['a<br />b<BR>c', 'a\nB\nc', 'a<br />B<BR>c'],
    // A break added or removed: the breaks cannot be told from one another, so each is `<br>` (as before the review: these two pin it).
    ['a <BR/> b', 'a\nb\nc', 'a<br>b<br>c'],
    ['a <BR/> b<br/>c', 'a\nbc', 'a<br>bc'],
  ])('keeps the tags of %j when the draft becomes %j', (title, draft, stored) => {
    expect(storedTitle(draft, title)).toBe(stored);
  });

  // Review of LEV-202: a break there was saved as the text `<br>`, and the node showed it.
  it.each([
    ['C:\\\ndir', 'after a backslash'],
    ['`a\nb`', 'inside inline code'],
    ['[説明](a\nb)', 'inside a link\'s target'],
  ])('refuses the draft %j: a break %s would be text', (draft) => {
    expect(() => storedTitle(draft, '元の名前')).toThrow('この位置では改行できません');
    const doc = parseMarkdown('## 計画\n\n- 元の名前\n', 'Note', undefined, 'list');
    expect(() => planEdit(doc, { type: 'rename', nodeId: find(doc, '元の名前').id, title: draft })).toThrow('この位置では改行できません');
  });

  it('keeps a free topic\'s stored position under its new title', () => {
    const source = '---\nmappy-topics:\n  温泉旅行: { mindmap: [10, 20] }\n---\n# 計画\n\n# 温泉旅行\n';
    const written = renamed(source, '温泉旅行', '温泉\n旅行', 'headings');
    expect(written).toContain('# 温泉<br>旅行\n');
    expect(written).toMatch(/^ {2}温泉<br>旅行: \{ mindmap: \[10, 20\] \}$/mu);
    expect(written).not.toMatch(/^ {2}温泉旅行:/mu);
  });

  // Review of LEV-202: the first version refused any break in a Setext heading, which locked out one that already had a `<br>`.
  it.each([
    ['温泉旅行\n===\n', '温泉旅行', '温泉\n旅行', '温泉<br>旅行\n===\n'],
    ['温泉<br>旅行\n===\n', '温泉<br>旅行', '温泉\n旅行記', '温泉<br>旅行記\n===\n'],
  ])('writes a break in the one line of the Setext heading %j', (source, title, draft, expected) => {
    expect(renamed(source, title, draft, 'headings')).toBe(expected);
  });

  it('refuses a break in a multi-line Setext heading, whose lines are the note\'s own', () => {
    const doc = parseMarkdown('温泉\n旅行\n===\n', 'Note', undefined, 'headings');
    expect(() => planEdit(doc, { type: 'rename', nodeId: find(doc, '温泉\n旅行').id, title: '温泉\n旅行記' })).toThrow('Setext');
    // Without a break it is one line, as before LEV-202. (This test held before the review too: it pins the refusal that stays.)
    expect(renamed('温泉\n旅行\n===\n', '温泉\n旅行', '温泉旅行', 'headings')).toBe('温泉旅行\n===\n');
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

  // Review 2 of LEV-202: the link was replaced by its label before the break in the label was seen.
  it('keeps a break inside a link\'s label, as the map shows it', () => {
    expect(plainTitle('[温泉<br>旅行](u)')).toEqual({ text: '温泉\n旅行', link: 'u', linkSyntax: 'vault' });
    expect(plainTitle('[[note|a<br>b]]').text).toBe('a<br>b');
  });

  // Review of LEV-202: reading the title with real newlines let the text after a break start a block.
  it('reads the text after a break as the same line of Markdown', () => {
    expect(plainTitle('見出し<br>```x [[Note]]')).toEqual({ text: '見出し\n```x Note', link: 'Note', linkSyntax: 'vault' });
    expect(plainTitle('一行目<br># 二行目 [[Note|別名]]')).toEqual({ text: '一行目\n# 二行目 別名', link: 'Note', linkSyntax: 'vault' });
  });
});
