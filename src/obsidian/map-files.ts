import { normalizePath, type App, type TFile, type TFolder } from 'obsidian';
import type { LayoutMode } from '../core/layout-mode';
import { LAYOUT_KEY } from './frontmatter';

const UNTITLED = '無題のマインドマップ';

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

/**
 * The folder a new map goes to. An empty setting keeps Obsidian's own "default
 * location for new notes"; a path is created when missing and refused when a
 * file already has that name, so nothing is ever overwritten.
 */
export async function resolveNewMapFolder(app: App, folder: string, sourcePath: string, fileName: string): Promise<TFolder> {
  const requested = folder.trim();
  if (!requested) return app.fileManager.getNewFileParent(sourcePath, fileName);
  const path = normalizePath(requested);
  // normalizePath turns "/" into "" (and "./" likewise); a non-empty setting that ends up empty means the root.
  if (!path || path === '/') return app.vault.getRoot();
  const existing = app.vault.getFolderByPath(path);
  if (existing) return existing;
  if (app.vault.getAbstractFileByPath(path)) throw new Error(`作成先「${path}」はフォルダではありません。設定の「新規マップの作成先フォルダ」を確認してください。`);
  return app.vault.createFolder(path);
}

/** Create without overwriting, in the configured folder (or Obsidian's), with the configured layout. */
export async function createMindmapFile(app: App, sourcePath: string, options: NewMapOptions = {}): Promise<TFile> {
  const requestedName = `${UNTITLED}.md`;
  const parent = await resolveNewMapFolder(app, options.folder ?? '', sourcePath, requestedName);
  let index = 1;
  let title = UNTITLED;
  let path = childPath(parent.path, `${title}.md`);
  while (app.vault.getAbstractFileByPath(path)) {
    index += 1;
    title = `${UNTITLED} ${index}`;
    path = childPath(parent.path, `${title}.md`);
  }
  return app.vault.create(path, newMindmapSource(title, options.layout));
}
