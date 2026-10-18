// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, MarkdownPostProcessorContext, TFile } from 'obsidian';
import { installObsidianDom } from '../browser-harness/dom';
import { HarnessApp } from '../browser-harness/app';
import { Component, MarkdownRenderer, TextFileView, WorkspaceLeaf } from '../browser-harness/obsidian';
import { DocumentStore } from '../../src/obsidian/document-store';
import { closeOpenViews } from '../mocks/open-views';
import { EMBED_ANCHOR_CLASS, EMBED_HOST_CLASS, MapEmbeds } from '../../src/ui/map-embed';

// The browser-harness stand-in for `obsidian`, so the shipped post processor, embed component and renderer run against a real DOM.
vi.mock('obsidian', () => import('../browser-harness/obsidian'));

beforeAll(() => { installObsidianDom(); });
const renderers: Component[] = [];
afterEach(async () => {
  for (const renderer of renderers.splice(0)) renderer.unload();
  // The Canvas view stand-ins each test builds (tests/mocks/open-views.ts).
  await closeOpenViews();
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

/** Where a card sits on the board, as Canvas keeps it in its data and writes it into the card's inline style. */
interface Place { x: number; y: number; width: number; height: number }

interface CardOptions {
  /** Whether the canvas's data has the card (false: a card no canvas leaf names, as in a canvas embedded in a note). */
  listed?: boolean;
  /** Where the card sits; the next free place along the board otherwise. */
  at?: Place;
  /** Where the canvas's data says it sits, if not where the card is (data saved before a move). */
  saved?: Place;
  /** The card's `transform` as the style reads it back, if not the plain `translate(xpx, ypx)` of `at`. */
  transform?: string;
}

/** Obsidian 1.14.4's Canvas view: a TextFileView whose data is the `.canvas` JSON. */
class CanvasStandIn extends TextFileView {
  getViewType(): string { return 'canvas'; }
  getDisplayText(): string { return 'ボード'; }
}

interface Board {
  app: HarnessApp;
  embeds: MapEmbeds;
  renderer: Component;
  /** The canvas's leaf as `getLeavesOfType('canvas')` returns it. */
  leaf: { view: TextFileView; parent: object };
  /** A card as Canvas 1.14.4 builds a file node: the content (the embed's container) and its cover in the card, the note rendered inside. */
  card: (path: string, subpath?: string, options?: CardOptions) => Promise<Card>;
  calls: { split: unknown[][]; open: unknown[][]; reveal: unknown[]; active: unknown[][] };
  /** Lets the next `openFile` of a split wait until the returned function is called (an open that takes time). */
  holdOpen: () => () => void;
  /** Makes the next `openFile` of a split fail, as when the canvas's tab closes under it. */
  failOpen: () => void;
}

function board(files: Record<string, string>): Board {
  const app = new HarnessApp();
  for (const [path, content] of Object.entries(files)) app.put(path, content);
  const embeds = new MapEmbeds(app.asApp<App>(), new DocumentStore(app.asApp<App>()), 'mappy-map');
  const renderer = new Component();
  renderer.load();
  renderers.push(renderer);
  const view = new CanvasStandIn(new WorkspaceLeaf(app.asApp<App>()));
  document.body.append(view.containerEl);
  const canvasEl = view.containerEl.createDiv({ cls: 'canvas' });
  const nodes: Record<string, unknown>[] = [];
  const save = (): void => { view.data = JSON.stringify({ nodes, edges: [] }); };
  save();
  const leaf = { view, parent: {} };
  const calls: Board['calls'] = { split: [], open: [], reveal: [], active: [] };
  const mapLeaves: unknown[] = [];
  let held: Promise<void> | null = null;
  let failing = false;
  app.workspace.getLeavesOfType = ((type: string) => type === 'canvas' ? [leaf] : type === 'mappy-map' ? mapLeaves : []) as never;
  Object.assign(app.workspace, {
    createLeafBySplit: (...args: unknown[]) => {
      calls.split.push(args);
      return { openFile: (...open: unknown[]) => {
        calls.open.push(open);
        if (failing) { failing = false; return Promise.reject(new Error('the canvas tab is gone')); }
        return held ?? Promise.resolve();
      } };
    },
    revealLeaf: (target: unknown) => { calls.reveal.push(target); return Promise.resolve(); },
    setActiveLeaf: (...args: unknown[]) => { calls.active.push(args); },
    mapLeaves,
  });
  const holdOpen = (): (() => void) => {
    let release = (): void => undefined;
    held = new Promise<void>(resolve => { release = () => { held = null; resolve(); }; });
    return () => { release(); };
  };
  const failOpen = (): void => { failing = true; };
  const card: Board['card'] = async (path, subpath = '', { listed = true, at, saved, transform } = {}) => {
    const place = at ?? { x: nodes.length * 500, y: 0, width: 480, height: 320 };
    const node = canvasEl.createDiv({ cls: 'canvas-node' });
    node.style.transform = transform ?? `translate(${place.x}px, ${place.y}px)`;
    node.style.width = `${place.width}px`;
    node.style.height = `${place.height}px`;
    const container = node.createDiv({ cls: 'canvas-node-container' });
    const content = container.createDiv({ cls: 'canvas-node-content markdown-embed is-loaded' });
    const blocker = container.createDiv({ cls: 'canvas-node-content-blocker' });
    const preview = content.createDiv({ cls: 'markdown-embed-content' }).createDiv({ cls: 'markdown-preview-view markdown-rendered' });
    content.createDiv({ cls: 'markdown-embed-link' });
    if (listed) {
      nodes.push({ id: `n${nodes.length}`, type: 'file', file: path, ...(subpath ? { subpath } : {}), ...(saved ?? place) });
      save();
    }
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
  return { app, embeds, renderer, leaf, card, calls, holdOpen, failOpen };
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

  it("tells two cards of one note apart by the place the canvas's data gives each, and leaves a card that sits nowhere it says", async () => {
    const { embeds, card } = board({ 'Plan.md': HEADINGS });
    const whole = await card('Plan.md', '', { at: { x: 0, y: 0, width: 480, height: 320 } });
    const heading = await card('Plan.md', '#準備', { at: { x: 600, y: 0, width: 400, height: 300 } });
    expect(titles(whole.content)).toEqual(['計画', '準備', '当日'].sort());
    expect(titles(heading.content)).toEqual(['準備', '荷物'].sort());
    // Data saved before the card moved: two headings for this note and none of them here, so the heading is unknown.
    const moved = await card('Plan.md', '#当日', { at: { x: 0, y: 500, width: 400, height: 300 }, saved: { x: 0, y: 900, width: 400, height: 300 } });
    expect(moved.content.hasClass(EMBED_HOST_CLASS)).toBe(false);
    expect(embeds.size).toBe(2);
  });

  it("leaves the card to Obsidian when the canvas's view is not a text file view or its data is not the canvas JSON", async () => {
    const { leaf, embeds, card } = board({ 'Map.md': MAP });
    expect((await card('Map.md')).content.hasClass(EMBED_HOST_CLASS)).toBe(true);
    const getViewData = leaf.view.getViewData.bind(leaf.view);
    leaf.view.getViewData = () => '{ not json';
    expect((await card('Map.md', '', { listed: false })).content.hasClass(EMBED_HOST_CLASS)).toBe(false);
    leaf.view.getViewData = getViewData;
    // A view of another kind (a later Obsidian whose Canvas is not a text file view): the card's heading is unknown.
    (leaf as { view: unknown }).view = Object.assign(Object.create(null) as object, { containerEl: leaf.view.containerEl, getViewData });
    expect((await card('Map.md')).content.hasClass(EMBED_HOST_CLASS)).toBe(false);
    expect(embeds.size).toBe(1);
  });

  it("reads a card's place as the style gives it back: a fraction rounded to 6 digits, a million as 1e+06", async () => {
    const { card } = board({ 'Plan.md': HEADINGS });
    // A fraction (a canvas written by another tool, before Canvas saves its whole pixels): the style keeps 6 digits.
    const fraction = await card('Plan.md', '#準備', { at: { x: 1234.5678, y: 0, width: 400, height: 300 }, transform: 'translate(1234.57px, 0px)' });
    // Far out on the board: 1,000,000 reads back as 1e+06.
    const far = await card('Plan.md', '', { at: { x: 1_000_000, y: 0, width: 400, height: 300 }, transform: 'translate(1e+06px, 0px)' });
    expect(titles(fraction.content)).toEqual(['準備', '荷物'].sort());
    expect(titles(far.content)).toEqual(['計画', '準備', '当日'].sort());
  });

  it('opens another heading of the note that is asked for while the first is still opening, each with its own heading', async () => {
    const { app, card, calls, holdOpen } = board({ 'Plan.md': HEADINGS });
    const heading = await card('Plan.md', '#準備', { at: { x: 0, y: 0, width: 400, height: 300 } });
    const whole = await card('Plan.md', '', { at: { x: 600, y: 0, width: 400, height: 300 } });
    const release = holdOpen();
    doubleClick(heading.blocker);
    doubleClick(whole.blocker);
    await settle();
    release();
    await settle();
    expect(calls.open).toEqual([
      [fileOf(app, 'Plan.md'), { active: true, eState: { subpath: '#準備', focus: true } }],
      [fileOf(app, 'Plan.md'), { active: true, eState: { focus: true } }],
    ]);
  });

  it('logs an open that fails (the canvas tab closed under it) instead of leaving it unhandled, and opens again after', async () => {
    const { card, calls, failOpen } = board({ 'Map.md': MAP });
    const { blocker } = await card('Map.md');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      failOpen();
      doubleClick(blocker);
      await settle();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: 'the canvas tab is gone' }));
      expect(unhandled).not.toHaveBeenCalled();
      doubleClick(blocker);
      await settle();
      expect(calls.split).toHaveLength(2);
    } finally {
      process.off('unhandledRejection', unhandled);
      logged.mockRestore();
    }
  });

  it('opens once for the two clicks and the double click of a double click on the open button, while the split is still opening', async () => {
    const { card, calls, holdOpen } = board({ 'Map.md': MAP });
    const { content } = await card('Map.md');
    const button = content.querySelector<HTMLElement>('.mappy-embed-open');
    if (!button) throw new Error('no open button');
    const release = holdOpen();
    button.click();
    button.click();
    // The double click lands on the button, which its two clicks already worked: Canvas does not edit, nothing else opens.
    expect(doubleClick(button).defaultPrevented).toBe(true);
    await settle();
    expect(calls.split).toHaveLength(1);
    release();
    await settle();
    expect(calls.split).toHaveLength(1);
  });

  it("leaves a double click on a fold or a link to the map's own clicks: Canvas does not edit and nothing opens beside", async () => {
    const { card, calls } = board({ 'Map.md': MAP.replace('  - 日誌\n', '  - 日誌\n- 葉 [[Other]]\n'), 'Other.md': '# Other' });
    const { content } = await card('Map.md');
    const toggle = Array.from(content.querySelectorAll<HTMLElement>('.mappy-node')).find(item => item.textContent?.includes('回復する'))?.querySelector<HTMLElement>('.mappy-node-toggle');
    if (!toggle) throw new Error('no toggle');
    expect(doubleClick(toggle).defaultPrevented).toBe(true);
    const link = content.querySelector<HTMLElement>('.mappy-node a.internal-link');
    if (!link) throw new Error('no link');
    expect(doubleClick(link).defaultPrevented).toBe(true);
    await settle();
    expect(calls.split).toEqual([]);
    // The fold's first click re-fits the map, so the second press — and the double click — can land on the blank
    // map beside it: the double click is judged by where it began.
    const blank = content.querySelector<HTMLElement>('.mappy-canvas');
    if (!blank) throw new Error('no canvas');
    const press = (target: HTMLElement, detail: number): void => { target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail })); };
    press(toggle, 1);
    press(blank, 2);
    expect(doubleClick(blank).defaultPrevented).toBe(true);
    await settle();
    expect(calls.split).toEqual([]);
    // A double click that begins on the blank map opens it beside.
    press(blank, 1);
    press(blank, 2);
    doubleClick(blank);
    await settle();
    expect(calls.split).toHaveLength(1);
  });

  it("follows a web link itself, since the click's default is cancelled to keep Canvas from editing the card", async () => {
    const { card } = board({ 'Map.md': MAP.replace('  - 日誌\n', '  - 日誌\n- [サイト](https://example.com/page)\n') });
    const { content } = await card('Map.md');
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      const link = content.querySelector<HTMLElement>('.mappy-node a.external-link');
      if (!link) throw new Error('no web link');
      const click = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
      link.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      expect(open).toHaveBeenCalledWith('https://example.com/page', '_blank');
      // A click on anything else is only prevented.
      content.querySelector<HTMLElement>('.mappy-canvas')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
    }
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

  it('opens beside the canvas from the open button as well, and in a new tab with ⌘ as from any other embed', async () => {
    const { app, leaf, card, calls } = board({ 'Map.md': MAP });
    const { content } = await card('Map.md');
    const button = content.querySelector<HTMLElement>('.mappy-embed-open');
    if (!button) throw new Error('no open button');
    button.click();
    await settle();
    expect(calls.split).toEqual([[leaf, 'vertical']]);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, metaKey: true }));
    await settle();
    expect(calls.split).toHaveLength(1);
    expect(app.activity.at(-1)).toMatchObject({ kind: 'link', detail: 'Map.md（Map.md から、新しいペイン）' });
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
