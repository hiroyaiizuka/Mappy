import { TFolder, normalizePath, type App, type TFile } from 'obsidian';
import type { LayoutMode } from '../core/layout-mode';
import { LAYOUT_KEY } from './frontmatter';
import { t } from '../i18n';

/** What the settings (M14) contribute to a new map; both default to the pre-settings behaviour. */
export interface NewMapOptions {
  /** Written as `mappy-layout` unless it is the regular map, which stays implicit as everywhere else. */
  layout?: LayoutMode;
  /** Vault-relative folder; empty follows Obsidian's new-note location, `/` is the vault root. */
  folder?: string;
}

/** New maps use the canonical marker and the H2 + bullet-list document shape. */
export function newMindmapSource(title: string, layout: LayoutMode = 'mindmap'): string {
  const properties = layout === 'mindmap' ? 'mappy: true\n' : `mappy: true\n${LAYOUT_KEY}: ${layout}\n`;
  return `---\n${properties}---\n\n## ${title}\n`;
}

function childPath(folder: string, name: string): string {
  return normalizePath(folder ? `${folder}/${name}` : name);
}

/** Why the folder setting cannot be used, naming the setting as the tab shows it. */
function badFolder(path: string, reason: 'folderDotName' | 'folderIsFile' | 'folderNotCreated'): Error {
  const text = t();
  return new Error(text[reason](path, text.setFolder));
}

/**
 * The folder a new map goes to. An empty setting keeps Obsidian's own "default
 * location for new notes"; a path is created when missing and refused when a
 * file already has that name, so nothing is ever overwritten. `normalizePath`
 * only tidies slashes, so `.`, `..` and dot-folders (which the vault does not
 * index) are refused here: `createFolder` would otherwise make a folder the
 * vault cannot see, or one outside it.
 */
export async function resolveNewMapFolder(app: App, folder: string, sourcePath: string, fileName: string): Promise<TFolder> {
  const requested = folder.trim();
  if (!requested) return app.fileManager.getNewFileParent(sourcePath, fileName);
  const path = normalizePath(requested);
  // normalizePath strips leading and trailing slashes, so "/" comes back as "" or "/"; either way the user asked for the root.
  if (!path || path === '/') return app.vault.getRoot();
  if (path.split('/').some(segment => segment.startsWith('.'))) throw badFolder(path, 'folderDotName');
  // The file system is usually case-insensitive: `maps` must reuse an existing `Maps` rather than fail to create it,
  // and a file called `Maps` blocks `maps` just as it blocks `Maps`.
  const lower = path.toLowerCase();
  const existing = app.vault.getAbstractFileByPath(path)
    ?? app.vault.getAllLoadedFiles().find(candidate => candidate.path.toLowerCase() === lower);
  if (existing instanceof TFolder) return existing;
  if (existing) throw badFolder(path, 'folderIsFile');
  const created: TFolder | null = await app.vault.createFolder(path);
  if (!created) throw badFolder(path, 'folderNotCreated');
  return created;
}

/** Create without overwriting, in the configured folder (or Obsidian's), with the configured layout. */
export async function createMindmapFile(app: App, sourcePath: string, options: NewMapOptions = {}): Promise<TFile> {
  // The name is written into the note as its title, in the app's language (architecture.md §9e).
  const untitled = t().untitled;
  const requestedName = `${untitled}.md`;
  const parent = await resolveNewMapFolder(app, options.folder ?? '', sourcePath, requestedName);
  let index = 1;
  let title = untitled;
  let path = childPath(parent.path, `${title}.md`);
  while (app.vault.getAbstractFileByPath(path)) {
    index += 1;
    title = `${untitled} ${index}`;
    path = childPath(parent.path, `${title}.md`);
  }
  return app.vault.create(path, newMindmapSource(title, options.layout));
}
