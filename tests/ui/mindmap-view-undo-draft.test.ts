// @vitest-environment jsdom
/**
 * LEV-331（本人の報告 2026-10-09）: ノードを作った直後、入力欄が開いたままの ⌘Z が何もしなかった。キャンバスの空いた所を
 * クリックして入力欄を閉じてからなら戻った。⌘Z を受けるのはキャンバスの keydown で、入力欄の中のキーは素通しして
 * いた（textarea の Undo に任せる）が、仮の名前は入力欄の外から入れた値なので textarea の Undo には何も無く、実機では
 * キーが macOS のメニューまで抜けていた。
 *
 * 行列は本人の操作（⌘Z・⌘⇧Z）× 入力欄の形（Tab の「サブトピック」・Enter の「メイントピック」・ルートの Tab・見出しの
 * ノート・空白のダブルクリックの「トピック」・F2 で開いた既存ノード・打った文字がある・変換中）。⌘Z をマップに渡すのは追加したばかりの
 * ノードの入力欄だけ（レビュー 1 回目: F2 の入力欄の ⌘Z が見えない所の編集を戻しうる）。保存中・保持・ウィンドウを離れたときの
 * 保存は `inline-editor.test.ts`。
 * 実機は E85（`npm run harness:e2e:undo-draft`）。
 */
import type { App } from 'obsidian';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HarnessApp } from '../browser-harness/app';
import { installObsidianDom } from '../browser-harness/dom';
import type { LayoutMode } from '../../src/layout/layout';
import { DocumentStore } from '../../src/obsidian/document-store';
import { t } from '../../src/i18n';
import { accessibleName } from './accessible-name';
import { mountMapView, type MountedMapView } from './map-view-mount';
import { closeOpenViews } from '../mocks/open-views';

vi.mock('obsidian', () => import('../browser-harness/obsidian'));
beforeAll(() => { installObsidianDom(); });

afterEach(async () => {
  await closeOpenViews();
  document.body.replaceChildren();
});

const PATH = 'Fixtures/undo-draft.md';
const LIST = ['---', 'mappy: true', '---', '## 旅の計画', '', '- 温泉旅行', '  - 予約', '- 持ち物', ''].join('\n');
const HEADINGS = ['# 旅の計画', '', '## 温泉旅行', '', '本文', '', '## 持ち物', ''].join('\n');
const LAYOUTS: readonly LayoutMode[] = ['mindmap', 'timeline', 'hierarchy', 'balanced'];

interface Mounted extends MountedMapView { store: DocumentStore }

async function mount(source: string, layout: LayoutMode = 'mindmap'): Promise<Mounted> {
  const app = new HarnessApp();
  app.put(PATH, source);
  const store = new DocumentStore(app.asApp<App>());
  const mounted = await mountMapView(PATH, source, layout, app, { store });
  return { ...mounted, store };
}

function nodeElements(mounted: MountedMapView, title: string): HTMLElement[] {
  return Array.from(mounted.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node')).filter(element => accessibleName(element) === title);
}

function selectedNames(mounted: MountedMapView): string[] {
  return Array.from(mounted.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node.is-selected'), element => accessibleName(element));
}

function draft(mounted: MountedMapView, value: string): HTMLTextAreaElement {
  const input = mounted.editor();
  if (!input) throw new Error('No inline editor is open');
  expect(input.value).toBe(value);
  expect(input.ownerDocument.activeElement).toBe(input);
  return input;
}

function type(input: HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const SHAPES = [
  { id: 'Tab のサブトピック', source: LIST, target: '持ち物', key: 'Tab', name: t().newNodeTitle, written: LIST.replace('- 持ち物\n', `- 持ち物\n  - ${t().newNodeTitle}\n`) },
  { id: 'Enter のメイントピック', source: LIST, target: '温泉旅行', key: 'Enter', name: t().mainTopicTitle, written: LIST.replace('  - 予約\n', `  - 予約\n- ${t().mainTopicTitle}\n`) },
  { id: 'Enter のサブトピック', source: LIST, target: '予約', key: 'Enter', name: t().newNodeTitle, written: LIST.replace('  - 予約\n', `  - 予約\n  - ${t().newNodeTitle}\n`) },
  { id: 'ルートの Tab のメイントピック', source: LIST, target: '旅の計画', key: 'Tab', name: t().mainTopicTitle, written: LIST.replace('- 持ち物\n', `- 持ち物\n- ${t().mainTopicTitle}\n`) },
  { id: '見出しの Tab', source: HEADINGS, target: '温泉旅行', key: 'Tab', name: t().newNodeTitle, written: HEADINGS.replace('本文\n', `本文\n\n### ${t().newNodeTitle}\n`) },
  { id: '見出しの Enter', source: HEADINGS, target: '温泉旅行', key: 'Enter', name: t().mainTopicTitle, written: HEADINGS.replace('本文\n', `本文\n\n## ${t().mainTopicTitle}\n`) },
] as const;

describe('⌘Z in the draft a new node opened takes the node back as a step of the history (LEV-331)', () => {
  for (const layout of LAYOUTS) {
    for (const shape of SHAPES) {
      it(`${layout}: ${shape.id} — ⌘Z right away, then ⌘⇧Z brings it back`, async () => {
        const mounted = await mount(shape.source, layout);
        mounted.key(mounted.select(shape.target), shape.key);
        await mounted.settle();
        expect(mounted.source()).toBe(shape.written);
        const undo = mounted.key(draft(mounted, shape.name), 'z', { metaKey: true });
        expect(undo.defaultPrevented).toBe(true);
        await mounted.settle();
        expect(mounted.editor()).toBeNull();
        expect(mounted.source()).toBe(shape.source);
        expect(nodeElements(mounted, shape.name)).toHaveLength(0);
        // An undo, not Escape's take-back: the step is there to redo, and the keyboard is on the map for it.
        expect(mounted.store.canRedo(mounted.file)).toBe(true);
        const focused = mounted.canvas.ownerDocument.activeElement;
        expect(focused instanceof Node && mounted.canvas.contains(focused)).toBe(true);
        mounted.key(focused ?? mounted.canvas, 'z', { metaKey: true, shiftKey: true });
        await mounted.settle();
        expect(mounted.source()).toBe(shape.written);
      });
    }
  }

  it('Ctrl+Z (Windows, Linux) does the same', async () => {
    const mounted = await mount(LIST);
    mounted.key(mounted.select('持ち物'), 'Tab');
    await mounted.settle();
    expect(mounted.key(draft(mounted, t().newNodeTitle), 'z', { ctrlKey: true }).defaultPrevented).toBe(true);
    await mounted.settle();
    expect(mounted.source()).toBe(LIST);
  });

  it('a free topic from a double click on the empty canvas goes too, its pressed point with it', async () => {
    const mounted = await mount(LIST);
    mounted.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await mounted.settle();
    expect(mounted.source()).toBe(`${LIST}\n## ${t().newTopicTitle}\n`);
    mounted.key(draft(mounted, t().newTopicTitle), 'z', { metaKey: true });
    await mounted.settle();
    expect(mounted.editor()).toBeNull();
    expect(mounted.source()).toBe(LIST);
    expect(mounted.store.canRedo(mounted.file)).toBe(true);
  });

  it('a second ⌘Z goes on through the history: the node before the last one goes too', async () => {
    const mounted = await mount(LIST);
    mounted.key(mounted.select('持ち物'), 'Tab');
    await mounted.settle();
    mounted.key(draft(mounted, t().newNodeTitle), 'Enter');
    await mounted.settle();
    const first = mounted.source();
    mounted.key(mounted.select(t().newNodeTitle), 'Enter');
    await mounted.settle();
    mounted.key(draft(mounted, t().newNodeTitle), 'z', { metaKey: true });
    await mounted.settle();
    expect(mounted.source()).toBe(first);
    const focused = mounted.canvas.ownerDocument.activeElement ?? mounted.canvas;
    mounted.key(focused, 'z', { metaKey: true });
    await mounted.settle();
    expect(mounted.source()).toBe(LIST);
  });

  it('puts back the fold the addition opened, the selection and the viewport, as Escape does (review 1)', async () => {
    const mounted = await mount(LIST);
    mounted.key(mounted.select('温泉旅行'), ' ');
    await mounted.settle();
    expect(mounted.node('温泉旅行').classList.contains('is-collapsed')).toBe(true);
    const selected = mounted.select('温泉旅行');
    const viewport = mounted.view.getState().viewport;
    mounted.key(selected, 'Tab');
    await mounted.settle();
    expect(mounted.node('温泉旅行').classList.contains('is-collapsed')).toBe(false);
    (mounted.view as unknown as { viewport: { set(value: object): void } }).viewport.set({ x: 11, y: 22, scale: 1 });
    mounted.key(draft(mounted, t().newNodeTitle), 'z', { metaKey: true });
    await mounted.settle();
    expect(mounted.source()).toBe(LIST);
    expect(mounted.node('温泉旅行').classList.contains('is-collapsed')).toBe(true);
    expect(selectedNames(mounted)).toEqual(['温泉旅行']);
    expect(mounted.canvas.ownerDocument.activeElement).toBe(mounted.node('温泉旅行'));
    expect(mounted.view.getState().viewport).toEqual(viewport);
  });
});

describe('⌘Z stays the textarea\'s where the draft is not a node just added, or has text of its own (LEV-331)', () => {
  it('a draft opened with F2 and left as it was: the draft and the note are left as they are (review 1)', async () => {
    const mounted = await mount(LIST);
    mounted.key(mounted.select('持ち物'), 'Tab');
    await mounted.settle();
    mounted.key(draft(mounted, t().newNodeTitle), 'Enter');
    await mounted.settle();
    const written = mounted.source();
    mounted.key(mounted.select('温泉旅行'), 'F2');
    const input = draft(mounted, '温泉旅行');
    expect(mounted.key(input, 'z', { metaKey: true }).defaultPrevented).toBe(false);
    await mounted.settle();
    expect(mounted.editor()).toBe(input);
    expect(mounted.source()).toBe(written);
  });

  it('⌘⇧Z in a new node\'s draft is the textarea\'s', async () => {
    const mounted = await mount(LIST);
    mounted.key(mounted.select('持ち物'), 'Tab');
    await mounted.settle();
    const written = mounted.source();
    const input = draft(mounted, t().newNodeTitle);
    expect(mounted.key(input, 'z', { metaKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    await mounted.settle();
    expect(mounted.editor()).toBe(input);
    expect(mounted.source()).toBe(written);
  });
});

describe('text typed in the draft is the textarea\'s to take back first (LEV-331)', () => {
  it('⌘Z with typed text stays in the textarea: the draft and the note are left as they are', async () => {
    const mounted = await mount(LIST);
    mounted.key(mounted.select('持ち物'), 'Tab');
    await mounted.settle();
    const written = mounted.source();
    const input = draft(mounted, t().newNodeTitle);
    type(input, '水着');
    expect(mounted.key(input, 'z', { metaKey: true }).defaultPrevented).toBe(false);
    await mounted.settle();
    expect(mounted.editor()).toBe(input);
    expect(mounted.source()).toBe(written);
  });

  it('once the textarea\'s own Undo has brought the provisional name back, the next ⌘Z takes the node back', async () => {
    const mounted = await mount(LIST);
    mounted.key(mounted.select('持ち物'), 'Tab');
    await mounted.settle();
    const input = draft(mounted, t().newNodeTitle);
    type(input, '水着');
    // What the textarea's Undo leaves (jsdom has no editing history of its own).
    type(input, t().newNodeTitle);
    expect(mounted.key(input, 'z', { metaKey: true }).defaultPrevented).toBe(true);
    await mounted.settle();
    expect(mounted.source()).toBe(LIST);
  });

  it('⌘Z while the IME composes is the IME\'s', async () => {
    const mounted = await mount(LIST);
    mounted.key(mounted.select('持ち物'), 'Tab');
    await mounted.settle();
    const written = mounted.source();
    const input = draft(mounted, t().newNodeTitle);
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(mounted.key(input, 'z', { metaKey: true, isComposing: true }).defaultPrevented).toBe(false);
    await mounted.settle();
    expect(mounted.editor()).toBe(input);
    expect(mounted.source()).toBe(written);
  });
});
