import { describe, expect, it } from 'vitest';
import { calledNodeId, projectShown, type CallTargets } from '../../src/core/calls';
import { foldKeyOf, isFoldKey, nodeOfFoldKey, type FoldKey } from '../../src/core/fold-keys';
import { parseMarkdown, type MindDocument } from '../../src/core/markdown';

/**
 * LEV-365: a fold kept for the next opening of a note names its node by the titles on the way to it, the same-titled
 * siblings told apart by their number, and a called map's node by its calling item's key, `null`, then its titles in the
 * called note. A key made on one parse names the same node on a parse of the note after any change that leaves the
 * titles on the way to it as they were.
 */
const LIST = [
  '---', 'mappy: true', '---',
  '## リストのマップ',
  '- 枝A', '  - A1', '    - A1a',
  '- 同名', '  - 一つ目の子',
  '- 同名', '  - 二つ目の子',
  '- ', '  - 空の子',
  '- ![[呼び出し先]]', '  - 自分の子',
  '',
  '## トピック', '- T1', '  - T1a', '',
].join('\n');
const HEADINGS = ['# 見出し', '## 章', '### 同じ', '#### 子1', '### 同じ', '#### 子2', ''].join('\n');
const CALLED = ['---', 'mappy: true', '---', '## 呼び出し先', '- C1', '  - C1a', '- C1', '  - C1b', ''].join('\n');

const byTitle = (document: MindDocument, title: string, nth = 1): string => {
  const found = document.nodes.filter(node => node.title === title)[nth - 1];
  if (!found) throw new Error(`no ${title} #${nth}`);
  return found.id;
};

function withCall(source = LIST): { document: MindDocument; called: MindDocument; calls: ReturnType<typeof projectShown>['calls']; caller: string } {
  const document = parseMarkdown(source, 'リスト');
  const called = parseMarkdown(CALLED, '呼び出し先');
  const caller = byTitle(document, '![[呼び出し先]]');
  const targets: CallTargets = new Map([[caller, { path: '呼び出し先.md', subpath: '', document: called }]]);
  return { document, called, calls: projectShown(document, targets).calls, caller };
}

describe('foldKeyOf', () => {
  it('names a node by the titles from the top of the note, the file name root left out', () => {
    const document = parseMarkdown(LIST, 'リスト');
    expect(foldKeyOf(document, undefined, 'root')).toEqual([]);
    expect(foldKeyOf(document, undefined, byTitle(document, 'リストのマップ'))).toEqual(['リストのマップ']);
    expect(foldKeyOf(document, undefined, byTitle(document, 'A1'))).toEqual(['リストのマップ', '枝A', 'A1']);
    expect(foldKeyOf(document, undefined, byTitle(document, 'T1'))).toEqual(['トピック', 'T1']);
  });

  it('tells siblings of one title apart by their number, the first keeping none, and keys an empty title as one', () => {
    const document = parseMarkdown(LIST, 'リスト');
    expect(foldKeyOf(document, undefined, byTitle(document, '同名', 1))).toEqual(['リストのマップ', '同名']);
    expect(foldKeyOf(document, undefined, byTitle(document, '同名', 2))).toEqual(['リストのマップ', '同名', 2]);
    expect(foldKeyOf(document, undefined, byTitle(document, '二つ目の子'))).toEqual(['リストのマップ', '同名', 2, '二つ目の子']);
    expect(foldKeyOf(document, undefined, byTitle(document, ''))).toEqual(['リストのマップ', '']);
    const headings = parseMarkdown(HEADINGS, '見出し');
    expect(foldKeyOf(headings, undefined, byTitle(headings, '同じ', 2))).toEqual(['見出し', '章', '同じ', 2]);
  });

  it('keys a called node under its calling item by its titles in the called note, and the item by its own text', () => {
    const { document, called, calls, caller } = withCall();
    const second = called.nodes.filter(node => node.title === 'C1')[1]!;
    expect(foldKeyOf(document, calls, caller)).toEqual(['リストのマップ', '![[呼び出し先]]']);
    expect(foldKeyOf(document, calls, calledNodeId(caller, second.id))).toEqual(['リストのマップ', '![[呼び出し先]]', null, 'C1', 2]);
    const c1b = called.nodes.find(node => node.title === 'C1b')!;
    expect(foldKeyOf(document, calls, calledNodeId(caller, c1b.id))).toEqual(['リストのマップ', '![[呼び出し先]]', null, 'C1', 2, 'C1b']);
    // The item's own child counts among its own: the called ones come first on the map, under a key of their own.
    expect(foldKeyOf(document, calls, byTitle(document, '自分の子'))).toEqual(['リストのマップ', '![[呼び出し先]]', '自分の子']);
  });

  it('has no key for an id the note does not have', () => {
    const { document, calls, caller } = withCall();
    expect(foldKeyOf(document, calls, 'node-missing')).toBeUndefined();
    expect(foldKeyOf(document, undefined, calledNodeId(caller, 'node-x'))).toBeUndefined();
    expect(foldKeyOf(document, calls, calledNodeId(caller, 'node-x'))).toBeUndefined();
  });
});

describe('nodeOfFoldKey', () => {
  it('finds every node of a note, called ones included, by its own key', () => {
    const { document, calls } = withCall();
    for (const id of calls.byId.keys()) {
      const key = foldKeyOf(document, calls, id);
      expect(key, id).toBeDefined();
      expect(nodeOfFoldKey(document, calls, key!), JSON.stringify(key)).toBe(id);
    }
  });

  it('finds the same node on a parse of the note after other nodes are added, deleted and moved outside the map', () => {
    const { document, calls } = withCall();
    const keys = new Map(['A1', '二つ目の子', '空の子', 'T1'].map(title => [title, foldKeyOf(document, calls, byTitle(document, title))!]));
    const edited = LIST
      .replace('- 枝A\n  - A1\n    - A1a\n', '')
      .replace('- ![[呼び出し先]]\n', '- 足した\n- 枝A\n  - A1\n    - A1a\n- ![[呼び出し先]]\n')
      .replace('## トピック', '## 新しいトピック\n- X\n\n## トピック');
    const after = withCall(edited);
    for (const [title, key] of keys) expect(nodeOfFoldKey(after.document, after.calls, key), title).toBe(byTitle(after.document, title));
  });

  it('finds nothing where no node stands: a title renamed, a number past the siblings, a call that draws nothing', () => {
    const { document, calls } = withCall();
    expect(nodeOfFoldKey(document, calls, ['リストのマップ', '別の名前'])).toBeUndefined();
    expect(nodeOfFoldKey(document, calls, ['リストのマップ', '同名', 3])).toBeUndefined();
    expect(nodeOfFoldKey(document, calls, ['リストのマップ', '![[呼び出し先]]', null, 'C9'])).toBeUndefined();
    expect(nodeOfFoldKey(document, undefined, ['リストのマップ', '![[呼び出し先]]', null, 'C1'])).toBeUndefined();
  });
});

describe('isFoldKey', () => {
  it('takes titles, numbers of 2 and more after a title, and one null after a title', () => {
    const good: FoldKey[] = [[], ['a'], ['a', 2, 'b'], ['', 3], ['a', null, 'b', 2]];
    for (const key of good) expect(isFoldKey(key), JSON.stringify(key)).toBe(true);
    const bad: unknown[] = [
      'a', null, {}, [1], ['a', 1], ['a', 2.5], [null, 'a'], ['a', null], ['a', null, 'b', null, 'c'], ['a', 2, 2], ['a', true],
    ];
    for (const key of bad) expect(isFoldKey(key), JSON.stringify(key)).toBe(false);
  });
});
