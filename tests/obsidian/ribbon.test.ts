/**
 * LEV-300（本人の報告 2026-10-02）: 左のリボンの「マインドマップを開く」は、開いているノートがマップでない（ノートが
 * 無い）と「先に『このノートをマインドマップ化』を実行してください。」を出すだけで何もしなかった。マップのノートなら
 * 今どおり開き、それ以外はコマンド「新しいマインドマップを作成」と同じく無題のマップを作って開く。開いているノートは
 * 書き換えない（マップ化しない）。
 *
 * 行列は本人の操作（リボンを押す）× アクティブなものの形（マップのノート 4 レイアウト・マップでないノート・`mappy:
 * false`・frontmatter の無いノート・Excalidraw の図面・Markdown 以外・何も開いていない）。修正を戻す（`runRibbon` を
 * 元の src/main.ts の分岐にする）と、マップのノート以外の 6 行が通知を出すだけで落ちる（`artifacts/lev-300/before-fix.txt`）。
 */
import { describe, expect, it, vi } from 'vitest';
import { TFile, type App } from 'obsidian';
import { Notice } from '../mocks/obsidian';
import type { LayoutMode } from '../../src/layout/layout';
import { runRibbon } from '../../src/obsidian/ribbon';

function file(path: string): TFile {
  const result = new TFile();
  result.path = path;
  return result;
}

/** An app whose only note has `frontmatter`; every write it could make is a spy. */
function app(frontmatter: Record<string, unknown> | undefined) {
  const writes = {
    processFrontMatter: vi.fn(() => Promise.resolve()),
    modify: vi.fn(() => Promise.resolve()),
    process: vi.fn(() => Promise.resolve('')),
    create: vi.fn(() => Promise.resolve(null)),
  };
  const instance = {
    metadataCache: { getFileCache: () => (frontmatter ? { frontmatter } : null) },
    fileManager: { processFrontMatter: writes.processFrontMatter },
    vault: { modify: writes.modify, process: writes.process, create: writes.create },
  } as unknown as App;
  return { instance, writes };
}

function press(active: TFile | null, frontmatter?: Record<string, unknown>) {
  const { instance, writes } = app(frontmatter);
  const routes = { open: vi.fn(), create: vi.fn() };
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
      const routes = press(note, { mappy: true, 'mappy-layout': layout });
      expect(routes.open).toHaveBeenCalledExactlyOnceWith(note, layout);
      expect(routes.create).not.toHaveBeenCalled();
    });
  }

  const OTHERS: readonly [string, TFile | null, Record<string, unknown> | undefined][] = [
    ['a note that is not a map', file('Notes/Plain.md'), { tags: ['x'] }],
    ['a note with mappy: false', file('Notes/Off.md'), { mappy: false }],
    ['a note without frontmatter', file('Notes/Bare.md'), undefined],
    ['an Excalidraw drawing', file('Drawings/Sketch.md'), { mappy: true, 'excalidraw-plugin': 'parsed' }],
    ['a file that is not Markdown', file('Boards/Board.canvas'), { mappy: true }],
    ['nothing open', null, undefined],
  ];
  for (const [shape, active, frontmatter] of OTHERS) {
    it(`creates a new map, leaving the active file alone, for ${shape}`, () => {
      const routes = press(active, frontmatter);
      expect(routes.create).toHaveBeenCalledOnce();
      expect(routes.open).not.toHaveBeenCalled();
    });
  }
});
