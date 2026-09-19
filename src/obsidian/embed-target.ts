import { parseLinktext, type App, type TFile } from 'obsidian';
import { isBlockReference } from '../core/embed';
import { readMapLayout } from './frontmatter';

/** A map note an embed points at, with the heading path (`#A#B`) it asks for; `''` for the whole note. */
export interface EmbedTarget {
  file: TFile;
  subpath: string;
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
  if (!file || readMapLayout(app, file) === null) return null;
  return { file, subpath };
}
