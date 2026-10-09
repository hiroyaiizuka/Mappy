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
 *
 * LEV-332: 空白のダブルクリックのトピックは、⌘Z → ⌘⇧Z で押した位置ではなく位置の無いトピックの場所に戻った。押した位置を
 * 名前の確定で書いていたため。作成の書き込みで位置も書くようにしたので、その行を 4 レイアウト × ノートの形（リスト・
 * frontmatter の無い見出しのノート・同じ名前のトピックがすでにある）で回し、戻ったトピックの描画位置が ⌘Z の前と同じで、
 * ノートに位置があることを見る。修正を戻すと 12 行とも描画位置で落ちる（`artifacts/lev-332/`）。
 */
import type { App } from 'obsidian';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HarnessApp } from '../browser-harness/app';
import { installObsidianDom } from '../browser-harness/dom';
import { projectMap, type MindDocument } from '../../src/core/markdown';
import { readTopicPositions } from '../../src/core/topics';
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

/**
 * The notes a topic is added to: front matter or none, a list or headings, and a topic of the same name already there (the
 * new one's key in `mappy-topics` is then `トピック (2)`).
 */
const TOPIC_SHAPES = [
  { id: 'list', source: LIST, key: t().newTopicTitle },
  { id: 'headings, no front matter', source: HEADINGS, key: t().newTopicTitle },
  { id: 'a topic of that name already', source: `${LIST}\n## ${t().newTopicTitle}\n\n- 下見\n`, key: `${t().newTopicTitle} (2)` },
] as const;

/** A double click on the empty canvas; its first click clears the selection, so nothing is selected when the topic is added. */
function doubleClickCanvas(mounted: MountedMapView): void {
  for (const type of ['pointerdown', 'pointerup'] as const) {
    mounted.canvas.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  }
  mounted.canvas.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  expect(selectedNames(mounted)).toEqual([]);
  mounted.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
}

/** The note's last topic, the one a double click adds. */
function lastTopic(mounted: MountedMapView): string {
  const document = (mounted.view as unknown as { document: MindDocument | undefined }).document;
  const topic = document ? projectMap(document).topics.at(-1) : undefined;
  if (!topic) throw new Error('The note has no topic');
  return topic.id;
}

/** Where a node is drawn on the map. */
function place(mounted: MountedMapView, id: string): { x: number; y: number } {
  const element = mounted.view.containerEl.querySelector<HTMLElement>(`.mappy-node[data-node-id="${id}"]`);
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/u.exec(element?.style.transform ?? '');
  if (!match) throw new Error(`No transform for ${id}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

describe('⌘Z in the draft a new node opened takes the node back as Escape does, as a step ⌘⇧Z brings back (LEV-331)', () => {
  for (const layout of LAYOUTS) {
    for (const shape of SHAPES) {
      it(`${layout}: ${shape.id} — ⌘Z right away, then ⌘⇧Z`, async () => {
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
        // Escape's take-back (review 2), the node the addition was made from with the keyboard, but as an Undo: the
        // addition is the step left for Redo (the person's answer, 2026-10-09).
        expect(mounted.store.canUndo(mounted.file)).toBe(false);
        expect(mounted.store.canRedo(mounted.file)).toBe(true);
        expect(selectedNames(mounted)).toEqual([shape.target]);
        expect(mounted.canvas.ownerDocument.activeElement).toBe(mounted.node(shape.target));
        mounted.key(mounted.node(shape.target), 'z', { metaKey: true, shiftKey: true });
        await mounted.settle();
        expect(mounted.source()).toBe(shape.written);
        expect(nodeElements(mounted, shape.name)).toHaveLength(1);
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

  // LEV-332: the section came back without the pressed point, where a topic with no position goes. The point was written
  // with the name, which the draft never confirmed; the addition writes it now, so the step ⌘⇧Z brings back holds it.
  for (const layout of LAYOUTS) {
    for (const topicShape of TOPIC_SHAPES) {
      it(`${layout}: a free topic from a double click on the empty canvas (${topicShape.id}) goes too, the keyboard left on the map, and ⌘⇧Z brings it back where it was pressed`, async () => {
        const mounted = await mount(topicShape.source, layout);
        doubleClickCanvas(mounted);
        await mounted.settle();
        const written = mounted.source();
        expect(written.endsWith(`# ${t().newTopicTitle}\n`)).toBe(true);
        const pressed = place(mounted, lastTopic(mounted));
        mounted.key(draft(mounted, t().newTopicTitle), 'z', { metaKey: true });
        await mounted.settle();
        expect(mounted.editor()).toBeNull();
        expect(mounted.source()).toBe(topicShape.source);
        // Found on the real Obsidian (E85): the removed draft left the keyboard on the page, and the next ⌘Z reached nothing.
        expect(mounted.canvas.ownerDocument.activeElement).toBe(mounted.canvas);
        mounted.key(mounted.canvas, 'z', { metaKey: true, shiftKey: true });
        await mounted.settle();
        expect(mounted.source()).toBe(written);
        expect(place(mounted, lastTopic(mounted))).toEqual(pressed);
        // Where it was pressed is in the note, so it holds where the view's own memory of it does not reach (a reload).
        expect(readTopicPositions(mounted.source()).get(topicShape.key)?.[layout]).toBeDefined();
      });
    }
  }

  // A guard, passing with or without LEV-332's fix: what it pins is that the point is written only for a topic, so a fix that
  // wrote it for any addition would fail here.
  it('the first heading of an empty map is its body root, not a topic: ⌘⇧Z brings it back with no position', async () => {
    const source = ['---', 'mappy: true', '---', ''].join('\n');
    const mounted = await mount(source);
    doubleClickCanvas(mounted);
    await mounted.settle();
    const written = mounted.source();
    expect(readTopicPositions(written).size).toBe(0);
    mounted.key(draft(mounted, t().newTopicTitle), 'z', { metaKey: true });
    await mounted.settle();
    expect(mounted.source()).toBe(source);
    mounted.key(mounted.canvas, 'z', { metaKey: true, shiftKey: true });
    await mounted.settle();
    expect(mounted.source()).toBe(written);
  });

  // Review 3: what Escape would not take back (something was written since the addition), ⌘Z does not either: only the
  // draft closes, and no step of the history goes — it could be another map's edit of the note.
  it('after another write since the addition, only closes the draft: the node and that write stay', async () => {
    const mounted = await mount(LIST);
    mounted.key(mounted.select('持ち物'), 'Tab');
    await mounted.settle();
    const added = mounted.source();
    const at = added.indexOf('温泉旅行');
    await mounted.store.apply(mounted.file, added, [{ from: at, to: at + '温泉旅行'.length, text: '湯治' }]);
    await mounted.settle();
    const other = added.replace('温泉旅行', '湯治');
    expect(mounted.source()).toBe(other);
    expect(mounted.key(draft(mounted, t().newNodeTitle), 'z', { metaKey: true }).defaultPrevented).toBe(true);
    await mounted.settle();
    expect(mounted.editor()).toBeNull();
    expect(mounted.source()).toBe(other);
    expect(nodeElements(mounted, t().newNodeTitle)).toHaveLength(1);
  });

  // Review 3: the keyboard is the map's as soon as the draft closes, not once the take-back is written.
  it('has the keyboard on the map at once: a second ⌘Z pressed before the take-back is written still reaches the map', async () => {
    const mounted = await mount(LIST);
    mounted.key(mounted.select('持ち物'), 'Tab');
    await mounted.settle();
    mounted.key(draft(mounted, t().newNodeTitle), 'Enter');
    await mounted.settle();
    mounted.key(mounted.select(t().newNodeTitle), 'Enter');
    await mounted.settle();
    mounted.key(draft(mounted, t().newNodeTitle), 'z', { metaKey: true });
    const focused = mounted.canvas.ownerDocument.activeElement;
    expect(focused instanceof Node && mounted.canvas.contains(focused)).toBe(true);
    mounted.key(focused ?? mounted.canvas, 'z', { metaKey: true });
    await mounted.settle();
    expect(mounted.source()).toBe(LIST);
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

  it('puts back the selection and the viewport as Escape does, and keeps the fold open so ⌘⇧Z shows the node (review 4)', async () => {
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
    expect(mounted.node('温泉旅行').classList.contains('is-collapsed')).toBe(false);
    expect(selectedNames(mounted)).toEqual(['温泉旅行']);
    expect(mounted.canvas.ownerDocument.activeElement).toBe(mounted.node('温泉旅行'));
    expect(mounted.view.getState().viewport).toEqual(viewport);
    mounted.key(mounted.node('温泉旅行'), 'z', { metaKey: true, shiftKey: true });
    await mounted.settle();
    expect(nodeElements(mounted, t().newNodeTitle)).toHaveLength(1);
  });

  it('leaves the view to a second ⌘Z pressed while the take-back is written (review 4)', async () => {
    const mounted = await mount(LIST);
    mounted.key(mounted.select('持ち物'), 'F2');
    type(draft(mounted, '持ち物'), '荷物');
    mounted.key(mounted.editor() ?? mounted.canvas, 'Enter');
    await mounted.settle();
    mounted.key(mounted.select('温泉旅行'), 'Tab');
    await mounted.settle();
    mounted.key(draft(mounted, t().newNodeTitle), 'z', { metaKey: true });
    // The second ⌘Z, before the take-back has settled: it undoes the rename, whose node it selects.
    mounted.key(mounted.canvas.ownerDocument.activeElement ?? mounted.canvas, 'z', { metaKey: true });
    await mounted.settle();
    expect(mounted.source()).toBe(LIST);
    expect(selectedNames(mounted)).not.toEqual(['温泉旅行']);
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
