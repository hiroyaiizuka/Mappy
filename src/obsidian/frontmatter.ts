import type { App, TFile } from 'obsidian';
import { TOPICS_KEY } from '../core/topics';
import { layoutFromValue, type LayoutMode } from '../core/layout-mode';

/** Canonical identity marker. Only the YAML boolean `true` claims a Markdown note. */
export const MAPPY_KEY = 'mappy';
/** Optional presentation preference. Its absence means the regular mindmap. */
export const LAYOUT_KEY = 'mappy-layout';
/** Free-topic positions by layout (M7). The topics' text stays in the note body, so removing the key loses no words. */
export { TOPICS_KEY };
/** Excalidraw drawings are Markdown too; never claim them. */
const EXCALIDRAW_KEY = 'excalidraw-plugin';

/** Layout never determines whether a file is a map. Unknown values use the safe default. */
export function layoutFromFrontmatter(value: unknown): LayoutMode {
  return layoutFromValue(value);
}

function frontmatter(app: App, file: TFile): Record<string, unknown> | undefined {
  return app.metadataCache.getFileCache(file)?.frontmatter;
}

/** Markdown drawings owned by another plugin must not be converted or routed. */
export function isMappyCandidate(app: App, file: TFile): boolean {
  return file.extension === 'md' && frontmatter(app, file)?.[EXCALIDRAW_KEY] === undefined;
}

export function readMapLayout(app: App, file: TFile): LayoutMode | null {
  const properties = frontmatter(app, file);
  if (file.extension !== 'md' || !properties || properties[EXCALIDRAW_KEY] !== undefined || properties[MAPPY_KEY] !== true) return null;
  return layoutFromFrontmatter(properties[LAYOUT_KEY]);
}

/** Preserve the old layout value when a user explicitly converts a legacy note. */
export function readPreferredMapLayout(app: App, file: TFile): LayoutMode {
  return layoutFromFrontmatter(frontmatter(app, file)?.[LAYOUT_KEY]);
}

/** Explicit conversion, removal, or layout selection. Obsidian's atomic frontmatter path handles open editors. */
export function writeMapLayout(app: App, file: TFile, layout: LayoutMode | null): Promise<void> {
  return app.fileManager.processFrontMatter(file, (properties: Record<string, unknown>) => {
    if (layout) {
      properties[MAPPY_KEY] = true;
      // The regular map is the default, so only the other layouts are written down.
      if (layout !== 'mindmap') properties[LAYOUT_KEY] = layout;
      else delete properties[LAYOUT_KEY];
    } else {
      delete properties[MAPPY_KEY];
      delete properties[LAYOUT_KEY];
      delete properties[TOPICS_KEY];
    }
  });
}
