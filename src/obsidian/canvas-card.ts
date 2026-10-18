import { TextFileView, type App, type TFile, type WorkspaceLeaf } from 'obsidian';
import type { CanvasFileData } from 'obsidian/canvas';

/** Obsidian's class for the element a Canvas file card renders its note into (the card's embed container). */
export const CANVAS_CONTENT_CLASS = 'canvas-node-content';
/** The card element around the content and its cover, where Canvas listens for the double click that edits the card. */
const CANVAS_CARD_CLASS = 'canvas-node-container';
/** The card itself, placed on the board by its inline `transform`, `width` and `height` (the node's x, y, width, height). */
const CANVAS_NODE_CLASS = 'canvas-node';

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

/** The file cards of a canvas's saved data, parsed once per text. */
const parsed = new WeakMap<TextFileView, { text: string; cards: CanvasFileData[] }>();

function fileCards(view: TextFileView): CanvasFileData[] {
  const text = view.getViewData();
  const known = parsed.get(view);
  if (known?.text === text) return known.cards;
  let cards: CanvasFileData[] = [];
  try {
    const data = JSON.parse(text) as { nodes?: unknown };
    if (Array.isArray(data.nodes)) {
      cards = data.nodes.filter((node): node is CanvasFileData => !!node && typeof node === 'object'
        && (node as { type?: unknown }).type === 'file' && typeof (node as { file?: unknown }).file === 'string');
    }
  } catch {
    cards = [];
  }
  parsed.set(view, { text, cards });
  return cards;
}

/** Where Canvas placed a card: the numbers of its inline style, which Canvas writes from the node's own. */
function placed(node: HTMLElement): { x: number; y: number; width: number; height: number } | null {
  const at = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/u.exec(node.style.transform);
  const width = parseFloat(node.style.width);
  const height = parseFloat(node.style.height);
  return at && Number.isFinite(width) && Number.isFinite(height) ? { x: Number(at[1]), y: Number(at[2]), width, height } : null;
}

/**
 * The card of `note` whose embed renders into `content` (a `.canvas-node-content` on the document). Canvas does not
 * write the card's heading path into the DOM, so it is read from the canvas's data (`TextFileView.getViewData`, the
 * `.canvas` JSON Canvas saves as soon as it adds or retargets a card), among the file cards of that note: the one heading
 * path they all share, else the card at this card's place and size. Null — the card stays Obsidian's — for a card no
 * open canvas leaf holds (a canvas embedded in a note, a hover preview), a DOM that is not Canvas's card, or cards of the
 * note with different heading paths none of which sits exactly here.
 */
export function canvasCard(app: App, content: HTMLElement, note: TFile): CanvasCard | null {
  const el = content.parentElement;
  const node = el?.parentElement;
  if (!el?.hasClass(CANVAS_CARD_CLASS) || !node?.hasClass(CANVAS_NODE_CLASS)) return null;
  for (const leaf of app.workspace.getLeavesOfType('canvas')) {
    const view = leaf.view;
    if (!(view instanceof TextFileView) || !view.containerEl.contains(content)) continue;
    const cards = fileCards(view).filter(card => card.file === note.path);
    const subpaths = new Set(cards.map(card => card.subpath ?? ''));
    if (subpaths.size === 1) return { file: note, subpath: [...subpaths][0] ?? '', el, leaf };
    const at = placed(node);
    const here = at ? cards.filter(card => card.x === at.x && card.y === at.y && card.width === at.width && card.height === at.height) : [];
    const subpath = here.length > 0 && new Set(here.map(card => card.subpath ?? '')).size === 1 ? here[0]?.subpath ?? '' : null;
    return subpath === null ? null : { file: note, subpath, el, leaf };
  }
  return null;
}

/** The note being opened beside a canvas right now, by path: a second call while it opens is the same open. */
const opening = new Map<string, Promise<void>>();

/**
 * Opens a card's note as a map beside its canvas (LEV-348): a map tab already on that note outside the canvas's own
 * tab group is brought forward, else a new split to the canvas's right opens it (the router makes a `mappy: true`
 * note a map, architecture.md §8). A `#heading` card selects that heading's node, as a link to it does (the view's
 * `subpath`), and the keys go to the map. Two calls for the same note before the first has opened it (the two clicks of
 * a double click on the open button) open it once: the new split has no map to be found by until it does.
 */
export function openMapBeside(app: App, card: Pick<CanvasCard, 'file' | 'subpath' | 'leaf'>, mapViewType: string): Promise<void> {
  const key = card.file.path;
  const pending = opening.get(key);
  if (pending) return pending;
  const run = openBeside(app, card, mapViewType).finally(() => { opening.delete(key); });
  opening.set(key, run);
  return run;
}

async function openBeside(app: App, card: Pick<CanvasCard, 'file' | 'subpath' | 'leaf'>, mapViewType: string): Promise<void> {
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
