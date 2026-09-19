import { Notice, PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';
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

/**
 * One setting as Obsidian 1.13's declarative settings API describes it: the subset of
 * `SettingDefinitionControl` with a `dropdown` or `text` control, copied from obsidian.d.ts 1.13.1
 * because the API types stay pinned to 1.8.7 (docs/harness.md). Obsidian 1.13+ renders these
 * through `getSettingDefinitions()` / `getControlValue()` / `setControlValue()`, which also puts
 * them in its settings search; earlier versions call `display()`, which builds the same three
 * from this list. Either way the note is never touched: only `loadData` / `saveData` change.
 *
 * With the types pinned, nothing checks these overrides against the 1.13 base class, so no
 * other member of this class may use a `SettingTab` name (`update`, `settingItems`, `hide`, …).
 */
export interface MapSettingDefinition {
  name: string;
  desc: string;
  control:
    | { type: 'dropdown'; key: SettingKey; options: Record<string, string>; defaultValue: string }
    | { type: 'text'; key: SettingKey; placeholder: string; defaultValue: string };
}

function options<K extends string>(keys: readonly K[], labels: Record<K, string>): Record<string, string> {
  return Object.fromEntries(keys.map(key => [key, labels[key]]));
}

/** The three settings, in the order the tab shows them; the layout list follows LAYOUT_MODES. */
export function mapSettingDefinitions(): MapSettingDefinition[] {
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
  ];
}

export class MappySettingTab extends PluginSettingTab {
  constructor(app: App, plugin: Plugin, private readonly store: SettingsStore) { super(app, plugin); }

  /** Obsidian 1.13+: the declarative path (rendering and settings search). */
  getSettingDefinitions(): MapSettingDefinition[] {
    return mapSettingDefinitions();
  }

  getControlValue(key: string): unknown {
    return isSettingKey(key) ? this.store.current()[key] : undefined;
  }

  /** A value the control cannot hold (or a key that is not a setting) is not saved. */
  setControlValue(key: string, value: unknown): Promise<void> {
    if (!isSettingKey(key)) return Promise.resolve();
    const accepted = readSettingField(key, value);
    return accepted === null ? Promise.resolve() : this.store.save({ ...this.store.current(), [key]: accepted });
  }

  /** Obsidian before 1.13: the same three settings, built by hand. */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const settings = this.store.current();
    for (const definition of this.getSettingDefinitions()) {
      const setting = new Setting(containerEl).setName(definition.name).setDesc(definition.desc);
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

  private commit(key: SettingKey, value: string): void {
    this.setControlValue(key, value).catch((error: unknown) => {
      new Notice(error instanceof Error ? error.message : '設定を保存できませんでした。');
    });
  }
}
