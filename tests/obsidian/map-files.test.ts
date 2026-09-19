import { describe, expect, it, vi } from 'vitest';
import { TFile, type App, type TFolder } from 'obsidian';
import { createMindmapFile, newMindmapSource, resolveNewMapFolder } from '../../src/obsidian/map-files';

describe('newMindmapSource', () => {
  it('creates the canonical marker and an H2 root without a redundant layout property', () => {
    expect(newMindmapSource('企画')).toBe('---\nmappy: true\n---\n\n## 企画\n');
    expect(newMindmapSource('企画', 'mindmap')).toBe(newMindmapSource('企画'));
  });

  it.each(['timeline', 'hierarchy'] as const)('writes the default layout %s as mappy-layout, after the marker', layout => {
    expect(newMindmapSource('企画', layout)).toBe(`---\nmappy: true\nmappy-layout: ${layout}\n---\n\n## 企画\n`);
  });
});

/** A vault of folders and files by path; `create` records what it was asked to write. */
function vault(options: { folders?: string[]; files?: string[]; newFileParent?: string } = {}) {
  const folders = new Map((options.folders ?? []).map(path => [path, { path } as TFolder]));
  const files = new Set(options.files ?? []);
  const root = { path: '/' } as TFolder;
  const create = vi.fn((path: string) => {
    const created = new TFile();
    created.path = path;
    return Promise.resolve(created);
  });
  const createFolder = vi.fn((path: string) => {
    const folder = { path } as TFolder;
    folders.set(path, folder);
    return Promise.resolve(folder);
  });
  const getNewFileParent = vi.fn(() => ({ path: options.newFileParent ?? 'Inbox' }) as TFolder);
  const app = {
    fileManager: { getNewFileParent },
    vault: {
      getRoot: () => root,
      getFolderByPath: (path: string) => folders.get(path) ?? null,
      getAbstractFileByPath: (path: string) => folders.get(path) ?? (files.has(path) ? { path } : null),
      create,
      createFolder,
    },
  } as unknown as App;
  return { app, create, createFolder, getNewFileParent, root };
}

describe('resolveNewMapFolder', () => {
  it('follows Obsidian\'s new-note location when the setting is empty or blank', async () => {
    const { app, getNewFileParent, createFolder } = vault();
    for (const setting of ['', '   ']) {
      const folder = await resolveNewMapFolder(app, setting, 'Notes/Current.md', 'x.md');
      expect(folder.path).toBe('Inbox');
    }
    expect(getNewFileParent).toHaveBeenCalledWith('Notes/Current.md', 'x.md');
    expect(createFolder).not.toHaveBeenCalled();
  });

  it('returns an existing folder, normalizing slashes, without touching the vault', async () => {
    const { app, createFolder, getNewFileParent } = vault({ folders: ['Maps/2026'] });
    for (const setting of ['Maps/2026', '/Maps/2026/', 'Maps//2026', ' Maps\\2026 ']) {
      const folder = await resolveNewMapFolder(app, setting, '', 'x.md');
      expect(folder.path).toBe('Maps/2026');
    }
    expect(createFolder).not.toHaveBeenCalled();
    expect(getNewFileParent).not.toHaveBeenCalled();
  });

  it('creates a missing folder once and then reuses it', async () => {
    const { app, createFolder } = vault();
    const first = await resolveNewMapFolder(app, 'Maps', '', 'x.md');
    const second = await resolveNewMapFolder(app, 'Maps', '', 'x.md');
    expect(first.path).toBe('Maps');
    expect(second).toBe(first);
    expect(createFolder).toHaveBeenCalledTimes(1);
    expect(createFolder).toHaveBeenCalledWith('Maps');
  });

  it('uses the vault root for "/" and refuses a path that names a file', async () => {
    const { app, root, createFolder } = vault({ files: ['Maps.md'] });
    expect(await resolveNewMapFolder(app, '/', '', 'x.md')).toBe(root);
    expect(await resolveNewMapFolder(app, ' // ', '', 'x.md')).toBe(root);
    await expect(resolveNewMapFolder(app, 'Maps.md', '', 'x.md')).rejects.toThrow('作成先「Maps.md」はフォルダではありません');
    expect(createFolder).not.toHaveBeenCalled();
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

  it('writes the same file as before when the settings are at their defaults', async () => {
    const { app, create, getNewFileParent } = vault({ newFileParent: 'Inbox' });
    await createMindmapFile(app, 'Notes/Current.md', { layout: 'mindmap', folder: '' });
    expect(getNewFileParent).toHaveBeenCalledWith('Notes/Current.md', '無題のマインドマップ.md');
    expect(create).toHaveBeenCalledWith('Inbox/無題のマインドマップ.md', '---\nmappy: true\n---\n\n## 無題のマインドマップ\n');
  });

  it('writes the default layout into the new note only, and puts it in the configured folder', async () => {
    const { app, create, createFolder, getNewFileParent } = vault({ files: ['Maps/無題のマインドマップ.md'] });
    const file = await createMindmapFile(app, 'Notes/Current.md', { layout: 'hierarchy', folder: 'Maps' });
    expect(file.path).toBe('Maps/無題のマインドマップ 2.md');
    expect(createFolder).toHaveBeenCalledWith('Maps');
    expect(getNewFileParent).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith('Maps/無題のマインドマップ 2.md', '---\nmappy: true\nmappy-layout: hierarchy\n---\n\n## 無題のマインドマップ 2\n');
  });

  it('creates at the vault root without a leading slash', async () => {
    const { app, create } = vault();
    await createMindmapFile(app, '', { layout: 'timeline', folder: '/' });
    expect(create).toHaveBeenCalledWith('無題のマインドマップ.md', '---\nmappy: true\nmappy-layout: timeline\n---\n\n## 無題のマインドマップ\n');
  });

  it('does not create the note when the folder cannot be resolved', async () => {
    const { app, create } = vault({ files: ['Maps'] });
    await expect(createMindmapFile(app, '', { folder: 'Maps' })).rejects.toThrow('フォルダではありません');
    expect(create).not.toHaveBeenCalled();
  });
});
