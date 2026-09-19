import { Platform, arrayBufferToBase64, requestUrl, type App, type TFile } from 'obsidian';
import { imageMimeType } from '../core/attachments';
import { hasUrlScheme, wikiLinkPath } from '../core/wiki-link';
import {
  PNG_UNAVAILABLE, canRasterize, captureScene, rasterizeSvg, type CaptureSource, type ImageResolver,
} from '../export/svg-capture';
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

/** A remote image that has not answered by then is treated as unreadable, so the export cannot hang on one host. */
export const REMOTE_IMAGE_TIMEOUT_MS = 15_000;

/** Canvas limits the raster must respect; WebKit on mobile allows far less than desktop Chromium. */
export function pixelLimits(mobile = Platform.isMobile): PngScaleLimits {
  return mobile ? MOBILE_PNG_LIMITS : DESKTOP_PNG_LIMITS;
}

/** Whether this host can name and create attachments; the command is offered only then. */
export function canSaveAttachments(app: App): boolean {
  return typeof app.fileManager.getAvailablePathForAttachment === 'function'
    && typeof app.vault.create === 'function' && typeof app.vault.createBinary === 'function';
}

/** Bytes and media type of a remote image. */
export interface FetchedImage {
  buffer: ArrayBuffer;
  mime: string;
}

/**
 * `requestUrl` is Obsidian's own client: no CORS, and the same call on desktop and
 * mobile. Only an image media type is accepted; a login page served with 200 would
 * otherwise be embedded as `data:text/html`.
 */
export async function fetchRemoteImage(url: string, timeoutMs = REMOTE_IMAGE_TIMEOUT_MS): Promise<FetchedImage> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => { reject(new Error(`画像の取得が ${timeoutMs} ms 以内に終わりませんでした: ${url}`)); }, timeoutMs);
  });
  try {
    const response = await Promise.race([requestUrl({ url, throw: false }), timeout]);
    if (response.status >= 400) throw new Error(`画像を取得できませんでした: ${response.status}`);
    const mime = response.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (!mime.startsWith('image/')) throw new Error(`画像ではありません: ${mime || '不明な形式'}`);
    return { buffer: response.arrayBuffer, mime };
  } finally {
    window.clearTimeout(timer);
  }
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
    const linkpath = wikiLinkPath(target);
    const file = linkpath ? app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath) : null;
    const mime = file ? imageMimeType(file.extension) : undefined;
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
    if (written && !hasUrlScheme(written)) {
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

/** The file is checked before it is written: a parser error here is a bug in the capture, not a broken vault file. */
export function assertWellFormed(svg: string): void {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const error = parsed.querySelector('parsererror');
  if (error) throw new Error(`書き出した SVG が整形式ではありません: ${error.textContent?.trim().split('\n')[0] ?? ''}`);
}

export interface ExportOptions {
  theme?: ExportTheme;
  limits?: PngScaleLimits;
}

/**
 * Capture, encode and create the attachment. SVG is written as text; PNG is the
 * same SVG rasterised at a scale the canvas limits allow, so a 2,000-node map
 * still completes, at a lower resolution. A host that cannot rasterise is refused
 * before any work is done and before the attachment folder is touched.
 */
export async function exportMap(app: App, note: TFile, source: CaptureSource, format: ExportFormat, options: ExportOptions = {}): Promise<TFile> {
  if (format === 'png' && !canRasterize()) throw new Error(PNG_UNAVAILABLE);
  const scene = await captureScene(source, {
    resolveImage: vaultImageResolver(app, note.path), ...(options.theme ? { theme: options.theme } : {}),
  });
  if (scene.nodes.length === 0) throw new Error('書き出すノードがありません。');
  const svg = buildSvg(scene);
  assertWellFormed(svg);
  if (format === 'svg') {
    const path = await app.fileManager.getAvailablePathForAttachment(`${note.basename}.svg`, note.path);
    return app.vault.create(path, svg);
  }
  const size = svgSize(scene.bounds);
  const png = await rasterizeSvg(svg, size, pngScale(size, options.limits ?? pixelLimits()));
  const path = await app.fileManager.getAvailablePathForAttachment(`${note.basename}.png`, note.path);
  return app.vault.createBinary(path, await png.blob.arrayBuffer());
}
