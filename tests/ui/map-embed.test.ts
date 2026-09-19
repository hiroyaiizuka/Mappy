// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, MarkdownPostProcessorContext, TFile } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { Component, MarkdownRenderer, MarkdownView, WorkspaceLeaf } from '../../harness/browser/obsidian';
import { DocumentStore } from '../../src/obsidian/document-store';
import { EMBED_HOST_CLASS, MapEmbeds } from '../../src/ui/map-embed';

// The browser-harness stand-in for `obsidian`, so the shipped post processor, embed component and renderer run against a real DOM.
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });
afterEach(() => { document.body.replaceChildren(); });

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

/** The host note rendered the way Obsidian's reading view hands a section to post processors: `![[…]]` is still a placeholder span. */
async function render(files: Record<string, string>, hostPath: string): Promise<Rendered> {
  const app = new HarnessApp();
  for (const [path, content] of Object.entries(files)) app.put(path, content);
  const store = new DocumentStore(app.asApp<App>());
  const embeds = new MapEmbeds(app.asApp<App>(), store);
  const renderer = new Component();
  renderer.load();
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

  it('shows a sentence instead of a map once the note stops being one', async () => {
    const { app, section } = await render({ 'Host.md': '![[Map]]', 'Map.md': MAP }, 'Host.md');
    app.put('Map.md', MAP.replace('mappy: true', 'mappy: false'));
    await refreshed();
    expect(titles(section)).toEqual([]);
    expect(section.querySelector('.mappy-embed-message')?.textContent).toContain('マップではなくなりました');
  });

  it('releases the component, its DOM subscriptions and its vault/workspace listeners when the section goes', async () => {
    const { app, renderer, section, embeds } = await render({ 'Host.md': '![[Map]]', 'Map.md': MAP }, 'Host.md');
    expect(app.vaultEvents.count()).toBeGreaterThan(0);
    expect(app.workspaceEvents.count()).toBeGreaterThan(0);
    renderer.unload();
    expect(embeds.size).toBe(0);
    expect(app.vaultEvents.count()).toBe(0);
    expect(app.workspaceEvents.count()).toBe(0);
    expect(section.querySelector('.mappy-node')).toBeNull();
    // A later change of the source is nobody's business any more.
    app.put('Map.md', MAP.replace('- 葉', '- 後で'));
    await refreshed();
    expect(section.querySelector('.mappy-node')).toBeNull();
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
  /** Obsidian's embed container as the live-preview widget builds it, with the map note already rendered inside. */
  async function container(app: HarnessApp, src: string, mapPath: string): Promise<{ span: HTMLElement; sections: HTMLElement[] }> {
    const span = document.body.createDiv({ cls: 'cm-embed-block' })
      .createSpan({ cls: 'internal-embed markdown-embed inline-embed is-loaded', attr: { src } });
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
    const renderer = new Component();
    renderer.load();
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
    renderer.unload();
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
    const renderer = new Component();
    renderer.load();
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

  it("leaves the note's own reading view alone and looks again once a detached section is attached", async () => {
    const app = new HarnessApp();
    app.put('Map.md', MAP);
    const embeds = new MapEmbeds(app.asApp<App>(), new DocumentStore(app.asApp<App>()));
    const renderer = new Component();
    renderer.load();
    const own = document.body.createDiv({ cls: 'markdown-preview-view' }).createDiv();
    await MarkdownRenderer.render(app.asApp<App>(), '- 回復する', own, 'Map.md');
    embeds.process(own, context(renderer, 'Map.md'));
    await settle();
    expect(embeds.size).toBe(0);
    const { span } = await container(app, 'Map', 'Map.md');
    const late = createDiv();
    await MarkdownRenderer.render(app.asApp<App>(), '- 記録する', late, 'Map.md');
    embeds.process(late, context(renderer, 'Map.md'));
    span.querySelector('.markdown-preview-view')?.append(late);
    await settle();
    expect(span.hasClass(EMBED_HOST_CLASS)).toBe(true);
    expect(embeds.size).toBe(1);
  });
});
