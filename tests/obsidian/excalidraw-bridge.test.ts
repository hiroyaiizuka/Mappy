// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TFile, type App } from 'obsidian';
import { parseMarkdown } from '../../src/core/markdown';
import { ExcalidrawBridge, findBorderedMappyEmbeddables, isMappyDrop } from '../../src/obsidian/excalidraw-bridge';
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

  addImage(topX: number, topY: number, imageFile: TFile | string): Promise<string | null> {
    const path = typeof imageFile === 'string' ? imageFile : imageFile.path;
    this.calls.push(`addImage:${path}`);
    const size = this.images.get(path);
    if (!size) return Promise.resolve(null);
    return Promise.resolve(this.create('image', topX, topY, size.width, size.height).id);
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
} = {}) {
  const sources = options.sources ?? { 'Note.md': SOURCE };
  const files = new Map(Object.keys(sources).map(path => [path, file(path)]));
  const images = new Map(Object.entries(options.images ?? {}));
  for (const path of images.keys()) files.set(path, file(path));
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
  } as unknown as App;
  const read = vi.fn((target: TFile) => {
    const source = sources[target.path];
    return source === undefined ? Promise.reject(new Error(`missing ${target.path}`)) : Promise.resolve(source);
  });
  const store = { read } as unknown as DocumentStore;
  const automate = 'automate' in options ? options.automate : new FakeAutomate(images, options.active ?? null);
  const reports: string[] = [];
  const bridge = new ExcalidrawBridge(app, store, () => automate, message => reports.push(message));
  return { bridge, automate, reports, files, read };
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
    expect(ea?.calls.at(-1)).toBe('destroy');
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
});
