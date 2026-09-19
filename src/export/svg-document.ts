import type { LayoutBounds, NodeSize } from '../layout/primitives';

/**
 * SVG export (§5 M13), the part that never touches a DOM: a scene of already
 * serialized node markup, connector paths and fold badges becomes one SVG
 * document. `svg-capture.ts` builds the scene from the map view's elements.
 */

export type ExportTheme = 'light' | 'dark';

/** One visible node: its layout box and its XHTML, ready to sit inside a `foreignObject`. */
export interface SvgNode extends LayoutBounds {
  id: string;
  html: string;
}

export interface SvgEdge {
  /** The `d` attribute the map view draws, unchanged. */
  path: string;
}

/** The hidden-descendant count of a collapsed node, drawn as a pill at the fold position. */
export interface SvgBadge extends LayoutBounds {
  text: string;
}

export interface SvgScene {
  theme: ExportTheme;
  /** Fill behind everything, the canvas colour of the current theme. */
  background: string;
  /** Body, free topics and fold controls, as the map view fits them. */
  bounds: LayoutBounds;
  nodes: SvgNode[];
  edges: SvgEdge[];
  badges: SvgBadge[];
  /** Rules the node markup and the badges reference; plain CSS text. */
  css: string;
}

export interface SvgSize extends NodeSize {
  viewBox: string;
}

/** Breathing room around the fitted bounds, in layout px. */
export const EXPORT_MARGIN = 24;

export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
export const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

export function escapeText(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

export function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/gu, '&quot;');
}

/** Layout numbers are kept to two decimals so the file stays readable and stable across runs. */
export function formatNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/u, '');
}

/** Width, height and viewBox of the document: the fitted bounds plus a margin, never smaller than a pixel. */
export function svgSize(bounds: LayoutBounds, margin = EXPORT_MARGIN): SvgSize {
  const width = Math.max(1, Math.ceil(bounds.width + margin * 2));
  const height = Math.max(1, Math.ceil(bounds.height + margin * 2));
  const x = bounds.x - margin;
  const y = bounds.y - margin;
  return { width, height, viewBox: `${formatNumber(x)} ${formatNumber(y)} ${width} ${height}` };
}

export interface PngScaleLimits {
  /** The scale the user would like (device pixel ratio, or 2 for print-like output). */
  preferred: number;
  /** Canvas area the host can allocate; a 2,000-node map is scaled down to fit rather than refused. */
  maxPixels: number;
  /** Longest side a canvas may have. */
  maxSide: number;
}

/** Desktop Chromium draws large canvases; 8,192² pixels is 256 MB of RGBA and still well inside its area cap. */
export const DESKTOP_PNG_LIMITS: PngScaleLimits = { preferred: 2, maxPixels: 8192 * 8192, maxSide: 16384 };
/** WebKit on phones refuses canvases past roughly 16 megapixels. */
export const MOBILE_PNG_LIMITS: PngScaleLimits = { preferred: 2, maxPixels: 4096 * 4096, maxSide: 4096 };

/** The raster scale that keeps the canvas within the host's limits; always positive. */
export function pngScale(size: NodeSize, limits: PngScaleLimits): number {
  const area = Math.max(1, size.width * size.height);
  const side = Math.max(1, size.width, size.height);
  const scale = Math.min(limits.preferred, Math.sqrt(limits.maxPixels / area), limits.maxSide / side);
  return Math.max(scale, 1e-3);
}

/**
 * Computed styles repeat across nodes of the same role, so each distinct
 * declaration list becomes one class. The registry is text in, text out:
 * the capture decides what to declare, the document only names it.
 */
export class StyleRegistry {
  private readonly classes = new Map<string, string>();

  constructor(private readonly prefix = 'm') {}

  /** The class carrying exactly these declarations (`prop:value;…`); empty declarations get no class. */
  classFor(declarations: string): string | null {
    if (!declarations) return null;
    let name = this.classes.get(declarations);
    if (!name) {
      name = `${this.prefix}${this.classes.size}`;
      this.classes.set(declarations, name);
    }
    return name;
  }

  get size(): number { return this.classes.size; }

  css(): string {
    return Array.from(this.classes, ([declarations, name]) => `.${name}{${declarations}}`).join('\n');
  }
}

/** The stylesheet must not end the CDATA section early; `]]>` cannot occur in CSS we generate, but the data is untrusted. */
function cdata(text: string): string {
  return `<![CDATA[\n${text.replace(/\]\]>/gu, ']]]]><![CDATA[>')}\n]]>`;
}

function rect(bounds: LayoutBounds, extra: string): string {
  return `<rect x="${formatNumber(bounds.x)}" y="${formatNumber(bounds.y)}" width="${formatNumber(bounds.width)}" height="${formatNumber(bounds.height)}" ${extra}/>`;
}

/**
 * One standalone SVG: background, connectors, the nodes as `foreignObject`
 * elements at their layout positions and the fold badges. Nodes come after
 * the edges so text sits above the lines, as on the map.
 */
export function buildSvg(scene: SvgScene, margin = EXPORT_MARGIN): string {
  const size = svgSize(scene.bounds, margin);
  const lines: string[] = [];
  lines.push(`<svg xmlns="${SVG_NAMESPACE}" width="${size.width}" height="${size.height}" viewBox="${size.viewBox}" class="mappy-export theme-${scene.theme}" data-theme="${scene.theme}" data-nodes="${scene.nodes.length}" data-edges="${scene.edges.length}">`);
  lines.push(`<style>${cdata(scene.css)}</style>`);
  const box = { x: scene.bounds.x - margin, y: scene.bounds.y - margin, width: size.width, height: size.height };
  lines.push(rect(box, `class="mappy-export-background" fill="${escapeAttribute(scene.background)}"`));
  lines.push('<g class="mappy-edges">');
  for (const edge of scene.edges) lines.push(`<path d="${escapeAttribute(edge.path)}"/>`);
  lines.push('</g>');
  lines.push('<g class="mappy-nodes">');
  for (const node of scene.nodes) {
    lines.push(`<foreignObject data-node-id="${escapeAttribute(node.id)}" x="${formatNumber(node.x)}" y="${formatNumber(node.y)}" width="${formatNumber(node.width)}" height="${formatNumber(node.height)}" overflow="visible">${node.html}</foreignObject>`);
  }
  lines.push('</g>');
  if (scene.badges.length > 0) {
    lines.push('<g class="mappy-folds">');
    for (const badge of scene.badges) {
      const radius = formatNumber(badge.height / 2);
      lines.push('<g class="mappy-fold">');
      lines.push(rect(badge, `rx="${radius}" ry="${radius}" class="mappy-fold-pill"`));
      lines.push(`<text x="${formatNumber(badge.x + badge.width / 2)}" y="${formatNumber(badge.y + badge.height / 2)}" text-anchor="middle" dominant-baseline="central" class="mappy-fold-text">${escapeText(badge.text)}</text>`);
      lines.push('</g>');
    }
    lines.push('</g>');
  }
  lines.push('</svg>');
  return `${lines.join('\n')}\n`;
}
