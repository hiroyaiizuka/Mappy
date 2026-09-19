import { PLACEHOLDER_ID } from '../layout/drop-preview';
import type { LayoutResult } from '../layout/layout';
import { foldBadgeWidth } from '../layout/primitives';
import {
  StyleRegistry, SVG_NAMESPACE, XHTML_NAMESPACE, XLINK_NAMESPACE, escapeAttribute, escapeText, formatNumber,
  type ExportTheme, type SvgBadge, type SvgEdge, type SvgNode, type SvgScene,
} from './svg-document';

/**
 * The DOM half of the SVG export (§5 M13): the map view's node elements, laid
 * out where the last frame placed them, become XHTML inside `foreignObject`
 * with their computed styles inlined, so the file looks like the screen in
 * the current theme without Obsidian's stylesheets. Images become data URLs
 * through a resolver the host supplies; a resolver that fails leaves the
 * node in place with the image's text. Nothing here reads Obsidian.
 *
 * The DOM is read in one synchronous pass, so a refresh that lands while the
 * images are being read cannot change what the file shows.
 */

export interface CapturedEntry {
  element: HTMLElement;
  /** The fold control's mark: its text is the hidden-descendant count once collapsed. */
  toggleMark: HTMLElement;
}

export interface CaptureSource {
  /** The layout the nodes on screen were placed with. */
  layout: LayoutResult;
  entries: ReadonlyMap<string, CapturedEntry>;
  /** The map canvas: its background is the theme's, and its document resolves computed styles. */
  canvas: HTMLElement;
  /** The connector layer; its first path gives the stroke. */
  edges: SVGSVGElement;
}

/** A data URL for the image, or null when it cannot be read; the node is kept either way. */
export type ImageResolver = (image: HTMLImageElement) => Promise<string | null>;

export interface CaptureOptions {
  resolveImage: ImageResolver;
  /** Defaults to the document's `theme-dark` body class, Obsidian's convention. */
  theme?: ExportTheme;
}

/** Computed properties copied onto every exported element; anything else falls back to the viewer's defaults. */
const STYLE_PROPERTIES: readonly string[] = [
  'display', 'box-sizing',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'background-color', 'min-width', 'min-height', 'max-width', 'max-height',
  'overflow', 'overflow-wrap', 'word-break', 'white-space', 'text-overflow', 'vertical-align', 'object-fit',
  'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'align-items', 'justify-content', 'row-gap', 'column-gap',
  'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
  'text-align', 'text-decoration-line', 'text-decoration-style', 'text-decoration-color',
  'font-variant-numeric', 'text-transform',
];

/** Values that equal the initial value are left out; the viewer supplies them. */
const INITIAL_VALUES: Readonly<Record<string, readonly string[]>> = {
  'padding-top': ['0px'], 'padding-right': ['0px'], 'padding-bottom': ['0px'], 'padding-left': ['0px'],
  'margin-top': ['0px'], 'margin-right': ['0px'], 'margin-bottom': ['0px'], 'margin-left': ['0px'],
  'border-top-width': ['0px'], 'border-right-width': ['0px'], 'border-bottom-width': ['0px'], 'border-left-width': ['0px'],
  'border-top-style': ['none'], 'border-right-style': ['none'], 'border-bottom-style': ['none'], 'border-left-style': ['none'],
  'border-top-left-radius': ['0px'], 'border-top-right-radius': ['0px'], 'border-bottom-right-radius': ['0px'], 'border-bottom-left-radius': ['0px'],
  'background-color': ['rgba(0, 0, 0, 0)', 'transparent'],
  'min-width': ['0px', 'auto'], 'min-height': ['0px', 'auto'], 'max-width': ['none'], 'max-height': ['none'],
  overflow: ['visible'], 'overflow-wrap': ['normal'], 'word-break': ['normal'], 'white-space': ['normal'],
  'text-overflow': ['clip'], 'vertical-align': ['baseline'], 'object-fit': ['fill'],
  'flex-direction': ['row'], 'flex-wrap': ['nowrap'], 'flex-grow': ['0'], 'flex-shrink': ['1'],
  'align-items': ['normal'], 'justify-content': ['normal'], 'row-gap': ['normal'], 'column-gap': ['normal'],
  'font-style': ['normal'], 'letter-spacing': ['normal'], 'text-align': ['start'],
  'text-decoration-line': ['none'], 'text-decoration-style': ['solid'],
  'font-variant-numeric': ['normal'], 'text-transform': ['none'],
};

/** A border's colour matters only while it has a width. */
const BORDER_SIDES = ['top', 'right', 'bottom', 'left'] as const;

/** Interaction state on the screen that has no place in a file. */
const STATE_CLASSES = new Set(['is-selected', 'is-drag-source', 'is-drag-moving', 'is-merging', 'is-editing', 'is-drop-target']);

/** Attributes carried over from the node markup; everything else (handlers, ARIA, tabindex, inline style) is dropped. */
const KEPT_ATTRIBUTES = new Set(['href', 'alt', 'title', 'width', 'height', 'dir', 'lang', 'data-href', 'data-node-id']);

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Elements that cannot be shown in a file, or that belong to editing and dragging. */
const SKIPPED_SELECTOR = 'script,style,template,iframe,video,audio,canvas,object,embed,input,textarea,select,button,.mappy-node-toggle,.mappy-inline-input,.mappy-inline-error';

/** Namespace prefixes the document declares; any other prefixed attribute would leave the file ill-formed. */
const DECLARED_PREFIXES = new Set(['xlink', 'xml', 'xmlns']);

/** The badge on screen is this tall unless the theme says otherwise (`.mappy-node-toggle-mark`). */
const DEFAULT_BADGE_HEIGHT = 18;

function themeOf(document: Document): ExportTheme {
  return document.body.classList.contains('theme-dark') ? 'dark' : 'light';
}

function computed(element: Element): CSSStyleDeclaration | null {
  const view = element.ownerDocument.defaultView;
  return view ? view.getComputedStyle(element) : null;
}

/**
 * The declarations of one element as `prop:value;…`, without initial values and
 * without geometry. One computed-style object per element: the read is what costs.
 */
export function styleDeclarations(element: Element, style: CSSStyleDeclaration | null = computed(element)): string {
  if (!style) return '';
  const values = new Map<string, string>();
  for (const property of STYLE_PROPERTIES) {
    const value = style.getPropertyValue(property).trim();
    if (!value || INITIAL_VALUES[property]?.includes(value)) continue;
    values.set(property, value);
  }
  for (const side of BORDER_SIDES) {
    if (!values.has(`border-${side}-width`) || !values.has(`border-${side}-style`)) {
      values.delete(`border-${side}-width`);
      values.delete(`border-${side}-style`);
      values.delete(`border-${side}-color`);
    }
  }
  return Array.from(values, ([property, value]) => `${property}:${value}`).join(';');
}

function isHidden(element: Element, style: CSSStyleDeclaration | null): boolean {
  return element.hasAttribute('hidden') || style?.getPropertyValue('display').trim() === 'none';
}

function exportedClasses(element: Element, styleClass: string | null, extra?: string): string {
  const classes = Array.from(element.classList).filter(name => !STATE_CLASSES.has(name));
  if (styleClass) classes.push(styleClass);
  if (extra) classes.push(extra);
  return classes.join(' ');
}

/** `[a-zA-Z_:][-a-zA-Z0-9_:.]*` is what XML accepts; DOM attribute names can be anything. */
function isXmlName(name: string): boolean {
  return /^[A-Za-z_:][-A-Za-z0-9_:.]*$/u.test(name);
}

/** A prefixed name is only written when the prefix is declared on the export's root. */
function isWritableAttributeName(name: string): boolean {
  if (!isXmlName(name)) return false;
  const colon = name.indexOf(':');
  return colon === -1 || DECLARED_PREFIXES.has(name.slice(0, colon));
}

/** The vault-side identity of an image: the embed's link target when Obsidian rendered it, else the URL it shows. */
function imageKey(image: HTMLImageElement): string {
  const embed = image.closest('.internal-embed');
  const target = embed?.getAttribute('src');
  return target ? `embed:${target}` : `src:${image.currentSrc || image.src || image.getAttribute('src') || ''}`;
}

/** Layout size of a rendered element in CSS px; the world transform does not affect offset sizes. */
function boxOf(element: HTMLElement): { width: number; height: number } {
  return { width: element.offsetWidth, height: element.offsetHeight };
}

/**
 * An image met while serializing: the markup is finished later, once its data URL
 * is known, from what was read now. The token never collides with content because
 * escaping strips control characters.
 */
interface PendingImage {
  token: string;
  image: HTMLImageElement;
  present: (src: string) => string;
  missing: string;
}

interface Serializer {
  registry: StyleRegistry;
  images: PendingImage[];
}

function serializeAttributes(element: Element, names: Iterable<string>, extra: Record<string, string | null>): string {
  const parts: string[] = [];
  const written = new Set<string>();
  for (const [name, value] of Object.entries(extra)) {
    written.add(name);
    if (value !== null && value !== '') parts.push(` ${name}="${escapeAttribute(value)}"`);
  }
  for (const name of names) {
    if (written.has(name) || !isWritableAttributeName(name)) continue;
    const value = element.getAttribute(name);
    if (value !== null) parts.push(` ${name}="${escapeAttribute(value)}"`);
  }
  return parts.join('');
}

function serializeChildren(element: Element, context: Serializer): string {
  let html = '';
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) html += escapeText(child.textContent ?? '');
    else if (child.nodeType === Node.ELEMENT_NODE) html += serializeElement(child as Element, context, false);
  }
  return html;
}

/**
 * Both outcomes of an image are prepared now: the `<img>` with its data URL, or a
 * `<span>` of the same size showing its text when the resolver cannot read it, so
 * the node it sits in stays whole either way.
 */
function serializeImage(image: HTMLImageElement, context: Serializer, style: CSSStyleDeclaration | null): string {
  const size = boxOf(image);
  const geometry = size.width > 0 && size.height > 0 ? `width:${size.width}px;height:${size.height}px` : null;
  const declarations = styleDeclarations(image, style);
  const imageClass = exportedClasses(image, context.registry.classFor(declarations));
  const spanDeclarations = [declarations, 'display:inline-block;overflow:hidden'].filter(Boolean).join(';');
  const spanClass = exportedClasses(image, context.registry.classFor(spanDeclarations), 'mappy-export-missing-image');
  const token = `image${context.images.length}`;
  context.images.push({
    token, image,
    present: src => `<img${serializeAttributes(image, KEPT_ATTRIBUTES, { class: imageClass, src, style: geometry })}/>`,
    missing: `<span${serializeAttributes(image, ['title'], { class: spanClass, style: geometry })}>${escapeText(image.alt || image.getAttribute('src') || '')}</span>`,
  });
  return token;
}

/**
 * A map drawn inside a node (§5 M12) is not drawn as a map in the file (LEV-73): its nodes
 * sit on inline transforms the style whitelist leaves out, so the frame is exported as a box
 * of the same size that names the map, the way an unreadable image keeps its place.
 */
function serializeFrame(frame: Element, context: Serializer, style: CSSStyleDeclaration | null): string {
  const size = boxOf(frame as HTMLElement);
  const declarations = [styleDeclarations(frame, style), 'display:flex;align-items:center;justify-content:center;overflow:hidden;text-align:center'].filter(Boolean).join(';');
  const frameClass = exportedClasses(frame, context.registry.classFor(declarations), 'mappy-export-embed');
  const geometry = size.width > 0 && size.height > 0 ? `width:${size.width}px;height:${size.height}px` : null;
  return `<div${serializeAttributes(frame, ['title'], { class: frameClass, style: geometry })}>${escapeText(frame.getAttribute('aria-label') ?? '')}</div>`;
}

function serializeElement(element: Element, context: Serializer, root: boolean, geometry?: { width: number; height: number }): string {
  if (element.matches(SKIPPED_SELECTOR)) return '';
  const style = computed(element);
  if (isHidden(element, style)) return '';
  if (!root && element.classList.contains('mappy-embed')) return serializeFrame(element, context, style);
  if (element.namespaceURI === SVG_NAMESPACE) {
    // Inline SVG (icons a renderer may add) keeps its own attributes; it is already XML.
    const parent = element.parentElement;
    const xmlns = parent && parent.namespaceURI !== SVG_NAMESPACE ? { xmlns: SVG_NAMESPACE, 'xmlns:xlink': XLINK_NAMESPACE } : {};
    const tag = element.localName;
    const attributes = serializeAttributes(element, Array.from(element.attributes, attribute => attribute.name), xmlns);
    return `<${tag}${attributes}>${serializeChildren(element, context)}</${tag}>`;
  }
  const tag = element.localName;
  // `localName`, not `instanceof`: a node in a popout window belongs to another window's classes.
  if (tag === 'img') return serializeImage(element as HTMLImageElement, context, style);
  if (!isXmlName(tag)) return '';
  const styleClass = context.registry.classFor(styleDeclarations(element, style));
  const extra: Record<string, string | null> = {
    ...(root ? { xmlns: XHTML_NAMESPACE } : {}),
    class: exportedClasses(element, styleClass),
    style: geometry ? `width:${formatNumber(geometry.width)}px;height:${formatNumber(geometry.height)}px` : null,
  };
  const attributes = serializeAttributes(element, KEPT_ATTRIBUTES, extra);
  if (VOID_ELEMENTS.has(tag)) return `<${tag}${attributes}/>`;
  return `<${tag}${attributes}>${serializeChildren(element, context)}</${tag}>`;
}

/** Every image the serialization met, resolved once per source through the host's resolver. */
async function resolveImages(pending: readonly PendingImage[], resolve: ImageResolver): Promise<Map<string, string | null>> {
  const bySource = new Map<string, Promise<string | null>>();
  const results = new Map<string, string | null>();
  await Promise.all(pending.map(async entry => {
    const key = imageKey(entry.image);
    let request = bySource.get(key);
    if (!request) {
      request = resolve(entry.image).catch(() => null);
      bySource.set(key, request);
    }
    results.set(entry.token, await request);
  }));
  return results;
}

/** Text colour of the canvas: what `currentColor` connectors and fallbacks resolve to. */
function canvasColor(canvas: HTMLElement, theme: ExportTheme): string {
  const color = computed(canvas)?.getPropertyValue('color').trim();
  return color || (theme === 'dark' ? '#dcddde' : '#222222');
}

function backgroundOf(canvas: HTMLElement, theme: ExportTheme): string {
  const color = computed(canvas)?.getPropertyValue('background-color').trim();
  return color && !INITIAL_VALUES['background-color']?.includes(color) ? color : theme === 'dark' ? '#1e1e1e' : '#ffffff';
}

function edgeCss(edges: SVGSVGElement, fallbackColor: string): string {
  const path = edges.querySelector('path:not(.is-preview)');
  const style = path ? computed(path) : null;
  const read = (property: string, fallback: string): string => {
    const value = style?.getPropertyValue(property).trim();
    return value || fallback;
  };
  let stroke = read('stroke', 'currentcolor');
  if (stroke.toLowerCase() === 'currentcolor') stroke = read('color', fallbackColor);
  return `.mappy-edges path{fill:none;stroke:${stroke};stroke-width:${read('stroke-width', '1.5px')};stroke-linecap:${read('stroke-linecap', 'round')};stroke-linejoin:${read('stroke-linejoin', 'round')}}`;
}

function badgeCss(mark: HTMLElement | undefined, fallbackColor: string, background: string): string {
  const style = mark ? computed(mark) : null;
  const read = (property: string, fallback: string): string => {
    const value = style?.getPropertyValue(property).trim();
    return value && !INITIAL_VALUES[property]?.includes(value) ? value : fallback;
  };
  const color = read('color', fallbackColor);
  const font = read('font-family', 'sans-serif');
  return [
    `.mappy-fold-pill{fill:${read('background-color', background)};stroke:${read('border-top-color', color)};stroke-width:1px}`,
    `.mappy-fold-text{fill:${color};font-family:${font};font-size:${read('font-size', '11px')};font-weight:${read('font-weight', '400')}}`,
  ].join('\n');
}

/**
 * The scene of what is on screen: one `SvgNode` per placed node in layout
 * order, the connectors' path data, and a badge for every collapsed node.
 * Layout coordinates are kept, so the SVG's viewBox is the map's own space.
 * Everything is read from the DOM before the first `await`; only the image
 * bytes are fetched afterwards and spliced into the markup already built.
 */
export async function captureScene(source: CaptureSource, options: CaptureOptions): Promise<SvgScene> {
  const document = source.canvas.ownerDocument;
  const theme = options.theme ?? themeOf(document);
  const registry = new StyleRegistry();
  const context: Serializer = { registry, images: [] };
  const drafts: SvgNode[] = [];
  for (const node of source.layout.nodes) {
    if (node.id === PLACEHOLDER_ID) continue;
    const entry = source.entries.get(node.id);
    if (!entry) continue;
    const html = serializeElement(entry.element, context, true, { width: node.width, height: node.height });
    if (html) drafts.push({ id: node.id, x: node.x, y: node.y, width: node.width, height: node.height, html });
  }
  const edges: SvgEdge[] = source.layout.edges
    .filter(edge => edge.to !== PLACEHOLDER_ID && edge.from !== PLACEHOLDER_ID)
    .map(edge => ({ path: edge.path }));
  const badges: SvgBadge[] = [];
  let mark: HTMLElement | undefined;
  for (const fold of source.layout.folds) {
    const entry = source.entries.get(fold.id);
    if (!entry || !entry.element.classList.contains('is-collapsed')) continue;
    const text = entry.toggleMark.textContent?.trim() ?? '';
    if (!text) continue;
    mark ??= entry.toggleMark;
    const width = foldBadgeWidth(Number(text) || 0);
    const height = entry.toggleMark.offsetHeight || DEFAULT_BADGE_HEIGHT;
    badges.push({ x: fold.x - width / 2, y: fold.y - height / 2, width, height, text });
  }
  const color = canvasColor(source.canvas, theme);
  const background = backgroundOf(source.canvas, theme);
  const css = [registry.css(), edgeCss(source.edges, color), ...(badges.length > 0 ? [badgeCss(mark, color, background)] : [])]
    .filter(Boolean).join('\n');
  // The DOM has been read; from here on only the image bytes are awaited.
  const resolved = await resolveImages(context.images, options.resolveImage);
  const nodes = drafts.map(draft => {
    let html = draft.html;
    for (const entry of context.images) {
      if (!html.includes(entry.token)) continue;
      const src = resolved.get(entry.token) ?? null;
      html = html.replace(entry.token, src === null ? entry.missing : entry.present(src));
    }
    return { ...draft, html };
  });
  return { theme, background, bounds: { ...source.layout.bounds }, nodes, edges, badges, css };
}

/** True when this window can draw into a 2D canvas; jsdom and some embedded hosts cannot. */
export function canRasterize(): boolean {
  try {
    return createEl('canvas').getContext('2d') !== null;
  } catch {
    return false;
  }
}

/** The message every PNG failure of the host surfaces; the SVG route always remains. */
export const PNG_UNAVAILABLE = 'この環境では PNG を作れません。SVG で書き出してください。';

/** Width and height of the raster in device pixels. */
export interface RasterSize {
  width: number;
  height: number;
}

export function rasterSize(size: { width: number; height: number }, scale: number): RasterSize {
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

export interface RasterizedPng extends RasterSize {
  blob: Blob;
}

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  const image = createEl('img');
  return new Promise<HTMLImageElement>((resolve, reject) => {
    image.addEventListener('load', () => { resolve(image); }, { once: true });
    image.addEventListener('error', () => { reject(new Error('SVG を画像として読み込めませんでした。')); }, { once: true });
    // A data URL, not a blob URL: a blob made by a page with an opaque origin (`file://`) is cross-origin to itself and taints the canvas.
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

function drawToCanvas(image: HTMLImageElement, size: { width: number; height: number }, scale: number): HTMLCanvasElement {
  const canvas = createEl('canvas');
  const raster = rasterSize(size, scale);
  canvas.width = raster.width;
  canvas.height = raster.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error(PNG_UNAVAILABLE);
  context.scale(scale, scale);
  context.drawImage(image, 0, 0, size.width, size.height);
  return canvas;
}

/**
 * WebKit treats an SVG image containing `foreignObject` as tainting; reading the canvas
 * back then throws a SecurityError. A DOMException is not an `Error` in every realm.
 */
function isTaint(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  return name === 'SecurityError' || (typeof message === 'string' && /taint|insecure/iu.test(message));
}

let foreignObjectProbe: Promise<boolean> | undefined;

/**
 * Whether this host can read back a canvas that an SVG with `foreignObject` was
 * drawn into: Chromium can, WebKit (Obsidian on iOS) cannot. Probed once with a
 * one-pixel document, so the modal offers PNG only where it will work.
 */
export function canRasterizeForeignObject(): Promise<boolean> {
  foreignObjectProbe ??= (async () => {
    if (!canRasterize()) return false;
    try {
      const svg = `<svg xmlns="${SVG_NAMESPACE}" width="1" height="1"><foreignObject width="1" height="1"><div xmlns="${XHTML_NAMESPACE}"></div></foreignObject></svg>`;
      const canvas = drawToCanvas(await loadSvgImage(svg), { width: 1, height: 1 }, 1);
      return canvas.toDataURL('image/png').startsWith('data:image/png');
    } catch {
      return false;
    }
  })();
  return foreignObjectProbe;
}

/**
 * The SVG drawn onto a canvas at `scale` and encoded as PNG. The SVG is
 * loaded as an image, so it can only use what it embeds: data URL images and
 * fonts installed on this device. Web fonts of the app are not available to it.
 * The scratch image and canvas come from Obsidian's global `createEl`, never attached.
 */
export async function rasterizeSvg(svg: string, size: { width: number; height: number }, scale: number): Promise<RasterizedPng> {
  const image = await loadSvgImage(svg);
  try {
    const canvas = drawToCanvas(image, size, scale);
    const blob = await new Promise<Blob | null>(resolve => { canvas.toBlob(resolve, 'image/png'); });
    if (!blob) throw new Error('PNG を生成できませんでした。');
    return { blob, width: canvas.width, height: canvas.height };
  } catch (error) {
    if (isTaint(error)) throw new Error(PNG_UNAVAILABLE);
    throw error;
  }
}
