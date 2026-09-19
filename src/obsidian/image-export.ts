import { Platform, arrayBufferToBase64, requestUrl, type App, type TFile } from 'obsidian';
import { canRasterize, captureScene, rasterizeSvg, type CaptureSource, type ImageResolver } from '../export/svg-capture';
import {
  DESKTOP_PNG_LIMITS, MOBILE_PNG_LIMITS, buildSvg, pngScale, svgSize, type ExportTheme, type PngScaleLimits,
} from '../export/svg-document';

/**
 * SVG／PNG export into the vault (§5 M13): the map view's scene is captured,
 * images are read from the vault as data URLs, and the file is created where
 * Obsidian's attachment setting points. The note itself is never written.
 */

export type ExportFormat = 'svg' | 'png';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['svg', 'png'];

const IMAGE_MIME: Readonly<Record<string, string>> = {
  avif: 'image/avif', bmp: 'image/bmp', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp',
};

/** Canvas limits the raster must respect; WebKit on mobile allows far less than desktop Chromium. */
export function pixelLimits(mobile = Platform.isMobile): PngScaleLimits {
  return mobile ? MOBILE_PNG_LIMITS : DESKTOP_PNG_LIMITS;
}

/** Whether this host can name and create attachments; the command is offered only then. */
export function canSaveAttachments(app: App): boolean {
  return typeof app.fileManager.getAvailablePathForAttachment === 'function'
    && typeof app.vault.create === 'function' && typeof app.vault.createBinary === 'function';
}

/** `[[figure.png|120]]` / `figure.png#^id` → `figure.png`. */
function linkpathOf(target: string): string | null {
  const trimmed = target.trim();
  const inner = trimmed.match(/^!?\[\[([\s\S]+)\]\]$/u)?.[1] ?? trimmed;
  const path = inner.split('|', 1)[0]?.split('#', 1)[0]?.trim() ?? '';
  return path || null;
}

function hasScheme(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/iu.test(url);
}

/** Bytes and media type of a remote image. */
export interface FetchedImage {
  buffer: ArrayBuffer;
  mime: string;
}

/** `requestUrl` is Obsidian's own client: no CORS, and the same call on desktop and mobile. */
async function fetchRemoteImage(url: string): Promise<FetchedImage> {
  const response = await requestUrl({ url, throw: false });
  if (response.status >= 400) throw new Error(`画像を取得できませんでした: ${response.status}`);
  const mime = response.headers['content-type']?.split(';', 1)[0]?.trim() || 'image/png';
  return { buffer: response.arrayBuffer, mime };
}

function dataUrl(mime: string, buffer: ArrayBuffer): string {
  return `data:${mime};base64,${arrayBufferToBase64(buffer)}`;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Images of the exported nodes, as the vault holds them: an embed's link target is
 * resolved from the note and read as binary; an `http(s)` image the note links to
 * is fetched as a last resort. Null leaves the node whole with the image's text.
 */
export function vaultImageResolver(app: App, sourcePath: string, fetchImage: (url: string) => Promise<FetchedImage> = fetchRemoteImage): ImageResolver {
  const fromVault = async (target: string | null): Promise<string | null> => {
    const linkpath = target ? linkpathOf(target) : null;
    const file = linkpath ? app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath) : null;
    const mime = file ? IMAGE_MIME[file.extension.toLowerCase()] : undefined;
    if (!file || !mime) return null;
    return dataUrl(mime, await app.vault.readBinary(file));
  };
  return async image => {
    const shown = image.currentSrc || image.src || '';
    if (shown.startsWith('data:')) return shown;
    const embedded = await fromVault(image.closest('.internal-embed')?.getAttribute('src') ?? null);
    if (embedded) return embedded;
    // A Markdown image (`![alt](figure.png)`) keeps its written path in the attribute when the renderer left it alone.
    const written = image.getAttribute('src') ?? '';
    if (written && !hasScheme(written)) {
      const resolved = await fromVault(safeDecode(written));
      if (resolved) return resolved;
    }
    if (!/^https?:/iu.test(shown)) return null;
    try {
      const fetched = await fetchImage(shown);
      return dataUrl(fetched.mime, fetched.buffer);
    } catch {
      return null;
    }
  };
}

export interface ExportOptions {
  theme?: ExportTheme;
  limits?: PngScaleLimits;
}

/**
 * Capture, encode and create the attachment. SVG is written as text; PNG is the
 * same SVG rasterised at a scale the canvas limits allow, so a 2,000-node map
 * still completes, at a lower resolution.
 */
export async function exportMap(app: App, note: TFile, source: CaptureSource, format: ExportFormat, options: ExportOptions = {}): Promise<TFile> {
  const scene = await captureScene(source, {
    resolveImage: vaultImageResolver(app, note.path), ...(options.theme ? { theme: options.theme } : {}),
  });
  if (scene.nodes.length === 0) throw new Error('書き出すノードがありません。');
  const svg = buildSvg(scene);
  const path = await app.fileManager.getAvailablePathForAttachment(`${note.basename}.${format}`, note.path);
  if (format === 'svg') return app.vault.create(path, svg);
  if (!canRasterize()) throw new Error('この環境では PNG を作れません。SVG で書き出してください。');
  const size = svgSize(scene.bounds);
  const png = await rasterizeSvg(svg, size, pngScale(size, options.limits ?? pixelLimits()));
  return app.vault.createBinary(path, await png.arrayBuffer());
}
