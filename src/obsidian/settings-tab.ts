import { Notice, PluginSettingTab, Setting, ToggleComponent, type App, type Plugin } from 'obsidian';
import { LAYOUT_MODES, layoutLabel, type LayoutMode } from '../core/layout-mode';
import {
  DEFAULT_SETTINGS, MAP_THEMES, isSettingKey, readSettingField, showDefaultLayout, type MapTheme, type MappySettings, type SettingKey,
} from './settings';
import { t } from '../i18n';

/** The text key of each theme's name; the Record type turns a new theme into a compile error until it is named. */
const THEME_LABEL_KEYS: Record<MapTheme, `theme${Capitalize<MapTheme>}`> = { follow: 'themeFollow', light: 'themeLight', dark: 'themeDark' };

/** Each theme's name in the dropdown, read when the tab is drawn (the names follow the app's language, src/i18n). */
export function themeLabel(theme: MapTheme): string {
  return t()[THEME_LABEL_KEYS[theme]];
}

/** One drawn「左下に表示するレイアウト」row. */
interface LayoutRow { toggles: Map<LayoutMode, ToggleComponent>; note: HTMLElement }

/** The plugin owns the settings object and `saveData`; the tab only reads and asks for a save. */
export interface SettingsStore {
  current(): MappySettings;
  save(next: MappySettings): Promise<void>;
}

/** The settings a dropdown or text control can hold: the ones stored as one string. */
type TextSettingKey = { [K in SettingKey]: MappySettings[K] extends string ? K : never }[SettingKey];

/**
 * One setting as Obsidian 1.13's declarative settings API describes it: the subset of
 * `SettingDefinition` with a `dropdown` or `text` control, or a `render` callback that draws the
 * row itself, copied from obsidian.d.ts 1.13.1 because the API types stay pinned to 1.8.7
 * (docs/harness.md). Obsidian 1.13+ renders these through `getSettingDefinitions()` /
 * `getControlValue()` / `setControlValue()` (calling `render` with the row's `Setting` once its
 * name and description are set), which also puts them in its settings search; earlier versions
 * call `display()`, which builds the same rows from this list. Either way the note is never
 * touched: only `loadData` / `saveData` change.
 *
 * With the types pinned, nothing checks these overrides against the 1.13 base class, so no
 * other member of this class may use a `SettingTab` name (`update`, `settingItems`, `hide`, …).
 */
export type MapSettingDefinition =
  | {
    name: string;
    desc: string;
    control:
      | { type: 'dropdown'; key: TextSettingKey; options: Record<string, string>; defaultValue: string }
      | { type: 'text'; key: TextSettingKey; placeholder: string; defaultValue: string };
    render?: never;
  }
  | { name: string; desc: string; control?: never; render: (setting: Setting) => void | (() => void) };

function options<K extends string>(keys: readonly K[], label: (key: K) => string): Record<string, string> {
  return Object.fromEntries(keys.map(key => [key, label(key)]));
}

/** The four settings, in the order the tab shows them; the layout lists follow LAYOUT_MODES. */
export function mapSettingDefinitions(renderLayouts: (setting: Setting) => void | (() => void)): MapSettingDefinition[] {
  const text = t();
  return [
    {
      name: text.setTheme,
      desc: text.setThemeDesc,
      control: { type: 'dropdown', key: 'theme', options: options(MAP_THEMES, themeLabel), defaultValue: DEFAULT_SETTINGS.theme },
    },
    {
      name: text.setDefaultLayout,
      desc: text.setDefaultLayoutDesc(text.cmdCreateMap, text.cmdConvertNote),
      control: { type: 'dropdown', key: 'defaultLayout', options: options(LAYOUT_MODES, layoutLabel), defaultValue: DEFAULT_SETTINGS.defaultLayout },
    },
    {
      name: text.setFolder,
      desc: text.setFolderDesc,
      control: { type: 'text', key: 'newMapFolder', placeholder: text.setFolderPlaceholder, defaultValue: DEFAULT_SETTINGS.newMapFolder },
    },
    {
      name: text.setLayouts,
      desc: text.setLayoutsDesc,
      render: renderLayouts,
    },
  ];
}

export class MappySettingTab extends PluginSettingTab {
  /**
   * Each drawn layout row: its toggles and the line under them naming the locked default layout.
   * More than one can be drawn at once (1.13+ draws the row for the tab and again for a settings
   * search result). Added by the row's render, dropped by its cleanup (1.13+) or the next
   * `display()`; a save that resolves after the tab was hidden finds a row detached and leaves it alone.
   */
  private readonly layoutRows = new Set<LayoutRow>();

  constructor(app: App, plugin: Plugin, private readonly store: SettingsStore) { super(app, plugin); }

  /** Obsidian 1.13+: the declarative path (rendering and settings search). */
  getSettingDefinitions(): MapSettingDefinition[] {
    return mapSettingDefinitions(setting => this.renderLayoutToggles(setting));
  }

  getControlValue(key: string): unknown {
    return isSettingKey(key) ? this.store.current()[key] : undefined;
  }

  /**
   * A value the control cannot hold (or a key that is not a setting) is not saved. A hidden layout
   * chosen as the default is shown in the same save, so the pair is never stored apart. When the
   * save settles either way, the layout rows are drawn again from what is stored: after a failure
   * that is the value the store put back, whichever path (a toggle, the 1.13 binding) asked.
   */
  setControlValue(key: string, value: unknown): Promise<void> {
    if (!isSettingKey(key)) return Promise.resolve();
    const accepted = readSettingField(key, value);
    if (accepted === null) return Promise.resolve();
    const saved = this.store.save(showDefaultLayout({ ...this.store.current(), [key]: accepted }));
    if (key !== 'defaultLayout' && key !== 'visibleLayouts') return saved;
    // A row left behind by display() (the tab hidden meanwhile) is detached and left alone.
    const sync = (): void => { for (const row of this.layoutRows) if (row.note.isConnected) this.syncLayoutRow(row); };
    return saved.then(sync, (error: unknown) => { sync(); throw error; });
  }

  /** Obsidian before 1.13: the same four settings, built by hand. `hide` is a base name, so the previous row's note is let go here. */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.layoutRows.clear();
    const settings = this.store.current();
    for (const definition of this.getSettingDefinitions()) {
      const setting = new Setting(containerEl).setName(definition.name).setDesc(definition.desc);
      if (definition.render) { definition.render(setting); continue; }
      const { control } = definition;
      const value = settings[control.key];
      if (control.type === 'dropdown') {
        setting.addDropdown(dropdown => {
          // A failed save puts the dropdown back too, so it never names a default the toggles do not lock.
          dropdown.addOptions(control.options).setValue(value).onChange(next => {
            this.commit(control.key, next, () => { dropdown.setValue(this.store.current()[control.key]); });
          });
        });
      } else {
        setting.addText(text => {
          text.setPlaceholder(control.placeholder).setValue(value).onChange(next => { this.commit(control.key, next); });
        });
      }
    }
  }

  /**
   * The bottom-left bar's buttons as four toggles on one row: the regular map and the default layout
   * are on and cannot be changed (the line under them names the default), the others save through
   * the same reader as the data file, so the stored list stays normalized. Each toggle's text flips
   * it too, as a setting row's name does.
   */
  private renderLayoutToggles(setting: Setting): () => void {
    const list = setting.controlEl.createDiv({ cls: 'mappy-setting-layouts' });
    const toggles = new Map<LayoutMode, ToggleComponent>();
    for (const mode of LAYOUT_MODES) {
      const item = list.createDiv({ cls: 'mappy-setting-layout' });
      const name = layoutLabel(mode);
      const label = item.createSpan({ text: name });
      const toggle = new ToggleComponent(item).setTooltip(name);
      toggles.set(mode, toggle);
      label.addEventListener('click', () => { if (!toggle.disabled) toggle.setValue(!toggle.getValue()); });
      toggle.onChange(on => {
        const current = this.store.current().visibleLayouts;
        // Already so: the toggle was put back after a failed save, synced to the store, or the store changed under it.
        if (on === current.includes(mode)) return;
        const others = current.filter(other => other !== mode);
        // A failed save needs no revert here: setControlValue draws every row again from the store.
        this.commit('visibleLayouts', on ? [...others, mode] : others);
      });
    }
    const row: LayoutRow = { toggles, note: setting.descEl.createDiv({ cls: 'mappy-setting-note' }) };
    this.layoutRows.add(row);
    // Drawn whether or not the row is in the document yet: a row built before it is attached still starts right.
    this.syncLayoutRow(row);
    return () => { this.layoutRows.delete(row); };
  }

  /** Show the stored list and lock the regular map and the default layout; called on render and after each save. */
  private syncLayoutRow(row: LayoutRow): void {
    const { defaultLayout, visibleLayouts } = this.store.current();
    for (const [mode, toggle] of row.toggles) {
      toggle.setDisabled(mode === 'mindmap' || mode === defaultLayout);
      toggle.setValue(visibleLayouts.includes(mode));
    }
    const named = defaultLayout !== 'mindmap';
    row.note.setText(named ? t().setLockedDefault(layoutLabel(defaultLayout)) : '');
    row.note.hidden = !named;
  }

  /** Save one field; when the save fails, `revert` puts the control back to what is still stored. */
  private commit(key: SettingKey, value: unknown, revert?: () => void): void {
    this.setControlValue(key, value).catch((error: unknown) => {
      revert?.();
      new Notice(error instanceof Error ? error.message : t().setSaveFailed);
    });
  }
}
