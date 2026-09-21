// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, TFile as ObsidianFile } from 'obsidian';
import { TFile } from '../mocks/obsidian-file';
import { installObsidianDom } from '../../harness/browser/dom';
import type { CaptureSource } from '../../src/export/svg-capture';
import { requestUrl } from 'obsidian';
import {
  assertWellFormed, canSaveAttachments, exportMap, fetchRemoteImage, pixelLimits, vaultImageResolver,
} from '../../src/obsidian/image-export';

vi.mock('obsidian', () => ({
  Platform: { isMobile: false },
  arrayBufferToBase64: (buffer: ArrayBuffer) => Buffer.from(buffer).toString('base64'),
  requestUrl: vi.fn(),
  TFile: class {},
}));

beforeAll(() => { installObsidianDom(); });
afterEach(() => { document.body.replaceChildren(); document.body.classList.remove('theme-dark'); });

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

function file(path: string): ObsidianFile {
  const created = new TFile();
  created.path = path;
  return created as unknown as ObsidianFile;
}

/** The slice of `App` the resolver and the export touch; every write is recorded. */
function fakeApp(files: Record<string, ObsidianFile>) {
  const created: { path: string; data: string | ArrayBuffer }[] = [];
  const app = {
    metadataCache: {
      getFirstLinkpathDest: vi.fn((linkpath: string) => files[linkpath] ?? null),
    },
    vault: {
      readBinary: vi.fn(() => Promise.resolve(PNG_BYTES.buffer.slice(0))),
      create: vi.fn((path: string, data: string) => { created.push({ path, data }); return Promise.resolve(file(path)); }),
      createBinary: vi.fn((path: string, data: ArrayBuffer) => { created.push({ path, data }); return Promise.resolve(file(path)); }),
      process: vi.fn(),
      modify: vi.fn(),
    },
    fileManager: {
      getAvailablePathForAttachment: vi.fn((name: string) => Promise.resolve(`attachments/${name}`)),
    },
  };
  return { app: app as unknown as App, raw: app, created };
}

/** Markup as Obsidian's renderer leaves it in a node (test fixture, not product code). */
function imageIn(markup: string): HTMLImageElement {
  const host = document.body.createDiv();
  host.insertAdjacentHTML('beforeend', markup);
  const image = host.querySelector('img');
  if (!image) throw new Error('no img');
  return image;
}

describe('canSaveAttachments', () => {
  it('needs the attachment path and both create calls', () => {
    const { app, raw } = fakeApp({});
    expect(canSaveAttachments(app)).toBe(true);
    const withoutAttachments = { ...raw, fileManager: {} } as unknown as App;
    expect(canSaveAttachments(withoutAttachments)).toBe(false);
  });

  it('gives mobile a smaller canvas budget', () => {
    expect(pixelLimits(true).maxPixels).toBeLessThan(pixelLimits(false).maxPixels);
    expect(pixelLimits(false)).toEqual({ preferred: 2, maxPixels: 8192 * 8192, maxSide: 16384 });
  });
});

describe('vaultImageResolver', () => {
  it('keeps a data URL as it is', async () => {
    const { app, raw } = fakeApp({});
    const resolve = vaultImageResolver(app, 'Map.md');
    const image = imageIn('<img src="data:image/gif;base64,R0lGOD">');
    await expect(resolve(image)).resolves.toBe('data:image/gif;base64,R0lGOD');
    expect(raw.vault.readBinary).not.toHaveBeenCalled();
  });

  it('reads an embed\'s target from the vault, ignoring the size alias, and types it by extension', async () => {
    const figure = file('Attachments/図.png');
    const { app, raw } = fakeApp({ '図.png': figure });
    const resolve = vaultImageResolver(app, 'Notes/Map.md');
    const image = imageIn('<span class="internal-embed image-embed is-loaded" src="図.png|120" alt="図.png"><img src="app://vault/Attachments/figure.png?1" alt="図.png" width="120"></span>');
    await expect(resolve(image)).resolves.toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`);
    expect(raw.metadataCache.getFirstLinkpathDest).toHaveBeenCalledWith('図.png', 'Notes/Map.md');
    expect(raw.vault.readBinary).toHaveBeenCalledWith(figure);
  });

  it('resolves a Markdown image by the path written in the note', async () => {
    const sample = file('Fixtures/sample-image.svg');
    const { app } = fakeApp({ 'sample-image.svg': sample });
    const resolve = vaultImageResolver(app, 'Fixtures/Map.md');
    const image = imageIn('<img src="sample-image.svg" alt="説明">');
    await expect(resolve(image)).resolves.toMatch(/^data:image\/svg\+xml;base64,/u);
  });

  it('fetches an http image through the host client, and gives up quietly when that fails', async () => {
    const fetchImage = vi.fn((url: string) => url.includes('ok')
      ? Promise.resolve({ buffer: PNG_BYTES.buffer.slice(0), mime: 'image/webp' })
      : Promise.reject(new Error('404')));
    const { app } = fakeApp({});
    const resolve = vaultImageResolver(app, 'Map.md', fetchImage);
    await expect(resolve(imageIn('<img src="https://example.com/ok.webp">'))).resolves.toBe(`data:image/webp;base64,${Buffer.from(PNG_BYTES).toString('base64')}`);
    await expect(resolve(imageIn('<img src="https://example.com/missing.png">'))).resolves.toBeNull();
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });

  it('does not read non-image vault files and does not fetch app URLs it cannot resolve', async () => {
    const pdf = file('Docs/paper.pdf');
    const fetchImage = vi.fn(() => Promise.reject(new Error('unexpected')));
    const { app, raw } = fakeApp({ 'paper.pdf': pdf });
    const resolve = vaultImageResolver(app, 'Map.md', fetchImage);
    await expect(resolve(imageIn('<span class="internal-embed" src="paper.pdf"><img src="app://vault/Docs/paper.pdf"></span>'))).resolves.toBeNull();
    expect(raw.vault.readBinary).not.toHaveBeenCalled();
    expect(fetchImage).not.toHaveBeenCalled();
  });
});

/** A one-node map on the page, as the view would have placed it. */
function source(): CaptureSource {
  const canvas = document.body.createDiv({ cls: 'mappy-canvas' });
  const edges = canvas.createSvg('svg', { cls: 'mappy-edges' });
  const element = canvas.createDiv({ cls: 'mappy-node is-root', attr: { 'data-node-id': 'root' } });
  element.createDiv({ cls: 'mappy-node-content' }).createDiv({ cls: 'mappy-node-label', text: '講座 <A & B>' });
  const toggleMark = element.createSpan({ cls: 'mappy-node-toggle-mark' });
  return {
    canvas, edges,
    entries: new Map([['root', { element, toggleMark }]]),
    layout: {
      nodes: [{ id: 'root', x: 10, y: 20, width: 120, height: 44 }],
      edges: [], folds: [],
      bounds: { x: 10, y: 20, width: 120, height: 44 }, origin: { x: 10, y: 20 },
    },
  };
}

describe('exportMap', () => {
  it('creates the SVG where the attachment setting points, named after the note, and never writes the note', async () => {
    const note = file('Notes/講座.md');
    const { app, raw, created } = fakeApp({});
    const saved = await exportMap(app, note, source(), 'svg');
    expect(raw.fileManager.getAvailablePathForAttachment).toHaveBeenCalledWith('講座.svg', 'Notes/講座.md');
    expect(saved.path).toBe('attachments/講座.svg');
    expect(created).toHaveLength(1);
    const svg = created[0]?.data;
    if (typeof svg !== 'string') throw new Error('SVG must be created as text');
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('<foreignObject data-node-id="root" x="10" y="20" width="120" height="44"');
    expect(svg).toContain('講座 &lt;A &amp; B&gt;');
    expect(raw.vault.process).not.toHaveBeenCalled();
    expect(raw.vault.modify).not.toHaveBeenCalled();
    expect(raw.vault.createBinary).not.toHaveBeenCalled();
  });

  it('names the theme of the container the map sits in, then the body\'s, and the option overrides both (LEV-92)', async () => {
    const { app, created } = fakeApp({});
    const inDarkView = (): CaptureSource => {
      const captured = source();
      document.body.createDiv({ cls: 'mappy-view theme-dark' }).append(captured.canvas);
      return captured;
    };
    await exportMap(app, file('Map.md'), inDarkView(), 'svg');
    await exportMap(app, file('Map.md'), inDarkView(), 'svg', { theme: 'light' });
    await exportMap(app, file('Map.md'), source(), 'svg');
    document.body.classList.add('theme-dark');
    await exportMap(app, file('Map.md'), source(), 'svg');
    expect(created.map(entry => typeof entry.data === 'string' && /data-theme="(\w+)"/.exec(entry.data)?.[1])).toEqual(['dark', 'light', 'light', 'dark']);
  });

  it('refuses PNG where no canvas can be drawn, before capturing or naming a file', async () => {
    const { app, raw, created } = fakeApp({});
    await expect(exportMap(app, file('Map.md'), source(), 'png')).rejects.toThrow('PNG を作れません');
    expect(created).toHaveLength(0);
    expect(raw.vault.createBinary).not.toHaveBeenCalled();
    expect(raw.fileManager.getAvailablePathForAttachment).not.toHaveBeenCalled();
  });

  it('checks the file is well formed before it is created', () => {
    expect(() => { assertWellFormed('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>'); }).toThrow('整形式ではありません');
    expect(() => { assertWellFormed('<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>'); }).not.toThrow();
  });

  it('refuses an empty map', async () => {
    const { app, created } = fakeApp({});
    const empty = { ...source(), layout: { nodes: [], edges: [], folds: [], bounds: { x: 0, y: 0, width: 0, height: 0 }, origin: { x: 0, y: 0 } } };
    await expect(exportMap(app, file('Map.md'), empty, 'svg')).rejects.toThrow('ノードがありません');
    expect(created).toHaveLength(0);
  });
});

describe('fetchRemoteImage', () => {
  const request = vi.mocked(requestUrl);

  afterEach(() => { request.mockReset(); vi.useRealTimers(); });

  it('accepts only an image media type', async () => {
    request.mockResolvedValueOnce({ status: 200, headers: { 'content-type': 'image/webp; charset=binary' }, arrayBuffer: PNG_BYTES.buffer.slice(0) } as never);
    await expect(fetchRemoteImage('https://example.com/a.webp')).resolves.toMatchObject({ mime: 'image/webp' });
    request.mockResolvedValueOnce({ status: 200, headers: { 'content-type': 'text/html' }, arrayBuffer: new ArrayBuffer(0) } as never);
    await expect(fetchRemoteImage('https://example.com/login')).rejects.toThrow('画像ではありません');
    request.mockResolvedValueOnce({ status: 404, headers: {}, arrayBuffer: new ArrayBuffer(0) } as never);
    await expect(fetchRemoteImage('https://example.com/missing.png')).rejects.toThrow('404');
  });

  it('gives up on a host that never answers', async () => {
    vi.useFakeTimers();
    request.mockReturnValueOnce(new Promise(() => { /* never settles */ }) as never);
    const pending = fetchRemoteImage('https://example.com/stalled.png', 500);
    const outcome = expect(pending).rejects.toThrow('500 ms');
    await vi.advanceTimersByTimeAsync(600);
    await outcome;
  });
});
