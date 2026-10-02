import type { App, TFile } from "obsidian";
import type { LayoutMode } from "../layout/layout";
import { isLegacyMapNote, readMapLayout } from "./frontmatter";

/** The ribbon button's routes; each reports its own failure. */
export interface RibbonRoutes {
  open(file: TFile, layout: LayoutMode): void;
  create(): void;
  /** The active note is not indexed yet, so whether it is a map is not known. */
  notReady(): void;
  /** The active note is a map of the old format: the conversion keeps its layout. */
  convertFirst(): void;
}

/**
 * The ribbon button (LEV-300): the active map note opens as a map; anything else (a note that is not a map, an
 * Excalidraw drawing, nothing open — `activeFile()` gives null for a file that is not Markdown) gets a new untitled map,
 * as the "Create new mind map" command does. The active note is never converted: that stays an explicit command.
 * A note the metadata cache has not read yet (Obsidian still indexing at startup; a note made a moment ago, which
 * Obsidian 1.14.2 indexes within ~50 ms) is neither: making a map for it would write a note the user did not ask for.
 * A note of the old format (`mappy-layout` alone) is the user's map from before `mappy: true`: the button points to its
 * conversion, as it did through 0.4.5, rather than make a new map beside it.
 */
export function runRibbon(app: App, file: TFile | null, routes: RibbonRoutes): void {
  if (file && !app.metadataCache.getFileCache(file)) return routes.notReady();
  const layout = file ? readMapLayout(app, file) : null;
  if (file && layout) routes.open(file, layout);
  else if (file && isLegacyMapNote(app, file)) routes.convertFirst();
  else routes.create();
}
