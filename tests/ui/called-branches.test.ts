// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, WorkspaceLeaf as ObsidianLeaf, ViewStateResult } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { Notice, WorkspaceLeaf } from '../../harness/browser/obsidian';
import { calledNodeId } from '../../src/core/calls';
import type { MindDocument } from '../../src/core/markdown';
import { sceneContents } from '../../src/export/excalidraw-scene';
import { DocumentStore } from '../../src/obsidian/document-store';
import type { ViewRouter } from '../../src/obsidian/view-routing';
import { CALLED_READ_ONLY_MESSAGE, MindmapView } from '../../src/ui/mindmap-view';

/**
 * §5 M12, the display side: a node whose title is one `![[map]]` stands in for the called map's
 * root and the called map's body tree is grafted under it as branches of this map, read-only. The
 * shipped view, renderer, reader and store run against the browser-harness stand-in for `obsidian`.
 */
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });

const HOST_PATH = 'Maps/Host.md';
const MAP = ['---', 'mappy: true', '---', '## 講座', '- 回復する', '  - 睡眠', '    - 昼寝', '  - 運動', '- 記録する', '  - 日誌', '- 葉', '', '## 補足', '- 用語', ''].join('\n');
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
  Notice.log.length = 0;
});

/** Canvas at (10, 20) of 1200 × 800 screen pixels; jsdom has no geometry of its own. */
const CANVAS = { x: 10, y: 20, left: 10, top: 20, width: 1200, height: 800, right: 1210, bottom: 820, toJSON: () => ({}) };

interface Mounted {
  app: HarnessApp;
  view: MindmapView;
  canvas: HTMLElement;
  document: () => MindDocument;
  /** Every node element on the map, by id, in DOM order. */
  nodes: () => Map<string, HTMLElement>;
  /** The n-th node element whose label (`aria-label`) is this text. */
  node: (title: string, occurrence?: number) => HTMLElement;
  /** The titles on the map, in the order the view lists them (preorder over the trees shown). */
  titles: () => string[];
  /** The elements of a called map's branches (`is-called`, the calling item among them). */
  called: () => HTMLElement[];
  /** The calling items' labels (the called roots' text), in layout order. */
  calledRoots: () => string[];
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

function labelOf(node: HTMLElement): string {
  return node.getAttribute('aria-label') ?? '';
}

async function mount(notes: Record<string, string> = NOTES, hostPath = HOST_PATH, layout = 'mindmap'): Promise<Mounted> {
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
  const canvas = view.contentEl.querySelector<HTMLElement>(':scope > .mappy-canvas');
  if (!canvas) throw new Error('The view has no canvas');
  canvas.getBoundingClientRect = () => CANVAS;
  canvas.setPointerCapture = () => undefined;
  canvas.releasePointerCapture = () => undefined;
  canvas.hasPointerCapture = () => false;
  let hitElement: Element | null = null;
  document.elementFromPoint = () => hitElement ?? canvas;
  await view.setState({ file: hostPath, layout }, { history: false } satisfies ViewStateResult);
  await settleDom();
  const file = app.vault.getAbstractFileByPath(hostPath);
  if (!file) throw new Error('no host');
  const all = (): HTMLElement[] => Array.from(canvas.querySelectorAll<HTMLElement>('.mappy-node'));
  const node = (title: string, occurrence = 0): HTMLElement => {
    const found = all().filter(candidate => labelOf(candidate) === title)[occurrence];
    if (!found) throw new Error(`No node ${title} (${occurrence})`);
    return found;
  };
  return {
    app, view, canvas, node,
    nodes: () => new Map(all().map(element => [element.dataset.nodeId ?? '', element])),
    titles: () => {
      // The renderer keeps DOM order by first appearance; the view's own order is the layout's preorder.
      const layout = (view as unknown as { layout?: { nodes: { id: string }[] } }).layout;
      const byId = new Map(all().map(element => [element.dataset.nodeId ?? '', labelOf(element)]));
      return (layout?.nodes ?? []).map(item => byId.get(item.id) ?? '').filter(Boolean);
    },
    called: () => all().filter(element => element.hasClass('is-called')),
    calledRoots: () => {
      const layout = (view as unknown as { layout?: { nodes: { id: string }[] } }).layout;
      const byId = new Map(all().map(element => [element.dataset.nodeId ?? '', element]));
      return (layout?.nodes ?? []).map(item => byId.get(item.id)).filter((element): element is HTMLElement => element?.hasClass('is-called-root') ?? false).map(labelOf);
    },
    document: () => {
      const parsed = view.snapshot()?.document;
      if (!parsed) throw new Error('The view has not parsed its note');
      return parsed;
    },
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

function contextMenu(target: EventTarget): string[] {
  target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
  const items = Array.from(document.querySelectorAll('.menu .menu-item-title'), item => item.textContent ?? '');
  document.querySelectorAll('.menu').forEach(menu => { menu.remove(); });
  return items;
}

describe('a node whose title is one `![[map]]` (judgement and drawing)', () => {
  it('stands in for the called root and grafts the called body under it, marked as called, its deeper branches folded, nothing written', async () => {
    const { node, called, titles, app, canvas, source, view } = await mount();
    expect(canvas.querySelector('.mappy-embed')).toBeNull();
    const calling = node('講座');
    expect(calling.hasClass('is-called')).toBe(true);
    expect(calling.hasClass('is-called-root')).toBe(true);
    expect(calling.hasClass('is-stage')).toBe(false);
    expect(calling.getAttribute('title')).toBe('呼び出し元: Map.md');
    expect(calling.getAttribute('aria-readonly')).toBe('true');
    expect(calling.querySelector(':scope > .mappy-node-content > .mappy-node-call-mark')).not.toBeNull();
    expect(calling.querySelector('.mappy-node-label')?.textContent).toBe('講座');
    // The calling item keeps its own identity: the host's node id, not a called one.
    expect(calling.dataset.nodeId).toBe(view.snapshot()?.document?.nodes.find(item => item.title === '![[Map]]')?.id);
    expect(calling.dataset.nodeId?.includes('/')).toBe(false);
    // The called root's children show; their own children start folded, the badge counting what is behind.
    const recover = node('回復する');
    expect(recover.hasClass('is-called')).toBe(true);
    expect(recover.hasClass('is-called-root')).toBe(false);
    expect(recover.dataset.nodeId).toBe(calledNodeId(calling.dataset.nodeId ?? '', recover.dataset.nodeId?.split('/')[1] ?? ''));
    expect(recover.hasClass('is-collapsed')).toBe(true);
    expect(recover.querySelector('.mappy-node-toggle-mark')?.textContent).toBe('3');
    expect(recover.querySelector('.mappy-node-call-mark')).toBeNull();
    expect(recover.getAttribute('title')).toBe('呼び出し元: Map.md');
    expect(titles().slice(0, 9)).toEqual(['ホスト', '呼び出し', '講座', '回復する', '記録する', '葉', '進行', '第 1 週', '第 2 週']);
    // The called note's free topic (補足) is not drawn; the heading call draws its section only.
    expect(titles()).not.toContain('補足');
    expect(node('同じ名前').getAttribute('title')).toBe('呼び出し元: Headings.md#同じ名前');
    expect(titles()).toContain('深い');
    expect(titles()).not.toContain('構成');
    expect(called()).toHaveLength(2 * 4 + 3 + 2);
    // Nothing was written to draw them.
    expect(source()).toBe(HOST);
    expect(app.content(app.vault.getAbstractFileByPath('Map.md') as never)).toBe(MAP);
    expect(app.activity.filter(entry => entry.kind === 'frontmatter')).toEqual([]);
  });

  it('lays the called branches out in the host\'s layout, not the called note\'s `mappy-layout`', async () => {
    const { node, view, settle } = await mount();
    expect(node('第 1 週').hasClass('is-timeline')).toBe(false);
    expect(node('深い').hasClass('is-hierarchy')).toBe(false);
    for (const layout of ['timeline', 'hierarchy', 'balanced'] as const) {
      await view.setState({ file: HOST_PATH, layout }, { history: false } satisfies ViewStateResult);
      await settle();
      expect(node('第 1 週').hasClass(`is-${layout}`)).toBe(true);
      expect(node('深い').hasClass(`is-${layout}`)).toBe(true);
      expect(node('講座').hasClass(`is-${layout}`)).toBe(true);
    }
  });

  it('keeps every other mention a link, an image or text: the note itself, an embed in a sentence, no `mappy: true`, missing, a block, code', async () => {
    const { nodes, called } = await mount();
    const plain = Array.from(nodes().values()).filter(node => !node.hasClass('is-called'));
    const links = new Map(plain.map(node => [labelOf(node), node.querySelector<HTMLAnchorElement>('a.internal-link')?.dataset.href ?? null]));
    expect(links.get('![[Host]]')).toBe('Host');
    expect(links.get('![[Plain]]')).toBe('Plain');
    expect(links.get('![[Missing]]')).toBe('Missing');
    expect(links.get('![[Map#^block]]')).toBe('Map#^block');
    expect(links.get('文中の ![[Map]] は埋め込まない')).toBe('Map');
    expect(links.get('`![[Map]]`')).toBeNull();
    const image = plain.find(node => labelOf(node) === '![[image.png]]');
    expect(image?.querySelector('.image-embed img')).not.toBeNull();
    for (const node of plain) expect(node.hasAttribute('title')).toBe(false);
    expect(called().filter(node => node.hasClass('is-called-root')).map(labelOf)).toEqual(['講座', '進行', '同じ名前', '講座']);
  });

  it('draws the same map twice under distinct ids, each folding on its own', async () => {
    const { node, settle } = await mount();
    const first = node('回復する', 0);
    const second = node('回復する', 1);
    expect(first.dataset.nodeId).not.toBe(second.dataset.nodeId);
    expect(first.dataset.nodeId?.split('/')[1]).toBe(second.dataset.nodeId?.split('/')[1]);
    second.querySelector<HTMLElement>('.mappy-node-toggle')?.click();
    await settle();
    expect(node('回復する', 1).hasClass('is-collapsed')).toBe(false);
    expect(node('回復する', 0).hasClass('is-collapsed')).toBe(true);
    expect(node('睡眠').hasClass('is-collapsed')).toBe(true);
    expect(node('睡眠').querySelector('.mappy-node-toggle-mark')?.textContent).toBe('1');
  });
});

describe('recursion', () => {
  const A = ['---', 'mappy: true', '---', '## A', '- ![[B]]', '- ![[A]]', ''].join('\n');
  const B = ['---', 'mappy: true', '---', '## B', '- ![[A]]', '- ![[C]]', ''].join('\n');
  const C = ['---', 'mappy: true', '---', '## C', '- ![[A]]', '- 葉', ''].join('\n');

  it('keeps the note itself and any call inside a called map a link, so A → B → A and A → B → C → A end at a link', async () => {
    const a = await mount({ 'A.md': A, 'B.md': B, 'C.md': C }, 'A.md');
    expect(a.titles()).toEqual(['A', 'B', '![[A]]', '![[C]]', '![[A]]']);
    expect(a.node('![[A]]', 1).hasClass('is-called')).toBe(false);
    expect(a.node('![[A]]', 1).querySelector<HTMLAnchorElement>('a.internal-link')?.dataset.href).toBe('A');
    for (const title of ['![[A]]', '![[C]]']) {
      const inner = a.node(title, 0);
      expect(inner.hasClass('is-called')).toBe(true);
      expect(inner.hasClass('is-called-root')).toBe(false);
      expect(inner.querySelector<HTMLAnchorElement>('a.internal-link')?.dataset.href).toBe(title.slice(3, -2));
    }
    expect(a.called()).toHaveLength(3);
    // Seen from B, the call back to A is grafted and A's own calls are links inside it.
    const fromB = await mount({ 'A.md': A, 'B.md': B, 'C.md': C }, 'B.md');
    expect(fromB.titles()).toEqual(['B', 'A', '![[B]]', '![[A]]', 'C', '![[A]]', '葉']);
    expect(fromB.called().filter(node => node.hasClass('is-called-root')).map(labelOf)).toEqual(['A', 'C']);
  });
});

describe('the called branches are read-only', () => {
  it('selects a called node on click, folds it with Space and its toggle, and walks into it with the arrows', async () => {
    const { node, settle, source, view } = await mount();
    const recover = node('回復する');
    click(recover.querySelector('.mappy-node-label') ?? recover);
    expect(recover.hasClass('is-selected')).toBe(true);
    expect(recover.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(recover);
    key(recover, ' ');
    await settle();
    expect(node('回復する').hasClass('is-collapsed')).toBe(false);
    expect(node('睡眠').hasClass('is-collapsed')).toBe(true);
    key(node('回復する'), 'ArrowRight');
    expect(node('睡眠').hasClass('is-selected')).toBe(true);
    key(node('睡眠'), 'ArrowLeft');
    expect(node('回復する').hasClass('is-selected')).toBe(true);
    key(node('回復する'), 'ArrowLeft');
    expect(node('講座').hasClass('is-selected')).toBe(true);
    key(node('講座'), 'ArrowRight');
    expect(node('回復する').hasClass('is-selected')).toBe(true);
    node('回復する').querySelector<HTMLElement>('.mappy-node-toggle')?.click();
    await settle();
    expect(node('回復する').hasClass('is-collapsed')).toBe(true);
    expect(source()).toBe(HOST);
    // The folds are the view's, kept with the map, and the called note is untouched.
    expect(view.snapshot()?.collapsed.has(node('回復する').dataset.nodeId ?? '')).toBe(true);
  });

  it('refuses Enter, Tab, Delete, Backspace, F2, ⌥↑, image drops and the body editor on a called node with a notice, leaving the note as it is', async () => {
    const { node, settle, source, editor } = await mount();
    const leaf = node('葉');
    click(leaf);
    for (const value of ['Enter', 'Tab', 'Delete', 'Backspace']) {
      Notice.log.length = 0;
      const event = key(leaf, value);
      await settle();
      expect(event.defaultPrevented).toBe(true);
      expect(source()).toBe(HOST);
      expect(editor()).toBeNull();
      expect(Notice.log).toEqual([CALLED_READ_ONLY_MESSAGE]);
    }
    Notice.log.length = 0;
    key(leaf, 'ArrowUp', { altKey: true });
    await settle();
    expect(source()).toBe(HOST);
    expect(Notice.log).toEqual([CALLED_READ_ONLY_MESSAGE]);
    Notice.log.length = 0;
    key(leaf, 'F2');
    expect(editor()).toBeNull();
    expect(Notice.log).toEqual([CALLED_READ_ONLY_MESSAGE]);
    // A file dropped on it is refused before anything is created.
    Notice.log.length = 0;
    const image = new File(['png'], 'figure.png', { type: 'image/png' });
    const transfer = { types: ['Files'], files: [image] } as unknown as DataTransfer;
    const drop = new MouseEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: transfer });
    leaf.dispatchEvent(drop);
    await settle();
    expect(Notice.log).toEqual([CALLED_READ_ONLY_MESSAGE]);
    expect(source()).toBe(HOST);
    expect(document.querySelector('.modal')).toBeNull();
  });

  it('never drags a called node, and never previews a drop onto one', async () => {
    const { canvas, node, hit } = await mount();
    const leaf = node('葉');
    pointer('pointerdown', leaf, 300, 300);
    pointer('pointermove', leaf, 320, 330);
    pointer('pointermove', leaf, 360, 360);
    expect(leaf.hasClass('is-drag-source')).toBe(false);
    expect(canvas.querySelector('.mappy-drag-ghost')).toBeNull();
    pointer('pointerup', canvas, 360, 360);
    // The host's own node dragged over a called node: no slot, no placeholder.
    const own = node('リンクのまま');
    pointer('pointerdown', own, 300, 300);
    pointer('pointermove', canvas, 320, 330);
    expect(canvas.querySelector('.mappy-drag-ghost')).not.toBeNull();
    hit(leaf);
    pointer('pointermove', canvas, 340, 340);
    pointer('pointermove', canvas, 350, 345);
    expect(canvas.querySelector<HTMLElement>('.mappy-drop-placeholder')?.hidden).toBe(true);
    key(canvas, 'Escape');
    expect(canvas.querySelector('.mappy-drag-ghost')).toBeNull();
  });

  it('opens the called note on a double click of any of its nodes, the calling item included, in a new leaf with ⌘', async () => {
    const { app, node, editor } = await mount();
    const opened = dblclick(node('葉'));
    expect(opened.defaultPrevented).toBe(true);
    expect(app.activity.at(-1)).toMatchObject({ kind: 'link', detail: 'Map.md（Maps/Host.md から）' });
    expect(editor()).toBeNull();
    dblclick(node('講座'), { metaKey: true });
    expect(app.activity.at(-1)).toMatchObject({ kind: 'link', detail: 'Map.md（Maps/Host.md から、新しいペイン）' });
    expect(editor()).toBeNull();
    dblclick(node('深い'));
    expect(app.activity.at(-1)).toMatchObject({ kind: 'link', detail: 'Headings.md（Maps/Host.md から）' });
    // The host's own node still edits on a double click.
    dblclick(node('リンクのまま'));
    expect(editor()?.value).toBe('リンクのまま');
  });

  it('offers only the note, the fold and the history in the context menu of a called node; the calling item keeps its edits', async () => {
    const { node } = await mount();
    expect(contextMenu(node('回復する'))).toEqual(['元のマップを開く', '折りたたみ', '元に戻す', 'やり直す']);
    expect(contextMenu(node('葉'))).toEqual(['元のマップを開く', '元に戻す', 'やり直す']);
    expect(node('葉').hasClass('is-selected')).toBe(true);
    const calling = contextMenu(node('講座'));
    expect(calling.slice(0, 2)).toEqual(['元のマップを開く', 'テキストを編集']);
    expect(calling).toContain('枝を削除');
    expect(contextMenu(node('リンクのまま'))).not.toContain('元のマップを開く');
  });
});

describe('editing the calling item', () => {
  it('edits the text as written on F2, adds siblings and its own children, which follow the called branches, and deletes the branches with it', async () => {
    const { node, source, settle, editor, titles, calledRoots } = await mount();
    click(node('進行'));
    key(node('進行'), 'F2');
    expect(editor()?.value).toBe('![[Timeline]]');
    key(editor() ?? document.body, 'Escape');
    await settle();
    expect(node('進行').hasClass('is-called-root')).toBe(true);
    click(node('進行'));
    key(node('進行'), 'Tab');
    await settle();
    expect(source()).toContain('  - ![[Timeline]]\n    - \n  - ![[Headings#同じ名前]]');
    const input = editor();
    if (!input) throw new Error('no editor');
    input.value = '自分の子';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    key(input, 'Enter');
    await settle();
    expect(titles().slice(titles().indexOf('進行'), titles().indexOf('進行') + 4)).toEqual(['進行', '第 1 週', '第 2 週', '自分の子']);
    expect(node('自分の子').hasClass('is-called')).toBe(false);
    click(node('進行'));
    key(node('進行'), 'Enter');
    await settle();
    expect(source()).toContain('    - 自分の子\n  - \n  - ![[Headings#同じ名前]]');
    key(editor() ?? document.body, 'Escape');
    await settle();
    click(node('進行'));
    key(node('進行'), 'Delete');
    await settle();
    expect(source()).not.toContain('![[Timeline]]');
    expect(source()).toContain('  - ![[Map]]\n  - \n  - ![[Headings#同じ名前]]\n');
    expect(titles()).not.toContain('第 1 週');
    expect(calledRoots()).toEqual(['講座', '同じ名前', '講座']);
    key(node('ホスト'), 'z', { metaKey: true });
    await settle();
    expect(source()).toContain('  - ![[Timeline]]\n    - 自分の子\n');
    expect(titles()).toContain('第 1 週');
  });

  it('renames through the inline editor with the raw text, so the node calls another map or becomes a link as the text says', async () => {
    const { node, editor, source, settle, calledRoots } = await mount();
    click(node('進行'));
    key(node('進行'), 'F2');
    const input = editor();
    if (!input) throw new Error('no editor');
    input.value = '![[Headings]]';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    key(input, 'Enter');
    await settle();
    expect(source()).toContain('  - ![[Headings]]\n');
    expect(node('構成').hasClass('is-called-root')).toBe(true);
    expect(node('構成').getAttribute('title')).toBe('呼び出し元: Headings.md');
    // The whole note: its first level shown (回復する, 記録する), the levels below folded.
    expect(node('回復する', 1).hasClass('is-collapsed')).toBe(true);
    click(node('構成'));
    key(node('構成'), 'F2');
    const again = editor();
    if (!again) throw new Error('no editor');
    again.value = 'ただの文';
    again.dispatchEvent(new Event('input', { bubbles: true }));
    key(again, 'Enter');
    await settle();
    expect(node('ただの文').hasClass('is-called')).toBe(false);
    expect(calledRoots()).toEqual(['講座', '同じ名前', '講座']);
  });

  it('refuses a map called under a called node, and calls one under the calling item', async () => {
    const { app, node, view, source, settle } = await mount();
    click(node('葉'));
    const timeline = app.vault.getAbstractFileByPath('Timeline.md');
    if (!timeline) throw new Error('no Timeline');
    await expect(view.callMap(timeline as never)).rejects.toThrow(CALLED_READ_ONLY_MESSAGE);
    expect(source()).toBe(HOST);
    click(node('講座'));
    await view.callMap(timeline as never);
    await settle();
    expect(source()).toContain('  - ![[Map]]\n    - ![[Timeline]]\n');
    expect(node('進行', 0).parentElement).not.toBeNull();
  });
});

describe('updates and release', () => {
  it('follows an edit of the called note, saved or in another leaf, keeping the folds and leaving the host alone', async () => {
    const { app, node, refreshed, source, titles, settle } = await mount();
    node('回復する', 0).querySelector<HTMLElement>('.mappy-node-toggle')?.click();
    await settle();
    expect(node('回復する', 0).hasClass('is-collapsed')).toBe(false);
    app.put('Map.md', MAP.replace('- 葉', '- 新しい葉\n  - 芽'));
    await refreshed();
    expect(titles()).toContain('新しい葉');
    expect(titles()).not.toContain('葉');
    expect(node('回復する', 0).hasClass('is-collapsed')).toBe(false);
    expect(node('回復する', 1).hasClass('is-collapsed')).toBe(true);
    // A branch new to the note starts folded, as on open.
    expect(node('新しい葉', 0).hasClass('is-collapsed')).toBe(true);
    expect(source()).toBe(HOST);
    const file = app.vault.getAbstractFileByPath('Map.md');
    app.workspaceEvents.trigger('editor-change', {}, { file });
    await refreshed();
    expect(titles().filter(title => title === '新しい葉')).toHaveLength(2);
    app.put('Map.md', MAP.replace('mappy: true', 'mappy: false'));
    await refreshed();
    expect(titles()).not.toContain('講座');
    expect(node('![[Map]]', 0).querySelector<HTMLAnchorElement>('a.internal-link')?.dataset.href).toBe('Map');
    expect(node('![[Map]]', 0).hasClass('is-called')).toBe(false);
  });

  it('judges the calls again when another note becomes a map, appears or goes, without editing the host', async () => {
    const host = ['---', 'mappy: true', '---', '## ホスト', '- ![[Later]]', '- ![[Plain]]', ''].join('\n');
    const { app, node, called, refreshed, source, nodes } = await mount({ [HOST_PATH]: host, 'Plain.md': '## Plain\n- a\n' });
    expect(called()).toHaveLength(0);
    expect(node('![[Later]]').querySelector<HTMLAnchorElement>('a.internal-link')?.dataset.href).toBe('Later');
    app.put('Later.md', MAP);
    await refreshed();
    expect(node('講座').hasClass('is-called-root')).toBe(true);
    expect(node('講座').getAttribute('title')).toBe('呼び出し元: Later.md');
    app.put('Plain.md', '---\nmappy: true\n---\n## Plain\n- a\n');
    await refreshed();
    expect(node('Plain').hasClass('is-called-root')).toBe(true);
    expect(node('a').hasClass('is-called')).toBe(true);
    app.remove('Later.md');
    await refreshed();
    expect(node('![[Later]]').hasClass('is-called')).toBe(false);
    expect(node('![[Later]]').querySelector<HTMLAnchorElement>('a.internal-link')?.dataset.href).toBe('Later');
    expect(source()).toBe(host);
    // A change of an unrelated note redraws nothing: the same elements stay.
    const before = Array.from(nodes().values());
    app.put('Other.md', '## Other\n');
    await refreshed();
    expect(Array.from(nodes().values())).toEqual(before);
  });

  it('starts a large called map with only its root\'s children shown, so the host stays responsive', async () => {
    const lines = ['---', 'mappy: true', '---', '## 大きい'];
    for (let section = 0; section < 20; section += 1) {
      lines.push(`- 節 ${section}`);
      for (let item = 0; item < 10; item += 1) {
        lines.push(`  - 項目 ${section}-${item}`);
        for (let leaf = 0; leaf < 9; leaf += 1) lines.push(`    - 葉 ${section}-${item}-${leaf}`);
      }
    }
    const big = `${lines.join('\n')}\n`;
    const host = ['---', 'mappy: true', '---', '## ホスト', '- ![[Big]]', ''].join('\n');
    const { node, nodes, called, settle, view } = await mount({ [HOST_PATH]: host, 'Big.md': big });
    expect(nodes().size).toBe(2 + 20);
    expect(node('節 0').hasClass('is-collapsed')).toBe(true);
    expect(node('節 0').querySelector('.mappy-node-toggle-mark')?.textContent).toBe('100');
    node('節 0').querySelector<HTMLElement>('.mappy-node-toggle')?.click();
    await settle();
    expect(nodes().size).toBe(2 + 20 + 10);
    expect(node('項目 0-0').hasClass('is-collapsed')).toBe(true);
    expect(called()).toHaveLength(1 + 20 + 10);
    expect(view.snapshot()?.document?.nodes).toHaveLength(2);
  });

  it('exports the called branches as ordinary nodes to the SVG capture and the Excalidraw scene', async () => {
    const { view, node } = await mount();
    const snapshot = view.snapshot();
    if (!snapshot?.document) throw new Error('no snapshot');
    const callingId = node('講座').dataset.nodeId ?? '';
    const called = snapshot.calls.get(callingId)?.document;
    const sleep = calledNodeId(callingId, called?.nodes.find(item => item.title === '睡眠')?.id ?? '');
    const capture = await view.exportSource();
    const ids = new Set(capture.layout.nodes.map(item => item.id));
    expect(ids.has(node('回復する').dataset.nodeId ?? '')).toBe(true);
    // 睡眠 is behind the fold of 回復する: not on screen, so not in the file.
    expect(ids.has(sleep)).toBe(false);
    expect(capture.entries.get(node('回復する').dataset.nodeId ?? '')?.element.hasClass('is-called')).toBe(true);
    const scene = sceneContents(snapshot.document, snapshot.collapsed, snapshot.calls);
    const byId = new Map(scene.nodes.map(item => [item.id, item]));
    expect(byId.get(callingId)).toMatchObject({ text: '講座', role: 'branch', link: 'Map.md', sourcePath: 'Map.md' });
    expect(byId.get(node('回復する').dataset.nodeId ?? '')).toMatchObject({ text: '回復する', sourcePath: 'Map.md', link: null });
    expect(byId.has(sleep)).toBe(false);
    expect(byId.get(node('リンクのまま').dataset.nodeId ?? '')?.sourcePath).toBeUndefined();
    expect(scene.nodes.map(item => item.text)).toContain('深い');
  });

  it('drops its listeners with the view, so a later change of a called note is nobody\'s business', async () => {
    const { app, view } = await mount();
    const listeners = (): number => app.vaultEvents.count() + app.workspaceEvents.count();
    expect(listeners()).toBeGreaterThan(0);
    await view.onClose();
    view.unload();
    views.splice(views.indexOf(view), 1);
    expect(listeners()).toBe(0);
    app.put('Map.md', MAP.replace('- 葉', '- 後で'));
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(document.querySelector('.mappy-node')).toBeNull();
  });
});
