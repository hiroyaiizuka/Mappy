import { Notice, PluginSettingTab, Setting, ToggleComponent, type App, type Plugin } from 'obsidian';
import { LAYOUT_LABELS, LAYOUT_MODES } from '../core/layout-mode';
import {
  DEFAULT_SETTINGS, MAP_THEMES, isSettingKey, readSettingField, type MapTheme, type MappySettings, type SettingKey,
} from './settings';

export const THEME_LABELS: Record<MapTheme, string> = { follow: 'Obsidian に従う', light: '明色', dark: '暗色' };

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

function options<K extends string>(keys: readonly K[], labels: Record<K, string>): Record<string, string> {
  return Object.fromEntries(keys.map(key => [key, labels[key]]));
}

/** The four settings, in the order the tab shows them; the layout lists follow LAYOUT_MODES. */
export function mapSettingDefinitions(renderLayouts: (setting: Setting) => void | (() => void)): MapSettingDefinition[] {
  return [
    {
      name: 'テーマ',
      desc: 'マップの表示だけに適用します。Obsidian の埋め込みや Excalidraw への挿入は Obsidian のテーマに従います。',
      control: { type: 'dropdown', key: 'theme', options: options(MAP_THEMES, THEME_LABELS), defaultValue: DEFAULT_SETTINGS.theme },
    },
    {
      name: '新規マップの既定レイアウト',
      desc: '「新しいマインドマップを作成」と「このノートをマインドマップ化」が mappy-layout に書く値です。既存のノートの表示は変わりません。',
      control: { type: 'dropdown', key: 'defaultLayout', options: options(LAYOUT_MODES, LAYOUT_LABELS), defaultValue: DEFAULT_SETTINGS.defaultLayout },
    },
    {
      name: '新規マップの作成先フォルダ',
      desc: 'Vault からの相対パスです。空欄なら Obsidian の「新規ノートの作成場所」に従い、/ で最上位を指定します。存在しないフォルダは作成時に作ります。',
      control: { type: 'text', key: 'newMapFolder', placeholder: '例: Maps', defaultValue: DEFAULT_SETTINGS.newMapFolder },
    },
    {
      name: '左下に表示するレイアウト',
      desc: 'マップの左下に並ぶレイアウトのボタンです。通常マップは外せません。開いているノートの mappy-layout が非表示のレイアウトなら、そのノートではそのボタンも出ます。非表示にしても mappy-layout の保存・復元、コマンド、埋め込み表示、Excalidraw への挿入は変わりません。',
      render: renderLayouts,
    },
  ];
}

export class MappySettingTab extends PluginSettingTab {
  /** The line under the layout toggles about a hidden default layout, while that row is on screen. */
  private hiddenDefaultEl: HTMLElement | undefined;

  constructor(app: App, plugin: Plugin, private readonly store: SettingsStore) { super(app, plugin); }

  /** Obsidian 1.13+: the declarative path (rendering and settings search). */
  getSettingDefinitions(): MapSettingDefinition[] {
    return mapSettingDefinitions(setting => this.renderLayoutToggles(setting));
  }

  getControlValue(key: string): unknown {
    return isSettingKey(key) ? this.store.current()[key] : undefined;
  }

  /** A value the control cannot hold (or a key that is not a setting) is not saved. */
  setControlValue(key: string, value: unknown): Promise<void> {
    if (!isSettingKey(key)) return Promise.resolve();
    const accepted = readSettingField(key, value);
    if (accepted === null) return Promise.resolve();
    return this.store.save({ ...this.store.current(), [key]: accepted }).then(() => { this.refreshHiddenDefault(); });
  }

  /** Obsidian before 1.13: the same four settings, built by hand. */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.hiddenDefaultEl = undefined;
    const settings = this.store.current();
    for (const definition of this.getSettingDefinitions()) {
      const setting = new Setting(containerEl).setName(definition.name).setDesc(definition.desc);
      if (definition.render) { definition.render(setting); continue; }
      const { control } = definition;
      const value = settings[control.key];
      if (control.type === 'dropdown') {
        setting.addDropdown(dropdown => {
          dropdown.addOptions(control.options).setValue(value).onChange(next => { this.commit(control.key, next); });
        });
      } else {
        setting.addText(text => {
          text.setPlaceholder(control.placeholder).setValue(value).onChange(next => { this.commit(control.key, next); });
        });
      }
    }
  }

  /**
   * The bottom-left bar's buttons as four toggles on one row: the regular map is on and cannot be
   * changed, the others save through the same reader as the data file, so the stored list stays
   * normalized. The line under them notes a default layout that is hidden: new maps are still
   * created with it, and then show its button.
   */
  private renderLayoutToggles(setting: Setting): () => void {
    const list = setting.controlEl.createDiv({ cls: 'mappy-setting-layouts' });
    const shown = this.store.current().visibleLayouts;
    for (const mode of LAYOUT_MODES) {
      const item = list.createDiv({ cls: 'mappy-setting-layout' });
      item.createSpan({ text: LAYOUT_LABELS[mode] });
      const toggle = new ToggleComponent(item).setValue(shown.includes(mode)).setTooltip(LAYOUT_LABELS[mode]);
      if (mode === 'mindmap') { toggle.setDisabled(true); continue; }
      toggle.onChange(on => {
        const others = this.store.current().visibleLayouts.filter(other => other !== mode);
        this.commit('visibleLayouts', on ? [...others, mode] : others);
      });
    }
    this.hiddenDefaultEl = setting.descEl.createDiv({ cls: 'mappy-setting-note' });
    this.refreshHiddenDefault();
    return () => { this.hiddenDefaultEl = undefined; };
  }

  private refreshHiddenDefault(): void {
    const line = this.hiddenDefaultEl;
    if (!line) return;
    const { defaultLayout, visibleLayouts } = this.store.current();
    const hidden = !visibleLayouts.includes(defaultLayout);
    line.setText(hidden ? `既定レイアウト「${LAYOUT_LABELS[defaultLayout]}」は左下に出しません。新規マップはそのレイアウトで作られ、そのノートではボタンも出ます。` : '');
    line.hidden = !hidden;
  }

  private commit(key: SettingKey, value: unknown): void {
    this.setControlValue(key, value).catch((error: unknown) => {
      new Notice(error instanceof Error ? error.message : '設定を保存できませんでした。');
    });
  }
}
