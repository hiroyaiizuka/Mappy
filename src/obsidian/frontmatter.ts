import type { App, TFile } from 'obsidian';
import { TOPICS_KEY } from '../core/topics';
import { isLayoutMode, layoutFromValue, type LayoutMode } from '../core/layout-mode';
import { EXCALIDRAW_KEY, LAYOUT_KEY, MAPPY_KEY } from '../core/map-keys';

/** The keys live in core (`map-keys.ts`) so the text reader of embeds decides the same way. */
export { MAPPY_KEY, LAYOUT_KEY };
/** Free-topic positions by layout (M7). The topics' text stays in the note body, so removing the key loses no words. */
export { TOPICS_KEY };

/** A frontmatter value naming a layout, tolerant of case and surrounding space; anything else is null. */
function parseLayout(value: unknown): LayoutMode | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value;
  return isLayoutMode(normalized) ? normalized : null;
}

/** Layout never determines whether a file is a map. Unknown values use the safe default. */
export const layoutFromFrontmatter = layoutFromValue;

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

/**
 * The layout an explicit conversion writes: a legacy note keeps its own `mappy-layout`,
 * any other note gets the fallback (the settings' default layout, M14).
 */
export function readPreferredMapLayout(app: App, file: TFile, fallback: LayoutMode = 'mindmap'): LayoutMode {
  return parseLayout(frontmatter(app, file)?.[LAYOUT_KEY]) ?? fallback;
}

/** Explicit conversion or removal (a layout button writes through the map view's own path: `planMapLayout`). Obsidian's atomic frontmatter path handles open editors. */
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
