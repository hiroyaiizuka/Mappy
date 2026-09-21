// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TFile, type App } from 'obsidian';
import { parseMarkdown } from '../../src/core/markdown';
import {
  DEFAULT_DROP_STALLED_MESSAGE, EMBEDDABLE_MAX_SIDE, ExcalidrawBridge, embeddableFrameSize, findBorderedMappyEmbeddables, isMappyDrop,
  type MapPainter, type PaintedMap,
} from '../../src/obsidian/excalidraw-bridge';
import { MAPPY_KEY } from '../../src/obsidian/frontmatter';
import type { DocumentStore } from '../../src/obsidian/document-store';
import type {
  ExcalidrawAutomate, ExcalidrawDropData, ExcalidrawDropHook, ExcalidrawElement, ExcalidrawStyle, ExcalidrawTextFormatting,
  ExcalidrawViewLike,
} from '../../src/types/excalidraw-automate';

interface FakeElement extends ExcalidrawElement {
  text?: string;
  points?: [number, number][];
  style: Partial<ExcalidrawStyle>;
  fontSize?: number;
}

function file(path: string): TFile {
  const result = new TFile();
  result.path = path;
  return result;
}

/** Enough of ExcalidrawAutomate to observe how the bridge builds a drawing. */
class FakeAutomate implements ExcalidrawAutomate {
  onDropHook: ExcalidrawDropHook | null | undefined = null;
  style: ExcalidrawStyle = FakeAutomate.defaultStyle();
  targetView: ExcalidrawViewLike | null = null;
  calls: string[] = [];
  elements = new Map<string, FakeElement>();
  added: { args: unknown[]; elements: FakeElement[] }[] = [];
  selected: unknown[] = [];
  instances: FakeAutomate[] = [];
  /** The vault file behind each image file id, as Excalidraw's own mapping answers for the view. */
  imageFiles = new Map<string, TFile>();
  private counter = 0;

  constructor(
    private readonly images: Map<string, { width: number; height: number }> = new Map(),
    public activeView: ExcalidrawViewLike | null = null,
    private readonly parent: FakeAutomate | null = null,
  ) {}

  static defaultStyle(): ExcalidrawStyle {
    return {
      strokeColor: '#000000', backgroundColor: 'transparent', fillStyle: 'hachure', strokeWidth: 1, strokeStyle: 'solid',
      roughness: 1, opacity: 100, roundness: null, fontFamily: 1, fontSize: 20, textAlign: 'left', verticalAlign: 'top',
    };
  }

  getAPI(view?: ExcalidrawViewLike): ExcalidrawAutomate {
    const instance = new FakeAutomate(this.images, this.activeView, this);
    instance.targetView = view ?? null;
    this.instances.push(instance);
    this.calls.push('getAPI');
    return instance;
  }

  setView(view?: ExcalidrawViewLike | 'active' | 'first' | 'auto' | null): ExcalidrawViewLike | null {
    this.calls.push(`setView:${typeof view === 'string' ? view : 'view'}`);
    this.targetView = view === 'active' ? this.activeView : null;
    return this.targetView;
  }

  getExcalidrawAPI(): { getAppState(): Record<string, unknown> } | null {
    return { getAppState: () => ({ currentItemFontFamily: 5 }) };
  }

  getViewElements(): ExcalidrawElement[] { return this.getElements(); }
  getViewFileForImageElement(element: ExcalidrawElement): TFile | null {
    return element.fileId ? this.imageFiles.get(element.fileId) ?? null : null;
  }
  copyViewElementsToEAforEditing(elements: ExcalidrawElement[]): void {
    this.elements.clear();
    for (const element of elements) this.elements.set(element.id, { ...element, style: {} });
  }

  reset(): void { this.calls.push('reset'); this.elements.clear(); this.style = FakeAutomate.defaultStyle(); }
  clear(): void { this.calls.push('clear'); this.elements.clear(); }
  destroy(): void { this.calls.push('destroy'); }

  private create(type: string, x: number, y: number, width: number, height: number): FakeElement {
    const element: FakeElement = {
      id: `${type}-${++this.counter}`, type, x, y, width, height, groupIds: [], style: { ...this.style },
    };
    this.elements.set(element.id, element);
    return element;
  }

  addText(topX: number, topY: number, text: string, formatting?: ExcalidrawTextFormatting): string {
    this.calls.push(`addText:${text}`);
    const width = Math.max(1, text.length) * this.style.fontSize * 0.6;
    const height = this.style.fontSize * 1.25;
    const textElement = this.create('text', topX, topY, width, height);
    textElement.text = text;
    textElement.fontSize = this.style.fontSize;
    if (!formatting?.box) return textElement.id;
    const padding = formatting.boxPadding ?? 30;
    const box = this.create('rectangle', topX - padding, topY - padding, width + 2 * padding, height + 2 * padding);
    box.boundElements = [{ type: 'text', id: textElement.id }];
    textElement.containerId = box.id;
    return box.id;
  }

  addLine(points: [number, number][]): string {
    this.calls.push('addLine');
    const xs = points.map(point => point[0]);
    const ys = points.map(point => point[1]);
    const element = this.create('line', Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    element.points = points;
    return element.id;
  }

  addImage(topX: number, topY: number, imageFile: TFile | string, scale = true): Promise<string | null> {
    const path = typeof imageFile === 'string' ? imageFile : imageFile.path;
    this.calls.push(`addImage:${path}`);
    const size = this.images.get(path);
    if (!size) return Promise.resolve(null);
    // As EA's `scale`: the longer side is capped at 500, the proportions kept.
    const factor = scale ? Math.min(1, 500 / Math.max(size.width, size.height)) : 1;
    const element = this.create('image', topX, topY, size.width * factor, size.height * factor);
    element.fileId = `file:${path}`;
    if (typeof imageFile !== 'string') this.imageFiles.set(element.fileId, imageFile);
    return Promise.resolve(element.id);
  }

  addToGroup(objectIds: string[]): string {
    this.calls.push('addToGroup');
    for (const id of objectIds) this.elements.get(id)?.groupIds?.push('group-1');
    return 'group-1';
  }

  getElement(id: string): ExcalidrawElement | null { return this.elements.get(id) ?? null; }
  getElements(): ExcalidrawElement[] { return Array.from(this.elements.values()); }

  addElementsToView(...args: unknown[]): Promise<boolean> {
    this.calls.push('addElementsToView');
    this.added.push({ args, elements: this.getElements().map(element => ({ ...element })) as FakeElement[] });
    return Promise.resolve(true);
  }

  selectElementsInView(elements: string[] | ExcalidrawElement[]): void {
    this.calls.push('selectElementsInView');
    this.selected.push(elements);
  }
}

const SOURCE = '## 講座\n- はじめに\n  ![[図.png]] と [[睡眠ノート|睡眠]]\n  - 学ぶこと\n- 回復する\n';

function harness(options: {
  sources?: Record<string, string>;
  frontmatter?: Record<string, Record<string, unknown>>;
  images?: Record<string, { width: number; height: number }>;
  active?: ExcalidrawViewLike | null;
  automate?: FakeAutomate | undefined;
  paint?: MapPainter;
} = {}) {
  const sources = options.sources ?? { 'Note.md': SOURCE };
  const files = new Map(Object.keys(sources).map(path => [path, file(path)]));
  const images = new Map(Object.entries(options.images ?? {}));
  for (const path of images.keys()) files.set(path, file(path));
  /** Attachments the bridge created: the SVG of a map drawn for "Insert image". */
  const created: { path: string; data: string }[] = [];
  const attachmentRequests: { name: string; owner: string }[] = [];
  const app = {
    metadataCache: {
      getFileCache: (target: TFile) => {
        const configured = options.frontmatter;
        const properties = configured && Object.prototype.hasOwnProperty.call(configured, target.path)
          ? configured[target.path]
          : { [MAPPY_KEY]: true };
        return properties ? { frontmatter: properties } : null;
      },
      getFirstLinkpathDest: (target: string) => files.get(target) ?? files.get(`${target}.md`) ?? null,
      fileToLinktext: (target: TFile) => target.basename,
    },
    fileManager: {
      getAvailablePathForAttachment: (name: string, owner: string) => { attachmentRequests.push({ name, owner }); return Promise.resolve(`attachments/${name}`); },
    },
    vault: {
      create: (path: string, data: string) => { created.push({ path, data }); return Promise.resolve(file(path)); },
    },
  } as unknown as App;
  const read = vi.fn((target: TFile) => {
    const source = sources[target.path];
    return source === undefined ? Promise.reject(new Error(`missing ${target.path}`)) : Promise.resolve(source);
  });
  const store = { read } as unknown as DocumentStore;
  const automate = 'automate' in options ? options.automate : new FakeAutomate(images, options.active ?? null);
  const reports: string[] = [];
  const bridge = new ExcalidrawBridge(app, store, () => automate, message => reports.push(message), options.paint ?? null);
  return { bridge, automate, reports, files, read, created, attachmentRequests };
}

/** What the painter answers for a note: a map SVG of the note's title, sized as the export would size it. */
function painted(title: string, bounds = { x: 0, y: 0, width: 1000, height: 400 }, stalled = false): PaintedMap {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width + 48}" height="${bounds.height + 48}"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">${title}</div></foreignObject></svg>`;
  return { svg, size: { width: bounds.width + 48, height: bounds.height + 48 }, bounds, stalled };
}

function drop(overrides: Partial<ExcalidrawDropData> = {}): ExcalidrawDropData {
  const drawing = file('Drawing.excalidraw.md');
  return {
    ea: new FakeAutomate(),
    event: { altKey: true, shiftKey: false, ctrlKey: false, metaKey: false },
    draggable: null,
    type: 'file',
    payload: { files: [file('Note.md')], text: null },
    excalidrawFile: drawing,
    view: { file: drawing },
    pointerPosition: { x: 100, y: 200 },
    ...overrides,
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

afterEach(() => { vi.useRealTimers(); });

describe('isMappyDrop', () => {
  it('accepts Option/Alt alone', () => {
    expect(isMappyDrop({ altKey: true, shiftKey: false, ctrlKey: false, metaKey: false })).toBe(true);
    expect(isMappyDrop({ altKey: false, shiftKey: false, ctrlKey: false, metaKey: false })).toBe(false);
    expect(isMappyDrop({ altKey: true, shiftKey: true, ctrlKey: false, metaKey: false })).toBe(false);
    expect(isMappyDrop({ altKey: true, shiftKey: false, ctrlKey: true, metaKey: false })).toBe(false);
  });
});

describe('findBorderedMappyEmbeddables', () => {
  it('finds only bordered Excalidraw embeds whose links resolve to Mappy notes', () => {
    const { files } = harness({
      sources: { 'Map.md': SOURCE, 'Plain.md': '# Plain\n' },
      frontmatter: { 'Map.md': { [MAPPY_KEY]: true }, 'Plain.md': {} },
    });
    const app = {
      metadataCache: {
        getFileCache: (target: TFile) => target.path === 'Map.md' ? { frontmatter: { [MAPPY_KEY]: true } } : { frontmatter: {} },
        getFirstLinkpathDest: (target: string) => files.get(target.replace(/\.md$/u, '')) ?? files.get(target) ?? null,
      },
    } as unknown as App;
    const elements = [
      { id: 'map', type: 'embeddable', link: '[[Map.md]]', strokeColor: '#000000' },
      { id: 'plain', type: 'embeddable', link: '[[Plain.md]]', strokeColor: '#000000' },
      { id: 'clear', type: 'embeddable', link: '[[Map.md]]', strokeColor: 'transparent' },
      { id: 'text', type: 'text', link: '[[Map.md]]', strokeColor: '#000000' },
    ] as ExcalidrawElement[];

    expect(findBorderedMappyEmbeddables(app, file('Drawing.excalidraw.md'), elements).map(element => element.id)).toEqual(['map']);
  });
});

describe('ExcalidrawBridge.ensureHook', () => {
  it('reports unavailable without the Excalidraw global and installs once it exists', () => {
    const { bridge } = harness({ automate: undefined });
    expect(bridge.available).toBe(false);
    expect(bridge.ensureHook()).toBe(false);
    const { bridge: ready, automate } = harness();
    expect(ready.ensureHook()).toBe(true);
    expect(ready.ensureHook()).toBe(true);
    expect(typeof automate?.onDropHook).toBe('function');
  });

  it('chains to the previously installed hook and restores it on dispose', () => {
    const { bridge, automate } = harness();
    const previous = vi.fn(() => true);
    if (automate) automate.onDropHook = previous;
    bridge.ensureHook();
    const unrelated = drop({ type: 'text', payload: { files: null, text: 'x' } });
    expect(automate?.onDropHook?.(unrelated)).toBe(true);
    expect(previous).toHaveBeenCalledWith(unrelated);
    bridge.dispose();
    expect(automate?.onDropHook).toBe(previous);
  });

  it('passes through after dispose when another hook wrapped ours', () => {
    const { bridge, automate } = harness();
    bridge.ensureHook();
    const ours = automate?.onDropHook;
    const later = vi.fn((data: ExcalidrawDropData) => ours?.(data) ?? false);
    if (automate) automate.onDropHook = later;
    bridge.dispose();
    expect(automate?.onDropHook).toBe(later);
    expect(automate?.onDropHook?.(drop())).toBe(false);
    expect(automate?.instances).toHaveLength(0);
  });

  it('re-installs when Excalidraw is reloaded with a new instance', () => {
    let current: FakeAutomate | undefined = new FakeAutomate();
    const bridge = new ExcalidrawBridge({} as App, { read: vi.fn() } as unknown as DocumentStore, () => current);
    bridge.ensureHook();
    const first = current.onDropHook;
    current = undefined;
    expect(bridge.ensureHook()).toBe(false);
    current = new FakeAutomate();
    expect(bridge.ensureHook()).toBe(true);
    expect(current.onDropHook).not.toBe(first);
    expect(typeof current.onDropHook).toBe('function');
  });

  it('makes a newly-created built-in Mappy embeddable borderless after the drop dialog', async () => {
    vi.useFakeTimers();
    const { bridge, automate } = harness();
    bridge.ensureHook();
    const ordinary = drop({ event: { altKey: false, shiftKey: false, ctrlKey: false, metaKey: false } });
    expect(automate?.onDropHook?.(ordinary)).toBe(false);
    const ea = automate?.instances[0];
    expect(ea).toBeDefined();
    ea?.elements.set('embed-1', {
      id: 'embed-1', type: 'embeddable', x: 0, y: 0, width: 500, height: 300,
      link: '[[Note.md]]', strokeColor: '#000000', style: {},
    });

    await vi.advanceTimersByTimeAsync(200);

    expect(ea?.added).toHaveLength(1);
    expect(ea?.added[0]?.elements[0]?.strokeColor).toBe('transparent');
    // Without a painter the frame keeps Excalidraw's size.
    expect(ea?.added[0]?.elements[0]).toMatchObject({ width: 500, height: 300 });
    expect(ea?.calls.at(-1)).toBe('destroy');
  });
});

describe('embeddableFrameSize', () => {
  it('adds the fit padding around the bounds and caps the longer side, keeping the proportions', () => {
    expect(embeddableFrameSize({ width: 200, height: 100 })).toEqual({ width: 320, height: 220 });
    const wide = embeddableFrameSize({ width: 1000, height: 400 });
    expect(wide.width).toBe(EMBEDDABLE_MAX_SIDE);
    expect(wide.height).toBe(Math.round(520 * (800 / 1120)));
    const tall = embeddableFrameSize({ width: 100, height: 2000 }, 500);
    expect(tall).toEqual({ width: Math.round(220 * (500 / 2120)), height: 500 });
    expect(embeddableFrameSize({ width: 0, height: 0 })).toEqual({ width: 120, height: 120 });
  });
});

/** Excalidraw's built-in "Insert image / Insert as embeddable" of a map note, watched after the drop dialog (§5 M6). */
describe('ExcalidrawBridge default drop', () => {
  const ordinary = () => drop({ event: { altKey: false, shiftKey: false, ctrlKey: false, metaKey: false } });

  /** The bridge hooked, the drop declined to Excalidraw, and the EA instance the watcher polls. */
  function watched(options: Parameters<typeof harness>[0] = {}) {
    vi.useFakeTimers();
    const result = harness(options);
    result.bridge.ensureHook();
    expect(result.automate?.onDropHook?.(ordinary())).toBe(false);
    const ea = result.automate?.instances[0];
    if (!ea) throw new Error('no EA instance');
    return { ...result, ea };
  }

  /** What Excalidraw's "Insert image" of a Markdown note leaves in the view: the note's text as an SVG image, its file the note. */
  function markdownImage(ea: FakeAutomate, id: string, note: TFile, x = 40, y = 60): void {
    ea.elements.set(id, {
      id, type: 'image', x, y, width: 500, height: 800, fileId: `md:${note.path}`, style: {},
      customData: { markdownImage: { source: 'external', schemaVersion: 1, version: 1 } },
    });
    ea.imageFiles.set(`md:${note.path}`, note);
  }

  it('replaces the Markdown image of "Insert image" with the map drawn as an SVG attachment, linked to the note', async () => {
    const paint = vi.fn((target: TFile) => Promise.resolve(painted(target.basename)));
    const { ea, files, created, attachmentRequests, read, reports } = watched({ paint, images: { 'attachments/Note.svg': { width: 1048, height: 448 } } });
    const note = files.get('Note.md');
    if (!note) throw new Error('no note');
    markdownImage(ea, 'md-image', note);

    await vi.advanceTimersByTimeAsync(200);

    expect(paint).toHaveBeenCalledTimes(1);
    expect(paint.mock.calls[0]?.[0]).toBe(note);
    // The SVG is attached where the drawing's attachments go, named after the note; the note itself is never read or written by this route.
    expect(attachmentRequests).toEqual([{ name: 'Note.svg', owner: 'Drawing.excalidraw.md' }]);
    expect(created).toHaveLength(1);
    expect(created[0]?.path).toBe('attachments/Note.svg');
    expect(created[0]?.data).toContain('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">Note</div></foreignObject>');
    expect(read).not.toHaveBeenCalled();
    expect(ea.calls).toContain('addImage:attachments/Note.svg');
    expect(ea.added).toHaveLength(1);
    expect(ea.added[0]?.args).toEqual([false, true, true]);
    const elements = ea.added[0]?.elements ?? [];
    const old = elements.find(element => element.id === 'md-image');
    const image = elements.find(element => element.id !== 'md-image');
    // Excalidraw's own element is deleted in place; the new image sits where it was, scaled by EA to 500 on its longer side.
    expect(old?.isDeleted).toBe(true);
    expect(image).toMatchObject({ type: 'image', x: 40, y: 60, width: 500, fileId: 'file:attachments/Note.svg', link: '[[Note]]' });
    expect(image?.height).toBeCloseTo(500 * (448 / 1048), 6);
    expect(image?.customData).toBeUndefined();
    expect(ea.selected.at(-1)).toEqual([image?.id]);
    expect(reports).toEqual([]);
    expect(ea.calls.at(-1)).toBe('destroy');
  });

  it('gives the embeddable of "Insert as embeddable" the map\'s proportions at the same place, and no border', async () => {
    const paint = vi.fn(() => Promise.resolve(painted('Note', { x: -20, y: -10, width: 1000, height: 400 })));
    const { ea } = watched({ paint });
    ea.elements.set('embed-1', {
      id: 'embed-1', type: 'embeddable', x: 600, y: 0, width: 500, height: 500,
      link: '[[Note.md]]', strokeColor: '#000000', style: {},
    });

    await vi.advanceTimersByTimeAsync(200);

    expect(paint).toHaveBeenCalledTimes(1);
    expect(ea.added).toHaveLength(1);
    const frame = ea.added[0]?.elements.find(element => element.id === 'embed-1');
    expect(frame).toMatchObject({ x: 600, y: 0, strokeColor: 'transparent', link: '[[Note.md]]', width: 800, height: Math.round(520 * (800 / 1120)) });
    expect(ea.calls).not.toContain('addImage:attachments/Note.svg');
  });

  it('resizes an embeddable Excalidraw already made borderless and paints each note once for several elements', async () => {
    const paint = vi.fn((target: TFile) => Promise.resolve(painted(target.basename, { x: 0, y: 0, width: 100, height: 50 })));
    const { ea, files } = watched({ paint, images: { 'attachments/Note.svg': { width: 148, height: 98 } } });
    const note = files.get('Note.md');
    if (!note) throw new Error('no note');
    ea.elements.set('embed-1', { id: 'embed-1', type: 'embeddable', x: 0, y: 0, width: 500, height: 500, link: '[[Note.md]]', strokeColor: 'transparent', style: {} });
    markdownImage(ea, 'md-image', note, 700, 0);

    await vi.advanceTimersByTimeAsync(200);

    expect(paint).toHaveBeenCalledTimes(1);
    const elements = ea.added[0]?.elements ?? [];
    expect(elements.find(element => element.id === 'embed-1')).toMatchObject({ width: 220, height: 170, strokeColor: 'transparent' });
    expect(elements.find(element => element.id === 'md-image')?.isDeleted).toBe(true);
    expect(elements.find(element => element.type === 'image' && element.id !== 'md-image')).toMatchObject({ x: 700, y: 0, width: 148, height: 98 });
  });

  it('leaves images and embeddables of other notes, and other new elements, alone', async () => {
    const paint = vi.fn(() => Promise.resolve(painted('Plain')));
    const { ea, files, created } = watched({
      paint, sources: { 'Note.md': SOURCE, 'Plain.md': '# Plain\n' }, frontmatter: { 'Note.md': { [MAPPY_KEY]: true }, 'Plain.md': {} },
    });
    const plain = files.get('Plain.md');
    if (!plain) throw new Error('no plain note');
    markdownImage(ea, 'plain-image', plain);
    ea.elements.set('plain-embed', { id: 'plain-embed', type: 'embeddable', x: 0, y: 0, width: 500, height: 500, link: '[[Plain.md]]', strokeColor: '#000000', style: {} });
    ea.elements.set('rect', { id: 'rect', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, strokeColor: '#000000', style: {} });

    await vi.advanceTimersByTimeAsync(600);

    expect(paint).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
    expect(ea.added).toHaveLength(0);
    expect(ea.calls).not.toContain('destroy');
  });

  it('reports a map that cannot be painted and still removes the border; the Markdown image stays as Excalidraw made it', async () => {
    const paint = vi.fn(() => Promise.reject(new Error('描けません')));
    const { ea, files, created, reports } = watched({ paint });
    const note = files.get('Note.md');
    if (!note) throw new Error('no note');
    markdownImage(ea, 'md-image', note);
    ea.elements.set('embed-1', { id: 'embed-1', type: 'embeddable', x: 0, y: 0, width: 500, height: 500, link: '[[Note.md]]', strokeColor: '#000000', style: {} });

    await vi.advanceTimersByTimeAsync(200);

    expect(reports).toEqual(['描けません']);
    expect(created).toHaveLength(0);
    const elements = ea.added[0]?.elements ?? [];
    expect(elements.map(element => element.id)).toEqual(['embed-1']);
    expect(elements[0]).toMatchObject({ strokeColor: 'transparent', width: 500, height: 500 });
    expect(ea.calls.at(-1)).toBe('destroy');
  });

  it('says when a render stalled and inserts the map as far as it got', async () => {
    const paint = vi.fn(() => Promise.resolve(painted('Note', undefined, true)));
    const { ea, files, reports } = watched({ paint, images: { 'attachments/Note.svg': { width: 1048, height: 448 } } });
    const note = files.get('Note.md');
    if (!note) throw new Error('no note');
    markdownImage(ea, 'md-image', note);

    await vi.advanceTimersByTimeAsync(200);

    expect(reports).toEqual([DEFAULT_DROP_STALLED_MESSAGE]);
    expect(ea.added).toHaveLength(1);
    expect(ea.calls).toContain('addImage:attachments/Note.svg');
  });

  it('reports an SVG Excalidraw cannot load and keeps the Markdown image', async () => {
    const paint = vi.fn(() => Promise.resolve(painted('Note')));
    const { ea, files, created, reports } = watched({ paint });
    const note = files.get('Note.md');
    if (!note) throw new Error('no note');
    markdownImage(ea, 'md-image', note);

    await vi.advanceTimersByTimeAsync(200);

    expect(created).toHaveLength(1);
    expect(reports).toEqual(['Note の画像を Excalidraw に読み込めませんでした。']);
    const elements = ea.added[0]?.elements ?? [];
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({ id: 'md-image', type: 'image' });
    expect(elements[0]?.isDeleted).toBeUndefined();
  });

  it('keeps a move made while the map was being painted', async () => {
    let release: (map: PaintedMap) => void = () => {};
    const paint = vi.fn(() => new Promise<PaintedMap>(resolve => { release = resolve; }));
    const { ea } = watched({ paint });
    ea.elements.set('embed-1', { id: 'embed-1', type: 'embeddable', x: 0, y: 0, width: 500, height: 500, link: '[[Note.md]]', strokeColor: '#000000', style: {} });

    await vi.advanceTimersByTimeAsync(200);
    expect(paint).toHaveBeenCalledTimes(1);
    const moved = ea.elements.get('embed-1');
    if (moved) { moved.x = 250; moved.y = 125; }
    release(painted('Note', { x: 0, y: 0, width: 100, height: 50 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(ea.added[0]?.elements.find(element => element.id === 'embed-1')).toMatchObject({ x: 250, y: 125, width: 220, height: 170 });
  });

  it('does not treat an image as a map when this Excalidraw cannot name its file', async () => {
    const paint = vi.fn(() => Promise.resolve(painted('Note')));
    const { ea, files } = watched({ paint });
    const note = files.get('Note.md');
    if (!note) throw new Error('no note');
    markdownImage(ea, 'md-image', note);
    (ea as unknown as { getViewFileForImageElement: unknown }).getViewFileForImageElement = undefined;

    await vi.advanceTimersByTimeAsync(600);

    expect(paint).not.toHaveBeenCalled();
    expect(ea.added).toHaveLength(0);
  });
});

describe('ExcalidrawBridge.handleDrop', () => {
  it('ignores text drops, drops without Option, and non-Markdown or Excalidraw files', () => {
    const { bridge, automate } = harness({ frontmatter: { 'Other.excalidraw.md': { 'excalidraw-plugin': 'parsed' } } });
    expect(bridge.handleDrop(drop({ type: 'text' }))).toBe(false);
    expect(bridge.handleDrop(drop({ event: { altKey: false, shiftKey: true, ctrlKey: false, metaKey: false } }))).toBe(false);
    expect(bridge.handleDrop(drop({ payload: { files: [file('a.png'), file('Other.excalidraw.md')], text: null } }))).toBe(false);
    expect(bridge.handleDrop(drop({ payload: { files: null, text: null } }))).toBe(false);
    expect(automate?.instances).toHaveLength(0);
  });

  it('claims the drop and inserts the map at the pointer as one group', async () => {
    const { bridge, automate } = harness({ images: { '図.png': { width: 480, height: 300 } } });
    expect(bridge.handleDrop(drop())).toBe(true);
    await flush();
    const ea = automate?.instances[0];
    expect(ea).toBeDefined();
    expect(ea?.calls[0]).toBe('reset');
    expect(ea?.calls.at(-1)).toBe('destroy');
    expect(ea?.calls).toContain('addToGroup');
    expect(ea?.added).toHaveLength(1);
    expect(ea?.added[0]?.args).toEqual([false, true, true]);
    const elements = ea?.added[0]?.elements ?? [];
    const texts = elements.filter(element => element.type === 'text').map(element => element.text);
    expect(texts).toEqual(['講座', 'はじめに', '学ぶこと', '回復する']);
    expect(elements.every(element => element.groupIds?.includes('group-1'))).toBe(true);
    expect(ea?.selected[0]).toHaveLength(elements.length);
    // Root and stages are boxed, deeper nodes are plain text.
    const boxes = elements.filter(element => element.type === 'rectangle');
    expect(boxes).toHaveLength(3);
    const root = boxes.find(box => box.style.backgroundColor === '#1e1e1e');
    expect(root?.link).toBe('[[Note]]');
    const rootText = elements.find(element => element.containerId === root?.id);
    expect(rootText?.style.strokeColor).toBe('#ffffff');
    expect(rootText?.fontSize).toBe(20);
    expect(root?.style.fontFamily).toBe(5);
    // Everything sits at or right/below the pointer.
    expect(Math.min(...elements.map(element => element.x))).toBe(100);
    expect(Math.min(...elements.map(element => element.y))).toBe(200);
    // Connectors are orthogonal polylines between nodes.
    const lines = elements.filter(element => element.type === 'line');
    expect(lines).toHaveLength(3);
    expect(lines.every(line => (line.points?.length ?? 0) >= 2)).toBe(true);
    // The image is scaled into the preview limit and placed under its label.
    const image = elements.find(element => element.type === 'image');
    expect(image).toMatchObject({ width: 224, height: 140 });
    const stage = elements.find(element => element.text === 'はじめに');
    const stageBox = elements.find(element => element.id === stage?.containerId);
    expect(stageBox?.link).toBe('[[睡眠ノート]]');
    expect(image?.y ?? 0).toBeGreaterThan((stageBox?.y ?? 0) + (stageBox?.height ?? 0));
    expect(image?.x).toBe(stageBox?.x);
  });

  it('stacks several dropped notes vertically and uses frontmatter layouts', async () => {
    const { bridge, automate } = harness({
      sources: { 'A.md': '## A\n- a1\n- a2\n', 'B.md': '## B\n- b1\n' },
      frontmatter: {
        'A.md': { [MAPPY_KEY]: true },
        'B.md': { [MAPPY_KEY]: true, 'mappy-layout': 'timeline' },
      },
    });
    expect(bridge.handleDrop(drop({ payload: { files: [file('A.md'), file('B.md')], text: null } }))).toBe(true);
    await flush();
    const ea = automate?.instances[0];
    expect(ea?.added).toHaveLength(2);
    expect(ea?.calls.filter(call => call === 'reset')).toHaveLength(2);
    expect(ea?.calls.filter(call => call === 'destroy')).toHaveLength(1);
    const first = ea?.added[0]?.elements ?? [];
    const second = ea?.added[1]?.elements ?? [];
    const firstBottom = Math.max(...first.map(element => element.y + element.height));
    expect(Math.min(...second.map(element => element.y))).toBeGreaterThanOrEqual(firstBottom + 40);
    // Timeline: the stage sits on the axis to the right of the root at the same vertical centre.
    const root = second.find(element => element.text === 'B');
    const stage = second.find(element => element.text === 'b1');
    expect(Math.round((root?.y ?? 0) + (root?.height ?? 0) / 2)).toBe(Math.round((stage?.y ?? 0) + (stage?.height ?? 0) / 2));
  });

  it('does not claim an ordinary Markdown drop until the note is explicitly map-enabled', () => {
    const { bridge, automate } = harness({ frontmatter: { 'Note.md': {} } });
    expect(bridge.handleDrop(drop())).toBe(false);
    expect(automate?.instances).toHaveLength(0);
  });

  it('reports failures and still destroys the automate instance', async () => {
    const { bridge, automate, reports } = harness({ sources: {} });
    expect(bridge.handleDrop(drop())).toBe(true);
    await flush();
    expect(reports).toEqual(['missing Note.md']);
    expect(automate?.instances[0]?.calls).toContain('destroy');
  });

  it('skips images that do not resolve to vault image files', async () => {
    const { bridge, automate } = harness();
    bridge.handleDrop(drop());
    await flush();
    const elements = automate?.instances[0]?.added[0]?.elements ?? [];
    expect(elements.some(element => element.type === 'image')).toBe(false);
  });
});

describe('ExcalidrawBridge.insertIntoActiveDrawing', () => {
  const request = (collapsed: string[] = []) => ({ file: file('Note.md'), mode: 'mindmap' as const, collapsed: new Set(collapsed) });

  it('fails clearly without Excalidraw or without an active drawing', async () => {
    await expect(harness({ automate: undefined }).bridge.insertIntoActiveDrawing(request())).rejects.toThrow(/Excalidraw プラグイン/u);
    const { bridge, automate } = harness({ active: null });
    await expect(bridge.insertIntoActiveDrawing(request())).rejects.toThrow(/図面を開いて/u);
    expect(automate?.instances[0]?.calls).toEqual(['setView:active', 'destroy']);
  });

  it('inserts into the active drawing centred on the cursor and respects collapsed nodes of the given document', async () => {
    const drawing = { file: file('Board.excalidraw.md') };
    const { bridge, automate, read } = harness({ active: drawing });
    const document = parseMarkdown(SOURCE, 'Note');
    const intro = document.nodes.find(node => node.title === 'はじめに');
    await bridge.insertIntoActiveDrawing({ ...request([intro?.id ?? '']), document });
    expect(read).not.toHaveBeenCalled();
    const ea = automate?.instances[0];
    expect(ea?.targetView).toBe(drawing);
    expect(ea?.added[0]?.args).toEqual([true, true, true]);
    const texts = (ea?.added[0]?.elements ?? []).filter(element => element.type === 'text').map(element => element.text);
    expect(texts).toEqual(['講座', 'はじめに', '回復する']);
    expect(ea?.calls.at(-1)).toBe('destroy');
  });

  const CALLED = '---\nmappy: true\n---\n## 呼ばれた\n- 一\n  ![[絵.png]] と [[別ノート]]\n  - 深い\n- 二\n';
  const CALLER = '## 講座\n- ![[Called]]\n- 葉\n';

  it('inserts the branches of a called map (§5 M12) as the view shows them, its links and images resolved from the called note', async () => {
    const drawing = { file: file('Board.excalidraw.md') };
    const { bridge, automate, read } = harness({
      active: drawing, sources: { 'Note.md': CALLER, 'Called.md': CALLED, '別ノート.md': '' }, images: { '絵.png': { width: 300, height: 100 } },
    });
    const document = parseMarkdown(CALLER, 'Note');
    const called = parseMarkdown(CALLED, 'Called');
    const calling = document.nodes.find(node => node.title === '![[Called]]');
    const deep = called.nodes.find(node => node.title === '一');
    const calls = new Map([[calling?.id ?? '', { path: 'Called.md', subpath: '', document: called }]]);
    // The view's folds: 一 is closed, so 深い stays behind it, as on screen.
    await bridge.insertIntoActiveDrawing({ ...request([`${calling?.id}/${deep?.id}`]), document, calls });
    expect(read).not.toHaveBeenCalled();
    const ea = automate?.instances[0];
    const elements = ea?.added[0]?.elements ?? [];
    expect(elements.filter(element => element.type === 'text').map(element => element.text)).toEqual(['講座', '呼ばれた', '一', '二', '葉']);
    expect(elements.filter(element => element.type === 'image')).toHaveLength(1);
    expect(ea?.calls).toContain('addImage:絵.png');
    // The calling item links to the called note; a called node's own link resolves from that note.
    const links = new Map(elements.filter(element => element.link).map(element => [element.boundElements ? (elements.find(text => text.containerId === element.id)?.text ?? '') : element.text ?? '', element.link]));
    expect(links.get('呼ばれた')).toBe('[[Called]]');
    expect(links.get('一')).toBe('[[別ノート]]');
  });

  it('reads the called maps itself for a request without them (a Markdown view) and folds them below their roots\' children', async () => {
    const drawing = { file: file('Board.excalidraw.md') };
    const { bridge, automate, read } = harness({ active: drawing, sources: { 'Note.md': CALLER, 'Called.md': CALLED } });
    await bridge.insertIntoActiveDrawing(request());
    expect(read.mock.calls.map(([target]) => target.path)).toEqual(['Note.md', 'Called.md']);
    const ea = automate?.instances[0];
    const texts = (ea?.added[0]?.elements ?? []).filter(element => element.type === 'text').map(element => element.text);
    expect(texts).toEqual(['講座', '呼ばれた', '一', '二', '葉']);
  });

  it('keeps a call a link when the called note is not a map or cannot be read', async () => {
    const drawing = { file: file('Board.excalidraw.md') };
    const { bridge, automate } = harness({
      active: drawing, sources: { 'Note.md': CALLER, 'Called.md': '## Plain\n- a\n' }, frontmatter: { 'Note.md': { [MAPPY_KEY]: true }, 'Called.md': {} },
    });
    await bridge.insertIntoActiveDrawing(request());
    const texts = (automate?.instances[0]?.added[0]?.elements ?? []).filter(element => element.type === 'text').map(element => element.text);
    expect(texts).toEqual(['講座', 'Called', '葉']);
  });
});
