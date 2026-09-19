import {
  MarkdownRenderChild, MarkdownView, parseLinktext, setIcon,
  type App, type MarkdownPostProcessor, type MarkdownPostProcessorContext,
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
import { NodeRenderer } from "./node-renderer";

/** Obsidian's embed container whose content a map replaced (the live-preview path); its own children are hidden by CSS. */
export const EMBED_HOST_CLASS = "mappy-embed-host";
/** Obsidian's classes that give a note embed its chrome; removed while a map is shown so both paths look the same, restored on release. */
const OBSIDIAN_EMBED_CLASSES = ["markdown-embed", "inline-embed"];
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
  private positions: TopicPositionMap = new Map();
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
    readonly source: MapEmbedSource,
    /** Puts the host's own embed back; runs once, whoever unloads the component. */
    private readonly release: () => void,
  ) { super(containerEl); }

  onload(): void {
    const el = this.containerEl;
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
      this.observer = new ResizeObserver(() => { this.scheduleLayout(); });
      this.observer.observe(this.canvas);
    }
    void this.refresh();
  }

  onunload(): void {
    this.epoch += 1;
    const win = this.containerEl.win;
    if (this.refreshTimer !== undefined) win.clearTimeout(this.refreshTimer);
    if (this.layoutFrame !== undefined) win.cancelAnimationFrame(this.layoutFrame);
    this.refreshTimer = undefined;
    this.layoutFrame = undefined;
    this.observer?.disconnect();
    this.observer = undefined;
    this.document = undefined;
    this.trees = null;
    this.containerEl.empty();
    this.release();
  }

  /** The reader's folds; read-only otherwise. */
  private click(event: MouseEvent): void {
    const target = event.targetNode;
    if (!target?.instanceOf(Element)) return;
    const anchor = target.closest<HTMLAnchorElement>("a.internal-link");
    if (anchor) {
      event.preventDefault();
      event.stopPropagation();
      const link = anchor.dataset.href ?? anchor.getAttribute("href") ?? "";
      void this.app.workspace.openLinkText(link, this.source.file.path, event.metaKey || event.ctrlKey);
      return;
    }
    if (target.closest("a")) return;
    const id = target.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
    if (!id || !target.closest(".mappy-node-toggle")) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.collapsed.has(id)) this.collapsed.delete(id); else this.collapsed.add(id);
    this.draw();
  }

  private scheduleRefresh(): void {
    this.epoch += 1;
    const win = this.containerEl.win;
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
    if (text === this.document?.source && this.document.root.title === file.basename) return;
    const mode = readMapFromSource(text);
    if (!mode) {
      this.show(`${file.basename} はマップではなくなりました。ノートを開き直すと通常の埋め込みに戻ります。`);
      return;
    }
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
    this.draw();
  }

  /** A frame with a sentence instead of a map: the note stopped being one, lost the heading, or could not be read. */
  private show(text: string): void {
    this.document = undefined;
    this.trees = null;
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
    this.layoutFrame = this.containerEl.win.requestAnimationFrame(() => {
      this.layoutFrame = undefined;
      const trees = this.trees;
      if (!trees) return;
      const layout = layoutTree(trees.root, this.renderer.sizes(), this.collapsed, this.mode, embedTopicLayouts(trees, this.positions, this.mode));
      this.renderer.place(layout.nodes, layout.folds);
      this.edges.update(layout.edges);
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

interface LiveEmbed {
  embed: MapEmbed;
  hostPath: string;
}

/**
 * The Markdown post processor for map embeds and the registry of the embeds it
 * created. Two ways an embed reaches it:
 *
 * - Reading view and hover previews render the host note's sections, where the
 *   `.internal-embed` span for `![[map]]` is still Obsidian's placeholder. The span
 *   is replaced by a map before Obsidian loads the note into it.
 * - Live preview renders the embedded note's own sections inside Obsidian's
 *   embed container (the host paragraph is a CodeMirror widget, never a section).
 *   The container is claimed once: its own content is hidden and a map appended.
 *
 * In both cases the component is handed to the renderer (`ctx.addChild`) so it
 * unloads with the section, and every live embed is released when the plugin
 * unloads, so disabling Mappy leaves the ordinary embeds behind.
 */
export class MapEmbeds {
  private readonly live = new Set<LiveEmbed>();
  readonly processor: MarkdownPostProcessor = (el, ctx) => { this.process(el, ctx); };

  constructor(private readonly app: App, private readonly store: DocumentStore) {}

  process(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    // Node labels of a map (view or embed) are rendered Markdown too; they never host embeds.
    if (el.closest(".mappy-view")) return;
    this.claimContainer(el, ctx, false);
    this.replaceSpans(el, ctx);
  }

  get size(): number { return this.live.size; }

  /** Plugin unload: every map goes back to the ordinary embed, and reading views that showed one are redrawn. */
  dispose(): void {
    const hosts = new Set<string>();
    for (const entry of Array.from(this.live)) {
      hosts.add(entry.hostPath);
      entry.embed.unload();
    }
    this.live.clear();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file && hosts.has(view.file.path) && view.getMode() === "preview") {
        view.previewMode.rerender(true);
      }
    }
  }

  private replaceSpans(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    for (const span of Array.from(el.querySelectorAll<HTMLElement>(".internal-embed"))) {
      // Inside a claimed container only Obsidian's hidden rendering remains; a map inside an ordinary note embed is drawn.
      if (span.hasClass(EMBED_HOST_CLASS) || span.parentElement?.closest(`.${EMBED_HOST_CLASS}`)) continue;
      const src = span.getAttribute("src");
      const target = src ? resolveEmbedTarget(this.app, src, ctx.sourcePath) : null;
      // A note embedding itself stays Obsidian's own case.
      if (!target || target.file.path === ctx.sourcePath) continue;
      const container = createDiv();
      span.replaceWith(container);
      this.mount(ctx, container, { ...target, hostPath: ctx.sourcePath }, () => { container.replaceWith(span); });
    }
  }

  private claimContainer(el: HTMLElement, ctx: MarkdownPostProcessorContext, retried: boolean): void {
    const own = this.app.vault.getFileByPath(ctx.sourcePath);
    if (!own || readMapLayout(this.app, own) === null) return;
    const span = el.closest<HTMLElement>(".internal-embed");
    if (!span) {
      // A section can reach the processor before it is attached; look once more when it is.
      if (!retried && !el.isConnected) el.win.requestAnimationFrame(() => { this.claimContainer(el, ctx, true); });
      return;
    }
    if (span.hasClass(EMBED_HOST_CLASS) || span.parentElement?.closest(`.${EMBED_HOST_CLASS}, .mappy-view`)) return;
    const { subpath } = parseLinktext(span.getAttribute("src") ?? "");
    const target = resolveEmbedTarget(this.app, own.path + subpath, ctx.sourcePath);
    if (!target) return;
    const removed = OBSIDIAN_EMBED_CLASSES.filter(name => span.hasClass(name));
    span.removeClass(...removed);
    span.addClass(EMBED_HOST_CLASS);
    const container = span.createDiv();
    this.mount(ctx, container, { ...target, hostPath: ctx.sourcePath }, () => {
      container.remove();
      span.removeClass(EMBED_HOST_CLASS);
      span.addClass(...removed);
    });
  }

  private mount(ctx: MarkdownPostProcessorContext, container: HTMLElement, source: MapEmbedSource, restore: () => void): void {
    let entry: LiveEmbed | undefined;
    const embed = new MapEmbed(this.app, this.store, container, source, () => {
      restore();
      if (entry) this.live.delete(entry);
    });
    entry = { embed, hostPath: source.hostPath };
    this.live.add(entry);
    ctx.addChild(embed);
  }
}
