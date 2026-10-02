import type { App, TFile } from "obsidian";
import type { LayoutMode } from "../layout/layout";
import { readMapLayout } from "./frontmatter";

/** The ribbon button's two routes; each reports its own failure. */
export interface RibbonRoutes {
  open(file: TFile, layout: LayoutMode): void;
  create(): void;
}

/**
 * The ribbon button (LEV-300): the active map note opens as a map; anything else (a note that is not a map, an
 * Excalidraw drawing, a file that is not Markdown, nothing open) gets a new untitled map, as the "Create new mind
 * map" command does. The active note is never converted: that stays an explicit command.
 */
export function runRibbon(app: App, file: TFile | null, routes: RibbonRoutes): void {
  const layout = file ? readMapLayout(app, file) : null;
  if (file && layout) routes.open(file, layout);
  else routes.create();
}
