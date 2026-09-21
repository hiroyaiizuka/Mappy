// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, TFile } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { MarkdownRenderer } from '../../harness/browser/obsidian';
import { DocumentStore } from '../../src/obsidian/document-store';
import { OFFSCREEN_CLASS, OFFSCREEN_IMAGE_WAIT_MS, OFFSCREEN_RENDER_STALL_MS, OffscreenMap, paintMap } from '../../src/ui/offscreen-map';

/**
 * §5 M6, the built-in insert routes: a map note drawn without a leaf, as the map view would open it,
 * captured as the export captures a view (§5 M13). The shipped renderer, reader and store run against
 * the browser-harness stand-in for `obsidian`; jsdom does no layout, so the geometry is zero and the
 * structure is what is checked.
 */
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

const MAP = ['---', 'mappy: true', '---', '## 講座', '- 回復する', '  - 睡眠', '    - 昼寝', '  - 運動', '- 記録する', '  - 日誌', '- 葉 <A & B>', ''].join('\n');
const TOPICS = ['---', 'mappy: true', 'mappy-topics:', '  補足: { mindmap: [300, 200] }', '---', '## 講座', '- 回復する', '', '## 補足', '- 用語', ''].join('\n');
const CALLED = ['---', 'mappy: true', '---', '## 呼ばれた', '- 一', '  - 深い', '- 二', ''].join('\n');
const HOST = ['---', 'mappy: true', 'mappy-layout: timeline', '---', '## ホスト', '- ![[Called]]', '- 葉', ''].join('\n');

function vault(files: Record<string, string>): { app: HarnessApp; store: DocumentStore; file: (path: string) => TFile } {
  const app = new HarnessApp();
  const created = new Map<string, TFile>();
  // The product sees Obsidian's `TFile`; at runtime the harness file stands in.
  for (const [path, content] of Object.entries(files)) created.set(path, app.put(path, content) as unknown as TFile);
  const store = new DocumentStore(app.asApp<App>());
  return { app, store, file: path => { const file = created.get(path); if (!file) throw new Error(`no ${path}`); return file; } };
}

function titles(svg: string): string[] {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  return Array.from(parsed.querySelectorAll('foreignObject .mappy-node-label'), label => label.textContent?.trim() ?? '');
}

describe('paintMap', () => {
  it('draws the whole map open, in the light theme, and leaves nothing on the document', async () => {
    const { app, store, file } = vault({ 'Map.md': MAP });
    const painted = await paintMap(app.asApp<App>(), store, file('Map.md'), document);
    expect(painted.stalled).toBe(false);
    expect(painted.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(painted.svg).toContain('class="mappy-export theme-light" data-theme="light" data-nodes="8" data-edges="7"');
    expect(titles(painted.svg)).toEqual(['講座', '回復する', '睡眠', '昼寝', '運動', '記録する', '日誌', '葉 <A & B>']);
    expect(painted.svg).toContain('葉 &lt;A &amp; B&gt;');
    expect(painted.size.width).toBeGreaterThan(0);
    expect(painted.size.height).toBeGreaterThan(0);
    expect(Object.keys(painted.bounds).sort()).toEqual(['height', 'width', 'x', 'y']);
    expect(Object.values(painted.bounds).every(value => Number.isFinite(value))).toBe(true);
    expect(document.querySelector(`.${OFFSCREEN_CLASS}`)).toBeNull();
    expect(document.querySelector('.mappy-node')).toBeNull();
    // Nothing was written: no frontmatter, no attachment, no link opened.
    expect(app.activity).toEqual([]);
    expect(app.content(file('Map.md'))).toBe(MAP);
  });

  it('places a free topic at its stored position and calls another map as the view would, folded below its root\'s children', async () => {
    const { app, store, file } = vault({ 'Topics.md': TOPICS, 'Host.md': HOST, 'Called.md': CALLED });
    const topics = await paintMap(app.asApp<App>(), store, file('Topics.md'), document);
    expect(titles(topics.svg)).toEqual(['講座', '回復する', '補足', '用語']);
    const parsed = new DOMParser().parseFromString(topics.svg, 'image/svg+xml');
    const supplement = Array.from(parsed.querySelectorAll('foreignObject')).find(node => node.textContent?.includes('補足'));
    // The stored position is an offset from the body root's top-left; jsdom's nodes are zero-sized, so it is the position itself.
    expect(supplement?.getAttribute('x')).toBe('300');
    expect(supplement?.getAttribute('y')).toBe('200');

    const host = await paintMap(app.asApp<App>(), store, file('Host.md'), document);
    // The calling item shows the called root's text; 深い stays behind the initial fold of 一.
    expect(titles(host.svg)).toEqual(['ホスト', '呼ばれた', '一', '二', '葉']);
    expect(host.svg).toContain('data-nodes="5"');
    expect(host.svg).toContain('is-called-root');
    expect(host.svg).toContain('class="mappy-folds"');
    expect(app.content(file('Called.md'))).toBe(CALLED);
  });

  it('refuses a note that is not a map, and releases the frame', async () => {
    const { app, store, file } = vault({ 'Plain.md': '## Plain\n- a\n' });
    await expect(paintMap(app.asApp<App>(), store, file('Plain.md'), document)).rejects.toThrow('Plain はマップではありません。');
    expect(document.querySelector(`.${OFFSCREEN_CLASS}`)).toBeNull();
  });

  it('reads the open editor buffer first, as every reader does', async () => {
    const { app, store, file } = vault({ 'Map.md': MAP });
    const read = vi.spyOn(store, 'read');
    await paintMap(app.asApp<App>(), store, file('Map.md'), document);
    expect(read).toHaveBeenCalledWith(file('Map.md'));
  });
});

describe('OffscreenMap', () => {
  it('keeps the frame hidden and inert on the body while it draws, sized as the view, and hands out copied entries', async () => {
    const { app, store, file } = vault({ 'Map.md': MAP });
    const map = new OffscreenMap(app.asApp<App>(), store, document, file('Map.md'));
    map.load();
    const host = document.querySelector<HTMLElement>(`body > .${OFFSCREEN_CLASS}`);
    expect(host?.getAttribute('aria-hidden')).toBe('true');
    expect(host?.querySelector('.mappy-view.theme-light > .mappy-canvas > .mappy-world > .mappy-nodes')).not.toBeNull();
    const { source, stalled } = await map.capture();
    expect(stalled).toBe(false);
    expect(source.layout.nodes).toHaveLength(8);
    expect(source.entries.size).toBe(8);
    expect(source.canvas.closest(`.${OFFSCREEN_CLASS}`)).toBe(host);
    expect(source.edges.querySelectorAll('path')).toHaveLength(7);
    // The entries are a copy: a later draw cannot change what the capture was handed.
    expect(source.entries).not.toBe((map as unknown as { renderer: { entries: unknown } }).renderer.entries);
    map.unload();
    expect(document.querySelector(`.${OFFSCREEN_CLASS}`)).toBeNull();
  });

  it('reports a stalled render and captures the map as far as it got', async () => {
    vi.useFakeTimers();
    try {
      const { app, store, file } = vault({ 'Map.md': MAP });
      const original = MarkdownRenderer.render.bind(MarkdownRenderer);
      // One label never renders: a hung post-processor, as the export meets it.
      vi.spyOn(MarkdownRenderer, 'render').mockImplementation((app, markdown, element, sourcePath) =>
        markdown === '睡眠' ? new Promise<void>(() => undefined) : original(app, markdown, element, sourcePath));
      const map = new OffscreenMap(app.asApp<App>(), store, document, file('Map.md'));
      map.load();
      const capture = map.capture();
      // The other seven labels finish within the first stall window; the wait ends when a whole window passes with none.
      await vi.advanceTimersByTimeAsync(OFFSCREEN_RENDER_STALL_MS * 2 + 100);
      const { source, stalled } = await capture;
      expect(stalled).toBe(true);
      expect(source.layout.nodes).toHaveLength(8);
      // The stalled node is placed with an empty label; the seven others carry their text.
      const labels = Array.from(source.entries.values(), entry => entry.element.querySelector('.mappy-node-label')?.textContent ?? '');
      expect(labels.filter(label => label === '')).toHaveLength(1);
      expect(labels).toContain('昼寝');
      map.unload();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for the images of the nodes no longer than their allowance', async () => {
    vi.useFakeTimers();
    try {
      const { app, store, file } = vault({ 'Map.md': MAP.replace('- 葉 <A & B>', '- 図\n  ![[figure.png]]'), 'figure.png': '' });
      const map = new OffscreenMap(app.asApp<App>(), store, document, file('Map.md'));
      map.load();
      // jsdom never loads an image; the capture must not hang on it.
      vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false);
      const capture = map.capture();
      let settled = false;
      void capture.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(OFFSCREEN_IMAGE_WAIT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const { source } = await capture;
      expect(settled).toBe(true);
      expect(source.entries.size).toBe(8);
      expect(source.canvas.querySelectorAll('img')).toHaveLength(1);
      map.unload();
    } finally {
      vi.useRealTimers();
    }
  });
});
