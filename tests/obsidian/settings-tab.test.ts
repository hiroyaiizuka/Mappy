// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, Plugin } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { LAYOUT_MODES } from '../../src/core/layout-mode';
import { DEFAULT_SETTINGS, MAP_THEMES, type MappySettings } from '../../src/obsidian/settings';
import { LAYOUT_LABELS, MappySettingTab, THEME_LABELS } from '../../src/obsidian/settings-tab';

// The browser-harness stand-in for `obsidian`: Setting, DropdownComponent, TextComponent and PluginSettingTab on a real DOM.
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });
afterEach(() => { document.body.replaceChildren(); });

function mount(initial: MappySettings = DEFAULT_SETTINGS) {
  let settings = initial;
  const save = vi.fn((next: MappySettings) => { settings = next; return Promise.resolve(); });
  // Anything that could touch a note, so the test can assert the tab never does.
  const app = {
    vault: { process: vi.fn(), modify: vi.fn(), create: vi.fn(), createFolder: vi.fn() },
    fileManager: { processFrontMatter: vi.fn() },
  };
  const tab = new MappySettingTab(app as unknown as App, {} as Plugin, { current: () => settings, save });
  document.body.append(tab.containerEl);
  tab.display();
  const items = Array.from(tab.containerEl.querySelectorAll<HTMLElement>('.setting-item'));
  const selects = Array.from(tab.containerEl.querySelectorAll<HTMLSelectElement>('select'));
  const [theme, layout] = selects;
  const folder = tab.containerEl.querySelector<HTMLInputElement>('input[type="text"]');
  if (!theme || !layout || !folder) throw new Error('The tab did not render its three controls');
  return { app, tab, save, items, theme, layout, folder, settings: () => settings };
}

function change(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('MappySettingTab', () => {
  it('renders exactly three settings, showing the stored values', () => {
    const { items, theme, layout, folder } = mount({ theme: 'dark', defaultLayout: 'timeline', newMapFolder: 'Maps' });
    expect(items).toHaveLength(3);
    expect(items.map(item => item.querySelector('.setting-item-name')?.textContent)).toEqual(['テーマ', '新規マップの既定レイアウト', '新規マップの作成先フォルダ']);
    expect(theme.value).toBe('dark');
    expect(layout.value).toBe('timeline');
    expect(folder.value).toBe('Maps');
  });

  it('lists the layouts from LAYOUT_MODES, in that order, and the themes from MAP_THEMES', () => {
    const { theme, layout } = mount();
    expect(Array.from(layout.options, option => option.value)).toEqual([...LAYOUT_MODES]);
    expect(Array.from(layout.options, option => option.text)).toEqual(LAYOUT_MODES.map(mode => LAYOUT_LABELS[mode]));
    expect(Array.from(theme.options, option => option.value)).toEqual([...MAP_THEMES]);
    expect(Array.from(theme.options, option => option.text)).toEqual(MAP_THEMES.map(mode => THEME_LABELS[mode]));
    expect(theme.value).toBe('follow');
    expect(layout.value).toBe('mindmap');
  });

  it('saves one changed field at a time and leaves the others as they were', async () => {
    const { save, theme, layout, folder, settings } = mount();
    change(layout, 'hierarchy');
    expect(save).toHaveBeenLastCalledWith({ theme: 'follow', defaultLayout: 'hierarchy', newMapFolder: '' });
    change(theme, 'light');
    expect(save).toHaveBeenLastCalledWith({ theme: 'light', defaultLayout: 'hierarchy', newMapFolder: '' });
    type(folder, ' Maps/2026 ');
    expect(save).toHaveBeenLastCalledWith({ theme: 'light', defaultLayout: 'hierarchy', newMapFolder: 'Maps/2026' });
    // The input keeps what was typed; only the stored value is trimmed.
    expect(folder.value).toBe(' Maps/2026 ');
    await Promise.resolve();
    expect(settings()).toEqual({ theme: 'light', defaultLayout: 'hierarchy', newMapFolder: 'Maps/2026' });
    expect(save).toHaveBeenCalledTimes(3);
  });

  it('never writes to the vault or to any frontmatter, whatever is changed', () => {
    const { app, save, theme, layout, folder } = mount();
    change(theme, 'dark');
    change(layout, 'timeline');
    type(folder, 'Maps');
    expect(save).toHaveBeenCalledTimes(3);
    expect(app.vault.process).not.toHaveBeenCalled();
    expect(app.vault.modify).not.toHaveBeenCalled();
    expect(app.vault.create).not.toHaveBeenCalled();
    expect(app.vault.createFolder).not.toHaveBeenCalled();
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
  });

  it('describes the same three settings declaratively for Obsidian 1.13+, layouts in LAYOUT_MODES order', () => {
    const { tab } = mount();
    const definitions = tab.getSettingDefinitions();
    expect(definitions.map(definition => definition.control.key)).toEqual(['theme', 'defaultLayout', 'newMapFolder']);
    expect(definitions.map(definition => definition.control.type)).toEqual(['dropdown', 'dropdown', 'text']);
    const [theme, layout, folder] = definitions;
    expect(theme?.control.type === 'dropdown' && Object.keys(theme.control.options)).toEqual([...MAP_THEMES]);
    expect(layout?.control.type === 'dropdown' && Object.entries(layout.control.options)).toEqual(LAYOUT_MODES.map(mode => [mode, LAYOUT_LABELS[mode]]));
    expect(definitions.map(definition => definition.control.defaultValue)).toEqual([DEFAULT_SETTINGS.theme, DEFAULT_SETTINGS.defaultLayout, DEFAULT_SETTINGS.newMapFolder]);
    expect(folder?.control.type === 'text' && folder.control.placeholder).toBe('例: Maps');
    // display() renders exactly these, so both Obsidian generations show the same tab.
    expect(Array.from(tab.containerEl.querySelectorAll('.setting-item-name'), item => item.textContent)).toEqual(definitions.map(definition => definition.name));
  });

  it('reads and writes the controls through the store, trimming the folder and refusing unusable values', async () => {
    const { tab, save, app } = mount({ theme: 'light', defaultLayout: 'timeline', newMapFolder: 'Maps' });
    expect(tab.getControlValue('theme')).toBe('light');
    expect(tab.getControlValue('defaultLayout')).toBe('timeline');
    expect(tab.getControlValue('newMapFolder')).toBe('Maps');
    expect(tab.getControlValue('mySetting')).toBeUndefined();
    await tab.setControlValue('defaultLayout', 'hierarchy');
    expect(save).toHaveBeenLastCalledWith({ theme: 'light', defaultLayout: 'hierarchy', newMapFolder: 'Maps' });
    await tab.setControlValue('newMapFolder', '  Maps/2026 ');
    expect(save).toHaveBeenLastCalledWith({ theme: 'light', defaultLayout: 'hierarchy', newMapFolder: 'Maps/2026' });
    await tab.setControlValue('theme', 'system');
    await tab.setControlValue('defaultLayout', 'issue-tree');
    await tab.setControlValue('newMapFolder', 42);
    await tab.setControlValue('mySetting', 'x');
    expect(save).toHaveBeenCalledTimes(2);
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
  });

  it('re-renders from the current settings without duplicating items, and ignores a value the dropdown cannot hold', () => {
    const { tab, save } = mount({ theme: 'follow', defaultLayout: 'timeline', newMapFolder: '' });
    tab.display();
    expect(tab.containerEl.querySelectorAll('.setting-item')).toHaveLength(3);
    const [theme, layout] = Array.from(tab.containerEl.querySelectorAll<HTMLSelectElement>('select'));
    if (!theme || !layout) throw new Error('The re-rendered tab has no dropdowns');
    expect(layout.value).toBe('timeline');
    // A select cannot take an unknown value: jsdom leaves it empty, and the tab saves nothing for it.
    change(layout, 'issue-tree');
    change(theme, 'system');
    expect(save).not.toHaveBeenCalled();
  });
});
