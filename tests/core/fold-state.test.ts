import { describe, expect, it } from 'vitest';
import { calledNodeId, projectShown, type CallTargets } from '../../src/core/calls';
import type { FoldKey } from '../../src/core/fold-keys';
import { foldEntryOf, moves, rememberedFolds, rememberedIds, type FoldedMap, type KeptKey } from '../../src/core/fold-state';
import { parseMarkdown, type MindDocument } from '../../src/core/markdown';

/**
 * LEV-365: a map's folds between its ids and the keys kept for its note — what a view hands the memory, and what the
 * kept keys fold or leave open when the note opens again.
 */
const HOST = ['---', 'mappy: true', '---', '## 根', '- 枝', '  - 葉', '- 同名', '  - 子1', '- 同名', '  - 子2', '- ![[先]]', ''].join('\n');
const CALLED = ['---', 'mappy: true', '---', '## 先', '- C1', '  - C1a', '    - C1b', '- C2', '  - C2a', '- C3', ''].join('\n');

const id = (document: MindDocument, title: string, nth = 1): string => document.nodes.filter(node => node.title === title)[nth - 1]!.id;

function map(source = HOST, called: MindDocument | null = parseMarkdown(CALLED, '先')): FoldedMap & { called: MindDocument | null } {
  const document = parseMarkdown(source, '根');
  const caller = document.nodes.find(node => node.title === '![[先]]');
  const targets: CallTargets = called && caller ? new Map([[caller.id, { path: '先.md', subpath: '', document: called }]]) : new Map();
  return { document, calls: projectShown(document, targets).calls, called };
}

describe('foldEntryOf', () => {
  it('keeps the host’s folded nodes, and of a called map only the nodes with children shown open (they start folded)', () => {
    const shown = map();
    const caller = id(shown.document, '![[先]]');
    const c1 = calledNodeId(caller, id(shown.called!, 'C1'));
    const c1a = calledNodeId(caller, id(shown.called!, 'C1a'));
    const c2 = calledNodeId(caller, id(shown.called!, 'C2'));
    const c3 = calledNodeId(caller, id(shown.called!, 'C3'));
    // `known` holds the calling item too, as the view's does (`sources` lists it, root: true).
    const { entry, ids } = foldEntryOf(shown, new Set([id(shown.document, '同名', 2), c2]), new Set([caller, c1, c1a, c2, c3]));
    // C2 folded is as it starts: nothing to keep. The calling item is the host's own node, kept only when folded.
    expect(entry.folds).toEqual([['根', '同名', 2]]);
    // C1 and C1a start folded at every opening and were opened; C3 has no children, so it is nothing to keep.
    expect(entry.open).toEqual([['根', '![[先]]', null, 'C1', 'C1a'], ['根', '![[先]]', null, 'C1']]);
    expect(Array.from(ids.keys()).sort()).toEqual([id(shown.document, '同名', 2), c1, c1a].sort());
  });

  it('keeps nothing for a map shown as it opens: a call drawn with its called nodes folded as they start (code review 1)', () => {
    const shown = map();
    const caller = id(shown.document, '![[先]]');
    const known = new Set(shown.calls.sources.keys());
    const starting = new Set(Array.from(known).filter(item => item !== caller && (shown.calls.byId.get(item)?.children.length ?? 0) > 0));
    expect(foldEntryOf(shown, starting, known).entry).toEqual({ folds: [], open: [] });
    expect(foldEntryOf(shown, new Set([...starting, caller]), known).entry).toEqual({ folds: [['根', '![[先]]']], open: [] });
  });

  it('keeps a called map’s kept keys while its item is in the note and draws no map, and drops them once the item goes', () => {
    const remembered = rememberedFolds({ folds: [['根', '消えた']], open: [['根', '![[先]]', null, 'C1']] });
    const undrawn = map(HOST, null);
    expect(foldEntryOf(undrawn, new Set(), new Set(), remembered).entry).toEqual({ folds: [], open: [['根', '![[先]]', null, 'C1']] });
    const gone = map(HOST.replace('- ![[先]]\n', ''), null);
    expect(foldEntryOf(gone, new Set(), new Set(), remembered).entry).toEqual({ folds: [], open: [] });
    // Drawn, the map's own state decides: a kept key whose node is not in it is dropped.
    const drawn = map(HOST, parseMarkdown(CALLED.replace('- C1\n  - C1a\n    - C1b\n', ''), '先'));
    expect(foldEntryOf(drawn, new Set(), new Set(), remembered).entry).toEqual({ folds: [], open: [] });
  });
});

describe('rememberedIds', () => {
  it('names the nodes the kept keys stand for on a parse of the note made later', () => {
    const first = map();
    const caller = id(first.document, '![[先]]');
    const { entry } = foldEntryOf(first, new Set([id(first.document, '同名', 2), id(first.document, '枝')]),
      new Set([calledNodeId(caller, id(first.called!, 'C1'))]));
    const later = map(HOST.replace('- 枝\n', '- 足した\n- 枝\n'));
    const keys = rememberedFolds(entry);
    const laterCaller = id(later.document, '![[先]]');
    expect(rememberedIds(later, keys.folds)).toEqual(new Set([id(later.document, '同名', 2), id(later.document, '枝')]));
    expect(rememberedIds(later, keys.open)).toEqual(new Set([calledNodeId(laterCaller, id(later.called!, 'C1'))]));
  });
});

describe('moves', () => {
  it('tells the keys a re-parse moved (a node renamed, a same-titled sibling put before it), dropped, and brought back', () => {
    const fold = (...key: FoldKey): KeptKey => ({ key, open: false });
    const before = new Map<string, KeptKey>([['a', fold('根', '枝')], ['b', fold('根', '同名', 2)], ['c', fold('根', '消える')], ['d', fold('根', '同じ')]]);
    const after = new Map<string, KeptKey>([['a', fold('根', '新しい名前')], ['b', fold('根', '同名', 3)], ['d', fold('根', '同じ')], ['e', { key: ['根', '![[先]]', null, 'C1'], open: true }]]);
    const { moved, dropped, added } = moves(before, after);
    expect(moved).toEqual(new Map([[JSON.stringify(['根', '枝']), ['根', '新しい名前']], [JSON.stringify(['根', '同名', 2]), ['根', '同名', 3]]]));
    expect(dropped).toEqual(new Set([JSON.stringify(['根', '消える'])]));
    expect(added).toEqual([{ key: ['根', '![[先]]', null, 'C1'], open: true }]);
  });
});

describe('a called branch whose link is broken for a while (code review 3)', () => {
  it('keeps the key of a called node opened while the item draws no map, so the link typed again finds it kept', () => {
    const shown = map();
    const caller = id(shown.document, '![[先]]');
    const c1 = calledNodeId(caller, id(shown.called!, 'C1'));
    const first = foldEntryOf(shown, new Set(), new Set([caller, c1]));
    expect(first.entry.open).toEqual([['根', '![[先]]', null, 'C1']]);
    // The item's link mistyped: the view keeps the called ids (LEV-260), but no node of them is drawn.
    const typo = map(HOST.replace('![[先]]', '![[さき]]'), null);
    const during = foldEntryOf(typo, new Set(), new Set([caller, c1]), rememberedFolds(first.entry), first.ids);
    expect(during.entry.open).toEqual([['根', '![[先]]', null, 'C1']]);
    expect(moves(first.ids, during.ids)).toEqual({ moved: new Map(), dropped: new Set(), added: [] });
  });
});
