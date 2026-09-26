// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, MarkdownPostProcessorContext, TFile } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { Component, MarkdownRenderer, MarkdownView, WorkspaceLeaf } from '../../harness/browser/obsidian';
import { DocumentStore } from '../../src/obsidian/document-store';
import { accessibleName } from './accessible-name';
import { EMBED_ANCHOR_CLASS, EMBED_CLAIM_HOLD_MS, EMBED_HOST_CLASS, MapEmbeds } from '../../src/ui/map-embed';

// The browser-harness stand-in for `obsidian`, so the shipped post processor, embed component and renderer run against a real DOM.
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });
/** Every renderer a test loaded; unloading them releases timers and subscriptions so nothing leaks into the next test. */
const renderers: Component[] = [];
afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.unload();
  document.body.replaceChildren();
});

function loadedRenderer(): Component {
  const renderer = new Component();
  renderer.load();
  renderers.push(renderer);
  return renderer;
}

const MAP = ['---', 'mappy: true', '---', '## 講座', '- 回復する', '  - 睡眠', '    - 昼寝', '  - 運動', '- 記録する', '  - 日誌', '- 葉', ''].join('\n');
const HEADINGS = [
  '---', 'mappy: true', 'mappy-layout: hierarchy', '---',
  '# 講座', '', '## 回復する', '### 同じ名前', '#### 深い', '### 休息', '## 記録する', '### 同じ名前', '',
].join('\n');

interface Rendered {
  app: HarnessApp;
  store: DocumentStore;
  embeds: MapEmbeds;
  /** The renderer that owns the children the processor adds; unloading it is Obsidian dropping the section. */
  renderer: Component;
  section: HTMLElement;
  /** Let the file read, the parse and one layout frame run. */
  settle: () => Promise<void>;
  process: (el: HTMLElement, sourcePath: string) => void;
}

function context(renderer: Component, sourcePath: string): MarkdownPostProcessorContext {
  return {
    docId: 'doc', sourcePath, frontmatter: null,
    // The product sees Obsidian's types; at runtime the child is the harness Component.
    addChild: child => { renderer.addChild(child as unknown as Component); },
    getSectionInfo: () => null,
  };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => requestAnimationFrame(resolve));
  await new Promise(resolve => setTimeout(resolve, 0));
}

/** Past the 45 ms debounce of a source change, then a frame. */
async function refreshed(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 60));
  await settle();
}

/** Animation frames one at a time, so a test can move a section between them the way Obsidian attaches its containers. */
async function frames(count: number): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) await new Promise(resolve => window.requestAnimationFrame(resolve));
}

/** Counts the animation frames still waiting to fire, so a test can show a look-again has ended and left nothing scheduled. */
function frameTracker(): { pending: () => number; restore: () => void } {
  const request = window.requestAnimationFrame.bind(window);
  const cancel = window.cancelAnimationFrame.bind(window);
  const waiting = new Set<number>();
  window.requestAnimationFrame = callback => {
    const id = request(time => { waiting.delete(id); callback(time); });
    waiting.add(id);
    return id;
  };
  window.cancelAnimationFrame = id => { waiting.delete(id); cancel(id); };
  return { pending: () => waiting.size, restore: () => { window.requestAnimationFrame = request; window.cancelAnimationFrame = cancel; } };
}

/** Records the timers still pending and lets a test fire the long ones (the wait's time limit) without waiting for them. */
function timerTracker(): { pending: (minDelay?: number) => number; fire: (minDelay: number) => void; restore: () => void } {
  const set = window.setTimeout.bind(window);
  const clear = window.clearTimeout.bind(window);
  // Keyed by whatever the environment's setTimeout returns (a number in browsers, an object under Node).
  const waiting = new Map<unknown, { delay: number; run: () => void }>();
  window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]): number => {
    if (typeof handler !== 'function') return set(handler, delay);
    const callback = handler as (...data: unknown[]) => void;
    const run = (): void => { callback(...args); };
    const id: unknown = set(() => { waiting.delete(id); run(); }, delay);
    waiting.set(id, { delay: delay ?? 0, run });
    return id as number;
  }) as unknown as typeof window.setTimeout;
  window.clearTimeout = id => { waiting.delete(id); clear(id); };
  return {
    pending: (minDelay = 0) => Array.from(waiting.values()).filter(timer => timer.delay >= minDelay).length,
    fire: minDelay => {
      for (const [id, timer] of Array.from(waiting)) {
        if (timer.delay < minDelay) continue;
        waiting.delete(id);
        clear(id as number);
        timer.run();
      }
    },
    restore: () => { window.setTimeout = set; window.clearTimeout = clear; },
  };
}

/** The host note rendered the way Obsidian's reading view hands a section to post processors: `![[…]]` is still a placeholder span. */
async function render(files: Record<string, string>, hostPath: string): Promise<Rendered> {
  const app = new HarnessApp();
  for (const [path, content] of Object.entries(files)) app.put(path, content);
  const store = new DocumentStore(app.asApp<App>());
  const embeds = new MapEmbeds(app.asApp<App>(), store);
  const renderer = loadedRenderer();
  const section = document.body.createDiv({ cls: 'markdown-preview-section' });
  await MarkdownRenderer.render(app.asApp<App>(), files[hostPath] ?? '', section, hostPath);
  const process = (el: HTMLElement, sourcePath: string): void => { embeds.process(el, context(renderer, sourcePath)); };
  process(section, hostPath);
  await settle();
  return { app, store, embeds, renderer, section, settle, process };
}

/** Visible node titles in layout order (left to right, then top to bottom); the DOM keeps insertion order. */
function titles(root: ParentNode): string[] {
  const position = (node: HTMLElement): [number, number] => {
    const match = node.style.transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/u);
    return [Number(match?.[1] ?? 0), Number(match?.[2] ?? 0)];
  };
  return Array.from(root.querySelectorAll<HTMLElement>('.mappy-node'))
    .map(node => ({ node, at: position(node) }))
    .sort((left, right) => left.at[0] - right.at[0] || left.at[1] - right.at[1])
    .map(({ node }) => node.querySelector('.mappy-node-label')?.textContent?.trim() ?? '');
}

/** The same visible nodes, whatever their order on the canvas. */
function sameTitles(root: ParentNode, expected: string[]): void {
  expect([...titles(root)].sort()).toEqual([...expected].sort());
}

function nodeByTitle(root: ParentNode, title: string): HTMLElement {
  const node = Array.from(root.querySelectorAll<HTMLElement>('.mappy-node')).find(candidate => candidate.querySelector('.mappy-node-label')?.textContent?.trim() === title);
  if (!node) throw new Error(`No node ${title}`);
  return node;
}

function fileOf(app: HarnessApp, path: string): TFile {
  const file = app.vault.getAbstractFileByPath(path);
  if (!file) throw new Error(`No file ${path}`);
  return file as unknown as TFile;
}

describe('MapEmbeds in the reading view (host sections)', () => {
  it('replaces the placeholder of a map note with a read-only map: roots and first level shown, deeper levels folded with counts', async () => {
    const { section, embeds } = await render({ 'Host.md': '前置き\n\n![[Map]]\n\n後書き', 'Map.md': MAP }, 'Host.md');
    expect(section.querySelector('.internal-embed')).toBeNull();
    const embed = section.querySelector<HTMLElement>('.mappy-embed');
    expect(embed?.hasClass('mappy-view')).toBe(true);
    expect(embed?.getAttribute('aria-label')).toBe('マインドマップ: Map');
    expect(titles(section)).toEqual(['講座', '回復する', '記録する', '葉']);
    const folded = nodeByTitle(section, '回復する');
    expect(folded.hasClass('is-collapsed')).toBe(true);
    expect(folded.querySelector('.mappy-node-toggle-mark')?.textContent).toBe('3');
    expect(nodeByTitle(section, '講座').hasClass('is-root')).toBe(true);
    expect(nodeByTitle(section, '記録する').hasClass('is-stage')).toBe(true);
    expect(section.querySelectorAll('.mappy-edges path')).toHaveLength(3);
    // Nothing editable: no inline input, nodes are not in the tab order, the frame says so.
    expect(section.querySelector('textarea, [contenteditable]')).toBeNull();
    expect(nodeByTitle(section, '講座').getAttribute('tabindex')).toBe('-1');
    // The embed draws its nodes through the same renderer: named for screen readers, no tooltip over the node below (LEV-199).
    for (const node of section.querySelectorAll<HTMLElement>('.mappy-node')) {
      expect(node.hasAttribute('aria-label')).toBe(false);
      expect(node.hasAttribute('aria-labelledby')).toBe(true);
      expect(accessibleName(node)).toBe(node.querySelector('.mappy-node-label')?.textContent?.trim());
    }
    expect(embed?.querySelector('.mappy-canvas')?.getAttribute('aria-readonly')).toBe('true');
    expect(section.textContent).toContain('前置き');
    expect(section.textContent).toContain('後書き');
    expect(embeds.size).toBe(1);
  });

  it('lets the reader unfold and fold again by clicking the toggle, without touching the note', async () => {
    const { section, settle: wait, app } = await render({ 'Host.md': '![[Map]]', 'Map.md': MAP }, 'Host.md');
    const toggle = nodeByTitle(section, '回復する').querySelector<HTMLElement>('.mappy-node-toggle');
    toggle?.click();
    await wait();
    sameTitles(section, ['講座', '回復する', '睡眠', '運動', '記録する', '葉']);
    expect(nodeByTitle(section, '睡眠').hasClass('is-collapsed')).toBe(true);
    expect(nodeByTitle(section, '睡眠').querySelector('.mappy-node-toggle-mark')?.textContent).toBe('1');
    toggle?.click();
    await wait();
    expect(titles(section)).toEqual(['講座', '回復する', '記録する', '葉']);
    expect(app.content(fileOf(app, 'Map.md'))).toBe(MAP);
  });

  it('leaves every embed that is not a map to Obsidian', async () => {
    const files = {
      'Host.md': '![[Plain]] ![[Quoted]] ![[Missing]] ![[Map#^block]] ![[Map#a#^b]] ![[image.png]] ![[Drawing]]',
      'Plain.md': '## Plain\n- a\n',
      'Quoted.md': '---\nmappy: "true"\n---\n## Quoted\n',
      'Drawing.md': '---\nmappy: true\nexcalidraw-plugin: parsed\n---\n',
      'Map.md': MAP,
    };
    const { section, embeds } = await render(files, 'Host.md');
    expect(Array.from(section.querySelectorAll('.internal-embed'), span => span.getAttribute('src')))
      .toEqual(['Plain', 'Quoted', 'Missing', 'Map#^block', 'Map#a#^b', 'image.png', 'Drawing']);
    expect(section.querySelector('.mappy-embed')).toBeNull();
    expect(embeds.size).toBe(0);
  });

  it('draws the subtree of the first heading of that name for `#heading`, and a sentence for a heading that does not exist', async () => {
    const { section } = await render({ 'Host.md': '![[Map#同じ名前]]\n\n![[Map#存在しない]]', 'Map.md': HEADINGS }, 'Host.md');
    const frames = section.querySelectorAll<HTMLElement>('.mappy-embed');
    expect(frames).toHaveLength(2);
    const first = frames[0];
    const second = frames[1];
    if (!first || !second) throw new Error('two frames expected');
    expect(titles(first)).toEqual(['同じ名前', '深い']);
    expect(nodeByTitle(first, '同じ名前').hasClass('is-root')).toBe(true);
    expect(nodeByTitle(first, '深い').hasClass('is-hierarchy')).toBe(true);
    expect(first.getAttribute('aria-label')).toBe('マインドマップ: Map › 同じ名前');
    expect(titles(second)).toEqual([]);
    expect(second.querySelector('.mappy-embed-message')?.textContent).toBe('Map に見出し「存在しない」が見つかりません。');
    expect(second.querySelector<HTMLElement>('.mappy-canvas')?.hidden).toBe(true);
  });

  it("follows the note's own mappy-layout and shows its free topics", async () => {
    const timeline = ['---', 'mappy: true', 'mappy-layout: timeline', 'mappy-topics:', '  補足: { timeline: [40, 200] }', '---',
      '## 本体', '- 一', '', '## 補足', '- 二', ''].join('\n');
    const { section } = await render({ 'Host.md': '![[Timeline]]', 'Timeline.md': timeline }, 'Host.md');
    sameTitles(section, ['本体', '一', '補足', '二']);
    expect(nodeByTitle(section, '一').hasClass('is-timeline')).toBe(true);
    expect(nodeByTitle(section, '補足').hasClass('is-topic')).toBe(true);
  });

  it('writes neither the host nor the source note', async () => {
    const host = '# Host\n\n![[Map]]\n';
    const { app, section } = await render({ 'Host.md': host, 'Map.md': MAP }, 'Host.md');
    expect(section.querySelector('.mappy-embed')).not.toBeNull();
    expect(app.content(fileOf(app, 'Host.md'))).toBe(host);
    expect(app.content(fileOf(app, 'Map.md'))).toBe(MAP);
    expect(app.activity.filter(entry => entry.kind === 'frontmatter')).toEqual([]);
  });

  it('redraws when the source note is saved, and when it is edited in another leaf before saving', async () => {
    const { app, section } = await render({ 'Host.md': '![[Map]]', 'Map.md': MAP }, 'Host.md');
    const file = fileOf(app, 'Map.md');
    app.put('Map.md', MAP.replace('- 葉', '- 新しい葉'));
    await refreshed();
    expect(titles(section)).toEqual(['講座', '回復する', '記録する', '新しい葉']);
    // An editor buffer of the source note is read before the disk, as the map view does (§4).
    const leaf = new WorkspaceLeaf(app.asApp<App>());
    const view = new MarkdownView(leaf);
    view.file = file;
    let buffer = MAP.replace('- 葉', '- 入力中');
    Object.assign(view, { editor: { getValue: () => buffer, offsetToPos: () => ({ line: 0, ch: 0 }), transaction: () => undefined } });
    app.workspace.getLeavesOfType = () => [{ view }];
    app.workspaceEvents.trigger('editor-change', {}, { file });
    await refreshed();
    expect(titles(section)).toEqual(['講座', '回復する', '記録する', '入力中']);
    buffer = MAP.replace('- 葉', '- 二打目');
    app.workspaceEvents.trigger('editor-change', {}, { file });
    await refreshed();
    expect(titles(section)).toEqual(['講座', '回復する', '記録する', '二打目']);
    expect(app.content(file)).toBe(MAP.replace('- 葉', '- 新しい葉'));
  });

  it("keeps the reader's folds across an edit and folds a branch that is new to the first level", async () => {
    const { app, section, settle: wait } = await render({ 'Host.md': '![[Map]]', 'Map.md': MAP }, 'Host.md');
    nodeByTitle(section, '回復する').querySelector<HTMLElement>('.mappy-node-toggle')?.click();
    await wait();
    app.put('Map.md', MAP.replace('- 葉\n', '- 葉\n- 追加\n  - 追加の子\n'));
    await refreshed();
    sameTitles(section, ['講座', '回復する', '睡眠', '運動', '記録する', '葉', '追加']);
    expect(nodeByTitle(section, '追加').hasClass('is-collapsed')).toBe(true);
  });

  it('keeps the reader\'s folds through a sentence, so a transient bad read does not close every branch', async () => {
    const { app, section } = await render({ 'Host.md': '![[Map]]', 'Map.md': MAP }, 'Host.md');
    nodeByTitle(section, '回復する').querySelector<HTMLElement>('.mappy-node-toggle')?.click();
    await settle();
    sameTitles(section, ['講座', '回復する', '睡眠', '運動', '記録する', '葉']);
    // The closing `---` is gone for a moment while the note is edited elsewhere: not a map until it is back.
    app.put('Map.md', MAP.replace('mappy: true\n---\n', 'mappy: true\n'));
    await refreshed();
    expect(titles(section)).toEqual([]);
    expect(section.querySelector('.mappy-embed-message')?.textContent).toContain('マップではなくなりました');
    app.put('Map.md', MAP);
    await refreshed();
    sameTitles(section, ['講座', '回復する', '睡眠', '運動', '記録する', '葉']);
    expect(section.querySelector<HTMLElement>('.mappy-embed-message')?.hidden).toBe(true);
  });

  it('shows a sentence instead of a map once the note stops being one', async () => {
    const { app, section } = await render({ 'Host.md': '![[Map]]', 'Map.md': MAP }, 'Host.md');
    app.put('Map.md', MAP.replace('mappy: true', 'mappy: false'));
    await refreshed();
    expect(titles(section)).toEqual([]);
    expect(section.querySelector('.mappy-embed-message')?.textContent).toContain('マップではなくなりました');
  });

  it('releases the component, its DOM subscriptions, its vault/workspace listeners and its store listener when the section goes', async () => {
    const { app, renderer, section, embeds, store } = await render({ 'Host.md': '![[Map]]', 'Map.md': MAP }, 'Host.md');
    expect(app.vaultEvents.count()).toBeGreaterThan(0);
    expect(app.workspaceEvents.count()).toBeGreaterThan(0);
    const writeListeners = (store as unknown as { writeListeners: Set<unknown> }).writeListeners;
    expect(writeListeners.size).toBe(1);
    renderer.unload();
    expect(embeds.size).toBe(0);
    expect(app.vaultEvents.count()).toBe(0);
    expect(app.workspaceEvents.count()).toBe(0);
    expect(writeListeners.size).toBe(0);
    expect(section.querySelector('.mappy-node')).toBeNull();
    // A later change of the source is nobody's business any more.
    app.put('Map.md', MAP.replace('- 葉', '- 後で'));
    await refreshed();
    expect(section.querySelector('.mappy-node')).toBeNull();
  });

  it('claims a span Obsidian loaded first instead of swapping it out, and its inner sections do not mount a second map', async () => {
    const app = new HarnessApp();
    app.put('Host.md', '![[Map]]');
    app.put('Map.md', MAP);
    const embeds = new MapEmbeds(app.asApp<App>(), new DocumentStore(app.asApp<App>()));
    const renderer = loadedRenderer();
    const section = document.body.createDiv({ cls: 'markdown-preview-section' });
    await MarkdownRenderer.render(app.asApp<App>(), '![[Map]]', section, 'Host.md');
    const span = section.querySelector<HTMLElement>('.internal-embed');
    if (!span) throw new Error('no span');
    // Obsidian's embed loader ran before this processor: the span carries the note's rendering and its component.
    span.addClass('markdown-embed', 'inline-embed', 'is-loaded');
    span.empty();
    const inner = span.createDiv({ cls: 'markdown-embed-content' }).createDiv({ cls: 'markdown-preview-view' });
    const innerSection = inner.createDiv();
    await MarkdownRenderer.render(app.asApp<App>(), '- 回復する', innerSection, 'Map.md');
    embeds.process(section, context(renderer, 'Host.md'));
    await settle();
    expect(span.isConnected).toBe(true);
    expect(span.hasClass(EMBED_HOST_CLASS)).toBe(true);
    expect(span.querySelectorAll(':scope > .mappy-embed')).toHaveLength(1);
    expect(embeds.size).toBe(1);
    embeds.process(innerSection, context(renderer, 'Map.md'));
    await settle();
    expect(embeds.size).toBe(1);
    expect(span.querySelectorAll('.mappy-embed')).toHaveLength(1);
  });

  it('redraws the reading views that held a map when the plugin unloads, found by the frame and not by a path', async () => {
    const { app, section, embeds } = await render({ 'Host.md': '![[Plain]]', 'Plain.md': '# Plain\n\n![[Map]]\n', 'Map.md': MAP }, 'Host.md');
    // Host embeds Plain, which embeds Map: Obsidian renders Plain's sections with Plain as the source path.
    const plainSpan = section.querySelector<HTMLElement>('.internal-embed[src="Plain"]');
    if (!plainSpan) throw new Error('no Plain span');
    const plainSection = plainSpan.createDiv({ cls: 'markdown-embed-content' }).createDiv();
    await MarkdownRenderer.render(app.asApp<App>(), '![[Map]]', plainSection, 'Plain.md');
    embeds.process(plainSection, context(loadedRenderer(), 'Plain.md'));
    await settle();
    expect(embeds.size).toBe(1);
    const rerender = vi.fn();
    const hostView = Object.assign(new MarkdownView(new WorkspaceLeaf(app.asApp<App>())), {
      getMode: () => 'preview', previewMode: { rerender },
    });
    hostView.containerEl.append(section);
    const otherView = Object.assign(new MarkdownView(new WorkspaceLeaf(app.asApp<App>())), {
      getMode: () => 'preview', previewMode: { rerender: vi.fn() },
    });
    app.workspace.getLeavesOfType = () => [{ view: hostView }, { view: otherView }];
    embeds.dispose();
    expect(rerender).toHaveBeenCalledWith(true);
    expect((otherView as unknown as { previewMode: { rerender: ReturnType<typeof vi.fn> } }).previewMode.rerender).not.toHaveBeenCalled();
    expect(embeds.size).toBe(0);
  });

  it("puts Obsidian's placeholder back when the plugin unloads, so the plain embed can take over", async () => {
    const { section, embeds } = await render({ 'Host.md': '![[Map]] and ![[Map#講座]]', 'Map.md': MAP }, 'Host.md');
    expect(section.querySelectorAll('.mappy-embed')).toHaveLength(2);
    embeds.dispose();
    expect(section.querySelector('.mappy-embed')).toBeNull();
    expect(Array.from(section.querySelectorAll('.internal-embed'), span => span.getAttribute('src'))).toEqual(['Map', 'Map#講座']);
    expect(embeds.size).toBe(0);
  });

  it('opens the source note from the host when the open button is clicked, and links inside nodes from the source note', async () => {
    const map = MAP.replace('- 葉', '- 葉 [[Other]]');
    const { app, section } = await render({ 'Host.md': '![[Map]]', 'Map.md': map, 'Other.md': '# Other' }, 'Host.md');
    section.querySelector<HTMLElement>('.mappy-embed-open')?.click();
    expect(app.activity.at(-1)).toMatchObject({ kind: 'link', detail: 'Map.md（Host.md から）' });
    const anchor = section.querySelector<HTMLAnchorElement>('.mappy-node a.internal-link');
    expect(anchor?.dataset.href).toBe('Other');
    anchor?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(app.activity.at(-1)).toMatchObject({ kind: 'link', detail: 'Other（Map.md から）' });
  });

  it('fits the whole map into the frame and never magnifies past 100%', async () => {
    const { section, settle: wait } = await render({ 'Host.md': '![[Map]]', 'Map.md': MAP }, 'Host.md');
    const canvas = section.querySelector<HTMLElement>('.mappy-canvas');
    if (!canvas) throw new Error('no canvas');
    Object.defineProperty(canvas, 'clientWidth', { value: 600, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { value: 320, configurable: true });
    nodeByTitle(section, '回復する').querySelector<HTMLElement>('.mappy-node-toggle')?.click();
    await wait();
    const world = section.querySelector<HTMLElement>('.mappy-world');
    const match = (world?.style.transform ?? '').match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/u);
    expect(match).not.toBeNull();
    expect(Number(match?.[3])).toBeLessThanOrEqual(1);
    expect(Number(match?.[3])).toBeGreaterThan(0);
  });

  it("does not recurse: a note embedding itself stays Obsidian's, and a node title embedding another map renders as a link", async () => {
    const a = ['---', 'mappy: true', '---', '## A', '- ![[B]]', '- ![[image.png]]', ''].join('\n');
    const b = ['---', 'mappy: true', '---', '## B', '- ![[A]]', ''].join('\n');
    const self = await render({ 'A.md': `${a}\n![[A]]\n`, 'B.md': b }, 'A.md');
    expect(self.section.querySelector('.internal-embed[src="A"]')).not.toBeNull();
    expect(self.section.querySelectorAll('.mappy-embed')).toHaveLength(1);
    expect(self.embeds.size).toBe(1);
    const host = await render({ 'Host.md': '![[A]]', 'A.md': a, 'B.md': b, 'image.png': '' }, 'Host.md');
    expect(host.embeds.size).toBe(1);
    const labels = Array.from(host.section.querySelectorAll<HTMLElement>('.mappy-node-label'));
    expect(labels.map(label => label.textContent?.trim())).toEqual(['A', 'B', '']);
    expect(labels[2]?.querySelector('.image-embed img')).not.toBeNull();
    expect(labels[1]?.querySelector<HTMLAnchorElement>('a.internal-link')?.dataset.href).toBe('B');
    expect(labels[1]?.querySelector('.internal-embed')).toBeNull();
    // Sections rendered inside a map node are never hosts themselves.
    const inner = labels[1]?.createDiv();
    if (!inner) throw new Error('no label');
    await MarkdownRenderer.render(host.app.asApp<App>(), '![[B]]', inner, 'A.md');
    host.process(inner, 'A.md');
    await host.settle();
    expect(host.embeds.size).toBe(1);
    expect(inner.querySelector('.internal-embed')).not.toBeNull();
  });
});

describe("MapEmbeds in live preview (the embedded note's own sections)", () => {
  /** Obsidian's embed container as the live-preview widget builds it, with the map note already rendered inside; a `block` off the document keeps the container detached. */
  async function container(app: HarnessApp, src: string, mapPath: string, block: HTMLElement = document.body.createDiv({ cls: 'cm-embed-block' })): Promise<{ span: HTMLElement; sections: HTMLElement[] }> {
    const span = block.createSpan({ cls: 'internal-embed markdown-embed inline-embed is-loaded', attr: { src } });
    const content = span.createDiv({ cls: 'markdown-embed-content' });
    const preview = content.createDiv({ cls: 'markdown-preview-view markdown-rendered' });
    const sections: HTMLElement[] = [];
    for (const block of app.content(fileOf(app, mapPath)).split(/\n{2,}/u)) {
      const section = preview.createDiv();
      await MarkdownRenderer.render(app.asApp<App>(), block, section, mapPath);
      sections.push(section);
    }
    return { span, sections };
  }

  it("claims the container once from any of its sections, hides Obsidian's rendering and appends the map", async () => {
    const app = new HarnessApp();
    app.put('Map.md', HEADINGS);
    const embeds = new MapEmbeds(app.asApp<App>(), new DocumentStore(app.asApp<App>()));
    const renderer = loadedRenderer();
    const { span, sections } = await container(app, 'Map#記録する', 'Map.md');
    for (const section of sections) embeds.process(section, context(renderer, 'Map.md'));
    await settle();
    expect(span.hasClass(EMBED_HOST_CLASS)).toBe(true);
    expect(span.hasClass('markdown-embed')).toBe(false);
    expect(span.querySelectorAll(':scope > .mappy-embed')).toHaveLength(1);
    expect(titles(span)).toEqual(['記録する', '同じ名前']);
    expect(embeds.size).toBe(1);
    // Obsidian's own content is still there for it to update; the stylesheet hides it.
    expect(span.querySelector('.markdown-embed-content')).not.toBeNull();
    // The lifecycle rides on an anchor inside the section Obsidian rendered, which is what it watches; the frame sits beside the content.
    const anchors = span.querySelectorAll(`.${EMBED_ANCHOR_CLASS}`);
    expect(anchors).toHaveLength(1);
    expect(sections.some(section => section.contains(anchors[0] ?? null))).toBe(true);
    expect(span.querySelector('.markdown-embed-content .mappy-embed')).toBeNull();
    renderer.unload();
    expect(span.querySelector(`.${EMBED_ANCHOR_CLASS}`)).toBeNull();
    expect(span.hasClass(EMBED_HOST_CLASS)).toBe(false);
    expect(span.hasClass('markdown-embed')).toBe(true);
    expect(span.querySelector('.mappy-embed')).toBeNull();
    expect(app.vaultEvents.count()).toBe(0);
  });

  it('draws a map embedded by an ordinary note that is itself embedded, but nothing inside a claimed container', async () => {
    const app = new HarnessApp();
    app.put('Map.md', MAP);
    app.put('Plain.md', '# Plain\n\n![[Map]]\n');
    const embeds = new MapEmbeds(app.asApp<App>(), new DocumentStore(app.asApp<App>()));
    const renderer = loadedRenderer();
    // Obsidian rendering Plain inside the host's `![[Plain]]` container: its section carries the map's placeholder.
    const { sections } = await container(app, 'Plain', 'Plain.md');
    for (const section of sections) embeds.process(section, context(renderer, 'Plain.md'));
    await settle();
    expect(embeds.size).toBe(1);
    expect(titles(document.body)).toEqual(['講座', '回復する', '記録する', '葉']);
    // A placeholder inside a claimed container is Obsidian's hidden rendering of the map note; it never becomes a second map.
    const claimed = await container(app, 'Map', 'Map.md');
    for (const section of claimed.sections) embeds.process(section, context(renderer, 'Map.md'));
    await settle();
    const hidden = claimed.span.querySelector('.markdown-embed-content')?.createDiv();
    if (!hidden) throw new Error('no content');
    await MarkdownRenderer.render(app.asApp<App>(), '![[Plain]]', hidden, 'Map.md');
    embeds.process(hidden, context(renderer, 'Map.md'));
    await settle();
    expect(embeds.size).toBe(2);
    expect(hidden.querySelector('.internal-embed')).not.toBeNull();
  });

  it("leaves the note's own reading view alone and stops waiting once a detached section joins it", async () => {
    const app = new HarnessApp();
    app.put('Map.md', MAP);
    const embeds = new MapEmbeds(app.asApp<App>(), new DocumentStore(app.asApp<App>()));
    const renderer = loadedRenderer();
    const view = document.body.createDiv({ cls: 'markdown-preview-view' });
    const own = view.createDiv();
    await MarkdownRenderer.render(app.asApp<App>(), '- 回復する', own, 'Map.md');
    embeds.process(own, context(renderer, 'Map.md'));
    await settle();
    expect(embeds.size).toBe(0);
    // A detached section that joins the note's own view is not an embed either; the wait ends there.
    const detached = createDiv();
    await MarkdownRenderer.render(app.asApp<App>(), '- 記録する', detached, 'Map.md');
    embeds.process(detached, context(renderer, 'Map.md'));
    expect(embeds.pending).toBe(1);
    view.append(detached);
    await settle();
    expect(embeds.pending).toBe(0);
    expect(embeds.size).toBe(0);
    expect(detached.querySelector(`.${EMBED_ANCHOR_CLASS}`)).toBeNull();
    const { span } = await container(app, 'Map', 'Map.md');
    const late = createDiv();
    await MarkdownRenderer.render(app.asApp<App>(), '- 記録する', late, 'Map.md');
    embeds.process(late, context(renderer, 'Map.md'));
    span.querySelector('.markdown-preview-view')?.append(late);
    await settle();
    expect(span.hasClass(EMBED_HOST_CLASS)).toBe(true);
    expect(embeds.size).toBe(1);
  });

  it('claims a section that arrives detached and whose container joins the document two frames later, as Obsidian 1.6.7 attaches it 17–28 ms after the section (LEV-91)', async () => {
    const app = new HarnessApp();
    app.put('Map.md', MAP);
    const embeds = new MapEmbeds(app.asApp<App>(), new DocumentStore(app.asApp<App>()));
    const renderer = loadedRenderer();
    // The section reaches the processor on its own; the container it will sit in is not on the document yet.
    const block = createDiv({ cls: 'cm-embed-block' });
    const { span } = await container(app, 'Map', 'Map.md', block);
    const late = createDiv();
    await MarkdownRenderer.render(app.asApp<App>(), '- 記録する', late, 'Map.md');
    const timers = timerTracker();
    try {
      embeds.process(late, context(renderer, 'Map.md'));
      // While it waits, a hidden anchor inside the section carries the wait's lifecycle, as the map's own anchor will; the hold is one timer.
      expect(embeds.pending).toBe(1);
      expect(timers.pending(EMBED_CLAIM_HOLD_MS)).toBe(1);
      expect(late.querySelectorAll<HTMLElement>(`.${EMBED_ANCHOR_CLASS}`)).toHaveLength(1);
      expect(late.querySelector<HTMLElement>(`.${EMBED_ANCHOR_CLASS}`)?.hidden).toBe(true);
      await frames(1);
      span.querySelector('.markdown-preview-view')?.append(late);
      await frames(1);
      expect(span.hasClass(EMBED_HOST_CLASS)).toBe(false);
      document.body.append(block);
      await settle();
      expect(span.hasClass(EMBED_HOST_CLASS)).toBe(true);
      expect(span.querySelectorAll(':scope > .mappy-embed')).toHaveLength(1);
      expect(titles(span)).toEqual(['講座', '回復する', '記録する', '葉']);
      expect(embeds.size).toBe(1);
      expect(embeds.pending).toBe(0);
      expect(timers.pending(EMBED_CLAIM_HOLD_MS)).toBe(0);
      expect(late.querySelectorAll(`.${EMBED_ANCHOR_CLASS}`)).toHaveLength(1);
      renderer.unload();
      expect(embeds.size).toBe(0);
      expect(app.vaultEvents.count()).toBe(0);
      expect(late.querySelector(`.${EMBED_ANCHOR_CLASS}`)).toBeNull();
    } finally { timers.restore(); }
  });

  it('waits without polling, through one watcher of the document for every section, for a container that joins seconds later (an embed below the fold is attached when scrolled to)', async () => {
    const app = new HarnessApp();
    app.put('Map.md', MAP);
    const embeds = new MapEmbeds(app.asApp<App>(), new DocumentStore(app.asApp<App>()));
    const renderer = loadedRenderer();
    const first = createDiv({ cls: 'cm-embed-block' });
    const second = createDiv({ cls: 'cm-embed-block' });
    const one = await container(app, 'Map', 'Map.md', first);
    const two = await container(app, 'Map#講座', 'Map.md', second);
    const sections = [createDiv(), createDiv()];
    for (const section of sections) await MarkdownRenderer.render(app.asApp<App>(), '- 記録する', section, 'Map.md');
    const tracker = frameTracker();
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    try {
      for (const section of sections) embeds.process(section, context(renderer, 'Map.md'));
      one.span.querySelector('.markdown-preview-view')?.append(sections[0] ?? '');
      two.span.querySelector('.markdown-preview-view')?.append(sections[1] ?? '');
      expect(embeds.pending).toBe(2);
      expect(observe).toHaveBeenCalledTimes(1);
      expect(observe.mock.calls[0]?.[0]).toBe(document.documentElement);
      // Far longer than any frame budget would have allowed for, and not one frame is scheduled meanwhile.
      await frames(40);
      expect(tracker.pending()).toBe(0);
      expect(embeds.pending).toBe(2);
      expect(one.span.hasClass(EMBED_HOST_CLASS)).toBe(false);
      document.body.append(first);
      await settle();
      expect(one.span.hasClass(EMBED_HOST_CLASS)).toBe(true);
      expect(embeds.pending).toBe(1);
      expect(disconnect).not.toHaveBeenCalled();
      document.body.append(second);
      await settle();
      expect(two.span.hasClass(EMBED_HOST_CLASS)).toBe(true);
      expect(titles(two.span)).toEqual(['講座', '回復する', '記録する', '葉']);
      expect(two.span.querySelector('.mappy-embed')?.getAttribute('aria-label')).toBe('マインドマップ: Map › 講座');
      expect(embeds.size).toBe(2);
      expect(embeds.pending).toBe(0);
      // Nothing waits any more: the watcher is gone until the next detached section.
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      observe.mockRestore();
      disconnect.mockRestore();
      tracker.restore();
    }
  });

  it('keeps a section past the hold only through Obsidian: a container that joins later is still claimed, and an unloaded section is let go', async () => {
    const app = new HarnessApp();
    app.put('Map.md', MAP);
    const embeds = new MapEmbeds(app.asApp<App>(), new DocumentStore(app.asApp<App>()));
    const renderer = loadedRenderer();
    const block = createDiv({ cls: 'cm-embed-block' });
    const { span } = await container(app, 'Map', 'Map.md', block);
    const late = createDiv();
    await MarkdownRenderer.render(app.asApp<App>(), '- 記録する', late, 'Map.md');
    const tracker = frameTracker();
    const timers = timerTracker();
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    try {
      embeds.process(late, context(renderer, 'Map.md'));
      span.querySelector('.markdown-preview-view')?.append(late);
      expect(timers.pending(EMBED_CLAIM_HOLD_MS)).toBe(1);
      expect(embeds.pending).toBe(1);
      // The hold ends: the plugin no longer counts or holds the section, but the anchor stays for a later join.
      timers.fire(EMBED_CLAIM_HOLD_MS);
      expect(timers.pending(EMBED_CLAIM_HOLD_MS)).toBe(0);
      expect(embeds.pending).toBe(0);
      expect(tracker.pending()).toBe(0);
      expect(late.querySelectorAll(`.${EMBED_ANCHOR_CLASS}`)).toHaveLength(1);
      expect(disconnect).not.toHaveBeenCalled();
      document.body.append(block);
      await settle();
      expect(span.hasClass(EMBED_HOST_CLASS)).toBe(true);
      expect(embeds.size).toBe(1);
      expect(disconnect).toHaveBeenCalledTimes(1);
      // A discarded rendering: past the hold, Obsidian unloading the section is what ends its wait.
      const dropped = createDiv({ cls: 'cm-embed-block' });
      const other = await container(app, 'Map#記録する', 'Map.md', dropped);
      const discarded = createDiv();
      await MarkdownRenderer.render(app.asApp<App>(), '- 葉', discarded, 'Map.md');
      const droppedRenderer = loadedRenderer();
      embeds.process(discarded, context(droppedRenderer, 'Map.md'));
      other.span.querySelector('.markdown-preview-view')?.append(discarded);
      timers.fire(EMBED_CLAIM_HOLD_MS);
      expect(embeds.pending).toBe(0);
      droppedRenderer.unload();
      expect(discarded.querySelector(`.${EMBED_ANCHOR_CLASS}`)).toBeNull();
      expect(disconnect).toHaveBeenCalledTimes(2);
      document.body.append(dropped);
      await settle();
      expect(other.span.hasClass(EMBED_HOST_CLASS)).toBe(false);
      expect(embeds.size).toBe(1);
    } finally {
      disconnect.mockRestore();
      timers.restore();
      tracker.restore();
    }
  });

  it('waits and claims even when the renderer never loads its component, since nothing depends on onload', async () => {
    const app = new HarnessApp();
    app.put('Map.md', MAP);
    const embeds = new MapEmbeds(app.asApp<App>(), new DocumentStore(app.asApp<App>()));
    // Another plugin's `MarkdownRenderer.render(…, component)` with a component it never loads: `addChild` does not load the child.
    const unloaded = new Component();
    const block = createDiv({ cls: 'cm-embed-block' });
    const { span } = await container(app, 'Map', 'Map.md', block);
    const late = createDiv();
    await MarkdownRenderer.render(app.asApp<App>(), '- 記録する', late, 'Map.md');
    const timers = timerTracker();
    try {
      embeds.process(late, context(unloaded, 'Map.md'));
      span.querySelector('.markdown-preview-view')?.append(late);
      expect(embeds.pending).toBe(1);
      expect(timers.pending(EMBED_CLAIM_HOLD_MS)).toBe(1);
      document.body.append(block);
      await settle();
      expect(span.hasClass(EMBED_HOST_CLASS)).toBe(true);
      expect(embeds.pending).toBe(0);
      expect(timers.pending(EMBED_CLAIM_HOLD_MS)).toBe(0);
    } finally { timers.restore(); }
  });


  it('does not claim from a section that lands inside a map drawn in an ordinary note embed (a node label rendered late)', async () => {
    const app = new HarnessApp();
    app.put('Map.md', MAP);
    app.put('Plain.md', '# Plain\n\n![[Map]]\n');
    const embeds = new MapEmbeds(app.asApp<App>(), new DocumentStore(app.asApp<App>()));
    const renderer = loadedRenderer();
    // Host embeds Plain (an ordinary note) whose section holds the map's placeholder: the map is drawn inside Plain's container.
    const { span, sections } = await container(app, 'Plain', 'Plain.md');
    for (const section of sections) embeds.process(section, context(renderer, 'Plain.md'));
    await settle();
    expect(embeds.size).toBe(1);
    const label = span.querySelector<HTMLElement>('.mappy-view .mappy-node-label');
    if (!label) throw new Error('no node label');
    // A label section of the map, rendered with the map as its source, reaches the processor before it is put into the node.
    const late = createDiv();
    await MarkdownRenderer.render(app.asApp<App>(), '記録する', late, 'Map.md');
    embeds.process(late, context(renderer, 'Map.md'));
    expect(embeds.pending).toBe(1);
    label.append(late);
    await settle();
    expect(embeds.pending).toBe(0);
    expect(span.hasClass(EMBED_HOST_CLASS)).toBe(false);
    expect(embeds.size).toBe(1);
    expect(late.querySelector(`.${EMBED_ANCHOR_CLASS}`)).toBeNull();
  });

  it('stops waiting when the section is unloaded before its container joins the document, and the watcher goes with the last one', async () => {
    const app = new HarnessApp();
    app.put('Map.md', MAP);
    const embeds = new MapEmbeds(app.asApp<App>(), new DocumentStore(app.asApp<App>()));
    const renderer = loadedRenderer();
    const block = createDiv({ cls: 'cm-embed-block' });
    const { span } = await container(app, 'Map', 'Map.md', block);
    const late = createDiv();
    await MarkdownRenderer.render(app.asApp<App>(), '- 記録する', late, 'Map.md');
    const tracker = frameTracker();
    const timers = timerTracker();
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    try {
      embeds.process(late, context(renderer, 'Map.md'));
      span.querySelector('.markdown-preview-view')?.append(late);
      await frames(1);
      expect(tracker.pending()).toBe(0);
      expect(timers.pending(EMBED_CLAIM_HOLD_MS)).toBe(1);
      // Obsidian drops the rendering (the first of the two it draws on opening): the section's children unload.
      renderer.unload();
      expect(timers.pending(EMBED_CLAIM_HOLD_MS)).toBe(0);
      expect(embeds.pending).toBe(0);
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(late.querySelector(`.${EMBED_ANCHOR_CLASS}`)).toBeNull();
      document.body.append(block);
      await settle();
      expect(span.hasClass(EMBED_HOST_CLASS)).toBe(false);
      expect(embeds.size).toBe(0);
      expect(tracker.pending()).toBe(0);
    } finally {
      disconnect.mockRestore();
      timers.restore();
      tracker.restore();
    }
  });

  it('does not claim anything after the plugin unloaded, even from a section that was still waiting', async () => {
    const app = new HarnessApp();
    app.put('Map.md', MAP);
    const embeds = new MapEmbeds(app.asApp<App>(), new DocumentStore(app.asApp<App>()));
    const renderer = loadedRenderer();
    const { span } = await container(app, 'Map', 'Map.md');
    const late = createDiv();
    await MarkdownRenderer.render(app.asApp<App>(), '- 記録する', late, 'Map.md');
    const timers = timerTracker();
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    try {
      // One section past its hold, one still within it: dispose lets go of both.
      const kept = createDiv();
      await MarkdownRenderer.render(app.asApp<App>(), '- 葉', kept, 'Map.md');
      embeds.process(kept, context(renderer, 'Map.md'));
      timers.fire(EMBED_CLAIM_HOLD_MS);
      expect(embeds.pending).toBe(0);
      embeds.process(late, context(renderer, 'Map.md'));
      expect(timers.pending(EMBED_CLAIM_HOLD_MS)).toBe(1);
      expect(embeds.pending).toBe(1);
      embeds.dispose();
      expect(timers.pending(EMBED_CLAIM_HOLD_MS)).toBe(0);
      expect(embeds.pending).toBe(0);
      expect(disconnect).toHaveBeenCalled();
      expect(late.querySelector(`.${EMBED_ANCHOR_CLASS}`)).toBeNull();
      expect(kept.querySelector(`.${EMBED_ANCHOR_CLASS}`)).toBeNull();
    } finally {
      disconnect.mockRestore();
      timers.restore();
    }
    span.querySelector('.markdown-preview-view')?.append(late);
    await settle();
    expect(span.hasClass(EMBED_HOST_CLASS)).toBe(false);
    expect(embeds.size).toBe(0);
    expect(app.vaultEvents.count()).toBe(0);
    embeds.process(span.querySelector('.markdown-preview-view')?.firstElementChild as HTMLElement, context(renderer, 'Map.md'));
    await settle();
    expect(embeds.size).toBe(0);
  });
});
