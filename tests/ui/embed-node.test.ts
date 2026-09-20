// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, WorkspaceLeaf as ObsidianLeaf, ViewStateResult } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { WorkspaceLeaf } from '../../harness/browser/obsidian';
import type { MindDocument } from '../../src/core/markdown';
import { DocumentStore } from '../../src/obsidian/document-store';
import type { ViewRouter } from '../../src/obsidian/view-routing';
import { nodeOf } from '../../src/ui/map-events';
import { MindmapView } from '../../src/ui/mindmap-view';

/**
 * §5 M12, the display side: a node whose title is one `![[map]]` draws that map inside
 * itself, read-only, with the same frame the note embed uses (§5 M10). The shipped view,
 * renderer, embed and store run against the browser-harness stand-in for `obsidian`.
 */
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });

const HOST_PATH = 'Maps/Host.md';
const MAP = ['---', 'mappy: true', '---', '## 講座', '- 回復する', '  - 睡眠', '    - 昼寝', '  - 運動', '- 記録する', '  - 日誌', '- 葉', ''].join('\n');
const TIMELINE = ['---', 'mappy: true', 'mappy-layout: timeline', '---', '## 進行', '- 第 1 週', '  - 準備', '- 第 2 週', ''].join('\n');
const HEADINGS = ['---', 'mappy: true', 'mappy-layout: hierarchy', '---', '# 構成', '', '## 回復する', '### 同じ名前', '#### 深い', '## 記録する', '### 同じ名前', ''].join('\n');
/** The host map: one node per way a title can mention an embed. */
const HOST = [
  '---', 'mappy: true', '---',
  '## ホスト',
  '- 呼び出し',
  '  - ![[Map]]',
  '  - ![[Timeline]]',
  '  - ![[Headings#同じ名前]]',
  '- 同じマップをもう一度',
  '  - ![[Map]]',
  '- リンクのまま',
  '  - ![[Host]]',
  '  - 文中の ![[Map]] は埋め込まない',
  '  - ![[Plain]]',
  '  - ![[Missing]]',
  '  - ![[Map#^block]]',
  '  - ![[image.png]]',
  '  - `![[Map]]`',
  '',
].join('\n');
const NOTES: Record<string, string> = {
  [HOST_PATH]: HOST, 'Map.md': MAP, 'Timeline.md': TIMELINE, 'Headings.md': HEADINGS,
  'Plain.md': '## Plain\n- a\n', 'image.png': '',
};

const views: MindmapView[] = [];
afterEach(async () => {
  for (const view of views.splice(0)) { await view.onClose(); view.unload(); }
  document.body.replaceChildren();
});

/** Canvas at (10, 20) of 1200 × 800 screen pixels; jsdom has no geometry of its own. */
const CANVAS = { x: 10, y: 20, left: 10, top: 20, width: 1200, height: 800, right: 1210, bottom: 820, toJSON: () => ({}) };

interface Mounted {
  app: HarnessApp;
  view: MindmapView;
  canvas: HTMLElement;
  document: () => MindDocument;
  /** The view's own node elements by id: never the nodes of a map drawn inside a node. */
  nodes: () => Map<string, HTMLElement>;
  node: (title: string) => HTMLElement;
  /** The frames drawn inside nodes, in DOM order. */
  frames: () => HTMLElement[];
  frameOf: (title: string) => HTMLElement;
  /** Visible titles inside a frame, in DOM order. */
  inner: (frame: HTMLElement) => string[];
  source: () => string;
  /** Let the file reads, the parses and one layout frame run. */
  settle: () => Promise<void>;
  /** Past the 45 ms debounce of a source change, then settled. */
  refreshed: () => Promise<void>;
  editor: () => HTMLTextAreaElement | null;
  hit: (element: Element | null) => void;
  viewport: () => { x: number; y: number; scale: number };
}

async function settleDom(): Promise<void> {
  for (let round = 0; round < 3; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => requestAnimationFrame(resolve));
  await new Promise(resolve => setTimeout(resolve, 0));
}

/** The view's own nodes, judged as the product judges a click: a node inside a frame answers to the frame. */
function ownNodes(canvas: HTMLElement): HTMLElement[] {
  return Array.from(canvas.querySelectorAll<HTMLElement>('.mappy-node')).filter(node => nodeOf(canvas, node) === node);
}

/** The title as written (the node's `aria-label`): a link node shows its link text, an embed node shows a frame. */
function labelOf(node: HTMLElement): string {
  return node.getAttribute('aria-label') ?? '';
}

async function mount(notes: Record<string, string> = NOTES, hostPath = HOST_PATH): Promise<Mounted> {
  const app = new HarnessApp();
  for (const [path, content] of Object.entries(notes)) app.put(path, content);
  const leaf = new WorkspaceLeaf(app.asApp<App>());
  const store = new DocumentStore(app.asApp<App>());
  const view = new MindmapView(leaf as unknown as ObsidianLeaf, store, {} as ViewRouter);
  views.push(view);
  leaf.view = view as unknown as WorkspaceLeaf['view'];
  document.body.append(view.containerEl);
  view.load();
  await view.onOpen();
  const canvas = view.contentEl.querySelector<HTMLElement>(":scope > .mappy-canvas");
  if (!canvas) throw new Error('The view has no canvas');
  canvas.getBoundingClientRect = () => CANVAS;
  canvas.setPointerCapture = () => undefined;
  canvas.releasePointerCapture = () => undefined;
  canvas.hasPointerCapture = () => false;
  let hitElement: Element | null = null;
  document.elementFromPoint = () => hitElement ?? canvas;
  await view.setState({ file: hostPath }, { history: false } satisfies ViewStateResult);
  await settleDom();
  const file = app.vault.getAbstractFileByPath(hostPath);
  if (!file) throw new Error('no host');
  const nodes = (): Map<string, HTMLElement> => new Map(ownNodes(canvas).map(node => [node.dataset.nodeId ?? '', node]));
  const node = (title: string): HTMLElement => {
    const found = ownNodes(canvas).find(candidate => labelOf(candidate) === title);
    if (!found) throw new Error(`No node ${title}`);
    return found;
  };
  return {
    app, view, canvas, nodes, node,
    document: () => {
      const parsed = view.snapshot()?.document;
      if (!parsed) throw new Error('The view has not parsed its note');
      return parsed;
    },
    frames: () => Array.from(canvas.querySelectorAll<HTMLElement>('.mappy-node > .mappy-node-content > .mappy-embed')),
    frameOf: title => {
      const frame = node(title).querySelector<HTMLElement>(':scope > .mappy-node-content > .mappy-embed');
      if (!frame) throw new Error(`No frame in ${title}`);
      return frame;
    },
    inner: frame => Array.from(frame.querySelectorAll<HTMLElement>('.mappy-node'), inner => labelOf(inner)),
    source: () => app.content(file),
    settle: settleDom,
    refreshed: async () => { await new Promise(resolve => setTimeout(resolve, 60)); await settleDom(); },
    editor: () => canvas.querySelector<HTMLTextAreaElement>('textarea.mappy-inline-input'),
    hit: element => { hitElement = element; },
    viewport: () => view.getState().viewport as { x: number; y: number; scale: number },
  };
}

function click(target: EventTarget, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function dblclick(target: EventTarget, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 300, clientY: 300, ...init });
  target.dispatchEvent(event);
  return event;
}

function key(target: EventTarget, value: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function pointer(type: string, target: EventTarget, clientX: number, clientY: number): PointerEvent {
  const event = new PointerEvent(type, { pointerId: 1, button: 0, bubbles: true, cancelable: true, clientX, clientY });
  target.dispatchEvent(event);
  return event;
}

function innerNode(frame: HTMLElement, title: string): HTMLElement {
  const found = Array.from(frame.querySelectorAll<HTMLElement>('.mappy-node')).find(candidate => labelOf(candidate) === title);
  if (!found) throw new Error(`No inner node ${title}`);
  return found;
}

describe('a node whose title is one `![[map]]` (judgement and drawing)', () => {
  it('draws the map inside the node with the note-embed frame: roots and first level, deeper levels folded, read-only', async () => {
    const { node, frames, frameOf, inner, app } = await mount();
    const embed = node('![[Map]]');
    expect(embed.hasClass('is-embed')).toBe(true);
    expect(embed.querySelector(':scope > .mappy-node-content > .mappy-node-label')).toBeNull();
    const frame = frameOf('![[Map]]');
    expect(frame.hasClass('mappy-view')).toBe(true);
    expect(frame.dataset.mappyEmbed).toBe('Map.md');
    expect(frame.getAttribute('aria-label')).toBe('マインドマップ: Map');
    expect(inner(frame)).toEqual(['講座', '回復する', '記録する', '葉']);
    expect(innerNode(frame, '回復する').hasClass('is-collapsed')).toBe(true);
    expect(innerNode(frame, '回復する').querySelector('.mappy-node-toggle-mark')?.textContent).toBe('3');
    expect(innerNode(frame, '講座').hasClass('is-root')).toBe(true);
    expect(frame.querySelector('.mappy-canvas')?.getAttribute('aria-readonly')).toBe('true');
    expect(frame.querySelector('textarea, [contenteditable]')).toBeNull();
    expect(frame.querySelector('.mappy-embed-open')).not.toBeNull();
    // The other maps follow their own layout and heading path.
    expect(frames().map(frame => frame.dataset.mappyEmbed)).toEqual(['Map.md', 'Timeline.md', 'Headings.md#同じ名前', 'Map.md']);
    expect(innerNode(frameOf('![[Timeline]]'), '第 1 週').hasClass('is-timeline')).toBe(true);
    expect(inner(frameOf('![[Headings#同じ名前]]'))).toEqual(['同じ名前', '深い']);
    expect(innerNode(frameOf('![[Headings#同じ名前]]'), '深い').hasClass('is-hierarchy')).toBe(true);
    // Nothing was written to draw them.
    expect(app.content(app.vault.getAbstractFileByPath(HOST_PATH) as never)).toBe(HOST);
    expect(app.content(app.vault.getAbstractFileByPath('Map.md') as never)).toBe(MAP);
    expect(app.activity.filter(entry => entry.kind === 'frontmatter')).toEqual([]);
  });

  it('keeps every other mention a link, an image or text: the note itself, an embed in a sentence, no `mappy: true`, missing, a block, code', async () => {
    const { nodes, frames } = await mount();
    const plain = Array.from(nodes().values()).filter(node => !node.hasClass('is-embed'));
    const links = new Map(plain.map(node => [node.getAttribute('aria-label') ?? '', node.querySelector<HTMLAnchorElement>('a.internal-link')?.dataset.href ?? null]));
    expect(links.get('![[Host]]')).toBe('Host');
    expect(links.get('![[Plain]]')).toBe('Plain');
    expect(links.get('![[Missing]]')).toBe('Missing');
    expect(links.get('![[Map#^block]]')).toBe('Map#^block');
    expect(links.get('文中の ![[Map]] は埋め込まない')).toBe('Map');
    expect(links.get('`![[Map]]`')).toBeNull();
    const image = plain.find(node => node.getAttribute('aria-label') === '![[image.png]]');
    expect(image?.querySelector('.image-embed img')).not.toBeNull();
    for (const node of plain) expect(node.querySelector('.mappy-embed, .internal-embed:not(.image-embed)')).toBeNull();
    expect(frames()).toHaveLength(4);
  });

  it('draws the same map twice, each frame folding on its own', async () => {
    const { frames, inner, settle } = await mount();
    const [first, , , second] = frames();
    if (!first || !second) throw new Error('two frames of Map expected');
    expect(first.dataset.mappyEmbed).toBe('Map.md');
    expect(second.dataset.mappyEmbed).toBe('Map.md');
    innerNode(second, '回復する').querySelector<HTMLElement>('.mappy-node-toggle')?.click();
    await settle();
    expect(inner(second)).toEqual(['講座', '回復する', '記録する', '葉', '睡眠', '運動']);
    expect(inner(first)).toEqual(['講座', '回復する', '記録する', '葉']);
  });
});

describe('recursion', () => {
  const A = ['---', 'mappy: true', '---', '## A', '- ![[B]]', '- ![[A]]', ''].join('\n');
  const B = ['---', 'mappy: true', '---', '## B', '- ![[A]]', '- ![[C]]', ''].join('\n');
  const C = ['---', 'mappy: true', '---', '## C', '- ![[A]]', '- 葉', ''].join('\n');

  it('shows the note itself and any embed inside an embedded map as links, so A → B → A and A → B → C → A end at a link', async () => {
    const a = await mount({ 'A.md': A, 'B.md': B, 'C.md': C }, 'A.md');
    expect(a.node('![[A]]').hasClass('is-embed')).toBe(false);
    expect(a.node('![[A]]').querySelector<HTMLAnchorElement>('a.internal-link')?.dataset.href).toBe('A');
    const b = a.frameOf('![[B]]');
    expect(a.inner(b)).toEqual(['B', '![[A]]', '![[C]]']);
    for (const title of ['![[A]]', '![[C]]']) {
      const inner = innerNode(b, title);
      expect(inner.hasClass('is-embed')).toBe(false);
      expect(inner.querySelector('.mappy-embed')).toBeNull();
      expect(inner.querySelector<HTMLAnchorElement>('a.internal-link')?.dataset.href).toBe(title.slice(3, -2));
    }
    expect(a.frames()).toHaveLength(1);
    expect(document.querySelectorAll('.mappy-embed')).toHaveLength(1);
    // Seen from B, the call back to A is the embed and A's own calls are links inside it.
    const fromB = await mount({ 'A.md': A, 'B.md': B, 'C.md': C }, 'B.md');
    expect(fromB.frames().map(frame => frame.dataset.mappyEmbed)).toEqual(['A.md', 'C.md']);
    expect(fromB.inner(fromB.frameOf('![[A]]'))).toEqual(['A', '![[B]]', '![[A]]']);
    expect(fromB.frameOf('![[A]]').querySelector('.mappy-embed')).toBeNull();
  });
});

describe('interaction with the outer map', () => {
  it('selects the node holding the map on a click inside the frame, folds inside the frame on its toggle, and never selects an inner node', async () => {
    const { node, frameOf, inner, settle, source } = await mount();
    const embed = node('![[Map]]');
    const frame = frameOf('![[Map]]');
    click(innerNode(frame, '記録する').querySelector('.mappy-node-label') ?? frame);
    expect(embed.hasClass('is-selected')).toBe(true);
    expect(embed.getAttribute('aria-selected')).toBe('true');
    expect(frame.querySelector('.mappy-node.is-selected')).toBeNull();
    // The inner toggle folds the embedded map only, and, like any click in the frame, selects and focuses the holding
    // node: the keyboard stays on the outer map instead of on a button the next inner redraw would throw away.
    click(node('呼び出し'));
    const toggle = innerNode(frame, '回復する').querySelector<HTMLElement>('.mappy-node-toggle');
    toggle?.focus();
    toggle?.click();
    await settle();
    expect(inner(frame)).toEqual(['講座', '回復する', '記録する', '葉', '睡眠', '運動']);
    expect(embed.hasClass('is-selected')).toBe(true);
    expect(node('呼び出し').hasClass('is-selected')).toBe(false);
    expect(document.activeElement).toBe(embed);
    expect(embed.hasClass('is-collapsed')).toBe(false);
    expect(source()).toBe(HOST);
    key(embed, ' ');
    await settle();
    expect(embed.hasClass('is-collapsed')).toBe(false);
    expect(inner(frame)).toEqual(['講座', '回復する', '記録する', '葉', '睡眠', '運動']);
    // The outer toggle folds the outer branch: the embed node goes with it, together with its frame.
    node('呼び出し').querySelector<HTMLElement>('.mappy-node-toggle')?.click();
    await settle();
    expect(document.contains(frame)).toBe(false);
    expect(node('呼び出し').hasClass('is-collapsed')).toBe(true);
  });

  it('opens the called map on a double click inside the frame, and edits the text `![[…]]` on F2 or a double click on the node itself', async () => {
    const { app, node, frameOf, editor, settle } = await mount();
    const embed = node('![[Map]]');
    const frame = frameOf('![[Map]]');
    click(frame);
    const opened = dblclick(innerNode(frame, '講座'));
    expect(opened.defaultPrevented).toBe(true);
    expect(app.activity.at(-1)).toMatchObject({ kind: 'link', detail: 'Map.md（Maps/Host.md から）' });
    expect(editor()).toBeNull();
    dblclick(frame, { metaKey: true });
    expect(app.activity.at(-1)).toMatchObject({ kind: 'link', detail: 'Map.md（Maps/Host.md から、新しいペイン）' });
    // Inside the frame, the map's own controls answer first: a link opens from the called note, not the host.
    const button = frame.querySelector<HTMLElement>('.mappy-embed-open');
    button?.click();
    expect(app.activity.at(-1)).toMatchObject({ kind: 'link', detail: 'Map.md（Maps/Host.md から）' });
    // A double click on the button or on a link is theirs (their clicks already opened); the frame does not open a third time.
    const opens = (): number => app.activity.filter(entry => entry.kind === 'link').length;
    const before = opens();
    if (button) dblclick(button);
    const anchor = frame.querySelector<HTMLElement>('a.internal-link');
    if (anchor) dblclick(anchor);
    expect(opens()).toBe(before);
    // F2 edits the title as written; the frame is hidden with the content while the editor shows and comes back untouched.
    key(embed, 'F2');
    expect(editor()?.value).toBe('![[Map]]');
    expect(frame.closest<HTMLElement>('.mappy-node-content')?.hidden).toBe(true);
    key(editor() ?? embed, 'Escape');
    await settle();
    expect(editor()).toBeNull();
    expect(frame.closest<HTMLElement>('.mappy-node-content')?.hidden).toBe(false);
    expect(frameOf('![[Map]]')).toBe(frame);
    // A double click on the node outside the frame edits too.
    dblclick(embed);
    expect(editor()?.value).toBe('![[Map]]');
    key(editor() ?? embed, 'Escape');
  });

  it('starts a drag of the holding node from inside the frame and pans the outer map on a wheel over it', async () => {
    const { canvas, node, frameOf, viewport } = await mount();
    const embed = node('![[Map]]');
    const frame = frameOf('![[Map]]');
    const label = innerNode(frame, '記録する');
    pointer('pointerdown', label, 300, 300);
    pointer('pointermove', label, 320, 330);
    expect(embed.hasClass('is-drag-source')).toBe(true);
    expect(label.hasClass('is-drag-source')).toBe(false);
    expect(canvas.querySelector('.mappy-drag-ghost')).not.toBeNull();
    key(canvas, 'Escape');
    expect(embed.hasClass('is-drag-source')).toBe(false);
    expect(canvas.querySelector('.mappy-drag-ghost')).toBeNull();
    const before = viewport();
    const innerWorld = frame.querySelector<HTMLElement>('.mappy-world')?.style.transform;
    label.dispatchEvent(new WheelEvent('wheel', { deltaX: 0, deltaY: 100, bubbles: true, cancelable: true }));
    const after = viewport();
    expect(after.y).toBeCloseTo(before.y - 100);
    expect(after.scale).toBe(before.scale);
    expect(frame.querySelector<HTMLElement>('.mappy-world')?.style.transform).toBe(innerWorld);
  });

  it('offers the holding node in the context menu opened inside the frame', async () => {
    const { node, frameOf } = await mount();
    const frame = frameOf('![[Map]]');
    innerNode(frame, '葉').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
    const items = Array.from(document.querySelectorAll('.menu .menu-item-title'), item => item.textContent ?? '');
    expect(items).toContain('テキストを編集');
    expect(items).toContain('枝を削除');
    expect(node('![[Map]]').hasClass('is-selected')).toBe(true);
    expect(frame.querySelector('.mappy-node.is-selected')).toBeNull();
  });
});

describe('editing the node that holds a map', () => {
  it('adds, indents and deletes the line as any other node, keeping the embed text as written', async () => {
    const { node, frameOf, source, settle, editor, frames } = await mount();
    click(node('![[Timeline]]'));
    key(node('![[Timeline]]'), 'Enter');
    await settle();
    expect(source()).toContain('  - ![[Timeline]]\n  - \n  - ![[Headings#同じ名前]]');
    expect(editor()).not.toBeNull();
    key(editor() ?? document.body, 'Escape');
    await settle();
    // The frame of the untouched node survives the refresh: the same element, not a redraw.
    const timeline = frameOf('![[Timeline]]');
    click(node('![[Timeline]]'));
    key(node('![[Timeline]]'), 'Tab');
    await settle();
    expect(source()).toContain('  - ![[Timeline]]\n    - \n  - \n');
    key(editor() ?? document.body, 'Escape');
    await settle();
    expect(frameOf('![[Timeline]]')).toBe(timeline);
    click(node('![[Timeline]]'));
    key(node('![[Timeline]]'), 'Delete');
    await settle();
    // The item and its child leave with their line breaks: no blank line stays in the list (LEV-75).
    expect(source()).not.toContain('![[Timeline]]');
    expect(source()).toContain('  - ![[Map]]\n  - \n  - ![[Headings#同じ名前]]\n- 同じマップをもう一度\n');
    // Two nodes of one title get new identities on every edit, so their order in the DOM is not fixed.
    expect(frames().map(frame => frame.dataset.mappyEmbed).sort()).toEqual(['Headings.md#同じ名前', 'Map.md', 'Map.md']);
    expect(document.contains(timeline)).toBe(false);
  });

  it('renames through the inline editor with the raw text, so the node becomes a link or another map as the text says', async () => {
    const { node, frameOf, editor, source, settle, frames } = await mount();
    click(node('![[Timeline]]'));
    key(node('![[Timeline]]'), 'F2');
    const input = editor();
    if (!input) throw new Error('no editor');
    input.value = '![[Headings]]';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    key(input, 'Enter');
    await settle();
    expect(source()).toContain('  - ![[Headings]]\n');
    expect(frames().map(frame => frame.dataset.mappyEmbed).sort()).toEqual(['Headings.md', 'Headings.md#同じ名前', 'Map.md', 'Map.md']);
    expect(frameOf('![[Headings]]').querySelector('.mappy-node.is-root')?.textContent?.trim()).toBe('構成');
    click(node('![[Headings]]'));
    key(node('![[Headings]]'), 'F2');
    const again = editor();
    if (!again) throw new Error('no editor');
    again.value = 'ただの文';
    again.dispatchEvent(new Event('input', { bubbles: true }));
    key(again, 'Enter');
    await settle();
    expect(node('ただの文').hasClass('is-embed')).toBe(false);
    expect(frames()).toHaveLength(3);
  });
});

describe('updates and release', () => {
  it('redraws the frames when the called note is saved or edited in another leaf, without touching the host', async () => {
    const { app, frames, inner, refreshed, source } = await mount();
    const mapFrames = (): HTMLElement[] => frames().filter(frame => frame.dataset.mappyEmbed === 'Map.md');
    app.put('Map.md', MAP.replace('- 葉', '- 新しい葉'));
    await refreshed();
    for (const frame of mapFrames()) expect(inner(frame)).toEqual(['講座', '回復する', '記録する', '新しい葉']);
    expect(source()).toBe(HOST);
    const file = app.vault.getAbstractFileByPath('Map.md');
    app.workspaceEvents.trigger('editor-change', {}, { file });
    await refreshed();
    expect(mapFrames()).toHaveLength(2);
    app.put('Map.md', MAP.replace('mappy: true', 'mappy: false'));
    await refreshed();
    for (const frame of mapFrames()) expect(frame.querySelector('.mappy-embed-message')?.textContent).toBe('Map はマップではなくなりました。開き直すと通常の表示に戻ります。');
  });

  it('judges the calls again when another note becomes a map, appears or goes, so the node becomes a frame or a link without editing the host', async () => {
    const host = ['---', 'mappy: true', '---', '## ホスト', '- ![[Later]]', '- ![[Plain]]', ''].join('\n');
    const { app, node, frames, settle, source } = await mount({ [HOST_PATH]: host, 'Plain.md': '## Plain\n- a\n' });
    expect(frames()).toHaveLength(0);
    expect(node('![[Later]]').querySelector<HTMLAnchorElement>('a.internal-link')?.dataset.href).toBe('Later');
    // The missing note is created as a map: the cache reports it and the node gets its frame.
    app.put('Later.md', MAP);
    await settle();
    expect(frames().map(frame => frame.dataset.mappyEmbed)).toEqual(['Later.md']);
    expect(node('![[Later]]').hasClass('is-embed')).toBe(true);
    // A plain note gains `mappy: true`: same again.
    app.put('Plain.md', '---\nmappy: true\n---\n## Plain\n- a\n');
    await settle();
    expect(frames().map(frame => frame.dataset.mappyEmbed)).toEqual(['Later.md', 'Plain.md']);
    // The called note is deleted: the node is a link again, no frame with a sentence lingers.
    app.remove('Later.md');
    await settle();
    expect(frames().map(frame => frame.dataset.mappyEmbed)).toEqual(['Plain.md']);
    expect(node('![[Later]]').hasClass('is-embed')).toBe(false);
    expect(node('![[Later]]').querySelector<HTMLAnchorElement>('a.internal-link')?.dataset.href).toBe('Later');
    expect(source()).toBe(host);
    // A cache change of an unrelated note, or of the host itself, redraws nothing.
    const plain = node('![[Plain]]');
    app.put('Other.md', '## Other\n');
    await settle();
    expect(node('![[Plain]]')).toBe(plain);
  });

  it('releases the embeds with the node: folding the branch, deleting the node and closing the view drop their listeners', async () => {
    const { app, view, node, frames, settle } = await mount();
    const listeners = (): number => app.vaultEvents.count() + app.workspaceEvents.count();
    const all = listeners();
    expect(frames()).toHaveLength(4);
    node('呼び出し').querySelector<HTMLElement>('.mappy-node-toggle')?.click();
    await settle();
    expect(frames()).toHaveLength(1);
    const folded = listeners();
    expect(folded).toBeLessThan(all);
    node('呼び出し').querySelector<HTMLElement>('.mappy-node-toggle')?.click();
    await settle();
    expect(frames()).toHaveLength(4);
    expect(listeners()).toBe(all);
    click(node('同じマップをもう一度'));
    key(node('同じマップをもう一度'), 'Delete');
    await settle();
    expect(frames()).toHaveLength(3);
    expect(listeners()).toBe(all - (all - folded) / 3);
    await view.onClose();
    view.unload();
    views.splice(views.indexOf(view), 1);
    expect(listeners()).toBe(0);
    expect(document.querySelector('.mappy-embed')).toBeNull();
    // A later change of a called note is nobody's business any more.
    app.put('Map.md', MAP.replace('- 葉', '- 後で'));
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(document.querySelector('.mappy-node')).toBeNull();
  });
});
