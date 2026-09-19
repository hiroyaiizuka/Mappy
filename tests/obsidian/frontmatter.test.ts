import { describe, expect, it, vi } from 'vitest';
import { TFile, type App } from 'obsidian';
import {
  LAYOUT_KEY, MAPPY_KEY, TOPICS_KEY, isMappyCandidate, layoutFromFrontmatter, readMapLayout,
  readPreferredMapLayout, writeMapLayout,
} from '../../src/obsidian/frontmatter';

function file(path = 'Note.md'): TFile {
  const result = new TFile();
  result.path = path;
  return result;
}

function app(frontmatter: Record<string, unknown> | undefined) {
  const store: Record<string, unknown> = { ...(frontmatter ?? {}) };
  const processFrontMatter = vi.fn((_file: TFile, transform: (fm: Record<string, unknown>) => void) => {
    transform(store);
    return Promise.resolve();
  });
  const instance = {
    metadataCache: { getFileCache: () => (frontmatter ? { frontmatter } : null) },
    fileManager: { processFrontMatter },
  } as unknown as App;
  return { instance, store, processFrontMatter };
}

describe('layoutFromFrontmatter', () => {
  it('uses timeline only for its explicit value and otherwise defaults to mindmap', () => {
    expect(layoutFromFrontmatter('Timeline ')).toBe('timeline');
    for (const value of [undefined, null, false, '', 'mindmap', 'unknown', true]) {
      expect(layoutFromFrontmatter(value)).toBe('mindmap');
    }
  });

  it('accepts every layout mode, trimmed and case-insensitively, and never a look-alike', () => {
    expect(layoutFromFrontmatter('hierarchy')).toBe('hierarchy');
    expect(layoutFromFrontmatter(' Hierarchy ')).toBe('hierarchy');
    expect(layoutFromFrontmatter('issue-tree')).toBe('mindmap');
    expect(layoutFromFrontmatter(['hierarchy'])).toBe('mindmap');
  });
});

describe('readMapLayout', () => {
  it('requires the boolean mappy marker and treats layout as optional', () => {
    expect(readMapLayout(app({ [MAPPY_KEY]: true }).instance, file())).toBe('mindmap');
    expect(readMapLayout(app({ [MAPPY_KEY]: true, [LAYOUT_KEY]: 'timeline' }).instance, file())).toBe('timeline');
    expect(readMapLayout(app({ [MAPPY_KEY]: true, [LAYOUT_KEY]: 'unknown' }).instance, file())).toBe('mindmap');
    expect(readMapLayout(app({ [MAPPY_KEY]: true, [LAYOUT_KEY]: 'hierarchy' }).instance, file())).toBe('hierarchy');
  });

  it('does not claim ordinary, disabled, malformed, or legacy layout-only notes', () => {
    expect(readMapLayout(app({ other: 1 }).instance, file())).toBeNull();
    expect(readMapLayout(app({ [MAPPY_KEY]: false, [LAYOUT_KEY]: 'timeline' }).instance, file())).toBeNull();
    expect(readMapLayout(app({ [MAPPY_KEY]: 'true' }).instance, file())).toBeNull();
    expect(readMapLayout(app({ [LAYOUT_KEY]: 'timeline' }).instance, file())).toBeNull();
    expect(readMapLayout(app(undefined).instance, file())).toBeNull();
  });

  it('keeps a legacy layout as the preference for an explicit migration', () => {
    expect(readPreferredMapLayout(app({ [LAYOUT_KEY]: 'timeline' }).instance, file())).toBe('timeline');
    expect(readPreferredMapLayout(app({ [LAYOUT_KEY]: 'mindmap' }).instance, file())).toBe('mindmap');
  });

  it('converts with the settings\' default layout only when the note names no valid layout of its own', () => {
    // No frontmatter, no layout key, or an unusable value: the default from the settings (M14).
    expect(readPreferredMapLayout(app(undefined).instance, file(), 'hierarchy')).toBe('hierarchy');
    expect(readPreferredMapLayout(app({ tags: ['a'] }).instance, file(), 'timeline')).toBe('timeline');
    expect(readPreferredMapLayout(app({ [LAYOUT_KEY]: 'issue-tree' }).instance, file(), 'hierarchy')).toBe('hierarchy');
    // A legacy note keeps its own, even the explicit regular map, whatever the default says.
    expect(readPreferredMapLayout(app({ [LAYOUT_KEY]: 'timeline' }).instance, file(), 'hierarchy')).toBe('timeline');
    expect(readPreferredMapLayout(app({ [LAYOUT_KEY]: 'mindmap' }).instance, file(), 'hierarchy')).toBe('mindmap');
    expect(readPreferredMapLayout(app({ [LAYOUT_KEY]: ' Hierarchy ' }).instance, file(), 'timeline')).toBe('hierarchy');
    // Without a fallback the regular map remains the default, as before.
    expect(readPreferredMapLayout(app(undefined).instance, file())).toBe('mindmap');
  });

  it('opens an existing note the same way whatever the default layout is: the setting is not consulted', () => {
    // readMapLayout has no fallback parameter by design; a note without mappy-layout stays the regular map.
    expect(readMapLayout(app({ [MAPPY_KEY]: true }).instance, file())).toBe('mindmap');
    expect(readMapLayout.length).toBe(2);
  });

  it('never claims Excalidraw drawings and excludes them from map conversion', () => {
    const instance = app({ [MAPPY_KEY]: true, 'excalidraw-plugin': 'parsed' }).instance;
    expect(readMapLayout(instance, file())).toBeNull();
    expect(isMappyCandidate(instance, file('Drawing.excalidraw.md'))).toBe(false);
  });
});

describe('writeMapLayout', () => {
  it('enables a mindmap with mappy true and omits the default layout property', async () => {
    const { instance, store, processFrontMatter } = app({ tags: ['a'], [LAYOUT_KEY]: 'mindmap' });
    await writeMapLayout(instance, file(), 'mindmap');
    expect(store).toEqual({ tags: ['a'], [MAPPY_KEY]: true });
    expect(processFrontMatter).toHaveBeenCalledOnce();
  });

  it.each(['timeline', 'hierarchy'] as const)('stores %s as the optional initial layout and replaces the previous one', async layout => {
    const { instance, store } = app({ tags: ['a'], [LAYOUT_KEY]: layout === 'timeline' ? 'hierarchy' : 'timeline' });
    await writeMapLayout(instance, file(), layout);
    expect(store).toEqual({ tags: ['a'], [MAPPY_KEY]: true, [LAYOUT_KEY]: layout });
  });

  it('removes every Mappy property, topic positions included, without changing unrelated frontmatter', async () => {
    const { instance, store } = app({ tags: ['a'], [MAPPY_KEY]: true, [LAYOUT_KEY]: 'timeline', [TOPICS_KEY]: { 参考: { mindmap: [1, 2] } } });
    await writeMapLayout(instance, file(), null);
    expect(store).toEqual({ tags: ['a'] });
  });

  it('keeps topic positions when enabling or changing the layout', async () => {
    const { instance, store } = app({ [MAPPY_KEY]: true, [TOPICS_KEY]: { 参考: { mindmap: [1, 2] } } });
    await writeMapLayout(instance, file(), 'timeline');
    expect(store).toEqual({ [MAPPY_KEY]: true, [TOPICS_KEY]: { 参考: { mindmap: [1, 2] } }, [LAYOUT_KEY]: 'timeline' });
  });
});
