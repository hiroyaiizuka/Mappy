import { describe, expect, it } from 'vitest';
import { applyEdits, planEdit, type EditCommand } from '../../src/core/commands';
import { parseMarkdown, projectMap, type MindDocument } from '../../src/core/markdown';
import { readTopicPositions } from '../../src/core/topics';

/**
 * LEV-301（本人の報告 2026-10-02）: 見出しの無いノートの仮の根（ファイル名）。Tab は根の右に「メイントピック」をつなぎ
 * （`## <ファイル名>` と子の項目を 1 回の編集で書く。新しいマップと同じ形）、名前の変更は `## <新しい名前>` を書いて根を
 * 実体化する。修正前は Tab が `## ` を末尾に書き、それが本文の根になってファイル名が消えた（項目のあるノートでは
 * フリートピックになった）。名前の変更は core が `rootAddsChildOnly` で拒んでいた。
 *
 * 行列は対象の形（本文が空・frontmatter だけ・改行で終わらない frontmatter・空行だけの本文・見出しの無い段落・
 * 見出しの無い項目・項目の後に H2 のトピック・CRLF）× 操作（Tab・Tab で書く名前つき・名前の変更）。
 */
const FILE = '無題のファイル 49';

function parse(source: string, title = FILE): MindDocument {
  return parseMarkdown(source, title);
}

function run(doc: MindDocument, command: EditCommand): { source: string; doc: MindDocument; selected: string | undefined } {
  const plan = planEdit(doc, command);
  const source = applyEdits(doc.source, plan.edits);
  const after = parseMarkdown(source, doc.root.title, doc, doc.format, plan.edits);
  return { source, doc: after, selected: after.nodes.find(node => node.titleFrom === plan.selectionOffset)?.title };
}

interface Shape { id: string; source: string; tab: string; renamed: string }

const SHAPES: readonly Shape[] = [
  { id: '本文が空', source: '', tab: `## ${FILE}\n\n- メイントピック`, renamed: '## 新しい名前' },
  {
    id: 'frontmatter だけ', source: '---\nmappy: true\n---\n',
    tab: `---\nmappy: true\n---\n\n## ${FILE}\n\n- メイントピック\n`, renamed: '---\nmappy: true\n---\n\n## 新しい名前\n',
  },
  {
    id: '改行で終わらない frontmatter', source: '---\nmappy: true\n---',
    tab: `---\nmappy: true\n---\n\n## ${FILE}\n\n- メイントピック`, renamed: '---\nmappy: true\n---\n\n## 新しい名前',
  },
  {
    id: '空行だけの本文', source: '---\nmappy: true\n---\n\n\n',
    tab: `---\nmappy: true\n---\n\n\n## ${FILE}\n\n- メイントピック\n`, renamed: '---\nmappy: true\n---\n\n\n## 新しい名前\n',
  },
  {
    id: '見出しの無い段落', source: '---\nmappy: true\n---\nメモ\n',
    tab: `---\nmappy: true\n---\n\n## ${FILE}\n\nメモ\n\n- メイントピック\n`, renamed: '---\nmappy: true\n---\n\n## 新しい名前\n\nメモ\n',
  },
  {
    id: '見出しの無い項目', source: '---\nmappy: true\n---\n- 温泉旅行\n  - 予約\n',
    tab: `---\nmappy: true\n---\n\n## ${FILE}\n\n- 温泉旅行\n  - 予約\n- メイントピック\n`,
    renamed: '---\nmappy: true\n---\n\n## 新しい名前\n\n- 温泉旅行\n  - 予約\n',
  },
  {
    id: '項目の後に H2 のトピック', source: '- a\n\n## 別の話\n- b\n',
    tab: `## ${FILE}\n\n- a\n- メイントピック\n\n## 別の話\n- b\n`, renamed: '## 新しい名前\n\n- a\n\n## 別の話\n- b\n',
  },
  {
    id: 'CRLF', source: '---\r\nmappy: true\r\n---\r\n- a\r\n',
    tab: `---\r\nmappy: true\r\n---\r\n\r\n## ${FILE}\r\n\r\n- a\r\n- メイントピック\r\n`, renamed: '---\r\nmappy: true\r\n---\r\n\r\n## 新しい名前\r\n\r\n- a\r\n',
  },
];

describe('the file-name root of a note without a heading section (LEV-301)', () => {
  it.each(SHAPES)('$id: Tab writes the file name as the body root and a main topic to its right, in one edit set', ({ source, tab }) => {
    const doc = parse(source);
    expect(projectMap(doc).root.kind).toBe('root');
    const { source: written, doc: after, selected } = run(doc, { type: 'add-child', nodeId: 'root', title: 'メイントピック' });
    expect(written).toBe(tab);
    const body = projectMap(after).root;
    expect(body.kind).toBe('atx');
    expect(body.title).toBe(FILE);
    expect(body.children.at(-1)?.title).toBe('メイントピック');
    expect(selected).toBe('メイントピック');
    // Every node the note had keeps its id, its title and its place under the root it stood under.
    for (const node of doc.nodes) {
      const kept = after.nodes.find(candidate => candidate.id === node.id);
      expect(kept?.title).toBe(node.title);
      expect(kept?.parentId).toBe(node.parentId === 'root' && node.kind === 'list' ? body.id : node.parentId);
    }
  });

  it.each(SHAPES)('$id: renaming writes the new name as the body root and leaves the rest as it is', ({ source, renamed }) => {
    const doc = parse(source);
    const { source: written, doc: after, selected } = run(doc, { type: 'rename', nodeId: 'root', title: '新しい名前' });
    expect(written).toBe(renamed);
    expect(projectMap(after).root.title).toBe('新しい名前');
    expect(selected).toBe('新しい名前');
  });

  it('writes nothing when the name is left as the file name, or emptied', () => {
    const doc = parse('---\nmappy: true\n---\n- a\n');
    for (const title of [FILE, ` ${FILE} `, '', '   ']) {
      expect(planEdit(doc, { type: 'rename', nodeId: 'root', title })).toEqual({ edits: [], selectionOffset: null });
    }
  });

  // Code review of LEV-301: only lines that end are skipped; spaces with no break after them stay where they were, after the heading.
  it('leaves a last line of only spaces after the heading, byte for byte', () => {
    expect(run(parse('---\nmappy: true\n---\n   '), { type: 'rename', nodeId: 'root', title: '新しい名前' }).source)
      .toBe('---\nmappy: true\n---\n\n## 新しい名前\n\n   ');
  });

  it('writes an empty item for the inline editor when no text is given, as Tab plans it before naming it', () => {
    expect(run(parse(''), { type: 'add-child', nodeId: 'root' }).source).toBe(`## ${FILE}\n\n- `);
  });

  it('keeps a line break of the draft as `<br>` in the heading, as any title does (LEV-202)', () => {
    expect(run(parse(''), { type: 'rename', nodeId: 'root', title: '一行目\n二行目' }).source).toBe('## 一行目<br>二行目');
  });

  it('refuses a name the heading cannot hold as it is, rather than writing another title', () => {
    // `## 名前 #` reads as `名前`: the closing sequence is not part of the heading's text.
    expect(() => planEdit(parse(''), { type: 'rename', nodeId: 'root', title: '名前 #' })).toThrow();
    expect(() => planEdit(parse('', '名前 #'), { type: 'add-child', nodeId: 'root', title: 'メイントピック' })).toThrow();
  });

  it('moves a topic position whose key the new body root takes, in the same edit set', () => {
    // Topic keys skip a number that is the text of a top-level heading (topicKeys): `X (2)` is the body root's text now.
    const source = '---\nmappy-topics:\n  X: { mindmap: [1, 1] }\n  "X (2)": { mindmap: [2, 2] }\n---\n- a\n\n## X\n\n## X\n';
    const doc = parse(source, 'X (2)');
    const { source: written } = run(doc, { type: 'add-child', nodeId: 'root', title: 'メイントピック' });
    expect([...readTopicPositions(written).keys()]).toEqual(['X', 'X (3)']);
    expect(readTopicPositions(written).get('X (3)')).toEqual({ mindmap: { x: 2, y: 2 } });
  });

  it('leaves Enter, Delete and moves on the file-name root refused, as before', () => {
    const doc = parse('- a\n');
    for (const command of [
      { type: 'add-sibling', nodeId: 'root' }, { type: 'delete', nodeId: 'root' }, { type: 'move-up', nodeId: 'root' },
    ] as const) expect(() => planEdit(doc, command)).toThrow();
  });

  // A control: it passes with the fix reverted too, and pins that the fix stays on the file-name root.
  it('keeps add-child on the parse root of a note whose body is a heading: a new section at the end', () => {
    // Not the file-name root: the map never shows it, and a called map adds there only with nothing selected.
    expect(run(parse('## Root\n- A\n'), { type: 'add-child', nodeId: 'root' }).source).toBe('## Root\n- A\n\n## \n');
    expect(run(parse('# H1\n'), { type: 'add-child', nodeId: 'root' }).source).toBe('# H1\n\n# \n');
  });
});
