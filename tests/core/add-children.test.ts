/**
 * `add-children`（LEV-271、docs/architecture.md §11.5）: AI の結果を「残す」ときに、選んだノードの最後の子として入れ子の
 * 項目をまとめて 1 回の差分で書く編集コマンド。
 *
 * 行列は「残す」× 書き込み先の形（見出し形式のノード・見出し形式のフリートピック・H5／H6・リスト形式の H2・リストの項目・
 * リスト形式のフリートピック・4 スペース・タブ・CRLF・末尾改行なし）。どの行も、書いた範囲（1 つの挿入）の外の原文が
 * バイト単位で変わらないことと、再解析で同じ題名・同じノード数（`checkedAddition` と同じ照合）になることを見る。
 * 項目の文がブロックの記法に読まれる場合（§11.4 の無効化）は記法 × 2 形式で、書いたあとの再解析を確かめる。
 */
import { describe, expect, it } from 'vitest';
import { applyEdits, planEdit } from '../../src/core/commands';
import { parseMarkdown, projectMap, type MindDocument, type MindNode } from '../../src/core/markdown';
import { fitBranches, inertTitle, type NewBranch } from '../../src/core/new-branches';
import { t } from '../../src/i18n';

function parse(source: string, format?: MindDocument['format']): MindDocument {
  return parseMarkdown(source, 'Note', undefined, format);
}

function find(doc: MindDocument, title: string): MindNode {
  const node = doc.nodes.find(candidate => candidate.title === title);
  if (!node) throw new Error(`Missing fixture node: ${title}`);
  return node;
}

const leaf = (text: string, ...children: NewBranch[]): NewBranch => ({ text, children });

/** Plan `add-children`, check it is one insertion that leaves every byte around it, and return the text written. */
function addChildren(doc: MindDocument, title: string, items: NewBranch[]): { source: string; inserted: string; after: MindDocument } {
  const plan = planEdit(doc, { type: 'add-children', nodeId: find(doc, title).id, items });
  expect(plan.edits).toHaveLength(1);
  const [edit] = plan.edits;
  if (!edit) throw new Error('No edit');
  expect(edit.from).toBe(edit.to);
  const source = applyEdits(doc.source, plan.edits);
  // Outside the written range the note is byte for byte what it was.
  expect(source.slice(0, edit.from)).toBe(doc.source.slice(0, edit.from));
  expect(source.slice(edit.from + edit.text.length)).toBe(doc.source.slice(edit.to));
  const after = parse(source, doc.format);
  // The selection is the first node written.
  expect(after.nodes.find(node => node.titleFrom === plan.selectionOffset)?.title).toBe(items[0] ? inertTitle(items[0].text, doc.format === 'list' ? 'item' : 'heading') : undefined);
  return { source, inserted: edit.text, after };
}

/** Preorder `depth:title` of the children of `title`. */
function childShape(doc: MindDocument, title: string): string[] {
  const shape: string[] = [];
  const walk = (node: MindNode, depth: number): void => {
    for (const child of node.children) { shape.push(`${depth}:${child.title}`); walk(child, depth + 1); }
  };
  walk(find(doc, title), 1);
  return shape;
}

const RESULT = [leaf('背景', leaf('市場', leaf('国内')), leaf('競合')), leaf('論点'), leaf('結論', leaf('次の一手'))];
const RESULT_SHAPE = ['1:背景', '2:市場', '3:国内', '2:競合', '1:論点', '1:結論', '2:次の一手'];

describe('add-children in the headings format', () => {
  const HEADINGS = ['# 企画', '', '本文', '', '## 既存の子', '', '## 後の兄弟', '', '本文 2', ''].join('\n');

  it('writes the branches as headings after the section, each one level down, in one insertion', () => {
    const doc = parse(HEADINGS);
    const { source, inserted, after } = addChildren(doc, '既存の子', RESULT);
    expect(inserted).toBe('### 背景\n\n#### 市場\n\n##### 国内\n\n#### 競合\n\n### 論点\n\n### 結論\n\n#### 次の一手\n\n');
    expect(source).toBe(HEADINGS.replace('## 後の兄弟', `${inserted}## 後の兄弟`));
    expect(childShape(after, '既存の子')).toEqual(RESULT_SHAPE);
    expect(after.nodes).toHaveLength(doc.nodes.length + 7);
  });

  it('adds after the existing children of the body root, at the end of a note without a final line break', () => {
    const source = '# 企画\n\n## 既存の子';
    const doc = parse(source);
    const { source: written, after } = addChildren(doc, '企画', [leaf('新しい')]);
    expect(written).toBe('# 企画\n\n## 既存の子\n\n## 新しい');
    expect(childShape(after, '企画')).toEqual(['1:既存の子', '1:新しい']);
  });

  it('keeps CRLF line breaks', () => {
    const source = '# 企画\r\n\r\n## 子\r\n';
    const doc = parse(source);
    expect(addChildren(doc, '子', [leaf('a', leaf('b'))]).source).toBe('# 企画\r\n\r\n## 子\r\n\r\n### a\r\n\r\n#### b\r\n');
  });

  it('writes under a free topic (a later top-level section) without touching the body or the topics header', () => {
    const source = ['---', 'mappy-topics:', '  別トピック: {mindmap: [400, 0]}', '---', '# 本体', '', '## 子', '', '# 別トピック', '', '本文', ''].join('\n');
    const doc = parse(source);
    expect(projectMap(doc).topics.map(topic => topic.title)).toEqual(['別トピック']);
    const { source: written, after } = addChildren(doc, '別トピック', [leaf('案 1'), leaf('案 2')]);
    expect(written).toBe(`${source}\n## 案 1\n\n## 案 2\n`);
    expect(childShape(after, '別トピック')).toEqual(['1:案 1', '1:案 2']);
    expect(projectMap(after).topics.map(topic => topic.title)).toEqual(['別トピック']);
  });

  it('refuses a level past H6, and fitBranches lifts the deeper levels to the one the node can take', () => {
    const source = '# 1\n\n## 2\n\n### 3\n\n#### 4\n\n##### 5\n';
    const doc = parse(source);
    const node = find(doc, '5');
    const items = [leaf('a', leaf('b', leaf('c')))];
    expect(() => planEdit(doc, { type: 'add-children', nodeId: node.id, items })).toThrow(t().headingDepth);
    const fitted = fitBranches(items, 6 - node.level);
    expect(fitted).toEqual([leaf('a'), leaf('b'), leaf('c')]);
    const { after } = addChildren(doc, '5', fitted);
    expect(childShape(after, '5')).toEqual(['1:a', '1:b', '1:c']);
    expect(after.nodes.filter(item => item.level === 6).map(item => item.title)).toEqual(['a', 'b', 'c']);
  });

  it('refuses the root and an empty result', () => {
    const doc = parse('# 企画\n');
    expect(() => planEdit(doc, { type: 'add-children', nodeId: 'root', items: [leaf('a')] })).toThrow(t().rootAddsChildOnly);
    expect(() => planEdit(doc, { type: 'add-children', nodeId: find(doc, '企画').id, items: [] })).toThrow(t().nothingToAdd);
  });
});

describe('add-children in the list format', () => {
  const LIST = ['---', 'mappy: true', '---', '## 旅の計画', '', '- 温泉旅行', '  - 予約', '- 持ち物', '', '本文', ''].join('\n');

  it('writes nested items after the last child of a list item, at the children\'s indent', () => {
    const doc = parse(LIST, 'list');
    const { inserted, source, after } = addChildren(doc, '温泉旅行', RESULT);
    // After the last child's line, before its line break.
    expect(inserted).toBe('\n  - 背景\n    - 市場\n      - 国内\n    - 競合\n  - 論点\n  - 結論\n    - 次の一手');
    expect(source).toBe(LIST.replace('  - 予約\n', `  - 予約${inserted}\n`));
    expect(childShape(after, '温泉旅行')).toEqual(['1:予約', ...RESULT_SHAPE]);
  });

  it('writes the first children of an item with no children', () => {
    const doc = parse(LIST, 'list');
    const { source, after } = addChildren(doc, '持ち物', [leaf('タオル'), leaf('充電器', leaf('USB-C'))]);
    expect(source).toBe(LIST.replace('- 持ち物\n', '- 持ち物\n  - タオル\n  - 充電器\n    - USB-C\n'));
    expect(childShape(after, '持ち物')).toEqual(['1:タオル', '1:充電器', '2:USB-C']);
  });

  it('writes under an H2 section after its list, and a section with no list gets one after a blank line', () => {
    const doc = parse(LIST, 'list');
    expect(addChildren(doc, '旅の計画', [leaf('予算')]).source).toBe(LIST.replace('- 持ち物\n', '- 持ち物\n- 予算\n'));
    const bare = parse('## 空\n\n## 次\n', 'list');
    expect(addChildren(bare, '空', [leaf('a', leaf('b'))]).source).toBe('## 空\n\n- a\n  - b\n\n## 次\n');
  });

  it('writes under a free topic (a later H2)', () => {
    const source = '## 本体\n\n- 子\n\n## 別トピック\n';
    const doc = parse(source, 'list');
    expect(projectMap(doc).topics.map(topic => topic.title)).toEqual(['別トピック']);
    const { source: written, after } = addChildren(doc, '別トピック', [leaf('案')]);
    expect(written).toBe('## 本体\n\n- 子\n\n## 別トピック\n\n- 案\n');
    expect(childShape(after, '別トピック')).toEqual(['1:案']);
  });

  it('follows four-space nesting, tab indentation and the marker in use', () => {
    const fours = parse('## R\n* P\n    * C\n', 'list');
    expect(addChildren(fours, 'P', [leaf('a', leaf('b'))]).source).toBe('## R\n* P\n    * C\n    * a\n      * b\n');
    const tabs = parse('## R\n- P\n\t- C\n', 'list');
    expect(addChildren(tabs, 'P', [leaf('a', leaf('b', leaf('c')))]).source).toBe('## R\n- P\n\t- C\n\t- a\n\t\t- b\n\t\t\t- c\n');
  });

  it('keeps CRLF and a file without a final line break', () => {
    const crlf = parse('## R\r\n- P', 'list');
    expect(addChildren(crlf, 'P', [leaf('a'), leaf('b')]).source).toBe('## R\r\n- P\r\n  - a\r\n  - b');
  });
});

/**
 * The texts a model returns that Markdown would read as another block, or that would hide the nodes after them
 * (§11.4), and how each is written in a list item (`written`) and in a heading (`heading`; the text as it is when
 * absent: an ATX heading's text starts no block, so only `%%`, `<!--`, a closing `#` and `$$` are escaped there). Every row is written in both
 * formats and must read back as the same titles, same count. The written text is spelled out: Mappy's own parse
 * reads some of these as plain text either way (`- - 論点` stays one node to it, `# 見出し` stays a heading's text),
 * while Obsidian's renderer reads them as a nested list or a heading mark, so the reparse alone would not hold the
 * escape in place: without `inertTitle` the reparse alone failed 8 of these rows, the spelled-out text all 39 that differ (artifacts/lev-271/revert-inert-title.txt).
 */
const MARKUP: readonly { name: string; text: string; written: string; heading?: string }[] = [
  { name: 'リストの印', text: '- 論点', written: '\\- 論点' },
  { name: 'リストの印（*）', text: '* 論点', written: '\\* 論点' },
  { name: 'リストの印（+）', text: '+ 論点', written: '\\+ 論点' },
  { name: '番号付きの印', text: '1. 背景', written: '1\\. 背景' },
  { name: '番号付きの印（括弧）', text: '2) 背景', written: '2\\) 背景' },
  { name: '区切り線', text: '---', written: '\\---' },
  // Two marks are enough in a list: the item's own marker makes the third (`- --` is a rule). Independent review of aef0bbb.
  { name: '区切り線（2 つ、- の印と合わせて 3 つ）', text: '--', written: '\\--' },
  { name: '区切り線（2 つ、* の印と合わせて 3 つ）', text: '**', written: '\\**' },
  { name: '区切り線（空白入り）', text: '* * *', written: '\\* * *' },
  { name: '区切り線（_）', text: '___', written: '\\___' },
  { name: 'Setext の下線', text: '===', written: '\\===' },
  { name: '見出し', text: '# 見出し', written: '\\# 見出し' },
  { name: '引用', text: '> 引用', written: '\\> 引用' },
  { name: 'フェンス', text: '```js', written: '\\```js' },
  { name: 'フェンス（~）', text: '~~~', written: '\\~~~' },
  { name: '数式ブロック', text: '$$', written: '\\$$', heading: '\\$$' },
  { name: 'HTML', text: '<div>', written: '\\<div>' },
  { name: 'リンク参照の定義', text: '[03:15]: 導入', written: '\\[03:15]: 導入' },
  { name: 'タスク', text: '[ ] やること', written: '\\[ ] やること' },
  { name: '末尾の #', text: '要点 ##', written: '要点 ##', heading: '要点 \\#\\#' },
  { name: '%% コメント', text: '途中 %% 隠す', written: '途中 \\%\\% 隠す', heading: '途中 \\%\\% 隠す' },
  { name: 'HTML コメント', text: '途中 <!-- 隠す', written: '途中 &lt;!-- 隠す', heading: '途中 &lt;!-- 隠す' },
];

describe('item texts that Markdown would read as markup are written inert (§11.4)', () => {
  const HEADINGS = '# 企画\n\n## 子\n\n## 後\n';
  const LIST = '## 企画\n\n- 子\n- 後\n';

  for (const row of MARKUP) {
    for (const [format, source] of [['headings', HEADINGS], ['list', LIST]] as const) {
      it(`${format}: ${row.name}（${row.text}）`, () => {
        const doc = parse(source, format);
        const items = [leaf(row.text, leaf('子の項目')), leaf('次')];
        const { after } = addChildren(doc, '子', items);
        const written = format === 'headings' ? row.heading ?? row.text : row.written;
        expect(childShape(after, '子')).toEqual([`1:${written}`, '2:子の項目', '1:次']);
        expect(after.nodes).toHaveLength(doc.nodes.length + 3);
        // The node after the branches is still there, under its own name.
        expect(after.nodes.at(-1)?.title).toBe('後');
      });
    }
  }

  it('writes ** under a list whose marker is *, where the line would be a rule (* **)', () => {
    const doc = parse('## 企画\n\n* 子\n* 後\n', 'list');
    const { source, after } = addChildren(doc, '子', [leaf('**'), leaf('次')]);
    expect(source).toBe('## 企画\n\n* 子\n  * \\**\n  * 次\n* 後\n');
    expect(childShape(after, '子')).toEqual(['1:\\**', '1:次']);
  });

  // A link stays a link and a tag stays a tag (§11.4: links are kept): an autolink and `#tag` start no block.
  for (const [format, source] of [['headings', '# 企画\n\n## 子\n\n## 後\n'], ['list', '## 企画\n\n- 子\n- 後\n']] as const) {
    it(`${format}: keeps an autolink and a tag as they are, and they read back as written`, () => {
      const doc = parse(source, format);
      const { after } = addChildren(doc, '子', [leaf('<https://example.com> 参照'), leaf('#重要 の項目')]);
      expect(childShape(after, '子')).toEqual(['1:<https://example.com> 参照', '1:#重要 の項目']);
    });
  }

  it('is idempotent, and leaves links and plain text alone', () => {
    for (const { text } of MARKUP) {
      for (const form of ['heading', 'item'] as const) expect(inertTitle(inertTitle(text, form), form)).toBe(inertTitle(text, form));
    }
    expect(inertTitle('[リンク](https://example.com) と [[ノート]]', 'item')).toBe('[リンク](https://example.com) と [[ノート]]');
    expect(inertTitle('*強調* で始まる', 'item')).toBe('*強調* で始まる');
    expect(inertTitle('C# の話', 'heading')).toBe('C# の話');
    expect(inertTitle('1.5 倍', 'item')).toBe('1.5 倍');
  });
});

describe('fitBranches', () => {
  it('makes each text one line, drops empty items and lifts their children to their place', () => {
    expect(fitBranches([leaf('  a\n b  '), leaf(' ', leaf('c')), leaf('d', leaf('', leaf('e')))], 3))
      .toEqual([leaf('a b'), leaf('c'), leaf('d', leaf('e'))]);
  });

  it('lifts levels past the depth after the item they were under, in order', () => {
    expect(fitBranches([leaf('a', leaf('b', leaf('c'), leaf('d')), leaf('e'))], 2))
      .toEqual([leaf('a', leaf('b'), leaf('c'), leaf('d'), leaf('e'))]);
    expect(fitBranches([leaf('a')], 0)).toEqual([]);
  });
});
