import { isLayoutMode, type LayoutMode } from '../core/layout-mode';

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
}

export const DEFAULT_SETTINGS: MappySettings = { theme: 'follow', defaultLayout: 'mindmap', newMapFolder: '' };

/**
 * Stored data may be missing, from an older version or hand-edited; anything
 * unknown falls back to the default field by field, and unknown keys are dropped.
 */
export function normalizeSettings(raw: unknown): MappySettings {
  const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    theme: isMapTheme(data.theme) ? data.theme : DEFAULT_SETTINGS.theme,
    defaultLayout: isLayoutMode(data.defaultLayout) ? data.defaultLayout : DEFAULT_SETTINGS.defaultLayout,
    newMapFolder: typeof data.newMapFolder === 'string' ? data.newMapFolder.trim() : DEFAULT_SETTINGS.newMapFolder,
  };
}
