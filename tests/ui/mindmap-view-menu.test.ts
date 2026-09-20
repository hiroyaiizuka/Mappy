// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ViewStateResult } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { Notice } from '../../harness/browser/obsidian';
import { findFixture } from '../../harness/browser/fixtures';
import type { MapMenuAction, MindmapView } from '../../src/ui/mindmap-view';
import { mountMapView, type MountedMapView } from './map-view-mount';

// The browser-harness stand-in for `obsidian`, so the shipped view, renderer and store run against a real DOM.
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });
const opened: MountedMapView[] = [];
afterEach(async () => {
  for (const mounted of opened.splice(0)) await mounted.close();
  document.body.replaceChildren();
  Notice.log.length = 0;
  vi.restoreAllMocks();
});

const PATH = 'Fixtures/free-topics.md';
const HEADINGS_PATH = 'Fixtures/headings.md';
const HEADINGS_SOURCE = '---\nmappy: true\n---\n## 講座\n\n### 第 1 章\n\n本文。\n\n### 第 2 章\n';

function fixtureSource(): string {
  const fixture = findFixture('free-topics');
  if (!fixture) throw new Error('Missing free-topics fixture');
  return fixture.source;
}

/** What a test can see of the plugin's items: the calls the popover made, and the availability each reports. */
interface PluginActions {
  actions: MapMenuAction[];
  ran: string[];
  /** The view each run received. */
  views: MindmapView[];
  /** What the page showed at the moment each run started: the popover's presence and the focused element. */
  during: { popoverOpen: boolean; focused: Element | null }[];
  /** Whether「書き出す」reports attachments as savable (`canSaveAttachments`). */
  exportable: boolean;
}

/** The two routes src/main.ts passes, with their checks stubbed. */
function pluginActions(): PluginActions {
  const state: PluginActions = { actions: [], ran: [], views: [], during: [], exportable: true };
  const record = (name: string, map: MindmapView): void => {
    state.ran.push(name); state.views.push(map);
    state.during.push({ popoverOpen: document.querySelector('.mappy-popover') !== null, focused: document.activeElement });
  };
  state.actions = [
    { title: 'マップを検索して呼び出す', description: '他のマップを挿入する', icon: 'search', check: map => map.file !== null, run: map => { record('call', map); } },
    { title: '書き出す', description: 'SVG／PNG に保存', icon: 'image-down', check: map => map.file !== null && state.exportable, run: map => { record('export', map); } },
  ];
  return state;
}

/** A DOMRect for a mocked `getBoundingClientRect` (jsdom lays nothing out). */
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => undefined };
}

/** What a pane and its gear look like on screen: the gear's card at 16px from the top-right corner, 4px of padding, a 32px button. */
function pane(width: number, height = 800, left = 0, top = 0): { pane: DOMRect; gear: DOMRect } {
  return { pane: rect(left, top, width, height), gear: rect(left + width - 16 - 4 - 32, top + 16 + 4, 32, 32) };
}

interface Mounted extends MountedMapView {
  plugin: PluginActions;
  /** The top-right floating control. */
  actions: () => HTMLElement;
  /** The single button there. */
  gear: () => HTMLButtonElement;
  /** The popover, if open. */
  popover: () => HTMLElement | null;
  /** The popover's items in order. */
  items: () => HTMLButtonElement[];
  /** The popover's item with this title. */
  item: (title: string) => HTMLButtonElement;
  /** Click the gear with the popover closed: the titles of the items in order. */
  open: () => string[];
  /** Click an item of the open popover and let the map act. */
  choose: (title: string) => Promise<void>;
  /** Give the pane and the gear a place on screen, as a window would, and return the rects. */
  place: (width: number, height?: number, left?: number, top?: number) => { pane: DOMRect; gear: DOMRect };
  /** Press a pointer at a target, as the outside-press listener sees it. */
  press: (target: EventTarget) => void;
}

async function mount(path = PATH, source = fixtureSource()): Promise<Mounted> {
  const plugin = pluginActions();
  const mounted = await mountMapView(path, source, 'mindmap', new HarnessApp(), { menuActions: plugin.actions });
  opened.push(mounted);
  const actions = (): HTMLElement => {
    const element = mounted.view.containerEl.querySelector<HTMLElement>('.mappy-actions');
    if (!element) throw new Error('The view has no top-right control');
    return element;
  };
  const gear = (): HTMLButtonElement => {
    const button = actions().querySelector<HTMLButtonElement>('button');
    if (!button) throw new Error('The top-right control has no button');
    return button;
  };
  const popover = (): HTMLElement | null => mounted.view.contentEl.querySelector<HTMLElement>('.mappy-popover');
  const items = (): HTMLButtonElement[] => Array.from(popover()?.querySelectorAll<HTMLButtonElement>('.mappy-popover-item') ?? []);
  const item = (title: string): HTMLButtonElement => {
    const found = items().find(candidate => candidate.querySelector('.mappy-popover-title')?.textContent === title);
    if (!found) throw new Error(`Popover item ${title} is not open`);
    return found;
  };
  let placed: { pane: DOMRect; gear: DOMRect } | null = null;
  vi.spyOn(mounted.view.contentEl, 'getBoundingClientRect').mockImplementation(() => placed?.pane ?? rect(0, 0, 0, 0));
  vi.spyOn(gear(), 'getBoundingClientRect').mockImplementation(() => placed?.gear ?? rect(0, 0, 0, 0));
  return {
    ...mounted, plugin, actions, gear, popover, items, item,
    open: () => {
      if (popover()) throw new Error('A popover is already open');
      gear().click();
      if (!popover()) throw new Error('The popover did not open');
      return items().map(candidate => candidate.querySelector('.mappy-popover-title')?.textContent ?? '');
    },
    choose: async title => { item(title).click(); await mounted.settle(); },
    place: (width, height, left, top) => { placed = pane(width, height, left, top); return placed; },
    press: target => { target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true })); },
  };
}

function disabled(element: HTMLElement): boolean {
  return element.classList.contains('is-disabled') && element.getAttribute('aria-disabled') === 'true';
}

/** The three items in the order of product-plan §5 M3, with the line under each and its icon. */
const ITEMS = [
  ['Markdown に切り替え', '同じタブで本文を開く', 'file-text'],
  ['マップを検索して呼び出す', '他のマップを挿入する', 'search'],
  ['書き出す', 'SVG／PNG に保存', 'image-down'],
] as const;
const TITLES = ITEMS.map(([title]) => title);

/** The context menu of a node, as before the popover (LEV-77 shared its node items; the popover holds none of them). */
const NODE_CONTEXT_MENU = ['テキストを編集', '本文・リンクを編集', '画像を追加', '子を追加', '兄弟を追加', '前へ移動', '後ろへ移動', '枝を削除', '元に戻す', 'やり直す'];

function contextMenuItems(target: EventTarget): string[] {
  target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
  const titles = Array.from(document.querySelectorAll('.menu .menu-item-title'), title => title.textContent ?? '');
  document.querySelector('.menu')?.remove();
  return titles;
}

/** Open the context menu at a target and choose an entry; `disabled` reports the entry's state instead of choosing it. */
function contextMenu(target: EventTarget, title: string, mode: 'choose' | 'disabled' = 'choose'): boolean {
  target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
  const item = Array.from(document.querySelectorAll<HTMLElement>('.menu .menu-item'))
    .find(candidate => candidate.querySelector('.menu-item-title')?.textContent === title);
  if (!item) throw new Error(`The context menu has no entry ${title}`);
  const state = item.classList.contains('is-disabled') && item.getAttribute('aria-disabled') === 'true';
  if (mode === 'choose') item.click();
  document.querySelector('.menu')?.remove();
  return state;
}

describe('the 操作 popover at the top right (§5 M3)', () => {
  it('has one button there, the settings gear named 操作 with the menu attributes, and no popover until it is pressed', async () => {
    const { view, actions, gear, popover } = await mount();
    expect(actions().querySelectorAll('button')).toHaveLength(1);
    expect(gear().getAttribute('aria-label')).toBe('操作');
    expect(gear().querySelector<HTMLElement>('[data-icon]')?.dataset.icon).toBe('settings');
    expect(gear().getAttribute('aria-haspopup')).toBe('menu');
    expect(gear().getAttribute('aria-expanded')).toBe('false');
    expect(popover()).toBeNull();
    // The other floating controls are untouched.
    expect(view.containerEl.querySelector('.mappy-modes')).not.toBeNull();
    expect(view.containerEl.querySelector('.mappy-zoom')).not.toBeNull();
  });

  it('opens a menu card inside the view with the three items in order — icon, title and one line each — and focuses the first', async () => {
    const { view, open, gear, popover, items } = await mount();
    expect(open()).toEqual(TITLES);
    const card = popover();
    expect(card?.parentElement).toBe(view.contentEl);
    expect(card?.getAttribute('role')).toBe('menu');
    expect(card?.getAttribute('aria-label')).toBe('操作');
    expect(gear().getAttribute('aria-expanded')).toBe('true');
    // The popover is the view's own element, not Obsidian's Menu.
    expect(document.querySelector('.menu')).toBeNull();
    const shown = items();
    expect(shown).toHaveLength(3);
    shown.forEach((item, index) => {
      const [title, description, icon] = ITEMS[index] ?? ['', '', ''];
      expect(item.tagName).toBe('BUTTON');
      expect(item.getAttribute('type')).toBe('button');
      expect(item.getAttribute('role')).toBe('menuitem');
      expect(item.querySelector<HTMLElement>('.mappy-popover-icon')?.dataset.icon).toBe(icon);
      expect(item.querySelector('.mappy-popover-title')?.textContent).toBe(title);
      expect(item.querySelector('.mappy-popover-description')?.textContent).toBe(description);
      expect(disabled(item), title).toBe(false);
    });
    expect(document.activeElement).toBe(shown[0]);
  });

  it('sits under the gear with the right edges aligned, at most 320px wide, offsets taken from the pane so a popout window is the same', async () => {
    const mounted = await mount();
    // No layout yet (every rect is empty, as in a hidden pane): no cap, the content's own size.
    mounted.open();
    expect((mounted.popover() as HTMLElement).style.maxWidth).toBe('');
    expect((mounted.popover() as HTMLElement).style.maxHeight).toBe('');
    mounted.gear().click();
    mounted.place(1280);
    mounted.open();
    const card = mounted.popover() as HTMLElement;
    // The gear's card is 16px in from the corner and pads the 32px button by 4px: the gear's bottom is at 52, its right edge 20px from the pane's.
    expect(card.style.top).toBe('58px');
    expect(card.style.right).toBe('20px');
    expect(card.style.maxWidth).toBe('320px');
    // The room under the gear, less the margin at the bottom.
    expect(card.style.maxHeight).toBe(`${800 - 58 - 16}px`);
    mounted.gear().click();
    // A pane that does not start at the window's origin (a split, a popout): the same offsets.
    mounted.place(900, 600, 380, 120);
    mounted.open();
    const moved = mounted.popover() as HTMLElement;
    expect(moved.style.top).toBe('58px');
    expect(moved.style.right).toBe('20px');
    expect(moved.style.maxWidth).toBe('320px');
    expect(moved.style.maxHeight).toBe(`${600 - 58 - 16}px`);
  });

  it('caps its height to the room under the gear in a short pane, where the card scrolls instead of being cut', async () => {
    const mounted = await mount();
    mounted.place(1280, 200);
    mounted.open();
    const card = mounted.popover() as HTMLElement;
    expect(card.style.maxHeight).toBe('126px');
    expect(58 + 126 + 16).toBe(200);
    mounted.place(1280, 800);
    mounted.view.onResize();
    expect(card.style.maxHeight).toBe('726px');
  });

  it('keeps its left edge inside a narrow pane: the full width at 400px, less below that, and follows a resize while open', async () => {
    const mounted = await mount();
    mounted.place(400);
    mounted.open();
    const card = mounted.popover() as HTMLElement;
    // 400 − 20 (right) − 320 (width) leaves 60px on the left, more than the 16px margin.
    expect(card.style.right).toBe('20px');
    expect(card.style.maxWidth).toBe('320px');
    // Narrower than the card and the margins: the card gives way, the margin stays.
    mounted.place(300);
    mounted.view.onResize();
    expect(card.style.right).toBe('20px');
    expect(card.style.maxWidth).toBe('264px');
    expect(20 + 264 + 16).toBe(300);
    mounted.place(1280);
    mounted.view.onResize();
    expect(card.style.maxWidth).toBe('320px');
    expect(card.style.top).toBe('58px');
  });

  it('moves the focus with ↑↓, Home and End, wrapping, and cycles Tab and Shift+Tab inside the card', async () => {
    const { open, items, popover, key } = await mount();
    open();
    const [first, second, third] = items() as [HTMLButtonElement, HTMLButtonElement, HTMLButtonElement];
    const focused = (): Element | null => document.activeElement;
    const pressed = (name: string, init?: KeyboardEventInit): KeyboardEvent => key(focused() ?? (popover() as HTMLElement), name, init);
    expect(focused()).toBe(first);
    expect(pressed('ArrowDown').defaultPrevented).toBe(true);
    expect(focused()).toBe(second);
    pressed('ArrowDown');
    expect(focused()).toBe(third);
    pressed('ArrowDown');
    expect(focused()).toBe(first);
    pressed('ArrowUp');
    expect(focused()).toBe(third);
    pressed('Home');
    expect(focused()).toBe(first);
    pressed('End');
    expect(focused()).toBe(third);
    expect(pressed('Tab').defaultPrevented).toBe(true);
    expect(focused()).toBe(first);
    pressed('Tab');
    expect(focused()).toBe(second);
    expect(pressed('Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(focused()).toBe(first);
    pressed('Tab', { shiftKey: true });
    expect(focused()).toBe(third);
    // Still open, still one card.
    expect(document.querySelectorAll('.mappy-popover')).toHaveLength(1);
  });

  it('runs the focused item on Enter and on Space, closing first so the item\'s own modal keeps the focus it takes', async () => {
    const mounted = await mount();
    const { open, items, popover, key, plugin, settle, canvas } = mounted;
    open();
    const second = items()[1] as HTMLButtonElement;
    second.focus();
    expect(key(second, 'Enter').defaultPrevented).toBe(true);
    await settle();
    expect(popover()).toBeNull();
    expect(plugin.ran).toEqual(['call']);
    expect(plugin.during).toEqual([{ popoverOpen: false, focused: canvas }]);
    open();
    (items()[2] as HTMLButtonElement).focus();
    key(items()[2] as HTMLButtonElement, ' ');
    await settle();
    expect(popover()).toBeNull();
    expect(plugin.ran).toEqual(['call', 'export']);
    expect(plugin.views).toEqual([mounted.view, mounted.view]);
  });

  it('closes on Escape and puts the focus back on the canvas', async () => {
    const { open, popover, key, gear, canvas } = await mount();
    open();
    const event = key(document.activeElement as HTMLElement, 'Escape');
    expect(event.defaultPrevented).toBe(true);
    expect(popover()).toBeNull();
    expect(gear().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(canvas);
  });

  it('closes on the gear\'s next press, the focus back on the canvas, and opens again on the press after that', async () => {
    const { open, popover, gear, press, canvas } = await mount();
    open();
    // A pointer press on the gear is not an outside press: the click that follows is what toggles.
    press(gear());
    expect(popover()).not.toBeNull();
    gear().click();
    expect(popover()).toBeNull();
    expect(gear().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(canvas);
    gear().click();
    expect(document.querySelectorAll('.mappy-popover')).toHaveLength(1);
    expect(gear().getAttribute('aria-expanded')).toBe('true');
  });

  it('closes on a press outside it: on the map the canvas takes the focus, outside the view the pressed pane does', async () => {
    const { open, popover, press, canvas, node, view } = await mount();
    open();
    press(node('睡眠'));
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(canvas);
    open();
    press(view.containerEl.querySelector('.mappy-zoom button') as HTMLElement);
    expect(popover()).toBeNull();
    open();
    // Outside the view the press comes first and its target takes the focus by itself afterwards (a browser default jsdom
    // does not run): the card only steps aside, so the focus is on nothing of the map's — the body, once the item is gone.
    const elsewhere = document.body.createDiv();
    press(elsewhere);
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(document.body);
    // A press on the card itself is not outside.
    open();
    const card = popover() as HTMLElement;
    press(card);
    expect(popover()).toBe(card);
  });

  it('closes when the focus is taken outside it, leaving the focus where it went, and not when the gear takes it', async () => {
    const { open, popover, gear, node, canvas } = await mount();
    open();
    // A node refocused by an inline edit that finished saving, a modal's input, another pane: the card has lost its keys.
    const target = node('睡眠');
    target.focus();
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(target);
    open();
    const elsewhere = document.body.createEl('input');
    elsewhere.focus();
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    // The gear takes the focus on its press (Chromium); its click is what toggles.
    open();
    gear().focus();
    expect(popover()).not.toBeNull();
    gear().click();
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(canvas);
  });

  it('closes a tick after a blur with no successor unless the focus has come back to the card', async () => {
    const { open, popover, items, canvas } = await mount();
    const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
    open();
    (document.activeElement as HTMLElement).blur();
    expect(popover()).not.toBeNull();
    await tick();
    expect(popover()).toBeNull();
    expect(document.activeElement).not.toBe(canvas);
    // The focus returning before the tick (the window regaining it): the card stays.
    open();
    const first = items()[0] as HTMLButtonElement;
    first.blur();
    first.focus();
    await tick();
    expect(popover()).not.toBeNull();
    expect(document.activeElement).toBe(first);
  });

  it('closes when the window loses the focus (a popout\'s card, the main window pressed), leaving the focus alone', async () => {
    const { open, popover, gear, canvas } = await mount();
    open();
    window.dispatchEvent(new Event('blur'));
    expect(popover()).toBeNull();
    expect(gear().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).not.toBe(canvas);
  });

  it('closes with the view and releases its listeners on the document and the window', async () => {
    const mounted = await mount();
    mounted.open();
    const removed = vi.spyOn(document, 'removeEventListener');
    const removedFromWindow = vi.spyOn(window, 'removeEventListener');
    await mounted.close();
    expect(document.querySelector('.mappy-popover')).toBeNull();
    expect(mounted.gear().getAttribute('aria-expanded')).toBe('false');
    expect(removed.mock.calls.some(([type, , options]) => type === 'pointerdown' && options === true)).toBe(true);
    expect(removedFromWindow.mock.calls.some(([type]) => type === 'blur')).toBe(true);
  });

  it('stays in place while the map pans and changes layout under it', async () => {
    const mounted = await mount();
    const { open, popover, canvas, view, settle } = mounted;
    mounted.place(1280);
    open();
    const card = popover() as HTMLElement;
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaX: 40, deltaY: 30, bubbles: true, cancelable: true }));
    // A keyboard activation of a layout button: a click without a press, so the card is not closed by it.
    view.containerEl.querySelector<HTMLButtonElement>('.mappy-modes button[aria-label="タイムライン"]')?.click();
    await settle();
    expect(view.getState().layout).toBe('timeline');
    expect(popover()).toBe(card);
    expect(card.style.top).toBe('58px');
    expect(card.style.right).toBe('20px');
    expect(card.parentElement).toBe(view.contentEl);
  });

  it('switches to Markdown with the same call the button made, once, with the card closed before it', async () => {
    const { view, open, choose, popover, canvas } = await mount();
    let during: { popoverOpen: boolean; focused: Element | null } | null = null;
    const shown = vi.spyOn(view, 'showSource').mockImplementation(() => {
      during = { popoverOpen: popover() !== null, focused: document.activeElement };
      return Promise.resolve();
    });
    open();
    await choose('Markdown に切り替え');
    expect(shown.mock.calls).toEqual([[false]]);
    expect(during).toEqual({ popoverOpen: false, focused: canvas });
  });

  it('runs the plugin\'s callbacks with the view, one per choice', async () => {
    const mounted = await mount();
    const { open, choose, plugin } = mounted;
    open();
    await choose('マップを検索して呼び出す');
    open();
    await choose('書き出す');
    expect(plugin.ran).toEqual(['call', 'export']);
    expect(plugin.views).toEqual([mounted.view, mounted.view]);
  });

  it('disables an item whose check fails, keeps it focusable and does nothing when it is chosen', async () => {
    const { open, item, choose, plugin, popover, items } = await mount();
    plugin.exportable = false;
    open();
    expect(disabled(item('書き出す'))).toBe(true);
    expect(disabled(item('マップを検索して呼び出す'))).toBe(false);
    expect(disabled(item('Markdown に切り替え'))).toBe(false);
    (items()[2] as HTMLButtonElement).focus();
    expect(document.activeElement).toBe(items()[2]);
    await choose('書き出す');
    expect(plugin.ran).toEqual([]);
    expect(popover()).not.toBeNull();
  });

  it('disables all three items while the view shows no note', async () => {
    const { view, open, items, settle, choose, plugin } = await mount();
    const shown = vi.spyOn(view, 'showSource').mockResolvedValue();
    await view.setState({}, { history: false } satisfies ViewStateResult);
    await settle();
    expect(view.file).toBeNull();
    expect(open()).toEqual(TITLES);
    for (const item of items()) expect(disabled(item), item.textContent ?? '').toBe(true);
    expect(document.activeElement).toBe(items()[0]);
    await choose('Markdown に切り替え');
    expect(shown).not.toHaveBeenCalled();
    expect(plugin.ran).toEqual([]);
  });

  it('leaves the context menu as it was: the node items, the moves, the deletion and the history, and the list conversion on a headings note', async () => {
    const { node, canvas } = await mount();
    expect(contextMenuItems(node('睡眠'))).toEqual(NODE_CONTEXT_MENU);
    expect(contextMenuItems(node('参考資料'))).toEqual(NODE_CONTEXT_MENU.map(title => title === '枝を削除' ? 'トピックを削除' : title));
    expect(contextMenuItems(canvas)).toEqual(['トピックを追加', '元に戻す', 'やり直す']);
    const headings = await mount(HEADINGS_PATH, HEADINGS_SOURCE);
    expect(contextMenuItems(headings.node('第 1 章'))).toEqual([...NODE_CONTEXT_MENU, 'リスト形式に変更']);
  });

  it('still converts a headings note to the list form from the context menu, with the same result as the command', async () => {
    const { node, source, view, settle } = await mount(HEADINGS_PATH, HEADINGS_SOURCE);
    expect(contextMenu(node('第 1 章'), 'リスト形式に変更', 'disabled')).toBe(false);
    contextMenu(node('第 1 章'), 'リスト形式に変更');
    await settle();
    expect(source()).toBe('---\nmappy: true\n---\n## 講座\n\n- 第 1 章\n\n  本文。\n\n- 第 2 章\n');
    expect(Notice.log).toContain('H2 とリストの形式に変更しました。元に戻す操作で復元できます。');
    expect(view.snapshot()?.document?.format).toBe('list');
    // A list note offers no conversion.
    expect(contextMenuItems(node('第 1 章'))).toEqual(NODE_CONTEXT_MENU);
  });

  it('still undoes and redoes from the context menu, enabled as the history allows', async () => {
    const { node, select, key, settle, editor, source, canvas } = await mount();
    const original = source();
    expect(contextMenu(node('睡眠'), '元に戻す', 'disabled')).toBe(true);
    expect(contextMenu(node('睡眠'), 'やり直す', 'disabled')).toBe(true);
    key(select('睡眠'), 'Delete');
    await settle();
    expect(editor()).toBeNull();
    const deleted = source();
    expect(deleted).not.toBe(original);
    expect(contextMenu(canvas, '元に戻す', 'disabled')).toBe(false);
    contextMenu(canvas, '元に戻す');
    await settle();
    expect(source()).toBe(original);
    expect(contextMenu(canvas, 'やり直す', 'disabled')).toBe(false);
    contextMenu(canvas, 'やり直す');
    await settle();
    expect(source()).toBe(deleted);
  });
});
