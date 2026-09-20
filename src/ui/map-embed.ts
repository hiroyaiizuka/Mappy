import {
  MarkdownRenderChild, MarkdownView, parseLinktext, setIcon,
  type App, type MarkdownPostProcessor, type MarkdownPostProcessorContext, type TFile,
} from "obsidian";
import { embedTopicLayouts, embedTrees, initialFolds, readMapFromSource, visibleNodes, type EmbedTrees } from "../core/embed";
import { parseMarkdown, type MindDocument } from "../core/markdown";
import { readTopicPositions, type TopicPositionMap } from "../core/topics";
import { fitToBounds } from "../interaction/viewport";
import { layoutTree, type LayoutBounds, type LayoutMode } from "../layout/layout";
import type { DocumentStore } from "../obsidian/document-store";
import { resolveEmbedTarget, type EmbedTarget } from "../obsidian/embed-target";
import { readMapLayout } from "../obsidian/frontmatter";
import { EdgeLayer } from "./edge-layer";
import { mapClick } from "./map-events";
import { NodeRenderer } from "./node-renderer";

/** Obsidian's embed container whose content a map replaced; its own children are hidden by CSS while the map shows. */
export const EMBED_HOST_CLASS = "mappy-embed-host";
/** The element inside a rendered section that carries a map's lifecycle when the map's frame cannot sit in that section itself. */
export const EMBED_ANCHOR_CLASS = "mappy-embed-anchor";
/** Obsidian's classes that give a note embed its chrome; removed while a map is shown so both paths look the same, restored on release. */
const OBSIDIAN_EMBED_CLASSES = ["markdown-embed", "inline-embed"];
/**
 * How long a section of an embedded note waiting for its container to join the document is
 * held by the plugin itself; after that it is kept only as long as Obsidian keeps the
 * section (a weak reference), so a rendering Obsidian discarded without unloading can be
 * collected while an embed below the fold still gets its map when it is scrolled to.
 * Obsidian 1.6.7 attaches the container 17–28 ms after the section reaches the processor
 * when the embed is on screen, only when it scrolls into view when it is below the fold
 * (2.5 s seen), and never for a rendering it discarded (LEV-91).
 */
export const EMBED_CLAIM_HOLD_MS = 60_000;
const EMBED_PADDING = 24;
const REFRESH_DEBOUNCE = 45;

export interface MapEmbedSource extends EmbedTarget {
  /** The note the embed is written in; the "open" action resolves from it. */
  hostPath: string;
}

/**
 * A read-only map inside a rendered note (§5 M10): the source note's tree, laid
 * out by its own `mappy-layout`, fitted into a frame of fixed height with
 * everything below the first level folded. It never writes; it re-reads the note
 * (an open editor buffer first) when the note changes, and it lives exactly as
 * long as the rendered section that holds it.
 *
 * `containerEl` is what Obsidian watches to decide the component is still alive
 * (it must be a child of the rendered section); `frame` is where the map is drawn.
 * They are the same element when the frame replaces a placeholder inside the
 * section, and differ when the frame is appended to Obsidian's embed container
 * around the section (live preview), where a hidden anchor inside the section
 * carries the lifecycle instead.
 */
export class MapEmbed extends MarkdownRenderChild {
  private canvas!: HTMLDivElement;
  private world!: HTMLDivElement;
  private nodes!: HTMLDivElement;
  private message!: HTMLDivElement;
  private renderer!: NodeRenderer;
  private edges!: EdgeLayer;
  private document: MindDocument | undefined;
  private trees: EmbedTrees | null = null;
  /** The source text the map on screen was drawn from; null while a sentence shows instead. */
  private drawnSource: string | null = null;
  private positions: TopicPositionMap = new Map();
  private bounds: LayoutBounds | null = null;
  private mode: LayoutMode = "mindmap";
  private collapsed = new Set<string>();
  private epoch = 0;
  private refreshTimer: number | undefined;
  private layoutFrame: number | undefined;
  private observer: ResizeObserver | undefined;

  constructor(
    private readonly app: App,
    private readonly store: DocumentStore,
    containerEl: HTMLElement,
    /** Where the map is drawn; `containerEl` itself unless the section cannot hold the frame. */
    readonly frame: HTMLElement,
    readonly source: MapEmbedSource,
    /** Puts the host's own embed back; runs once, whoever unloads the component. */
    private readonly release: () => void,
  ) { super(containerEl); }

  onload(): void {
    const el = this.frame;
    const name = this.source.file.basename + this.source.subpath.replace(/^#/u, " › ");
    el.addClass("mappy-embed", "mappy-view");
    el.dataset.mappyEmbed = this.source.file.path + this.source.subpath;
    el.setAttribute("role", "figure");
    el.setAttribute("aria-label", `マインドマップ: ${name}`);
    this.canvas = el.createDiv({ cls: "mappy-canvas", attr: { role: "tree", "aria-readonly": "true", "aria-label": name } });
    this.world = this.canvas.createDiv({ cls: "mappy-world" });
    this.edges = new EdgeLayer(this.world.createSvg("svg", { cls: "mappy-edges", attr: { "aria-hidden": "true" } }));
    this.nodes = this.world.createDiv({ cls: "mappy-nodes" });
    this.message = el.createDiv({ cls: "mappy-embed-message" });
    this.message.hidden = true;
    const open = el.createEl("button", { cls: "mappy-button mappy-embed-open", attr: { type: "button", "aria-label": "マップで開く", title: "マップで開く" } });
    setIcon(open, "git-fork");
    this.registerDomEvent(open, "click", event => {
      event.preventDefault();
      event.stopPropagation();
      void this.app.workspace.openLinkText(this.source.file.path, this.source.hostPath, event.metaKey || event.ctrlKey);
    });
    this.renderer = this.addChild(new NodeRenderer(this.app, this.nodes, () => { this.scheduleLayout(); }));
    this.registerDomEvent(this.nodes, "load", () => { this.scheduleLayout(); }, true);
    this.registerDomEvent(this.canvas, "click", event => { this.click(event); });
    const path = (): string => this.source.file.path;
    this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => {
      if (info.file?.path === path()) this.scheduleRefresh();
    }));
    this.registerEvent(this.app.vault.on("modify", file => { if (file.path === path()) this.scheduleRefresh(); }));
    this.registerEvent(this.app.vault.on("rename", file => { if (file === this.source.file) this.scheduleRefresh(); }));
    this.registerEvent(this.app.vault.on("delete", file => { if (file === this.source.file) this.scheduleRefresh(); }));
    if (typeof ResizeObserver !== "undefined") {
      // Only the fit depends on the frame's size; the layout itself does not.
      this.observer = new ResizeObserver(() => { if (this.bounds) this.fit(this.bounds); });
      this.observer.observe(this.canvas);
    }
    void this.refresh();
  }

  onunload(): void {
    this.epoch += 1;
    const win = this.frame.win;
    if (this.refreshTimer !== undefined) win.clearTimeout(this.refreshTimer);
    if (this.layoutFrame !== undefined) win.cancelAnimationFrame(this.layoutFrame);
    this.refreshTimer = undefined;
    this.layoutFrame = undefined;
    this.observer?.disconnect();
    this.observer = undefined;
    this.document = undefined;
    this.trees = null;
    this.drawnSource = null;
    this.frame.empty();
    this.release();
  }

  /** The reader's folds and the links; nothing else reacts. A link is followed here and goes no further. */
  private click(event: MouseEvent): void {
    const click = mapClick(event, this.canvas);
    if (!click) return;
    if ("link" in click) {
      event.preventDefault();
      event.stopPropagation();
      void this.app.workspace.openLinkText(click.link, this.source.file.path, click.newLeaf);
      return;
    }
    if (!click.toggle) return;
    event.preventDefault();
    if (this.collapsed.has(click.nodeId)) this.collapsed.delete(click.nodeId); else this.collapsed.add(click.nodeId);
    this.draw();
  }

  private scheduleRefresh(): void {
    this.epoch += 1;
    const win = this.frame.win;
    if (this.refreshTimer !== undefined) win.clearTimeout(this.refreshTimer);
    this.refreshTimer = win.setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, REFRESH_DEBOUNCE);
  }

  private async refresh(): Promise<void> {
    const epoch = ++this.epoch;
    const file = this.source.file;
    let text: string;
    try {
      text = await this.store.read(file);
    } catch {
      if (epoch === this.epoch) this.show(`${file.basename} を読み込めませんでした。`);
      return;
    }
    if (epoch !== this.epoch) return;
    if (text === this.drawnSource && this.document?.root.title === file.basename) return;
    const mode = readMapFromSource(text);
    if (!mode) {
      this.show(`${file.basename} はマップではなくなりました。開き直すと通常の表示に戻ります。`);
      return;
    }
    // The last map drawn stays the reference for node identity, so the reader's folds survive a sentence in between.
    const previous = this.document;
    this.document = parseMarkdown(text, file.basename, previous);
    this.mode = mode;
    this.positions = readTopicPositions(text);
    const trees = embedTrees(this.document, this.source.subpath);
    if (!trees) {
      this.show(`${file.basename} に見出し「${this.source.subpath.replace(/^#/u, "")}」が見つかりません。`);
      return;
    }
    this.trees = trees;
    // The reader's folds survive an edit; branches new to the note start folded, as on open.
    const ids = new Set([this.document.root.id, ...this.document.nodes.map(node => node.id)]);
    const known = previous ? new Set([previous.root.id, ...previous.nodes.map(node => node.id)]) : null;
    const collapsed = new Set(Array.from(this.collapsed).filter(id => ids.has(id)));
    for (const id of initialFolds(trees)) if (!known?.has(id)) collapsed.add(id);
    this.collapsed = collapsed;
    this.drawnSource = text;
    this.draw();
  }

  /** A frame with a sentence instead of a map: the note stopped being one, lost the heading, or could not be read. */
  private show(text: string): void {
    this.trees = null;
    this.drawnSource = null;
    this.bounds = null;
    this.renderer.update([], parseMarkdown("", ""), "", this.collapsed, { visualRootId: "root", mode: this.mode });
    this.edges.clear();
    this.canvas.hidden = true;
    this.message.setText(text);
    this.message.hidden = false;
  }

  private draw(): void {
    const trees = this.trees;
    if (!this.document || !trees) return;
    this.message.hidden = true;
    this.canvas.hidden = false;
    this.renderer.update(visibleNodes(trees, this.collapsed), this.document, this.source.file.path, this.collapsed, {
      visualRootId: trees.root.id, topicIds: new Set(trees.topics.map(topic => topic.id)), mode: this.mode,
    });
    this.scheduleLayout();
  }

  private scheduleLayout(): void {
    if (this.layoutFrame !== undefined) return;
    this.layoutFrame = this.frame.win.requestAnimationFrame(() => {
      this.layoutFrame = undefined;
      const trees = this.trees;
      const document = this.document;
      if (!trees || !document) return;
      const layout = layoutTree(trees.root, this.renderer.sizes(), this.collapsed, this.mode, embedTopicLayouts(document, trees, this.positions, this.mode));
      this.renderer.place(layout.nodes, layout.folds);
      this.edges.update(layout.edges);
      this.bounds = layout.bounds;
      this.fit(layout.bounds);
    });
  }

  /** The whole map in the frame, never magnified past its own size. */
  private fit(bounds: LayoutBounds): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width <= 0 || height <= 0) return;
    const scale = Math.min(1, fitToBounds(bounds, width, height, EMBED_PADDING).scale);
    const x = width / 2 - (bounds.x + bounds.width / 2) * scale;
    const y = height / 2 - (bounds.y + bounds.height / 2) * scale;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }
}

/**
 * A section of an embedded note that reached the processor before its container joined
 * the document. It lives in the section like a map would (`ctx.addChild`, on a hidden
 * anchor inside the section, which is what Obsidian watches) and reports once: attached
 * (the watcher of the document found the anchor in it), or not, because the section was
 * unloaded (Obsidian discarded that rendering, or the host closed) or the plugin unloaded.
 * The anchor goes with the report, and nothing else is registered, so giving up leaves
 * nothing behind. Nothing here polls: the document's own changes drive `check`.
 */
class PendingClaim extends MarkdownRenderChild {
  private timer: number | undefined;
  /** The weak handle the watcher keeps once the hold is over; on the claim itself so it can be dropped without a strong reference. */
  ref: WeakRef<PendingClaim> | undefined;

  constructor(section: HTMLElement, private settled: ((attached: boolean) => void) | null) {
    super(section.createDiv({ cls: EMBED_ANCHOR_CLASS, attr: { hidden: "" } }));
  }

  onunload(): void { this.settle(false); }

  /** Reports attached once the anchor is in the document. */
  check(): boolean {
    if (!this.containerEl.isConnected) return false;
    this.settle(true);
    return true;
  }

  /** Runs `release` after `ms` unless the wait has ended by then. */
  hold(ms: number, release: () => void): void {
    this.timer = this.containerEl.win.setTimeout(() => {
      this.timer = undefined;
      release();
    }, ms);
  }

  /** Ends the wait; harmless once it has ended. */
  settle(attached: boolean): void {
    if (this.timer !== undefined) this.containerEl.win.clearTimeout(this.timer);
    this.timer = undefined;
    const settled = this.settled;
    if (!settled) return;
    this.settled = null;
    this.containerEl.remove();
    settled(attached);
  }
}

/**
 * The sections of one document waiting for their container: one observer of the document's
 * DOM changes serves them all, checking each on every change and disconnected while none
 * waits. `held` are the plugin's own for `EMBED_CLAIM_HOLD_MS`; `kept` are then only as
 * long as Obsidian keeps them (their section's component still holds them).
 */
interface Watcher {
  observer: MutationObserver;
  held: Set<PendingClaim>;
  kept: Set<WeakRef<PendingClaim>>;
}

/**
 * The Markdown post processor for map embeds and the registry of the embeds it
 * created. Two ways an embed reaches it:
 *
 * - Reading view and hover previews render the host note's sections, where the
 *   `.internal-embed` span for `![[map]]` is still Obsidian's placeholder. The span
 *   is replaced by a map before Obsidian loads the note into it. A span Obsidian
 *   loaded first keeps its own component and is claimed instead.
 * - Live preview renders the embedded note's own sections inside Obsidian's
 *   embed container (the host paragraph is a CodeMirror widget, never a section).
 *   The container is claimed once: its own content is hidden and a map appended,
 *   with an anchor inside the section carrying the lifecycle. A section that
 *   arrives before its container is on the document waits for it (an embed below the
 *   fold gets its container only when scrolled to) until Obsidian drops the section.
 *
 * In both cases the component is handed to the renderer (`ctx.addChild`) so it
 * unloads with the section, and every live embed is released when the plugin
 * unloads, so disabling Mappy leaves the ordinary embeds behind.
 */
export class MapEmbeds {
  private readonly live = new Set<MapEmbed>();
  /** Sections waiting for their container, by the document they will join. */
  private readonly watchers = new Map<Document, Watcher>();
  private disposed = false;
  readonly processor: MarkdownPostProcessor = (el, ctx) => { this.process(el, ctx); };

  constructor(private readonly app: App, private readonly store: DocumentStore) {}

  process(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    // Node labels of a map (view or embed) are rendered Markdown too; they never host embeds.
    if (this.disposed || el.closest(".mappy-view")) return;
    this.claimContainer(el, ctx);
    this.replaceSpans(el, ctx);
  }

  get size(): number { return this.live.size; }

  /** Sections of embedded notes still waiting for their container to join the document, within the hold. */
  get pending(): number {
    let count = 0;
    for (const watcher of this.watchers.values()) count += watcher.held.size;
    return count;
  }

  /** Plugin unload: every map goes back to the ordinary embed, and the reading views that showed one are redrawn. */
  dispose(): void {
    this.disposed = true;
    for (const watcher of Array.from(this.watchers.values())) {
      for (const claim of Array.from(watcher.held)) claim.settle(false);
      for (const ref of Array.from(watcher.kept)) ref.deref()?.settle(false);
      watcher.observer.disconnect();
    }
    this.watchers.clear();
    const views = new Set<MarkdownView>();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.getMode() !== "preview") continue;
      for (const embed of this.live) if (view.containerEl.contains(embed.frame)) views.add(view);
    }
    for (const embed of Array.from(this.live)) embed.unload();
    this.live.clear();
    for (const view of views) view.previewMode.rerender(true);
  }

  private replaceSpans(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    for (const span of Array.from(el.querySelectorAll<HTMLElement>(".internal-embed"))) {
      // Inside a claimed container only Obsidian's hidden rendering remains; a map inside an ordinary note embed is drawn.
      if (span.hasClass(EMBED_HOST_CLASS) || span.parentElement?.closest(`.${EMBED_HOST_CLASS}`)) continue;
      const src = span.getAttribute("src");
      const target = src ? resolveEmbedTarget(this.app, src, ctx.sourcePath) : null;
      // A note embedding itself stays Obsidian's own case.
      if (!target || target.file.path === ctx.sourcePath) continue;
      const source = { ...target, hostPath: ctx.sourcePath };
      if (span.hasClass("is-loaded") || span.childElementCount > 0) {
        // Obsidian got to the span first: its component lives on inside, so the container is claimed, not swapped out.
        this.claim(ctx, span, source, null);
        continue;
      }
      const frame = createDiv();
      span.replaceWith(frame);
      this.mount(ctx, frame, frame, source, () => { frame.replaceWith(span); });
    }
  }

  private claimContainer(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const own = this.app.vault.getFileByPath(ctx.sourcePath);
    if (!own || readMapLayout(this.app, own) === null) return;
    if (el.isConnected) {
      this.claimAround(el, ctx, own);
      return;
    }
    // A section can reach the processor before its container is on the document, and Obsidian attaches it a few
    // frames later, when the embed scrolls into view, or never (a discarded rendering); wait for it.
    const watcher = this.watcher(el.doc);
    const claim = new PendingClaim(el, attached => {
      watcher.held.delete(claim);
      if (claim.ref) watcher.kept.delete(claim.ref);
      this.prune(el.doc, watcher);
      if (attached && !this.disposed) this.claimAround(el, ctx, own);
    });
    watcher.held.add(claim);
    claim.hold(EMBED_CLAIM_HOLD_MS, () => {
      watcher.held.delete(claim);
      claim.ref = new WeakRef(claim);
      watcher.kept.add(claim.ref);
    });
    ctx.addChild(claim);
  }

  /** The watcher of a document, started on its first waiting section. */
  private watcher(doc: Document): Watcher {
    const existing = this.watchers.get(doc);
    if (existing) return existing;
    const held = new Set<PendingClaim>();
    const kept = new Set<WeakRef<PendingClaim>>();
    const observer = new MutationObserver(() => {
      for (const claim of Array.from(held)) claim.check();
      for (const ref of Array.from(kept)) {
        const claim = ref.deref();
        // Obsidian dropped the section without unloading it: gone with it.
        if (!claim) kept.delete(ref);
        else claim.check();
      }
      this.prune(doc, watcher);
    });
    const watcher: Watcher = { observer, held, kept };
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    this.watchers.set(doc, watcher);
    return watcher;
  }

  /** Stops a document's watcher once nothing waits in it. */
  private prune(doc: Document, watcher: Watcher): void {
    if (watcher.held.size > 0 || watcher.kept.size > 0 || this.watchers.get(doc) !== watcher) return;
    watcher.observer.disconnect();
    this.watchers.delete(doc);
  }

  /** The section is on the document: claim the container around it, unless it is the note's own view, inside a map, or in a container already claimed. */
  private claimAround(el: HTMLElement, ctx: MarkdownPostProcessorContext, own: TFile): void {
    const span = el.closest<HTMLElement>(".internal-embed");
    // The section itself may have landed inside a map (a node label) since `process` looked; the check covers the whole way up.
    if (!span || el.closest(`.${EMBED_HOST_CLASS}, .mappy-view`)) return;
    const { subpath } = parseLinktext(span.getAttribute("src") ?? "");
    const target = resolveEmbedTarget(this.app, own.path + subpath, ctx.sourcePath);
    if (!target) return;
    // The frame goes on the container, outside this section; the anchor inside the section keeps the lifecycle honest.
    this.claim(ctx, span, { ...target, hostPath: ctx.sourcePath }, el.createDiv({ cls: EMBED_ANCHOR_CLASS, attr: { hidden: "" } }));
  }

  /** Hide what Obsidian rendered into the container and draw the map beside it; `anchor` null means the frame is inside the section. */
  private claim(ctx: MarkdownPostProcessorContext, span: HTMLElement, source: MapEmbedSource, anchor: HTMLElement | null): void {
    const removed = OBSIDIAN_EMBED_CLASSES.filter(name => span.hasClass(name));
    span.removeClass(...removed);
    span.addClass(EMBED_HOST_CLASS);
    const frame = span.createDiv();
    this.mount(ctx, anchor ?? frame, frame, source, () => {
      frame.remove();
      anchor?.remove();
      span.removeClass(EMBED_HOST_CLASS);
      span.addClass(...removed);
    });
  }

  private mount(ctx: MarkdownPostProcessorContext, anchor: HTMLElement, frame: HTMLElement, source: MapEmbedSource, restore: () => void): void {
    const embed: MapEmbed = new MapEmbed(this.app, this.store, anchor, frame, source, () => {
      restore();
      this.live.delete(embed);
    });
    this.live.add(embed);
    ctx.addChild(embed);
  }
}
