import type { App, TFile } from 'obsidian';

/** Reserved property: its presence opens the note as a map; its value picks the layout. */
export const LAYOUT_KEY = 'mappy-layout';
/** Excalidraw drawings are Markdown too; never claim them. */
const EXCALIDRAW_KEY = 'excalidraw-plugin';

export type MapLayout = 'mindmap' | 'timeline';

/** Interpret a frontmatter value; unknown truthy values still mean "open as a map". */
export function layoutFromFrontmatter(value: unknown): MapLayout | null {
  if (value === undefined || value === null || value === false || value === '') return null;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'timeline') return 'timeline';
    if (normalized === '' || normalized === 'false' || normalized === 'off' || normalized === 'no') return null;
    return 'mindmap';
  }
  return value ? 'mindmap' : null;
}

export function readMapLayout(app: App, file: TFile): MapLayout | null {
  const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
  if (!frontmatter || frontmatter[EXCALIDRAW_KEY] !== undefined) return null;
  return layoutFromFrontmatter(frontmatter[LAYOUT_KEY]);
}

/** Explicit command only; viewing never writes. Obsidian's atomic frontmatter path handles open editors. */
export function writeMapLayout(app: App, file: TFile, layout: MapLayout | null): Promise<void> {
  return app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
    if (layout) frontmatter[LAYOUT_KEY] = layout;
    else delete frontmatter[LAYOUT_KEY];
  });
}
