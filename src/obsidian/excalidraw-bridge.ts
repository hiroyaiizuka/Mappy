import type { App, TFile } from 'obsidian';
import { imageMimeType } from '../core/attachments';
import { initialCallFolds, projectCalls, type CallTargets } from '../core/calls';
import { parseMarkdown, projectMap, type MindDocument } from '../core/markdown';
import { externalUrl, hasUrlScheme, urlScheme, wikiLinkPath } from '../core/wiki-link';
import {
  buildScene, sceneContents, type NodeMeasure, type NodeRole, type SceneNodeContent,
} from '../export/excalidraw-scene';
import { FIT_PADDING } from '../interaction/viewport';
import type { LayoutBounds, LayoutMode, NodeSize } from '../layout/layout';
import type { Point } from '../layout/path-points';
import type {
  ExcalidrawAutomate, ExcalidrawDropData, ExcalidrawDropHook, ExcalidrawElement, ExcalidrawStyle, ExcalidrawViewLike,
} from '../types/excalidraw-automate';
import type { DocumentStore } from './document-store';
import { readMapLayout } from './frontmatter';
import { createSvgAttachment } from './image-export';
import { CallReader } from './map-calls';

export interface ImportRequest {
  file: TFile;
  mode: LayoutMode;
  /** Node IDs of `document`; a fresh parse assigns new IDs, so pass the document they belong to. */
  collapsed: ReadonlySet<string>;
  document?: MindDocument;
  /**
   * The maps the document's items call (§5 M12), as the map view resolved them; read here when
   * absent (a Markdown view), with the called trees folded below their roots' children, as they open.
   */
  calls?: CallTargets;
}

/**
 * A map drawn without a leaf (§5 M6, the built-in insert routes): the layout's bounds the
 * map view would fit and, when asked for, the SVG the export would write (§5 M13). `stalled`
 * says a Markdown render never finished, so the map is shown as far as it got, as the export
 * shows it.
 */
export interface PaintedMap {
  /** Null when the painter was not asked for it (an embeddable needs only the bounds). */
  svg: string | null;
  bounds: LayoutBounds;
  stalled: boolean;
}

/** Draws a map note off screen; the plugin wires `src/ui/offscreen-map.ts` in, the bridge only asks. */
export type MapPainter = (file: TFile, options: { svg: boolean }) => Promise<PaintedMap>;

/** The map view caps attachment previews; the drawing keeps the same proportions. */
const MAX_IMAGE = { width: 240, height: 140 };
const FILE_GAP = 40;
const ROUNDED = { type: 3 };
const DEFAULT_DROP_POLL_MS = 200;
const DEFAULT_DROP_TIMEOUT_MS = 60_000;
/** An "Insert as embeddable" frame is no longer than this on its longer side; the live view inside fits the map to it. */
export const EMBEDDABLE_MAX_SIDE = 800;
export const DEFAULT_DROP_STALLED_MESSAGE = '描画が終わらないノードがあるため、描けたところまでのマップに合わせます。';

const BASE_STYLE: Partial<ExcalidrawStyle> = {
  strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
  roughness: 1, opacity: 100, roundness: null, fontSize: 16, textAlign: 'left', verticalAlign: 'top',
};

const ROLE_STYLE: Record<NodeRole, { fontSize: number; box: boolean; padding: number; fill: string; text: string }> = {
  root: { fontSize: 20, box: true, padding: 10, fill: '#1e1e1e', text: '#ffffff' },
  stage: { fontSize: 16, box: true, padding: 8, fill: 'transparent', text: '#1e1e1e' },
  branch: { fontSize: 16, box: false, padding: 0, fill: 'transparent', text: '#1e1e1e' },
};

interface CreatedBlock { ids: string[]; origin: Point; size: NodeSize }
interface CreatedNode { label: CreatedBlock; images: CreatedBlock[] }

/** Only the modifier that Excalidraw's own internal-drag defaults leave unused on both platforms. */
export function isMappyDrop(event: ExcalidrawDropData['event']): boolean {
  return event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey;
}

function mappyTarget(app: App, drawing: TFile, element: ExcalidrawElement): TFile | null {
  if (element.type !== 'embeddable') return null;
  const path = wikiLinkPath(element.link);
  if (!path) return null;
  const target = app.metadataCache.getFirstLinkpathDest(path, drawing.path);
  return target && readMapLayout(app, target) !== null ? target : null;
}

/**
 * The map note a built-in "Insert image" drew as Markdown text: an image element whose
 * vault file (Excalidraw's own mapping from the element's file id) is a map. Only an EA
 * that exposes the mapping and can delete a view element can replace the image; an older
 * one leaves it as it is.
 */
function mappyImageSource(app: App, ea: ExcalidrawAutomate, element: ExcalidrawElement): TFile | null {
  if (element.type !== 'image' || typeof ea.getViewFileForImageElement !== 'function' || typeof ea.deleteViewElements !== 'function') return null;
  const file = ea.getViewFileForImageElement(element);
  return file && readMapLayout(app, file) !== null ? file : null;
}

/** Excalidraw stores the visible outer frame as the embeddable element's stroke. */
function isBordered(element: ExcalidrawElement): boolean {
  return element.strokeColor !== 'transparent';
}

/**
 * The frame of an "Insert as embeddable" drop for a map of these bounds: the bounds plus
 * the view's fit padding on each side, so the live view shows the map at 100%, scaled down
 * together so the longer side is at most `maxSide`. Never smaller than a pixel.
 */
export function embeddableFrameSize(bounds: NodeSize, maxSide = EMBEDDABLE_MAX_SIDE): NodeSize {
  const width = Math.max(1, bounds.width + FIT_PADDING * 2);
  const height = Math.max(1, bounds.height + FIT_PADDING * 2);
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A new element of a built-in drop and the map note it came from. */
interface DroppedMap {
  element: ExcalidrawElement;
  file: TFile;
}

/** What a poll of the view found: the drop's new elements from map notes, embeddables and Markdown images apart. */
interface DroppedMaps {
  embeds: DroppedMap[];
  images: DroppedMap[];
}

/**
 * Bridges Mappy to the Excalidraw plugin through its public ExcalidrawAutomate
 * API: an Option/Alt drop of a note inserts the map as native elements, and a
 * command inserts the active map. The global drop hook is a single slot, so it
 * is chained to whatever was installed before and restored on unload.
 */
export class ExcalidrawBridge {
  private hook: ExcalidrawDropHook | null = null;
  private previous: ExcalidrawDropHook | null = null;
  private host: ExcalidrawAutomate | null = null;
  private disposed = false;

  constructor(
    private readonly app: App,
    private readonly store: DocumentStore,
    private readonly automate: () => ExcalidrawAutomate | undefined = () => window.ExcalidrawAutomate,
    private readonly report: (message: string) => void = () => {},
    /** Without a painter the built-in routes only lose their border, as before the map was drawn for them. */
    private readonly paint: MapPainter | null = null,
  ) {}

  get available(): boolean { return this.automate() !== undefined; }

  /** Idempotent; safe to call whenever the layout changes, so a late-loaded Excalidraw is still hooked. */
  ensureHook(): boolean {
    if (this.disposed) return false;
    const ea = this.automate();
    if (!ea) { this.host = null; this.hook = null; return false; }
    if (this.host === ea && this.hook && ea.onDropHook === this.hook) return true;
    const previous = ea.onDropHook ?? null;
    const hook: ExcalidrawDropHook = data => {
      if (this.disposed || this.hook !== hook) return previous?.(data) ?? false;
      if (this.handleDrop(data)) return true;
      this.watchDefaultDrop(data);
      return previous?.(data) ?? false;
    };
    ea.onDropHook = hook;
    this.hook = hook;
    this.previous = previous;
    this.host = ea;
    return true;
  }

  dispose(): void {
    this.disposed = true;
    if (this.host && this.hook && this.host.onDropHook === this.hook) this.host.onDropHook = this.previous;
    this.host = null;
    this.hook = null;
    this.previous = null;
  }

  /** Synchronous decision for Excalidraw; the import itself runs afterwards. */
  handleDrop(data: ExcalidrawDropData): boolean {
    if (data.type !== 'file' || !isMappyDrop(data.event)) return false;
    const files = (data.payload.files ?? []).filter(file => readMapLayout(this.app, file) !== null);
    if (files.length === 0) return false;
    void this.importFiles(files, data.view, [data.pointerPosition.x, data.pointerPosition.y]).catch((error: unknown) => {
      this.report(error instanceof Error ? error.message : 'Excalidraw への挿入に失敗しました。');
    });
    return true;
  }

  /**
   * Excalidraw's built-in "Insert as embeddable / Insert image" flow completes after its
   * modal closes. Observe only the newly-created elements, then fit them to the map through
   * EA's identity-preserving edit workflow: an embeddable loses its border and takes the
   * map's proportions, a Markdown image is replaced by the map's own SVG (§5 M6).
   */
  private watchDefaultDrop(data: ExcalidrawDropData): void {
    if (data.type !== 'file' || isMappyDrop(data.event)) return;
    if (!(data.payload.files ?? []).some(file => readMapLayout(this.app, file) !== null)) return;
    const host = this.automate();
    if (!host) return;
    const ea = host.getAPI(data.view);
    if (typeof ea.getViewElements !== 'function' || typeof ea.copyViewElementsToEAforEditing !== 'function') {
      ea.destroy?.();
      return;
    }
    const before = new Set(ea.getViewElements().map(element => element.id));
    void this.adoptDefaultDrop(ea, data.excalidrawFile, before).catch((error: unknown) => {
      this.report(error instanceof Error ? error.message : 'Excalidraw の埋め込みをマップに合わせられませんでした。');
    });
  }

  /**
   * Polls until the drop's elements are there and no more arrive in a poll (Excalidraw adds
   * the Markdown images of a multi-file drop one at a time, each after its render), fits
   * them once, and stops: a later drop starts a watcher of its own.
   */
  private async adoptDefaultDrop(ea: ExcalidrawAutomate, drawing: TFile, before: ReadonlySet<string>): Promise<void> {
    const started = Date.now();
    let seen = 0;
    try {
      while (!this.disposed && Date.now() - started < DEFAULT_DROP_TIMEOUT_MS) {
        await new Promise<void>(resolve => { window.setTimeout(resolve, DEFAULT_DROP_POLL_MS); });
        const dropped = this.droppedMaps(ea, drawing, before);
        const count = dropped.embeds.length + dropped.images.length;
        if (count === 0 || count !== seen) { seen = count; continue; }
        await this.fitDefaultDrop(ea, drawing, dropped);
        return;
      }
    } finally {
      ea.clear();
      ea.destroy?.();
    }
  }

  private droppedMaps(ea: ExcalidrawAutomate, drawing: TFile, before: ReadonlySet<string>): DroppedMaps {
    const dropped: DroppedMaps = { embeds: [], images: [] };
    for (const element of ea.getViewElements()) {
      if (before.has(element.id)) continue;
      const target = mappyTarget(this.app, drawing, element);
      if (target) { dropped.embeds.push({ element, file: target }); continue; }
      const source = mappyImageSource(this.app, ea, element);
      if (source) dropped.images.push({ element, file: source });
    }
    return dropped;
  }

  /**
   * One edit for everything the drop created. The maps are painted first (one paint per
   * note, the SVG only for the images; a failure is reported and that element is left as
   * Excalidraw made it), then the embeddables are edited in place and a new image element
   * showing each map's SVG, attached beside the drawing and linked to the note, is added
   * where its Markdown image sits; the Markdown image is removed once the new one is in.
   * The view is read again after the paint: an element moved meanwhile is edited where it
   * is now, one deleted meanwhile is left deleted, and an unloaded plugin changes nothing.
   * An attachment the edit could not use is removed again.
   */
  private async fitDefaultDrop(ea: ExcalidrawAutomate, drawing: TFile, dropped: DroppedMaps): Promise<void> {
    const maps = await this.paintMaps(dropped);
    if (this.disposed) return;
    const current = new Map(ea.getViewElements().map(element => [element.id, element]));
    const still = ({ element, file }: DroppedMap): DroppedMap | null => {
      const now = current.get(element.id);
      return now ? { element: now, file } : null;
    };
    const embeds = dropped.embeds.map(still).filter((item): item is DroppedMap => item !== null);
    const images = dropped.images.map(still).filter((item): item is DroppedMap => item !== null && maps.get(item.file.path)?.svg != null);
    if (!embeds.some(({ element }) => isBordered(element)) && !embeds.some(({ file }) => maps.has(file.path)) && images.length === 0) return;
    ea.clear();
    ea.copyViewElementsToEAforEditing(embeds.map(({ element }) => element));
    for (const { element, file } of embeds) {
      const copy = ea.getElement(element.id);
      if (!copy) continue;
      copy.strokeColor = 'transparent';
      const map = maps.get(file.path);
      if (map) Object.assign(copy, embeddableFrameSize(map.bounds));
    }
    const attachments: TFile[] = [];
    const replaced: { original: ExcalidrawElement; id: string }[] = [];
    try {
      for (const { element, file } of images) {
        const svg = maps.get(file.path)?.svg;
        if (svg == null) continue;
        const attachment = await createSvgAttachment(this.app, file.basename, drawing, svg);
        attachments.push(attachment);
        const id = await ea.addImage(element.x, element.y, attachment, true);
        const image = id ? ea.getElement(id) : null;
        if (!id || !image) {
          this.report(`${file.basename} の画像を Excalidraw に読み込めませんでした。`);
          await this.discard(attachments.pop());
          continue;
        }
        image.link = `[[${this.app.metadataCache.fileToLinktext(file, drawing.path)}]]`;
        replaced.push({ original: element, id });
      }
      if (embeds.length === 0 && replaced.length === 0) return;
      if (!await ea.addElementsToView(false, true, true)) throw new Error('Excalidraw の要素を更新できませんでした。');
    } catch (error: unknown) {
      for (const attachment of attachments) await this.discard(attachment);
      throw error;
    }
    if (replaced.length > 0) {
      if (!ea.deleteViewElements?.(replaced.map(({ original }) => original))) this.report('元の Markdown の画像を消せませんでした。');
      ea.selectElementsInView?.(replaced.map(({ id }) => id));
    }
  }

  /** Removes (as the user's deletion setting says) an attachment this edit created and could not use; a failure to remove it is not worth an error of its own. */
  private async discard(attachment: TFile | undefined): Promise<void> {
    if (!attachment) return;
    try {
      await this.app.fileManager.trashFile(attachment);
    } catch {
      this.report(`使わなかった添付ファイルを消せませんでした: ${attachment.path}`);
    }
  }

  /** Each note painted once, with its SVG only when an image of it is being replaced; a note that cannot be painted is reported and left out. */
  private async paintMaps(dropped: DroppedMaps): Promise<Map<string, PaintedMap>> {
    const maps = new Map<string, PaintedMap>();
    const paint = this.paint;
    if (!paint) return maps;
    const needsSvg = new Set(dropped.images.map(({ file }) => file.path));
    const tried = new Set<string>();
    let stalled = false;
    for (const { file } of [...dropped.embeds, ...dropped.images]) {
      if (tried.has(file.path)) continue;
      tried.add(file.path);
      try {
        const map = await paint(file, { svg: needsSvg.has(file.path) });
        maps.set(file.path, map);
        stalled = stalled || map.stalled;
      } catch (error: unknown) {
        this.report(error instanceof Error ? error.message : `${file.basename} のマップを描けませんでした。`);
      }
      if (this.disposed) break;
    }
    if (stalled && !this.disposed) this.report(DEFAULT_DROP_STALLED_MESSAGE);
    return maps;
  }

  async importFiles(files: TFile[], view: ExcalidrawViewLike, origin: Point): Promise<void> {
    const host = this.automate();
    if (!host) throw new Error('Excalidraw プラグインが見つかりません。');
    const ea = host.getAPI(view);
    try {
      let y = origin[1];
      for (const file of files) {
        const request: ImportRequest = { file, mode: readMapLayout(this.app, file) ?? 'mindmap', collapsed: new Set() };
        const height = await this.render(ea, request, [origin[0], y]);
        y += height + FILE_GAP;
      }
    } finally {
      ea.destroy?.();
    }
  }

  /** Command route: insert into the active drawing, centred on the viewport. */
  async insertIntoActiveDrawing(request: ImportRequest): Promise<void> {
    const host = this.automate();
    if (!host) throw new Error('Excalidraw プラグインが見つかりません。');
    const ea = host.getAPI();
    try {
      if (!ea.setView('active')) throw new Error('Excalidraw の図面を開いてから実行してください。');
      await this.render(ea, request, null);
    } finally {
      ea.destroy?.();
    }
  }

  /** Create at the origin, measure, lay out, then move: sizes come from Excalidraw itself. */
  private async render(ea: ExcalidrawAutomate, request: ImportRequest, origin: Point | null): Promise<number> {
    const { file, mode } = request;
    const document = request.document ?? parseMarkdown(await this.store.read(file), file.basename);
    let { collapsed } = request;
    let calls = request.calls;
    if (!calls) {
      calls = await new CallReader(this.app, this.store).read(document, file.path);
      const split = projectMap(document);
      collapsed = new Set([...collapsed, ...initialCallFolds(projectCalls([split.root, ...split.topics], calls))]);
    }
    const contents = sceneContents(document, collapsed, calls);
    if (contents.nodes.length === 0) throw new Error('マップにするノードがありません。');
    ea.reset();
    const fontFamily = this.drawingFontFamily(ea);
    const drawingPath = ea.targetView?.file?.path ?? file.path;
    const created = new Map<string, CreatedNode>();
    const measures = new Map<string, NodeMeasure>();
    /** Links left out of the drawing because their scheme is not on the allowed list; reported once, not per node. */
    const refused: string[] = [];
    for (const node of contents.nodes) {
      const label = this.addLabel(ea, node, fontFamily, drawingPath, file, refused);
      const images: CreatedBlock[] = [];
      for (const target of node.images) {
        const block = await this.addImage(ea, target, node.sourcePath ?? file.path);
        if (block) images.push(block);
      }
      created.set(node.id, { label, images });
      measures.set(node.id, { label: label.size, images: images.map(image => image.size) });
    }
    const scene = buildScene(contents, measures, mode, collapsed, origin ?? [0, 0]);
    const ids: string[] = [];
    for (const block of scene.blocks) {
      const node = created.get(block.nodeId);
      const target = block.kind === 'label' ? node?.label : node?.images[block.index];
      if (!target) continue;
      for (const id of target.ids) {
        const element = ea.getElement(id);
        if (!element) continue;
        element.x += block.x - target.origin[0];
        element.y += block.y - target.origin[1];
        ids.push(id);
      }
    }
    this.applyStyle(ea, { ...BASE_STYLE, roundness: null });
    for (const line of scene.lines) ids.push(ea.addLine(line));
    ea.addToGroup(ids);
    if (!await ea.addElementsToView(origin === null, true, true)) throw new Error('Excalidraw に要素を追加できませんでした。');
    ea.selectElementsInView?.(ids);
    if (refused.length > 0) {
      this.report(`図面に入れられないリンクを ${refused.length} 件外しました（${[...new Set(refused.map(link => urlScheme(link) ?? link))].join('、')}）。`);
    }
    return scene.bounds.height;
  }

  private addLabel(
    ea: ExcalidrawAutomate, node: SceneNodeContent, fontFamily: number, drawingPath: string, source: TFile, refused: string[],
  ): CreatedBlock {
    const role = ROLE_STYLE[node.role];
    this.applyStyle(ea, {
      ...BASE_STYLE, fontFamily, fontSize: role.fontSize, strokeColor: role.text, backgroundColor: role.fill, roundness: ROUNDED,
    });
    const text = node.text || ' ';
    const id = ea.addText(0, 0, text, role.box
      ? { box: 'box', boxPadding: role.padding, boxStrokeColor: BASE_STYLE.strokeColor ?? '#1e1e1e', textVerticalAlign: 'middle' }
      : undefined);
    const outer = ea.getElement(id);
    const ids = [id];
    if (outer?.boundElements) for (const bound of outer.boundElements) if (bound.type === 'text') ids.push(bound.id);
    const link = this.linkFor(node, drawingPath, source, refused);
    if (link && outer) outer.link = link;
    return {
      ids,
      origin: [outer?.x ?? 0, outer?.y ?? 0],
      size: { width: outer?.width ?? 0, height: outer?.height ?? 0 },
    };
  }

  private async addImage(ea: ExcalidrawAutomate, target: string, sourcePath: string): Promise<CreatedBlock | null> {
    const file = this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
    if (!file || imageMimeType(file.extension) === undefined) return null;
    const id = await ea.addImage(0, 0, file, true);
    const element = id ? ea.getElement(id) : null;
    if (!id || !element) return null;
    const scale = Math.min(1, MAX_IMAGE.width / element.width, MAX_IMAGE.height / element.height);
    element.width = Math.round(element.width * scale);
    element.height = Math.round(element.height * scale);
    return { ids: [id], origin: [element.x, element.y], size: { width: element.width, height: element.height } };
  }

  /**
   * Root boxes link back to the note; other nodes carry their first link, resolved from the note it is written in.
   * A link that already has a scheme travels into the drawing as it was written, so only the schemes on the allowed
   * list are kept (`externalUrl`, LEV-131); a refused one is added to `refused` and the node falls back to what it
   * would carry with no link at all, so a root still links to its note.
   */
  private linkFor(node: SceneNodeContent, drawingPath: string, source: TFile, refused: string[]): string | null {
    if (node.link && !hasUrlScheme(node.link)) {
      const dest = this.app.metadataCache.getFirstLinkpathDest(node.link, node.sourcePath ?? source.path);
      return `[[${dest ? this.app.metadataCache.fileToLinktext(dest, drawingPath) : node.link}]]`;
    }
    if (node.link) {
      const external = externalUrl(node.link);
      if (external) return external;
      refused.push(node.link);
    }
    if (node.role === 'root') return `[[${this.app.metadataCache.fileToLinktext(source, drawingPath)}]]`;
    return null;
  }

  private drawingFontFamily(ea: ExcalidrawAutomate): number {
    const family = ea.getExcalidrawAPI()?.getAppState().currentItemFontFamily;
    return typeof family === 'number' && Number.isFinite(family) ? family : ea.style.fontFamily;
  }

  private applyStyle(ea: ExcalidrawAutomate, style: Partial<ExcalidrawStyle>): void {
    Object.assign(ea.style, style);
  }
}
