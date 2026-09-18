import { ItemView, MarkdownView, Menu, Notice, TFile, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { parseMarkdown, projectMap, type MapProjection, type MindDocument, type MindNode } from "../core/markdown";
import { planEdit, resolveDrop, type EditCommand, type MoveCommand, type TextEdit } from "../core/commands";
import { nodeBody, planBodyEdit, planAppendBody } from "../core/body";
import { planListConversion } from "../core/list-conversion";
import { planTopicMoves, readTopicPositions, type TopicPosition, type TopicPositionMap } from "../core/topics";
import type { Viewport } from "../interaction/viewport";
import { isLayoutMode, layoutTree, type FreeTopicLayout, type LayoutMode, type LayoutNode, type LayoutResult } from "../layout/layout";
import { PLACEHOLDER_ID, previewTree } from "../layout/drop-preview";
import { DocumentStore } from "../obsidian/document-store";
import { readMapLayout, writeMapLayout } from "../obsidian/frontmatter";
import type { ViewRouter } from "../obsidian/view-routing";
import { EditModal } from "./edit-modal";
import { NodeRenderer } from "./node-renderer";
import { MapViewport } from "./map-viewport";
import { MapEvents } from "./map-events";
import { NodeDrag, type DragDelta } from "./node-drag";
import { InlineEditor } from "./inline-editor";
import { LinkSuggest } from "./link-suggest";

export const VIEW_TYPE = "mappy-map";

export class MindmapView extends ItemView {
  file: TFile | null = null;
  private document: MindDocument | undefined;
  /** Body/topic split and stored positions of `document`, derived once per parse. */
  private projected: { document: MindDocument; projection: MapProjection; positions: TopicPositionMap } | undefined;
  private selectedId: string | null = null;
  private collapsed = new Set<string>();
  private mode: LayoutMode = "mindmap";
  private canvas!: HTMLDivElement;
  private svg!: SVGSVGElement;
  private emptyState!: HTMLDivElement;
  private zoomLabel!: HTMLButtonElement;
  private renderer!: NodeRenderer;
  private viewport!: MapViewport;
  private modeButtons = new Map<string, HTMLButtonElement>();
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
  private layoutWrite: Promise<void> = Promise.resolve();

  constructor(leaf: WorkspaceLeaf, private readonly store: DocumentStore, private readonly router: ViewRouter) { super(leaf); }

  /** Current presentation, for exports that mirror what the user sees. */
  snapshot(): { file: TFile; mode: LayoutMode; collapsed: ReadonlySet<string>; document?: MindDocument } | null {
    if (!this.file) return null;
    return { file: this.file, mode: this.mode, collapsed: new Set(this.collapsed), ...(this.document ? { document: this.document } : {}) };
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return this.file ? `${this.file.basename} · マップ` : "マインドマップ"; }
  getIcon(): string { return "git-fork"; }

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
    const modes = this.contentEl.createDiv({ cls: "mappy-modes mappy-floating", attr: { "aria-label": "レイアウト" } });
    for (const [mode, label, icon] of [
      ["mindmap", "マップ", "git-fork"], ["timeline", "タイムライン", "git-commit-horizontal"], ["hierarchy", "階層図", "network"],
    ] as const) {
      const button = this.button(modes, label, icon, () => {
        this.selectMode(mode);
      });
      this.modeButtons.set(mode, button);
    }
    const sourceTools = this.contentEl.createDiv({ cls: "mappy-source-tools mappy-floating" });
    this.button(sourceTools, "Markdown に切り替え", "file-text", () => { this.run(() => this.showSource(false)); });
    this.button(sourceTools, "左に Markdown を開く", "panel-left", () => { this.run(() => this.showSource(true)); });
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
    this.viewport = this.addChild(new MapViewport(this.canvas, world, view => {
      this.zoomLabel.setText(`${view.scale < 0.1 ? (view.scale * 100).toFixed(1) : Math.round(view.scale * 100)}%`);
      this.app.workspace.requestSaveLayout();
    }));
    this.addChild(new MapEvents(this.canvas, {
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
      dropTarget: (dragged, target, position) => this.document ? resolveDrop(this.document, dragged, target, position) : null,
      preview: command => { this.previewDrop(command); },
      command: command => { this.run(() => this.executeDrop(command)); },
      shift: (id, delta) => { this.shiftTopic(id, delta); },
      place: (id, delta) => { this.run(() => this.placeTopic(id, delta)); },
    }));
    this.registerDomEvent(this.canvas, "contextmenu", event => {
      const target = event.targetNode;
      if (!target?.instanceOf(Element)) return;
      if (target.closest("input,textarea,[contenteditable='true'],button,.mappy-floating")) return;
      const id = target.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
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
      menu.addItem(item => item.setTitle("テキストを編集").setIcon("pencil").onClick(() => { this.editTitle(); }));
      menu.addItem(item => item.setTitle("本文・リンクを編集").setIcon("text").onClick(() => { this.editBody(); }));
      menu.addItem(item => item.setTitle("画像を追加").setIcon("image-plus").onClick(() => { this.chooseImage(); }));
      menu.addSeparator();
      menu.addItem(item => item.setTitle("子を追加").setIcon("plus").onClick(() => { this.executeSelected("add-child"); }));
      menu.addItem(item => item.setTitle("兄弟を追加").setIcon("corner-down-right").onClick(() => { this.executeSelected("add-sibling"); }));
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
      if (file === this.file) { this.file = null; this.document = undefined; this.scheduleRefresh(); }
    }));
    this.ready = true;
    return this.refresh();
  }

  onClose(): Promise<void> {
    this.closed = true;
    this.inlineEditor?.dispose(); this.inlineEditor = undefined;
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
    }
    this.emptyState.hidden = true;
    this.draw();
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
    for (const [mode, button] of this.modeButtons) {
      button.toggleClass("is-active", mode === this.mode);
      button.setAttribute("aria-pressed", String(mode === this.mode));
    }
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
    const plan = planEdit(document, command);
    await this.commit(document.source, plan.edits, file);
    if (this.file !== file || this.closed) return;
    const selected = this.reveal(plan.selectionOffset);
    if (selected && (command.type === "add-child" || command.type === "add-sibling")) this.editTitle();
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
  private topicPoint(point: { x: number; y: number }): TopicPosition {
    const view = this.viewport.value;
    const origin = this.layout?.origin ?? { x: 0, y: 0 };
    return { x: Math.round((point.x - view.x) / view.scale - origin.x), y: Math.round((point.y - view.y) / view.scale - origin.y) };
  }

  /**
   * A new empty top-level section at the end of the note, edited in place where the canvas was
   * pressed (§5 M7). The position is stored by the edit that names it, so the title and the
   * `mappy-topics` entry are one step of the history; Escape keeps the section, Undo removes it.
   */
  private async addTopic(point: { x: number; y: number }): Promise<void> {
    const document = this.document;
    const file = this.file;
    if (!document || !file || this.saving) return;
    const position = this.topicPoint(point);
    const plan = planEdit(document, { type: "add-topic" });
    await this.commit(document.source, plan.edits, file);
    if (this.file !== file || this.closed) return;
    const created = this.document?.nodes.find(node => node.titleFrom === plan.selectionOffset);
    // The first heading of a note becomes its body root and has no position.
    if (created && this.isTopic(created.id)) this.pendingTopic = { id: created.id, layout: this.mode, position };
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
    this.topicDrag = { id, body, from, overrides: new Map(from), viewport: body ? { ...this.viewport.value } : null, marked: this.markMoving(id) };
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

  /** A drop on a slot: a topic joins the node as a branch; a failed move puts the tree back. */
  private async executeDrop(command: MoveCommand): Promise<void> {
    try { await this.execute(command); }
    finally { this.endTopicDrag(command.nodeId, true); }
  }

  private async commit(source: string, edits: TextEdit[], file = this.file): Promise<void> {
    if (!file || file !== this.file || this.closed) throw new Error("対象のノートが変わりました。元のノートを開いて再実行してください。");
    if (this.saving) throw new Error("保存処理が終わってから、もう一度実行してください。");
    this.saving = true;
    try { await this.store.apply(file, source, edits); await this.refresh(); }
    finally { this.saving = false; }
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
    this.inlineEditor = new InlineEditor(entry.element, {
      initial: node.title,
      suggest: input => new LinkSuggest(this.app, input, file.path),
      save: async text => {
        // A topic added on the map is placed where it was pressed by the same edit set that names it.
        const pending = this.pendingTopic?.id === node.id ? this.pendingTopic : null;
        const plan = planEdit(document, {
          type: "rename", nodeId: node.id, title: text,
          ...(pending ? { position: { layout: pending.layout, x: pending.position.x, y: pending.position.y } } : {}),
        });
        await this.commit(document.source, plan.edits, file);
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
          ?? (!cancelled ? this.document?.nodes.find(item => item.titleFrom === renamedOffset || item.from === node.from) : undefined);
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
    if (!node || !document) return;
    new EditModal(this.app, nodeBody(document, node), "本文・リンクを編集", true, async text => {
      await this.commit(document.source, [planBodyEdit(document, node.id, text)], file);
    }).open();
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
