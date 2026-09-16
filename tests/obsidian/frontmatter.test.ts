import { describe, expect, it, vi } from 'vitest';
import { TFile, type App } from 'obsidian';
import {
  LAYOUT_KEY, MAPPY_KEY, isMappyCandidate, layoutFromFrontmatter, readMapLayout,
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
});

describe('readMapLayout', () => {
  it('requires the boolean mappy marker and treats layout as optional', () => {
    expect(readMapLayout(app({ [MAPPY_KEY]: true }).instance, file())).toBe('mindmap');
    expect(readMapLayout(app({ [MAPPY_KEY]: true, [LAYOUT_KEY]: 'timeline' }).instance, file())).toBe('timeline');
    expect(readMapLayout(app({ [MAPPY_KEY]: true, [LAYOUT_KEY]: 'unknown' }).instance, file())).toBe('mindmap');
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

  it('stores timeline as the optional initial layout', async () => {
    const { instance, store } = app({ tags: ['a'] });
    await writeMapLayout(instance, file(), 'timeline');
    expect(store).toEqual({ tags: ['a'], [MAPPY_KEY]: true, [LAYOUT_KEY]: 'timeline' });
  });

  it('removes both Mappy properties without changing unrelated frontmatter', async () => {
    const { instance, store } = app({ tags: ['a'], [MAPPY_KEY]: true, [LAYOUT_KEY]: 'timeline' });
    await writeMapLayout(instance, file(), null);
    expect(store).toEqual({ tags: ['a'] });
  });
});
