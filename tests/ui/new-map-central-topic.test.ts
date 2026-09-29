// @vitest-environment jsdom
/**
 * LEV-255（本人のフィードバック 2026-09-29）: 新しいマップのルートの仮の名前は「中心トピック」／`Central topic`。
 * そこで Tab すると「メイントピック」（LEV-250）、さらに Tab すると「サブトピック」。ファイル名は従来どおり
 * 「無題のマインドマップ（n）」のまま。
 *
 * 行列は本人の操作（新しいマップを作る → ルートを見る → ルートで Tab → できたノードで Tab）× 設定の既定のレイアウト
 * 4 種 × 言語（ja・en）。新しいマップを作る経路はコマンド「新しいマインドマップを作成」だけ（src/main.ts。リボンは
 * 開く、ファイルメニューは既存のノートを変換するだけで、どちらもノートを作らない）で、それが呼ぶ `createMindmapFile`
 * の書いた原文をそのままビューで開く。
 *
 * 修正を戻すと 9 件すべてが落ちる（8 行は作られた原文の見出し、1 行は文言表に `centralTopicTitle` が無いこと。
 * `artifacts/lev-255/before-fix.txt`）。同じ行の後半の Tab 2 段は LEV-250 の挙動で、ルートが見出しの区画になっても
 * 深さの判定（ルートの直下はメイントピック、その下はサブトピック）が崩れないことを見ている。
 */
import type { App } from 'obsidian';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installObsidianDom } from '../browser-harness/dom';
import { TFile, TFolder } from '../browser-harness/obsidian';
import type { LayoutMode } from '../../src/layout/layout';
import { projectMap } from '../../src/core/markdown';
import { createMindmapFile } from '../../src/obsidian/map-files';
import { setLanguage, t } from '../../src/i18n';
import { mountMapView, type MountedMapView } from './map-view-mount';
import { closeOpenViews } from '../mocks/open-views';

vi.mock('obsidian', () => import('../browser-harness/obsidian'));
beforeAll(() => { installObsidianDom(); });

afterEach(async () => {
  await closeOpenViews();
  document.body.replaceChildren();
  setLanguage('ja');
});

const LAYOUTS: readonly LayoutMode[] = ['mindmap', 'timeline', 'hierarchy', 'balanced'];
// Spelled out rather than read from the table, so a missing or mixed-up key fails here.
const NAMES = {
  ja: { file: '無題のマインドマップ', root: '中心トピック', main: 'メイントピック', sub: 'サブトピック' },
  en: { file: 'Untitled mind map', root: 'Central topic', main: 'Main topic', sub: 'Subtopic' },
} as const;

/** What the command writes: the path and the note `createMindmapFile` hands to `vault.create`. */
async function createNewMap(layout: LayoutMode): Promise<{ path: string; source: string }> {
  const parent = new TFolder();
  parent.path = 'Maps';
  let created: { path: string; source: string } | null = null;
  const app = {
    fileManager: { getNewFileParent: () => parent },
    vault: {
      getAbstractFileByPath: () => null,
      create: (path: string, source: string) => {
        created = { path, source };
        const file = new TFile();
        file.path = path;
        return Promise.resolve(file);
      },
    },
  } as unknown as App;
  await createMindmapFile(app, 'Notes/Current.md', { layout, folder: '' });
  if (!created) throw new Error('The command wrote no note');
  return created;
}

/** Tab on `target`, then Enter on the untouched draft; returns the name the draft opened with. */
async function tabAndKeep(mounted: MountedMapView, target: string): Promise<string> {
  mounted.key(mounted.select(target), 'Tab');
  await mounted.settle();
  const input = mounted.editor();
  if (!input) throw new Error(`No draft opened under ${target}`);
  const name = input.value;
  mounted.key(input, 'Enter');
  await mounted.settle();
  expect(mounted.editor()).toBeNull();
  return name;
}

describe('a new map starts from a central topic (LEV-255)', () => {
  for (const language of ['ja', 'en'] as const) {
    const names = NAMES[language];
    for (const layout of LAYOUTS) {
      it(`${language} / ${layout}: the root reads ${names.root}, the file keeps ${names.file}, Tab → ${names.main} → ${names.sub}`, async () => {
        setLanguage(language);
        const { path, source } = await createNewMap(layout);
        expect(path).toBe(`Maps/${names.file}.md`);
        const properties = layout === 'mindmap' ? 'mappy: true\n' : `mappy: true\nmappy-layout: ${layout}\n`;
        expect(source).toBe(`---\n${properties}---\n\n## ${names.root}\n`);

        const mounted = await mountMapView(path, source, layout);
        // The root drawn is the body's first section (projectMap); `document.root` is the file-name root behind it.
        const parsed = mounted.view.snapshot()?.document;
        if (!parsed) throw new Error('The view has no document');
        expect(projectMap(parsed).root.title).toBe(names.root);
        expect(mounted.node(names.root).classList.contains('is-root')).toBe(true);
        expect(() => mounted.node(names.file)).toThrow();

        expect(await tabAndKeep(mounted, names.root)).toBe(names.main);
        expect(await tabAndKeep(mounted, names.main)).toBe(names.sub);
        expect(mounted.source()).toBe(`---\n${properties}---\n\n## ${names.root}\n\n- ${names.main}\n  - ${names.sub}\n`);
      });
    }
  }

  it('reads the names from the table in both languages', () => {
    for (const language of ['ja', 'en'] as const) {
      setLanguage(language);
      const text = t();
      expect([text.untitled, text.centralTopicTitle, text.mainTopicTitle, text.newNodeTitle])
        .toEqual(Object.values(NAMES[language]));
    }
  });
});
