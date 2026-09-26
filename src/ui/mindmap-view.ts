import { FileView, MarkdownView, Menu, Notice, Scope, TFile, setIcon, type TAbstractFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { parseMarkdown, projectMap, type MindDocument, type MindNode } from "../core/markdown";
import { applyEdits, planEdit, resolveDrop, type EditCommand, type MoveCommand, type TextEdit } from "../core/commands";
import { findNode, getNode, nodeAt } from "../core/text-edits";
import { planMapLayout } from "../core/layout-key";
import { nodeBody, planBodyEdit, planAppendBody } from "../core/body";
import { initialCallFolds, isCalledNode, projectShown, type CallSource, type CallTargets, type ShownTrees } from "../core/calls";
import { embedOnlyTitle } from "../core/embed";
import { displayTitle } from "../core/title-breaks";
import { planListConversion } from "../core/list-conversion";
import { locateSubpath } from "../core/subpath";
import { planTopicMoves, readTopicPositions, topicKeys, type TopicPosition, type TopicPositionMap } from "../core/topics";
import type { CaptureSource } from "../export/svg-capture";
import type { Viewport } from "../interaction/viewport";
import { LAYOUT_LABELS, LAYOUT_MODES, axisBand, isLayoutMode, layoutTree, type FreeTopicLayout, type LayoutMode, type LayoutNode, type LayoutPoint, type LayoutResult, type PositionedNode } from "../layout/layout";
import { PLACEHOLDER_ID, previewTree } from "../layout/drop-preview";
import { balancedSideOf, snapSlot, type NodePlace, type SnapSlot } from "../layout/snap";
import { DocumentStore, conflictMessage, type CarriedWrite, type LatestWrite } from "../obsidian/document-store";
import { resolveEmbedTarget } from "../obsidian/embed-target";
import { readMapLayout } from "../obsidian/frontmatter";
import { CallReader, sameTargets } from "../obsidian/map-calls";
import type { MapTheme } from "../obsidian/settings";
import { exportMap, type ExportFormat } from "../obsidian/image-export";
import type { ViewRouter } from "../obsidian/view-routing";
import { EditModal } from "./edit-modal";
import { NodeRenderer } from "./node-renderer";
import { MapViewport } from "./map-viewport";
import { MapEvents, nodeOf } from "./map-events";
import { NodeDrag, type DragDelta } from "./node-drag";
import { InlineEditor } from "./inline-editor";
import { LinkSuggest } from "./link-suggest";

export const VIEW_TYPE = "mappy-map";

/** The slot shown now wins over a new one unless the new one is clearly closer, so a shifting layout does not flip the preview. */
const SNAP_STICK = 16;

const NOTE_CHANGED_MESSAGE = "対象のノートが変わりました。元のノートを開いて再実行してください。";
/**
 * How long the export waits for Markdown renders still in flight without one of them finishing (§5 M13): a title
 * renders in milliseconds, so this only ends the wait when a render hangs (a post-processor, an embed that never
 * resolves); the export then goes on with what the map shows, as the map itself does, and says so.
 */
export const EXPORT_RENDER_WAIT_MS = 2000;
export const EXPORT_RENDER_STALLED_MESSAGE = "描画が終わらないノードがあるため、画面に見えているまま書き出します。";
/** How long a topic added right after a confirmed draft waits for the labels to render before it is measured. */
const TOPIC_RENDER_WAIT_MS = 300;
/** A draft whose node is no longer in the note: the one thing the user can do is pick a node again. */
export const NODE_GONE_MESSAGE = "編集していたノードが Markdown 側で見つかりません。マップでノードを選び直してください。";
/**
 * The provisional names a node added on the map is written with, selected in its inline editor so that typing
 * replaces them (LEV-203, as MarkMind): a child or sibling (Tab／Enter), and a free topic (the empty canvas).
 */
export const NEW_NODE_TITLE = "サブトピック";
export const NEW_TOPIC_TITLE = "トピック";
/** What every edit of a node drawn from a called map answers with (§5 M12); the node's own note is where it is edited. */
export const CALLED_READ_ONLY_MESSAGE = "呼び出したマップは読み取り専用です。ダブルクリックで元のマップを開けます。";

/** What a draft edits: the node's title and body as one string (a title never holds a newline), compared before a kept draft is retried. */
function draftFingerprint(document: MindDocument, node: MindNode): string {
  return `${node.title}\n${nodeBody(document, node)}`;
}

/**
 * What an open draft is on: the node it edits and that node's text when the draft last agreed with the
 * note (`draftFingerprint`). A save refuses when the two no longer agree, so the draft cannot overwrite
 * someone else's edit (E05). The text is re-based after the map's own writes — an image the user pasted
 * into the node being edited is not someone else's edit (LEV-140) — while the id needs no re-basing:
 * a write of this view's own carries every node's id across the re-parse (`ownWrites`, LEV-146).
 */
interface DraftBase { nodeId: string; value: string }

/**
 * A write this view made: what the note read before it, what it wrote, and the edits between. The re-parse
 * that follows takes them so the nodes keep their ids — nothing else carries a node whose title repeats or
 * is empty (LEV-146) — and it is used once, for the read that finds exactly that text, or a text a run of
 * such writes led to from the one the view last parsed (a draft saved by the blur of the click on a layout
 * button, then the button's own write — LEV-150): anything else means someone else has written, and then the
 * ids are as much of a guess as E05 says they are. The layout buttons' writes are among them (LEV-196), this view's
 * own and those the store carried one of its edits over (`recordCarried`), from whichever view they came.
 */
interface OwnWrite {
  readonly before: string;
  readonly after: string;
  readonly edits: readonly TextEdit[];
  /** `after` parsed from a document with these edits, kept so a replay and a draft's base do not parse it again (`parseOwn`). */
  parsed?: { from: MindDocument; basename: string; document: MindDocument };
}

/** A node the view has just added for the inline editor to name (LEV-203): the write that added it, and the node selected before. */
interface Created {
  readonly write: LatestWrite;
  readonly previous: string | null;
  /** The provisional name the node was written with: a draft still holding it is untouched. */
  readonly name: string;
  /** The folds before the addition (revealing the new node opens its parent) and the viewport (revealing it can pan). */
  readonly collapsed: ReadonlySet<string>;
  readonly viewport: Viewport;
}

/** The snap's index of a drag's base layout; see `MindmapView.snapIndex`. */
interface SnapIndex {
  byId: ReadonlyMap<string, PositionedNode>;
  children: ReadonlyMap<string, readonly PositionedNode[]>;
  places: ReadonlyMap<string, NodePlace>;
}

/**
 * Whether two readings of the node sizes describe the same map. The layout measures the DOM again on
 * every frame and nothing announces a change it did not ask for (a theme class, a font arriving), so a
 * drag's kept snap index is only carried over while the sizes behind it still hold (LEV-126).
 */
function sameSizes(
  before: ReadonlyMap<string, { width: number; height: number }>,
  after: ReadonlyMap<string, { width: number; height: number }>,
): boolean {
  if (before.size !== after.size) return false;
  for (const [id, size] of after) {
    const was = before.get(id);
    if (!was || was.width !== size.width || was.height !== size.height) return false;
  }
  return true;
}

/** Where the roots of `ids` sit in `layout`, relative to its origin: the offsets `FreeTopicLayout.position` carries. One pass over the nodes. */
function rootOffsets(layout: LayoutResult, ids: Iterable<string>): Map<string, TopicPosition> {
  const wanted = new Set(ids);
  const offsets = new Map<string, TopicPosition>();
  for (const node of layout.nodes) {
    if (wanted.has(node.id)) offsets.set(node.id, { x: node.x - layout.origin.x, y: node.y - layout.origin.y });
  }
  return offsets;
}

/** One button per layout, in LAYOUT_MODES order, named as LAYOUT_LABELS names it; the Record keeps the list and the buttons in step. */
const LAYOUT_BUTTONS: Record<LayoutMode, { label: string; icon: string }> = {
  mindmap: { label: LAYOUT_LABELS.mindmap, icon: "git-fork" },
  timeline: { label: LAYOUT_LABELS.timeline, icon: "git-commit-horizontal" },
  hierarchy: { label: LAYOUT_LABELS.hierarchy, icon: "network" },
  balanced: { label: LAYOUT_LABELS.balanced, icon: "unfold-horizontal" },
};

/**
 * An item the plugin adds to the view's 操作 popover (§5 M3): a command whose route (a modal, another
 * plugin) lives outside the view. `description` is the one line under the title. `check` is asked when
 * the popover opens and decides whether the item is enabled; `run` is the command's own callback, so
 * the popover and the palette do the same thing.
 */
export interface MapMenuAction {
  title: string;
  description: string;
  icon: string;
  check: (view: MindmapView) => boolean;
  run: (view: MindmapView) => void;
}

/** An entry of the context menu: the title, the icon and what choosing it runs. */
type MenuEntry = readonly [title: string, icon: string, run: () => void];

/** The 操作 popover's card (§5 M3): its widest, the gap under the gear, and the least the pane keeps to its left. */
const POPOVER_MAX_WIDTH = 320;
const POPOVER_GAP = 6;
const POPOVER_MARGIN = 16;

/**
 * The map is a `FileView` (LEV-89), as the Markdown editor, Kanban or a PDF are: the note it shows is `file`, which
 * Obsidian reads through `getActiveFileView()` while the map is active — the core file commands (copy path, delete,
 * move, reveal in the explorer, open with the default app...) address the map's own note, `file-open` carries it to
 * the outline, the backlinks and the properties sidebars and to the recent files, and a linked tab group keeps a
 * map in step. `allowNoFile` stays false, so a leaf whose note is gone (deleted, or a state naming nothing the map
 * can show) goes back in its history or to the empty view, as a Markdown tab does, instead of an empty map.
 * `canAcceptExtension` stays FileView's (false): `WorkspaceLeaf.openFile` keeps a FileView that accepts the extension
 * instead of asking the view registry, and a map claiming `md` would make the `ViewRouter` demote every plain note
 * opened into a map leaf and remember that leaf as a Markdown one. Declining, every open goes through Markdown's
 * registration and the router decides (§8), as for any other leaf: a map note opens as a map, a note that is no
 * longer one as Markdown, and a leaf switched to Markdown on purpose stays there (E22), with nothing new recorded.
 * Not an `EditableFileView`: 1.14.2 makes the view header's title editable there and renames the note to whatever
 * it shows, which the ` · マップ` suffix would end up in.
 */
export class MindmapView extends FileView {
  /** The note shown; loaded and unloaded by `FileView.setState`, which calls `onUnloadFile` below (`onLoadFile` is FileView's own). */
  file: TFile | null = null;
  private document: MindDocument | undefined;
  /** The maps the document's items call (§5 M12), as last read; the trees are projected from the document and these. */
  private targets: CallTargets = new Map();
  /** Reads the called notes; one parse per note, identity kept across edits of them. */
  private readonly reader: CallReader;
  /** Ids of the called nodes the view has shown; a call new to it starts folded below the called root's children. */
  private knownCalled = new Set<string>();
  private recallTimer: number | undefined;
  /**
   * The trees on the map (§5 M7, M12): the body root and the free topics as written (`split`) and with the called
   * maps grafted in (`calls`), plus the stored topic positions and each topic's key into them (`topicKeys`: the
   * heading, or `<heading> (n)` for a repeated one); derived once per document and targets, in `adopt`.
   */
  private projected: { document: MindDocument; targets: CallTargets; trees: ShownTrees; positions: TopicPositionMap; keys: Map<string, string> } | undefined;
  private selectedId: string | null = null;
  /**
   * True after a click on the empty canvas: nothing is selected, and draws keep it so until a node is selected
   * again (otherwise a draw with no valid selection falls back to the first node, as when a note opens). A call
   * with nothing selected adds the map as a free topic (§5 M12).
   */
  private deselected = false;
  /**
   * Writes of this view's own still being prepared (a file to store first, as `attachImage` does): each will write
   * onto the note as the map shows it now, so nothing may take that note back meanwhile (`retract`, LEV-203). A
   * write that awaits anything before `commit` counts itself here through `preparing`.
   */
  private prepared = 0;
  private collapsed = new Set<string>();
  private mode: LayoutMode = "mindmap";
  private theme: MapTheme = "follow";
  /** The settings' bottom-left buttons (M14); the layout on screen shows its button regardless. */
  private visibleLayouts: readonly LayoutMode[] = LAYOUT_MODES;
  private canvas!: HTMLDivElement;
  private svg!: SVGSVGElement;
  private emptyState!: HTMLDivElement;
  private zoomLabel!: HTMLButtonElement;
  private renderer!: NodeRenderer;
  private viewport!: MapViewport;
  private nodeDrag!: NodeDrag;
  /** The canvas listeners, which also answer the view's scope; set with the DOM in `onOpen`. */
  private events: MapEvents | undefined;
  private modeButtons = new Map<LayoutMode, HTMLButtonElement>();
  private layout: LayoutResult | undefined;
  /**
   * The latest layout laid out without a placeholder, with the note and mode it was laid out for. It is
   * what holds the unpositioned topics in place (`topicLayouts`): while a placeholder is laid out (LEV-95)
   * and, in every layout, for the whole of a topic's drag (LEV-117 for the map and the balanced map,
   * LEV-125 for the timeline and the hierarchy), a topic with no position of its own keeps the slot this
   * layout stacked it in, so neither the placeholder nor the moving tree restacks the column it is about
   * to join. A layout of another note or mode measures from a different origin and holds nothing, which
   * is also what re-bases the hold when the layout is switched mid-drag.
   */
  private plain: { file: TFile | null; mode: LayoutMode; layout: LayoutResult } | undefined;
  private placeholder!: HTMLDivElement;
  private edgePaths = new Map<string, SVGPathElement>();
  private dropPreview: MoveCommand | null = null;
  /**
   * A free tree following the pointer: the dragged root, and where each affected topic started and where
   * it shows now (origin-relative). Dragging the body moves it against its topics: they keep their place
   * on screen while the viewport follows the pointer.
   */
  private topicDrag: {
    id: string; body: boolean; from: Map<string, TopicPosition>; overrides: Map<string, TopicPosition>;
    /**
     * The viewport the pointer's travel is measured under: the map's own for a topic, and for the body the one its
     * topics are seen under (the map's own is that one panned by the body's travel). The press viewport until
     * something else moves the view mid-drag (`viewportMoved`, LEV-194).
     */
    view: Viewport;
    /** The pointer's travel now (screen pixels since the press), and what the tree's travel in world units is offset by (`travelled`). */
    delta: DragDelta; offset: LayoutPoint;
    /** Node ids marked as moving; cleared by id, since a joined topic keeps its element under a new tree. */
    marked: string[];
    /**
     * The latest layout of this drag without a placeholder: what the snap judges against, so the slot
     * it shows cannot shift the nodes it is judged by (a placeholder re-centres a hierarchy row and
     * pushes a timeline stage past a forest).
     */
    base: LayoutResult;
    /** The node sizes `base` was laid out with; the layout re-reads them from the DOM on every frame. */
    sizes: ReadonlyMap<string, { width: number; height: number }>;
    /**
     * The snap's reading of `base` (tree structure and each node's place). Kept across the bases of one
     * drag: between two of them only the carried tree moved, and the snap never reads that tree, so the
     * reading still describes the map. `snapIndexStale` and the sizes say when it does not (LEV-126).
     */
    index: SnapIndex | null;
  } | null = null;
  /**
   * Whether the next base a drag takes has to be read again: set by every layout request that is not
   * just a carried tree following the pointer (a redraw, a preview, the mode, the pane), and cleared
   * when a drag's base is refreshed. Between two bases that share it, only the carried tree moved:
   * everything else is held where it was (`topicLayouts`), so the reading of it still holds.
   */
  private snapIndexStale = true;
  /**
   * Where a topic added on the map was pressed, until a save stores it: the first rename writes it
   * with the title, a drag replaces it. Kept in the view only, so Escape leaves the topic in place.
   */
  private pendingTopic: { id: string; layout: LayoutMode; position: TopicPosition } | null = null;
  private refreshTimer: number | undefined;
  /** The refresh running now, if any: what the export waits for when the debounce has already fired. */
  private refreshing: Promise<void> | undefined;
  private layoutFrame: number | undefined;
  private epoch = 0;
  private ready = false;
  private closed = false;
  /** True while `onUnloadFile` saves a draft: the note is being left, so its re-read and redraw after that save are skipped. */
  private unloading = false;
  private needsFit = true;
  /**
   * Whether `needsFit` outlived a free drag (LEV-182), set when the drag ends: only that fit also waits for a re-read
   * (see the layout frame), and a pan or zoom made before it runs cancels it (`clearFit`).
   */
  private fitHeld = false;
  private saving = false;
  private revealId: string | null = null;
  private inlineEditor: InlineEditor | undefined;
  /** The last 本文・リンクを編集 modal, so a refresh under its kept draft can update its error line; closed modals no longer show one. */
  private bodyModal: EditModal | undefined;
  /** The base of the open title draft and of the open body draft; see `DraftBase`. */
  private inlineDraft: DraftBase | undefined;
  private bodyDraft: DraftBase | undefined;
  /** The writes this view made since its last re-parse, in order, for the re-parse that reads them back; see `OwnWrite`. */
  private ownWrites: OwnWrite[] = [];
  /** How many times a note has left this view (`onUnloadFile`): a layout write started before the last one is not this record's. */
  private loads = 0;
  /** The 操作 popover while it is open (§5 M3): its card, the gear it hangs under, and the release of the listeners outside it (the document's press, the window's blur). */
  private popover: { element: HTMLDivElement; anchor: HTMLButtonElement; release: () => void } | null = null;
  /** Whether any node of `document` calls a map (§5 M12), read once per parse. */
  private calls: { document: MindDocument; any: boolean } | undefined;
  private layoutWrite: Promise<void> = Promise.resolve();

  constructor(
    leaf: WorkspaceLeaf, private readonly store: DocumentStore, private readonly router: ViewRouter,
    /** Items of the 操作 popover whose routes live in the plugin (§5 M3); shown after Markdown に切り替え, in this order. */
    private readonly menuActions: readonly MapMenuAction[] = [],
  ) {
    super(leaf);
    // A FileView is a navigation view (the API's own rule: a view that opens a note, like the Markdown editor, Kanban
    // or a PDF; not a static one like the file explorer — LEV-74). Obsidian 1.14.2 treats a non-navigation active
    // leaf as "not really the current file": `getActiveFileView()` (the core file commands, `getActiveFile()`,
    // `file-open`) resolves to the most recently active navigation leaf, and the workspace's window `keydown` for a
    // bare Escape moves the active leaf and the focus there — on the map, Escape with no inline editor open jumped to
    // the Markdown tab beside it, and the core commands acted on that note. As a navigation view the map keeps the
    // active leaf on Escape (the workspace returns before choosing another leaf), the leaf's back／forward history
    // records the notes the map passes through (`FileView.setState`), and `getLeaf(false)` — a link clicked on the
    // map, a file chosen in the explorer or the quick switcher — opens in this leaf, as it would in a Markdown tab,
    // instead of a neighbouring tab or a new one. ⌘-click still opens a tab. A map moved into a sidebar is the
    // exception (`syncNavigation`). FileView's other default, `allowNoFile = false`, is the map's too (see the class).
    this.reader = new CallReader(this.app, store);
    // Obsidian's keymap consults the active view's scope at the window's capture phase, before its global hotkeys, so
    // F2 pressed on the map reaches the map instead of the default `workspace:edit-file-title`, which otherwise consumes
    // it before the canvas listener (E02, LEV-48). Its `checkCallback` (1.14.2) wants `getActiveFileView()` to be an
    // `EditableFileView`, which the map is not, so the default declines here even without this scope (before LEV-74
    // it found the most recently active Markdown tab, whose file it then started renaming); the scope stays because
    // it does not hinge on that class distinction and keeps F2 the map's key when a user assigns it to another
    // command. While the focus is in this view, F2 is the map's key: on the canvas it edits the selected node, in the
    // inline editor or on a floating control it does nothing, and either way `false` (Obsidian's "consumed":
    // preventDefault and stopPropagation) keeps that default from running. With the focus outside the view the
    // handler declines (`undefined`); what Obsidian then does with F2 is its own affair (1.14.2 runs no other handler
    // for a key the active view registered, so the default stays off while the map is active). Only F2 is registered:
    // no other map key has a default hotkey. The workspace reads `view.scope` on each key, so there is nothing to undo.
    this.scope = new Scope(this.app.scope);
    this.scope.register([], "F2", event => {
      const target = event.targetNode;
      if (!target || !this.contentEl.contains(target)) return undefined;
      this.events?.hotkey(event);
      return false;
    });
  }

  /**
   * Resolves once the layout writes the buttons queued so far have run (`selectMode`), failed ones included: the end
   * point the browser page waits on before reading what the note holds, instead of a time window (LEV-212).
   */
  layoutWritten(): Promise<void> {
    return this.layoutWrite.catch(() => undefined);
  }

  /** Current presentation, for exports that mirror what the user sees: the folds and the called maps as drawn (§5 M12). */
  snapshot(): { file: TFile; mode: LayoutMode; collapsed: ReadonlySet<string>; document?: MindDocument; calls: CallTargets } | null {
    if (!this.file) return null;
    return { file: this.file, mode: this.mode, collapsed: new Set(this.collapsed), calls: this.targets, ...(this.document ? { document: this.document } : {}) };
  }

  /**
   * What is on screen, for the SVG／PNG export (§5 M13): the layout the nodes were
   * placed with, their elements and the connector layer. A debounced or running
   * refresh is finished first, Markdown renders still in flight (an external change
   * just before the export) are awaited until none is left or none finishes for
   * EXPORT_RENDER_WAIT_MS, and then a pending layout frame is awaited, so the labels
   * and the geometry handed out are the ones the DOM shows; the entries are copied,
   * so a later refresh cannot change the set being exported.
   */
  async exportSource(): Promise<CaptureSource & { file: TFile }> {
    const file = this.file;
    if (!file || !this.document) throw new Error("マップを開いてから書き出してください。");
    if (this.inlineEditor) throw new Error("テキストの編集を確定してから書き出してください。");
    if (this.topicDrag || this.dropPreview) throw new Error("ドラッグを終えてから書き出してください。");
    // A change arriving while a refresh reads (it is dropped by the epoch) leaves a new debounce behind, hence the loop.
    while (this.refreshTimer !== undefined || this.refreshing) {
      if (this.refreshTimer !== undefined) {
        this.contentEl.win.clearTimeout(this.refreshTimer);
        this.refreshTimer = undefined;
        await this.refresh();
      } else await this.refreshing;
    }
    // A finished render asks for its layout frame before idle() resolves, so the frame awaited next measures it.
    if (!await this.renderer.idle(EXPORT_RENDER_WAIT_MS)) new Notice(EXPORT_RENDER_STALLED_MESSAGE);
    if (this.layoutFrame !== undefined) await this.nextFrame();
    const layout = this.layout;
    if (this.closed || file !== this.file) throw new Error("マップが閉じられたか、別のノートに変わりました。開き直してから書き出してください。");
    if (!layout) throw new Error("マップの配置が終わってから書き出してください。");
    return { file, layout, entries: new Map(this.renderer.entries), canvas: this.canvas, edges: this.svg };
  }

  /** The next animation frame, or 100 ms: a hidden window never paints, and the export must not wait for it. */
  private nextFrame(): Promise<void> {
    const win = this.contentEl.win;
    return new Promise<void>(resolve => {
      let done = false;
      const finish = (): void => { if (!done) { done = true; resolve(); } };
      win.requestAnimationFrame(finish);
      win.setTimeout(finish, 100);
    });
  }

  /** The command's route: capture what is shown and create the attachment; the note is not written. */
  exportImage(format: ExportFormat): Promise<TFile> {
    return this.exportSource().then(source => exportMap(this.app, source.file, source, format));
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return this.file ? `${this.file.basename} · マップ` : "マインドマップ"; }
  getIcon(): string { return "git-fork"; }

  /**
   * The settings' theme (M14): Obsidian's own `theme-light` / `theme-dark` class on the map container
   * only, where styles.css re-derives the palette; `follow` removes both so the container inherits
   * the app's theme again. Presentation only, nothing is written to the note.
   */
  setTheme(theme: MapTheme): void {
    this.theme = theme;
    this.contentEl.toggleClass("theme-light", theme === "light");
    this.contentEl.toggleClass("theme-dark", theme === "dark");
  }

  /**
   * The settings' visible layouts (M14): which of the bottom-left buttons show. The layout on
   * screen keeps its button whether or not it is listed, so a note opened in a hidden layout can
   * still be switched away from it, and the button goes once another layout is chosen. Presentation
   * only: the note, the view state and every other use of the layout are as before.
   */
  setVisibleLayouts(layouts: readonly LayoutMode[]): void {
    this.visibleLayouts = layouts;
    this.syncModeButtons();
  }

  /** The note (`FileView`: `file`, when one is shown) with the layout and the viewport, for the workspace layout and the leaf's history. */
  getState(): Record<string, unknown> {
    return { ...super.getState(), layout: this.mode, viewport: this.viewport?.value };
  }

  /**
   * `FileView.setState` loads the note the state names — `onUnloadFile` for the one shown, `onLoadFile` for the new
   * one — and reports another note as a step of the leaf's back／forward history (LEV-74; the layout and the viewport
   * alone are not one) and a leaf left without a note as one to close (`allowNoFile`). It is handed the state as it
   * came, except that only a Markdown note is one the map can show: anything else named there (a folder, an
   * image, a path that is gone) is handed over as no note, as a missing path would be. The layout comes from the
   * state, else from the note's own preference when the note changed; the viewport is restored once the view has
   * its DOM, and the note is read.
   */
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const value = state && typeof state === "object" ? state as Record<string, unknown> : {};
    // A state without `file` keeps the note shown (FileView reads the key's presence, not its value).
    const named = Object.prototype.hasOwnProperty.call(value, "file");
    const found = named && typeof value.file === "string" ? this.app.vault.getAbstractFileByPath(value.file) : null;
    const file = named ? (found instanceof TFile && found.extension === "md" ? found : null) : this.file;
    const changed = this.file !== file;
    await super.setState(named ? { ...value, file: file?.path ?? null } : value, result);
    if (isLayoutMode(value.layout)) this.applyMode(value.layout);
    else if (changed && this.file) this.applyMode(readMapLayout(this.app, this.file) ?? "mindmap");
    // The bar follows the layout at once, before the read: draw() does not run for a note that fails to load.
    this.syncModeButtons();
    // A leaf left without a note closes (`allowNoFile` is false: FileView asked the leaf to): nothing to restore or read.
    if (!this.ready || !this.file) return;
    const view = value.viewport;
    if (view && typeof view === "object" && "x" in view && "y" in view && "scale" in view
      && typeof view.x === "number" && Number.isFinite(view.x)
      && typeof view.y === "number" && Number.isFinite(view.y)
      && typeof view.scale === "number" && Number.isFinite(view.scale)) {
      this.viewport.set({ x: view.x, y: view.y, scale: view.scale });
      this.clearFit();
    }
    await this.refresh();
  }

  /**
   * The note shown leaves this view (`FileView.loadFile`: another note takes its place, the state names none, the
   * view closes). A draft under way when a navigation replaces the note in this leaf (a link, the explorer,
   * back／forward — LEV-74) is saved first, as a Markdown tab keeps its buffer; the save needs the note it was
   * opened on, which `file` still is here, and skips the re-read and redraw of that note (`unloading`), since
   * everything it gave the view goes right after. A refused save (the note moved on, E05) cannot keep the draft
   * here. A note that is gone (deleted: FileView then takes the leaf back in its history or to the empty view)
   * has nothing to save to; a closing view has dropped its draft already (`onClose`).
   */
  async onUnloadFile(file: TFile): Promise<void> {
    if (this.inlineEditor && this.app.vault.getFileByPath(file.path) === file) {
      this.unloading = true;
      try { await this.inlineEditor.flush(); }
      catch (error) { new Notice(`編集中の内容を保存できませんでした。${error instanceof Error ? error.message : ""}`); }
      finally { this.unloading = false; }
    }
    this.dropDraft();
    this.document = undefined; this.selectedId = null; this.deselected = false; this.collapsed.clear(); this.needsFit = true; this.fitHeld = false;
    this.pendingTopic = null; this.topicDrag = null; this.ownWrites = []; this.loads += 1;
    this.targets = new Map(); this.knownCalled.clear();
    await super.onUnloadFile(file);
  }

  /** A draft is dropped without a save: the note is leaving, gone or the view is closing. */
  private dropDraft(): void {
    this.inlineEditor?.dispose();
    this.inlineEditor = undefined;
    this.inlineDraft = undefined;
    this.bodyModal?.close();
    this.bodyModal = undefined;
    this.bodyDraft = undefined;
  }

  /**
   * The note shown was renamed: FileView updates the leaf's header; the map redraws (the root node is the
   * basename) and the workspace layout is saved with the new path (`getState`) — asked for here as the API has it,
   * though 1.14.2's FileView does so too on its own.
   */
  async onRename(file: TFile): Promise<void> {
    await super.onRename(file);
    if (file !== this.file) return;
    this.scheduleRefresh();
    this.app.workspace.requestSaveLayout();
  }

  /**
   * What a back／forward step or a duplicated tab restores through `setEphemeralState` below (LEV-74): the selected
   * node of this note by its place and text (node ids are handed out per parse, so the id would name nothing in the
   * view that opens next; a called map's node has no place in this note and is not kept), and whether the focus was
   * in the view, so the keys come back with it — as the Markdown editor reports its cursor and focus.
   */
  getEphemeralState(): Record<string, unknown> {
    const node = this.selected();
    const own = node && this.document && (node.id === "root" || this.document.nodes.includes(node)) ? node : undefined;
    const focus = this.contentEl.contains(this.contentEl.ownerDocument.activeElement);
    return { ...(own ? { selection: { from: own.from, title: own.title } } : {}), ...(focus ? { focus: true } : {}) };
  }

  /**
   * What Obsidian hands a navigation view besides its state (LEV-74). `subpath`, from a link (`[[note#heading]]`,
   * `[[note#^block]]`, or `[[#heading]]` on this very note, which opens in this leaf now): the node holding that
   * position is selected and brought into view, as the editor scrolls to the heading (E06). `selection`, this
   * view's own `getEphemeralState`: a back／forward step or a duplicated tab keeps the selection — the node at the
   * same place with the same text, else the first with that text, else nothing. `focus`, from `setActiveLeaf(leaf,
   * { focus: true })` (the map opened by a command, its tab pressed) and from `getEphemeralState` (a history step):
   * the keys work at once, on the selected node or else the canvas — never while a draft is being typed.
   */
  setEphemeralState(state: unknown): void {
    const value = state && typeof state === "object" ? state as Record<string, unknown> : {};
    const document = this.document;
    const selection = value.selection && typeof value.selection === "object" ? value.selection as Record<string, unknown> : null;
    if (document && typeof value.subpath === "string" && value.subpath !== "") {
      const offset = locateSubpath(document.source, value.subpath);
      const id = offset === null ? undefined : this.nodeContaining(document, offset)?.id;
      if (id !== undefined) this.select(id, true);
    } else if (document && selection && typeof selection.from === "number" && typeof selection.title === "string") {
      const { from, title } = selection;
      const candidates = [document.root, ...document.nodes];
      const node = candidates.find(item => item.from === from && item.title === title) ?? candidates.find(item => item.title === title);
      if (node) this.select(node.id);
    }
    if (value.focus === true && this.ready && !this.inlineEditor) {
      if (this.selectedId !== null && this.renderer.entries.has(this.selectedId)) this.renderer.focus(this.selectedId);
      else this.canvas.focus({ preventScroll: true });
    }
  }

  /** The innermost node whose section holds the offset: children lie inside their parent's range and follow it. */
  private nodeContaining(document: MindDocument, offset: number): MindNode | undefined {
    let found: MindNode | undefined;
    for (const node of document.nodes) {
      if (node.from <= offset && offset < node.to && (!found || node.from >= found.from)) found = node;
    }
    return found ?? (document.root.from <= offset && offset < document.root.to ? document.root : undefined);
  }

  /**
   * A map dragged into a sidebar is a static pane there, as Obsidian's Bases view treats itself: the explorer, the
   * quick switcher and this plugin's own open() must not put a note into it. Read when the view opens and on every
   * layout change, since a leaf can be moved between the sidebars and the main area at any time.
   */
  private syncNavigation(): void {
    const root = this.leaf.getRoot();
    const { leftSplit, rightSplit } = this.app.workspace;
    this.navigation = root !== leftSplit && root !== rightSplit;
  }

  onOpen(): Promise<void> {
    this.closed = false;
    this.syncNavigation();
    this.registerEvent(this.app.workspace.on("layout-change", () => { this.syncNavigation(); }));
    this.contentEl.empty();
    this.contentEl.addClass("mappy-view");
    this.setTheme(this.theme);
    const modes = this.contentEl.createDiv({ cls: "mappy-modes mappy-floating", attr: { "aria-label": "レイアウト" } });
    for (const mode of LAYOUT_MODES) {
      const { label, icon } = LAYOUT_BUTTONS[mode];
      const button = this.button(modes, label, icon, () => {
        this.selectMode(mode);
      });
      this.modeButtons.set(mode, button);
    }
    // The top-right corner holds one control (§5 M3): the gear, which opens the view's own popover of three items;
    // the node operations stay on the keys, the context menu and the command palette. The popover's outside-press
    // listener leaves a press on the gear alone, so the click here toggles it.
    const actions = this.contentEl.createDiv({ cls: "mappy-actions mappy-floating", attr: { "aria-label": "操作" } });
    const gear = this.button(actions, "操作", "settings", () => {
      if (this.popover) this.closePopover(true);
      else this.openPopover(gear);
    });
    gear.setAttribute("aria-haspopup", "menu");
    gear.setAttribute("aria-expanded", "false");
    this.canvas = this.contentEl.createDiv({ cls: "mappy-canvas", attr: {
      tabindex: "0", role: "tree", "aria-label": "マインドマップ。Enter で兄弟、Tab で子、F2 で編集。",
    } });
    this.emptyState = this.canvas.createDiv({ cls: "mappy-empty-state", text: "Markdown ノートを選び、コマンドパレットからマインドマップを開いてください。" });
    this.emptyState.hidden = true;
    const world = this.canvas.createDiv({ cls: "mappy-world" });
    this.svg = world.createSvg("svg", { cls: "mappy-edges", attr: { "aria-hidden": "true" } });
    const nodes = world.createDiv({ cls: "mappy-nodes" });
    this.placeholder = nodes.createDiv({ cls: "mappy-drop-placeholder", attr: { "data-drop-placeholder": "", "aria-hidden": "true" } });
    this.placeholder.hidden = true;
    const zoom = this.contentEl.createDiv({ cls: "mappy-zoom mappy-floating", attr: { "aria-label": "ズーム" } });
    this.button(zoom, "縮小", "minus", () => { this.viewport.zoom(1 / 1.2); });
    this.zoomLabel = this.button(zoom, "100%", undefined, () => { this.viewport.zoom(1 / this.viewport.value.scale); });
    this.button(zoom, "拡大", "plus", () => { this.viewport.zoom(1.2); });
    this.button(zoom, "全体表示", "scan", () => { if (this.layout) this.viewport.fit(this.layout.bounds); });
    this.renderer = this.addChild(new NodeRenderer(this.app, nodes, () => { this.scheduleLayout(); }));
    this.viewport = this.addChild(new MapViewport(this.canvas, world, (view, previous, carried) => {
      this.zoomLabel.setText(`${view.scale < 0.1 ? (view.scale * 100).toFixed(1) : Math.round(view.scale * 100)}%`);
      this.app.workspace.requestSaveLayout();
      // A pan or zoom between a drop and the fit held through it is where the view is wanted now (LEV-182).
      if (this.fitHeld && !this.topicDrag) this.clearFit();
      if (!carried) this.viewportMoved(previous, view);
    }, () => { this.deselect(); }));
    this.events = this.addChild(new MapEvents(this.canvas, {
      selected: () => this.selected(), visible: () => this.visible(), select: (id, focus) => { this.select(id, focus); },
      fold: id => { this.fold(id); }, edit: () => { this.editTitle(); },
      command: command => { this.run(() => this.execute(command)); },
      history: direction => { this.history(direction); }, attach: file => { this.run(() => this.attachImage(file)); },
      // A link is resolved from the note it is written in: the called note for a called map's node (§5 M12), this
      // one for the host's own nodes and for the calling item, whose attachments are its own item's.
      link: (link, newLeaf, nodeId) => {
        const source = nodeId === null ? undefined : this.calledSource(nodeId);
        const base = source && !source.root ? source.path : this.file?.path;
        if (base !== undefined) this.run(() => this.app.workspace.openLinkText(link, base, newLeaf));
      },
      addTopic: point => { this.run(() => this.addTopic(point)); },
      open: (id, newLeaf) => this.openCalled(id, newLeaf),
    }));
    this.nodeDrag = this.addChild(new NodeDrag(this.canvas, {
      select: id => { this.select(id); },
      readOnly: id => this.isCalled(id),
      free: id => this.isFree(id),
      dropTarget: (dragged, target, position) => this.document && !this.topicDrag?.body ? resolveDrop(this.document, dragged, target, position) : null,
      preview: command => { this.previewDrop(command); },
      command: command => { this.run(() => this.executeDrop(command)); },
      shift: (id, delta) => { this.shiftTopic(id, delta); },
      place: (id, delta) => { this.run(() => this.placeTopic(id, delta)); },
      detach: (id, point) => { this.run(() => this.detachNode(id, point)); },
      snap: (id, root, current) => this.snapTarget(id, root, current),
    }));
    this.registerDomEvent(this.canvas, "contextmenu", event => {
      const target = event.targetNode;
      if (!target?.instanceOf(Element)) return;
      if (target.closest("input,textarea,[contenteditable='true'],button,.mappy-floating")) return;
      const id = nodeOf(this.canvas, target)?.dataset.nodeId;
      if (!this.document || !this.file) return;
      event.preventDefault();
      const menu = new Menu();
      if (!id) {
        // Empty canvas: the topic goes where the menu was opened.
        const rect = this.canvas.getBoundingClientRect();
        const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        menu.addItem(item => item.setTitle("トピックを追加").setIcon("plus").onClick(() => { this.run(() => this.addTopic(point)); }));
        menu.addSeparator();
        this.historyItems(menu);
        menu.showAtMouseEvent(event);
        return;
      }
      this.select(id);
      // A node drawn from a called map (§5 M12) is edited in its own note: the menu opens that note and folds, nothing more.
      if (this.calledSource(id)) {
        menu.addItem(item => item.setTitle("元のマップを開く").setIcon("git-fork").onClick(() => { this.openCalled(id, false); }));
        if (this.isCalled(id)) {
          const node = this.projection()?.calls.byId.get(id);
          if (node && node.children.length > 0) menu.addItem(item => item.setTitle("折りたたみ").setIcon("chevrons-down-up").onClick(() => { this.fold(id); }));
          menu.addSeparator();
          this.historyItems(menu);
          menu.showAtMouseEvent(event);
          return;
        }
        menu.addSeparator();
      }
      const entries = this.nodeEntries();
      for (const entry of [entries.edit, entries.body, entries.image]) this.menuItem(menu, entry);
      menu.addSeparator();
      for (const entry of [entries.child, entries.sibling]) this.menuItem(menu, entry);
      const remove = this.isTopic(id) ? "トピックを削除" : "枝を削除";
      for (const [type, title] of [["move-up", "前へ移動"], ["move-down", "後ろへ移動"], ["delete", remove]] as const) {
        menu.addItem(item => item.setTitle(title).onClick(() => { this.executeSelected(type); }));
      }
      menu.addSeparator();
      this.historyItems(menu);
      if (this.document.format === "headings") {
        menu.addSeparator();
        menu.addItem(item => item.setTitle("リスト形式に変更").setIcon("list-tree")
          .onClick(() => { this.run(() => this.convertToList()); }));
      }
      menu.showAtMouseEvent(event);
    });
    this.registerDomEvent(nodes, "load", () => { this.scheduleLayout(); }, true);
    this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => {
      if (info.file?.path === this.file?.path) this.scheduleRefresh();
    }));
    this.registerEvent(this.app.vault.on("modify", file => { if (file === this.file) this.scheduleRefresh(); }));
    this.register(this.store.onWrite((file, write) => { this.recordWrite(file, write); }));
    // A rename of the note is `onRename` (FileView's own subscription). Its deletion is FileView's too, and comes
    // first (subscribed in `onload`): the leaf goes back in its history or to the empty view (`allowNoFile` is
    // false), which unloads the note here without a save; a kept draft outlives refreshes, but not its note, so it
    // goes at once rather than on that navigation. A leaf busy with a `setViewState` (a read of this very note in
    // flight) refuses the history step instead (1.14.2: "Tab is busy"), and then nothing would unload the note: once
    // the tick's work is done, a view still on the deleted note lets go of it itself and draws the empty state.
    this.registerEvent(this.app.vault.on("delete", file => {
      const note = this.file;
      if (!note || file !== note) return;
      this.dropDraft();
      this.contentEl.win.setTimeout(() => {
        if (this.closed || this.file !== note) return;
        this.run(async () => {
          await this.onUnloadFile(note);
          if (this.file !== note) return;
          this.file = null;
          this.scheduleRefresh();
        });
      }, 0);
    }));
    // The maps the items call (§5 M12) are read again when a note they concern changes: one read for the last draw
    // (edited, saved or not, renamed, deleted, no longer a map), or one an item resolves to now (created, became a map,
    // took over a link). Any other note's change is nobody's business here.
    const recall = (file: TAbstractFile, oldPath?: string): void => { if (this.callConcerns(file, oldPath)) this.scheduleRecall(); };
    this.registerEvent(this.app.metadataCache.on("changed", file => { recall(file); }));
    this.registerEvent(this.app.metadataCache.on("deleted", file => { recall(file); }));
    this.registerEvent(this.app.vault.on("rename", recall));
    this.registerEvent(this.app.vault.on("delete", file => { recall(file); }));
    this.registerEvent(this.app.vault.on("modify", file => { recall(file); }));
    this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => { if (info.file) recall(info.file); }));
    // The settings may have reached the view before it had buttons (src/main.ts sets them at construction).
    this.syncModeButtons();
    this.ready = true;
    return this.refresh();
  }

  /** The view's own teardown, then FileView's: it empties the content and unloads the note (`onUnloadFile`, with no save). */
  onClose(): Promise<void> {
    this.closed = true;
    this.dropDraft();
    this.closePopover(false);
    this.epoch += 1;
    if (this.refreshTimer !== undefined) this.contentEl.win.clearTimeout(this.refreshTimer);
    if (this.recallTimer !== undefined) this.contentEl.win.clearTimeout(this.recallTimer);
    if (this.layoutFrame !== undefined) this.contentEl.win.cancelAnimationFrame(this.layoutFrame);
    return super.onClose();
  }

  onResize(): void {
    if (this.ready) this.scheduleLayout();
    // A draft opened while the pane had no layout (hidden) has not been measured yet.
    this.inlineEditor?.fit(true);
    // The gear keeps its corner; the card under it follows, and shrinks if the pane got too narrow for it.
    this.placePopover();
  }

  private button(parent: HTMLElement, label: string, icon: string | undefined, action: () => void): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "mappy-button", attr: { "aria-label": label, title: label, type: "button" } });
    if (icon) { setIcon(button.createSpan(), icon); button.createSpan({ text: label, cls: "mappy-button-label" }); }
    else button.setText(label);
    button.addEventListener("click", action);
    return button;
  }

  private run(action: () => Promise<void>): void {
    void action().catch(error => { new Notice(error instanceof Error ? error.message : "操作を完了できませんでした。"); });
  }

  /** A context-menu entry: the title, the icon and the method it runs. */
  private menuItem(menu: Menu, [title, icon, run]: MenuEntry): void {
    menu.addItem(item => item.setTitle(title).setIcon(icon).onClick(run));
  }

  /**
   * The node operations of the context menu, each running the method its key runs; the node is read
   * when the item is chosen, as the keys do, not when the menu opened.
   */
  private nodeEntries(): Record<"edit" | "body" | "image" | "child" | "sibling", MenuEntry> {
    return {
      edit: ["テキストを編集", "pencil", () => { this.editTitle(); }],
      body: ["本文・リンクを編集", "text", () => { this.editBody(); }],
      image: ["画像を追加", "image-plus", () => { this.chooseImage(); }],
      child: ["子を追加", "plus", () => { this.executeSelected("add-child"); }],
      sibling: ["兄弟を追加", "corner-down-right", () => { this.executeSelected("add-sibling"); }],
    };
  }

  /**
   * The 操作 popover (§5 M3), opened under the gear: a card of three items — Markdown に切り替え, then the
   * plugin's routes (the map search, the export) in the order `src/main.ts` passes them — each an icon, a
   * title and one line of description. Every other operation stays on the keys, the context menu and the
   * command palette. The card is the view's own element inside `.mappy-view`, placed by `placePopover`, so
   * it follows the pane (a popout window, a narrow one) and never leaves it, where Obsidian's `Menu` at the
   * window's right edge did. Whether an item is enabled is judged as the card opens, as the menu did: the
   * Markdown switch needs the note and its document, the plugin's items answer their own `check`. A
   * disabled item is still reached with ↑↓ and Tab on the card and does nothing, so it is found and read.
   *
   * Keys, on the card: the first item takes the focus; ↑↓ (Home／End) move, Tab and Shift+Tab cycle,
   * Enter／Space run the focused item, Escape closes. A press outside the card and the gear, the gear's
   * next press, choosing an item and the view's closing close it too. Closing puts the focus back on the
   * canvas, except on a press outside the view, whose target takes the focus itself.
   *
   * The keys live on the focus (Obsidian's `Menu` has the keymap instead), so the card goes whenever the
   * focus is taken outside it — a node refocused by an inline edit that finished saving, the command
   * palette, another tab, the window losing focus to another (a popout's card, the main window pressed) —
   * and leaves the focus where it went; a card left open without its keys would have no Escape. The gear
   * taking the focus on its press is not that: its click toggles.
   */
  private openPopover(anchor: HTMLButtonElement): void {
    if (this.popover) return;
    const doc = this.contentEl.doc;
    const win = this.contentEl.win;
    const element = this.contentEl.createDiv({ cls: "mappy-popover", attr: { role: "menu", "aria-label": "操作" } });
    const items: HTMLButtonElement[] = [];
    const add = (title: string, description: string, icon: string, enabled: boolean, run: () => void): void => {
      const item = element.createEl("button", { cls: "mappy-popover-item", attr: { type: "button", role: "menuitem", tabindex: "-1" } });
      setIcon(item.createSpan({ cls: "mappy-popover-icon" }), icon);
      const text = item.createSpan({ cls: "mappy-popover-text" });
      text.createSpan({ cls: "mappy-popover-title", text: title });
      text.createSpan({ cls: "mappy-popover-description", text: description });
      if (!enabled) { item.addClass("is-disabled"); item.setAttribute("aria-disabled", "true"); }
      item.addEventListener("click", () => {
        // Closing takes the card down; a second activation from the same press (Enter's native click) finds it gone and does nothing.
        if (!enabled || this.popover?.element !== element) return;
        this.closePopover(true);
        run();
      });
      items.push(item);
    };
    const ready = this.file !== null && this.document !== undefined;
    add("Markdown に切り替え", "同じタブで本文を開く", "file-text", ready, () => { this.run(() => this.showSource(false)); });
    for (const action of this.menuActions) add(action.title, action.description, action.icon, action.check(this), () => { action.run(this); });
    element.addEventListener("keydown", event => {
      const focused = items.findIndex(item => item === doc.activeElement);
      const move = (to: number): void => { items[(to + items.length) % items.length]?.focus({ preventScroll: true }); };
      const previous = focused < 0 ? items.length - 1 : focused - 1;
      switch (event.key) {
        case "ArrowDown": move(focused + 1); break;
        case "ArrowUp": move(previous); break;
        case "Home": move(0); break;
        case "End": move(items.length - 1); break;
        case "Tab": move(event.shiftKey ? previous : focused + 1); break;
        case "Enter": case " ": items[focused]?.click(); break;
        case "Escape": this.closePopover(true); break;
        default: return;
      }
      event.preventDefault();
      event.stopPropagation();
    });
    // A press on the card's own padding would move the focus to the body and take the keys with it.
    element.addEventListener("mousedown", event => {
      const target = event.targetNode;
      if (!target?.instanceOf(Element) || !target.closest("button")) event.preventDefault();
    });
    // The focus leaving the card (see above). A known destination decides at once; none (a blur with no successor: a
    // touch on nothing focusable, the window) is judged a tick later, once a gear press has had its click and a
    // focus that merely returned (the window's) has shown itself.
    element.addEventListener("focusout", event => {
      const next = event.relatedTarget as Node | null;
      if (next && (element.contains(next) || anchor.contains(next))) return;
      if (next) { this.closePopover(false); return; }
      win.setTimeout(() => { if (this.popover?.element === element && !element.contains(doc.activeElement)) this.closePopover(false); }, 0);
    });
    // The press outside, at the capture phase so no pane can swallow it; a press on the gear is left to its click, which toggles.
    const outside = (event: PointerEvent): void => {
      const target = event.targetNode;
      if (!target || element.contains(target) || anchor.contains(target)) return;
      this.closePopover(this.contentEl.contains(target));
    };
    // The window losing the focus to another window (or app): the outside press of a popout's card lands in the main
    // window, whose document has no listener, and the focus stays on the item as far as this document can tell.
    const blurred = (): void => { this.closePopover(false); };
    doc.addEventListener("pointerdown", outside, true);
    win.addEventListener("blur", blurred);
    this.popover = { element, anchor, release: () => {
      doc.removeEventListener("pointerdown", outside, true);
      win.removeEventListener("blur", blurred);
    } };
    anchor.setAttribute("aria-expanded", "true");
    this.placePopover();
    items[0]?.focus({ preventScroll: true });
  }

  /**
   * Under the gear, the right edges aligned: offsets from the pane's top and right edges, since the card
   * and the gear are both positioned in `.mappy-view`, so the card sits where the gear is at any pane size.
   * The width is the content's, at most POPOVER_MAX_WIDTH and less in a pane too narrow for that plus the
   * margin on the left, so the card's left edge never leaves the pane (a 400px pane still fits the full width);
   * the height is likewise capped to what is left under the gear, the card scrolling inside a short pane
   * rather than being cut by the view's `overflow: hidden`. A pane without a layout yet (empty rects) sets
   * no cap: the content's own width until the next resize.
   */
  private placePopover(): void {
    if (!this.popover) return;
    const { element, anchor } = this.popover;
    const pane = this.contentEl.getBoundingClientRect();
    const gear = anchor.getBoundingClientRect();
    const right = Math.max(0, pane.right - gear.right);
    const top = gear.bottom - pane.top + POPOVER_GAP;
    const width = pane.width - right - POPOVER_MARGIN;
    const height = pane.height - top - POPOVER_MARGIN;
    element.style.top = `${top}px`;
    element.style.right = `${right}px`;
    element.style.maxWidth = width > 0 ? `${Math.min(POPOVER_MAX_WIDTH, width)}px` : "";
    element.style.maxHeight = height > 0 ? `${height}px` : "";
  }

  /**
   * Take the card down and, unless the focus is going elsewhere anyway, give it back to the canvas — without
   * scrolling: `.mappy-view` hides its overflow, and a focus that scrolled it would shift the map and its controls.
   */
  private closePopover(focus: boolean): void {
    const popover = this.popover;
    if (!popover) return;
    this.popover = null;
    popover.release();
    popover.element.remove();
    popover.anchor.setAttribute("aria-expanded", "false");
    if (focus) this.canvas.focus({ preventScroll: true });
  }

  private historyItems(menu: Menu): void {
    menu.addItem(item => item.setTitle("元に戻す").setIcon("undo-2")
      .setDisabled(!this.file || !this.store.canUndo(this.file)).onClick(() => { this.history("undo"); }));
    menu.addItem(item => item.setTitle("やり直す").setIcon("redo-2")
      .setDisabled(!this.file || !this.store.canRedo(this.file)).onClick(() => { this.history("redo"); }));
  }

  /**
   * A deliberate layout switch is the note's next-open preference. The key is written as this view's own
   * edit, through the store's queue (`writeLayout`), not beside it.
   */
  private selectMode(mode: LayoutMode): void {
    if (mode === this.mode) return;
    this.applyMode(mode);
    this.needsFit = true;
    this.syncModeButtons();
    this.draw();
    this.app.workspace.requestSaveLayout();
    const file = this.file;
    if (!file) return;
    const loaded = this.loads;
    const write = this.layoutWrite.catch(() => undefined).then(() => this.writeLayout(file, mode, loaded));
    this.layoutWrite = write;
    this.run(() => write);
  }

  /**
   * `mappy-layout` rewritten on whatever the note holds when the store gets to it (`planMapLayout`), in the
   * queue of the map's own edits (LEV-196). Written beside that queue (`processFrontMatter`, before), it
   * changed the note under the view: the view's text stayed the old one until the watcher's re-read (≈60 ms),
   * an edit planned in between — a draft saved by the blur of the click on the button itself, a key, a topic
   * dropped by the finger still on it — was refused as someone else's change, and the re-read had no edits to
   * carry the ids of a node whose title repeats or is empty (LEV-150). Queued, an edit already on its way
   * lands first, and one planned before it is carried over it by the store (`DocumentStore.applyOver`); recorded,
   * the re-read carries the ids (`ownWrites`). The note of a view that moved on keeps the preference but none of
   * the rest — nor does a view that left the note and came back while the write was under way (`loaded`): its
   * record starts again from the note it re-read, which a write from before that cannot lead on from.
   */
  private async writeLayout(file: TFile, mode: LayoutMode, loaded: number): Promise<void> {
    const write = await this.store.applyLatest(file, source => planMapLayout(source, mode));
    if (write.edits.length === 0 || file !== this.file || this.closed || loaded !== this.loads) return;
    this.recordOwn(write);
  }

  /**
   * `write` recorded where the view's record leads to its start: the end of the record, or the text the view shows
   * when a re-read has spent it. A write already there — the store's `onWrite` told it before the caller got its
   * answer (`recordWrite`) — is the last one and is not added again; nor is one a re-read has spent in between (its
   * start is behind the text the view shows). Not matched against earlier writes, as `recordCarried` does: ⌘Z, ⌘⇧Z,
   * ⌘Z before one re-read write the same texts twice.
   */
  private recordOwn(write: LatestWrite): void {
    const last = this.ownWrites[this.ownWrites.length - 1];
    if (last?.before === write.before && last.after === write.after) return;
    if (write.before !== (last?.after ?? this.document?.source)) return;
    this.ownWrites.push({ before: write.before, after: write.after, edits: write.edits });
  }

  /**
   * The layout writes the store carried this view's edit over (`CarriedWrite.carried`), recorded where the view's
   * own record leads to their start: another view's button (several views share the store), or this view's own
   * write that a re-read has spent and the record no longer holds. Without them the re-read could not replay
   * from the text this view shows to the edit's (LEV-150 through LEV-196's carry). Returns them as recorded.
   */
  private recordCarried(carried: readonly LatestWrite[]): OwnWrite[] {
    let at = this.ownWrites[this.ownWrites.length - 1]?.after ?? this.document?.source;
    const recorded: OwnWrite[] = [];
    for (const write of carried) {
      const own = this.ownWrites.find(item => item.before === write.before && item.after === write.after);
      if (own) { recorded.push(own); continue; }
      if (write.before !== at) continue;
      const added: OwnWrite = { ...write };
      this.ownWrites.push(added);
      recorded.push(added);
      at = write.after;
    }
    return recorded;
  }

  /**
   * The parse an edit planned on `planned` (from `source`) stands on in the text the store found (`write.before`):
   * `planned` carried over the writes the store carried it over, or the view's own parse when a re-read got there
   * first. Undefined when neither is that text; the drafts are then left for the re-read to measure.
   */
  private writeBase(planned: MindDocument | undefined, source: string, write: CarriedWrite, carried: readonly OwnWrite[], basename: string): MindDocument | undefined {
    let base = planned?.source === source ? planned : undefined;
    for (const own of carried) if (base?.source === own.before) base = this.parseOwn(own, base, basename);
    if (base?.source === write.before) return base;
    return this.document?.source === write.before ? this.document : undefined;
  }

  /** `own.after` parsed from `from` with its edits, once per base document. */
  private parseOwn(own: OwnWrite, from: MindDocument, basename: string): MindDocument {
    if (own.parsed?.from !== from || own.parsed.basename !== basename) {
      own.parsed = { from, basename, document: parseMarkdown(own.after, basename, from, undefined, own.edits) };
    }
    return own.parsed.document;
  }

  /**
   * Where `this.mode` is set (here and in `setState`): a drag in progress, and a topic just added on the
   * map and not yet named, are rebased to the new mode before it takes hold, so a layout switch mid-drag
   * (a button, a restored workspace, a pane opened on the same note — LEV-129) does not move them out
   * from under the pointer or drop their held position. `originFor` is read fresh on both sides of the
   * switch rather than trusting a frame-cached origin, so two switches ahead of a single paint (a fast
   * double click, `setState` racing a pointer move while its `store.read` is in flight) still compose.
   */
  private applyMode(mode: LayoutMode): void {
    const changing = mode !== this.mode;
    const rebasing = changing && this.document && (this.topicDrag || this.pendingTopic);
    const previousOrigin = rebasing && this.document ? this.originFor(this.document) : undefined;
    this.mode = mode;
    if (previousOrigin) this.rebaseFreePositions(previousOrigin);
  }

  /**
   * `topicDrag.from`/`overrides`, a dragged body's viewport pan, the snap's own map (`topicDrag.base`／
   * `index`), and `pendingTopic` are all measured against the body root's top-left (`LayoutResult.origin`)
   * or tagged to the mode they were taken in; a mode switch moves the first and stales the rest. Left
   * alone: a carried topic tree jumps by the origins' difference and stays off by it once dropped; a
   * dragged body jumps the same way, since nothing here compensates the viewport pan that carries it; the
   * snap can judge the new mode's positions against the old mode's map until the next frame catches up
   * (`setState` awaits a read in between, so a pointer move can land in that window); and a topic just
   * added on the map, still unnamed, falls back to the default slot the instant its `layout` tag stops
   * matching `this.mode` (`topicLayouts()`'s guard). Rebasing all four here keeps every one of them
   * exactly where it was on screen (LEV-129).
   */
  private rebaseFreePositions(previousOrigin: LayoutPoint): void {
    if (!this.document) return;
    const origin = this.originFor(this.document);
    const dx = previousOrigin.x - origin.x;
    const dy = previousOrigin.y - origin.y;
    const drag = this.topicDrag;
    if (drag) {
      if (drag.body) {
        // The body's own screen position comes from the viewport pan the drag drives (`carry`), not from
        // `overrides` — only the topics read those, to stay screen-fixed while the pan carries the body.
        // Moving the view the travel is measured under by the origins' difference in screen units keeps
        // the body from jumping; `carry` then pans by it and puts the topics back at `from` less the body's
        // travel, which the switch does not change (shifting `from` too would double-correct: the origin
        // term the topics sit against moves with them already).
        if (dx !== 0 || dy !== 0) {
          const scale = drag.view.scale;
          drag.view = { ...drag.view, x: drag.view.x + dx * scale, y: drag.view.y + dy * scale };
          this.carry(drag);
        }
      } else {
        if (dx !== 0 || dy !== 0) {
          for (const [id, point] of drag.from) drag.from.set(id, { x: point.x + dx, y: point.y + dy });
          for (const [id, point] of drag.overrides) drag.overrides.set(id, { x: point.x + dx, y: point.y + dy });
        }
        // Only a topic drag snaps (a body never does — `snapTarget` declines it outright), so only here
        // does `base`/`index` need a fresh, placeholder-free read under the new mode, taken now rather
        // than left for the next frame.
        const projection = this.projection();
        if (projection) {
          const sizes = this.renderer.sizes();
          drag.base = layoutTree(projection.root, sizes, this.collapsed, this.mode, this.topicLayouts());
          drag.sizes = sizes;
          drag.index = null;
        }
      }
    }
    if (this.pendingTopic) {
      this.pendingTopic = {
        ...this.pendingTopic, layout: this.mode,
        position: { x: this.pendingTopic.position.x + dx, y: this.pendingTopic.position.y + dy },
      };
    }
  }

  private scheduleRefresh(): void {
    // Invalidate pending reads immediately, before the debounced refresh begins.
    this.epoch += 1;
    if (this.refreshTimer !== undefined) this.contentEl.win.clearTimeout(this.refreshTimer);
    this.refreshTimer = this.contentEl.win.setTimeout(() => { this.refreshTimer = undefined; this.run(() => this.refresh()); }, 45);
  }

  /**
   * One refresh, tracked while it runs (the last one started wins, as with the epoch), so the export can wait for it.
   * `own`: the re-read right after a write of this view's own that `showOwnWrite` has already drawn (`reread`).
   */
  private refresh(own = false): Promise<void> {
    const task = this.reread(own).finally(() => {
      if (this.refreshing !== task) return;
      this.refreshing = undefined;
      // A fit held for this read runs now even when the read failed and drew nothing, not on some later unrelated frame.
      if (this.fitHeld && this.refreshTimer === undefined) this.scheduleLayout();
    });
    this.refreshing = task;
    return task;
  }

  private async reread(own = false): Promise<void> {
    if (!this.ready || this.closed) return;
    const epoch = ++this.epoch;
    const file = this.file;
    if (!file) {
      this.emptyState.hidden = false;
      this.renderer.update([], parseMarkdown("", ""), "", this.collapsed, { visualRootId: "root", mode: this.mode });
      this.drawEdges([]);
      return;
    }
    const source = await this.store.read(file);
    if (this.closed || epoch !== this.epoch || file !== this.file) return;
    const changed = source !== this.document?.source || this.document.root.title !== file.basename;
    // The view's own writes answer for this read while they lead from the text this view last parsed to
    // exactly the text found; their edits then carry the ids across (LEV-146). Anything else means someone
    // else has written, and the writes are of no use to any later read either.
    const replayed = this.replayOwnWrites(source, file.basename);
    if (!replayed) this.ownWrites = [];
    const document = changed || !this.document
      ? replayed?.document ?? parseMarkdown(source, file.basename, this.document) : this.document;
    // The maps the items call are read with the note (the items may have changed), and the note is published together
    // with them: nothing between here and the draw sees a document whose trees are not on screen.
    const targets: CallTargets = this.callsMaps(document) ? await this.reader.read(document, file.path) : new Map();
    if (this.closed || epoch !== this.epoch || file !== this.file) return;
    // Spent only now: a read superseded above leaves the writes for the read that wins, which finds the same
    // text on the same note and carries the ids after all. A write made while this read was under way is
    // kept for the next one.
    this.ownWrites = this.ownWrites.slice(replayed?.used ?? 0);
    // The write's own re-read finding the text the write just put on screen (`showOwnWrite`), with the same called maps, has
    // nothing to draw: the draw would repeat that one over every node. Any other read draws, as before (a layout set by
    // `setState` is drawn by its read, the watcher's re-read of the write draws once more, as it always did).
    if (own && !changed && sameTargets(this.targets, targets)) return;
    this.publish(changed ? document : undefined, targets);
    // Someone else's change under a draft kept by a conflict; the re-read after this view's own write is not that.
    if (changed && !this.saving) this.tellKeptDrafts();
  }

  /** `document` (when the note changed) and the called maps become what the map shows, and are drawn. */
  private publish(document: MindDocument | undefined, targets: CallTargets): void {
    if (document) {
      this.document = document;
      const ids = new Set([document.root.id, ...document.nodes.map(node => node.id)]);
      if (this.pendingTopic && !ids.has(this.pendingTopic.id)) this.pendingTopic = null;
      if (this.topicDrag && !ids.has(this.topicDrag.id)) this.endTopicDrag(this.topicDrag.id, false);
    }
    this.adopt(targets);
    this.emptyState.hidden = true;
    this.draw();
  }

  /**
   * A write of this view's own has landed on `file` (an edit, ⌘Z／⌘⇧Z): the text it wrote is shown at once, parsed
   * from the view's own writes so every id carries over (`replayOwnWrites`), without waiting for a read (LEV-219).
   * The re-read after the write gives up when the watcher of that very write schedules a newer one while it reads (a
   * read longer than the watcher's debounce: E53's `slow`), and until the newer one drew, the map showed the note
   * from before the write: the old title, no new node, a topic dropped on a slot or a branch detached back where it
   * was pressed. The text is the note as the store left it, so it is no guess: a change after it comes with a
   * watcher of its own, whose re-read draws it. The caller re-reads right after (`refresh`, in the same task), which
   * drops the reads begun before the write (the epoch): they may have read the note from before it. The maps the
   * items call are kept for the items that embed the same note as before; an item the write made a call or pointed
   * elsewhere waits for that read, so no caller shows the map another text called. Nothing is shown when the record
   * does not lead from the note shown to the text written (a re-read published another text meanwhile): the re-read
   * decides then. Nor for a note being left (`unloading`), which is neither re-read nor drawn again: the next note
   * follows. True when it drew.
   */
  private showOwnWrite(file: TFile, written: string): boolean {
    const previous = this.document;
    if (this.closed || this.unloading || file !== this.file || !previous || written === previous.source) return false;
    const replayed = this.replayOwnWrites(written, file.basename);
    if (!replayed) return false;
    this.ownWrites = this.ownWrites.slice(replayed.used);
    // By what each item embeds, not its text: an alias added to a call (`![[map|A]]`) still calls the same map.
    const embeds = (document: MindDocument): Map<string, string | null> => new Map(this.targets.size === 0 ? []
      : document.nodes.filter(node => this.targets.has(node.id)).map(node => [node.id, embedOnlyTitle(node.title)]));
    const before = embeds(previous);
    const after = embeds(replayed.document);
    const kept = new Map(Array.from(this.targets).filter(([id]) => (before.get(id) ?? null) !== null && before.get(id) === after.get(id)));
    this.publish(replayed.document, kept);
    return true;
  }

  /** A draft kept by a conflict (its error line up) learns that the note has moved on, and that saving it again may now apply. */
  private tellKeptDrafts(): void {
    this.inlineEditor?.refreshed(conflictMessage);
    this.bodyModal?.refreshed(conflictMessage);
  }

  /**
   * The parse of `source` from the view's own writes (`ownWrites`): each re-parses its text from the parse
   * before it, starting at the one the view shows, until one of them wrote exactly `source`. `used` is how
   * many were spent. Undefined when they do not lead there.
   */
  private replayOwnWrites(source: string, basename: string): { document: MindDocument; used: number } | undefined {
    let document = this.document;
    for (const [index, own] of this.ownWrites.entries()) {
      if (!document || document.source !== own.before) return undefined;
      document = this.parseOwn(own, document, basename);
      if (own.after === source) return { document, used: index + 1 };
    }
    return undefined;
  }

  /** True when a node's title is one embed: only then can another note's change alter what this map shows. */
  private callsMaps(document = this.document): boolean {
    if (!document) return false;
    if (this.calls?.document !== document) this.calls = { document, any: document.nodes.some(node => embedOnlyTitle(node.title) !== null) };
    return this.calls.any;
  }

  /**
   * Whether a change of `file` (renamed from `oldPath`) can alter the called maps (§5 M12): the note was read for
   * the last draw, or an item resolves to it now (a note created or made a map, or one that a link now points to).
   */
  private callConcerns(file: TAbstractFile, oldPath?: string): boolean {
    const host = this.file;
    const document = this.document;
    if (!host || !document || file === host || !this.callsMaps(document)) return false;
    if (this.reader.reads(file.path) || (oldPath !== undefined && this.reader.reads(oldPath))) return true;
    return document.nodes.some(node => {
      const linktext = embedOnlyTitle(node.title);
      return linktext !== null && resolveEmbedTarget(this.app, linktext, host.path)?.file === file;
    });
  }

  private scheduleRecall(): void {
    if (this.recallTimer !== undefined) this.contentEl.win.clearTimeout(this.recallTimer);
    this.recallTimer = this.contentEl.win.setTimeout(() => { this.recallTimer = undefined; this.run(() => this.refreshCalls()); }, 45);
  }

  /**
   * Another note changed: read the called maps again and redraw when any of them differs. The note itself is
   * not re-read; a refresh of it in flight (a newer epoch) supersedes this one, as it reads the calls itself.
   */
  private async refreshCalls(): Promise<void> {
    const document = this.document;
    const file = this.file;
    if (!document || !file || this.closed || !this.ready) return;
    const epoch = this.epoch;
    const targets = await this.reader.read(document, file.path);
    if (this.closed || epoch !== this.epoch || this.document !== document || file !== this.file) return;
    if (sameTargets(this.targets, targets)) return;
    this.adopt(targets);
    this.draw();
  }

  /**
   * Take a document and its called maps as the trees on the map: the body root plus the free topics beside it
   * (§5 M7; documents without headings keep the virtual root), with the called maps grafted in (§5 M12). The
   * folds are pruned to the nodes that exist, and a call new to the view starts folded below its root's children.
   * The only place `targets`, the projection and the fold set change together, so `projection()` stays a reader.
   */
  private adopt(targets: CallTargets): void {
    const document = this.document;
    if (!document) return;
    if (this.projected?.document === document && sameTargets(this.projected.targets, targets)) return;
    if (!sameTargets(this.targets, targets)) this.targets = targets;
    const trees = projectShown(document, this.targets);
    this.projected = { document, targets: this.targets, trees, positions: readTopicPositions(document.source), keys: topicKeys(document) };
    const collapsed = new Set(Array.from(this.collapsed).filter(id => trees.calls.byId.has(id)));
    for (const id of initialCallFolds(trees.calls)) if (!this.knownCalled.has(id)) collapsed.add(id);
    this.collapsed = collapsed;
    this.knownCalled = new Set(trees.calls.sources.keys());
  }

  /** The trees on the map as `adopt` made them: the body root (`root`) and the free topics with the calls grafted in, and the projection. */
  private projection(): { root: MindNode; topics: MindNode[]; calls: ShownTrees["calls"] } | undefined {
    const projected = this.projected;
    if (!projected || projected.document !== this.document) return undefined;
    const [root = projected.trees.split.root, ...topics] = projected.trees.calls.roots;
    return { root, topics, calls: projected.trees.calls };
  }

  /** Where a node drawn from a called map comes from (§5 M12); undefined for the host's own nodes. */
  private calledSource(id: string): CallSource | undefined {
    return this.projection()?.calls.sources.get(id);
  }

  /** True for a node of a called map other than the calling item: read-only on this map. */
  private isCalled(id: string): boolean {
    return isCalledNode(this.projection()?.calls, id);
  }

  /** A double click on a node of a called map opens that note as a map; false for the host's own nodes, which are edited. */
  private openCalled(id: string, newLeaf: boolean): boolean {
    const source = this.calledSource(id);
    const file = this.file;
    if (!source || !file) return false;
    this.run(() => this.app.workspace.openLinkText(source.path, file.path, newLeaf));
    return true;
  }

  /** Every edit addresses the host's own nodes; a called map's node is edited in its own note. */
  private assertEditable(id: string): void {
    if (this.isCalled(id)) throw new Error(CALLED_READ_ONLY_MESSAGE);
  }

  private isTopic(id: string): boolean {
    return this.projection()?.topics.some(topic => topic.id === id) ?? false;
  }

  /** Roots of the trees on the map move freely: the free topics and the body root itself. */
  private isFree(id: string): boolean {
    return this.projection()?.root.id === id || this.isTopic(id);
  }

  /**
   * Positions for this layout: a topic being dragged shows where the pointer holds it, a stored
   * position comes next, then the pressed point of a topic added on the map that no save has
   * stored yet. While a topic is dragged every other unpositioned topic keeps the slot `held` stacked it
   * in, so a child column does not flee from the moving tree before snap can find it (LEV-117 for the map
   * and the balanced map, LEV-125 for the timeline and the hierarchy); a placeholder holds them the same
   * way (LEV-95). The stack is dealt again once the slot goes or the drag ends. Topics sharing a heading
   * have keys of their own (`topicKeys`), so each finds its entry.
   */
  private topicLayouts(trees?: readonly LayoutNode[], held?: LayoutResult): FreeTopicLayout[] {
    const projected = this.projected;
    if (!projected) return [];
    const topics = projected.trees.split.topics;
    // Keys come from the headings as written (`split`); the tree laid out is the one shown (a topic may call a map).
    const own = topics.map(topic => {
      const stored = projected.positions.get(projected.keys.get(topic.id) ?? topic.title)?.[this.mode];
      const pending = this.pendingTopic?.id === topic.id && this.pendingTopic.layout === this.mode ? this.pendingTopic.position : undefined;
      return this.topicDrag?.overrides.get(topic.id) ?? stored ?? pending;
    });
    // Only a topic with no position of its own reads the hold, so a note whose topics all have one (the common case,
    // and every frame outside a drag or a placeholder) never walks the held layout's nodes.
    const unplaced = topics.filter((topic, index) => !own[index]).map(topic => topic.id);
    const kept = held && unplaced.length > 0 ? rootOffsets(held, unplaced) : undefined;
    return topics.map((topic, index) => {
      const position = own[index] ?? kept?.get(topic.id);
      return { tree: trees?.[index + 1] ?? projected.trees.calls.roots[index + 1] ?? topic, position: position ? { x: position.x, y: position.y } : null };
    });
  }

  private visible(): MindNode[] {
    const projection = this.projection();
    if (!projection) return [];
    const result: MindNode[] = [];
    const pending = [projection.root, ...projection.topics].reverse();
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node) break;
      result.push(node);
      if (!this.collapsed.has(node.id)) pending.push(...[...node.children].reverse());
    }
    return result;
  }

  private draw(): void {
    const projection = this.projection();
    if (!this.document || !this.file || !projection) return;
    this.syncModeButtons();
    const active = this.canvas.doc.activeElement;
    const focused = active?.instanceOf(HTMLElement) && active.classList.contains("mappy-node") ? active : null;
    const nodes = this.visible();
    this.renderer.update(nodes, this.document, this.file.path, this.collapsed, {
      visualRootId: projection.root.id, topicIds: new Set(projection.topics.map(topic => topic.id)), mode: this.mode,
      sources: projection.calls.sources, trees: [projection.root, ...projection.topics],
    });
    // The update may have restyled the node being edited (is-root / is-stage set the weight): its draft is measured again.
    this.inlineEditor?.fit();
    // One node stays selected (the first when the selected one is gone, or the note just opened) unless the empty canvas was clicked.
    if (!this.deselected && !nodes.some(node => node.id === this.selectedId)) this.selectedId = nodes[0]?.id ?? null;
    this.renderer.select(this.selectedId);
    // Undo, delete or an external change can replace the focused node's element; the keyboard stays on the map.
    if (focused && !focused.isConnected && this.selectedId) this.renderer.focus(this.selectedId);
    this.scheduleLayout();
  }

  /**
   * The layout buttons as the settings and the current layout leave them; with every layout listed,
   * nothing is hidden. Called wherever `mode` changes, not only from draw(), which needs a document.
   */
  private syncModeButtons(): void {
    for (const [mode, button] of this.modeButtons) {
      button.hidden = mode !== this.mode && !this.visibleLayouts.includes(mode);
      button.toggleClass("is-active", mode === this.mode);
      button.setAttribute("aria-pressed", String(mode === this.mode));
    }
  }

  /**
   * A frame whose only change is where a dragged tree sits: everything the layout reads besides that
   * offset is the same, so the snap's reading of the map survives it. Its own method rather than an
   * argument to `scheduleLayout`, which is passed around as a bare callback (LEV-126).
   */
  private scheduleCarriedLayout(): void { this.requestLayout(true); }

  private scheduleLayout(): void { this.requestLayout(false); }

  /**
   * `carried` says the request comes from a dragged tree following the pointer; every other request
   * leaves the next base for the snap to read again. The flag outlives a coalesced frame, so a redraw
   * asking for the same frame as a pointer move still counts.
   */
  private requestLayout(carried: boolean): void {
    if (!this.ready || this.closed) return;
    if (!carried) this.snapIndexStale = true;
    if (this.layoutFrame !== undefined) return;
    this.layoutFrame = this.contentEl.win.requestAnimationFrame(() => {
      this.layoutFrame = undefined;
      const projection = this.projection();
      if (!projection || this.closed) return;
      const sizes = this.renderer.sizes();
      const preview = this.previewLayout(projection, sizes);
      const plain = this.plain;
      // One hold for both: `plain` is this drag's own base as well (both take `this.layout` on every
      // placeholder-free frame), and it carries the note and mode the offsets were measured in. Every
      // layout holds the same way: the timeline's axis and the hierarchy's row restack out from under the
      // pointer exactly as the map's column did (LEV-125). Dragging the body root instead moves every
      // topic through `overrides`, which leaves nothing for a hold.
      const drag = this.topicDrag && !this.topicDrag.body;
      const held = (preview || drag) && plain && plain.file === this.file && plain.mode === this.mode ? plain.layout : undefined;
      this.layout = layoutTree(preview?.trees[0] ?? projection.root, sizes, preview?.collapsed ?? this.collapsed, this.mode,
        this.topicLayouts(preview?.trees, held));
      if (!preview) this.plain = { file: this.file, mode: this.mode, layout: this.layout };
      // Only a base the snap actually takes clears the flag, so a change made while a placeholder was laid
      // out still reaches the first base after it. The sizes are checked as well: they are read from the
      // DOM here, not requested, so a change nobody asked a layout for would otherwise keep a stale index.
      if (this.topicDrag && !preview) {
        const drag = this.topicDrag;
        if (this.snapIndexStale || !sameSizes(drag.sizes, sizes)) drag.index = null;
        this.snapIndexStale = false;
        drag.base = this.layout;
        drag.sizes = sizes;
      }
      this.renderer.place(this.layout.nodes, this.layout.folds);
      const slot = this.layout.nodes.find(node => node.id === PLACEHOLDER_ID);
      this.placeholder.hidden = !slot;
      if (slot) {
        this.placeholder.style.width = `${slot.width}px`;
        this.placeholder.style.height = `${slot.height}px`;
        this.placeholder.style.transform = `translate(${slot.x}px, ${slot.y}px)`;
      }
      this.drawEdges(this.layout.edges);
      // A fit asked for mid-drag (a layout button pressed by a second pointer) waits until the drag ends (LEV-182): the
      // carried tree would now stay on the pointer through it (`viewportMoved`, LEV-194), but the map would reframe
      // under the hand for a request the drag did not make. A fit that outlived a drag (`fitHeld`) also
      // waits for a re-read scheduled or under way, so it frames the note as the reads leave it: the drop's own text is
      // on screen once the save lands (`showOwnWrite`, LEV-219), but where the view's record does not lead to it, only
      // a re-read draws it, and the save's own gives up when the watcher schedules a newer one (`commit`).
      // Any other fit runs at once, as it always has.
      const waiting = this.topicDrag !== null || (this.fitHeld && (this.refreshTimer !== undefined || this.refreshing !== undefined));
      if (this.needsFit && !waiting && this.canvas.clientWidth > 0 && this.canvas.clientHeight > 0) {
        this.viewport.fit(this.layout.bounds); this.clearFit();
      }
      // A node to reveal is brought into view after the fit, as in the frame both run in, not before a fit that would move it again.
      if (this.revealId && !(this.needsFit && waiting)) { this.ensureVisible(this.revealId); this.revealId = null; }
    });
  }

  /** Reuse path elements across frames; only changed connectors touch the DOM. */
  private drawEdges(edges: LayoutResult["edges"]): void {
    const retained = new Set<string>();
    for (const edge of edges) {
      retained.add(edge.id);
      let path = this.edgePaths.get(edge.id);
      if (!path) {
        path = this.svg.createSvg("path");
        this.edgePaths.set(edge.id, path);
      }
      if (path.getAttribute("d") !== edge.path) path.setAttribute("d", edge.path);
      const preview = edge.to === PLACEHOLDER_ID;
      path.toggleClass("is-preview", preview);
      // The thick connector must sit above the thin ones it overlaps along the shared trunk.
      if (preview && path !== this.svg.lastElementChild) this.svg.append(path);
    }
    for (const [id, path] of this.edgePaths) {
      if (retained.has(id)) continue;
      path.remove();
      this.edgePaths.delete(id);
    }
  }

  /** Show or clear the slot a pending drop would fill; the layout makes room for it on the next frame. */
  private previewDrop(command: MoveCommand | null): void {
    // A topic held over a slot shows as the plain node it becomes when it joins.
    const drag = this.topicDrag;
    if (drag && !drag.body) this.renderer.entries.get(drag.id)?.element.toggleClass("is-merging", command?.nodeId === drag.id);
    const current = this.dropPreview;
    if (current === command || (current && command && current.nodeId === command.nodeId
      && current.parentId === command.parentId && current.index === command.index)) return;
    this.dropPreview = command;
    if (!command) this.placeholder.hidden = true;
    this.scheduleLayout();
  }

  /**
   * Layout input with an empty placeholder in the previewed slot, sized like the moving node.
   * `trees[0]` is the body and `trees[i + 1]` the i-th free topic; only the destination's tree is rebuilt.
   */
  private previewLayout(
    projection: NonNullable<ReturnType<MindmapView["projection"]>>, sizes: Map<string, { width: number; height: number }>,
  ): { trees: LayoutNode[]; collapsed: ReadonlySet<string> } | null {
    const dropped = this.dropPreview;
    const size = dropped ? sizes.get(dropped.nodeId) : undefined;
    if (!dropped || !size || !this.document) return null;
    // The slot is counted among the parent's own children; on the map a calling item shows the called root's children first (§5 M12).
    const parentSource = projection.calls.sources.get(dropped.parentId);
    const command = parentSource?.root ? { ...dropped, index: dropped.index + parentSource.node.children.length } : dropped;
    const roots: MindNode[] = [projection.root, ...projection.topics];
    // Topics first: a virtual-root body also parents them, so it would claim their destinations.
    let previewed = -1;
    let tree: LayoutNode | null = null;
    for (let index = roots.length - 1; index >= 0 && !tree; index -= 1) {
      const root = roots[index];
      tree = root ? previewTree(root, command, this.collapsed) : null;
      previewed = index;
    }
    if (!tree) return null;
    const trees = roots.map((root, index): LayoutNode => index === previewed && tree ? tree : root);
    sizes.set(PLACEHOLDER_ID, size);
    // A collapsed destination reveals only the placeholder, so it must not be measured as collapsed.
    const collapsed = this.collapsed.has(dropped.parentId)
      ? new Set(Array.from(this.collapsed).filter(id => id !== dropped.parentId)) : this.collapsed;
    return { trees, collapsed };
  }

  /** The host's own node for the host's ids (its title as written, for editing); the node as shown for a called map's (§5 M12). */
  private selected(): MindNode | undefined {
    const id = this.selectedId;
    if (!this.document || id === null) return undefined;
    if (id === "root") return this.document.root;
    return this.document.nodes.find(node => node.id === id) ?? this.projection()?.calls.byId.get(id);
  }

  private select(id: string, focus = false): void {
    this.selectedId = id; this.deselected = false; this.renderer.select(id);
    if (focus) {
      this.renderer.focus(id);
      if (this.layout?.nodes.some(node => node.id === id)) this.ensureVisible(id);
      else { this.revealId = id; this.scheduleLayout(); }
    }
  }

  /** A click on the empty canvas (MapViewport's judgement: not a pan): nothing selected, on screen and for the keys, until a node is selected again. */
  private deselect(): void {
    this.selectedId = null; this.deselected = true; this.renderer.select(null);
  }

  private ensureVisible(id: string): void {
    const node = this.layout?.nodes.find(item => item.id === id);
    if (!node) return;
    const view = this.viewport.value;
    const left = node.x * view.scale + view.x;
    const top = node.y * view.scale + view.y;
    const right = left + node.width * view.scale;
    const bottom = top + node.height * view.scale;
    const margin = 30;
    const dx = left < margin ? margin - left : right > this.canvas.clientWidth - margin ? this.canvas.clientWidth - margin - right : 0;
    const dy = top < margin ? margin - top : bottom > this.canvas.clientHeight - margin ? this.canvas.clientHeight - margin - bottom : 0;
    if (dx || dy) this.viewport.set({ ...view, x: view.x + dx, y: view.y + dy });
  }

  private fold(id: string): void {
    if (this.collapsed.has(id)) this.collapsed.delete(id); else this.collapsed.add(id);
    this.draw();
  }

  private executeSelected(type: "add-child" | "add-sibling" | "delete" | "move-up" | "move-down"): void {
    const node = this.selected();
    if (node) this.run(() => this.execute({ type, nodeId: node.id }));
  }

  private async execute(command: EditCommand): Promise<void> {
    if (this.saving) return;
    if ("nodeId" in command) this.assertEditable(command.nodeId);
    if ("parentId" in command) this.assertEditable(command.parentId);
    // A kept draft (E05) still addresses its node and a structural edit under it would move what the draft
    // comes back to, so the draft is written first and the command plans against the note that leaves
    // (LEV-140). A draft that cannot be saved keeps its reason on its own error line, where the user is
    // typing, and the command stops rather than planning against a note the draft has not reached.
    if (this.inlineEditor && !await this.inlineEditor.confirm()) return;
    const document = this.document;
    const file = this.file;
    if (!document || this.saving) return;
    // A node added without its text (Tab, Enter, the menu) is written under its provisional name and named in place;
    // one added with its text (a called map) is only selected.
    const provisional = (command.type === "add-child" || command.type === "add-sibling") && command.title === undefined;
    const before = this.shownState();
    let name = NEW_NODE_TITLE;
    let plan = planEdit(document, provisional ? { ...command, title: name } : command);
    // A node that lands as a free topic (Enter on a topic's root, Tab on the note's own root) is named as the empty
    // canvas names one: the same kind of node under the same provisional name, whichever way it was made.
    if (provisional && this.addsTopic(document, plan)) {
      name = NEW_TOPIC_TITLE;
      plan = planEdit(document, { ...command, title: name });
    }
    const write = await this.commit(document.source, plan.edits, file, provisional);
    if (this.file !== file || this.closed) return;
    const selected = this.reveal(plan.selectionOffset);
    if (selected && provisional) this.editTitle({ write, ...before, name });
  }

  /** Whether the node `plan` adds is a free topic of the note it leaves. */
  private addsTopic(document: MindDocument, plan: { edits: TextEdit[]; selectionOffset: number | null }): boolean {
    const after = parseMarkdown(applyEdits(document.source, plan.edits), document.root.title);
    const added = nodeAt(after, plan.selectionOffset);
    return added !== undefined && projectMap(after).topics.some(topic => topic.id === added.id);
  }

  /** What an addition changes on screen besides the note: the selection, the folds it opens, the viewport it pans. */
  private shownState(): Pick<Created, "previous" | "collapsed" | "viewport"> {
    return { previous: this.selectedId, collapsed: new Set(this.collapsed), viewport: { ...this.viewport.value } };
  }

  /**
   * Call another map (§5 M12): `![[map]]` becomes the last child of the selected node (a topic's
   * root counts as selected) — one `add-child` edit with the link as its text, so the diff, the
   * history (Undo removes the item) and the selection are those of Tab. With nothing selected
   * (the empty canvas was clicked) it becomes a free topic instead: `## ![[map]]` at the end of
   * the note by one `add-topic` edit, with no position written, so the topic takes the default
   * place beside the body until it is dragged (§5 M7), and Undo removes the section. The virtual
   * root of a note without a heading section takes the same route: add-child there would write
   * the same heading. The called map's note is not touched. The link is always the wiki form the
   * map and the embed display read (`![[…]]`), its path following the vault's link-path setting
   * (`fileToLinktext`: shortest, relative or absolute).
   */
  async callMap(target: TFile): Promise<void> {
    const file = this.file;
    if (!file || !this.document) return;
    if (target.path === file.path) throw new Error("このマップ自身は呼び出せません。");
    // Tab stays quiet while a save is in flight; a chosen map must not vanish without a word.
    if (this.saving) throw new Error("保存処理が終わってから、もう一度実行してください。");
    const link = `![[${this.app.metadataCache.fileToLinktext(target, file.path, true)}]]`;
    const parent = this.selected();
    if (!parent || parent.kind === "root") { await this.execute({ type: "add-topic", title: link }); return; }
    this.assertEditable(parent.id);
    await this.execute({ type: "add-child", nodeId: parent.id, title: link });
  }

  /** Select the node a plan points at, unfolding its parent, after the document was re-read. */
  private reveal(offset: number | null): MindNode | undefined {
    const selected = this.document ? nodeAt(this.document, offset) : undefined;
    if (!selected) return undefined;
    if (selected.parentId) this.collapsed.delete(selected.parentId);
    this.draw(); this.select(selected.id, true);
    return selected;
  }

  /** Layout coordinates of a canvas-relative pixel, as an offset from the body root (`LayoutResult.origin`). */
  private topicPoint(point: { x: number; y: number }, origin = this.layout?.origin ?? { x: 0, y: 0 }): TopicPosition {
    const view = this.viewport.value;
    return { x: Math.round((point.x - view.x) / view.scale - origin.x), y: Math.round((point.y - view.y) / view.scale - origin.y) };
  }

  /** Where the body root will sit once `document` is laid out with the sizes on screen: what topic positions are measured from. */
  private originFor(document: MindDocument): { x: number; y: number } {
    // The called maps stay grafted in (their items keep their ids across the re-parse), so the body's height is as shown.
    const trees = projectShown(document, this.targets);
    return layoutTree(trees.calls.roots[0] ?? trees.split.root, this.renderer.sizes(), this.collapsed, this.mode).origin;
  }

  /**
   * A new top-level section at the end of the note under its provisional name (「トピック」, selected in the
   * draft: LEV-203), edited in place where the canvas was pressed (§5 M7). The position is stored by the edit
   * that names it, so the title and the `mappy-topics` entry are one step of the history; Escape takes the
   * section back (no step left for Undo), Undo after a confirmed name removes the name, then the section.
   * Without a point no position is kept or stored: the topic takes the default place of a topic with
   * no `mappy-topics` entry until it is dragged (the 操作 menu of LEV-77 added topics this way; no caller
   * does now, the popover of LEV-81 having no such item).
   */
  private async addTopic(point?: { x: number; y: number }): Promise<void> {
    const open = this.inlineEditor;
    // A draft held with a reason is saved only by its own Enter (editTitle): it stays, and no topic is added.
    if (open?.held()) { open.focus(); return; }
    // The save under way may be the draft's own (the blur of this very double click): confirm waits for it.
    if (this.saving && !open) return;
    if (open) {
      // Written first, as blur would, then the topic; a refusal keeps the draft with its reason and adds nothing.
      if (!await open.confirm()) return;
      // The write can resize its node and move the body root, which topic positions are measured from: the point
      // is read once the labels are drawn and placed (a short wait: a slow render elsewhere does not hold the topic).
      await this.renderer.idle(TOPIC_RENDER_WAIT_MS);
      if (this.layoutFrame !== undefined) await this.nextFrame();
    }
    const document = this.document;
    const file = this.file;
    if (!document || !file || this.saving) return;
    const position = point ? this.topicPoint(point) : null;
    const before = this.shownState();
    const plan = planEdit(document, { type: "add-topic", title: NEW_TOPIC_TITLE });
    const write = await this.commit(document.source, plan.edits, file, true);
    if (this.file !== file || this.closed) return;
    const created = this.document ? nodeAt(this.document, plan.selectionOffset) : undefined;
    // The first heading of a note becomes its body root and has no position.
    if (created && position && this.isTopic(created.id)) this.pendingTopic = { id: created.id, layout: this.mode, position };
    if (this.reveal(plan.selectionOffset)) this.editTitle({ write, ...before, name: NEW_TOPIC_TITLE });
  }

  /** The tree under a root on the map: the body's own subtree, or a topic's. */
  private treeOf(id: string): MindNode | undefined {
    const projection = this.projection();
    if (!projection) return undefined;
    return projection.root.id === id ? projection.root : projection.topics.find(topic => topic.id === id);
  }

  /** Hit testing must see through a tree that follows the pointer; its nodes also lift a little. */
  private markMoving(id: string): string[] {
    const marked: string[] = [];
    const pending = [this.treeOf(id)];
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node) continue;
      this.renderer.entries.get(node.id)?.element.addClass("is-drag-moving");
      marked.push(node.id);
      pending.push(...node.children);
    }
    return marked;
  }

  /** Remember where every affected topic sits before the pointer moves it. */
  private startTopicDrag(id: string): NonNullable<MindmapView["topicDrag"]> | null {
    const projection = this.projection();
    const layout = this.layout;
    if (!projection || !layout || !this.isFree(id)) return null;
    const body = projection.root.id === id;
    const from = rootOffsets(layout, (body ? projection.topics : projection.topics.filter(topic => topic.id === id)).map(topic => topic.id));
    this.topicDrag = {
      id, body, from, overrides: new Map(from), view: { ...this.viewport.value },
      delta: { x: 0, y: 0 }, offset: { x: 0, y: 0 }, marked: this.markMoving(id),
      base: layout, sizes: this.renderer.sizes(), index: null,
    };
    return this.topicDrag;
  }

  private endTopicDrag(id: string, restore: boolean): void {
    const drag = this.topicDrag;
    if (!drag || drag.id !== id) return;
    this.topicDrag = null;
    for (const marked of drag.marked) this.renderer.entries.get(marked)?.element.removeClass("is-drag-moving");
    this.renderer.entries.get(id)?.element.removeClass("is-merging");
    // The body goes back where it was among its topics, which stay as they are seen (a pan or zoom made mid-drag is kept).
    if (restore && drag.body) this.viewport.set(drag.view);
    // Set here, after the drag's own viewport is back, rather than by a frame that saw the drag: a frame can come late
    // or the release land inside one frame interval of the switch, and the hold must not hang on that (LEV-182).
    if (this.needsFit) this.fitHeld = true;
    this.scheduleLayout();
  }

  /** The fit is done or no longer wanted (a saved viewport restored, the view moved by hand after a drop). */
  private clearFit(): void {
    this.needsFit = false;
    this.fitHeld = false;
  }

  /**
   * Live drag of a free tree through the layout; null puts it back. A topic moves by the pointer
   * travel; the body root stays the origin, so its topics move the other way while the viewport
   * follows the pointer, which reads as the body moving among topics that stay put.
   */
  private shiftTopic(id: string, delta: DragDelta | null): void {
    if (!delta) { this.endTopicDrag(id, true); return; }
    const drag = this.topicDrag?.id === id ? this.topicDrag : this.startTopicDrag(id);
    if (!drag) return;
    drag.delta = delta;
    this.carry(drag);
  }

  /** How far the tree has come, in world units, once the pointer has travelled `delta` (screen pixels) since the press. */
  private travelled(drag: NonNullable<MindmapView["topicDrag"]>, delta: DragDelta): LayoutPoint {
    const scale = drag.view.scale;
    return { x: drag.offset.x + delta.x / scale, y: drag.offset.y + delta.y / scale };
  }

  /** Puts the tree where the drag has brought it: a topic through `overrides`; the body by the pan, its topics the other way. */
  private carry(drag: NonNullable<MindmapView["topicDrag"]>): void {
    const moved = this.travelled(drag, drag.delta);
    const sign = drag.body ? -1 : 1;
    for (const [topicId, start] of drag.from) drag.overrides.set(topicId, { x: start.x + sign * moved.x, y: start.y + sign * moved.y });
    if (drag.body) this.viewport.set({ ...drag.view, x: drag.view.x + moved.x * drag.view.scale, y: drag.view.y + moved.y * drag.view.scale }, true);
    // Only a topic carries one tree; the body root moves every topic at once, which is no base the snap can keep.
    if (drag.body) this.scheduleLayout();
    else this.scheduleCarriedLayout();
  }

  /**
   * The viewport moved under a drag by anything but the drag (the wheel, ⌘/Ctrl + wheel, a zoom or fit button, a
   * second pointer's pan or pinch, a node revealed, a restored state — LEV-194). The map moves as asked; the tree
   * carried stays with the pointer, the point grabbed under it at the new scale. So the tree's travel so far is
   * re-read under the new viewport: it is what it was, plus how far the world point under the pointer moved. For the
   * body, what the user sees move is its topics (the map's viewport is theirs panned by the body's travel), so the
   * viewport they are now seen under takes that travel back off. With no pointer holding the tree (released, its
   * place computed and being saved — `placeTopic` awaits the write — or a drag driven without one), the tree is
   * left where it is in the world, which is what the save stores: only the view the travel is measured under
   * follows. NodeDrag is told last, of the viewport as it ends up (the body's own pan included).
   */
  private viewportMoved(previous: Viewport, next: Viewport): void {
    const drag = this.topicDrag;
    const pointer = drag ? this.nodeDrag.pointer(drag.id) : null;
    if (drag) this.rebaseDrag(drag, next, pointer);
    this.nodeDrag.viewportMoved(previous, this.viewport.value);
  }

  /** `viewportMoved` for the free tree under way: its travel re-read under `next`, the pointer (canvas pixels) kept on the point grabbed. */
  private rebaseDrag(drag: NonNullable<MindmapView["topicDrag"]>, next: Viewport, pointer: LayoutPoint | null): void {
    const moved = this.travelled(drag, drag.delta);
    const scale = next.scale;
    const view = drag.body ? { x: next.x - moved.x * scale, y: next.y - moved.y * scale, scale } : { ...next };
    const under = (at: Viewport, point: LayoutPoint): LayoutPoint => ({ x: (point.x - at.x) / at.scale, y: (point.y - at.y) / at.scale });
    const shift = pointer ? { x: under(view, pointer).x - under(drag.view, pointer).x, y: under(view, pointer).y - under(drag.view, pointer).y } : { x: 0, y: 0 };
    // From here the travel is measured under `view`: the tree has come `moved` (plus how far the world point under
    // the pointer moved), and further travel adds to it at the new scale.
    drag.view = view;
    drag.offset = { x: moved.x + shift.x - drag.delta.x / scale, y: moved.y + shift.y - drag.delta.y / scale };
    if (pointer) this.carry(drag);
  }

  /** A free tree released on the canvas: only `mappy-topics` entries for this layout change (all of them for the body). */
  private async placeTopic(id: string, delta: DragDelta): Promise<void> {
    const document = this.document;
    const file = this.file;
    const projection = this.projection();
    const drag = this.topicDrag?.id === id ? this.topicDrag : this.startTopicDrag(id);
    try {
      if (!document || !file || !projection || !drag) return;
      const moved = this.travelled(drag, delta);
      const sign = drag.body ? -1 : 1;
      // By node id: the plan derives each topic's key from the heading as written (a topic that calls a map shows the called
      // root's text instead). A topic whose id an external change replaced during the drag is left out rather than refused.
      const moves = new Map<string, TopicPosition>();
      for (const [topicId, start] of drag.from) {
        if (!projection.topics.some(topic => topic.id === topicId)) continue;
        moves.set(topicId, { x: Math.round(start.x + sign * moved.x), y: Math.round(start.y + sign * moved.y) });
      }
      const layout = this.mode;
      const edit = planTopicMoves(document, layout, moves);
      if (edit) await this.commit(document.source, [edit], file);
      if (this.pendingTopic && (drag.body || this.pendingTopic.id === id)) this.pendingTopic = null;
    } finally {
      this.endTopicDrag(id, false);
    }
  }

  /**
   * A branch released on empty canvas becomes its own topic (§5 M7 切り離し): a new section at the
   * end of the note, placed where the ghost was, both in one edit set so Undo brings the branch back.
   */
  private async detachNode(id: string, point: { x: number; y: number }): Promise<void> {
    const document = this.document;
    const file = this.file;
    if (!document || !file || this.saving) return;
    // Removing the branch re-centres the body root, so the drop point is measured from where the root will be.
    // The simulation takes its own edits, so the folds and the called maps — both held by node id — answer for
    // the same nodes as on screen (LEV-146).
    const removal = planEdit(document, { type: "detach", nodeId: id }).edits;
    const detached = parseMarkdown(applyEdits(document.source, removal), file.basename, document, undefined, removal);
    const position = this.topicPoint(point, this.originFor(detached));
    const plan = planEdit(document, { type: "detach", nodeId: id, position: { layout: this.mode, x: position.x, y: position.y } });
    await this.commit(document.source, plan.edits, file);
    if (this.file !== file || this.closed) return;
    this.reveal(plan.selectionOffset);
  }

  /**
   * The slot a dragged topic would join, from where its root sits (`snapSlot` holds each layout's
   * zones): beside a leaf (or a collapsed node) it becomes the last child; level with a node's
   * children it slots in among them. Judged against the drag's placeholder-free layout, so the slot
   * shown cannot move the nodes it depends on; it is then kept while the root stays in a widened
   * zone, so a small drift does not flip the preview. Only topics snap; the body never joins.
   */
  private snapTarget(draggedId: string, root: { x: number; y: number; width: number; height: number }, current: MoveCommand | null): MoveCommand | null {
    const document = this.document;
    const drag = this.topicDrag;
    if (!document || !drag || drag.body || drag.id !== draggedId) return null;
    const layout = drag.base;
    const view = this.viewport.value;
    const rect = { x: (root.x - view.x) / view.scale, y: (root.y - view.y) / view.scale, width: root.width / view.scale, height: root.height / view.scale };
    const moving = new Set(drag.marked);
    const { byId, children, places } = drag.index ??= this.snapIndex(layout, moving);
    const slotFor = (node: PositionedNode, widen: number): SnapSlot | null =>
      snapSlot(this.mode, rect, node, children.get(node.id) ?? [], widen, places.get(node.id));
    const resolve = (slot: SnapSlot | null): MoveCommand | null =>
      slot ? resolveDrop(document, draggedId, slot.targetId, slot.position) : null;
    let kept: number | null = null;
    if (current) {
      const parent = byId.get(current.parentId);
      const slot = parent ? slotFor(parent, 2) : null;
      const same = slot ? resolve(slot) : null;
      if (slot && same && same.parentId === current.parentId && same.index === current.index) kept = slot.distance;
    }
    let best: { command: MoveCommand; distance: number } | null = null;
    for (const node of layout.nodes) {
      if (node.id === PLACEHOLDER_ID || moving.has(node.id)) continue;
      const slot = slotFor(node, 1);
      if (!slot || (best && slot.distance >= best.distance)) continue;
      const command = resolve(slot);
      if (command) best = { command, distance: slot.distance };
    }
    if (current && kept !== null && (!best || best.distance >= kept - SNAP_STICK)) return current;
    return best?.command ?? null;
  }

  /**
   * What the snap reads from a placeholder-free layout: the visible children of every node (the moving
   * tree left out) and, where the zones depend on it, each node's place. Every tree's root is "root"
   * (in the map and the balanced map its first child hangs a root gap off, farther than a branch's),
   * except in the hierarchy, whose zones read no place. On the timeline a stage's forest hangs above
   * the axis for even stages and below for odd ones (`placeTimeline`), past the band its tree keeps
   * clear around the axis (`axisBand`); in the balanced map a tree's first level sits right or left of
   * its root (`balancedSideOf`) and every deeper node keeps that side. Any other layout gets its roots
   * only.
   */
  private snapIndex(layout: LayoutResult, moving: ReadonlySet<string>): SnapIndex {
    const byId = new Map(layout.nodes.map(node => [node.id, node]));
    const children = new Map<string, PositionedNode[]>();
    const parents = new Set<string>();
    for (const edge of layout.edges) {
      const child = byId.get(edge.to);
      if (!child || edge.to === PLACEHOLDER_ID || moving.has(edge.from) || moving.has(edge.to)) continue;
      const list = children.get(edge.from) ?? [];
      list.push(child);
      children.set(edge.from, list);
      parents.add(edge.to);
    }
    const places = new Map<string, NodePlace>();
    if (this.mode !== "hierarchy") {
      for (const node of layout.nodes) {
        if (parents.has(node.id)) continue;
        places.set(node.id, "root");
        const kids = children.get(node.id) ?? [];
        if (this.mode === "timeline") { const band = axisBand(node, kids); kids.forEach((stage, index) => { places.set(stage.id, { side: index % 2 === 0 ? "upper" : "lower", band }); }); }
        if (this.mode !== "balanced") continue;
        const pending = kids.map(kid => ({ kid, side: balancedSideOf(node, kid) }));
        for (let next = pending.pop(); next; next = pending.pop()) {
          places.set(next.kid.id, next.side);
          for (const kid of children.get(next.kid.id) ?? []) pending.push({ kid, side: next.side });
        }
      }
    }
    return { byId, children, places };
  }

  /** A drop on a slot: a topic joins the node as a branch; a failed move puts the tree back. */
  private async executeDrop(command: MoveCommand): Promise<void> {
    try { await this.execute(command); }
    finally { this.endTopicDrag(command.nodeId, true); }
  }

  /**
   * `retractable`: the edit adds a node that Escape on its draft may take back (`retract`); the store keeps the Redo
   * steps it drops until then.
   */
  private commit(source: string, edits: TextEdit[], file = this.file, retractable = false): Promise<CarriedWrite> {
    return this.writeOwn(source, file, target => this.store.applyOver(target, source, edits, { retractable }));
  }

  /**
   * One write of this view's own, planned on `source`: `perform` makes it in the store, and the view records it so
   * the re-read carries the ids over, rebases the open drafts and reads the note again.
   */
  private async writeOwn(source: string, file: TFile | null, perform: (file: TFile) => Promise<CarriedWrite>): Promise<CarriedWrite> {
    if (!file || file !== this.file || this.closed) throw new Error(NOTE_CHANGED_MESSAGE);
    if (this.saving) throw new Error("保存処理が終わってから、もう一度実行してください。");
    // Read before the write: a draft that already disagrees with the note is left alone, so an external
    // change that arrived first is still refused when the draft is saved (E05).
    const drafts = this.currentDrafts();
    const planned = this.document;
    this.saving = true;
    try {
      let write: CarriedWrite;
      // A layout button pressed after the edit was planned (LEV-196) is carried over by the store.
      try { write = await perform(file); }
      // A refused write means the note moved on; re-read it here too, so a kept draft can retry even where no watcher reports the change.
      catch (error) { this.scheduleRefresh(); throw error; }
      const written = write.after;
      // What the next read of this note is measured against: the folds, the selection, a drag and any open
      // draft all name nodes by id, and only these edits can carry those ids over the re-parse (LEV-146).
      const carried = this.recordCarried(write.carried);
      this.recordOwn(write);
      // Rebased from the text this view just wrote, before the re-read: `reread` gives up when a newer epoch
      // was scheduled — the modify watcher for this very write schedules one — so waiting for it would leave
      // the draft on the old note now and then, and adopting whatever came back would bless an external
      // change that landed in between. Both are the E05 refusal this fix exists to keep (LEV-140).
      const base = this.writeBase(planned, source, write, carried, file.basename);
      if (drafts.length > 0 && base) this.rebaseDrafts(drafts, base, written, write.edits);
      const shown = this.showOwnWrite(file, written);
      // The note being left (a draft saved on the way out) is not read again: what it would show goes right after.
      if (!this.unloading) await this.refresh(shown);
      return write;
    } finally { this.saving = false; }
  }

  /**
   * Take back a node this view has just added, whose draft was dismissed with Escape untouched and before anything
   * was written to it (LEV-203): the note goes back to its text before the addition, with no step left for Undo or
   * Redo, and the node selected before the addition is selected again. Taken back as this view's own write, so
   * the re-read carries every id over (folds, the selection), same-titled nodes included; with nothing selected
   * before, nothing is selected after. The caller asks only while the note is as the addition left it and
   * nothing else is being written; the store still refuses (the node stays, a Notice says why) if a change
   * lands in between: then the node stays as after any Escape, with no error. A topic keeps the point it was
   * pressed at until the section is really gone. The folds the addition opened and the viewport it panned come
   * back too.
   */
  private async retract(file: TFile, created: Created, nodeId: string): Promise<void> {
    if (file !== this.file || this.closed || this.saving) { this.draw(); return; }
    try {
      await this.writeOwn(created.write.after, file, async target => {
        const write = await this.store.retract(target, created.write);
        if (this.pendingTopic?.id === nodeId) this.pendingTopic = null;
        // Nothing selected before the addition stays so: the re-read would otherwise select the first node.
        if (!created.previous) this.deselect();
        // The folds the addition opened close again (the ids are carried over the re-read).
        this.collapsed = new Set(created.collapsed);
        return { ...write, carried: [] };
      });
    } catch (error) {
      // The note changed in a way the view had not read yet (an edit from outside within the refresh's debounce):
      // the node stays, and Escape is what it is on any node — the draft given up — rather than an error.
      if (!(error instanceof Error) || error.message !== conflictMessage) throw error;
      if (this.file === file && !this.closed) this.draw();
      return;
    }
    if (this.file !== file || this.closed || !this.document) return;
    if (created.previous && findNode(this.document, created.previous)) this.select(created.previous, true);
    // The viewport as it was, which showed the node selected then, once the layout of the closed folds is on screen
    // (that frame keeps what is on screen in place, and would pan it again): no reveal is left for later either.
    this.revealId = null;
    if (this.layoutFrame !== undefined) await this.nextFrame();
    if (this.file !== file || this.closed) return;
    this.viewport.set(created.viewport);
  }

  /** `created`: the draft names a node just added (its provisional name selected); Escape then takes the node back. */
  private editTitle(created?: Created): void {
    // The draft already open is confirmed before another opens (a double click on a node, F2 from the menu), as blur
    // would save it; one held with a reason (a refusal, a conflict: its error line up) is saved only by its own Enter,
    // so it stays where it is, instead of being dropped for the node's old text or written unasked (LEV-202).
    const open = this.inlineEditor;
    if (open?.held()) { open.focus(); return; }
    if (open) {
      const wanted = this.selectedId;
      const file = this.file;
      this.run(async () => {
        // A refused save keeps the draft focused with its reason (InlineEditor.settle).
        if (!await open.confirm()) return;
        // Ids are only this note's: another note taking the leaf while the save ran has its own `node-N`s.
        if (this.inlineEditor || this.closed || this.file !== file) return;
        // Closing the draft selects its node again; the node asked for is the one to edit.
        if (wanted && this.document && findNode(this.document, wanted)) this.select(wanted, true);
        this.editTitle();
      });
      return;
    }
    const node = this.selected();
    const document = this.document;
    const file = this.file;
    if (!node || !document || !file) return;
    if (node.kind === "root") { new Notice("このノードはファイル名です。子ノードを追加できます。"); return; }
    if (this.isCalled(node.id)) { new Notice(CALLED_READ_ONLY_MESSAGE); return; }
    const entry = this.renderer.entries.get(node.id);
    if (!entry) return;
    // The editor stands in for the node's text; the node keeps showing its images, so one pasted while the
    // draft is open appears at once instead of when the draft is confirmed (報告: 2026-09-22).
    this.renderer.editing(node.id, true);
    let renamedOffset: number | null = null;
    const draft: DraftBase = { nodeId: node.id, value: draftFingerprint(document, node) };
    this.inlineDraft = draft;
    this.inlineEditor = new InlineEditor(entry.element, {
      // Its `<br>` tags are line breaks in the draft; the rename writes them back (core/title-breaks, LEV-202).
      initial: displayTitle(node.title),
      suggest: input => new LinkSuggest(this.app, input, file.path),
      save: async text => {
        // A topic added on the map is placed where it was pressed by the same edit set that names it.
        const pending = this.pendingTopic?.id === node.id ? this.pendingTopic : null;
        // The draft outlives an external change that refreshed the map (E05): plan against the note as it is now.
        const { document: current, node: target } = this.draftTarget(file, draft);
        const plan = planEdit(current, {
          type: "rename", nodeId: target.id, title: text,
          ...(pending ? { position: { layout: pending.layout, x: pending.position.x, y: pending.position.y } } : {}),
        });
        await this.commit(current.source, plan.edits, file);
        renamedOffset = plan.selectionOffset;
        if (pending && this.pendingTopic === pending) this.pendingTopic = null;
      },
      finish: (next, cancelled, text) => {
        this.inlineEditor = undefined;
        if (this.inlineDraft === draft) this.inlineDraft = undefined;
        this.renderer.editing(node.id, false);
        if (this.closed || this.unloading || file !== this.file) return;
        // Dismissed right after the addition — the provisional name untouched, the note still as the addition left
        // it — the node goes too. Once the user has typed, or something else has been written or is on its way (an
        // image pasted onto it, the draft's own save that an Escape pressed during it cannot stop, a change from
        // outside), Escape only closes the draft, as on any node.
        if (cancelled && created && text === created.name && !this.saving && this.prepared === 0
          && this.document?.source === created.write.after) {
          this.run(() => this.retract(file, created, node.id));
          return;
        }
        this.draw();
        // A frontmatter edit in the same set shifts every offset, so the renamed node is found by the plan's selection.
        const current = this.document?.nodes.find(item => item.id === node.id)
          ?? (!cancelled && this.document ? nodeAt(this.document, renamedOffset) : undefined)
          ?? (!cancelled ? this.document?.nodes.find(item => item.from === node.from) : undefined);
        // A click on the empty canvas that ended the edit (the blur saved it) leaves nothing selected; the node is not taken back.
        if (current && !this.deselected) this.select(current.id, true);
        if (!cancelled && next === "child" && current) this.run(() => this.execute({ type: "add-child", nodeId: current.id }));
      },
      resize: () => { this.scheduleLayout(); },
      restore: () => { this.renderer.editing(node.id, false); },
    });
  }

  private editBody(): void {
    const node = this.selected();
    const document = this.document;
    const file = this.file;
    if (!node || !document || !file) return;
    if (this.isCalled(node.id)) { new Notice(CALLED_READ_ONLY_MESSAGE); return; }
    const draft: DraftBase = { nodeId: node.id, value: draftFingerprint(document, node) };
    this.bodyDraft = draft;
    const modal = new EditModal(this.app, nodeBody(document, node), "本文・リンクを編集", true, async text => {
      const { document: current, node: target } = this.draftTarget(file, draft);
      await this.commit(current.source, [planBodyEdit(current, target.id, text)], file);
    });
    const close = modal.onClose.bind(modal);
    modal.onClose = () => {
      if (this.bodyDraft === draft) this.bodyDraft = undefined;
      if (this.bodyModal === modal) this.bodyModal = undefined;
      close();
    };
    this.bodyModal = modal;
    modal.open();
  }

  /** The open drafts still on their node, reading as they did when the draft was last in step with the note. */
  private currentDrafts(): DraftBase[] {
    const document = this.document;
    if (!document) return [];
    return [this.inlineDraft, this.bodyDraft].filter((draft): draft is DraftBase => {
      if (!draft) return false;
      const node = findNode(document, draft.nodeId);
      return node !== undefined && draftFingerprint(document, node) === draft.value;
    });
  }

  /**
   * After the map's own write, a draft that was current before it stays current: what changed is this
   * view's doing (an image pasted onto the node being edited, a command run from under the draft), not
   * another app's, and the save must not tell the user their own action changed the note (LEV-140).
   * `written` is the text this view put on disk, parsed here rather than read back, so neither a lost
   * re-read nor an external change that arrived in between can decide what the draft is measured against.
   * The parse takes the edits, as the re-read's will, so both number the nodes the same way (LEV-146).
   */
  private rebaseDrafts(drafts: readonly DraftBase[], planned: MindDocument, written: string, edits: readonly TextEdit[]): void {
    const document = parseMarkdown(written, this.file?.basename ?? "", planned, undefined, edits);
    for (const draft of drafts) {
      const node = findNode(document, draft.nodeId);
      if (node) draft.value = draftFingerprint(document, node);
    }
  }

  /**
   * The note a kept draft applies to once the map has refreshed under it (E05): the view's current parse,
   * provided the node is still there with the title and body the user saw when the draft opened. A write
   * of this view's own carries the node's id over (LEV-146); an external change carries it only where the
   * title is unique, so a node that vanished under one is refused here, and an external edit to the node
   * being drafted is refused rather than overwritten. A node that only moved takes the draft.
   */
  private draftTarget(file: TFile, draft: DraftBase): { document: MindDocument; node: MindNode } {
    const document = this.document;
    if (file !== this.file || !document) throw new Error(NOTE_CHANGED_MESSAGE);
    const node = findNode(document, draft.nodeId);
    if (!node) throw new Error(NODE_GONE_MESSAGE);
    if (draftFingerprint(document, node) !== draft.value) {
      throw new Error("編集中の内容が Markdown 側で変わりました。取り消して新しい内容を確認してください。");
    }
    return { document, node };
  }

  async convertToList(): Promise<void> {
    const document = this.document;
    const file = this.file;
    if (!document || !file) return;
    if (this.inlineEditor) throw new Error("テキストの編集を確定してから、形式を変更してください。");
    const edits = planListConversion(document);
    if (!edits.length) return;
    await this.commit(document.source, edits, file);
    new Notice("H2 とリストの形式に変更しました。元に戻す操作で復元できます。");
  }

  /** Undo／Redo: the store tells every map of the note what the step wrote (`recordWrite`). */
  private history(direction: "undo" | "redo"): void {
    const file = this.file;
    if (!file) return;
    this.run(async () => {
      // A step refused because the note changed under it re-reads the note here too, as a refused edit does (`writeOwn`).
      let write: LatestWrite;
      try { write = await this.store[direction](file); } catch (error) {
        if (error instanceof Error && error.message === conflictMessage) this.scheduleRefresh();
        throw error;
      }
      const shown = this.showOwnWrite(file, write.after);
      // ⌘Z／⌘⇧Z are not saves: a draft kept by a conflict learns the note moved on, whether or not a save is under way
      // and whether this view or its re-read shows the step.
      if (write.edits.length > 0) this.tellKeptDrafts();
      await this.refresh(shown);
    });
  }

  /**
   * A write the store made on the note (`DocumentStore.onWrite`) — this view's, another map's of the note, or a step of
   * the shared history — recorded as a write of this view's own so the re-read carries the ids over (LEV-150): the
   * folds and the selection stay on a node whose title repeats or is empty. Recorded only where the view's record
   * leads to its start (`recordOwn`): a view that moved on, or whose text is not the one the write was made on,
   * re-reads it as it would any change. The view that asked for the write records it again once the store answers
   * (`writeOwn`, `writeLayout`), which skips the copy.
   */
  private recordWrite(file: TFile, write: LatestWrite): void {
    if (file !== this.file || this.closed) return;
    this.recordOwn(write);
  }

  async showSource(split: boolean): Promise<void> {
    const file = this.file;
    if (!file) return;
    // A called map's node has no place in this note; its calling item does (§5 M12).
    const selected = this.selected();
    const source = selected ? this.calledSource(selected.id) : undefined;
    const anchor = source && !source.root && this.document ? getNode(this.document, source.callerId) : selected;
    const offset = anchor?.from ?? 0;
    const leaf = split
      ? this.app.workspace.createLeafBySplit(this.leaf, "vertical", true)
      : this.leaf;
    // The router keeps this leaf on Markdown even when the note opens as a map by default.
    await this.router.openMarkdown(leaf, file);
    if (leaf.view instanceof MarkdownView) {
      const pos = leaf.view.editor.offsetToPos(offset);
      leaf.view.editor.setCursor(pos);
      leaf.view.editor.scrollIntoView({ from: pos, to: pos }, true);
      leaf.view.editor.focus();
    }
  }

  private chooseImage(): void {
    const node = this.selected();
    if (!node) return;
    if (this.isCalled(node.id)) { new Notice(CALLED_READ_ONLY_MESSAGE); return; }
    const input = this.contentEl.createEl("input", { type: "file", cls: "mappy-file-input", attr: { accept: "image/*" } });
    input.addEventListener("change", () => {
      const file = input.files?.[0]; input.remove();
      if (file) this.run(() => this.attachImage(file));
    }, { once: true });
    input.addEventListener("cancel", () => { input.remove(); }, { once: true });
    input.click();
  }

  private async attachImage(image: File): Promise<void> {
    const node = this.selected();
    const document = this.document;
    const file = this.file;
    if (!node || !document || !file) return;
    this.assertEditable(node.id);
    if (!image.type.startsWith("image/")) throw new Error("画像ファイルを選んでください。");
    if (image.size > 20 * 1024 * 1024) throw new Error("画像は 20 MB 以下にしてください。");
    // An Escape on a new node's draft meanwhile must not take the node away from under the image (LEV-203).
    await this.preparing(() => this.attachTo(image, node, document, file));
  }

  /** Run a write of this view's own that prepares something before it commits, counted in `prepared` until it ends. */
  private async preparing<T>(write: () => Promise<T>): Promise<T> {
    this.prepared += 1;
    try { return await write(); } finally { this.prepared -= 1; }
  }

  private async attachTo(image: File, node: MindNode, document: MindDocument, file: TFile): Promise<void> {
    const binary = await image.arrayBuffer();
    // The note as the map shows it, or as the view's own layout buttons have since written it (LEV-196): the store
    // carries the link over those.
    if (!await this.store.applies(file, document.source)) throw new Error("ノートが更新されました。画像の追加をもう一度実行してください。");
    const name = image.name.replace(/[\\/:*?"<>|]/gu, "-") || "image.png";
    const path = await this.app.fileManager.getAvailablePathForAttachment(name, file.path);
    const attachment = await this.app.vault.createBinary(path, binary);
    const link = `!${this.app.fileManager.generateMarkdownLink(attachment, file.path)}`;
    try {
      await this.commit(document.source, [planAppendBody(document, node.id, link)], file);
    } catch (error) {
      new Notice(`画像は ${attachment.path} に保存済みです。ノートへの挿入を再試行してください。`);
      throw error;
    }
  }
}
