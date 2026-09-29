// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, Plugin } from 'obsidian';
import { installObsidianDom } from '../browser-harness/dom';
import { Notice, PluginSettingTab as MockSettingTab, type PluginSettingTab as HarnessSettingTab } from '../browser-harness/obsidian';
import { LAYOUT_MODES, layoutLabel } from '../../src/core/layout-mode';
import { DEFAULT_SETTINGS, MAP_THEMES, type MappySettings } from '../../src/obsidian/settings';
import { MappySettingTab, themeLabel } from '../../src/obsidian/settings-tab';

// The browser-harness stand-in for `obsidian`: Setting, DropdownComponent, TextComponent, ToggleComponent and PluginSettingTab on a real DOM.
vi.mock('obsidian', () => import('../browser-harness/obsidian'));

beforeAll(() => { installObsidianDom(); });
afterEach(() => { document.body.replaceChildren(); Notice.log.length = 0; });

const NAMES = ['テーマ', '新規マップの既定レイアウト', '新規マップの作成先フォルダ', '左下に表示するレイアウト'];
const ALL_LAYOUTS = [...LAYOUT_MODES];
/** DEFAULT_SETTINGS.visibleLayouts: everything but the balanced map (LEV-257). */
const DEFAULT_LAYOUTS = ['mindmap', 'timeline', 'hierarchy'];

/** The store as the plugin keeps it (src/main.ts `saveSettings`): the new value is current at once, and put back when `saveData` fails. */
function mount(initial: MappySettings = DEFAULT_SETTINGS, saving: (next: MappySettings) => Promise<void> = () => Promise.resolve()) {
  let settings = initial;
  const save = vi.fn((next: MappySettings) => {
    const previous = settings;
    settings = next;
    return saving(next).catch((error: unknown) => { if (settings === next) settings = previous; throw error; });
  });
  // Anything that could touch a note, so the test can assert the tab never does.
  const app = {
    vault: { process: vi.fn(), modify: vi.fn(), create: vi.fn(), createFolder: vi.fn() },
    fileManager: { processFrontMatter: vi.fn() },
  };
  const tab = new MappySettingTab(app as unknown as App, {} as Plugin, { current: () => settings, save });
  document.body.append(tab.containerEl);
  tab.display();
  return { app, tab, save, settings: () => settings, ...controls(tab.containerEl) };
}

/** The rendered controls, whichever path (display() or the 1.13 flow) drew them. */
function controls(container: HTMLElement) {
  const items = Array.from(container.querySelectorAll<HTMLElement>('.setting-item'));
  const selects = Array.from(container.querySelectorAll<HTMLSelectElement>('select'));
  const [theme, layout] = selects;
  const folder = container.querySelector<HTMLInputElement>('input[type="text"]');
  if (!theme || !layout || !folder) throw new Error('The tab did not render its dropdowns and text field');
  const toggles = Object.fromEntries(LAYOUT_MODES.map(mode => {
    const toggle = container.querySelector<HTMLElement>(`.mappy-setting-layouts .checkbox-container[aria-label="${layoutLabel(mode)}"]`);
    if (!toggle) throw new Error(`No toggle for ${mode}`);
    return [mode, toggle];
  })) as Record<(typeof LAYOUT_MODES)[number], HTMLElement>;
  const note = container.querySelector<HTMLElement>('.mappy-setting-note');
  if (!note) throw new Error('The layout row has no note line');
  return { items, theme, layout, folder, toggles, note };
}

function change(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** A click on Obsidian's toggle: the inner checkbox flips and its change event reaches the toggle. */
function click(toggle: HTMLElement): void {
  toggle.dispatchEvent(new Event('change', { bubbles: true }));
}

function on(toggle: HTMLElement): boolean { return toggle.classList.contains('is-enabled'); }

function locked(toggle: HTMLElement): boolean { return toggle.classList.contains('is-disabled'); }

/** Let a save settle: the store's promise, the tab's refresh after it, and a revert after a failure. */
function flush(): Promise<void> { return new Promise(resolve => setTimeout(resolve, 0)); }

describe('MappySettingTab', () => {
  it('renders exactly four settings, showing the stored values', () => {
    const { items, theme, layout, folder, toggles } = mount({ theme: 'dark', defaultLayout: 'timeline', newMapFolder: 'Maps', visibleLayouts: ['mindmap', 'balanced'] });
    expect(items).toHaveLength(4);
    expect(items.map(item => item.querySelector('.setting-item-name')?.textContent)).toEqual(NAMES);
    expect(theme.value).toBe('dark');
    expect(layout.value).toBe('timeline');
    expect(folder.value).toBe('Maps');
    expect(LAYOUT_MODES.map(mode => on(toggles[mode]))).toEqual([true, false, false, true]);
  });

  it('lists the layouts from LAYOUT_MODES, in that order, and the themes from MAP_THEMES', () => {
    const { theme, layout, tab } = mount();
    expect(Array.from(layout.options, option => option.value)).toEqual(ALL_LAYOUTS);
    expect(Array.from(layout.options, option => option.text)).toEqual(LAYOUT_MODES.map(layoutLabel));
    expect(Array.from(theme.options, option => option.value)).toEqual([...MAP_THEMES]);
    expect(Array.from(theme.options, option => option.text)).toEqual(MAP_THEMES.map(themeLabel));
    expect(theme.value).toBe('follow');
    expect(layout.value).toBe('mindmap');
    // The toggles carry the same names, in the same order, each next to its label text.
    const row = Array.from(tab.containerEl.querySelectorAll<HTMLElement>('.mappy-setting-layout'));
    expect(row.map(item => item.querySelector('span')?.textContent)).toEqual(LAYOUT_MODES.map(layoutLabel));
    expect(row.map(item => item.querySelector('.checkbox-container')?.getAttribute('aria-label'))).toEqual(LAYOUT_MODES.map(layoutLabel));
  });

  it('saves one changed field at a time and leaves the others as they were', async () => {
    const { save, theme, layout, folder, toggles, settings } = mount();
    change(layout, 'hierarchy');
    expect(save).toHaveBeenLastCalledWith({ theme: 'follow', defaultLayout: 'hierarchy', newMapFolder: '', visibleLayouts: DEFAULT_LAYOUTS });
    change(theme, 'light');
    expect(save).toHaveBeenLastCalledWith({ theme: 'light', defaultLayout: 'hierarchy', newMapFolder: '', visibleLayouts: DEFAULT_LAYOUTS });
    type(folder, ' Maps/2026 ');
    expect(save).toHaveBeenLastCalledWith({ theme: 'light', defaultLayout: 'hierarchy', newMapFolder: 'Maps/2026', visibleLayouts: DEFAULT_LAYOUTS });
    // The input keeps what was typed; only the stored value is trimmed.
    expect(folder.value).toBe(' Maps/2026 ');
    click(toggles.timeline);
    expect(save).toHaveBeenLastCalledWith({ theme: 'light', defaultLayout: 'hierarchy', newMapFolder: 'Maps/2026', visibleLayouts: ['mindmap', 'hierarchy'] });
    await flush();
    expect(settings()).toEqual({ theme: 'light', defaultLayout: 'hierarchy', newMapFolder: 'Maps/2026', visibleLayouts: ['mindmap', 'hierarchy'] });
    expect(save).toHaveBeenCalledTimes(4);
  });

  it('never writes to the vault or to any frontmatter, whatever is changed', () => {
    const { app, save, theme, layout, folder, toggles } = mount();
    change(theme, 'dark');
    change(layout, 'timeline');
    type(folder, 'Maps');
    click(toggles.balanced);
    expect(save).toHaveBeenCalledTimes(4);
    expect(app.vault.process).not.toHaveBeenCalled();
    expect(app.vault.modify).not.toHaveBeenCalled();
    expect(app.vault.create).not.toHaveBeenCalled();
    expect(app.vault.createFolder).not.toHaveBeenCalled();
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
  });

  it('describes the same four settings declaratively for Obsidian 1.13+, layouts in LAYOUT_MODES order, the last row rendering itself', () => {
    const { tab } = mount();
    const definitions = tab.getSettingDefinitions();
    expect(definitions.map(definition => definition.name)).toEqual(NAMES);
    expect(definitions.map(definition => definition.control?.key)).toEqual(['theme', 'defaultLayout', 'newMapFolder', undefined]);
    expect(definitions.map(definition => definition.control?.type)).toEqual(['dropdown', 'dropdown', 'text', undefined]);
    const [theme, layout, folder, layouts] = definitions;
    expect(theme?.control?.type === 'dropdown' && Object.keys(theme.control.options)).toEqual([...MAP_THEMES]);
    expect(layout?.control?.type === 'dropdown' && Object.entries(layout.control.options)).toEqual(LAYOUT_MODES.map(mode => [mode, layoutLabel(mode)]));
    expect(definitions.slice(0, 3).map(definition => definition.control?.defaultValue)).toEqual([DEFAULT_SETTINGS.theme, DEFAULT_SETTINGS.defaultLayout, DEFAULT_SETTINGS.newMapFolder]);
    expect(folder?.control?.type === 'text' && folder.control.placeholder).toBe('例: Maps');
    expect(typeof layouts?.render).toBe('function');
    // display() renders exactly these, so both Obsidian generations show the same tab.
    expect(Array.from(tab.containerEl.querySelectorAll('.setting-item-name'), item => item.textContent)).toEqual(definitions.map(definition => definition.name));
  });

  it('survives Obsidian 1.13+\'s addSettingTab → update() → render flow: four items stored, no save, no fallback to display()', () => {
    const { tab, save } = mount();
    // The 1.8.7 types know nothing of the 1.13 members; the mock models them (tests/browser-harness/obsidian.ts).
    const runtime = tab as unknown as HarnessSettingTab;
    // update() is the base class's own method (app.js 1.14.2); a subclass member of that name would shadow it.
    runtime.update();
    expect(runtime.settingItems).toHaveLength(4);
    expect(save).not.toHaveBeenCalled();
    // The declarative renderer replaces what display() drew: dropdowns and text through the bindings, the last row through its render().
    runtime.renderTab();
    expect(tab.containerEl.querySelectorAll('.setting-item')).toHaveLength(4);
    // update() while the tab is open renders again; Obsidian tears the rows down first, and so does the mock.
    runtime.update();
    runtime.renderTab();
    expect(tab.containerEl.querySelectorAll('.setting-item')).toHaveLength(4);
    expect(tab.containerEl.querySelectorAll('.mappy-setting-note')).toHaveLength(1);
    expect(tab.containerEl.querySelectorAll('.mappy-setting-layouts .checkbox-container')).toHaveLength(4);
    // Every other name SettingTab / PluginSettingTab own in app.js 1.14.2 (fields set in their constructors and the
    // renderer's methods): the types are pinned to 1.8.7, so this list is the only check that none is shadowed.
    const methods = ['update', 'hide', 'renderTab', 'getControlBinding', 'refreshDomState', 'getElementForDefinition', 'getDefinitionForElement'];
    for (const name of methods) expect(Object.getOwnPropertyNames(MappySettingTab.prototype)).not.toContain(name);
    const fields = ['settingItems', 'renderedItems', 'setting', 'navEl', 'name', 'id', 'icon', 'app', 'plugin', 'containerEl'];
    const base = new (class extends MockSettingTab { display(): void { /* nothing */ } })(tab.app, {});
    const own = Object.keys(tab).filter(key => !(key in base));
    for (const name of fields) expect(own).not.toContain(name);
  });

  it('draws the layout row the same way through the 1.13 declarative path, saving, locking and noting through the same code', async () => {
    const { tab, save } = mount({ ...DEFAULT_SETTINGS, defaultLayout: 'hierarchy' });
    const runtime = tab as unknown as HarnessSettingTab;
    runtime.update();
    runtime.renderTab();
    const { toggles, note, layout } = controls(tab.containerEl);
    expect(LAYOUT_MODES.map(mode => on(toggles[mode]))).toEqual([true, true, true, false]);
    expect(LAYOUT_MODES.map(mode => locked(toggles[mode]))).toEqual([true, false, true, false]);
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain('階層図');
    click(toggles.hierarchy);
    expect(save).not.toHaveBeenCalled();
    // The dropdown goes through the binding (setControlValue): a hidden layout chosen as the default is shown in the same save.
    change(layout, 'balanced');
    expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, defaultLayout: 'balanced', visibleLayouts: ALL_LAYOUTS });
    await flush();
    expect(LAYOUT_MODES.map(mode => on(toggles[mode]))).toEqual([true, true, true, true]);
    expect(LAYOUT_MODES.map(mode => locked(toggles[mode]))).toEqual([true, false, false, true]);
    expect(note.textContent).toContain('左右バランス');
    change(layout, 'mindmap');
    await flush();
    expect(note.hidden).toBe(true);
    // hide() runs the row's cleanup; a later save no longer touches the dropped elements.
    runtime.hide();
    change(layout, 'timeline');
    await flush();
    expect(note.hidden).toBe(true);
    expect(locked(toggles.timeline)).toBe(false);
  });

  it('reads and writes the controls through the store, trimming the folder and refusing unusable values', async () => {
    const { tab, save, app } = mount({ theme: 'light', defaultLayout: 'timeline', newMapFolder: 'Maps', visibleLayouts: ALL_LAYOUTS });
    expect(tab.getControlValue('theme')).toBe('light');
    expect(tab.getControlValue('defaultLayout')).toBe('timeline');
    expect(tab.getControlValue('newMapFolder')).toBe('Maps');
    expect(tab.getControlValue('visibleLayouts')).toEqual(ALL_LAYOUTS);
    expect(tab.getControlValue('mySetting')).toBeUndefined();
    await tab.setControlValue('defaultLayout', 'hierarchy');
    expect(save).toHaveBeenLastCalledWith({ theme: 'light', defaultLayout: 'hierarchy', newMapFolder: 'Maps', visibleLayouts: ALL_LAYOUTS });
    await tab.setControlValue('newMapFolder', '  Maps/2026 ');
    expect(save).toHaveBeenLastCalledWith({ theme: 'light', defaultLayout: 'hierarchy', newMapFolder: 'Maps/2026', visibleLayouts: ALL_LAYOUTS });
    // The list is normalized on the way in: order, no repeats, and the regular map and the default layout whether or not they were named.
    await tab.setControlValue('visibleLayouts', ['balanced', 'timeline', 'balanced']);
    expect(save).toHaveBeenLastCalledWith({ theme: 'light', defaultLayout: 'hierarchy', newMapFolder: 'Maps/2026', visibleLayouts: ALL_LAYOUTS });
    await tab.setControlValue('theme', 'system');
    await tab.setControlValue('defaultLayout', 'issue-tree');
    await tab.setControlValue('newMapFolder', 42);
    await tab.setControlValue('visibleLayouts', 'timeline');
    await tab.setControlValue('mySetting', 'x');
    expect(save).toHaveBeenCalledTimes(3);
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
  });

  it('re-renders from the current settings without duplicating items, and ignores a value the dropdown cannot hold', () => {
    const { tab, save } = mount({ theme: 'follow', defaultLayout: 'timeline', newMapFolder: '', visibleLayouts: ALL_LAYOUTS });
    tab.display();
    expect(tab.containerEl.querySelectorAll('.setting-item')).toHaveLength(4);
    expect(tab.containerEl.querySelectorAll('.mappy-setting-layouts .checkbox-container')).toHaveLength(4);
    const [theme, layout] = Array.from(tab.containerEl.querySelectorAll<HTMLSelectElement>('select'));
    if (!theme || !layout) throw new Error('The re-rendered tab has no dropdowns');
    expect(layout.value).toBe('timeline');
    // A select cannot take an unknown value: jsdom leaves it empty, and the tab saves nothing for it.
    change(layout, 'issue-tree');
    change(theme, 'system');
    expect(save).not.toHaveBeenCalled();
  });
});

describe('MappySettingTab: 左下に表示するレイアウト', () => {
  it('shows one toggle per layout, the balanced map off by default (LEV-257), with the regular map on and locked', () => {
    const { toggles, note } = mount();
    expect(LAYOUT_MODES.map(mode => on(toggles[mode]))).toEqual([true, true, true, false]);
    expect(LAYOUT_MODES.map(mode => locked(toggles[mode]))).toEqual([true, false, false, false]);
    expect(note.hidden).toBe(true);
  });

  it('cannot turn the regular map off: a click on its toggle saves nothing and leaves it on', () => {
    const { toggles, save } = mount();
    click(toggles.mindmap);
    toggles.mindmap.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(on(toggles.mindmap)).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('turns a layout off and on again, saving the list in LAYOUT_MODES order each time', async () => {
    const { toggles, save, settings } = mount();
    click(toggles.timeline);
    expect(on(toggles.timeline)).toBe(false);
    expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, visibleLayouts: ['mindmap', 'hierarchy'] });
    click(toggles.balanced);
    expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, visibleLayouts: ['mindmap', 'hierarchy', 'balanced'] });
    click(toggles.timeline);
    expect(on(toggles.timeline)).toBe(true);
    // Re-adding timeline after balanced was added still yields LAYOUT_MODES order, not click order.
    expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, visibleLayouts: ALL_LAYOUTS });
    await flush();
    expect(settings().visibleLayouts).toEqual(ALL_LAYOUTS);
    expect(settings().theme).toBe('follow');
    expect(settings().defaultLayout).toBe('mindmap');
  });

  it('locks the default layout on, naming it under the toggles; neither its toggle nor its text saves anything (LEV-257)', () => {
    const { tab, toggles, note, save } = mount({ ...DEFAULT_SETTINGS, defaultLayout: 'timeline' });
    expect(LAYOUT_MODES.map(mode => locked(toggles[mode]))).toEqual([true, true, false, false]);
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe('「タイムライン」は新規マップの既定レイアウトなので外せません。');
    click(toggles.timeline);
    toggles.timeline.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    tab.containerEl.querySelectorAll<HTMLElement>('.mappy-setting-layout > span')[1]?.click();
    expect(on(toggles.timeline)).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('choosing a hidden layout as the default shows it in the same save, and frees the previous default', async () => {
    const { toggles, layout, note, save, settings } = mount({ ...DEFAULT_SETTINGS, defaultLayout: 'timeline' });
    change(layout, 'balanced');
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, defaultLayout: 'balanced', visibleLayouts: ALL_LAYOUTS });
    await flush();
    expect(on(toggles.balanced)).toBe(true);
    expect(LAYOUT_MODES.map(mode => locked(toggles[mode]))).toEqual([true, false, false, true]);
    expect(note.textContent).toBe('「左右バランス」は新規マップの既定レイアウトなので外せません。');
    // The previous default can be turned off now; the new one stays.
    click(toggles.timeline);
    await flush();
    expect(settings().visibleLayouts).toEqual(['mindmap', 'hierarchy', 'balanced']);
    // Back to the regular map: nothing but it is locked, and the note goes away.
    change(layout, 'mindmap');
    await flush();
    expect(settings()).toEqual({ ...DEFAULT_SETTINGS, visibleLayouts: ['mindmap', 'hierarchy', 'balanced'] });
    expect(LAYOUT_MODES.map(mode => locked(toggles[mode]))).toEqual([true, false, false, false]);
    expect(note.hidden).toBe(true);
    expect(note.textContent).toBe('');
  });

  it('keeps the toggles as they were when the default layout cannot be saved', async () => {
    const { toggles, layout, settings } = mount(DEFAULT_SETTINGS, () => Promise.reject(new Error('data.json は書き込めません')));
    change(layout, 'balanced');
    await flush();
    expect(settings()).toEqual(DEFAULT_SETTINGS);
    expect(LAYOUT_MODES.map(mode => on(toggles[mode]))).toEqual([true, true, true, false]);
    expect(LAYOUT_MODES.map(mode => locked(toggles[mode]))).toEqual([true, false, false, false]);
    expect(Notice.log).toEqual(['data.json は書き込めません']);
  });

  it('flips a toggle from its text too, except the locked regular map', () => {
    const { tab, toggles, save } = mount();
    const labels = Array.from(tab.containerEl.querySelectorAll<HTMLElement>('.mappy-setting-layout > span'));
    labels[1]?.click();
    expect(on(toggles.timeline)).toBe(false);
    expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, visibleLayouts: ['mindmap', 'hierarchy'] });
    labels[1]?.click();
    expect(on(toggles.timeline)).toBe(true);
    expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, visibleLayouts: DEFAULT_LAYOUTS });
    labels[0]?.click();
    expect(on(toggles.mindmap)).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('puts a toggle back when the save fails, so the next change starts from what is really stored', async () => {
    let fail = true;
    const { toggles, save, settings } = mount(DEFAULT_SETTINGS, () => fail ? Promise.reject(new Error('data.json は書き込めません')) : Promise.resolve());
    click(toggles.timeline);
    expect(on(toggles.timeline)).toBe(false);
    await flush();
    // The store still has the old list; the toggle shows it again and the failure is reported once.
    expect(on(toggles.timeline)).toBe(true);
    expect(settings().visibleLayouts).toEqual(DEFAULT_LAYOUTS);
    expect(Notice.log).toEqual(['data.json は書き込めません']);
    // Putting it back did not start another save (the store already says "visible").
    expect(save).toHaveBeenCalledTimes(1);
    fail = false;
    click(toggles.balanced);
    // Computed from the stored list, so timeline stays in it.
    expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, visibleLayouts: ALL_LAYOUTS });
    await flush();
    expect(settings().visibleLayouts).toEqual(ALL_LAYOUTS);
    expect(on(toggles.balanced)).toBe(true);
    expect(Notice.log).toHaveLength(1);
  });

  it('leaves a detached note alone after the tab was hidden, on both paths', async () => {
    const { tab, layout, note } = mount({ ...DEFAULT_SETTINGS, visibleLayouts: ['mindmap'] });
    // display() path: hide() empties the container; a save resolving afterwards must not write into the dropped row.
    change(layout, 'timeline');
    (tab as unknown as HarnessSettingTab).hide();
    await flush();
    expect(note.isConnected).toBe(false);
    expect(note.hidden).toBe(true);
    expect(note.textContent).toBe('');
  });
});
