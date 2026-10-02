/**
 * LEV-300（本人の報告 2026-10-02）: 左のリボンの「マインドマップを開く」は、開いているノートがマップでない（ノートが
 * 無い）と「先に『このノートをマインドマップ化』を実行してください。」を出すだけで何もしなかった。マップのノートなら
 * 今どおり開き、それ以外はコマンド「新しいマインドマップを作成」と同じく無題のマップを作って開く。開いているノートは
 * 書き換えない（マップ化しない）。
 *
 * 行列は本人の操作（リボンを押す）× アクティブなものの形（マップのノート 4 レイアウト・マップでないノート・`mappy:
 * false`・frontmatter の無いノート・Excalidraw の図面・何も開いていない・まだ索引されていないノート・旧形式の
 * `mappy-layout` だけのノート）。修正を戻す（`runRibbon` を元の src/main.ts の分岐にする）と、作る行が `create` を
 * 呼ばずに落ちる（`artifacts/lev-300/before-fix.txt`）。旧形式の 2 行は独立レビューの指摘で足した（その分岐を外すと
 * create に流れて落ちる: `artifacts/lev-300/legacy-before.txt`）。マップのノートを開く 4 行は 0.4.5 からの挙動の保持で、
 * 修正を戻しても通る（回帰テストではない）。
 *
 * ここで見るのは `runRibbon` の振り分けまで（旧版の通知は main.ts の中で出していたのでここには届かない）。
 * `runRibbon` は vault に触れないので、作る経路（`createMap` → `createMindmapFile` → `open`）が開いていたノートを
 * 書かないことは実機 E82 が見る。
 */
import { describe, expect, it, vi } from 'vitest';
import { TFile, type App } from 'obsidian';
import type { LayoutMode } from '../../src/layout/layout';
import { runRibbon } from '../../src/obsidian/ribbon';

function file(path: string): TFile {
  const result = new TFile();
  result.path = path;
  return result;
}

/** Presses the button with `cache` as the active note's metadata (null while Obsidian has not indexed it yet). */
function press(active: TFile | null, cache: { frontmatter?: Record<string, unknown> } | null) {
  const app = { metadataCache: { getFileCache: () => cache } } as unknown as App;
  const routes = { open: vi.fn(), create: vi.fn(), notReady: vi.fn(), convertFirst: vi.fn() };
  runRibbon(app, active, routes);
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
    ['a note without frontmatter (an empty new note once indexed)', file('Notes/Bare.md'), {}],
    ['an Excalidraw drawing', file('Drawings/Sketch.md'), { frontmatter: { mappy: true, 'excalidraw-plugin': 'parsed' } }],
    ['nothing open', null, null],
  ];
  for (const [shape, active, cache] of OTHERS) {
    it(`routes to a new map for ${shape}`, () => {
      const routes = press(active, cache);
      expect(routes.create).toHaveBeenCalledOnce();
      expect(routes.open).not.toHaveBeenCalled();
      expect(routes.notReady).not.toHaveBeenCalled();
    });
  }

  // The old format (architecture.md: `mappy-layout` without `mappy: true`) is the user's map from before `mappy: true`:
  // the button points them to the conversion, which keeps that layout, as through 0.4.5, and makes no new map.
  for (const layout of ['timeline', 'mindmap']) {
    it(`points an old-format note (mappy-layout: ${layout} alone) to the conversion, making nothing`, () => {
      const routes = press(file('Maps/Old.md'), { frontmatter: { 'mappy-layout': layout } });
      expect(routes.convertFirst).toHaveBeenCalledOnce();
      expect(routes.create).not.toHaveBeenCalled();
      expect(routes.open).not.toHaveBeenCalled();
      expect(routes.notReady).not.toHaveBeenCalled();
    });
  }

  it('neither opens nor creates for a note the metadata cache has not read yet', () => {
    // Obsidian still indexing at startup, or a note made a moment ago (Obsidian 1.14.2 indexes an empty new note within
    // ~50 ms: artifacts/lev-300/probe-empty-note.txt): a new map here would be a note the user did not ask for.
    const routes = press(file('Maps/Plan.md'), null);
    expect(routes.notReady).toHaveBeenCalledOnce();
    expect(routes.open).not.toHaveBeenCalled();
    expect(routes.create).not.toHaveBeenCalled();
  });
});
