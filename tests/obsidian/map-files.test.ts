import { describe, expect, it, vi } from 'vitest';
import { TFile, TFolder, type App } from 'obsidian';
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

function folderAt(path: string): TFolder {
  const folder = new TFolder();
  folder.path = path;
  return folder;
}

function fileAt(path: string): TFile {
  const file = new TFile();
  file.path = path;
  return file;
}

/** A vault of folders and files by path (case-sensitive, as Obsidian's index is); `create` records what it was asked to write. */
function vault(options: { folders?: string[]; files?: string[]; newFileParent?: string } = {}) {
  const entries = new Map<string, TFolder | TFile>();
  for (const path of options.folders ?? []) entries.set(path, folderAt(path));
  for (const path of options.files ?? []) entries.set(path, fileAt(path));
  const root = folderAt('/');
  const create = vi.fn((path: string) => Promise.resolve(fileAt(path)));
  const createFolder = vi.fn((path: string) => {
    const folder = folderAt(path);
    entries.set(path, folder);
    return Promise.resolve(folder);
  });
  const getNewFileParent = vi.fn(() => folderAt(options.newFileParent ?? 'Inbox'));
  const app = {
    fileManager: { getNewFileParent },
    vault: {
      getRoot: () => root,
      getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
      getAllLoadedFiles: () => [root, ...entries.values()],
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

  it('reuses a folder whose name differs only in case, and treats a file of that name as blocking too', async () => {
    const { app, createFolder } = vault({ folders: ['Maps'], files: ['Notes/Plan.md'] });
    expect((await resolveNewMapFolder(app, 'maps', '', 'x.md')).path).toBe('Maps');
    expect((await resolveNewMapFolder(app, 'MAPS/', '', 'x.md')).path).toBe('Maps');
    await expect(resolveNewMapFolder(app, 'notes/plan.md', '', 'x.md')).rejects.toThrow('はフォルダではありません');
    expect(createFolder).not.toHaveBeenCalled();
  });

  it('refuses ".", ".." and dot-folders, which normalizePath keeps and the vault cannot index', async () => {
    const { app, createFolder } = vault();
    for (const setting of ['./Maps', '../Maps', 'Maps/../Other', 'Maps/./2026', '.maps', 'Maps/.hidden', '..']) {
      await expect(resolveNewMapFolder(app, setting, '', 'x.md')).rejects.toThrow('に . で始まる名前は使えません');
    }
    expect(createFolder).not.toHaveBeenCalled();
  });

  it('reports a folder the vault could not create instead of returning nothing', async () => {
    const { app, createFolder } = vault();
    createFolder.mockImplementationOnce(() => Promise.resolve(null as unknown as TFolder));
    await expect(resolveNewMapFolder(app, 'Maps', '', 'x.md')).rejects.toThrow('作成先「Maps」を作成できませんでした');
  });
});

describe('createMindmapFile', () => {
  it('uses the configured new-file folder and finds a non-conflicting name', async () => {
    const { app, create, getNewFileParent } = vault({ newFileParent: 'Maps', files: ['Maps/無題のマインドマップ.md'] });
    const file = await createMindmapFile(app, 'Notes/Current.md');
    expect(file.path).toBe('Maps/無題のマインドマップ 2.md');
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
