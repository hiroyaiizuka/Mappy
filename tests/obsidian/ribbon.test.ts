/**
 * LEV-300（本人の報告 2026-10-02）: 左のリボンの「マインドマップを開く」は、開いているノートがマップでない（ノートが
 * 無い）と「先に『このノートをマインドマップ化』を実行してください。」を出すだけで何もしなかった。マップのノートなら
 * 今どおり開き、それ以外はコマンド「新しいマインドマップを作成」と同じく無題のマップを作って開く。開いているノートは
 * 書き換えない（マップ化しない）。
 *
 * 行列は本人の操作（リボンを押す）× アクティブなものの形（マップのノート 4 レイアウト・マップでないノート・`mappy:
 * false`・frontmatter の無いノート・Excalidraw の図面・何も開いていない・まだ索引されていないノート）。修正を戻す
 * （`runRibbon` を元の src/main.ts の分岐にする）と、作る行が通知を出すだけで落ちる（`artifacts/lev-300/before-fix.txt`）。
 *
 * ここで見るのは `runRibbon` の振り分けと、振り分けがノートに何も書かないことまで。作る経路（`createMap` →
 * `createMindmapFile` → `open`）が開いていたノートを書かないことは実機 E82 が見る（main.ts はここで起動できない）。
 */
import { describe, expect, it, vi } from 'vitest';
import { TFile, type App } from 'obsidian';
import { Notice } from '../mocks/obsidian';
import type { LayoutMode } from '../../src/layout/layout';
import { runRibbon, singleFlight } from '../../src/obsidian/ribbon';

function file(path: string): TFile {
  const result = new TFile();
  result.path = path;
  return result;
}

/** `cache`: the note's metadata as Obsidian indexed it, or null while it is not indexed yet. */
function app(cache: { frontmatter?: Record<string, unknown> } | null) {
  const writes = {
    processFrontMatter: vi.fn(() => Promise.resolve()),
    modify: vi.fn(() => Promise.resolve()),
    process: vi.fn(() => Promise.resolve('')),
    create: vi.fn(() => Promise.resolve(null)),
  };
  const instance = {
    metadataCache: { getFileCache: () => cache },
    fileManager: { processFrontMatter: writes.processFrontMatter },
    vault: { modify: writes.modify, process: writes.process, create: writes.create },
  } as unknown as App;
  return { instance, writes };
}

function press(active: TFile | null, cache: { frontmatter?: Record<string, unknown> } | null) {
  const { instance, writes } = app(cache);
  const routes = { open: vi.fn(), create: vi.fn(), notReady: vi.fn() };
  Notice.messages = [];
  runRibbon(instance, active, routes);
  for (const write of Object.values(writes)) expect(write).not.toHaveBeenCalled();
  expect(Notice.messages).toEqual([]);
  return routes;
}

describe('the ribbon button (LEV-300)', () => {
  const LAYOUTS: readonly LayoutMode[] = ['mindmap', 'timeline', 'hierarchy', 'balanced'];
  for (const layout of LAYOUTS) {
    it(`opens the active map note in its own layout (${layout})`, () => {
      const note = file('Maps/Plan.md');
      const routes = press(note, { frontmatter: { mappy: true, 'mappy-layout': layout } });
      expect(routes.open).toHaveBeenCalledExactlyOnceWith(note, layout);
      expect(routes.create).not.toHaveBeenCalled();
      expect(routes.notReady).not.toHaveBeenCalled();
    });
  }

  // A file that is not Markdown never reaches here: `activeFile()` in src/main.ts gives null for it ("nothing open").
  const OTHERS: readonly [string, TFile | null, { frontmatter?: Record<string, unknown> } | null][] = [
    ['a note that is not a map', file('Notes/Plain.md'), { frontmatter: { tags: ['x'] } }],
    ['a note with mappy: false', file('Notes/Off.md'), { frontmatter: { mappy: false } }],
    ['a note without frontmatter', file('Notes/Bare.md'), {}],
    ['an Excalidraw drawing', file('Drawings/Sketch.md'), { frontmatter: { mappy: true, 'excalidraw-plugin': 'parsed' } }],
    ['nothing open', null, null],
  ];
  for (const [shape, active, cache] of OTHERS) {
    it(`routes to a new map, writing nothing itself, for ${shape}`, () => {
      const routes = press(active, cache);
      expect(routes.create).toHaveBeenCalledExactlyOnceWith(active);
      expect(routes.open).not.toHaveBeenCalled();
      expect(routes.notReady).not.toHaveBeenCalled();
    });
  }

  it('neither opens nor creates for a note the metadata cache has not read yet', () => {
    // Obsidian still indexing at startup, or the map a first click just made: a new map here would be a note the
    // user did not ask for.
    const routes = press(file('Maps/Plan.md'), null);
    expect(routes.notReady).toHaveBeenCalledOnce();
    expect(routes.open).not.toHaveBeenCalled();
    expect(routes.create).not.toHaveBeenCalled();
  });
});

describe('singleFlight (LEV-300: a double click makes one map)', () => {
  it('drops a call while the previous one is pending, and runs again once it has settled', async () => {
    let finish!: () => void;
    const calls: string[] = [];
    const run = vi.fn((path: string) => { calls.push(path); return new Promise<void>(resolve => { finish = resolve; }); });
    const once = singleFlight(run);
    const first = once('a');
    await once('b');
    expect(run).toHaveBeenCalledExactlyOnceWith('a');
    finish();
    await first;
    const third = once('c');
    finish();
    await third;
    expect(run).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(['a', 'c']);
  });

  it('runs again after a failure, and leaves the failure to the first caller', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('no folder')).mockResolvedValue(undefined);
    const once = singleFlight(run as () => Promise<void>);
    await expect(once()).rejects.toThrow('no folder');
    await expect(once()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
