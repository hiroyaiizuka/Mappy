// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, MarkdownPostProcessorContext, TFile } from 'obsidian';
import { installObsidianDom } from '../browser-harness/dom';
import { HarnessApp } from '../browser-harness/app';
import { Component, MarkdownRenderer } from '../browser-harness/obsidian';
import { DocumentStore } from '../../src/obsidian/document-store';
import { EMBED_ANCHOR_CLASS, EMBED_HOST_CLASS, MapEmbeds } from '../../src/ui/map-embed';

// The browser-harness stand-in for `obsidian`, so the shipped post processor, embed component and renderer run against a real DOM.
vi.mock('obsidian', () => import('../browser-harness/obsidian'));

beforeAll(() => { installObsidianDom(); });
const renderers: Component[] = [];
afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.unload();
  document.body.replaceChildren();
});

const MAP = ['---', 'mappy: true', '---', '## 講座', '- 回復する', '  - 睡眠', '- 記録する', '  - 日誌', ''].join('\n');
const HEADINGS = ['---', 'mappy: true', '---', '# 計画', '', '## 準備', '### 荷物', '#### 服', '## 当日', '### 出発', ''].join('\n');

function context(renderer: Component, sourcePath: string): MarkdownPostProcessorContext {
  return {
    docId: 'doc', sourcePath, frontmatter: null,
    addChild: child => { renderer.addChild(child as unknown as Component); },
    getSectionInfo: () => null,
  };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => requestAnimationFrame(resolve));
  await new Promise(resolve => setTimeout(resolve, 0));
}

function fileOf(app: HarnessApp, path: string): TFile {
  const file = app.vault.getAbstractFileByPath(path);
  if (!file) throw new Error(`No file ${path}`);
  return file as unknown as TFile;
}

function titles(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.mappy-node .mappy-node-label'), label => label.textContent?.trim() ?? '').sort();
}

interface Card {
  node: HTMLElement;
  container: HTMLElement;
  content: HTMLElement;
  blocker: HTMLElement;
  sections: HTMLElement[];
}

interface Board {
  app: HarnessApp;
  embeds: MapEmbeds;
  renderer: Component;
  /** The canvas's leaf as `getLeavesOfType('canvas')` returns it, with the node list Canvas keeps. */
  leaf: { view: { containerEl: HTMLElement; canvas: { nodes: Map<string, unknown> } }; parent: object };
  /** A card as Canvas 1.14.4 builds a file node: the content (the embed's container) and its cover in the card, the note rendered inside. */
  card: (path: string, subpath?: string, options?: { listed?: boolean; entry?: (node: Record<string, unknown>) => unknown }) => Promise<Card>;
  calls: { split: unknown[][]; open: unknown[][]; reveal: unknown[]; active: unknown[][]; eState: unknown[] };
}

function board(files: Record<string, string>): Board {
  const app = new HarnessApp();
  for (const [path, content] of Object.entries(files)) app.put(path, content);
  const embeds = new MapEmbeds(app.asApp<App>(), new DocumentStore(app.asApp<App>()));
  const renderer = new Component();
  renderer.load();
  renderers.push(renderer);
  const containerEl = document.body.createDiv({ cls: 'workspace-leaf-content', attr: { 'data-type': 'canvas' } });
  const canvasEl = containerEl.createDiv({ cls: 'canvas' });
  const leaf = { view: { containerEl, canvas: { nodes: new Map<string, unknown>() } }, parent: {} };
  const calls: Board['calls'] = { split: [], open: [], reveal: [], active: [], eState: [] };
  const mapLeaves: unknown[] = [];
  app.workspace.getLeavesOfType = ((type: string) => type === 'canvas' ? [leaf] : type === 'mappy-map' ? mapLeaves : []) as never;
  Object.assign(app.workspace, {
    createLeafBySplit: (...args: unknown[]) => {
      calls.split.push(args);
      return { openFile: (...open: unknown[]) => { calls.open.push(open); return Promise.resolve(); } };
    },
    revealLeaf: (target: unknown) => { calls.reveal.push(target); return Promise.resolve(); },
    setActiveLeaf: (...args: unknown[]) => { calls.active.push(args); },
    mapLeaves,
  });
  const card: Board['card'] = async (path, subpath = '', { listed = true, entry = (node: Record<string, unknown>): unknown => node } = {}) => {
    const node = canvasEl.createDiv({ cls: 'canvas-node' });
    const container = node.createDiv({ cls: 'canvas-node-container' });
    const content = container.createDiv({ cls: 'canvas-node-content markdown-embed is-loaded' });
    const blocker = container.createDiv({ cls: 'canvas-node-content-blocker' });
    const preview = content.createDiv({ cls: 'markdown-embed-content' }).createDiv({ cls: 'markdown-preview-view markdown-rendered' });
    content.createDiv({ cls: 'markdown-embed-link' });
    if (listed) leaf.view.canvas.nodes.set(`n${leaf.view.canvas.nodes.size}`, entry({ contentEl: content, file: fileOf(app, path), subpath, nodeEl: node }));
    const sections: HTMLElement[] = [];
    for (const block of app.content(fileOf(app, path)).split(/\n{2,}/u)) {
      const section = preview.createDiv();
      await MarkdownRenderer.render(app.asApp<App>(), block, section, path);
      sections.push(section);
    }
    for (const section of sections) embeds.process(section, context(renderer, path));
    await settle();
    return { node, container, content, blocker, sections };
  };
  return { app, embeds, renderer, leaf, card, calls };
}

function doubleClick(target: HTMLElement): MouseEvent {
  const event = new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 });
  target.dispatchEvent(event);
  return event;
}

describe('MapEmbeds on a Canvas card (LEV-348)', () => {
  it("draws a card of a map note as a read-only map filling the card, hides the card's rendering and puts it back when the section goes", async () => {
    const { app, embeds, renderer, card } = board({ 'Map.md': MAP });
    const { content, sections } = await card('Map.md');
    expect(content.hasClass(EMBED_HOST_CLASS)).toBe(true);
    // Canvas styles the editor its menu opens by `markdown-embed`: the card keeps its classes.
    expect(content.hasClass('markdown-embed')).toBe(true);
    const frames = content.querySelectorAll(':scope > .mappy-embed.mappy-embed-card');
    expect(frames).toHaveLength(1);
    expect(titles(content)).toEqual(['回復する', '記録する', '講座'].sort());
    expect(embeds.size).toBe(1);
    // The lifecycle rides on an anchor inside a section Obsidian rendered, as in live preview.
    const anchor = content.querySelector(`.${EMBED_ANCHOR_CLASS}`);
    expect(sections.some(section => section.contains(anchor))).toBe(true);
    renderer.unload();
    expect(content.hasClass(EMBED_HOST_CLASS)).toBe(false);
    expect(content.hasClass('markdown-embed')).toBe(true);
    expect(content.querySelector('.mappy-embed')).toBeNull();
    expect(app.vaultEvents.count()).toBe(0);
    expect(app.workspaceEvents.count()).toBe(0);
  });

  it("draws the subtree of the card's heading, read from the canvas since the card's DOM does not name it", async () => {
    const { card } = board({ 'Plan.md': HEADINGS });
    const { content } = await card('Plan.md', '#準備');
    expect(titles(content)).toEqual(['準備', '荷物'].sort());
  });

  it('leaves a card of a note that is not a map, a block reference, and a card no open canvas holds to Obsidian', async () => {
    const { embeds, card } = board({ 'Plain.md': '# Plain\n\n- 項目\n', 'Map.md': MAP });
    const plain = await card('Plain.md');
    expect(plain.content.hasClass(EMBED_HOST_CLASS)).toBe(false);
    const block = await card('Map.md', '#^abc');
    expect(block.content.hasClass(EMBED_HOST_CLASS)).toBe(false);
    // A canvas embedded in a note or shown in a hover preview: no canvas leaf holds its nodes, so its heading is unknown.
    const unlisted = await card('Map.md', '', { listed: false });
    expect(unlisted.content.hasClass(EMBED_HOST_CLASS)).toBe(false);
    // Beside them, a card of the map on the same canvas is the map's.
    const map = await card('Map.md');
    expect(map.content.hasClass(EMBED_HOST_CLASS)).toBe(true);
    expect(embeds.size).toBe(1);
  });

  it('leaves the card to Obsidian when the canvas does not keep its nodes the way 1.14.4 does', async () => {
    const { leaf, embeds, card } = board({ 'Map.md': MAP });
    // Kept the 1.14.4 way, the card is the map's.
    expect((await card('Map.md')).content.hasClass(EMBED_HOST_CLASS)).toBe(true);
    // The file as a path instead of a TFile.
    const byPath = await card('Map.md', '', { entry: node => ({ ...node, file: 'Map.md' }) });
    expect(byPath.content.hasClass(EMBED_HOST_CLASS)).toBe(false);
    // The nodes in another collection than a Map.
    const kept: unknown[] = [];
    (leaf.view.canvas as { nodes: unknown }).nodes = { size: 0, set: (_key: string, node: unknown) => { kept.push(node); }, values: () => kept };
    const { content } = await card('Map.md');
    expect(kept).toHaveLength(1);
    expect(content.hasClass(EMBED_HOST_CLASS)).toBe(false);
    expect(content.querySelector('.mappy-embed')).toBeNull();
    expect(embeds.size).toBe(1);
  });

  it("opens the note as a map in a split beside the canvas on a double click on the card, instead of Canvas's editor", async () => {
    const { app, leaf, card, calls } = board({ 'Plan.md': HEADINGS });
    const { container, blocker, content } = await card('Plan.md', '#準備');
    // Canvas's own listener on the card starts its Markdown editor unless the double click was prevented.
    let edited = 0;
    container.addEventListener('dblclick', event => { if (!event.defaultPrevented) edited += 1; });
    // An unselected card: the cover takes the pointer.
    expect(doubleClick(blocker).defaultPrevented).toBe(true);
    await settle();
    expect(edited).toBe(0);
    expect(calls.split).toEqual([[leaf, 'vertical']]);
    expect(calls.open).toEqual([[fileOf(app, 'Plan.md'), { active: true, eState: { subpath: '#準備', focus: true } }]]);
    // A selected card: the map itself.
    expect(doubleClick(content.querySelector<HTMLElement>('.mappy-canvas') ?? content).defaultPrevented).toBe(true);
    await settle();
    expect(edited).toBe(0);
    expect(calls.split).toHaveLength(2);
  });

  it('brings forward a map tab already on the note outside the canvas tab group, and splits when the only one is behind the canvas', async () => {
    const { app, leaf, card, calls } = board({ 'Map.md': MAP });
    const { blocker } = await card('Map.md');
    const mapLeaves = (app.workspace as unknown as { mapLeaves: unknown[] }).mapLeaves;
    const eState: unknown[] = [];
    const tab = (parent: object): object => ({
      parent, getViewState: () => ({ type: 'mappy-map', state: { file: 'Map.md' } }), setEphemeralState: (state: unknown) => { eState.push(state); },
    });
    const behind = tab(leaf.parent);
    mapLeaves.push(behind);
    doubleClick(blocker);
    await settle();
    expect(calls.reveal).toEqual([]);
    expect(calls.split).toHaveLength(1);
    const beside = tab({});
    mapLeaves.push(beside);
    doubleClick(blocker);
    await settle();
    expect(calls.reveal).toEqual([beside]);
    expect(calls.active).toEqual([[beside, { focus: true }]]);
    expect(eState).toEqual([{ focus: true }]);
    expect(calls.split).toHaveLength(1);
  });

  it("lets Canvas have the double click while it edits the card's Markdown (its menu's Edit)", async () => {
    const { card, calls } = board({ 'Map.md': MAP });
    const { node, blocker } = await card('Map.md');
    node.addClass('is-editing');
    expect(doubleClick(blocker).defaultPrevented).toBe(false);
    await settle();
    expect(calls.split).toEqual([]);
    // Once the editor closes, the double click is the map's again.
    node.removeClass('is-editing');
    expect(doubleClick(blocker).defaultPrevented).toBe(true);
    await settle();
    expect(calls.split).toHaveLength(1);
  });

  it("keeps a click inside the map from reaching Canvas's click-to-edit, while the folds still open and close", async () => {
    const { card } = board({ 'Map.md': MAP });
    const { content } = await card('Map.md');
    const blank = content.querySelector<HTMLElement>('.mappy-canvas');
    if (!blank) throw new Error('no canvas');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
    blank.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    const node = Array.from(content.querySelectorAll<HTMLElement>('.mappy-node')).find(item => item.textContent?.includes('回復する'));
    node?.querySelector<HTMLElement>('.mappy-node-toggle')?.click();
    await settle();
    expect(titles(content)).toContain('睡眠');
  });

  it('opens beside the canvas from the open button as well', async () => {
    const { leaf, card, calls } = board({ 'Map.md': MAP });
    const { content } = await card('Map.md');
    content.querySelector<HTMLElement>('.mappy-embed-open')?.click();
    await settle();
    expect(calls.split).toEqual([[leaf, 'vertical']]);
  });

  it('puts every card back when the plugin unloads', async () => {
    const { embeds, card } = board({ 'Map.md': MAP });
    const first = await card('Map.md');
    const second = await card('Map.md');
    expect(embeds.size).toBe(2);
    embeds.dispose();
    for (const { content } of [first, second]) {
      expect(content.hasClass(EMBED_HOST_CLASS)).toBe(false);
      expect(content.querySelector('.mappy-embed, .mappy-embed-anchor')).toBeNull();
    }
    expect(embeds.size).toBe(0);
  });
});
