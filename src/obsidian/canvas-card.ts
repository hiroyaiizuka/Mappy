import { TFile, type App, type WorkspaceLeaf } from 'obsidian';

/** Obsidian's class for the element a Canvas file card renders its note into (the card's embed container). */
export const CANVAS_CONTENT_CLASS = 'canvas-node-content';
/** The card element around the content and its cover, where Canvas listens for the double click that edits the card. */
const CANVAS_CARD_CLASS = 'canvas-node-container';

/** A file card of an open Canvas (§5 M10, LEV-348). */
export interface CanvasCard {
  file: TFile;
  /** The heading path the card narrows to (`#A#B`), '' for the whole note. */
  subpath: string;
  /** The card element (`.canvas-node-container`) around the content. */
  el: HTMLElement;
  /** The canvas's own leaf. */
  leaf: WorkspaceLeaf;
}

/**
 * The card whose embed renders into `content` (a `.canvas-node-content` on the document), read from its canvas's
 * own node list. Canvas has no public API for its nodes: its view keeps `canvas.nodes`, a Map whose file nodes
 * carry `file`, `subpath` and the `contentEl` their embed renders into (Obsidian 1.14.4 app.js, the file node's
 * `render`). Every member is checked before it is used, and any other shape — or a card no canvas leaf holds (a
 * canvas embedded in a note, a hover preview) — is null: the card stays Obsidian's.
 */
export function canvasCard(app: App, content: HTMLElement): CanvasCard | null {
  const el = content.parentElement;
  if (!el?.hasClass(CANVAS_CARD_CLASS)) return null;
  for (const leaf of app.workspace.getLeavesOfType('canvas')) {
    if (!leaf.view.containerEl.contains(content)) continue;
    const nodes = (leaf.view as { canvas?: { nodes?: unknown } }).canvas?.nodes;
    if (!(nodes instanceof Map)) return null;
    for (const node of (nodes as Map<unknown, unknown>).values()) {
      if (!node || typeof node !== 'object' || (node as { contentEl?: unknown }).contentEl !== content) continue;
      const { file, subpath } = node as { file?: unknown; subpath?: unknown };
      return file instanceof TFile ? { file, subpath: typeof subpath === 'string' ? subpath : '', el, leaf } : null;
    }
    return null;
  }
  return null;
}

/**
 * Opens a card's note as a map beside its canvas (LEV-348): a map tab already on that note outside the canvas's own
 * tab group is brought forward, else a new split to the canvas's right opens it (the router makes a `mappy: true`
 * note a map, architecture.md §8). A `#heading` card selects that heading's node, as a link to it does (the view's
 * `subpath`), and the keys go to the map.
 */
export async function openMapBeside(app: App, card: Pick<CanvasCard, 'file' | 'subpath' | 'leaf'>, mapViewType: string): Promise<void> {
  const { workspace } = app;
  const eState = card.subpath ? { subpath: card.subpath, focus: true } : { focus: true };
  // By the view state, so a tab restored in the background (Obsidian's deferred view, no `view.file` yet) counts too.
  const shown = workspace.getLeavesOfType(mapViewType)
    .find(leaf => leaf.parent !== card.leaf.parent && leaf.getViewState().state?.file === card.file.path);
  if (shown) {
    await workspace.revealLeaf(shown);
    workspace.setActiveLeaf(shown, { focus: true });
    shown.setEphemeralState(eState);
    return;
  }
  await workspace.createLeafBySplit(card.leaf, 'vertical').openFile(card.file, { active: true, eState });
}
