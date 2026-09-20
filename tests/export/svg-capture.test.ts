// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, WorkspaceLeaf as ObsidianLeaf, ViewStateResult } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { MarkdownRenderer, WorkspaceLeaf } from '../../harness/browser/obsidian';
import { FIXTURES, SAMPLE_IMAGE, findFixture } from '../../harness/browser/fixtures';
import {
  PNG_UNAVAILABLE, canRasterize, canRasterizeForeignObject, captureScene, rasterizeSvg, type ImageResolver,
} from '../../src/export/svg-capture';
import { EXPORT_MARGIN, XHTML_NAMESPACE, buildSvg, svgSize } from '../../src/export/svg-document';
import { foldBadgeWidth, type LayoutMode } from '../../src/layout/layout';
import { DocumentStore } from '../../src/obsidian/document-store';
import type { ViewRouter } from '../../src/obsidian/view-routing';
import { EXPORT_RENDER_WAIT_MS, MindmapView } from '../../src/ui/mindmap-view';

// The browser-harness stand-in for `obsidian`, so the shipped view and renderer run against a real DOM.
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });
afterEach(() => { document.body.replaceChildren(); document.body.classList.remove('theme-dark'); });

const CANVAS = { x: 0, y: 0, left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800, toJSON: () => ({}) };

/** The harness keeps the sample image as a data URL; anything else is unreadable here. */
const passthrough: ImageResolver = image => Promise.resolve(image.src.startsWith('data:') ? image.src : null);

interface Mounted {
  app: HarnessApp;
  view: MindmapView;
  source: () => string;
  modified: () => number;
  nodes: () => HTMLElement[];
  settle: () => Promise<void>;
  fold: (title: string) => void;
}

async function mount(fixtureId: string, layout: LayoutMode = 'mindmap', source?: string, others: Record<string, string> = {}): Promise<Mounted> {
  const fixture = findFixture(fixtureId);
  if (!fixture) throw new Error(`Missing fixture ${fixtureId}`);
  const app = new HarnessApp();
  app.put(fixture.path, source ?? fixture.source);
  app.put(SAMPLE_IMAGE.path, '', SAMPLE_IMAGE.url);
  for (const [path, content] of Object.entries(others)) app.put(path, content);
  let modified = 0;
  app.vault.on('modify', () => { modified += 1; });
  const leaf = new WorkspaceLeaf(app.asApp<App>());
  const store = new DocumentStore(app.asApp<App>());
  const view = new MindmapView(leaf as unknown as ObsidianLeaf, store, {} as ViewRouter);
  leaf.view = view as unknown as WorkspaceLeaf['view'];
  document.body.append(view.containerEl);
  view.load();
  await view.onOpen();
  const canvas = view.containerEl.querySelector<HTMLElement>('.mappy-canvas');
  if (!canvas) throw new Error('The view has no canvas');
  canvas.getBoundingClientRect = () => CANVAS;
  await view.setState({ file: fixture.path, layout }, { history: false } satisfies ViewStateResult);
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 3; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));
  };
  await settle();
  const file = app.asApp<App>().vault.getAbstractFileByPath(fixture.path) as never;
  const nodes = (): HTMLElement[] => Array.from(view.containerEl.querySelectorAll<HTMLElement>('.mappy-node'));
  return {
    app, view, settle, nodes,
    source: () => app.content(file),
    modified: () => modified,
    fold: title => {
      const element = nodes().find(node => node.querySelector('.mappy-node-label')?.textContent?.trim() === title);
      const toggle = element?.querySelector<HTMLElement>('.mappy-node-toggle');
      if (!toggle) throw new Error(`No fold control on ${title}`);
      toggle.click();
    },
  };
}

function parseSvg(svg: string): Document {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const error = parsed.querySelector('parsererror');
  if (error) throw new Error(`SVG is not well formed: ${error.textContent ?? ''}`);
  return parsed;
}

async function exportOf(mounted: Mounted, resolveImage: ImageResolver = passthrough) {
  const started = performance.now();
  const source = await mounted.view.exportSource();
  const scene = await captureScene(source, { resolveImage });
  const svg = buildSvg(scene);
  const exportMs = performance.now() - started;
  return { source, scene, svg, exportMs, parsed: parseSvg(svg) };
}

describe('SVG export of the map view (jsdom)', () => {
  it('writes one foreignObject per visible node and one path per connector, in the layout coordinates, without touching the note', async () => {
    const mounted = await mount('uneven-branches');
    const original = mounted.source();
    const { source, scene, svg, parsed } = await exportOf(mounted);
    const shown = mounted.nodes();
    expect(shown.length).toBeGreaterThan(40);
    const objects = Array.from(parsed.querySelectorAll('foreignObject'));
    expect(objects.length).toBe(shown.length);
    expect(new Set(objects.map(item => item.getAttribute('data-node-id')))).toEqual(new Set(shown.map(node => node.dataset.nodeId)));
    for (const object of objects) {
      const id = object.getAttribute('data-node-id') ?? '';
      const placed = source.layout.nodes.find(node => node.id === id);
      expect(placed).toBeDefined();
      expect(Number(object.getAttribute('x'))).toBeCloseTo(placed?.x ?? NaN, 2);
      expect(Number(object.getAttribute('y'))).toBeCloseTo(placed?.y ?? NaN, 2);
      const inner = object.firstElementChild;
      expect(inner?.namespaceURI).toBe(XHTML_NAMESPACE);
      expect(inner?.classList.contains('mappy-node')).toBe(true);
      expect(inner?.getAttribute('style')).toBe(`width:${placed?.width ?? 0}px;height:${placed?.height ?? 0}px`);
    }
    expect(parsed.querySelectorAll('.mappy-edges path').length).toBe(source.layout.edges.length);
    expect(parsed.querySelectorAll('.mappy-edges path').length).toBe(shown.length - 1);
    const root = parsed.documentElement;
    expect(root.getAttribute('viewBox')).toBe(svgSize(source.layout.bounds, EXPORT_MARGIN).viewBox);
    expect(root.getAttribute('class')).toBe('mappy-export theme-light');
    expect(scene.theme).toBe('light');
    // Interaction state stays on the screen; the labels come along.
    expect(svg).not.toContain('is-selected');
    expect(svg).not.toContain('mappy-node-toggle');
    expect(svg).not.toContain('tabindex');
    expect(Array.from(parsed.querySelectorAll('.mappy-node-label'), label => label.textContent?.trim())).toContain('多数の兄弟');
    expect(mounted.source()).toBe(original);
    expect(mounted.modified()).toBe(0);
  });

  it('reflects a fold: the hidden branch is gone, the count badge is drawn at the fold position, and exportSource waits for the layout frame', async () => {
    const mounted = await mount('uneven-branches');
    const before = mounted.nodes().length;
    mounted.fold('多数の兄弟');
    // No settle: the fold's layout frame is still pending when the export is asked for.
    const { source, scene, parsed } = await exportOf(mounted);
    expect(parsed.querySelectorAll('foreignObject').length).toBe(before - 24);
    expect(source.layout.nodes.length).toBe(before - 24);
    const badges = Array.from(parsed.querySelectorAll('.mappy-fold'));
    expect(badges.length).toBe(1);
    expect(badges[0]?.querySelector('text')?.textContent).toBe('24');
    const collapsed = mounted.nodes().find(node => node.classList.contains('is-collapsed'));
    const fold = source.layout.folds.find(item => item.id === collapsed?.dataset.nodeId);
    expect(fold).toBeDefined();
    expect(scene.badges[0]).toEqual({ x: (fold?.x ?? 0) - foldBadgeWidth(24) / 2, y: (fold?.y ?? 0) - 9, width: foldBadgeWidth(24), height: 18, text: '24' });
    expect(scene.css).toContain('.mappy-fold-pill{');
    // The 24 siblings are not in the file at all.
    expect(Array.from(parsed.querySelectorAll('.mappy-node-label'), label => label.textContent?.trim())).not.toContain('兄弟 1');
    await mounted.settle();
    mounted.fold('多数の兄弟');
    await mounted.settle();
    expect((await exportOf(mounted)).parsed.querySelectorAll('foreignObject').length).toBe(before);
  });

  it('keeps a node whole when its image is missing or unreadable, and embeds readable images as data URLs', async () => {
    const mounted = await mount('uneven-branches');
    const withImages = await exportOf(mounted);
    const images = Array.from(withImages.parsed.querySelectorAll('img'));
    expect(images.length).toBeGreaterThan(0);
    expect(images.length).toBe(mounted.view.containerEl.querySelectorAll('.mappy-node img').length);
    for (const image of images) expect(image.getAttribute('src')?.startsWith('data:image/svg+xml')).toBe(true);
    // The fixture's `![[存在しない画像.png|120]]` never rendered an image; its node is still exported with the link text.
    const labels = (parsed: Document): string[] => Array.from(parsed.querySelectorAll('.mappy-node-label'), label => label.textContent?.trim() ?? '');
    expect(labels(withImages.parsed)).toContain('画像の欠落');
    expect(withImages.parsed.querySelector('.mod-empty')?.textContent).toBe('存在しない画像.png');

    const unreadable = await exportOf(mounted, () => Promise.resolve(null));
    expect(unreadable.parsed.querySelectorAll('img').length).toBe(0);
    const placeholders = Array.from(unreadable.parsed.querySelectorAll('.mappy-export-missing-image'));
    expect(placeholders.length).toBe(images.length);
    expect(placeholders.map(item => item.textContent)).toContain('説明');
    expect(unreadable.parsed.querySelectorAll('foreignObject').length).toBe(withImages.parsed.querySelectorAll('foreignObject').length);
    expect(labels(unreadable.parsed)).toEqual(expect.arrayContaining(['リンクと画像', 'Markdown 形式の画像', '画像の欠落']));

    const failing = await exportOf(mounted, () => Promise.reject(new Error('boom')));
    expect(failing.parsed.querySelectorAll('foreignObject').length).toBe(withImages.parsed.querySelectorAll('foreignObject').length);
    expect(mounted.modified()).toBe(0);
  });

  it('exports the branches of a called map (§5 M12) as ordinary nodes: the called root\'s text on the calling item, its children, their folds (LEV-73)', async () => {
    const map = ['---', 'mappy: true', '---', '## 講座', '- 回復する', '  - 睡眠', '- 記録する', ''].join('\n');
    const source = ['---', 'mappy: true', '---', '## ホスト', '- ![[Called]]', '- 文', ''].join('\n');
    const mounted = await mount('uneven-branches', 'mindmap', source, { 'Called.md': map });
    expect(mounted.view.containerEl.querySelector('.mappy-embed')).toBeNull();
    const { parsed, svg } = await exportOf(mounted);
    const labels = Array.from(parsed.querySelectorAll('.mappy-node-label'), label => label.textContent?.trim());
    // The called map opens with its root's children shown and 回復する folded: 睡眠 is behind the badge.
    expect(labels).toEqual(['ホスト', '講座', '回復する', '記録する', '文']);
    expect(parsed.querySelectorAll('foreignObject')).toHaveLength(5);
    expect(Array.from(parsed.querySelectorAll('.mappy-fold text'), text => text.textContent)).toEqual(['1']);
    const calling = Array.from(parsed.querySelectorAll('.mappy-node')).find(node => node.classList.contains('is-called-root'));
    expect(calling?.querySelector('.mappy-node-call-mark svg')).not.toBeNull();
    expect(calling?.getAttribute('title')).toBe('呼び出し元: Called.md');
    expect(parsed.querySelectorAll('.mappy-node.is-called')).toHaveLength(3);
    expect(parsed.querySelectorAll('.mappy-edges path')).toHaveLength(4);
    expect(svg).not.toContain('mappy-export-embed');
    expect(mounted.modified()).toBe(0);
  });

  it('names the dark theme from the body class and falls back to the theme colours where the DOM has none', async () => {
    document.body.classList.add('theme-dark');
    const mounted = await mount('heading-document');
    const { scene, parsed } = await exportOf(mounted);
    expect(scene.theme).toBe('dark');
    expect(parsed.documentElement.getAttribute('class')).toBe('mappy-export theme-dark');
    // jsdom resolves no theme variables, so the background is the dark fallback and the light one otherwise.
    expect(parsed.querySelector('.mappy-export-background')?.getAttribute('fill')).toBe('#1e1e1e');
    document.body.classList.remove('theme-dark');
    const light = await exportOf(await mount('heading-document'));
    expect(light.parsed.querySelector('.mappy-export-background')?.getAttribute('fill')).toBe('#ffffff');
    expect(light.scene.css).toContain('.mappy-edges path{fill:none;stroke:');
  });

  it.each(['timeline', 'hierarchy'] as const)('exports the %s layout with the same nodes and connectors as the view', async layout => {
    const mounted = await mount('uneven-branches', layout);
    const { source, parsed } = await exportOf(mounted);
    expect(parsed.querySelectorAll('foreignObject').length).toBe(mounted.nodes().length);
    expect(parsed.querySelectorAll('.mappy-edges path').length).toBe(source.layout.edges.length);
    const classes = Array.from(parsed.querySelectorAll('foreignObject > *'), inner => inner.getAttribute('class') ?? '');
    expect(classes.every(value => value.includes(`is-${layout}`))).toBe(true);
  });

  it('refuses while a title is being edited and after the view lost its file', async () => {
    const mounted = await mount('uneven-branches');
    const canvas = mounted.view.containerEl.querySelector<HTMLElement>('.mappy-canvas');
    const target = mounted.nodes().find(node => node.querySelector('.mappy-node-label')?.textContent?.trim() === '空に近い枝');
    target?.click();
    canvas?.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
    expect(mounted.view.containerEl.querySelector('textarea.mappy-inline-input')).not.toBeNull();
    await expect(mounted.view.exportSource()).rejects.toThrow('テキストの編集を確定してから');
    canvas?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const empty = new MindmapView(new WorkspaceLeaf(mounted.app.asApp<App>()) as unknown as ObsidianLeaf, {} as DocumentStore, {} as ViewRouter);
    await expect(empty.exportSource()).rejects.toThrow('マップを開いてから');
  });

  it('cannot rasterise in jsdom, and says so instead of hanging', () => {
    expect(canRasterize()).toBe(false);
  });

  it('reads the DOM before waiting for images, so a refresh that lands meanwhile cannot drop or blank nodes', async () => {
    const mounted = await mount('uneven-branches');
    const before = mounted.nodes().length;
    const source = await mounted.view.exportSource();
    // The resolver stands in for a refresh arriving mid-export: it tears the node layer down while the export waits on it.
    const scene = await captureScene(source, {
      resolveImage: () => {
        for (const node of mounted.nodes()) node.remove();
        return Promise.resolve(null);
      },
    });
    expect(scene.nodes.length).toBe(before);
    expect(scene.nodes.every(node => node.html.includes('mappy-node-label'))).toBe(true);
    expect(parseSvg(buildSvg(scene)).querySelectorAll('foreignObject').length).toBe(before);
  });

  it('runs a pending debounced refresh before exporting, so an edit just made is in the file', async () => {
    const mounted = await mount('uneven-branches');
    const before = mounted.nodes().length;
    const fixture = findFixture('uneven-branches');
    mounted.app.put(fixture?.path ?? '', `${fixture?.source ?? ''}- 直前に足した枝\n`);
    // No settle: the 45 ms refresh timer is still pending.
    const { parsed } = await exportOf(mounted);
    expect(parsed.querySelectorAll('foreignObject').length).toBe(before + 1);
    expect(Array.from(parsed.querySelectorAll('.mappy-node-label'), label => label.textContent?.trim())).toContain('直前に足した枝');
  });

  it('waits for the Markdown renders an external change just started, so the new label and its re-measured size are in the file', async () => {
    const mounted = await mount('uneven-branches');
    const fixture = findFixture('uneven-branches');
    // jsdom has no layout: here a node is as wide as its label text, so a label rendered late widens its node.
    const widthOf = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get(this: HTMLElement) {
      return this.classList.contains('mappy-node') ? 16 + 8 * (this.querySelector('.mappy-node-label')?.textContent?.length ?? 0) : 0;
    } });
    // Obsidian's renderer resolves after its post-processors; the harness one is synchronous, so the delay is put in here.
    const original = MarkdownRenderer.render.bind(MarkdownRenderer);
    const render = vi.spyOn(MarkdownRenderer, 'render').mockImplementation((...args) =>
      new Promise<void>(resolve => { setTimeout(resolve, 60); }).then(() => original(...args)));
    try {
      mounted.app.put(fixture?.path ?? '', `${fixture?.source ?? ''}- 外部変更で足した枝\n`);
      // No settle: the export runs the debounced refresh itself, and the render it starts is still in flight.
      const { source, parsed } = await exportOf(mounted);
      expect(render).toHaveBeenCalled();
      const added = mounted.nodes().find(node => node.getAttribute('aria-label') === '外部変更で足した枝');
      expect(added?.querySelector('.mappy-node-label')?.textContent).toBe('外部変更で足した枝');
      const object = parsed.querySelector(`foreignObject[data-node-id="${added?.dataset.nodeId ?? ''}"]`);
      expect(object?.querySelector('.mappy-node-label')?.textContent?.trim()).toBe('外部変更で足した枝');
      const placed = source.layout.nodes.find(node => node.id === added?.dataset.nodeId);
      expect(placed?.width).toBe(16 + 8 * '外部変更で足した枝'.length);
      expect(object?.firstElementChild?.getAttribute('style')).toBe(`width:${placed?.width ?? 0}px;height:${placed?.height ?? 0}px`);
    } finally {
      render.mockRestore();
      if (widthOf) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', widthOf);
    }
  });

  it('gives up on a render that hangs after EXPORT_RENDER_WAIT_MS and exports what the map shows', async () => {
    const mounted = await mount('uneven-branches');
    const fixture = findFixture('uneven-branches');
    const before = mounted.nodes().length;
    // A render that never resolves (a hung post-processor): the label stays as the renderer left it.
    const render = vi.spyOn(MarkdownRenderer, 'render').mockImplementation(() => new Promise<void>(() => undefined));
    // Only the timers are faked: the view's frames (jsdom's requestAnimationFrame) keep running.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mounted.app.put(fixture?.path ?? '', `${fixture?.source ?? ''}- 描画が終わらない枝\n`);
      let done = false;
      const pending = mounted.view.exportSource().then(source => { done = true; return source; });
      for (let frame = 0; frame < 3; frame += 1) await new Promise(resolve => requestAnimationFrame(resolve));
      expect(render).toHaveBeenCalled();
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(EXPORT_RENDER_WAIT_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const source = await pending;
      expect(source.entries.size).toBe(before + 1);
      const added = mounted.nodes().find(node => node.getAttribute('aria-label') === '描画が終わらない枝');
      expect(added?.querySelector('.mappy-node-label')?.textContent).toBe('');
      expect(source.entries.get(added?.dataset.nodeId ?? '')?.element).toBe(added);
    } finally {
      vi.useRealTimers();
      render.mockRestore();
    }
  });

  it('keeps the file well formed when a title carries a form feed or a renderer put inline SVG with xlink:href into a node', async () => {
    const fixture = findFixture('uneven-branches');
    const mounted = await mount('uneven-branches', 'mindmap', `${fixture?.source ?? ''}- PDF から\u000c貼った文字\n`);
    // The harness renderer escapes markup, so the inline SVG (as MathJax or a theme icon would add it) is put in by hand.
    const label = mounted.nodes().find(node => node.querySelector('.mappy-node-label')?.textContent?.includes('空に近い枝'))?.querySelector('.mappy-node-label');
    label?.insertAdjacentHTML('beforeend', '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><use xlink:href="#g" foo:bar="1"/></svg>');
    expect(label?.querySelector('use')?.getAttribute('xlink:href')).toBe('#g');
    const { svg, parsed } = await exportOf(mounted);
    expect(svg).not.toContain('\u000c');
    expect(Array.from(parsed.querySelectorAll('.mappy-node-label'), label => label.textContent?.trim())).toContain('PDF から貼った文字');
    const use = parsed.querySelector('use');
    expect(use?.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe('#g');
    expect(use?.hasAttribute('foo:bar')).toBe(false);
  });

  it('reports a tainted canvas as "PNG unavailable" and probes it once for the modal', async () => {
    const win = window as unknown as { createEl: (tag: string) => unknown };
    const original = win.createEl;
    const fakeImage = {
      listeners: new Map<string, () => void>(),
      addEventListener(type: string, listener: () => void) { this.listeners.set(type, listener); },
      set src(_value: string) { queueMicrotask(() => { this.listeners.get('load')?.(); }); },
    };
    const fakeCanvas = {
      width: 0, height: 0,
      getContext: () => ({ scale() { /* stub */ }, drawImage() { /* stub */ } }),
      toBlob() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
      toDataURL() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
    };
    win.createEl = (tag: string) => (tag === 'img' ? fakeImage : fakeCanvas);
    try {
      await expect(rasterizeSvg('<svg xmlns="http://www.w3.org/2000/svg"/>', { width: 10, height: 10 }, 1)).rejects.toThrow(PNG_UNAVAILABLE);
      await expect(canRasterizeForeignObject()).resolves.toBe(false);
    } finally {
      win.createEl = original;
    }
  });

  it.each([10, 100, 500, 2000])('completes for the %i-node link-and-image document', async count => {
    const fixture = FIXTURES.find(candidate => candidate.performance?.nodeCount === count && candidate.performance.shape === 'links');
    expect(fixture).toBeDefined();
    const mounted = await mount(fixture?.id ?? '');
    const { svg, parsed, exportMs } = await exportOf(mounted);
    expect(parsed.querySelectorAll('foreignObject').length).toBe(count);
    expect(parsed.querySelectorAll('.mappy-edges path').length).toBe(count - 1);
    expect(parsed.querySelectorAll('img').length).toBe(Math.floor((count - 1) / 5));
    expect(parsed.querySelectorAll('img[src^="data:"]').length).toBe(Math.floor((count - 1) / 5));
    expect(mounted.modified()).toBe(0);
    // Not a performance target (jsdom resolves each computed property slowly); it guards against a hang or a quadratic walk.
    // The browser harness records the real time; see artifacts/.
    expect(exportMs).toBeLessThan(30_000);
    expect(svg.length).toBeGreaterThan(count * 100);
  }, 90_000);
});
