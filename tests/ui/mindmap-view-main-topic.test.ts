// @vitest-environment jsdom
/**
 * LEV-250（本人のフィードバック 2026-09-28）: 新しいノードの仮の名前は追加先の深さで決まる。親が地図上の木のルート
 * （本文のルート・フリートピックのルート・見出しの無いノートの仮のルート）なら「メイントピック」／`Main topic`、
 * それより下の枝は従来どおり「サブトピック」／`Subtopic`。フリートピックになるノードは「トピック」のまま（LEV-203）。
 *
 * 行列は本人の操作（ルートで Tab・第一階層で Enter／Tab・深い階層で Enter／Tab・右クリックメニューの「子／兄弟を
 * 追加」・ドラッグで親を変えた後の Enter）× 文書の形（リスト形式・見出し形式〔H1 の下の H2 区画〕・フリートピックの
 * 本体・見出しの無いノート）× 4 レイアウト × 言語（ja・en）。期待は「開いた入力欄の値」と「そのノードの親」の両方で
 * 見る: 名前だけを見ると、別の場所に同じ名前が書かれても通ってしまう。
 *
 * 修正を戻すと落ちるのは Main topic の行（と空のノートの行）。Subtopic の行は戻しても通る: 深さで分けた結果、
 * 第二階層より下まで「メイントピック」にしてしまう行き過ぎを固定する対照として置いている。
 */
import type { App } from 'obsidian';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HarnessApp } from '../browser-harness/app';
import { installObsidianDom } from '../browser-harness/dom';
import { resolveDrop } from '../../src/core/commands';
import type { MindDocument, MindNode } from '../../src/core/markdown';
import type { MoveCommand } from '../../src/core/commands';
import type { LayoutMode } from '../../src/layout/layout';
import { DocumentStore } from '../../src/obsidian/document-store';
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

const PATH = 'Fixtures/main-topic.md';
const ROOT_TITLE = 'main-topic';
const LIST = ['---', 'mappy: true', '---', '## 旅の計画', '', '- 温泉旅行', '  - 予約', '- 持ち物', ''].join('\n');
const HEADINGS = ['# 旅の計画', '', '## 温泉旅行', '', '本文', '', '### 予約', '', '## 持ち物', ''].join('\n');
const TOPIC = `${LIST}\n## 別の話\n\n- 項目\n  - 細目\n`;
const EMPTY = ['---', 'mappy: true', '---', ''].join('\n');
const NO_HEADING = ['---', 'mappy: true', '---', '- 温泉旅行', '  - 予約', ''].join('\n');
const LAYOUTS: readonly LayoutMode[] = ['mindmap', 'timeline', 'hierarchy', 'balanced'];
const LANGUAGES = ['ja', 'en'] as const;

type Depth = 'main' | 'sub';

async function mount(source: string, layout: LayoutMode): Promise<MountedMapView> {
  const app = new HarnessApp();
  app.put(PATH, source);
  const store = new DocumentStore(app.asApp<App>());
  return mountMapView(PATH, source, layout, app, { store });
}

function documentOf(mounted: MountedMapView): MindDocument {
  const document = mounted.view.snapshot()?.document;
  if (!document) throw new Error('The view has no document');
  return document;
}

function nameOf(depth: Depth): string {
  return depth === 'main' ? t().mainTopicTitle : t().newNodeTitle;
}

/** The node written under `name`, and the title of its parent in the note as it now stands. */
function parentOf(mounted: MountedMapView, name: string): string | undefined {
  const document = documentOf(mounted);
  const added = document.nodes.filter(node => node.title === name);
  expect(added).toHaveLength(1);
  const parentId = added[0]?.parentId;
  if (parentId === 'root') return document.root.title;
  return document.nodes.find((node: MindNode) => node.id === parentId)?.title;
}

/** The draft the addition opened under its provisional name, all of it selected (LEV-203). */
function draftName(mounted: MountedMapView): string {
  const input = mounted.editor();
  if (!input) throw new Error('No inline editor opened on the new node');
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
  return input.value;
}

/** Choose an item of the node's context menu, as the right click does. */
function menu(mounted: MountedMapView, title: string, item: string): void {
  mounted.select(title).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
  const entry = Array.from(document.querySelectorAll<HTMLElement>('.menu .menu-item'))
    .find(candidate => candidate.querySelector('.menu-item-title')?.textContent === item);
  if (!entry) throw new Error(`no ${item} in the menu`);
  entry.click();
}

interface Row {
  id: string;
  source: string;
  /** What the user does to add the node. */
  act: (mounted: MountedMapView) => Promise<void> | void;
  depth: Depth;
  /** The title of the node the new one hangs under. */
  parent: string;
}

function key(target: string, value: 'Tab' | 'Enter'): Row['act'] {
  return mounted => { mounted.key(mounted.select(target), value); };
}

/** Drag `dragged` onto `target` (`position` as the drop preview resolves it), then Enter on `dragged`. */
function afterDrag(dragged: string, target: string, position: 'before' | 'after' | 'inside'): Row['act'] {
  return async mounted => {
    const document = documentOf(mounted);
    const id = (title: string): string => {
      const found = document.nodes.find(node => node.title === title);
      if (!found) throw new Error(`Missing ${title}`);
      return found.id;
    };
    const command = resolveDrop(document, id(dragged), id(target), position);
    if (!command) throw new Error('The drop resolved to nothing');
    // What NodeDrag's `command` action runs on the pointer's release.
    await (mounted.view as unknown as { executeDrop: (command: MoveCommand) => Promise<void> }).executeDrop(command);
    await mounted.settle();
    mounted.key(mounted.select(dragged), 'Enter');
  };
}

const ROWS: readonly Row[] = [
  // リスト形式: `## 旅の計画` が本文のルート、その直下のリスト項目が第一階層。
  { id: 'リスト: ルートで Tab', source: LIST, act: key('旅の計画', 'Tab'), depth: 'main', parent: '旅の計画' },
  { id: 'リスト: 第一階層で Enter', source: LIST, act: key('温泉旅行', 'Enter'), depth: 'main', parent: '旅の計画' },
  { id: 'リスト: 第一階層で Tab', source: LIST, act: key('持ち物', 'Tab'), depth: 'sub', parent: '持ち物' },
  { id: 'リスト: 深い階層で Enter', source: LIST, act: key('予約', 'Enter'), depth: 'sub', parent: '温泉旅行' },
  { id: 'リスト: 深い階層で Tab', source: LIST, act: key('予約', 'Tab'), depth: 'sub', parent: '予約' },
  { id: 'リスト: メニューの「子を追加」をルートで', source: LIST, act: m => { menu(m, '旅の計画', t().addChild); }, depth: 'main', parent: '旅の計画' },
  { id: 'リスト: メニューの「兄弟を追加」を第一階層で', source: LIST, act: m => { menu(m, '温泉旅行', t().addSibling); }, depth: 'main', parent: '旅の計画' },
  { id: 'リスト: メニューの「子を追加」を第一階層で', source: LIST, act: m => { menu(m, '持ち物', t().addChild); }, depth: 'sub', parent: '持ち物' },
  { id: 'リスト: 深い項目をルートの直下へドラッグしてから Enter', source: LIST, act: afterDrag('予約', '持ち物', 'after'), depth: 'main', parent: '旅の計画' },
  { id: 'リスト: 第一階層を枝の中へドラッグしてから Enter', source: LIST, act: afterDrag('持ち物', '温泉旅行', 'inside'), depth: 'sub', parent: '温泉旅行' },
  // 見出し形式: `# 旅の計画` が本文のルート、H2 区画が第一階層（新しい区画もメイントピック）。
  { id: '見出し: ルートで Tab（新しい H2 区画）', source: HEADINGS, act: key('旅の計画', 'Tab'), depth: 'main', parent: '旅の計画' },
  { id: '見出し: H2 区画で Enter（新しい H2 区画）', source: HEADINGS, act: key('温泉旅行', 'Enter'), depth: 'main', parent: '旅の計画' },
  { id: '見出し: H2 区画で Tab', source: HEADINGS, act: key('温泉旅行', 'Tab'), depth: 'sub', parent: '温泉旅行' },
  { id: '見出し: H3 で Enter', source: HEADINGS, act: key('予約', 'Enter'), depth: 'sub', parent: '温泉旅行' },
  { id: '見出し: H3 で Tab', source: HEADINGS, act: key('予約', 'Tab'), depth: 'sub', parent: '予約' },
  // フリートピックの本体: トピックのルートの直下もメイントピック。
  { id: 'トピック: トピックのルートで Tab', source: TOPIC, act: key('別の話', 'Tab'), depth: 'main', parent: '別の話' },
  { id: 'トピック: 第一階層で Enter', source: TOPIC, act: key('項目', 'Enter'), depth: 'main', parent: '別の話' },
  { id: 'トピック: 第一階層で Tab', source: TOPIC, act: key('項目', 'Tab'), depth: 'sub', parent: '項目' },
  { id: 'トピック: 深い階層で Enter', source: TOPIC, act: key('細目', 'Enter'), depth: 'sub', parent: '項目' },
  // 見出しの無いノート: ファイル名の仮のルートの直下がメイントピック。
  { id: '見出し無し: 第一階層で Enter', source: NO_HEADING, act: key('温泉旅行', 'Enter'), depth: 'main', parent: ROOT_TITLE },
  { id: '見出し無し: 第一階層で Tab', source: NO_HEADING, act: key('温泉旅行', 'Tab'), depth: 'sub', parent: '温泉旅行' },
];

describe('the provisional name follows the depth the node is added at (LEV-250)', () => {
  for (const language of LANGUAGES) {
    for (const layout of LAYOUTS) {
      for (const row of ROWS) {
        it(`${language} / ${layout}: ${row.id} → ${row.depth === 'main' ? 'Main topic' : 'Subtopic'}`, async () => {
          setLanguage(language);
          const mounted = await mount(row.source, layout);
          await row.act(mounted);
          await mounted.settle();
          const name = nameOf(row.depth);
          expect(draftName(mounted)).toBe(name);
          expect(parentOf(mounted, name)).toBe(row.parent);
          // Enter on the untouched draft keeps the provisional name as written.
          mounted.key(mounted.editor() ?? mounted.canvas, 'Enter');
          await mounted.settle();
          expect(mounted.editor()).toBeNull();
          expect(parentOf(mounted, name)).toBe(row.parent);
        });
      }
    }
  }

  // The names themselves, spelled out: every row above reads them from the table, so a mix-up of the keys would pass there.
  it('spells the names in both languages', () => {
    setLanguage('ja');
    expect([t().mainTopicTitle, t().newNodeTitle, t().newTopicTitle]).toEqual(['メイントピック', 'サブトピック', 'トピック']);
    setLanguage('en');
    expect([t().mainTopicTitle, t().newNodeTitle, t().newTopicTitle]).toEqual(['Main topic', 'Subtopic', 'Topic']);
  });

  // Review 2: a node that becomes the map's own root (the first heading written into a note with nothing else) is
  // neither under a root nor further down; it is named as the empty canvas names the node it makes (addTopic).
  for (const layout of LAYOUTS) {
    it(`${layout}: Tab on the file-name root of an empty note makes the body root, named「トピック」`, async () => {
      const mounted = await mount(EMPTY, layout);
      mounted.key(mounted.select(ROOT_TITLE), 'Tab');
      await mounted.settle();
      expect(draftName(mounted)).toBe(t().newTopicTitle);
      mounted.key(mounted.editor() ?? mounted.canvas, 'Enter');
      await mounted.settle();
      expect(mounted.source()).toBe(`${EMPTY}\n## ${t().newTopicTitle}\n`);
    });
  }
});
