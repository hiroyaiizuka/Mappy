// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ViewStateResult } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { Menu, Notice } from '../../harness/browser/obsidian';
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
const SEPARATOR = '———';

function fixtureSource(): string {
  const fixture = findFixture('free-topics');
  if (!fixture) throw new Error('Missing free-topics fixture');
  return fixture.source;
}

/** What a test can see of the plugin's items: the calls the menu made, and the availability each reports. */
interface PluginActions {
  actions: MapMenuAction[];
  ran: string[];
  /** The view each run received. */
  views: MindmapView[];
  /** Whether「Excalidraw の図面に挿入」reports Excalidraw as present. */
  excalidraw: boolean;
}

/** The three routes src/main.ts passes, with their checks stubbed. */
function pluginActions(): PluginActions {
  const state: PluginActions = { actions: [], ran: [], views: [], excalidraw: false };
  state.actions = [
    { title: 'マップを検索して呼び出す', icon: 'search', check: map => map.file !== null, run: map => { state.ran.push('call'); state.views.push(map); } },
    { title: 'Excalidraw の図面に挿入', icon: 'pencil-ruler', check: map => map.file !== null && state.excalidraw, run: map => { state.ran.push('excalidraw'); state.views.push(map); } },
    { title: 'SVG／PNG に書き出し', icon: 'image-down', check: map => map.file !== null, run: map => { state.ran.push('export'); state.views.push(map); } },
  ];
  return state;
}

interface Mounted extends MountedMapView {
  plugin: PluginActions;
  /** The top-right floating control. */
  actions: () => HTMLElement;
  /** The single button there. */
  gear: () => HTMLButtonElement;
  /** Close a menu left open, click the gear: the open menu's entries in order, a separator as `———`. */
  open: () => Promise<string[]>;
  /** An entry of the open menu. */
  item: (title: string) => HTMLElement;
  /** Click an entry of the open menu and let the map act. */
  choose: (title: string) => Promise<void>;
  /** ⌘Z on the canvas: the map's own history, then a refresh. */
  undo: () => Promise<void>;
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
  const item = (title: string): HTMLElement => {
    const found = Array.from(document.querySelectorAll<HTMLElement>('.menu .menu-item'))
      .find(candidate => candidate.querySelector('.menu-item-title')?.textContent === title);
    if (!found) throw new Error(`Menu item ${title} is not open`);
    return found;
  };
  return {
    ...mounted, plugin, actions, gear, item,
    open: async () => {
      // The mock menu listens for Escape once a timer has run, as Obsidian's does; a menu a test left open closes here.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (document.querySelector('.menu')) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      if (document.querySelector('.menu')) throw new Error('A menu stayed open');
      gear().click();
      const menu = document.querySelector('.menu');
      if (!menu) throw new Error('The menu did not open');
      return Array.from(menu.children, child => child.classList.contains('menu-separator') ? SEPARATOR : child.querySelector('.menu-item-title')?.textContent ?? '');
    },
    choose: async title => { item(title).click(); await mounted.settle(); },
    undo: async () => { mounted.key(mounted.canvas, 'z', { metaKey: true }); await mounted.settle(); },
  };
}

function disabled(element: HTMLElement): boolean {
  return element.classList.contains('is-disabled') && element.getAttribute('aria-disabled') === 'true';
}

/** The entries in the order and grouping of product-plan §5 M3. */
const ENTRIES = [
  'Markdown に切り替え', '左に Markdown を開く', SEPARATOR,
  '兄弟を追加（Enter）', '子を追加（Tab）', 'トピックを追加', SEPARATOR,
  'テキストを編集（F2）', '本文・リンクを編集', '画像を追加', '折りたたみ（Space）', '削除（Delete）', SEPARATOR,
  'マップを検索して呼び出す', 'Excalidraw の図面に挿入', 'SVG／PNG に書き出し', 'リスト形式に変更', SEPARATOR,
  '元に戻す', 'やり直す',
];

describe('the 操作 menu at the top right (§5 M3)', () => {
  it('has one button there, the settings gear named 操作, and the Markdown buttons are gone', async () => {
    const { view, actions, gear } = await mount();
    expect(actions().querySelectorAll('button')).toHaveLength(1);
    expect(gear().getAttribute('aria-label')).toBe('操作');
    expect(gear().querySelector<HTMLElement>('[data-icon]')?.dataset.icon).toBe('settings');
    expect(view.containerEl.querySelectorAll('.mappy-button[aria-label="Markdown に切り替え"], .mappy-button[aria-label="左に Markdown を開く"]')).toHaveLength(0);
    // The other floating controls are untouched.
    expect(view.containerEl.querySelector('.mappy-modes')).not.toBeNull();
    expect(view.containerEl.querySelector('.mappy-zoom')).not.toBeNull();
  });

  it('opens under the button, right-aligned, in the view\'s own document, with the entries, separators and keys in order', async () => {
    const { open, gear } = await mount();
    const shown = vi.spyOn(Menu.prototype, 'showAtPosition');
    // jsdom has no layout: give the button a place, as a real window would.
    const rect = { x: 1200, y: 16, left: 1200, top: 16, right: 1232, bottom: 48, width: 32, height: 32, toJSON: () => undefined };
    vi.spyOn(gear(), 'getBoundingClientRect').mockReturnValue(rect);
    expect(await open()).toEqual(ENTRIES);
    expect(shown).toHaveBeenCalledTimes(1);
    // Obsidian's own menu right-aligns with the button (`left` with its width); a native one opens from (x, y), its left-bottom corner.
    expect(shown.mock.calls[0]?.[0]).toEqual({ x: 1200, y: 48, width: 32, overlap: true, left: true });
    // Obsidian takes the document as the second argument (a popout window shows the menu in its own window).
    expect((shown.mock.calls[0] as unknown[])[1]).toBe(document);
    expect(gear().getAttribute('aria-haspopup')).toBe('menu');
    expect(gear().getAttribute('aria-expanded')).toBe('true');
  });

  it('closes on the button\'s next press instead of opening a second menu, and opens again on the press after that', async () => {
    const { open, gear } = await mount();
    await open();
    expect(gear().getAttribute('aria-expanded')).toBe('true');
    // Obsidian's menu hides on the window's mousedown outside it (registered once the menu has loaded), before the button's click.
    await new Promise(resolve => setTimeout(resolve, 0));
    gear().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(document.querySelector('.menu')).toBeNull();
    gear().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(document.querySelector('.menu')).toBeNull();
    expect(gear().getAttribute('aria-expanded')).toBe('false');
    // A keyboard activation is a click without a mousedown: it opens.
    gear().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(document.querySelectorAll('.menu')).toHaveLength(1);
    expect(gear().getAttribute('aria-expanded')).toBe('true');
  });

  it('closes with the view', async () => {
    const mounted = await mount();
    await mounted.open();
    await mounted.close();
    expect(document.querySelector('.menu')).toBeNull();
  });

  it('enables every entry on an open note with the selected root, except the Excalidraw item without Excalidraw, the list conversion of a list note and the empty history', async () => {
    const { open, item } = await mount();
    await open();
    for (const title of ENTRIES.filter(entry => entry !== SEPARATOR)) {
      const expected = title === 'Excalidraw の図面に挿入' || title === 'リスト形式に変更' || title === '元に戻す' || title === 'やり直す';
      expect(disabled(item(title)), title).toBe(expected);
    }
  });

  it('enables the Excalidraw item when the plugin reports Excalidraw, and runs the plugin\'s callbacks with the view', async () => {
    const mounted = await mount();
    const { open, item, choose, plugin } = mounted;
    plugin.excalidraw = true;
    await open();
    expect(disabled(item('Excalidraw の図面に挿入'))).toBe(false);
    await choose('Excalidraw の図面に挿入');
    expect(document.querySelector('.menu')).toBeNull();
    await open();
    await choose('マップを検索して呼び出す');
    await open();
    await choose('SVG／PNG に書き出し');
    expect(plugin.ran).toEqual(['excalidraw', 'call', 'export']);
    expect(plugin.views).toEqual([mounted.view, mounted.view, mounted.view]);
  });

  it('disables the node entries, the Markdown entries, the topic and the plugin\'s items while the view shows no note', async () => {
    const { view, open, item, settle, plugin } = await mount();
    // Excalidraw present: its item still needs a note, as the command's own check does (`snapshot()` is null without one).
    plugin.excalidraw = true;
    await view.setState({}, { history: false } satisfies ViewStateResult);
    await settle();
    expect(view.file).toBeNull();
    expect(await open()).toEqual(ENTRIES);
    for (const title of ENTRIES.filter(entry => entry !== SEPARATOR)) expect(disabled(item(title)), title).toBe(true);
  });

  it('on the virtual root of a note without a heading, disables the sibling, the title and the deletion the keys would refuse, and keeps the rest', async () => {
    const { open, item, view } = await mount('Fixtures/list-only.md', '---\nmappy: true\n---\n- 項目 A\n  - 項目 A の子\n- 項目 B\n');
    expect(view.containerEl.querySelector<HTMLElement>('.mappy-node.is-selected')?.dataset.nodeId).toBe('root');
    await open();
    for (const title of ['兄弟を追加（Enter）', 'テキストを編集（F2）', '削除（Delete）']) expect(disabled(item(title)), title).toBe(true);
    for (const title of ['子を追加（Tab）', 'トピックを追加', '本文・リンクを編集', '画像を追加', '折りたたみ（Space）']) expect(disabled(item(title)), title).toBe(false);
  });

  it('folds the node selected when the entry is chosen, not the one selected when the menu opened', async () => {
    const { open, choose, select, node, app, file, source } = await mount();
    select('記録する');
    await open();
    // The selected node is removed outside while the menu is open: after the refresh its id is gone and the map selects the body root instead.
    app.put(file.path, source().replace('- 記録する\n  - ふりかえる\n', ''));
    await new Promise(resolve => setTimeout(resolve, 80));
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(() => node('記録する')).toThrow();
    expect(node('講座の本体').classList.contains('is-selected')).toBe(true);
    expect(document.querySelectorAll('.menu')).toHaveLength(1);
    await choose('折りたたみ（Space）');
    expect(node('講座の本体').classList.contains('is-collapsed')).toBe(true);
    expect(() => node('回復する')).toThrow();
  });

  it('switches to Markdown and opens the split with the same calls the buttons made', async () => {
    const { view, open, choose } = await mount();
    const shown = vi.spyOn(view, 'showSource').mockResolvedValue();
    await open();
    await choose('Markdown に切り替え');
    await open();
    await choose('左に Markdown を開く');
    expect(shown.mock.calls).toEqual([[false], [true]]);
  });

  it('adds a sibling, a child and deletes with the same diff as Enter, Tab and Delete, one history step each', async () => {
    const mounted = await mount();
    const { select, open, choose, key, settle, editor, source, undo } = mounted;
    const original = source();
    /** Run one edit on the selected node, read the note, and take the edit back; a new node's editor is cancelled first. */
    const edited = async (title: string, act: (target: HTMLElement) => Promise<void>): Promise<string> => {
      await act(select('睡眠'));
      const result = source();
      expect(result, title).not.toBe(original);
      if (title !== '削除（Delete）') {
        // As with the key, the new empty node is named in place.
        expect(editor()?.value, title).toBe('');
        key(editor() as HTMLTextAreaElement, 'Escape');
        await settle();
      } else expect(editor(), title).toBeNull();
      await undo();
      expect(source(), title).toBe(original);
      return result;
    };
    for (const [title, name] of [['兄弟を追加（Enter）', 'Enter'], ['子を追加（Tab）', 'Tab'], ['削除（Delete）', 'Delete']] as const) {
      const byMenu = await edited(title, async () => { await open(); await choose(title); });
      const byKey = await edited(title, async target => { key(target, name); await settle(); });
      expect(byMenu, title).toBe(byKey);
    }
  });

  it('adds a free topic at the end of the note without a stored position, named in place, and Undo removes it', async () => {
    const { open, choose, source, editor, key, settle, undo, view } = await mount();
    const original = source();
    await open();
    await choose('トピックを追加');
    expect(source()).toBe(`${original}\n## \n`);
    expect(editor()?.value).toBe('');
    const input = editor() as HTMLTextAreaElement;
    input.value = '新しい話題';
    key(input, 'Enter');
    await settle();
    expect(source()).toBe(`${original}\n## 新しい話題\n`);
    // No point was pressed, so no `mappy-topics` entry: the topic takes the default place.
    expect(source().includes('新しい話題:')).toBe(false);
    expect(view.snapshot()?.document?.nodes.some(node => node.title === '新しい話題')).toBe(true);
    await undo();
    expect(source()).toBe(`${original}\n## \n`);
    await undo();
    expect(source()).toBe(original);
  });

  it('edits the title, the body and folds the selected node as F2, the context menu and Space do', async () => {
    const { open, choose, editor, key, settle, node, select, source } = await mount();
    select('回復する');
    await open();
    await choose('テキストを編集（F2）');
    expect(editor()?.value).toBe('回復する');
    key(editor() as HTMLTextAreaElement, 'Escape');
    await settle();
    expect(editor()).toBeNull();
    await open();
    await choose('本文・リンクを編集');
    const body = document.querySelector<HTMLTextAreaElement>('.modal .mappy-edit-input');
    expect(body?.value).toBe('参考: [[heading-document#回復する|回復]]\n');
    document.querySelector<HTMLElement>('.modal-close-button')?.click();
    const before = source();
    await open();
    await choose('折りたたみ（Space）');
    expect(node('回復する').classList.contains('is-collapsed')).toBe(true);
    expect(() => node('睡眠')).toThrow();
    expect(source()).toBe(before);
    await open();
    await choose('折りたたみ（Space）');
    expect(node('回復する').classList.contains('is-collapsed')).toBe(false);
    expect(node('睡眠')).toBeDefined();
  });

  it('opens the image chooser for the selected node', async () => {
    const { view, open, choose, select } = await mount();
    select('睡眠');
    const clicked = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    await open();
    await choose('画像を追加');
    const input = view.containerEl.querySelector<HTMLInputElement>('input[type="file"].mappy-file-input');
    expect(input?.getAttribute('accept')).toBe('image/*');
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('converts a headings note to the list form, enabled only there, with the same result as the command', async () => {
    const { open, item, choose, source, view } = await mount(HEADINGS_PATH, HEADINGS_SOURCE);
    await open();
    expect(disabled(item('リスト形式に変更'))).toBe(false);
    await choose('リスト形式に変更');
    expect(source()).toBe('---\nmappy: true\n---\n## 講座\n\n- 第 1 章\n\n  本文。\n\n- 第 2 章\n');
    expect(Notice.log).toContain('H2 とリストの形式に変更しました。元に戻す操作で復元できます。');
    expect(view.snapshot()?.document?.format).toBe('list');
    await open();
    expect(disabled(item('リスト形式に変更'))).toBe(true);
  });

  it('undoes and redoes through the shared history entries, enabled as the history allows', async () => {
    const { open, item, choose, select, source, editor, key, settle } = await mount();
    const original = source();
    await open();
    expect(disabled(item('元に戻す'))).toBe(true);
    expect(disabled(item('やり直す'))).toBe(true);
    key(select('睡眠'), 'Delete');
    await settle();
    expect(editor()).toBeNull();
    const deleted = source();
    expect(deleted).not.toBe(original);
    await open();
    expect(disabled(item('元に戻す'))).toBe(false);
    expect(disabled(item('やり直す'))).toBe(true);
    await choose('元に戻す');
    expect(source()).toBe(original);
    await open();
    expect(disabled(item('やり直す'))).toBe(false);
    await choose('やり直す');
    expect(source()).toBe(deleted);
  });
});
