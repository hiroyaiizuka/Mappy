import { describe, expect, it, vi } from 'vitest';
import { TFile, TFolder, type App } from 'obsidian';
import { setLanguage } from '../../src/i18n';
import { createMindmapFile, newMapSourcePath, newMindmapSource, resolveNewMapFolder } from '../../src/obsidian/map-files';

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

/**
 * A vault of folders and files by path (case-sensitive, as Obsidian's index is), each folder holding its children as
 * Obsidian's do; `create` records what it was asked to write. Listing the vault is a spy the resolver must not call
 * (LEV-253: the community scan flags every listing, and a path resolves without one).
 */
function vault(options: { folders?: string[]; files?: string[]; newFileParent?: string } = {}) {
  const entries = new Map<string, TFolder | TFile>();
  const root = folderAt('/');
  const add = (entry: TFolder | TFile) => {
    entries.set(entry.path, entry);
    const slash = entry.path.lastIndexOf('/');
    const parent = slash < 0 ? root : folderOf(entry.path.slice(0, slash));
    parent.children.push(entry);
  };
  const folderOf = (path: string): TFolder => {
    const existing = entries.get(path);
    if (existing instanceof TFolder) return existing;
    const folder = folderAt(path);
    add(folder);
    return folder;
  };
  for (const path of options.folders ?? []) folderOf(path);
  for (const path of options.files ?? []) add(fileAt(path));
  const create = vi.fn((path: string) => Promise.resolve(fileAt(path)));
  const createFolder = vi.fn((path: string) => Promise.resolve(folderOf(path)));
  const getNewFileParent = vi.fn(() => folderAt(options.newFileParent ?? 'Inbox'));
  const listing = vi.fn(() => [root, ...entries.values()]);
  const app = {
    fileManager: { getNewFileParent },
    vault: {
      getRoot: () => root,
      getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
      getAllLoadedFiles: listing,
      getAllFolders: listing,
      getFiles: listing,
      getMarkdownFiles: listing,
      create,
      createFolder,
    },
  } as unknown as App;
  return { app, create, createFolder, getNewFileParent, root, listing };
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

  it('finds a folder whose name differs in case by walking down from the root, without listing the vault (LEV-253)', async () => {
    const { app, createFolder, listing } = vault({ folders: ['Maps/2026', 'maps.md'], files: ['Notes/Plan.md', 'Notes/Sub/Deep.md'] });
    expect((await resolveNewMapFolder(app, 'maps/2026', '', 'x.md')).path).toBe('Maps/2026');
    expect((await resolveNewMapFolder(app, 'NOTES/sub', '', 'x.md')).path).toBe('Notes/Sub');
    // The exact name wins over one differing only in case.
    expect((await resolveNewMapFolder(app, 'maps.md', '', 'x.md')).path).toBe('maps.md');
    await expect(resolveNewMapFolder(app, 'notes/sub/deep.md', '', 'x.md')).rejects.toThrow('はフォルダではありません');
    expect(createFolder).not.toHaveBeenCalled();
    // A path that goes on under a file is refused as a file is (review 3: creating through it fails with the adapter's
    // own error). One with no match at some level is new: the vault is asked to create it, under the existing folders
    // as they are spelled (review 2: not a second `maps` beside `Maps` in the vault's index).
    await expect(resolveNewMapFolder(app, 'notes/plan.md/inner', '', 'x.md')).rejects.toThrow('はフォルダではありません');
    await resolveNewMapFolder(app, 'maps/2027', '', 'x.md');
    expect(createFolder.mock.calls).toEqual([['Maps/2027']]);
    expect(listing).not.toHaveBeenCalled();
  });

  it('goes back up when the first folder matching in case has no such child (review 1: a vault synced from a case-sensitive system)', async () => {
    const { app, createFolder, listing } = vault({ folders: ['Maps', 'MAPS/2026', 'maps/x', 'notes/y'], files: ['Notes'] });
    expect((await resolveNewMapFolder(app, 'maps/2026', '', 'x.md')).path).toBe('MAPS/2026');
    // Nor does the exact name, or a file of that name, hide the folder beside it that has the rest.
    expect((await resolveNewMapFolder(app, 'Maps/x', '', 'x.md')).path).toBe('maps/x');
    expect((await resolveNewMapFolder(app, 'Notes/y', '', 'x.md')).path).toBe('notes/y');
    // The exact path still wins when there is one.
    expect((await resolveNewMapFolder(app, 'Maps', '', 'x.md')).path).toBe('Maps');
    // At the last segment too, a folder differing in case is taken over a file of the name (review 2).
    const synced = vault({ folders: ['PLANS'], files: ['Plans'] });
    expect((await resolveNewMapFolder(synced.app, 'plans', '', 'x.md')).path).toBe('PLANS');
    expect((await resolveNewMapFolder(synced.app, 'Plans', '', 'x.md')).path).toBe('PLANS');
    expect(synced.createFolder).not.toHaveBeenCalled();
    // And across branches: a file at the whole path under one parent does not hide a folder there under another (review 3).
    const branches = vault({ folders: ['Maps', 'maps/x'], files: ['Maps/x'] });
    expect((await resolveNewMapFolder(branches.app, 'Maps/x', '', 'x.md')).path).toBe('maps/x');
    expect(branches.createFolder).not.toHaveBeenCalled();
    expect(createFolder).not.toHaveBeenCalled();
    expect(listing).not.toHaveBeenCalled();
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
      '---\nmappy: true\n---\n\n## 中心トピック\n',
    );
  });

  // The file name and the root written into the note (LEV-255) follow the app's language, as the UI does (LEV-226).
  it('names a new map and its central topic in English when the app is not in Japanese, and the folder refusal names the setting as the tab does', async () => {
    setLanguage('en');
    try {
      const { app, create } = vault({ newFileParent: 'Maps', files: ['Maps/Untitled mind map.md'] });
      await createMindmapFile(app, 'Notes/Current.md');
      expect(create).toHaveBeenCalledWith('Maps/Untitled mind map 2.md', '---\nmappy: true\n---\n\n## Central topic\n');
      const blocked = vault({ files: ['Maps'] });
      await expect(resolveNewMapFolder(blocked.app, 'Maps', '', 'x.md')).rejects.toThrow('"Maps" is not a folder. Check "Folder for new maps" in the settings.');
    } finally { setLanguage('ja'); }
  });

  it('writes the same file as before when the settings are at their defaults', async () => {
    const { app, create, getNewFileParent } = vault({ newFileParent: 'Inbox' });
    await createMindmapFile(app, 'Notes/Current.md', { layout: 'mindmap', folder: '' });
    expect(getNewFileParent).toHaveBeenCalledWith('Notes/Current.md', '無題のマインドマップ.md');
    expect(create).toHaveBeenCalledWith('Inbox/無題のマインドマップ.md', '---\nmappy: true\n---\n\n## 中心トピック\n');
  });

  it('writes the default layout into the new note only, and puts it in the configured folder', async () => {
    const { app, create, createFolder, getNewFileParent } = vault({ files: ['Maps/無題のマインドマップ.md'] });
    const file = await createMindmapFile(app, 'Notes/Current.md', { layout: 'hierarchy', folder: 'Maps' });
    expect(file.path).toBe('Maps/無題のマインドマップ 2.md');
    // The note already there means the folder is too.
    expect(createFolder).not.toHaveBeenCalled();
    expect(getNewFileParent).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith('Maps/無題のマインドマップ 2.md', '---\nmappy: true\nmappy-layout: hierarchy\n---\n\n## 中心トピック\n');
  });

  it('creates at the vault root without a leading slash', async () => {
    const { app, create } = vault();
    await createMindmapFile(app, '', { layout: 'timeline', folder: '/' });
    expect(create).toHaveBeenCalledWith('無題のマインドマップ.md', '---\nmappy: true\nmappy-layout: timeline\n---\n\n## 中心トピック\n');
  });

  it('does not create the note when the folder cannot be resolved', async () => {
    const { app, create } = vault({ files: ['Maps'] });
    await expect(createMindmapFile(app, '', { folder: 'Maps' })).rejects.toThrow('フォルダではありません');
    expect(create).not.toHaveBeenCalled();
  });
});

/**
 * LEV-300: "same folder as current file" for a map made from a canvas or a PDF (the ribbon makes one from those now; the
 * command too) counts from that file. Before, the plugin's active note was null there and the path was '' (Obsidian's
 * default location). Put back to `note?.path ?? ''`, the canvas line fails (artifacts/lev-300/source-path-reverted.txt).
 */
describe('newMapSourcePath (LEV-300)', () => {
  const file = (path: string): TFile => { const result = new TFile(); result.path = path; return result; };
  const app = (active: TFile | null) => ({ workspace: { getActiveFile: () => active } }) as unknown as App;

  it('counts from the active note, else from the active file that is not a note (a canvas the ribbon was pressed on)', () => {
    expect(newMapSourcePath(app(file('Other/Note.md')), file('Maps/Plan.md'))).toBe('Maps/Plan.md');
    expect(newMapSourcePath(app(file('Projects/X/Board.canvas')), null)).toBe('Projects/X/Board.canvas');
    expect(newMapSourcePath(app(null), null)).toBe('');
  });
});
