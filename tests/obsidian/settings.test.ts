import { describe, expect, it } from 'vitest';
import { LAYOUT_MODES } from '../../src/core/layout-mode';
import { DEFAULT_SETTINGS, MAP_THEMES, isMapTheme, normalizeSettings } from '../../src/obsidian/settings';

describe('normalizeSettings', () => {
  it('returns the defaults, which reproduce the behaviour before the settings existed, when nothing is stored', () => {
    expect(DEFAULT_SETTINGS).toEqual({ theme: 'follow', defaultLayout: 'mindmap', newMapFolder: '' });
    for (const raw of [undefined, null, '', 0, false, [], 'settings']) {
      expect(normalizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps every valid stored value and does not alias the defaults', () => {
    const stored = { theme: 'dark', defaultLayout: 'hierarchy', newMapFolder: 'Maps/2026' };
    const settings = normalizeSettings(stored);
    expect(settings).toEqual(stored);
    expect(settings).not.toBe(stored);
    expect(normalizeSettings({})).not.toBe(DEFAULT_SETTINGS);
  });

  it('falls back field by field on an older or hand-edited data file', () => {
    // An earlier shape: only the theme, under a different value vocabulary.
    expect(normalizeSettings({ theme: 'obsidian' })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ theme: 'light', defaultLayout: 'issue-tree' })).toEqual({ ...DEFAULT_SETTINGS, theme: 'light' });
    expect(normalizeSettings({ defaultLayout: 'TIMELINE' })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ newMapFolder: 42 })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ newMapFolder: null })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ theme: null, defaultLayout: null, newMapFolder: undefined })).toEqual(DEFAULT_SETTINGS);
  });

  it('trims the folder and drops keys it does not know', () => {
    expect(normalizeSettings({ newMapFolder: '  Maps/  ' })).toEqual({ ...DEFAULT_SETTINGS, newMapFolder: 'Maps/' });
    expect(normalizeSettings({ newMapFolder: '   ' })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ theme: 'light', legacyOption: true, mySetting: 'x' })).toEqual({ ...DEFAULT_SETTINGS, theme: 'light' });
  });

  it('accepts every layout mode and every theme, and nothing that merely looks like one', () => {
    for (const layout of LAYOUT_MODES) expect(normalizeSettings({ defaultLayout: layout }).defaultLayout).toBe(layout);
    for (const theme of MAP_THEMES) expect(normalizeSettings({ theme }).theme).toBe(theme);
    expect(isMapTheme('Dark')).toBe(false);
    expect(isMapTheme(['dark'])).toBe(false);
    expect(isMapTheme('system')).toBe(false);
  });
});
