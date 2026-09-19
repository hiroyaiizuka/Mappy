import { LAYOUT_MODES, isLayoutMode, type LayoutMode } from '../core/layout-mode';

/**
 * The map's own theme (M14). `follow` leaves the container to Obsidian's theme,
 * the other two put Obsidian's `theme-light` / `theme-dark` class on the map
 * container only, so the palette applies there and nowhere else.
 */
export const MAP_THEMES = ['follow', 'light', 'dark'] as const;
export type MapTheme = (typeof MAP_THEMES)[number];

export function isMapTheme(value: unknown): value is MapTheme {
  return typeof value === 'string' && (MAP_THEMES as readonly string[]).includes(value);
}

/** What `loadData` / `saveData` hold. Every field has a default that reproduces the pre-settings behaviour. */
export interface MappySettings {
  theme: MapTheme;
  /** Written to `mappy-layout` by "create" and "convert" only; how existing notes open never depends on it. */
  defaultLayout: LayoutMode;
  /** Vault-relative folder for new maps; empty follows Obsidian's own new-note location, `/` is the vault root. */
  newMapFolder: string;
  /**
   * The layout buttons the map shows at the bottom left, in LAYOUT_MODES order and always with the
   * regular map. Presentation only: a hidden layout still saves, restores, embeds and exports as before.
   */
  visibleLayouts: LayoutMode[];
}

export const DEFAULT_SETTINGS: MappySettings = { theme: 'follow', defaultLayout: 'mindmap', newMapFolder: '', visibleLayouts: [...LAYOUT_MODES] };

export type SettingKey = keyof MappySettings;

export function isSettingKey(key: string): key is SettingKey {
  return Object.keys(DEFAULT_SETTINGS).includes(key);
}

/**
 * A stored or offered list as the bar shows it: known layouts only, each once, in LAYOUT_MODES
 * order, and the regular map whether or not it was named. Anything but an array is not a list.
 */
export function readVisibleLayouts(value: unknown): LayoutMode[] | null {
  if (!Array.isArray(value)) return null;
  const named: unknown[] = value;
  return LAYOUT_MODES.filter(mode => mode === 'mindmap' || named.includes(mode));
}

/**
 * One reader per field: the stored form of a candidate value, or null when the
 * field cannot hold it. The data file and the settings tab both go through these,
 * so what the tab accepts is exactly what survives a reload.
 */
const READERS: { [K in SettingKey]: (value: unknown) => MappySettings[K] | null } = {
  theme: value => isMapTheme(value) ? value : null,
  defaultLayout: value => isLayoutMode(value) ? value : null,
  newMapFolder: value => typeof value === 'string' ? value.trim() : null,
  visibleLayouts: readVisibleLayouts,
};

export function readSettingField<K extends SettingKey>(key: K, value: unknown): MappySettings[K] | null {
  return READERS[key](value);
}

/**
 * Stored data may be missing, from an older version or hand-edited; anything
 * unknown falls back to the default field by field, and unknown keys are dropped.
 */
export function normalizeSettings(raw: unknown): MappySettings {
  const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    theme: readSettingField('theme', data.theme) ?? DEFAULT_SETTINGS.theme,
    defaultLayout: readSettingField('defaultLayout', data.defaultLayout) ?? DEFAULT_SETTINGS.defaultLayout,
    newMapFolder: readSettingField('newMapFolder', data.newMapFolder) ?? DEFAULT_SETTINGS.newMapFolder,
    visibleLayouts: readSettingField('visibleLayouts', data.visibleLayouts) ?? [...DEFAULT_SETTINGS.visibleLayouts],
  };
}
