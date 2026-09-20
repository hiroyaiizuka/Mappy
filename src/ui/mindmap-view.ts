import { ItemView, MarkdownView, Menu, Notice, Scope, TFile, setIcon, type TAbstractFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { parseMarkdown, projectMap, type MapProjection, type MindDocument, type MindNode } from "../core/markdown";
import { applyEdits, getNode, planEdit, resolveDrop, type EditCommand, type MoveCommand, type TextEdit } from "../core/commands";
import { nodeBody, planBodyEdit, planAppendBody } from "../core/body";
import { embedOnlyTitle } from "../core/embed";
import { planListConversion } from "../core/list-conversion";
import { planTopicMoves, readTopicPositions, type TopicPosition, type TopicPositionMap } from "../core/topics";
import type { CaptureSource } from "../export/svg-capture";
import type { Viewport } from "../interaction/viewport";
import { LAYOUT_LABELS, LAYOUT_MODES, isLayoutMode, layoutTree, type FreeTopicLayout, type LayoutMode, type LayoutNode, type LayoutResult, type PositionedNode } from "../layout/layout";
import { PLACEHOLDER_ID, previewTree } from "../layout/drop-preview";
import { balancedSideOf, snapSlot, type NodePlace, type SnapSlot } from "../layout/snap";
import { DocumentStore, conflictMessage } from "../obsidian/document-store";
import { readMapLayout, writeMapLayout } from "../obsidian/frontmatter";
import type { MapTheme } from "../obsidian/settings";
import { exportMap, type ExportFormat } from "../obsidian/image-export";
import type { ViewRouter } from "../obsidian/view-routing";
import { EditModal } from "./edit-modal";
import { nodeEmbeds } from "./map-embed";
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

/** What a draft edits: the node's title and body as one string (a title never holds a newline), compared before a kept draft is retried. */
function draftFingerprint(document: MindDocument, node: MindNode): string {
  return `${node.title}\n${nodeBody(document, node)}`;
}

/** The snap's index of a drag's base layout; see `MindmapView.snapIndex`. */
interface SnapIndex {
  byId: ReadonlyMap<string, PositionedNode>;
  children: ReadonlyMap<string, readonly PositionedNode[]>;
  places: ReadonlyMap<string, NodePlace>;
}

/** One button per layout, in LAYOUT_MODES order, named as LAYOUT_LABELS names it; the Record keeps the list and the buttons in step. */
const LAYOUT_BUTTONS: Record<LayoutMode, { label: string; icon: string }> = {
  mindmap: { label: LAYOUT_LABELS.mindmap, icon: "git-fork" },
  timeline: { label: LAYOUT_LABELS.timeline, icon: "git-commit-horizontal" },
  hierarchy: { label: LAYOUT_LABELS.hierarchy, icon: "network" },
  balanced: { label: LAYOUT_LABELS.balanced, icon: "unfold-horizontal" },
};

/**
 * An item the plugin adds to the view's 操作 menu (§5 M3): a command whose route (a modal, another
 * plugin) lives outside the view. `check` is asked when the menu opens and decides whether the item
 * is enabled; `run` is the command's own callback, so the menu and the palette do the same thing.
 */
export interface MapMenuAction {
  title: string;
  icon: string;
  check: (view: MindmapView) => boolean;
  run: (view: MindmapView) => void;
}

/** An entry of the view's menus: the title (without a key), the icon and what choosing it runs. */
type MenuEntry = readonly [title: string, icon: string, run: () => void];

export class MindmapView extends ItemView {
  file: TFile | null = null;
  private document: MindDocument | undefined;
  /** Body/topic split and stored positions of `document`, derived once per parse. */
  private projected: { document: MindDocument; projection: MapProjection; positions: TopicPositionMap } | undefined;
  private selectedId: string | null = null;
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
  /** The canvas listeners, which also answer the view's scope; set with the DOM in `onOpen`. */
  private events: MapEvents | undefined;
  private modeButtons = new Map<LayoutMode, HTMLButtonElement>();
  private layout: LayoutResult | undefined;
  private placeholder!: HTMLDivElement;
  private edgePaths = new Map<string, SVGPathElement>();
  private dropPreview: MoveCommand | null = null;
  /**
   * A free tree following the pointer: the dragged root, where each affected topic started and where
   * it shows now (origin-relative), and, for the body root, the viewport at the press. Dragging the
   * body moves it against its topics: they keep their place on screen while the viewport follows the pointer.
   */
  private topicDrag: {
    id: string; body: boolean; from: Map<string, TopicPosition>; overrides: Map<string, TopicPosition>; viewport: Viewport | null;
    /** Node ids marked as moving; cleared by id, since a joined topic keeps its element under a new tree. */
    marked: string[];
    /**
     * The latest layout of this drag without a placeholder: what the snap judges against, so the slot
     * it shows cannot shift the nodes it is judged by (a placeholder re-centres a hierarchy row and
     * pushes a timeline stage past a forest).
     */
    base: LayoutResult;
    /** The snap's reading of `base` (tree structure and each node's place), built once per base rather than per pointer move. */
    index: SnapIndex | null;
  } | null = null;
  /**
   * Where a topic added on the map was pressed, until a save stores it: the first rename writes it
   * with the title, a drag replaces it. Kept in the view only, so Escape leaves the topic in place.
   */
  private pendingTopic: { id: string; layout: LayoutMode; position: TopicPosition } | null = null;
  private refreshTimer: number | undefined;
  private layoutFrame: number | undefined;
  private epoch = 0;
  private ready = false;
  private closed = false;
  private needsFit = true;
  private saving = false;
  private revealId: string | null = null;
  private inlineEditor: InlineEditor | undefined;
  /** The last 本文・リンクを編集 modal, so a refresh under its kept draft can update its error line; closed modals no longer show one. */
  private bodyModal: EditModal | undefined;
  /** The 操作 menu while it is open (§5 M3), so the button's next press closes it instead of opening another. */
  private actionMenu: Menu | null = null;
  /** Whether any node of `document` calls a map (§5 M12), read once per parse. */
  private calls: { document: MindDocument; any: boolean } | undefined;
  private layoutWrite: Promise<void> = Promise.resolve();

  constructor(
    leaf: WorkspaceLeaf, private readonly store: DocumentStore, private readonly router: ViewRouter,
    /** Items of the 操作 menu whose routes live in the plugin (§5 M3); shown between the node items and リスト形式に変更. */
    private readonly menuActions: readonly MapMenuAction[] = [],
  ) {
    super(leaf);
    // Obsidian's keymap consults the active view's scope at the window's capture phase, before its global hotkeys, so
    // F2 pressed on the map reaches the map instead of the default `workspace:edit-file-title`, which otherwise consumes
    // it before the canvas listener and, the map not being a navigation view, starts renaming the most recently active
    // Markdown tab's file instead (E02, LEV-48). While the focus is in this view, F2 is the map's key: on the canvas it
    // edits the selected node, in the inline editor or on a floating control it does nothing, and either way `false`
    // (Obsidian's "consumed": preventDefault and stopPropagation) keeps that default from running. With the focus
    // outside the view the handler declines (`undefined`); what Obsidian then does with F2 is its own affair (1.14.2
    // runs no other handler for a key the active view registered, so the default stays off while the map is active).
    // Only F2 is registered: no other map key has a default hotkey. The workspace reads `view.scope` on each key, so
    // there is nothing to undo.
    this.scope = new Scope(this.app.scope);
    this.scope.register([], "F2", event => {
      const target = event.targetNode;
      if (!target || !this.contentEl.contains(target)) return undefined;
      this.events?.hotkey(event);
      return false;
    });
  }

  /** Current presentation, for exports that mirror what the user sees. */
  snapshot(): { file: TFile; mode: LayoutMode; collapsed: ReadonlySet<string>; document?: MindDocument } | null {
    if (!this.file) return null;
    return { file: this.file, mode: this.mode, collapsed: new Set(this.collapsed), ...(this.document ? { document: this.document } : {}) };
  }

  /**
   * What is on screen, for the SVG／PNG export (§5 M13): the layout the nodes were
   * placed with, their elements and the connector layer. A debounced refresh is run
   * first and a pending layout frame is awaited, so the geometry handed out is the
   * one the DOM shows; the entries are copied, so a later refresh cannot change the
   * set being exported. Markdown renders still in flight are not awaited (the
   * renderer reports them only by scheduling another frame).
   */
  async exportSource(): Promise<CaptureSource & { file: TFile }> {
    const file = this.file;
    if (!file || !this.document) throw new Error("マップを開いてから書き出してください。");
    if (this.inlineEditor) throw new Error("テキストの編集を確定してから書き出してください。");
    if (this.topicDrag || this.dropPreview) throw new Error("ドラッグを終えてから書き出してください。");
    if (this.refreshTimer !== undefined) {
      this.contentEl.win.clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
      await this.refresh();
    }
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

  getState(): Record<string, unknown> {
    return { file: this.file?.path, layout: this.mode, viewport: this.viewport?.value };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const value = state && typeof state === "object" ? state as Record<string, unknown> : {};
    const file = typeof value.file === "string" ? this.app.vault.getAbstractFileByPath(value.file) : null;
    const changed = this.file !== file;
    this.file = file instanceof TFile && file.extension === "md" ? file : null;
    if (isLayoutMode(value.layout)) this.mode = value.layout;
    else if (changed && this.file) this.mode = readMapLayout(this.app, this.file) ?? "mindmap";
    // The bar follows the layout at once, before the read: draw() does not run for a note that fails to load.
    this.syncModeButtons();
    if (changed) {
      this.inlineEditor?.dispose(); this.inlineEditor = undefined;
      this.document = undefined; this.selectedId = null; this.collapsed.clear(); this.needsFit = true;
      this.pendingTopic = null; this.topicDrag = null;
    }
    if (this.ready) {
      const view = value.viewport;
      if (view && typeof view === "object" && "x" in view && "y" in view && "scale" in view
        && typeof view.x === "number" && Number.isFinite(view.x)
        && typeof view.y === "number" && Number.isFinite(view.y)
        && typeof view.scale === "number" && Number.isFinite(view.scale)) {
        this.viewport.set({ x: view.x, y: view.y, scale: view.scale });
        this.needsFit = false;
      }
      await this.refresh();
    }
    await super.setState(state, result);
  }

  onOpen(): Promise<void> {
    this.closed = false;
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
    // The top-right corner holds one control (§5 M3): the 操作 menu, where the Markdown switch and the split
    // moved to, next to the node operations the keys, the context menu and the command palette offer elsewhere.
    const actions = this.contentEl.createDiv({ cls: "mappy-actions mappy-floating", attr: { "aria-label": "操作" } });
    // Obsidian hides an open menu on the mousedown outside it, which comes before this button's click; the press
    // is remembered here so that click closes the menu (a no-op once hidden) instead of opening it again.
    let closing = false;
    const actionsButton = this.button(actions, "操作", "settings", () => {
      if (closing) { closing = false; this.actionMenu?.hide(); return; }
      this.openActionMenu(actionsButton);
    });
    actionsButton.setAttribute("aria-haspopup", "menu");
    actionsButton.setAttribute("aria-expanded", "false");
    actionsButton.addEventListener("mousedown", () => { closing = this.actionMenu !== null; });
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
    // A node that is one `![[map]]` draws that map inside itself (§5 M12); the map's own nodes are not this view's.
    this.renderer = this.addChild(new NodeRenderer(this.app, nodes, () => { this.scheduleLayout(); }, nodeEmbeds(this.app, this.store)));
    this.viewport = this.addChild(new MapViewport(this.canvas, world, view => {
      this.zoomLabel.setText(`${view.scale < 0.1 ? (view.scale * 100).toFixed(1) : Math.round(view.scale * 100)}%`);
      this.app.workspace.requestSaveLayout();
    }));
    this.events = this.addChild(new MapEvents(this.canvas, {
      selected: () => this.selected(), visible: () => this.visible(), select: (id, focus) => { this.select(id, focus); },
      fold: id => { this.fold(id); }, edit: () => { this.editTitle(); },
      command: command => { this.run(() => this.execute(command)); },
      history: direction => { this.history(direction); }, attach: file => { this.run(() => this.attachImage(file)); },
      link: (link, newLeaf) => { if (this.file) this.run(() => this.app.workspace.openLinkText(link, this.file?.path ?? "", newLeaf)); },
      addTopic: point => { this.run(() => this.addTopic(point)); },
    }));
    this.addChild(new NodeDrag(this.canvas, {
      select: id => { this.select(id); },
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
    this.registerEvent(this.app.vault.on("rename", file => {
      if (file === this.file) { this.scheduleRefresh(); this.app.workspace.requestSaveLayout(); }
    }));
    this.registerEvent(this.app.vault.on("delete", file => {
      if (file !== this.file) return;
      // A kept draft outlives refreshes, but not its note.
      this.inlineEditor?.dispose(); this.inlineEditor = undefined;
      this.file = null; this.document = undefined; this.scheduleRefresh();
    }));
    // A node that calls a map (§5 M12) is judged when it is drawn: when another note's cache, name or existence
    // changes, the calls are judged again on the next draw (a note that became a map gets its frame, a lost one its link).
    const recall = (file: TAbstractFile): void => { if (file !== this.file && this.callsMaps()) this.draw(); };
    this.registerEvent(this.app.metadataCache.on("changed", recall));
    this.registerEvent(this.app.metadataCache.on("deleted", recall));
    this.registerEvent(this.app.vault.on("rename", recall));
    // The settings may have reached the view before it had buttons (src/main.ts sets them at construction).
    this.syncModeButtons();
    this.ready = true;
    return this.refresh();
  }

  onClose(): Promise<void> {
    this.closed = true;
    this.inlineEditor?.dispose(); this.inlineEditor = undefined;
    this.actionMenu?.hide();
    this.epoch += 1;
    if (this.refreshTimer !== undefined) this.contentEl.win.clearTimeout(this.refreshTimer);
    if (this.layoutFrame !== undefined) this.contentEl.win.cancelAnimationFrame(this.layoutFrame);
    return Promise.resolve();
  }

  onResize(): void { if (this.ready) this.scheduleLayout(); }

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

  /** A menu entry both menus offer: the title without its key, the icon and the method it runs. */
  private menuItem(menu: Menu, [title, icon, run]: MenuEntry, key?: string, enabled = true): void {
    menu.addItem(item => item.setTitle(key ? `${title}（${key}）` : title).setIcon(icon).setDisabled(!enabled).onClick(run));
  }

  /**
   * The node operations the context menu and the 操作 menu share, each running the method its key
   * runs; the node is read when the item is chosen, as the keys do, not when the menu opened.
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
   * The 操作 menu (§5 M3), opened under the top-right button: the Markdown switch and the split, then
   * the node operations with the key each answers to, the free-topic addition, the plugin's routes and
   * the list conversion, then the history. Every item runs the same method as its key, its context-menu
   * entry or its command, so the diff and the history are the same. Items that act on a node are
   * disabled while nothing is selected (a map without a note); on the virtual root of a note without a
   * heading, which the keys refuse with a notice, the sibling, the title and the deletion are disabled
   * too. The plugin's items are enabled on their own `check`.
   */
  private openActionMenu(anchor: HTMLElement): void {
    const menu = new Menu();
    const node = this.selected();
    const ready = this.file !== null && this.document !== undefined;
    const onNode = node !== undefined;
    const onItem = onNode && node.kind !== "root";
    const entries = this.nodeEntries();
    const add = (title: string, icon: string, enabled: boolean, run: () => void): void => { this.menuItem(menu, [title, icon, run], undefined, enabled); };
    add("Markdown に切り替え", "file-text", ready, () => { this.run(() => this.showSource(false)); });
    add("左に Markdown を開く", "panel-left", ready, () => { this.run(() => this.showSource(true)); });
    menu.addSeparator();
    this.menuItem(menu, entries.sibling, "Enter", onItem);
    this.menuItem(menu, entries.child, "Tab", onNode);
    // Without a pressed point the new topic takes the default place of a topic with no stored position (§5 M7).
    add("トピックを追加", "square-plus", ready, () => { this.run(() => this.addTopic()); });
    menu.addSeparator();
    this.menuItem(menu, entries.edit, "F2", onItem);
    this.menuItem(menu, entries.body, undefined, onNode);
    this.menuItem(menu, entries.image, undefined, onNode);
    add("折りたたみ（Space）", "chevrons-down-up", onNode, () => { const current = this.selected(); if (current) this.fold(current.id); });
    add("削除（Delete）", "trash-2", onItem, () => { this.executeSelected("delete"); });
    menu.addSeparator();
    for (const action of this.menuActions) add(action.title, action.icon, action.check(this), () => { action.run(this); });
    add("リスト形式に変更", "list-tree", this.document?.format === "headings", () => { this.run(() => this.convertToList()); });
    menu.addSeparator();
    this.historyItems(menu);
    this.actionMenu = menu;
    anchor.setAttribute("aria-expanded", "true");
    menu.onHide(() => {
      if (this.actionMenu === menu) this.actionMenu = null;
      anchor.setAttribute("aria-expanded", "false");
    });
    // Below the button: Obsidian's own menu right-aligns with it (`left` with the button's width), a native
    // menu (macOS by default) takes only `x`/`y` and opens from the button's left-bottom corner, the OS
    // keeping it on screen. The view's own document, so a popout window gets the menu.
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom, width: rect.width, overlap: true, left: true }, this.contentEl.doc);
  }

  private historyItems(menu: Menu): void {
    menu.addItem(item => item.setTitle("元に戻す").setIcon("undo-2")
      .setDisabled(!this.file || !this.store.canUndo(this.file)).onClick(() => { this.history("undo"); }));
    menu.addItem(item => item.setTitle("やり直す").setIcon("redo-2")
      .setDisabled(!this.file || !this.store.canRedo(this.file)).onClick(() => { this.history("redo"); }));
  }

  /** A deliberate layout switch is the note's next-open preference. */
  private selectMode(mode: LayoutMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.needsFit = true;
    this.syncModeButtons();
    this.draw();
    this.app.workspace.requestSaveLayout();
    const file = this.file;
    if (!file) return;
    const write = this.layoutWrite.catch(() => undefined).then(() => writeMapLayout(this.app, file, mode));
    this.layoutWrite = write;
    this.run(() => write);
  }

  private scheduleRefresh(): void {
    // Invalidate pending reads immediately, before the debounced refresh begins.
    this.epoch += 1;
    if (this.refreshTimer !== undefined) this.contentEl.win.clearTimeout(this.refreshTimer);
    this.refreshTimer = this.contentEl.win.setTimeout(() => { this.refreshTimer = undefined; this.run(() => this.refresh()); }, 45);
  }

  private async refresh(): Promise<void> {
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
    if (source !== this.document?.source || this.document.root.title !== file.basename) {
      this.document = parseMarkdown(source, file.basename, this.document);
      const ids = new Set([this.document.root.id, ...this.document.nodes.map(node => node.id)]);
      this.collapsed = new Set(Array.from(this.collapsed).filter(id => ids.has(id)));
      if (this.pendingTopic && !ids.has(this.pendingTopic.id)) this.pendingTopic = null;
      if (this.topicDrag && !ids.has(this.topicDrag.id)) this.endTopicDrag(this.topicDrag.id, false);
      // Someone else's change under a draft kept by a conflict; the re-read after this view's own write is not that.
      if (!this.saving) { this.inlineEditor?.refreshed(conflictMessage); this.bodyModal?.refreshed(conflictMessage); }
    }
    this.emptyState.hidden = true;
    this.draw();
  }

  /** True when a node's title is one embed: only then can another note's change alter what this map shows. */
  private callsMaps(): boolean {
    const document = this.document;
    if (!document) return false;
    if (this.calls?.document !== document) this.calls = { document, any: document.nodes.some(node => embedOnlyTitle(node.title) !== null) };
    return this.calls.any;
  }

  /** The body root plus the free topics beside it (§5 M7); documents without headings keep the virtual root. */
  private projection(): MapProjection | undefined {
    const document = this.document;
    if (!document) return undefined;
    if (this.projected?.document !== document) {
      this.projected = { document, projection: projectMap(document), positions: readTopicPositions(document.source) };
    }
    return this.projected.projection;
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
   * stored yet. Topics sharing a heading share one entry; only the first uses it.
   */
  private topicLayouts(trees?: readonly LayoutNode[]): FreeTopicLayout[] {
    const projected = this.projected;
    if (!projected) return [];
    const used = new Set<string>();
    return projected.projection.topics.map((topic, index) => {
      const stored = used.has(topic.title) ? undefined : projected.positions.get(topic.title)?.[this.mode];
      used.add(topic.title);
      const pending = this.pendingTopic?.id === topic.id && this.pendingTopic.layout === this.mode ? this.pendingTopic.position : undefined;
      const position = this.topicDrag?.overrides.get(topic.id) ?? stored ?? pending;
      return { tree: trees?.[index + 1] ?? topic, position: position ? { x: position.x, y: position.y } : null };
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
    });
    if (!nodes.some(node => node.id === this.selectedId)) this.selectedId = nodes[0]?.id ?? null;
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

  private scheduleLayout(): void {
    if (!this.ready || this.closed || this.layoutFrame !== undefined) return;
    this.layoutFrame = this.contentEl.win.requestAnimationFrame(() => {
      this.layoutFrame = undefined;
      const projection = this.projection();
      if (!projection || this.closed) return;
      const sizes = this.renderer.sizes();
      const preview = this.previewLayout(projection, sizes);
      this.layout = layoutTree(preview?.trees[0] ?? projection.root, sizes, preview?.collapsed ?? this.collapsed, this.mode,
        this.topicLayouts(preview?.trees));
      if (this.topicDrag && !preview) { this.topicDrag.base = this.layout; this.topicDrag.index = null; }
      this.renderer.place(this.layout.nodes, this.layout.folds);
      const slot = this.layout.nodes.find(node => node.id === PLACEHOLDER_ID);
      this.placeholder.hidden = !slot;
      if (slot) {
        this.placeholder.style.width = `${slot.width}px`;
        this.placeholder.style.height = `${slot.height}px`;
        this.placeholder.style.transform = `translate(${slot.x}px, ${slot.y}px)`;
      }
      this.drawEdges(this.layout.edges);
      if (this.needsFit && this.canvas.clientWidth > 0 && this.canvas.clientHeight > 0) {
        this.viewport.fit(this.layout.bounds); this.needsFit = false;
      }
      if (this.revealId) { this.ensureVisible(this.revealId); this.revealId = null; }
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
    projection: MapProjection, sizes: Map<string, { width: number; height: number }>,
  ): { trees: LayoutNode[]; collapsed: ReadonlySet<string> } | null {
    const command = this.dropPreview;
    const size = command ? sizes.get(command.nodeId) : undefined;
    const document = this.document;
    if (!command || !size || !document) return null;
    const roots: MindNode[] = [projection.root, ...projection.topics];
    // Topics first: a virtual-root body also parents them, so it would claim their destinations.
    let previewed = -1;
    let tree: LayoutNode | null = null;
    for (let index = roots.length - 1; index >= 0 && !tree; index -= 1) {
      const root = roots[index];
      tree = root ? previewTree(document, root, command, this.collapsed) : null;
      previewed = index;
    }
    if (!tree) return null;
    const trees = roots.map((root, index): LayoutNode => index === previewed && tree ? tree : root);
    sizes.set(PLACEHOLDER_ID, size);
    // A collapsed destination reveals only the placeholder, so it must not be measured as collapsed.
    const collapsed = this.collapsed.has(command.parentId)
      ? new Set(Array.from(this.collapsed).filter(id => id !== command.parentId)) : this.collapsed;
    return { trees, collapsed };
  }

  private selected(): MindNode | undefined {
    if (!this.document) return undefined;
    return this.selectedId === "root" ? this.document.root : this.document.nodes.find(node => node.id === this.selectedId);
  }

  private select(id: string, focus = false): void {
    this.selectedId = id; this.renderer.select(id);
    if (focus) {
      this.renderer.focus(id);
      if (this.layout?.nodes.some(node => node.id === id)) this.ensureVisible(id);
      else { this.revealId = id; this.scheduleLayout(); }
    }
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
    const document = this.document;
    const file = this.file;
    if (!document || this.saving) return;
    // A kept draft (E05) still addresses its node; a structural edit under it would move what the draft comes back to.
    if (this.inlineEditor) throw new Error("テキストの編集を確定してから、もう一度実行してください。");
    const plan = planEdit(document, command);
    await this.commit(document.source, plan.edits, file);
    if (this.file !== file || this.closed) return;
    const selected = this.reveal(plan.selectionOffset);
    // A new empty node is named in place; one added with its text (a called map) is only selected.
    if (selected && ((command.type === "add-child" && command.title === undefined) || command.type === "add-sibling")) this.editTitle();
  }

  /**
   * Call another map (§5 M12): `![[map]]` becomes the last child of the selected node, or
   * of the body root when nothing is selected (a topic's root counts as selected). One
   * `add-child` edit with the link as its text, so the diff, the history (Undo removes the
   * item) and the selection are those of Tab. The called map's note is not touched. The
   * link is always the wiki form the map and the embed display read (`![[…]]`), its path
   * following the vault's link-path setting (`fileToLinktext`: shortest, relative or absolute).
   */
  async callMap(target: TFile): Promise<void> {
    const file = this.file;
    if (!file || !this.document) return;
    if (target.path === file.path) throw new Error("このマップ自身は呼び出せません。");
    // Tab stays quiet while a save is in flight; a chosen map must not vanish without a word.
    if (this.saving) throw new Error("保存処理が終わってから、もう一度実行してください。");
    const parent = this.selected() ?? this.projection()?.root;
    if (!parent) return;
    // Under the virtual root (a note without a heading section) add-child makes an H2 whose title would be the embed: not an item.
    if (parent.kind === "root") throw new Error("本体のルートがないノートです。先に H2 の見出しを作ってから呼び出してください。");
    const link = `![[${this.app.metadataCache.fileToLinktext(target, file.path, true)}]]`;
    await this.execute({ type: "add-child", nodeId: parent.id, title: link });
  }

  /** Select the node a plan points at, unfolding its parent, after the document was re-read. */
  private reveal(offset: number | null): MindNode | undefined {
    const selected = offset === null ? undefined : this.document?.nodes.find(node => node.titleFrom === offset);
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
    return layoutTree(projectMap(document).root, this.renderer.sizes(), this.collapsed, this.mode).origin;
  }

  /**
   * A new empty top-level section at the end of the note, edited in place where the canvas was
   * pressed (§5 M7). The position is stored by the edit that names it, so the title and the
   * `mappy-topics` entry are one step of the history; Escape keeps the section, Undo removes it.
   * Without a point (the 操作 menu) no position is kept or stored: the topic takes the default
   * place of a topic with no `mappy-topics` entry until it is dragged.
   */
  private async addTopic(point?: { x: number; y: number }): Promise<void> {
    const document = this.document;
    const file = this.file;
    if (!document || !file || this.saving) return;
    const position = point ? this.topicPoint(point) : null;
    const plan = planEdit(document, { type: "add-topic" });
    await this.commit(document.source, plan.edits, file);
    if (this.file !== file || this.closed) return;
    const created = this.document?.nodes.find(node => node.titleFrom === plan.selectionOffset);
    // The first heading of a note becomes its body root and has no position.
    if (created && position && this.isTopic(created.id)) this.pendingTopic = { id: created.id, layout: this.mode, position };
    if (this.reveal(plan.selectionOffset)) this.editTitle();
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
    const from = new Map<string, TopicPosition>();
    for (const topic of body ? projection.topics : projection.topics.filter(topic => topic.id === id)) {
      const node = layout.nodes.find(item => item.id === topic.id);
      if (node) from.set(topic.id, { x: node.x - layout.origin.x, y: node.y - layout.origin.y });
    }
    this.topicDrag = {
      id, body, from, overrides: new Map(from), viewport: body ? { ...this.viewport.value } : null, marked: this.markMoving(id), base: layout, index: null,
    };
    return this.topicDrag;
  }

  private endTopicDrag(id: string, restore: boolean): void {
    const drag = this.topicDrag;
    if (!drag || drag.id !== id) return;
    this.topicDrag = null;
    for (const marked of drag.marked) this.renderer.entries.get(marked)?.element.removeClass("is-drag-moving");
    this.renderer.entries.get(id)?.element.removeClass("is-merging");
    if (restore && drag.viewport) this.viewport.set(drag.viewport);
    this.scheduleLayout();
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
    const scale = drag.viewport?.scale ?? this.viewport.value.scale;
    const sign = drag.body ? -1 : 1;
    for (const [topicId, start] of drag.from) drag.overrides.set(topicId, { x: start.x + sign * delta.x / scale, y: start.y + sign * delta.y / scale });
    if (drag.viewport) this.viewport.set({ ...drag.viewport, x: drag.viewport.x + delta.x, y: drag.viewport.y + delta.y });
    this.scheduleLayout();
  }

  /** A free tree released on the canvas: only `mappy-topics` entries for this layout change (all of them for the body). */
  private async placeTopic(id: string, delta: DragDelta): Promise<void> {
    const document = this.document;
    const file = this.file;
    const projection = this.projection();
    const drag = this.topicDrag?.id === id ? this.topicDrag : this.startTopicDrag(id);
    try {
      if (!document || !file || !projection || !drag) return;
      const scale = drag.viewport?.scale ?? this.viewport.value.scale;
      const sign = drag.body ? -1 : 1;
      const moves = new Map<string, TopicPosition>();
      for (const topic of projection.topics) {
        const start = drag.from.get(topic.id);
        // Topics sharing a heading share one entry; the first one owns it.
        if (!start || moves.has(topic.title)) continue;
        moves.set(topic.title, { x: Math.round(start.x + sign * delta.x / scale), y: Math.round(start.y + sign * delta.y / scale) });
      }
      const edit = planTopicMoves(document, this.mode, moves);
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
    const detached = parseMarkdown(applyEdits(document.source, planEdit(document, { type: "detach", nodeId: id }).edits), file.basename, document);
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
   * tree left out) and, where the zones depend on it, each node's place. On the timeline a stage's
   * forest hangs above the axis for even stages and below for odd ones (`placeTimeline`); in the
   * balanced map a tree's first level sits right or left of its root (`balancedSideOf`) and every
   * deeper node keeps that side.
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
    if (this.mode === "timeline" || this.mode === "balanced") {
      for (const node of layout.nodes) {
        if (parents.has(node.id)) continue;
        places.set(node.id, "root");
        const kids = children.get(node.id) ?? [];
        if (this.mode === "timeline") { kids.forEach((stage, index) => { places.set(stage.id, index % 2 === 0 ? "upper" : "lower"); }); continue; }
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

  private async commit(source: string, edits: TextEdit[], file = this.file): Promise<void> {
    if (!file || file !== this.file || this.closed) throw new Error(NOTE_CHANGED_MESSAGE);
    if (this.saving) throw new Error("保存処理が終わってから、もう一度実行してください。");
    this.saving = true;
    try {
      try { await this.store.apply(file, source, edits); }
      // A refused write means the note moved on; re-read it here too, so a kept draft can retry even where no watcher reports the change.
      catch (error) { this.scheduleRefresh(); throw error; }
      await this.refresh();
    } finally { this.saving = false; }
  }

  private editTitle(): void {
    const node = this.selected();
    const document = this.document;
    const file = this.file;
    if (!node || !document || !file) return;
    if (node.kind === "root") { new Notice("このノードはファイル名です。子ノードを追加できます。"); return; }
    const entry = this.renderer.entries.get(node.id);
    if (!entry) return;
    this.inlineEditor?.dispose();
    entry.content.hidden = true;
    let renamedOffset: number | null = null;
    const opened = draftFingerprint(document, node);
    this.inlineEditor = new InlineEditor(entry.element, {
      initial: node.title,
      suggest: input => new LinkSuggest(this.app, input, file.path),
      save: async text => {
        // A topic added on the map is placed where it was pressed by the same edit set that names it.
        const pending = this.pendingTopic?.id === node.id ? this.pendingTopic : null;
        // The draft outlives an external change that refreshed the map (E05): plan against the note as it is now.
        const current = this.draftTarget(file, node.id, opened);
        const plan = planEdit(current, {
          type: "rename", nodeId: node.id, title: text,
          ...(pending ? { position: { layout: pending.layout, x: pending.position.x, y: pending.position.y } } : {}),
        });
        await this.commit(current.source, plan.edits, file);
        renamedOffset = plan.selectionOffset;
        if (pending && this.pendingTopic === pending) this.pendingTopic = null;
      },
      finish: (next, cancelled) => {
        this.inlineEditor = undefined;
        entry.content.hidden = false;
        if (this.closed || file !== this.file) return;
        this.draw();
        // A frontmatter edit in the same set shifts every offset, so the renamed node is found by the plan's selection.
        const current = this.document?.nodes.find(item => item.id === node.id)
          ?? (!cancelled && renamedOffset !== null ? this.document?.nodes.find(item => item.titleFrom === renamedOffset) : undefined)
          ?? (!cancelled ? this.document?.nodes.find(item => item.from === node.from) : undefined);
        if (current) this.select(current.id, true);
        if (!cancelled && next === "child" && current) this.run(() => this.execute({ type: "add-child", nodeId: current.id }));
      },
      resize: () => { this.scheduleLayout(); },
      restore: () => { entry.content.hidden = false; },
    });
  }

  private editBody(): void {
    const node = this.selected();
    const document = this.document;
    const file = this.file;
    if (!node || !document || !file) return;
    const opened = draftFingerprint(document, node);
    const modal = new EditModal(this.app, nodeBody(document, node), "本文・リンクを編集", true, async text => {
      const current = this.draftTarget(file, node.id, opened);
      await this.commit(current.source, [planBodyEdit(current, node.id, text)], file);
    });
    this.bodyModal = modal;
    modal.open();
  }

  /**
   * The note a kept draft applies to once the map has refreshed under it (E05): the view's current parse,
   * provided the node is still there with the title and body the user saw when the draft opened. Ids survive
   * a re-parse only for unique titles, so a same-named or vanished node is refused here, and an external edit
   * to the node being drafted is refused rather than overwritten; a node that only moved takes the draft.
   */
  private draftTarget(file: TFile, nodeId: string, opened: string): MindDocument {
    const document = this.document;
    if (file !== this.file || !document) throw new Error(NOTE_CHANGED_MESSAGE);
    if (draftFingerprint(document, getNode(document, nodeId)) !== opened) {
      throw new Error("編集中の内容が Markdown 側で変わりました。取り消して新しい内容を確認してください。");
    }
    return document;
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

  private history(direction: "undo" | "redo"): void {
    const file = this.file;
    if (!file) return;
    this.run(async () => { await this.store[direction](file); await this.refresh(); });
  }

  async showSource(split: boolean): Promise<void> {
    const file = this.file;
    if (!file) return;
    const offset = this.selected()?.from ?? 0;
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
    if (!this.selected()) return;
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
    if (!image.type.startsWith("image/")) throw new Error("画像ファイルを選んでください。");
    if (image.size > 20 * 1024 * 1024) throw new Error("画像は 20 MB 以下にしてください。");
    const binary = await image.arrayBuffer();
    if (await this.store.read(file) !== document.source) throw new Error("ノートが更新されました。画像の追加をもう一度実行してください。");
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
