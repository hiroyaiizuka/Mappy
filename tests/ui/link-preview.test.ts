// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, MarkdownPostProcessorContext } from 'obsidian';
import { installObsidianDom } from '../browser-harness/dom';
import { HarnessApp } from '../browser-harness/app';
import { Component, MarkdownRenderer } from '../browser-harness/obsidian';
import { DocumentStore } from '../../src/obsidian/document-store';
import { MapEmbeds } from '../../src/ui/map-embed';
import { closeOpenViews } from '../mocks/open-views';
import { mountMapView, type MountedMapView } from './map-view-mount';

/**
 * LEV-265: an internal link on a map asks Obsidian's Page preview for its popover (`hover-link`), as a note's reading
 * view does, from the note the link is written in. The shipped view, embed and renderer run against the harness's
 * `obsidian`; the payload the workspace receives is what is pinned here. Whether the popover shows (⌘／Ctrl, the
 * setting) is Page preview's and is checked on device (E81).
 */
vi.mock('obsidian', () => import('../browser-harness/obsidian'));

beforeAll(() => { installObsidianDom(); });

const renderers: Component[] = [];
afterEach(async () => {
  for (const renderer of renderers.splice(0)) renderer.unload();
  await closeOpenViews();
  document.body.replaceChildren();
});

interface HoverLink {
  event: MouseEvent;
  source: string;
  hoverParent: { hoverPopover: unknown };
  targetEl: HTMLElement;
  linktext: string;
  sourcePath: string;
}

function listen(app: HarnessApp): HoverLink[] {
  const seen: HoverLink[] = [];
  app.workspace.on('hover-link', info => { seen.push(info as HoverLink); });
  return seen;
}

function over(target: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('mouseover', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function popover(): { hide: ReturnType<typeof vi.fn> } {
  return { hide: vi.fn() };
}

function link(root: ParentNode, href: string): HTMLAnchorElement {
  const found = Array.from(root.querySelectorAll<HTMLAnchorElement>('a.internal-link')).find(anchor => anchor.dataset.href === href);
  if (!found) throw new Error(`No link ${href}`);
  return found;
}

const HOST_PATH = 'Maps/Host.md';
const HOST = [
  '---', 'mappy: true', '---',
  '## ホスト',
  '- [[Target]]',
  '- [[Target#見出し]]',
  '- [[Target#^block]]',
  '- [[Target|別名]]',
  '- [[image.png]]',
  '- 本文を持つ',
  '  [[Body]]',
  '- [外](https://example.com)',
  '- ![[Called]]',
  '',
].join('\n');
const CALLED = ['---', 'mappy: true', '---', '## 呼ばれる', '- [[Inner]]', ''].join('\n');
const NOTES: Record<string, string> = {
  'Target.md': '# 見出し\n本文 ^block\n', 'image.png': '', 'Body.md': '', 'Sub/Called.md': CALLED, 'Sub/Inner.md': '',
};

async function mount(): Promise<MountedMapView> {
  const app = new HarnessApp();
  for (const [path, content] of Object.entries(NOTES)) app.put(path, content);
  const mounted = await mountMapView(HOST_PATH, HOST, 'mindmap', app);
  await mounted.settle();
  return mounted;
}

describe('link hover preview (LEV-265)', () => {
  it('asks Page preview for each kind of internal link in a map tab, from the map\'s note, with the map as the popover\'s parent', async () => {
    const { app, canvas } = await mount();
    const seen = listen(app);
    const anchors = Array.from(canvas.querySelectorAll<HTMLAnchorElement>('a.internal-link'));
    const alias = anchors.find(anchor => anchor.textContent === '別名');
    // The alias is what is shown; its target is what is previewed.
    expect(alias?.dataset.href).toBe('Target');
    const cases: [HTMLAnchorElement, string][] = [
      [link(canvas, 'Target'), 'Target'], [link(canvas, 'Target#見出し'), 'Target#見出し'], [link(canvas, 'Target#^block'), 'Target#^block'],
      [alias ?? canvas.ownerDocument.createElement('a'), 'Target'], [link(canvas, 'image.png'), 'image.png'], [link(canvas, 'Body'), 'Body'],
    ];
    for (const [anchor, href] of cases) {
      const event = over(anchor, { relatedTarget: canvas });
      const info = seen.at(-1);
      expect(info, href).toBeDefined();
      expect(info).toMatchObject({ source: 'mappy', linktext: href, sourcePath: HOST_PATH });
      expect(info?.targetEl).toBe(anchor);
      expect(info?.event).toBe(event);
      expect(info?.hoverParent).toHaveProperty('hoverPopover', null);
    }
    expect(seen).toHaveLength(6);
  });

  it('resolves a link inside a called branch from the called note', async () => {
    const { app, canvas } = await mount();
    const seen = listen(app);
    over(link(canvas, 'Inner'), { relatedTarget: canvas });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ source: 'mappy', linktext: 'Inner', sourcePath: 'Sub/Called.md' });
  });

  it('does not ask for an external link, while a button is held (a drag, a pan), while a node is being written, or again inside one link', async () => {
    const { app, canvas, select, key, editor } = await mount();
    const seen = listen(app);
    const external = canvas.querySelector<HTMLAnchorElement>('a:not(.internal-link)');
    expect(external?.getAttribute('href')).toBe('https://example.com');
    over(external ?? canvas, { relatedTarget: canvas });
    over(link(canvas, 'Target'), { relatedTarget: canvas, buttons: 1 });
    const anchor = link(canvas, 'Target');
    const inner = anchor.ownerDocument.createElement('span');
    anchor.append(inner);
    over(inner, { relatedTarget: anchor });
    expect(seen).toHaveLength(0);
    // The inline editor is open on another node: nothing on the map pops over what is being written.
    key(select('本文を持つ'), 'F2');
    expect(editor()).not.toBeNull();
    over(link(canvas, 'Body'), { relatedTarget: canvas });
    over(link(canvas, 'Target#見出し'), { relatedTarget: canvas });
    expect(seen).toHaveLength(0);
  });

  it('keeps a click on a link opening it, and closes the popover on a press, a wheel, a key, and when the tab closes', async () => {
    const { app, canvas, close } = await mount();
    const seen = listen(app);
    const anchor = link(canvas, 'Target');
    for (const end of [
      () => { canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); },
      () => { canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 10 })); },
      () => { canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); },
    ]) {
      over(anchor, { relatedTarget: canvas });
      const parent = seen.at(-1)?.hoverParent;
      const shown = popover();
      if (parent) parent.hoverPopover = shown;
      await Promise.resolve();
      expect(shown.hide).not.toHaveBeenCalled();
      end();
      expect(shown.hide).toHaveBeenCalledTimes(1);
      expect(parent?.hoverPopover).toBeNull();
    }
    // ⌘ alone is Page preview's cue to show the hovered link; it does not close it.
    over(anchor, { relatedTarget: canvas });
    const parent = seen.at(-1)?.hoverParent;
    const held = popover();
    if (parent) parent.hoverPopover = held;
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true, bubbles: true }));
    await Promise.resolve();
    expect(held.hide).not.toHaveBeenCalled();
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(app.activity.at(-1)).toMatchObject({ kind: 'link', detail: `Target（${HOST_PATH} から）` });
    await close();
    expect(held.hide).toHaveBeenCalledTimes(1);
  });

  it('closes a popover that shows after Page preview\'s delay when a press, a wheel, a key or a draft came in the meantime, once its show has returned', async () => {
    const { app, canvas, select, key, editor } = await mount();
    const seen = listen(app);
    const anchor = link(canvas, 'Target');
    for (const [what, meanwhile] of [
      // A drag that began on the link: the canvas holds the pointer, the link never hears it leave.
      ['press', () => { canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); }],
      ['wheel', () => { canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 10 })); }],
      ['key', () => { canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); }],
    ] as const) {
      over(anchor, { relatedTarget: canvas });
      const parent = seen.at(-1)?.hoverParent;
      meanwhile();
      // As Obsidian's `show` does: the popover is handed over, then `show` goes on with it; closing it in between
      // would have `show` list and load a hidden popover again.
      const late = popover();
      if (parent) parent.hoverPopover = late;
      expect(late.hide, what).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(late.hide, what).toHaveBeenCalledTimes(1);
      expect(parent?.hoverPopover, what).toBeNull();
    }
    // The next hover may show again.
    over(anchor, { relatedTarget: canvas });
    const parent = seen.at(-1)?.hoverParent;
    const again = popover();
    if (parent) parent.hoverPopover = again;
    await Promise.resolve();
    expect(again.hide).not.toHaveBeenCalled();
    expect(parent?.hoverPopover).toBe(again);
    // A draft opened while it waited (F2 on another node: the key closes it as well, the draft on its own too).
    if (parent) parent.hoverPopover = null;
    over(anchor, { relatedTarget: canvas });
    key(select('本文を持つ'), 'F2');
    expect(editor()).not.toBeNull();
    const whileWriting = popover();
    if (parent) parent.hoverPopover = whileWriting;
    await Promise.resolve();
    expect(whileWriting.hide).toHaveBeenCalledTimes(1);
  });

  it('closes the popover when the inline editor opens without the canvas hearing the key (F2 is the view scope\'s)', async () => {
    const { app, canvas, view, select, editor } = await mount();
    const seen = listen(app);
    select('本文を持つ');
    over(link(canvas, 'Target'), { relatedTarget: canvas });
    const parent = seen.at(-1)?.hoverParent;
    const shown = popover();
    if (parent) parent.hoverPopover = shown;
    await Promise.resolve();
    expect(shown.hide).not.toHaveBeenCalled();
    // What Obsidian's keymap does with F2: the view's scope runs the edit, and the key never reaches the canvas.
    (view as unknown as { editTitle(): void }).editTitle();
    expect(editor()).not.toBeNull();
    expect(shown.hide).toHaveBeenCalledTimes(1);
  });

  it('shows the popover asked for with ⌘ pressed over a link after a key closed the last one', async () => {
    const { app, canvas } = await mount();
    const seen = listen(app);
    over(link(canvas, 'Target'), { relatedTarget: canvas });
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    // The pointer stays on the link; ⌘ is pressed, and Page preview makes its popover now.
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true, bubbles: true }));
    const parent = seen.at(-1)?.hoverParent;
    const wanted = popover();
    if (parent) parent.hoverPopover = wanted;
    await Promise.resolve();
    expect(wanted.hide).not.toHaveBeenCalled();
    // A modifier other than ⌘／Ctrl neither closes one nor asks for one.
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'CapsLock', bubbles: true }));
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'AltGraph', bubbles: true }));
    expect(wanted.hide).not.toHaveBeenCalled();
  });

  it('keeps a link\'s mouseover going on in a map tab, for whoever else listens around the map', async () => {
    const { canvas, view } = await mount();
    const around = vi.fn();
    view.containerEl.addEventListener('mouseover', around);
    over(link(canvas, 'Target'), { relatedTarget: canvas });
    expect(around).toHaveBeenCalledTimes(1);
  });

  it('asks from a read-only embed too, from the map\'s note, and the reading view around it does not ask again', async () => {
    const app = new HarnessApp();
    const files: Record<string, string> = { 'Host.md': '![[Sub/Map]]', 'Sub/Map.md': ['---', 'mappy: true', '---', '## 講座', '- [[Inner]]', ''].join('\n'), 'Sub/Inner.md': '' };
    for (const [path, content] of Object.entries(files)) app.put(path, content);
    const store = new DocumentStore(app.asApp<App>());
    const embeds = new MapEmbeds(app.asApp<App>(), store);
    const renderer = new Component();
    renderer.load();
    renderers.push(renderer);
    const section = document.body.createDiv({ cls: 'markdown-preview-section' });
    const reading = vi.fn();
    section.addEventListener('mouseover', reading);
    await MarkdownRenderer.render(app.asApp<App>(), files['Host.md'] ?? '', section, 'Host.md');
    const context: MarkdownPostProcessorContext = {
      docId: 'doc', sourcePath: 'Host.md', frontmatter: null,
      addChild: child => { renderer.addChild(child as unknown as Component); },
      getSectionInfo: () => null,
    };
    embeds.process(section, context);
    for (let round = 0; round < 3; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => setTimeout(resolve, 0));
    const seen = listen(app);
    const canvas = section.querySelector<HTMLElement>('.mappy-embed .mappy-canvas');
    expect(canvas).not.toBeNull();
    over(link(section, 'Inner'), { relatedTarget: canvas });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ source: 'mappy', linktext: 'Inner', sourcePath: 'Sub/Map.md' });
    expect(reading).not.toHaveBeenCalled();
    // Nor when the embed itself asks nothing: a move between the parts of one link, a button held (a selection dragged).
    const inner = link(section, 'Inner');
    const part = inner.ownerDocument.createElement('span');
    inner.append(part);
    over(part, { relatedTarget: inner });
    over(inner, { relatedTarget: canvas, buttons: 1 });
    expect(seen).toHaveLength(1);
    expect(reading).not.toHaveBeenCalled();
    const parent = seen[0]?.hoverParent;
    const shown = popover();
    if (parent) parent.hoverPopover = shown;
    renderer.unload();
    expect(shown.hide).toHaveBeenCalledTimes(1);
    embeds.dispose();
  });
});
