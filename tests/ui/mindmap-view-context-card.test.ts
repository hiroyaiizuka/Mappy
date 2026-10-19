// @vitest-environment jsdom
/**
 * LEV-369 (the person's decision of 2026-10-19「1=A」): the right-click of the map opens a card of the map's own, not
 * Obsidian's `Menu` — on a node the row of colours on top, the two edits without a key, the deletion below a line; on
 * the empty canvas the topic. Rows are the person's operations (right-click, the card's keys, a press, a scroll, another
 * tab, another window) × what the card is for (a list item, a topic, a node of a heading note, a root that takes no
 * colour, the empty canvas). The called map's node is in tests/ui/called-branches.test.ts, the colours' writes in
 * tests/ui/mindmap-view-color.test.ts.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installObsidianDom } from '../browser-harness/dom';
import { Notice } from '../browser-harness/obsidian';
import { findFixture } from '../browser-harness/fixtures';
import { mountMapView, type MountedMapView } from './map-view-mount';
import { closeOpenViews } from '../mocks/open-views';
import { cardRow, cardSwatch, cardSwatches, cardTitles, cardTitlesAt, closeContextCard, contextCard, openContextCard } from './context-card';

vi.mock('obsidian', () => import('../browser-harness/obsidian'));

beforeAll(() => { installObsidianDom(); });
afterEach(async () => {
  await closeOpenViews();
  document.body.replaceChildren();
  Notice.log.length = 0;
  vi.restoreAllMocks();
});

const PATH = 'Fixtures/free-topics.md';
const HEADINGS_PATH = 'Fixtures/headings.md';
const HEADINGS_SOURCE = '---\nmappy: true\n---\n## 講座\n\n### 第 1 章\n\n本文。\n\n### 第 2 章\n';
const COLORS = ['色なし', '黄色', 'オレンジ', '赤', '緑', '青', '紫'];
/** The rows the card took off (LEV-369), each reached otherwise: double click／F2, Tab, Enter, a drag／⌥↑↓, ⌘Z／⌘⇧Z. */
const REMOVED = ['テキストを編集', '子を追加', '兄弟を追加', '前へ移動', '後ろへ移動', '元に戻す', 'やり直す'];

function fixtureSource(): string {
  const fixture = findFixture('free-topics');
  if (!fixture) throw new Error('Missing free-topics fixture');
  return fixture.source;
}

async function mount(path = PATH, source = fixtureSource()): Promise<MountedMapView> {
  return mountMapView(path, source);
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => undefined };
}

/** Lay the pane out at `pane` and every context card at `card`'s size (jsdom lays nothing out). */
function layOut(mounted: MountedMapView, pane: DOMRect, card: { width: number; height: number }): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === mounted.view.contentEl) return pane;
    if (this.classList.contains('mappy-context-card')) return rect(0, 0, card.width, card.height);
    return rect(0, 0, 0, 0);
  });
}

describe('the context card of a node (LEV-369)', () => {
  it('opens the view\'s own card, not Obsidian\'s menu: the colours on top, the two edits, the deletion below a line', async () => {
    const { node, view } = await mount();
    const card = openContextCard(node('睡眠'));
    expect(document.querySelector('.menu')).toBeNull();
    expect(card.parentElement).toBe(view.contentEl);
    expect(card.getAttribute('role')).toBe('menu');
    expect(card.getAttribute('aria-label')).toBe('ノードのメニュー');
    expect(cardSwatches(card)).toEqual({ labels: COLORS, checked: ['色なし'] });
    expect(cardTitles(card)).toEqual(['本文・リンクを編集', '画像を追加', '削除']);
    // In the card's order: the colours, a line, the edits, a line, the deletion.
    expect(Array.from(card.children, child => child.className.split(' ')[0])).toEqual([
      'mappy-swatches', 'mappy-popover-separator', 'mappy-popover-item', 'mappy-popover-item', 'mappy-popover-separator', 'mappy-popover-item',
    ]);
    for (const title of REMOVED) expect(card.textContent).not.toContain(title);
    expect(node('睡眠').classList.contains('is-selected')).toBe(true);
  });

  it('names each colour for a screen reader and the tooltip, the current one checked, as radio items in a group named 色', async () => {
    const { node } = await mount();
    const card = openContextCard(node('睡眠'));
    const group = card.querySelector('.mappy-swatches');
    expect([group?.getAttribute('role'), group?.getAttribute('aria-label')]).toEqual(['group', '色']);
    const circles = Array.from(card.querySelectorAll<HTMLButtonElement>('.mappy-swatch'));
    expect(circles.map(circle => circle.getAttribute('role'))).toEqual(Array(7).fill('menuitemradio'));
    expect(circles.map(circle => circle.querySelector<HTMLElement>('.mappy-swatch-fill')?.dataset.mappyColor ?? null))
      .toEqual([null, 'yellow', 'orange', 'red', 'green', 'blue', 'purple']);
    expect(circles[0]?.querySelector('[data-mappy-none]')).not.toBeNull();
    for (const row of card.querySelectorAll('.mappy-popover-item')) expect(row.getAttribute('role')).toBe('menuitem');
    expect(card.querySelectorAll('[role="separator"]')).toHaveLength(2);
  });

  it('shows only keys the map answers: ⌫ (Delete off a Mac) beside the deletion, nothing beside the edits', async () => {
    const { node } = await mount();
    openContextCard(node('睡眠'));
    const remove = cardRow('削除');
    expect(remove.querySelector('.mappy-popover-key')?.textContent).toBe('Delete');
    expect(remove.getAttribute('aria-keyshortcuts')).toBe('Delete Backspace');
    expect(remove.classList.contains('mod-warning')).toBe(true);
    for (const title of ['本文・リンクを編集', '画像を追加']) {
      expect(cardRow(title).querySelector('.mappy-popover-key')).toBeNull();
      expect(cardRow(title).hasAttribute('aria-keyshortcuts')).toBe(false);
    }
  });

  it('says トピックを削除 on a free topic, keeps the list conversion on a heading note, and leaves out the colours where none can be written', async () => {
    const mounted = await mount();
    expect(cardTitlesAt(mounted.node('参考資料'))).toEqual(['本文・リンクを編集', '画像を追加', 'トピックを削除']);
    // Where the colour commands are off (`canColor`, LEV-364: a parse root that is not a list note's file name), so is the row.
    vi.spyOn(mounted.view, 'canColor').mockReturnValue(false);
    const card = openContextCard(mounted.node('睡眠'));
    expect(cardSwatches(card).labels).toEqual([]);
    expect(card.querySelector('.mappy-swatches')).toBeNull();
    expect(card.firstElementChild?.classList.contains('mappy-popover-item')).toBe(true);
    closeContextCard();
    await closeOpenViews();
    const headings = await mount(HEADINGS_PATH, HEADINGS_SOURCE);
    expect(cardTitlesAt(headings.node('第 1 章'))).toEqual(['本文・リンクを編集', '画像を追加', 'リスト形式に変更', '削除']);
  });

  it('converts a heading note to the list form from the card, as the command does; a list note offers no conversion', async () => {
    const { node, source, view, settle } = await mount(HEADINGS_PATH, HEADINGS_SOURCE);
    openContextCard(node('第 1 章'));
    cardRow('リスト形式に変更').click();
    await settle();
    expect(source()).toBe('---\nmappy: true\n---\n## 講座\n\n- 第 1 章\n\n  本文。\n\n- 第 2 章\n');
    expect(Notice.log).toContain('H2 とリストの形式に変更しました。元に戻す操作で復元できます。');
    expect(view.snapshot()?.document?.format).toBe('list');
    expect(cardTitlesAt(node('第 1 章'))).toEqual(['本文・リンクを編集', '画像を追加', '削除']);
  });

  it('colours the node in one press, one step back with ⌘Z, the card gone and the node focused', async () => {
    const { node, source, settle, key, canvas } = await mount();
    const original = source();
    openContextCard(node('睡眠'));
    cardSwatch('緑').click();
    await settle();
    await settle();
    expect(contextCard()).toBeNull();
    expect(source()).toBe(original.replace('  - 睡眠', '  - <mark style="background: #BBFABBA6;">睡眠</mark>'));
    expect(document.activeElement).toBe(node('睡眠'));
    expect(cardSwatches(openContextCard(node('睡眠'))).checked).toEqual(['緑']);
    closeContextCard();
    key(canvas, 'z', { metaKey: true });
    await settle();
    await settle();
    expect(source()).toBe(original);
  });

  it('deletes from the card as Delete does, the node read when the row is chosen', async () => {
    const byCard = await mount();
    const original = byCard.source();
    openContextCard(byCard.node('睡眠'));
    cardRow('削除').click();
    await byCard.settle();
    const deleted = byCard.source();
    expect(deleted).not.toBe(original);
    await closeOpenViews();
    const byKey = await mount();
    byKey.key(byKey.select('睡眠'), 'Delete');
    await byKey.settle();
    expect(byKey.source()).toBe(deleted);
  });

  it('runs the deletion on its own key pressed on the card (⌫／Delete), as the key does on the map (review 3)', async () => {
    const { node, source, settle, key } = await mount();
    const original = source();
    openContextCard(node('睡眠'));
    expect(key(document.activeElement as HTMLElement, 'Backspace').defaultPrevented).toBe(true);
    await settle();
    expect(contextCard()).toBeNull();
    expect(source()).toBe(original.replace('  - 睡眠\n', ''));
    openContextCard(node('ふりかえる'));
    key(document.activeElement as HTMLElement, 'Delete');
    await settle();
    expect(source()).toBe(original.replace('  - 睡眠\n', '').replace('  - ふりかえる\n', ''));
  });

  it('offers no deletion on the file name standing as the root, which is never deleted (review 3)', async () => {
    const { node } = await mount('Fixtures/no-heading.md', '---\nmappy: true\n---\n- 項目\n');
    const card = openContextCard(node('no-heading'));
    expect(cardSwatches(card).labels).toHaveLength(7);
    expect(cardTitles(card)).toEqual(['本文・リンクを編集', '画像を追加']);
    expect(cardTitlesAt(node('項目'))).toEqual(['本文・リンクを編集', '画像を追加', '削除']);
  });

  it('opens the 本文・リンクを編集 modal and writes nothing by opening or closing', async () => {
    const { node, source, settle } = await mount();
    const original = source();
    openContextCard(node('睡眠'));
    closeContextCard();
    openContextCard(node('参考資料'), 900, 700);
    closeContextCard();
    expect(source()).toBe(original);
    openContextCard(node('睡眠'));
    cardRow('本文・リンクを編集').click();
    await settle();
    expect(document.querySelector('.modal .mappy-edit-input')).not.toBeNull();
    expect(source()).toBe(original);
  });
});

describe('the context card of the empty canvas (LEV-369)', () => {
  it('offers トピックを追加 alone, with no colours, and adds the topic where the card was opened', async () => {
    const { canvas, source, settle, editor } = await mount();
    const card = openContextCard(canvas, 300, 400);
    expect(card.getAttribute('aria-label')).toBe('マップのメニュー');
    expect(cardTitles(card)).toEqual(['トピックを追加']);
    expect(card.querySelector('.mappy-swatches')).toBeNull();
    const before = source();
    cardRow('トピックを追加').click();
    await settle();
    expect(source()).toBe(`${before}\n## トピック\n`);
    expect(editor()).not.toBeNull();
  });
});

describe('the context card\'s keys (LEV-369)', () => {
  it('starts on the checked colour, moves along the colours with ←→ (wrapping) and between the rows with ↑↓, Tab, Home and End', async () => {
    const { node, key } = await mount();
    const card = openContextCard(node('睡眠'));
    const focused = (): string => {
      const active = document.activeElement as HTMLElement | null;
      return active?.getAttribute('aria-label') ?? active?.querySelector('.mappy-popover-title')?.textContent ?? '';
    };
    const press = (name: string, init?: KeyboardEventInit): KeyboardEvent => key(document.activeElement ?? card, name, init);
    expect(focused()).toBe('色なし');
    expect(press('ArrowRight').defaultPrevented).toBe(true);
    expect(focused()).toBe('黄色');
    press('ArrowLeft');
    press('ArrowLeft');
    expect(focused()).toBe('紫');
    expect(press('ArrowDown').defaultPrevented).toBe(true);
    expect(focused()).toBe('本文・リンクを編集');
    // ←→ on a row of one do nothing, and are not taken.
    expect(press('ArrowRight').defaultPrevented).toBe(false);
    expect(focused()).toBe('本文・リンクを編集');
    press('ArrowDown');
    expect(focused()).toBe('画像を追加');
    press('Tab');
    expect(focused()).toBe('削除');
    press('Tab');
    // Back on the colours: the checked one.
    expect(focused()).toBe('色なし');
    press('Tab', { shiftKey: true });
    expect(focused()).toBe('削除');
    press('Home');
    expect(focused()).toBe('色なし');
    press('End');
    expect(focused()).toBe('削除');
    press('ArrowUp');
    expect(focused()).toBe('画像を追加');
    expect(contextCard()).toBe(card);
  });

  it('runs the focused colour on Enter and the focused row on Space, closing first', async () => {
    const { node, key, settle, source } = await mount();
    openContextCard(node('睡眠'));
    key(document.activeElement as HTMLElement, 'ArrowRight');
    expect(key(document.activeElement as HTMLElement, 'Enter').defaultPrevented).toBe(true);
    await settle();
    await settle();
    expect(contextCard()).toBeNull();
    expect(source()).toContain('  - <mark style="background: #FFF3A3A6;">睡眠</mark>');
    openContextCard(node('睡眠'));
    key(document.activeElement as HTMLElement, 'ArrowDown');
    key(document.activeElement as HTMLElement, ' ');
    await settle();
    expect(contextCard()).toBeNull();
    expect(document.querySelector('.modal .mappy-edit-input')).not.toBeNull();
  });

  it('closes on Escape, the focus back on the node it was for; on the empty canvas\'s card back on the canvas', async () => {
    const { node, key, canvas } = await mount();
    openContextCard(node('睡眠'));
    expect(key(document.activeElement as HTMLElement, 'Escape').defaultPrevented).toBe(true);
    expect(contextCard()).toBeNull();
    expect(document.activeElement).toBe(node('睡眠'));
    // The empty canvas's card leaves the selection as it was: the focus goes back to the selected node.
    openContextCard(canvas, 300, 300);
    key(document.activeElement as HTMLElement, 'Escape');
    expect(document.activeElement).toBe(node('睡眠'));
  });
});

describe('closing the context card (LEV-369)', () => {
  const press = (target: EventTarget): void => { target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true })); };

  it('closes on a press outside it: on the map the node takes the focus back, outside the view the pressed place keeps it', async () => {
    const { node, view } = await mount();
    const card = openContextCard(node('睡眠'));
    press(card);
    expect(contextCard()).toBe(card);
    press(view.containerEl.querySelector('.mappy-zoom button') as HTMLElement);
    expect(contextCard()).toBeNull();
    expect(document.activeElement).toBe(node('睡眠'));
    openContextCard(node('睡眠'));
    press(document.body.createDiv());
    expect(contextCard()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('closes when the map scrolls or zooms under it, the focus back on the node', async () => {
    const { node, canvas } = await mount();
    openContextCard(node('睡眠'));
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaX: 40, deltaY: 30, bubbles: true, cancelable: true }));
    expect(contextCard()).toBeNull();
    expect(document.activeElement).toBe(node('睡眠'));
    openContextCard(node('睡眠'));
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, ctrlKey: true, bubbles: true, cancelable: true }));
    expect(contextCard()).toBeNull();
  });

  it('closes when another tab becomes the active one or the focus is taken elsewhere, leaving the focus where it went', async () => {
    const { node, app } = await mount();
    openContextCard(node('睡眠'));
    app.workspace.trigger('active-leaf-change', {});
    expect(contextCard()).toBeNull();
    openContextCard(node('睡眠'));
    const elsewhere = document.body.createEl('input');
    elsewhere.focus();
    expect(contextCard()).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });

  it('closes when its window loses the focus, leaving the focus on the node for the window\'s return', async () => {
    const { node } = await mount();
    openContextCard(node('睡眠'));
    window.dispatchEvent(new Event('blur'));
    expect(contextCard()).toBeNull();
    expect(document.activeElement).toBe(node('睡眠'));
  });

  it('leaves the focus alone when the window lost it to a frame or web view of its own (review 1)', async () => {
    const { node } = await mount();
    openContextCard(node('睡眠'));
    // The page's focus is in the frame by the time the window's blur arrives (Chromium: the frame element is active).
    const frame = document.body.createEl('iframe');
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(frame);
    window.dispatchEvent(new Event('blur'));
    vi.restoreAllMocks();
    expect(contextCard()).toBeNull();
    expect(document.activeElement).not.toBe(node('睡眠'));
  });

  it('closes when another note loads into the leaf (back, forward, a link): its rows were for the note that went (review 2)', async () => {
    const mounted = await mount();
    mounted.app.put(HEADINGS_PATH, HEADINGS_SOURCE);
    openContextCard(mounted.node('睡眠'));
    await mounted.view.setState({ file: HEADINGS_PATH }, { history: false });
    await mounted.settle();
    expect(contextCard()).toBeNull();
  });

  it('stays open while the view moves the map itself (a fit, a node brought on screen), and closes on a person\'s wheel (review 1)', async () => {
    const mounted = await mount();
    const card = openContextCard(mounted.node('睡眠'));
    const viewport = (mounted.view as unknown as { viewport: { value: { x: number; y: number; scale: number }; set: (value: { x: number; y: number; scale: number }) => void } }).viewport;
    viewport.set({ ...viewport.value, x: viewport.value.x + 50 });
    await mounted.settle();
    expect(contextCard()).toBe(card);
    mounted.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 30, bubbles: true, cancelable: true }));
    expect(contextCard()).toBeNull();
  });

  it('keeps the card and its node when a renamed draft\'s save lands under it, and its rows act on that node (review 1)', async () => {
    const { node, source, settle, editor } = await mount();
    const original = source();
    node('睡眠').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await settle();
    const input = editor();
    if (!input) throw new Error('No draft on 睡眠');
    input.value = '睡眠（改）';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    // The right press on another node takes the focus from the draft (its blur saves it), then its card opens.
    const other = node('ふりかえる');
    other.focus();
    const card = openContextCard(other);
    await settle();
    await settle();
    expect(source()).toBe(original.replace('  - 睡眠\n', '  - 睡眠（改）\n'));
    expect(contextCard()).toBe(card);
    expect(node('ふりかえる').classList.contains('is-selected')).toBe(true);
    expect(card.contains(document.activeElement)).toBe(true);
    cardRow('削除').click();
    await settle();
    expect(source()).toBe(original.replace('  - 睡眠\n', '  - 睡眠（改）\n').replace('  - ふりかえる\n', ''));
  });

  it('keeps the right-clicked node when the card is closed before the edit\'s save lands (review 2)', async () => {
    const { node, source, settle, editor, key } = await mount();
    const original = source();
    node('睡眠').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await settle();
    const input = editor();
    if (!input) throw new Error('No draft on 睡眠');
    input.value = '睡眠（改）';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    const other = node('ふりかえる');
    other.focus();
    openContextCard(other);
    key(document.activeElement as HTMLElement, 'Escape');
    expect(contextCard()).toBeNull();
    await settle();
    await settle();
    expect(source()).toBe(original.replace('  - 睡眠\n', '  - 睡眠（改）\n'));
    expect(node('ふりかえる').classList.contains('is-selected')).toBe(true);
    expect(document.activeElement).toBe(node('ふりかえる'));
  });

  it('closes when someone else changes the note under it, the focus back on the node: its ids may name other nodes now (review 3)', async () => {
    const { node, source, settle, app, file } = await mount();
    openContextCard(node('睡眠'));
    app.put(file.path, source().replace('  - 休息の取り方\n', '  - 足した項目\n  - 休息の取り方\n'));
    await new Promise(resolve => setTimeout(resolve, 100));
    await settle();
    expect(contextCard()).toBeNull();
    expect(document.activeElement).toBe(node('睡眠'));
  });

  it('keeps a held edit\'s end the person\'s once they go back into it, after a right-click elsewhere (review 3)', async () => {
    const { node, source, settle, editor, key } = await mount(HEADINGS_PATH, HEADINGS_SOURCE);
    node('第 1 章').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await settle();
    const input = editor();
    if (!input) throw new Error('No draft on 第 1 章');
    // A rename the note refuses (an ATX heading's closing sequence): Enter keeps the edit open with the reason.
    input.value = '第 1 章 #';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    key(input, 'Enter');
    await settle();
    expect(editor()).toBe(input);
    openContextCard(node('第 2 章'));
    key(document.activeElement as HTMLElement, 'Escape');
    input.focus();
    input.value = '第一章';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    key(input, 'Enter');
    await settle();
    await settle();
    expect(source()).toContain('### 第一章\n');
    expect(node('第一章').classList.contains('is-selected')).toBe(true);
    expect(document.activeElement).toBe(node('第一章'));
  });

  it('closes with the view and releases its listeners on the document and the window', async () => {
    const mounted = await mount();
    openContextCard(mounted.node('睡眠'));
    const removed = vi.spyOn(document, 'removeEventListener');
    const removedFromWindow = vi.spyOn(window, 'removeEventListener');
    await mounted.close();
    expect(contextCard()).toBeNull();
    expect(removed.mock.calls.some(([type, , options]) => type === 'pointerdown' && options === true)).toBe(true);
    expect(removedFromWindow.mock.calls.some(([type]) => type === 'blur')).toBe(true);
  });

  it('is one card at a time: another right-click replaces it, the gear\'s card closes it and it closes the gear\'s', async () => {
    const mounted = await mountMapView(PATH, fixtureSource(), 'mindmap', undefined, { menuActions: [] });
    const gear = mounted.view.containerEl.querySelector<HTMLButtonElement>('.mappy-actions button') as HTMLButtonElement;
    openContextCard(mounted.node('睡眠'));
    openContextCard(mounted.node('参考資料'));
    expect(document.querySelectorAll('.mappy-popover')).toHaveLength(1);
    expect(cardTitles()).toContain('トピックを削除');
    gear.click();
    expect(contextCard()).toBeNull();
    expect(document.querySelectorAll('.mappy-popover')).toHaveLength(1);
    openContextCard(mounted.node('睡眠'));
    expect(document.querySelectorAll('.mappy-popover')).toHaveLength(1);
    expect(gear.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('where the context card opens (LEV-369)', () => {
  it('opens at the point, to its right and below it, offsets from the pane', async () => {
    const mounted = await mount();
    layOut(mounted, rect(100, 50, 1000, 700), { width: 220, height: 180 });
    const card = openContextCard(mounted.node('睡眠'), 400, 300);
    expect([card.style.left, card.style.top]).toEqual(['300px', '250px']);
    expect([card.style.maxWidth, card.style.maxHeight]).toEqual(['320px', '684px']);
  });

  it('opens to the left of or above the point near the right or bottom edge, and against the edge when neither side has room', async () => {
    const mounted = await mount();
    layOut(mounted, rect(0, 0, 600, 400), { width: 220, height: 180 });
    const corner = openContextCard(mounted.node('睡眠'), 590, 390);
    expect([corner.style.left, corner.style.top]).toEqual(['370px', '210px']);
    closeContextCard();
    // A short pane: 300 high, the card 180 high, opened at 150 — neither below (150 + 180 > 292) nor above (150 - 180 < 8).
    vi.restoreAllMocks();
    layOut(mounted, rect(0, 0, 600, 300), { width: 220, height: 180 });
    const middle = openContextCard(mounted.node('睡眠'), 100, 150);
    expect([middle.style.left, middle.style.top]).toEqual(['100px', '112px']);
  });

  it('caps itself to a pane smaller than it, its least width too, so it scrolls inside the pane instead of leaving it (review 1)', async () => {
    const mounted = await mount();
    layOut(mounted, rect(0, 0, 200, 150), { width: 184, height: 134 });
    const card = openContextCard(mounted.node('睡眠'), 50, 50);
    expect([card.style.minWidth, card.style.maxWidth, card.style.maxHeight]).toEqual(['184px', '184px', '134px']);
    expect([card.style.left, card.style.top]).toEqual(['8px', '8px']);
  });

  it('keeps 200px as its least width where the pane has the room, and never starts before the pane (a point outside it) (review 1)', async () => {
    const mounted = await mount();
    layOut(mounted, rect(300, 100, 1000, 700), { width: 220, height: 180 });
    const card = openContextCard(mounted.node('睡眠'), 0, 0);
    expect(card.style.minWidth).toBe('200px');
    expect([card.style.left, card.style.top]).toEqual(['8px', '8px']);
  });
});
