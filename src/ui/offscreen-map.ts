import { Component, type App, type TFile } from "obsidian";
import { initialCallFolds, projectShown } from "../core/calls";
import { readMapFromSource, visibleNodes } from "../core/embed";
import { parseMarkdown } from "../core/markdown";
import { readTopicPositions, topicKeys } from "../core/topics";
import type { CaptureSource } from "../export/svg-capture";
import type { ExportTheme } from "../export/svg-document";
import { layoutTree, type FreeTopicLayout } from "../layout/layout";
import type { DocumentStore } from "../obsidian/document-store";
import type { PaintedMap } from "../obsidian/excalidraw-bridge";
import { renderSvg } from "../obsidian/image-export";
import { CallReader } from "../obsidian/map-calls";
import { EdgeLayer } from "./edge-layer";
import { NodeRenderer } from "./node-renderer";

/** The hidden host on the document's body; styles.css keeps it a pixel large and invisible. */
export const OFFSCREEN_CLASS = "mappy-offscreen";
/**
 * As the export's wait (`EXPORT_RENDER_WAIT_MS`, §5 M13): the wait ends when no Markdown render of a node finishes
 * for this long (a hung post-processor or embed), while a slow map whose renders keep finishing is waited for.
 */
export const OFFSCREEN_RENDER_STALL_MS = 2000;
/** The whole wait for the renders is capped here (a 2,000-node map keeps finishing renders for a while); past it the map is captured as far as it got. */
export const OFFSCREEN_RENDER_BUDGET_MS = 20_000;
/** Images of the nodes are vault files read locally; they get this long to load before the nodes are measured. */
export const OFFSCREEN_IMAGE_WAIT_MS = 1000;

/**
 * A map drawn without a leaf (§5 M6, Excalidraw's own "Insert image / Insert as
 * embeddable" of a map note): the note as the map view would open it — the body,
 * the free topics at their stored positions, the called maps grafted in and folded
 * below their roots' children (§5 M12), everything else open — drawn by the view's
 * own renderer into a hidden frame on the document, laid out once and handed to
 * the SVG capture (§5 M13). The frame is on the document because the capture reads
 * computed styles and sizes; it is a pixel large, invisible and inert. The theme is
 * explicit (light by default): Excalidraw inverts an SVG image in its dark mode, so
 * a light SVG looks right on both canvases. Nothing here writes, and the frame goes
 * when the component unloads.
 */
export class OffscreenMap extends Component {
  private host!: HTMLDivElement;
  private canvas!: HTMLDivElement;
  private svg!: SVGSVGElement;
  private nodes!: HTMLDivElement;
  private renderer!: NodeRenderer;
  private edges!: EdgeLayer;

  constructor(
    private readonly app: App,
    private readonly store: DocumentStore,
    private readonly doc: Document,
    private readonly file: TFile,
    private readonly theme: ExportTheme = "light",
  ) { super(); }

  onload(): void {
    this.host = this.doc.body.createDiv({ cls: OFFSCREEN_CLASS, attr: { "aria-hidden": "true" } });
    const frame = this.host.createDiv({ cls: `mappy-view theme-${this.theme}` });
    this.canvas = frame.createDiv({ cls: "mappy-canvas" });
    const world = this.canvas.createDiv({ cls: "mappy-world" });
    this.svg = world.createSvg("svg", { cls: "mappy-edges", attr: { "aria-hidden": "true" } });
    this.nodes = world.createDiv({ cls: "mappy-nodes" });
    this.edges = new EdgeLayer(this.svg);
    // A render's end asks for a layout; there is one layout, after every render, so nothing is scheduled here.
    this.renderer = this.addChild(new NodeRenderer(this.app, this.nodes, () => {}));
  }

  onunload(): void {
    this.host.remove();
  }

  /**
   * Read, project, render, wait, lay out: what the export captures from a view. `stalled`
   * is true when a render never finished (or the budget ran out) and the map shows as far
   * as it got. The entries are copied, as the view's export hands them out.
   */
  async capture(): Promise<{ source: CaptureSource; stalled: boolean }> {
    const file = this.file;
    const text = await this.store.read(file);
    const mode = readMapFromSource(text);
    if (mode === null) throw new Error(`${file.basename} はマップではありません。`);
    const document = parseMarkdown(text, file.basename);
    const targets = await new CallReader(this.app, this.store).read(document, file.path);
    const trees = projectShown(document, targets);
    const collapsed = initialCallFolds(trees.calls);
    const [root = trees.split.root, ...topics] = trees.calls.roots;
    this.renderer.update(visibleNodes({ root, topics }, collapsed), document, file.path, collapsed, {
      visualRootId: root.id, topicIds: new Set(topics.map(topic => topic.id)), mode,
      sources: trees.calls.sources, trees: [root, ...topics],
    });
    const stalled = !await this.rendered();
    await this.imagesLoaded(OFFSCREEN_IMAGE_WAIT_MS);
    // Keys come from the headings as written (`split`); the tree laid out is the one shown (a topic may call a map).
    const positions = readTopicPositions(text);
    const keys = topicKeys(document);
    const layouts: FreeTopicLayout[] = trees.split.topics.map((topic, index) => {
      const stored = positions.get(keys.get(topic.id) ?? topic.title)?.[mode];
      return { tree: trees.calls.roots[index + 1] ?? topic, position: stored ? { x: stored.x, y: stored.y } : null };
    });
    const layout = layoutTree(root, this.renderer.sizes(), collapsed, mode, layouts);
    this.renderer.place(layout.nodes, layout.folds);
    this.edges.update(layout.edges);
    return { source: { layout, entries: new Map(this.renderer.entries), canvas: this.canvas, edges: this.svg }, stalled };
  }

  /** True once every render finished; false when one stalled or the budget ran out. */
  private rendered(): Promise<boolean> {
    const win = this.nodes.win;
    return new Promise(resolve => {
      const timer = win.setTimeout(() => { resolve(false); }, OFFSCREEN_RENDER_BUDGET_MS);
      void this.renderer.idle(OFFSCREEN_RENDER_STALL_MS).then(done => { win.clearTimeout(timer); resolve(done); });
    });
  }

  /** Waits for the images still loading, at most `ms`; an image that never answers does not hold the capture. */
  private imagesLoaded(ms: number): Promise<void> {
    const pending = Array.from(this.nodes.querySelectorAll("img")).filter(image => !image.complete);
    if (pending.length === 0) return Promise.resolve();
    const win = this.nodes.win;
    return new Promise(resolve => {
      let left = pending.length;
      const timer = win.setTimeout(resolve, ms);
      const settled = (): void => {
        left -= 1;
        if (left === 0) { win.clearTimeout(timer); resolve(); }
      };
      for (const image of pending) {
        image.addEventListener("load", settled, { once: true });
        image.addEventListener("error", settled, { once: true });
      }
    });
  }
}

/**
 * The painter the Excalidraw bridge asks for a map note: draws it off screen, captures
 * it as the export would, and releases the frame. The SVG is the one the export writes
 * (§5 M13) in the light theme; the bounds are the layout's, for the embeddable's frame.
 */
export async function paintMap(app: App, store: DocumentStore, file: TFile, doc: Document = document): Promise<PaintedMap> {
  const map = new OffscreenMap(app, store, doc, file);
  map.load();
  try {
    const { source, stalled } = await map.capture();
    const { svg, size } = await renderSvg(app, file, source, { theme: "light" });
    return { svg, size: { width: size.width, height: size.height }, bounds: { ...source.layout.bounds }, stalled };
  } finally {
    map.unload();
  }
}
