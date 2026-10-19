import { describe, expect, it } from 'vitest';
import type { FoldKey } from '../../src/core/fold-keys';
import {
  FOLD_LIMITS, isRemoved, readFoldFile, relinkedKey, renamedPaths, sameFolds, sortedKeys, writeFoldFile, type StoredFolds,
} from '../../src/core/fold-memory';

/**
 * LEV-365: the memory's file — its shape, what a load accepts of it, and the limits a write keeps it under (the notes
 * whose folds changed last first). A text that is not such a file reads as none.
 */
const stored = (at: number, folds: FoldKey[], open: FoldKey[] = []): StoredFolds => ({ at, folds, open });

describe('readFoldFile', () => {
  it('reads the notes a write wrote, as they were', () => {
    const notes = new Map([
      ['Maps/計画.md', stored(5, [['計画', 'Phase 1'], ['計画', '同名', 2]], [['計画', '![[他]]', null, 'C1']])],
      ['ほか.md', stored(3, [[]])],
    ]);
    const { text, kept } = writeFoldFile(notes, 42);
    expect(kept).toEqual(new Set(notes.keys()));
    expect(readFoldFile(text)).toEqual({ savedAt: 42, notes });
  });

  it('reads nothing from a text that is not the file: broken, cut, another version, another shape', () => {
    for (const text of ['', '{', '{"version":1,"notes":', 'null', '[]', '{"version":2,"notes":{}}', '{"version":1,"notes":[]}', '{"version":1}']) {
      expect(readFoldFile(text), text).toBeNull();
    }
  });

  it('leaves out what does not read inside a file that does: a bad key, a note with no folds, a note that is not an object', () => {
    const text = JSON.stringify({
      version: 1, savedAt: 'later',
      notes: {
        'a.md': { at: 1, folds: [['a'], ['a', 1], 'a', null], open: 'x' },
        'b.md': { at: 2, folds: [], open: [] },
        'c.md': 'folds',
        'd.md': { folds: [['d']] },
      },
    });
    expect(readFoldFile(text)).toEqual({ savedAt: 0, notes: new Map([['a.md', stored(1, [['a']])], ['d.md', stored(0, [['d']])]]) });
  });
});

describe('writeFoldFile', () => {
  it('keeps the notes whose folds changed last, up to the number of notes', () => {
    const notes = new Map(Array.from({ length: 5 }, (_, index) => [`${index}.md`, stored(index, [['x']])]));
    const { text, kept } = writeFoldFile(notes, 1, { notes: 3, bytes: 1_000_000 });
    expect(kept).toEqual(new Set(['4.md', '3.md', '2.md']));
    expect(Array.from(readFoldFile(text)!.notes.keys()).sort()).toEqual(['2.md', '3.md', '4.md']);
  });

  it('keeps the file under its bytes, counted in UTF-8, by leaving out the notes changed longest ago', () => {
    const title = '日本語の長い見出し'.repeat(10);
    const notes = new Map(Array.from({ length: 50 }, (_, index) => [`ノート ${index}.md`, stored(index, [[title, String(index)]])]));
    const limit = 5_000;
    const { text, kept } = writeFoldFile(notes, 1, { notes: 1000, bytes: limit });
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(limit);
    expect(kept.size).toBeGreaterThan(0);
    expect(kept.size).toBeLessThan(50);
    const newest = Array.from(kept).map(path => notes.get(path)!.at);
    expect(Math.min(...newest)).toBe(50 - kept.size);
  });

  it('holds 1,000 notes of 20 deep folds in long Japanese titles within the limits', () => {
    const key = (note: number, fold: number): FoldKey => [`第${note}章 計画の見出し`, `節 ${fold % 5}`, `項目の題名 ${fold}`];
    const notes = new Map(Array.from({ length: 1000 }, (_, note) => [
      `Projects/分野 ${note % 20}/計画ノート ${note}.md`, stored(note, Array.from({ length: 20 }, (_, fold) => key(note, fold))),
    ]));
    const { text, kept } = writeFoldFile(notes, 1);
    expect(kept.size).toBe(1000);
    expect(new TextEncoder().encode(text).length).toBeLessThan(FOLD_LIMITS.bytes);
  });
});

describe('paths', () => {
  it('follows a note or a folder renamed, and nothing that only begins with the same letters', () => {
    const paths = ['a.md', 'A/b.md', 'A/C/d.md', 'AB/e.md'];
    expect(renamedPaths(paths, 'a.md', 'z.md')).toEqual(new Map([['a.md', 'z.md']]));
    expect(renamedPaths(paths, 'A', 'Z/Y')).toEqual(new Map([['A/b.md', 'Z/Y/b.md'], ['A/C/d.md', 'Z/Y/C/d.md']]));
    expect(isRemoved('A/C/d.md', 'A')).toBe(true);
    expect(isRemoved('AB/e.md', 'A')).toBe(false);
  });
});

describe('sortedKeys and sameFolds', () => {
  it('makes the same folds the same entry whatever order they came in, once each', () => {
    const one = sortedKeys([['b'], ['a', 2], ['a'], ['b']]);
    const two = sortedKeys([['a'], ['b'], ['a', 2]]);
    expect(one).toEqual(two);
    expect(sameFolds({ folds: one, open: [] }, { folds: two, open: [] })).toBe(true);
    expect(sameFolds({ folds: one, open: [] }, { folds: [], open: one })).toBe(false);
    expect(sameFolds(undefined, { folds: [], open: [] })).toBe(false);
  });
});

describe('relinkedKey (code review 3)', () => {
  it('rewrites a calling item’s link to a renamed note as Obsidian’s link update does, its heading and alias kept', () => {
    expect(relinkedKey(['根', '![[Plan]]', null, 'C1'], 'Maps/Plan.md', 'Maps/Plan v2.md')).toEqual(['根', '![[Plan v2]]', null, 'C1']);
    expect(relinkedKey(['根', '![[Maps/Plan#節|別名]]'], 'Maps/Plan.md', 'Maps/Plan v2.md')).toEqual(['根', '![[Maps/Plan v2#節|別名]]']);
    expect(relinkedKey(['根', '![[Maps/Plan.md]]'], 'Maps/Plan.md', 'Archive/Plan.md')).toEqual(['根', '![[Archive/Plan.md]]']);
    // A note moved keeps its shortest link; a folder renamed rewrites the links by path that pass through it.
    expect(relinkedKey(['根', '![[Plan]]'], 'Maps/Plan.md', 'Archive/Plan.md')).toBeNull();
    expect(relinkedKey(['根', '![[Maps/Sub/Plan]]'], 'Maps', 'Areas')).toEqual(['根', '![[Areas/Sub/Plan]]']);
    expect(relinkedKey(['根', '![[Maps]]'], 'Maps', 'Areas')).toBeNull();
  });

  it('leaves every other step as it is: plain titles, links to other notes, a link inside a sentence', () => {
    expect(relinkedKey(['Plan', '![[Other]]', null, 'Plan'], 'Plan.md', 'New.md')).toBeNull();
    expect(relinkedKey(['文中の ![[Plan]] は呼び出しでない'], 'Plan.md', 'New.md')).toBeNull();
  });
});
