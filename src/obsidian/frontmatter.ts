import type { App, TFile } from 'obsidian';
import { MEMOS_KEY } from '../core/memo';

/** Canonical identity marker. Only the YAML boolean `true` claims a Markdown note. */
export const MAPPY_KEY = 'mappy';
/** Optional presentation preference. Its absence means the regular mindmap. */
export const LAYOUT_KEY = 'mappy-layout';
/** Memo positions by layout (M7). Memo text stays in the note body, so removing the key loses no words. */
export { MEMOS_KEY };
/** Excalidraw drawings are Markdown too; never claim them. */
const EXCALIDRAW_KEY = 'excalidraw-plugin';

export type MapLayout = 'mindmap' | 'timeline';

/** Layout never determines whether a file is a map. Unknown values use the safe default. */
export function layoutFromFrontmatter(value: unknown): MapLayout {
  return typeof value === 'string' && value.trim().toLowerCase() === 'timeline' ? 'timeline' : 'mindmap';
}

function frontmatter(app: App, file: TFile): Record<string, unknown> | undefined {
  return app.metadataCache.getFileCache(file)?.frontmatter;
}

/** Markdown drawings owned by another plugin must not be converted or routed. */
export function isMappyCandidate(app: App, file: TFile): boolean {
  return file.extension === 'md' && frontmatter(app, file)?.[EXCALIDRAW_KEY] === undefined;
}

export function readMapLayout(app: App, file: TFile): MapLayout | null {
  const properties = frontmatter(app, file);
  if (file.extension !== 'md' || !properties || properties[EXCALIDRAW_KEY] !== undefined || properties[MAPPY_KEY] !== true) return null;
  return layoutFromFrontmatter(properties[LAYOUT_KEY]);
}

/** Preserve the old layout value when a user explicitly converts a legacy note. */
export function readPreferredMapLayout(app: App, file: TFile): MapLayout {
  return layoutFromFrontmatter(frontmatter(app, file)?.[LAYOUT_KEY]);
}

/** Explicit conversion, removal, or layout selection. Obsidian's atomic frontmatter path handles open editors. */
export function writeMapLayout(app: App, file: TFile, layout: MapLayout | null): Promise<void> {
  return app.fileManager.processFrontMatter(file, (properties: Record<string, unknown>) => {
    if (layout) {
      properties[MAPPY_KEY] = true;
      if (layout === 'timeline') properties[LAYOUT_KEY] = layout;
      else delete properties[LAYOUT_KEY];
    } else {
      delete properties[MAPPY_KEY];
      delete properties[LAYOUT_KEY];
      delete properties[MEMOS_KEY];
    }
  });
}
