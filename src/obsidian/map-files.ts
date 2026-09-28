import { TFolder, normalizePath, type App, type TAbstractFile, type TFile } from 'obsidian';
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

/**
 * The children of `folder` named `segment` ignoring case, folders before files and each in its exact name first: a
 * vault synced from a case-sensitive system can hold `Maps/`, `MAPS/2026` and a file `maps` side by side.
 */
function childrenNamed(folder: TFolder, segment: string): TAbstractFile[] {
  const lower = segment.toLowerCase();
  const rank = (child: TAbstractFile) => (child instanceof TFolder ? 0 : 2) + (child.name === segment ? 0 : 1);
  return folder.children.filter(child => child.name.toLowerCase() === lower).sort((left, right) => rank(left) - rank(right));
}

/** What one walk down the setting's path finds: the entry at the whole path, and how far existing folders reach. */
interface Walk {
  /** At the whole path ignoring case, a folder in any branch before a file in any branch; null when nothing is there. */
  found: TAbstractFile | null;
  /** The deepest existing folder along the path, and how many segments it covers. */
  deepest: { folder: TFolder; depth: number };
  /** A file stands where a folder of the path would have to go (a segment before the last names a file). */
  blocked: boolean;
}

/**
 * One walk down from the root through each folder's own children, instead of listing the vault (LEV-253: the community
 * scan flags every listing). Every branch whose names match ignoring case is tried, so a vault synced from a
 * case-sensitive system (`Maps/x` a file, `maps/x` a folder) resolves to the folder. `metadataCache.getFirstLinkpathDest`
 * is no substitute: it resolves notes by link, not folders.
 */
function walkIgnoringCase(root: TFolder, segments: string[]): Walk {
  const walk: Walk = { found: null, deepest: { folder: root, depth: 0 }, blocked: false };
  const visit = (folder: TFolder, depth: number): void => {
    if (depth > walk.deepest.depth) walk.deepest = { folder, depth };
    for (const child of childrenNamed(folder, segments[depth] ?? '')) {
      if (depth === segments.length - 1) {
        if (!walk.found || (child instanceof TFolder && !(walk.found instanceof TFolder))) walk.found = child;
      } else if (child instanceof TFolder) visit(child, depth + 1);
      else walk.blocked = true;
      if (walk.found instanceof TFolder) return;
    }
  };
  visit(root, 0);
  return walk;
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
  const exact = app.vault.getAbstractFileByPath(path);
  if (exact instanceof TFolder) return exact;
  const segments = path.split('/');
  const walk = walkIgnoringCase(app.vault.getRoot(), segments);
  if (walk.found instanceof TFolder) return walk.found;
  // A file of the name, or a file where one of its folders would go, blocks it: creating through a file only fails later.
  if (walk.found ?? exact ?? walk.blocked) throw badFolder(path, 'folderIsFile');
  // Only what is missing takes the setting's spelling: `maps/2027` under an existing `Maps` is `Maps/2027`, not a
  // second parent differing in case in the vault's index.
  const { folder: known, depth } = walk.deepest;
  const created: TFolder | null = await app.vault.createFolder(childPath(known.path, segments.slice(depth).join('/')));
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
