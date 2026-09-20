import { describe, expect, it } from 'vitest';
import { LAYOUT_MODES } from '../../src/core/layout-mode';
import { DEFAULT_SETTINGS, MAP_THEMES, isMapTheme, normalizeSettings, readSettingField, readVisibleLayouts } from '../../src/obsidian/settings';

describe('normalizeSettings', () => {
  it('returns the defaults, which reproduce the behaviour before the settings existed, when nothing is stored', () => {
    expect(DEFAULT_SETTINGS).toEqual({ theme: 'follow', defaultLayout: 'mindmap', newMapFolder: '', visibleLayouts: ['mindmap', 'timeline', 'hierarchy', 'balanced'] });
    for (const raw of [undefined, null, '', 0, false, [], 'settings']) {
      expect(normalizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps every valid stored value and does not alias the defaults', () => {
    const stored = { theme: 'dark', defaultLayout: 'hierarchy', newMapFolder: 'Maps/2026', visibleLayouts: ['mindmap', 'hierarchy'] };
    const settings = normalizeSettings(stored);
    expect(settings).toEqual(stored);
    expect(settings).not.toBe(stored);
    expect(settings.visibleLayouts).not.toBe(stored.visibleLayouts);
    expect(normalizeSettings({})).not.toBe(DEFAULT_SETTINGS);
    expect(normalizeSettings({}).visibleLayouts).not.toBe(DEFAULT_SETTINGS.visibleLayouts);
  });

  it('falls back field by field on an older or hand-edited data file', () => {
    // An earlier shape: only the theme, under a different value vocabulary.
    expect(normalizeSettings({ theme: 'obsidian' })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ theme: 'light', defaultLayout: 'issue-tree' })).toEqual({ ...DEFAULT_SETTINGS, theme: 'light' });
    expect(normalizeSettings({ defaultLayout: 'TIMELINE' })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ newMapFolder: 42 })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ newMapFolder: null })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ theme: null, defaultLayout: null, newMapFolder: undefined, visibleLayouts: null })).toEqual(DEFAULT_SETTINGS);
    // The data file of the version before the layout list: every button shows, as it did then.
    expect(normalizeSettings({ theme: 'dark', defaultLayout: 'timeline', newMapFolder: 'Maps' })).toEqual({
      theme: 'dark', defaultLayout: 'timeline', newMapFolder: 'Maps', visibleLayouts: [...LAYOUT_MODES],
    });
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

describe('visibleLayouts (the bottom-left layout buttons, M14)', () => {
  it('always holds the regular map: a list without it, or an empty one, gets it back', () => {
    expect(normalizeSettings({ visibleLayouts: ['timeline'] }).visibleLayouts).toEqual(['mindmap', 'timeline']);
    expect(normalizeSettings({ visibleLayouts: [] }).visibleLayouts).toEqual(['mindmap']);
    expect(normalizeSettings({ visibleLayouts: ['hierarchy', 'balanced'] }).visibleLayouts).toEqual(['mindmap', 'hierarchy', 'balanced']);
  });

  it('keeps known layouts only, once each, in LAYOUT_MODES order', () => {
    expect(normalizeSettings({ visibleLayouts: ['balanced', 'mindmap', 'timeline', 'balanced'] }).visibleLayouts).toEqual(['mindmap', 'timeline', 'balanced']);
    expect(normalizeSettings({ visibleLayouts: ['issue-tree', 'Timeline', ' hierarchy', 42, null, { mode: 'timeline' }] }).visibleLayouts).toEqual(['mindmap']);
    expect(normalizeSettings({ visibleLayouts: [...LAYOUT_MODES].reverse() }).visibleLayouts).toEqual([...LAYOUT_MODES]);
  });

  it('treats anything but an array as unset, so every button shows', () => {
    for (const raw of ['timeline', 'mindmap,timeline', 0, true, {}, { mindmap: true }, null, undefined]) {
      expect(normalizeSettings({ visibleLayouts: raw }).visibleLayouts).toEqual([...LAYOUT_MODES]);
      expect(readVisibleLayouts(raw)).toBeNull();
    }
    expect(readSettingField('visibleLayouts', 'timeline')).toBeNull();
    expect(readSettingField('visibleLayouts', ['timeline'])).toEqual(['mindmap', 'timeline']);
  });

  it('does not touch the other fields when normalizing the list', () => {
    expect(normalizeSettings({ theme: 'light', defaultLayout: 'timeline', newMapFolder: 'Maps', visibleLayouts: ['hierarchy'] })).toEqual({
      theme: 'light', defaultLayout: 'timeline', newMapFolder: 'Maps', visibleLayouts: ['mindmap', 'hierarchy'],
    });
  });
});
