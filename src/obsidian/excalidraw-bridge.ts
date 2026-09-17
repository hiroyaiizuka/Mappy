import type { App, TFile } from 'obsidian';
import { IMAGE_EXTENSIONS } from '../core/attachments';
import { parseMarkdown, type MindDocument } from '../core/markdown';
import {
  buildScene, sceneContents, type MapMode, type NodeMeasure, type NodeRole, type SceneNodeContent,
} from '../export/excalidraw-scene';
import type { NodeSize } from '../layout/layout';
import type { Point } from '../layout/path-points';
import type {
  ExcalidrawAutomate, ExcalidrawDropData, ExcalidrawDropHook, ExcalidrawElement, ExcalidrawStyle, ExcalidrawViewLike,
} from '../types/excalidraw-automate';
import type { DocumentStore } from './document-store';
import { readMapLayout } from './frontmatter';

export interface ImportRequest {
  file: TFile;
  mode: MapMode;
  /** Node IDs of `document`; a fresh parse assigns new IDs, so pass the document they belong to. */
  collapsed: ReadonlySet<string>;
  document?: MindDocument;
}

const IMAGE_EXTENSIONS_SET = new Set<string>(IMAGE_EXTENSIONS);
const EXTERNAL_LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'obsidian']);

export function externalLink(link: string): string | null {
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(link)?.[1]?.toLowerCase();
  if (!scheme) return null;
  return EXTERNAL_LINK_SCHEMES.has(scheme) ? link : null;
}

/** The map view caps attachment previews; the drawing keeps the same proportions. */
const MAX_IMAGE = { width: 240, height: 140 };
const FILE_GAP = 40;
const ROUNDED = { type: 3 };
const DEFAULT_DROP_POLL_MS = 200;
const DEFAULT_DROP_TIMEOUT_MS = 60_000;

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

function wikiLinkPath(link: string | null | undefined): string | null {
  if (!link) return null;
  const value = /^\[\[([\s\S]+)\]\]$/u.exec(link.trim())?.[1] ?? link.trim();
  const path = value.split('|', 1)[0]?.split('#', 1)[0]?.split('^', 1)[0]?.trim();
  return path || null;
}

function mappyTarget(app: App, drawing: TFile, element: ExcalidrawElement): TFile | null {
  if (element.type !== 'embeddable') return null;
  const path = wikiLinkPath(element.link);
  if (!path) return null;
  const target = app.metadataCache.getFirstLinkpathDest(path, drawing.path);
  return target && readMapLayout(app, target) !== null ? target : null;
}

/** Excalidraw stores the visible outer frame as the embeddable element's stroke. */
export function findBorderedMappyEmbeddables(
  app: App, drawing: TFile, elements: readonly ExcalidrawElement[],
): ExcalidrawElement[] {
  return elements.filter(element => element.strokeColor !== 'transparent' && mappyTarget(app, drawing, element) !== null);
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
   * Excalidraw's built-in "as embeddable / as image" flow completes after its
   * modal closes. Observe only the newly-created element, then persist a
   * transparent stroke through EA's identity-preserving edit workflow.
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
    void this.removeDefaultDropBorder(ea, data.excalidrawFile, before).catch((error: unknown) => {
      this.report(error instanceof Error ? error.message : 'Excalidraw の埋め込み枠を消せませんでした。');
    });
  }

  private async removeDefaultDropBorder(
    ea: ExcalidrawAutomate, drawing: TFile, before: ReadonlySet<string>,
  ): Promise<void> {
    const started = Date.now();
    try {
      while (!this.disposed && Date.now() - started < DEFAULT_DROP_TIMEOUT_MS) {
        await new Promise<void>(resolve => { window.setTimeout(resolve, DEFAULT_DROP_POLL_MS); });
        const created = ea.getViewElements().filter(element => !before.has(element.id));
        const mappy = created.filter(element => mappyTarget(this.app, drawing, element) !== null);
        if (mappy.length === 0) continue;
        const bordered = findBorderedMappyEmbeddables(this.app, drawing, mappy);
        if (bordered.length === 0) return;
        ea.clear();
        ea.copyViewElementsToEAforEditing(bordered);
        for (const element of bordered) {
          const copy = ea.getElement(element.id);
          if (copy) copy.strokeColor = 'transparent';
        }
        await ea.addElementsToView(false, true, false);
        return;
      }
    } finally {
      ea.clear();
      ea.destroy?.();
    }
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
    const { file, mode, collapsed } = request;
    const document = request.document ?? parseMarkdown(await this.store.read(file), file.basename);
    const contents = sceneContents(document, collapsed);
    if (contents.nodes.length === 0) throw new Error('マップにするノードがありません。');
    ea.reset();
    const fontFamily = this.drawingFontFamily(ea);
    const drawingPath = ea.targetView?.file?.path ?? file.path;
    const created = new Map<string, CreatedNode>();
    const measures = new Map<string, NodeMeasure>();
    for (const node of contents.nodes) {
      const label = this.addLabel(ea, node, fontFamily, drawingPath, file);
      const images: CreatedBlock[] = [];
      for (const target of node.images) {
        const block = await this.addImage(ea, target, file);
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
    return scene.bounds.height;
  }

  private addLabel(
    ea: ExcalidrawAutomate, node: SceneNodeContent, fontFamily: number, drawingPath: string, source: TFile,
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
    const link = this.linkFor(node, drawingPath, source);
    if (link && outer) outer.link = link;
    return {
      ids,
      origin: [outer?.x ?? 0, outer?.y ?? 0],
      size: { width: outer?.width ?? 0, height: outer?.height ?? 0 },
    };
  }

  private async addImage(ea: ExcalidrawAutomate, target: string, source: TFile): Promise<CreatedBlock | null> {
    const file = this.app.metadataCache.getFirstLinkpathDest(target, source.path);
    if (!file || !IMAGE_EXTENSIONS_SET.has(file.extension.toLowerCase())) return null;
    const id = await ea.addImage(0, 0, file, true);
    const element = id ? ea.getElement(id) : null;
    if (!id || !element) return null;
    const scale = Math.min(1, MAX_IMAGE.width / element.width, MAX_IMAGE.height / element.height);
    element.width = Math.round(element.width * scale);
    element.height = Math.round(element.height * scale);
    return { ids: [id], origin: [element.x, element.y], size: { width: element.width, height: element.height } };
  }

  /** Root boxes link back to the note; other nodes carry their first link, resolved from the note. */
  private linkFor(node: SceneNodeContent, drawingPath: string, source: TFile): string | null {
    if (node.link) {
      if (/^[a-z][a-z0-9+.-]*:/iu.test(node.link)) return externalLink(node.link);
      const dest = this.app.metadataCache.getFirstLinkpathDest(node.link, source.path);
      return `[[${dest ? this.app.metadataCache.fileToLinktext(dest, drawingPath) : node.link}]]`;
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
