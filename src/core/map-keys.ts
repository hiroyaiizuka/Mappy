/**
 * Frontmatter keys of a map note, shared by the metadata-cache reader
 * (`src/obsidian/frontmatter.ts`) and the text reader (`src/core/embed.ts`), so
 * both decide the same way. Free-topic positions have their own key in topics.ts.
 */

/** Canonical identity marker. Only the YAML boolean `true` claims a Markdown note. */
export const MAPPY_KEY = 'mappy';
/** Optional presentation preference. Its absence means the regular mindmap. */
export const LAYOUT_KEY = 'mappy-layout';
/** Excalidraw drawings are Markdown too; never claim them. */
export const EXCALIDRAW_KEY = 'excalidraw-plugin';
