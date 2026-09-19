import { parseLinktext, type App, type TFile } from 'obsidian';
import { isBlockReference } from '../core/embed';
import { readMapLayout } from './frontmatter';

/** A map note an embed points at, with the heading path (`#A#B`) it asks for; `''` for the whole note. */
export interface EmbedTarget {
  file: TFile;
  subpath: string;
}

/**
 * A note an embed or the map search (§5 M12) may show as a map: a Markdown file whose
 * cached frontmatter has the boolean `mappy: true` (not the string `"true"`, not an
 * Excalidraw drawing). The same verdict as opening it as a map.
 */
export function isMapNote(app: App, file: TFile): boolean {
  return readMapLayout(app, file) !== null;
}

/**
 * The map note behind an `.internal-embed` src, resolved from the host note like
 * any link. Null leaves the embed to Obsidian: a missing note, a note without
 * `mappy: true` (or with the string `"true"`), a non-Markdown file, a block reference.
 */
export function resolveEmbedTarget(app: App, linktext: string, sourcePath: string): EmbedTarget | null {
  const { path, subpath } = parseLinktext(linktext);
  if (isBlockReference(subpath)) return null;
  const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
  if (!file || !isMapNote(app, file)) return null;
  return { file, subpath };
}
