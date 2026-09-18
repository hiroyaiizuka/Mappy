import { ItemView, MarkdownView, Menu, Notice, TFile, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { parseMarkdown, type MindDocument, type MindNode } from "../core/markdown";
import { planEdit, resolveDrop, type EditCommand, type TextEdit } from "../core/commands";
import { nodeBody, planBodyEdit, planAppendBody } from "../core/body";
import { planListConversion } from "../core/list-conversion";
import { layoutTree, type LayoutResult } from "../layout/layout";
import { DocumentStore } from "../obsidian/document-store";
import { readMapLayout, writeMapLayout, type MapLayout } from "../obsidian/frontmatter";
import type { ViewRouter } from "../obsidian/view-routing";
import { EditModal } from "./edit-modal";
import { NodeRenderer } from "./node-renderer";
import { MapViewport } from "./map-viewport";
import { MapEvents } from "./map-events";
import { InlineEditor } from "./inline-editor";
import { LinkSuggest } from "./link-suggest";

export const VIEW_TYPE = "mappy-map";

export class MindmapView extends ItemView {
  file: TFile | null = null;
  private document: MindDocument | undefined;
  private selectedId: string | null = null;
  private collapsed = new Set<string>();
  private mode: MapLayout = "mindmap";
  private canvas!: HTMLDivElement;
  private svg!: SVGSVGElement;
  private emptyState!: HTMLDivElement;
  private zoomLabel!: HTMLButtonElement;
  private renderer!: NodeRenderer;
  private viewport!: MapViewport;
  private modeButtons = new Map<string, HTMLButtonElement>();
  private layout: LayoutResult | undefined;
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
  snapshot(): { file: TFile; mode: "mindmap" | "timeline"; collapsed: ReadonlySet<string>; document?: MindDocument } | null {
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
    if (value.layout === "timeline" || value.layout === "mindmap") this.mode = value.layout;
    else if (changed && this.file) this.mode = readMapLayout(this.app, this.file) ?? "mindmap";
    if (changed) {
      this.inlineEditor?.dispose(); this.inlineEditor = undefined;
      this.document = undefined; this.selectedId = null; this.collapsed.clear(); this.needsFit = true;
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
    for (const [mode, label, icon] of [["mindmap", "マップ", "git-fork"], ["timeline", "タイムライン", "git-commit-horizontal"]] as const) {
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
      dropTarget: (dragged, target, position) => this.document ? resolveDrop(this.document, dragged, target, position) : null,
    }));
    this.registerDomEvent(this.canvas, "contextmenu", event => {
      const target = event.targetNode;
      if (!target?.instanceOf(Element)) return;
      if (target.closest("input,textarea,[contenteditable='true']")) return;
      const id = target.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
      if (!id) return;
      event.preventDefault();
      this.select(id);
      const menu = new Menu();
      menu.addItem(item => item.setTitle("テキストを編集").setIcon("pencil").onClick(() => { this.editTitle(); }));
      menu.addItem(item => item.setTitle("本文・リンクを編集").setIcon("text").onClick(() => { this.editBody(); }));
      menu.addItem(item => item.setTitle("画像を追加").setIcon("image-plus").onClick(() => { this.chooseImage(); }));
      menu.addSeparator();
      menu.addItem(item => item.setTitle("子を追加").setIcon("plus").onClick(() => { this.executeSelected("add-child"); }));
      menu.addItem(item => item.setTitle("兄弟を追加").setIcon("corner-down-right").onClick(() => { this.executeSelected("add-sibling"); }));
      for (const [type, title] of [["move-up", "前へ移動"], ["move-down", "後ろへ移動"], ["delete", "枝を削除"]] as const) {
        menu.addItem(item => item.setTitle(title).onClick(() => { this.executeSelected(type); }));
      }
      menu.addSeparator();
      menu.addItem(item => item.setTitle("元に戻す").setIcon("undo-2")
        .setDisabled(!this.file || !this.store.canUndo(this.file)).onClick(() => { this.history("undo"); }));
      menu.addItem(item => item.setTitle("やり直す").setIcon("redo-2")
        .setDisabled(!this.file || !this.store.canRedo(this.file)).onClick(() => { this.history("redo"); }));
      if (this.document?.format === "headings") {
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

  /** A deliberate layout switch is the note's next-open preference. */
  private selectMode(mode: MapLayout): void {
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
      this.svg.empty();
      return;
    }
    const source = await this.store.read(file);
    if (this.closed || epoch !== this.epoch || file !== this.file) return;
    if (source !== this.document?.source || this.document.root.title !== file.basename) {
      this.document = parseMarkdown(source, file.basename, this.document);
      const ids = new Set([this.document.root.id, ...this.document.nodes.map(node => node.id)]);
      this.collapsed = new Set(Array.from(this.collapsed).filter(id => ids.has(id)));
    }
    this.emptyState.hidden = true;
    this.draw();
  }

  private visualRoot(): MindNode | undefined {
    const root = this.document?.root;
    return root?.children.length === 1 ? root.children[0] : root;
  }

  private visible(): MindNode[] {
    const root = this.visualRoot();
    if (!root) return [];
    const result: MindNode[] = [];
    const pending = [root];
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node) break;
      result.push(node);
      if (!this.collapsed.has(node.id)) pending.push(...[...node.children].reverse());
    }
    return result;
  }

  private draw(): void {
    if (!this.document || !this.file) return;
    for (const [mode, button] of this.modeButtons) {
      button.toggleClass("is-active", mode === this.mode);
      button.setAttribute("aria-pressed", String(mode === this.mode));
    }
    const nodes = this.visible();
    this.renderer.update(nodes, this.document, this.file.path, this.collapsed, {
      visualRootId: this.visualRoot()?.id ?? this.document.root.id, mode: this.mode,
    });
    for (const entry of this.renderer.entries.values()) entry.element.draggable = !entry.element.hasClass("is-editing");
    if (!nodes.some(node => node.id === this.selectedId)) this.selectedId = nodes[0]?.id ?? null;
    this.renderer.select(this.selectedId);
    this.scheduleLayout();
  }

  private scheduleLayout(): void {
    if (!this.ready || this.closed || this.layoutFrame !== undefined) return;
    this.layoutFrame = this.contentEl.win.requestAnimationFrame(() => {
      this.layoutFrame = undefined;
      const root = this.visualRoot();
      if (!root || this.closed) return;
      this.layout = layoutTree(root, this.renderer.sizes(), this.collapsed, this.mode);
      this.renderer.place(this.layout.nodes, this.layout.folds);
      this.svg.empty();
      for (const edge of this.layout.edges) this.svg.createSvg("path", { attr: { d: edge.path } });
      if (this.needsFit && this.canvas.clientWidth > 0 && this.canvas.clientHeight > 0) {
        this.viewport.fit(this.layout.bounds); this.needsFit = false;
      }
      if (this.revealId) { this.ensureVisible(this.revealId); this.revealId = null; }
    });
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
    let created = false;
    if (plan.selectionOffset !== null) {
      const selected = this.document?.nodes.find(node => node.titleFrom === plan.selectionOffset);
      if (selected) {
        if (selected.parentId) this.collapsed.delete(selected.parentId);
        this.draw(); this.select(selected.id, true);
        created = true;
      }
    }
    if (created && (command.type === "add-child" || command.type === "add-sibling")) this.editTitle();
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
    entry.element.draggable = false;
    this.inlineEditor = new InlineEditor(entry.element, {
      initial: node.title,
      suggest: input => new LinkSuggest(this.app, input, file.path),
      save: async text => {
        const plan = planEdit(document, { type: "rename", nodeId: node.id, title: text });
        await this.commit(document.source, plan.edits, file);
      },
      finish: (next, cancelled) => {
        this.inlineEditor = undefined;
        entry.content.hidden = false;
        entry.element.draggable = true;
        if (this.closed || file !== this.file) return;
        this.draw();
        const current = this.document?.nodes.find(item => item.id === node.id)
          ?? (!cancelled ? this.document?.nodes.find(item => item.from === node.from) : undefined);
        if (current) this.select(current.id, true);
        if (!cancelled && next === "child" && current) this.run(() => this.execute({ type: "add-child", nodeId: current.id }));
      },
      resize: () => { this.scheduleLayout(); },
      restore: () => { entry.content.hidden = false; entry.element.draggable = true; },
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
