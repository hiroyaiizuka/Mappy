import { describe, expect, it, vi } from 'vitest';
import { TFile, type App } from 'obsidian';
import { LAYOUT_KEY, layoutFromFrontmatter, readMapLayout, writeMapLayout } from '../../src/obsidian/frontmatter';

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
  it('maps values to layouts and treats absent or negative values as none', () => {
    expect(layoutFromFrontmatter('mindmap')).toBe('mindmap');
    expect(layoutFromFrontmatter('Timeline ')).toBe('timeline');
    expect(layoutFromFrontmatter(true)).toBe('mindmap');
    expect(layoutFromFrontmatter('yes')).toBe('mindmap');
    for (const value of [undefined, null, false, '', 'false', 'off', 'no', 0]) expect(layoutFromFrontmatter(value)).toBeNull();
  });
});

describe('readMapLayout', () => {
  it('reads the reserved key from the metadata cache', () => {
    expect(readMapLayout(app({ [LAYOUT_KEY]: 'timeline' }).instance, file())).toBe('timeline');
    expect(readMapLayout(app({ other: 1 }).instance, file())).toBeNull();
    expect(readMapLayout(app(undefined).instance, file())).toBeNull();
  });

  it('never claims Excalidraw drawings, even with the key present', () => {
    expect(readMapLayout(app({ [LAYOUT_KEY]: 'mindmap', 'excalidraw-plugin': 'parsed' }).instance, file())).toBeNull();
  });
});

describe('writeMapLayout', () => {
  it('sets and removes the key through processFrontMatter only', async () => {
    const { instance, store, processFrontMatter } = app({ tags: ['a'] });
    await writeMapLayout(instance, file(), 'timeline');
    expect(store).toEqual({ tags: ['a'], [LAYOUT_KEY]: 'timeline' });
    await writeMapLayout(instance, file(), null);
    expect(store).toEqual({ tags: ['a'] });
    expect(processFrontMatter).toHaveBeenCalledTimes(2);
  });
});
