import { describe, expect, it, vi } from 'vitest';
import { TFile, type App } from 'obsidian';
import { createMindmapFile, newMindmapSource } from '../../src/obsidian/map-files';

describe('newMindmapSource', () => {
  it('creates the canonical marker and an H2 root without a redundant layout property', () => {
    expect(newMindmapSource('企画')).toBe('---\nmappy: true\n---\n\n## 企画\n');
  });
});

describe('createMindmapFile', () => {
  it('uses the configured new-file folder and finds a non-conflicting name', async () => {
    const created = new TFile();
    created.path = 'Maps/無題のマインドマップ 2.md';
    const create = vi.fn(() => Promise.resolve(created));
    const getNewFileParent = vi.fn(() => ({ path: 'Maps' }));
    const app = {
      fileManager: { getNewFileParent },
      vault: {
        getAbstractFileByPath: vi.fn((path: string) => path === 'Maps/無題のマインドマップ.md' ? {} : null),
        create,
      },
    } as unknown as App;

    await expect(createMindmapFile(app, 'Notes/Current.md')).resolves.toBe(created);
    expect(getNewFileParent).toHaveBeenCalledWith('Notes/Current.md', '無題のマインドマップ.md');
    expect(create).toHaveBeenCalledWith(
      'Maps/無題のマインドマップ 2.md',
      '---\nmappy: true\n---\n\n## 無題のマインドマップ 2\n',
    );
  });
});
