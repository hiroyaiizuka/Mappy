// @vitest-environment jsdom
/**
 * LEV-203（本人の決定 2026-09-26）: 子・兄弟（Tab／Enter）で作るノードは「サブトピック」、空白のダブルクリック・
 * 右クリックで作るフリートピックは「トピック」という仮の名前で書かれ、その名前が全選択された入力欄が開く（そのまま
 * 打てば上書き）。作ってすぐの Escape は作成の取り消し（Markdown に何も残らず、Undo／Redo にも手順が残らない）。
 * 打たずに Enter・フォーカスを外した場合は仮の名前のまま確定する。既存ノードの編集中の Escape はこれまでどおり
 * 編集の取り消しだけ。
 *
 * 行列は本人の操作（Tab・Enter・メニュー・ダブルクリック × Enter・Escape・blur・上書き）× 対象の形（リストの項目・
 * 見出しのノートの見出し・本文のルート・フリートピック）× 4 レイアウト。IME の変換開始で選択が置き換わること、入力欄と
 * 確定後のノードの寸法はブラウザ検証ページ（`new-node-*`）と実機（E43）で見る。jsdom は選択の置換も寸法も持たない。
 */
import type { App } from 'obsidian';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HarnessApp } from '../../harness/browser/app';
import { installObsidianDom } from '../../harness/browser/dom';
import type { MindDocument } from '../../src/core/markdown';
import type { LayoutMode } from '../../src/layout/layout';
import { DocumentStore, conflictMessage } from '../../src/obsidian/document-store';
import { NEW_NODE_TITLE, NEW_TOPIC_TITLE } from '../../src/ui/mindmap-view';
import { accessibleName } from './accessible-name';
import { mountMapView, type MountedMapView } from './map-view-mount';

vi.mock('obsidian', () => import('../../harness/browser/obsidian'));
beforeAll(() => { installObsidianDom(); });

const opened: MountedMapView[] = [];
afterEach(async () => {
  for (const mounted of opened.splice(0)) await mounted.close();
  document.body.replaceChildren();
});

const PATH = 'Fixtures/new-node.md';
const LIST = ['---', 'mappy: true', '---', '## 旅の計画', '', '- 温泉旅行', '  - 予約', '- 持ち物', ''].join('\n');
const HEADINGS = ['# 旅の計画', '', '## 温泉旅行', '', '本文', '', '## 持ち物', ''].join('\n');
const LAYOUTS: readonly LayoutMode[] = ['mindmap', 'timeline', 'hierarchy', 'balanced'];

interface Mounted extends MountedMapView { store: DocumentStore }

async function mount(source: string, layout: LayoutMode = 'mindmap'): Promise<Mounted> {
  const app = new HarnessApp();
  app.put(PATH, source);
  const store = new DocumentStore(app.asApp<App>());
  const mounted = await mountMapView(PATH, source, layout, app, { store });
  opened.push(mounted);
  return { ...mounted, store };
}

function documentOf(mounted: MountedMapView): MindDocument {
  const document = mounted.view.snapshot()?.document;
  if (!document) throw new Error('The view has no document');
  return document;
}

function nodeElements(mounted: MountedMapView, title: string): HTMLElement[] {
  return Array.from(mounted.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node')).filter(element => accessibleName(element) === title);
}

function selectedNames(mounted: MountedMapView): string[] {
  return Array.from(mounted.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node.is-selected'), element => accessibleName(element));
}

/** The draft the addition opened: its provisional name, all of it selected so that typing replaces it. */
function provisionalDraft(mounted: MountedMapView, name: string): HTMLTextAreaElement {
  const input = mounted.editor();
  if (!input) throw new Error('No inline editor opened on the new node');
  expect(input.value).toBe(name);
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, name.length]);
  expect(input.ownerDocument.activeElement).toBe(input);
  return input;
}

/** How each shape adds a node, and where the provisional name lands in the note. */
const SHAPES = [
  { id: 'リストの子（Tab）', source: LIST, target: '持ち物', key: 'Tab', written: LIST.replace('- 持ち物\n', `- 持ち物\n  - ${NEW_NODE_TITLE}\n`) },
  { id: 'リストの兄弟（Enter）', source: LIST, target: '温泉旅行', key: 'Enter', written: LIST.replace('  - 予約\n', `  - 予約\n- ${NEW_NODE_TITLE}\n`) },
  { id: '本文のルートの子（Tab）', source: LIST, target: '旅の計画', key: 'Tab', written: LIST.replace('- 持ち物\n', `- 持ち物\n- ${NEW_NODE_TITLE}\n`) },
  { id: '見出しの子（Tab）', source: HEADINGS, target: '温泉旅行', key: 'Tab', written: HEADINGS.replace('本文\n', `本文\n\n### ${NEW_NODE_TITLE}\n`) },
  { id: '見出しの兄弟（Enter）', source: HEADINGS, target: '温泉旅行', key: 'Enter', written: HEADINGS.replace('本文\n', `本文\n\n## ${NEW_NODE_TITLE}\n`) },
] as const;

describe('a node added on the map opens under its provisional name, selected (LEV-203)', () => {
  for (const layout of LAYOUTS) {
    for (const shape of SHAPES) {
      it(`${layout}: ${shape.id} — written as 「${NEW_NODE_TITLE}」, typed over, Enter`, async () => {
        const mounted = await mount(shape.source, layout);
        mounted.key(mounted.select(shape.target), shape.key);
        await mounted.settle();
        expect(mounted.source()).toBe(shape.written);
        const input = provisionalDraft(mounted, NEW_NODE_TITLE);
        // What typing over the selection leaves (jsdom does not replace a selection on its own).
        input.value = '新しい項目';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        mounted.key(input, 'Enter');
        await mounted.settle();
        expect(mounted.editor()).toBeNull();
        expect(mounted.source()).toBe(shape.written.replace(NEW_NODE_TITLE, '新しい項目'));
        expect(selectedNames(mounted)).toEqual(['新しい項目']);
      });

      it(`${layout}: ${shape.id} — Escape right away takes the node back, with nothing left for Undo or Redo`, async () => {
        const mounted = await mount(shape.source, layout);
        mounted.key(mounted.select(shape.target), shape.key);
        await mounted.settle();
        const input = provisionalDraft(mounted, NEW_NODE_TITLE);
        mounted.key(input, 'Escape');
        await mounted.settle();
        expect(mounted.editor()).toBeNull();
        expect(mounted.source()).toBe(shape.source);
        expect(nodeElements(mounted, NEW_NODE_TITLE)).toHaveLength(0);
        expect(mounted.store.canUndo(mounted.file)).toBe(false);
        expect(mounted.store.canRedo(mounted.file)).toBe(false);
        // ⌘⇧Z brings nothing back either: the addition was taken back, not undone.
        mounted.key(mounted.canvas, 'z', { metaKey: true, shiftKey: true });
        await mounted.settle();
        expect(mounted.source()).toBe(shape.source);
        // The node the addition was made from is selected again, so the next Tab／Enter goes where it went.
        expect(selectedNames(mounted)).toEqual([shape.target]);
      });
    }

    it(`${layout}: Enter on the untouched draft, or leaving it, keeps 「${NEW_NODE_TITLE}」 as written, one step for Undo`, async () => {
      const mounted = await mount(LIST, layout);
      mounted.key(mounted.select('持ち物'), 'Tab');
      await mounted.settle();
      mounted.key(provisionalDraft(mounted, NEW_NODE_TITLE), 'Enter');
      await mounted.settle();
      const once = LIST.replace('- 持ち物\n', `- 持ち物\n  - ${NEW_NODE_TITLE}\n`);
      expect(mounted.editor()).toBeNull();
      expect(mounted.source()).toBe(once);
      // Left by blur (a click elsewhere): the same.
      mounted.key(mounted.select('温泉旅行'), 'Tab');
      await mounted.settle();
      provisionalDraft(mounted, NEW_NODE_TITLE).blur();
      await mounted.settle();
      expect(mounted.editor()).toBeNull();
      expect(mounted.source()).toBe(once.replace('  - 予約\n', `  - 予約\n  - ${NEW_NODE_TITLE}\n`));
      mounted.key(mounted.canvas, 'z', { metaKey: true });
      await mounted.settle();
      expect(mounted.source()).toBe(once);
      mounted.key(mounted.canvas, 'z', { metaKey: true });
      await mounted.settle();
      expect(mounted.source()).toBe(LIST);
    });

    it(`${layout}: a free topic is written as 「${NEW_TOPIC_TITLE}」 and Escape takes it back`, async () => {
      const mounted = await mount(LIST, layout);
      mounted.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
      await mounted.settle();
      expect(mounted.source()).toBe(`${LIST}\n## ${NEW_TOPIC_TITLE}\n`);
      mounted.key(provisionalDraft(mounted, NEW_TOPIC_TITLE), 'Escape');
      await mounted.settle();
      expect(mounted.source()).toBe(LIST);
      expect(mounted.store.canUndo(mounted.file)).toBe(false);
      expect(mounted.store.canRedo(mounted.file)).toBe(false);
    });
  }

  it('Escape on the draft of a node that already existed only cancels the edit (F2, a double click)', async () => {
    const mounted = await mount(LIST);
    mounted.key(mounted.select('持ち物'), 'F2');
    const input = mounted.editor();
    if (!input) throw new Error('F2 did not open the editor');
    expect(input.value).toBe('持ち物');
    input.value = '書きかけ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    mounted.key(input, 'Escape');
    await mounted.settle();
    expect(mounted.editor()).toBeNull();
    expect(mounted.source()).toBe(LIST);
    expect(selectedNames(mounted)).toEqual(['持ち物']);
    // A node confirmed under its provisional name is an existing node from then on.
    mounted.key(mounted.select('持ち物'), 'Tab');
    await mounted.settle();
    mounted.key(provisionalDraft(mounted, NEW_NODE_TITLE), 'Enter');
    await mounted.settle();
    mounted.key(mounted.select(NEW_NODE_TITLE), 'F2');
    const again = mounted.editor();
    if (!again) throw new Error('F2 did not open the editor');
    mounted.key(again, 'Escape');
    await mounted.settle();
    expect(mounted.source()).toBe(LIST.replace('- 持ち物\n', `- 持ち物\n  - ${NEW_NODE_TITLE}\n`));
  });

  it('Tab in the draft confirms the new node and adds its own child, which Escape alone takes back', async () => {
    const mounted = await mount(LIST);
    mounted.key(mounted.select('持ち物'), 'Tab');
    await mounted.settle();
    const first = provisionalDraft(mounted, NEW_NODE_TITLE);
    first.value = '着替え';
    first.dispatchEvent(new Event('input', { bubbles: true }));
    mounted.key(first, 'Tab');
    await mounted.settle();
    await mounted.settle();
    expect(mounted.source()).toBe(LIST.replace('- 持ち物\n', `- 持ち物\n  - 着替え\n    - ${NEW_NODE_TITLE}\n`));
    mounted.key(provisionalDraft(mounted, NEW_NODE_TITLE), 'Escape');
    await mounted.settle();
    expect(mounted.source()).toBe(LIST.replace('- 持ち物\n', '- 持ち物\n  - 着替え\n'));
    expect(selectedNames(mounted)).toEqual(['着替え']);
    // The steps before the taken-back one are still there: the name, then the addition.
    expect(mounted.store.canUndo(mounted.file)).toBe(true);
    expect(mounted.store.canRedo(mounted.file)).toBe(false);
  });

  it('keeps the node when anything was written after it (an image pasted onto it, a change from outside): Escape only closes the draft', async () => {
    const mounted = await mount(LIST);
    mounted.key(mounted.select('持ち物'), 'Tab');
    await mounted.settle();
    const input = provisionalDraft(mounted, NEW_NODE_TITLE);
    // An image pasted onto the node being edited is written under it at once (報告: 2026-09-22).
    const attach = (mounted.view as unknown as { attachImage(image: File): Promise<void> }).attachImage.bind(mounted.view);
    await attach(new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }));
    await mounted.settle();
    const pasted = mounted.source();
    expect(pasted).toMatch(new RegExp(`  - ${NEW_NODE_TITLE}\\n\\n    !\\[\\[\\d*-?shot\\.png\\]\\]`, "u"));
    expect(mounted.editor()).toBe(input);
    mounted.key(input, 'Escape');
    await mounted.settle();
    expect(mounted.editor()).toBeNull();
    expect(mounted.source()).toBe(pasted);
    expect(document.querySelector('.notice')).toBeNull();
    expect(selectedNames(mounted)).toEqual([NEW_NODE_TITLE]);

    // Someone else's change lands while a new node's draft is open (E05): taking the node back would take theirs too.
    mounted.key(mounted.select('温泉旅行'), 'Tab');
    await mounted.settle();
    const second = provisionalDraft(mounted, NEW_NODE_TITLE);
    const written = mounted.source();
    mounted.app.put(PATH, `${written}- 外から\n`);
    await mounted.settle();
    mounted.key(second, 'Escape');
    await mounted.settle();
    await mounted.settle();
    expect(mounted.source()).toBe(`${written}- 外から\n`);
  });

  it('taking a new node back is not a delete: the node selected before comes back, and a Delete after it follows LEV-204', async () => {
    const mounted = await mount(LIST);
    // Escape: the addition never happened, so the selection is the one before it (not LEV-204's sibling or parent).
    mounted.key(mounted.select('持ち物'), 'Tab');
    await mounted.settle();
    mounted.key(provisionalDraft(mounted, NEW_NODE_TITLE), 'Escape');
    await mounted.settle();
    expect(selectedNames(mounted)).toEqual(['持ち物']);
    // A confirmed new node deleted afterwards is a delete: its only parent's child gone, the parent is selected.
    mounted.key(mounted.select('持ち物'), 'Tab');
    await mounted.settle();
    mounted.key(provisionalDraft(mounted, NEW_NODE_TITLE), 'Enter');
    await mounted.settle();
    mounted.key(mounted.select(NEW_NODE_TITLE), 'Delete');
    await mounted.settle();
    expect(mounted.source()).toBe(LIST);
    expect(selectedNames(mounted)).toEqual(['持ち物']);
    // And Delete on 「持ち物」 goes to the sibling above (LEV-204), not to a node the retract remembered.
    mounted.key(mounted.node('持ち物'), 'Delete');
    await mounted.settle();
    expect(selectedNames(mounted)).toEqual(['温泉旅行']);
  });

  it('Escape puts back the fold the addition opened and the viewport it panned (review 3)', async () => {
    const mounted = await mount(LIST);
    mounted.key(mounted.select('温泉旅行'), ' ');
    await mounted.settle();
    expect(mounted.node('温泉旅行').classList.contains('is-collapsed')).toBe(true);
    // Selecting can itself bring the node into view: the viewport the addition starts from is the one after it.
    const selected = mounted.select('温泉旅行');
    const viewport = mounted.view.getState().viewport;
    mounted.key(selected, 'Tab');
    await mounted.settle();
    // Revealing the new child opens its parent.
    expect(mounted.node('温泉旅行').classList.contains('is-collapsed')).toBe(false);
    // A pan by the reveal, or by the user while the draft is open: the viewport before the addition comes back.
    (mounted.view as unknown as { viewport: { set(value: object): void } }).viewport.set({ x: 11, y: 22, scale: 1 });
    mounted.key(provisionalDraft(mounted, NEW_NODE_TITLE), 'Escape');
    await mounted.settle();
    expect(mounted.source()).toBe(LIST);
    expect(mounted.node('温泉旅行').classList.contains('is-collapsed')).toBe(true);
    expect(selectedNames(mounted)).toEqual(['温泉旅行']);
    expect(mounted.view.getState().viewport).toEqual(viewport);
  });

  it('a node that lands as a free topic (Enter on a topic\'s root) is 「トピック」, as the empty canvas names one (review 3)', async () => {
    const source = `${LIST}\n## 買うもの\n\n- 野菜\n`;
    const mounted = await mount(source);
    mounted.key(mounted.select('買うもの'), 'Enter');
    await mounted.settle();
    expect(mounted.source()).toBe(`${source}\n## ${NEW_TOPIC_TITLE}\n`);
    mounted.key(provisionalDraft(mounted, NEW_TOPIC_TITLE), 'Escape');
    await mounted.settle();
    expect(mounted.source()).toBe(source);
    // A child of that topic's root is not a topic: 「サブトピック」.
    mounted.key(mounted.select('買うもの'), 'Tab');
    await mounted.settle();
    provisionalDraft(mounted, NEW_NODE_TITLE);
  });

  it('Escape after typing over the provisional name gives up the typing only: the node stays as 「サブトピック」 (review 2)', async () => {
    const mounted = await mount(LIST);
    mounted.key(mounted.select('持ち物'), 'Tab');
    await mounted.settle();
    const input = provisionalDraft(mounted, NEW_NODE_TITLE);
    input.value = '打ちかけ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    mounted.key(input, 'Escape');
    await mounted.settle();
    expect(mounted.editor()).toBeNull();
    expect(mounted.source()).toBe(LIST.replace('- 持ち物\n', `- 持ち物\n  - ${NEW_NODE_TITLE}\n`));
    expect(selectedNames(mounted)).toEqual([NEW_NODE_TITLE]);
  });

  it('Escape pressed while the draft\'s own Enter is saving keeps what Enter saves, with no Notice (review 1)', async () => {
    const mounted = await mount(LIST);
    mounted.key(mounted.select('持ち物'), 'Tab');
    await mounted.settle();
    const input = provisionalDraft(mounted, NEW_NODE_TITLE);
    input.value = '着替え';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    mounted.key(input, 'Enter');
    mounted.key(input, 'Escape');
    await mounted.settle();
    await mounted.settle();
    expect(mounted.source()).toBe(LIST.replace('- 持ち物\n', '- 持ち物\n  - 着替え\n'));
    expect(document.querySelector('.notice')).toBeNull();
  });

  it('Escape while an image is still on its way onto the new node keeps the node for it (review 1)', async () => {
    const mounted = await mount(LIST);
    mounted.key(mounted.select('持ち物'), 'Tab');
    await mounted.settle();
    const input = provisionalDraft(mounted, NEW_NODE_TITLE);
    const attach = (mounted.view as unknown as { attachImage(image: File): Promise<void> }).attachImage.bind(mounted.view);
    // Not awaited: the file is read and stored before anything is written to the note.
    const pasting = attach(new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }));
    mounted.key(input, 'Escape');
    await pasting;
    await mounted.settle();
    expect(mounted.source()).toMatch(new RegExp(`- 持ち物\\n  - ${NEW_NODE_TITLE}\\n\\n    !\\[\\[\\d*-?shot\\.png\\]\\]`, 'u'));
    expect(document.querySelector('.notice')).toBeNull();
  });

  it('with nothing selected before a topic was added, nothing is selected once Escape takes it back (review 1)', async () => {
    const mounted = await mount(LIST);
    (mounted.view as unknown as { deselect(): void }).deselect();
    mounted.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await mounted.settle();
    mounted.key(provisionalDraft(mounted, NEW_TOPIC_TITLE), 'Escape');
    await mounted.settle();
    expect(mounted.source()).toBe(LIST);
    expect(selectedNames(mounted)).toEqual([]);
  });

  it('a topic whose taking back the store refuses stays, as after any Escape: no error, and the point it was pressed at kept (reviews 1 and 3)', async () => {
    const mounted = await mount(LIST);
    mounted.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await mounted.settle();
    // A change the view could not see before the store's turn (a race): the store refuses, the section stays.
    mounted.store.retract = () => Promise.reject(new Error(conflictMessage));
    mounted.key(provisionalDraft(mounted, NEW_TOPIC_TITLE), 'Escape');
    await mounted.settle();
    expect(mounted.source()).toBe(`${LIST}\n## ${NEW_TOPIC_TITLE}\n`);
    // A change from outside inside the refresh's debounce is not the user's error to be told about on Escape.
    expect(document.querySelector('.notice')).toBeNull();
    expect(mounted.editor()).toBeNull();
    // Named later, the topic is stored where it was pressed.
    mounted.key(mounted.select(NEW_TOPIC_TITLE), 'F2');
    const input = mounted.editor();
    if (!input) throw new Error('F2 did not open the editor');
    input.value = '後で付けた名前';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    mounted.key(input, 'Enter');
    await mounted.settle();
    expect(mounted.source()).toMatch(/\n {2}後で付けた名前: \{ mindmap: \[-?\d+, -?\d+\] \}\n/u);
  });
});

describe('same-titled 「サブトピック」 nodes stay apart (LEV-203)', () => {
  it('taking one back keeps the selection, the folds and a later edit on the nodes they were on', async () => {
    const source = ['## 本体', '', '- A', '- B', ''].join('\n');
    const mounted = await mount(source);
    for (const parent of ['A', 'B']) {
      mounted.key(mounted.select(parent), 'Tab');
      await mounted.settle();
      mounted.key(provisionalDraft(mounted, NEW_NODE_TITLE), 'Enter');
      await mounted.settle();
    }
    const two = ['## 本体', '', '- A', `  - ${NEW_NODE_TITLE}`, '- B', `  - ${NEW_NODE_TITLE}`, ''].join('\n');
    expect(mounted.source()).toBe(two);
    const ids = (): string[] => documentOf(mounted).nodes.filter(node => node.title === NEW_NODE_TITLE).map(node => node.id);
    const [underA, underB] = ids();
    // B folded: its 「サブトピック」 goes out of sight.
    mounted.key(mounted.select('B'), ' ');
    await mounted.settle();
    expect(nodeElements(mounted, NEW_NODE_TITLE)).toHaveLength(1);
    // A sibling of A's 「サブトピック」, dismissed at once.
    const [aChild] = nodeElements(mounted, NEW_NODE_TITLE);
    if (!aChild) throw new Error('A\'s 「サブトピック」 is not on the map');
    aChild.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    mounted.key(aChild, 'Enter');
    await mounted.settle();
    expect(mounted.source()).toBe(two.replace(`  - ${NEW_NODE_TITLE}\n- B`, `  - ${NEW_NODE_TITLE}\n  - ${NEW_NODE_TITLE}\n- B`));
    mounted.key(provisionalDraft(mounted, NEW_NODE_TITLE), 'Escape');
    await mounted.settle();
    expect(mounted.source()).toBe(two);
    expect(ids()).toEqual([underA, underB]);
    // The selection is A's, and B is still folded.
    const selected = mounted.view.containerEl.querySelector<HTMLElement>('.mappy-node.is-selected');
    expect(selected && accessibleName(selected)).toBe(NEW_NODE_TITLE);
    expect(mounted.node('B').classList.contains('is-collapsed')).toBe(true);
    // An edit goes to the node selected: Delete removes A's 「サブトピック」, B's stays.
    if (!selected) throw new Error('Nothing selected');
    mounted.key(selected, 'Delete');
    await mounted.settle();
    expect(mounted.source()).toBe(['## 本体', '', '- A', '- B', `  - ${NEW_NODE_TITLE}`, ''].join('\n'));
  });
});
