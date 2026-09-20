// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, WorkspaceLeaf as ObsidianLeaf, ViewStateResult } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { WorkspaceLeaf } from '../../harness/browser/obsidian';
import { findFixture } from '../../harness/browser/fixtures';
import { planEdit, type MoveCommand } from '../../src/core/commands';
import { projectMap, type MindDocument, type MindNode } from '../../src/core/markdown';
import { TOPICS_KEY, readTopicPositions } from '../../src/core/topics';
import { PLACEHOLDER_ID } from '../../src/layout/drop-preview';
import type { LayoutMode, LayoutResult } from '../../src/layout/layout';
import { DocumentStore } from '../../src/obsidian/document-store';
import type { ViewRouter } from '../../src/obsidian/view-routing';
import { MindmapView } from '../../src/ui/mindmap-view';

// The browser-harness stand-in for `obsidian`, so the shipped view, renderer and store run against a real DOM.
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });
afterEach(() => { document.body.replaceChildren(); });

const PATH = 'Fixtures/free-topics.md';

function fixtureSource(): string {
  const fixture = findFixture('free-topics');
  if (!fixture) throw new Error('Missing free-topics fixture');
  return fixture.source;
}

/** The view's own parse, whose node IDs the DOM carries. */
function documentOf(view: MindmapView): MindDocument {
  const document = view.snapshot()?.document;
  if (!document) throw new Error('The view has not parsed its note');
  return document;
}

interface Mounted {
  app: HarnessApp;
  view: MindmapView;
  store: DocumentStore;
  canvas: HTMLElement;
  file: never;
  layout: () => LayoutResult;
  transform: (id: string) => { x: number; y: number };
  nodes: () => Map<string, HTMLElement>;
  /** The note as the in-memory vault holds it now. */
  source: () => string;
  /** Let queued saves, refreshes and one layout frame run. */
  settle: () => Promise<void>;
  topic: (title: string) => MindNode;
  dblclick: (target: EventTarget, clientX: number, clientY: number) => MouseEvent;
  pointer: (type: string, target: EventTarget, clientX: number, clientY: number) => PointerEvent;
  key: (target: EventTarget, key: string, init?: KeyboardEventInit) => KeyboardEvent;
  contextmenu: (target: EventTarget, clientX: number, clientY: number) => string[];
  editor: () => HTMLTextAreaElement | null;
  /** ⌘Z / ⌘⇧Z on the canvas: the map's own history, then a refresh. */
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /** What hit testing reports under the pointer (jsdom has no geometry): a node element, or the canvas. */
  hit: (element: Element | null) => void;
  viewport: () => { x: number; y: number; scale: number };
}

/** Canvas at (10, 20) of 1200 × 800 screen pixels; jsdom has no geometry of its own. */
const CANVAS = { x: 10, y: 20, left: 10, top: 20, width: 1200, height: 800, right: 1210, bottom: 820, toJSON: () => ({}) };

async function mount(source: string, layout: LayoutMode = 'mindmap'): Promise<Mounted> {
  const app = new HarnessApp();
  app.put(PATH, source);
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
  // jsdom implements neither pointer capture nor hit testing; the drag code tolerates both.
  canvas.setPointerCapture = () => undefined;
  canvas.releasePointerCapture = () => undefined;
  canvas.hasPointerCapture = () => false;
  let hitElement: Element | null = null;
  document.elementFromPoint = () => hitElement ?? canvas;
  await view.setState({ file: PATH, layout }, { history: false } satisfies ViewStateResult);
  await new Promise(resolve => requestAnimationFrame(resolve));
  const nodes = (): Map<string, HTMLElement> => new Map(Array.from(
    view.containerEl.querySelectorAll<HTMLElement>('.mappy-node'), node => [node.dataset.nodeId ?? '', node],
  ));
  const file = app.asApp<App>().vault.getAbstractFileByPath(PATH) as never;
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 3; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => requestAnimationFrame(resolve));
  };
  return {
    app, view, store, canvas, file, nodes, settle,
    layout: () => {
      const result = (view as unknown as { layout: LayoutResult | undefined }).layout;
      if (!result) throw new Error('Layout has not run');
      return result;
    },
    transform: (id) => {
      const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/u.exec(nodes().get(id)?.style.transform ?? '');
      if (!match) throw new Error(`No transform for ${id}`);
      return { x: Number(match[1]), y: Number(match[2]) };
    },
    source: () => app.content(file),
    topic: (title) => {
      const node = projectMap(documentOf(view)).topics.find(candidate => candidate.title === title);
      if (!node) throw new Error(`Missing topic ${title}`);
      return node;
    },
    dblclick: (target, clientX, clientY) => {
      const event = new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX, clientY });
      target.dispatchEvent(event);
      return event;
    },
    pointer: (type, target, clientX, clientY) => {
      const event = new PointerEvent(type, { pointerId: 1, button: 0, bubbles: true, cancelable: true, clientX, clientY });
      target.dispatchEvent(event);
      return event;
    },
    key: (target, value, init = {}) => {
      const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    },
    contextmenu: (target, clientX, clientY) => {
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY }));
      return Array.from(document.querySelectorAll('.menu .menu-item-title'), item => item.textContent ?? '');
    },
    editor: () => view.containerEl.querySelector<HTMLTextAreaElement>('textarea.mappy-inline-input'),
    undo: async () => {
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }));
      await settle();
    },
    redo: async () => {
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      await settle();
    },
    hit: element => { hitElement = element; },
    viewport: () => view.getState().viewport as { x: number; y: number; scale: number },
  };
}

function menuItem(title: string): HTMLElement {
  const item = Array.from(document.querySelectorAll<HTMLElement>('.menu .menu-item'))
    .find(candidate => candidate.querySelector('.menu-item-title')?.textContent === title);
  if (!item) throw new Error(`Menu item ${title} is not open`);
  return item;
}

describe('MindmapView with free topics', () => {
  it('shows the first H2 as the body root and every later H2 as a topic root, each styled as a root of its own tree', async () => {
    const source = fixtureSource();
    const { view, nodes } = await mount(source);
    const doc = documentOf(view);
    const { root, topics } = projectMap(doc);
    const byTitle = new Map(doc.nodes.map(node => [node.title, node.id]));
    const elements = nodes();
    expect(elements.has('root')).toBe(false);
    expect(elements.get(byTitle.get('講座の本体') ?? '')?.classList.contains('is-root')).toBe(true);
    expect(elements.get(byTitle.get('講座の本体') ?? '')?.classList.contains('is-topic')).toBe(false);
    for (const topic of topics) {
      const element = elements.get(topic.id);
      expect(element?.classList.contains('is-root')).toBe(true);
      expect(element?.classList.contains('is-topic')).toBe(true);
      expect(element?.classList.contains('is-stage')).toBe(false);
      for (const child of topic.children) expect(elements.get(child.id)?.classList.contains('is-stage')).toBe(true);
    }
    expect(elements.get(byTitle.get('回復する') ?? '')?.classList.contains('is-stage')).toBe(true);
    expect(elements.size).toBe(doc.nodes.length);
    expect(root.id).toBe(byTitle.get('講座の本体'));
    expect(view.snapshot()?.document?.source).toBe(source);
  });

  it.each(['mindmap', 'timeline'] as const)('places positioned topics at origin + stored offset and the unpositioned one below the body in %s', async mode => {
    const source = fixtureSource();
    const { view, layout, transform } = await mount(source, mode);
    const doc = documentOf(view);
    const positions = readTopicPositions(source);
    const { root, topics } = projectMap(doc);
    const result = layout();
    const [reference, glossary, unplaced] = topics;
    if (!reference || !glossary || !unplaced) throw new Error('Missing topics');
    expect(transform(root.id)).toEqual({ x: result.origin.x, y: result.origin.y });
    const stored = positions.get('参考資料')?.[mode];
    expect(stored).toBeDefined();
    if (stored) expect(transform(reference.id)).toEqual({ x: result.origin.x + stored.x, y: result.origin.y + stored.y });
    const bodyIds = new Set(doc.nodes.filter(node => node.from >= root.from && node.from < root.to).map(node => node.id));
    const bodyNodes = result.nodes.filter(node => bodyIds.has(node.id));
    const bodyBottom = Math.max(...bodyNodes.map(node => node.y + node.height));
    const quoted = positions.get('補足: 用語')?.[mode];
    if (quoted) expect(transform(glossary.id)).toEqual({ x: result.origin.x + quoted.x, y: result.origin.y + quoted.y });
    else expect(transform(glossary.id).y).toBeGreaterThan(bodyBottom);
    expect(transform(unplaced.id).y).toBeGreaterThan(bodyBottom);
    expect(transform(unplaced.id).x).toBe(Math.min(...bodyNodes.map(node => node.x)));
    // Fit bounds cover every topic, so 全体表示 shows the whole map.
    for (const node of result.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(result.bounds.x);
      expect(node.y + node.height).toBeLessThanOrEqual(result.bounds.y + result.bounds.height);
    }
  });

  it('keeps the virtual root only for documents that do not start with a heading section', async () => {
    const withTopics = '---\nmappy: true\n---\n## One\n- A\n\n## Two\n- B\n';
    const mounted = await mount(withTopics);
    const doc = documentOf(mounted.view);
    expect(mounted.nodes().has('root')).toBe(false);
    expect(mounted.nodes().get(doc.nodes[0]?.id ?? '')?.classList.contains('is-root')).toBe(true);
    expect(mounted.nodes().get(doc.nodes.find(node => node.title === 'Two')?.id ?? '')?.classList.contains('is-topic')).toBe(true);
    document.body.replaceChildren();
    const lists = await mount('- Only\n- Lists\n');
    expect(lists.nodes().get('root')?.classList.contains('is-root')).toBe(true);
    expect(lists.nodes().size).toBe(3);
    document.body.replaceChildren();
    const leadingSource = '- Before\n\n## One\n- A\n';
    const leading = await mount(leadingSource);
    const one = documentOf(leading.view).nodes.find(node => node.title === 'One')?.id;
    expect(leading.nodes().get('root')?.classList.contains('is-root')).toBe(true);
    expect(leading.nodes().get(one ?? '')?.classList.contains('is-topic')).toBe(true);
    expect(leading.layout().edges.some(edge => edge.from === 'root' && edge.to === one)).toBe(false);
    expect(leading.layout().nodes.map(node => node.id).sort()).toEqual(['root', ...documentOf(leading.view).nodes.map(node => node.id)].sort());
  });

  it('previews a drop inside a topic within that topic\'s tree and a drop inside the body within the body', async () => {
    const source = fixtureSource();
    const { view, layout, transform } = await mount(source);
    const doc = documentOf(view);
    const { root, topics } = projectMap(doc);
    const dragged = doc.nodes.find(node => node.title === '習慣化する');
    const glossary = topics[1];
    if (!dragged || !glossary) throw new Error('Missing fixture nodes');
    const preview = async (parentId: string): Promise<LayoutResult> => {
      (view as unknown as { previewDrop(command: MoveCommand | null): void }).previewDrop({ type: 'move', nodeId: dragged.id, parentId, index: 0 });
      await new Promise(resolve => requestAnimationFrame(resolve));
      return layout();
    };
    const intoTopic = await preview(glossary.id);
    const slot = intoTopic.nodes.find(node => node.id === PLACEHOLDER_ID);
    expect(slot).toBeDefined();
    expect(intoTopic.edges.some(edge => edge.from === glossary.id && edge.to === PLACEHOLDER_ID)).toBe(true);
    expect(transform(glossary.id)).toEqual({ x: intoTopic.origin.x + 560, y: intoTopic.origin.y - 140 });
    expect(slot && slot.x).toBeGreaterThan(transform(glossary.id).x);
    const intoBody = await preview(root.id);
    expect(intoBody.edges.some(edge => edge.from === root.id && edge.to === PLACEHOLDER_ID)).toBe(true);
    expect(intoBody.edges.some(edge => edge.from === glossary.id && edge.to === PLACEHOLDER_ID)).toBe(false);
    (view as unknown as { previewDrop(command: MoveCommand | null): void }).previewDrop(null);
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(layout().nodes.some(node => node.id === PLACEHOLDER_ID)).toBe(false);
  });

  it('renames a topic through the view and keeps its stored position under the new heading', async () => {
    const source = fixtureSource();
    const { app, view } = await mount(source);
    const doc = documentOf(view);
    const topic = doc.nodes.find(node => node.title === '参考資料');
    if (!topic) throw new Error('Missing topic');
    const plan = planEdit(doc, { type: 'rename', nodeId: topic.id, title: '資料: 参考' });
    await (view as unknown as { commit(source: string, edits: typeof plan.edits): Promise<void> }).commit(doc.source, plan.edits);
    const file = app.asApp<App>().vault.getAbstractFileByPath(PATH);
    const updated = app.content(file as never);
    expect(updated).toContain('\n  "資料: 参考": { mindmap: [-360, 200], timeline: [0, 260] }\n');
    expect(updated).not.toContain('参考資料');
    expect(updated.slice(updated.indexOf('## 講座の本体'), updated.indexOf('## 資料: 参考')))
      .toBe(source.slice(source.indexOf('## 講座の本体'), source.indexOf('## 参考資料')));
    expect(readTopicPositions(updated).get('資料: 参考')).toEqual({ mindmap: { x: -360, y: 200 }, timeline: { x: 0, y: 260 } });
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(view.snapshot()?.document?.source).toBe(updated);
  });
});

describe('MindmapView adds, moves and deletes free topics (§5 M7)', () => {
  it('double-clicking empty canvas appends `## `, edits it in place where pressed, and Enter stores title and position as one step', async () => {
    const source = fixtureSource();
    const mounted = await mount(source);
    const { view, canvas, store, file, layout, transform, nodes, source: current, settle, dblclick, key, editor, undo, redo } = mounted;
    const before = documentOf(view);
    const origin = layout().origin;
    const viewport = view.getState().viewport as { x: number; y: number; scale: number };
    // Press 300 px right of and 500 px below the canvas corner, in screen pixels.
    dblclick(canvas, CANVAS.left + 300, CANVAS.top + 500);
    await settle();
    expect(current()).toBe(`${source}\n## \n`);
    const added = projectMap(documentOf(view)).topics.at(-1);
    if (!added) throw new Error('No topic was added');
    expect(added.title).toBe('');
    expect(documentOf(view).nodes).toHaveLength(before.nodes.length + 1);
    expect(nodes().get(added.id)?.classList.contains('is-topic')).toBe(true);
    const input = editor();
    expect(input).not.toBeNull();
    expect(nodes().get(added.id)?.contains(input)).toBe(true);
    const expected = {
      x: Math.round((300 - viewport.x) / viewport.scale - origin.x), y: Math.round((500 - viewport.y) / viewport.scale - origin.y),
    };
    expect(transform(added.id)).toEqual({ x: origin.x + expected.x, y: origin.y + expected.y });
    expect(store.canUndo(file)).toBe(true);
    if (!input) return;
    input.value = '新しい話題';
    key(input, 'Enter');
    await settle();
    const saved = current();
    expect(saved.endsWith('\n## 新しい話題\n')).toBe(true);
    expect(saved).toContain(`\n  新しい話題: { mindmap: [${expected.x}, ${expected.y}] }\n---\n`);
    expect(readTopicPositions(saved).get('新しい話題')).toEqual({ mindmap: expected });
    // The body and the other topics keep their bytes; only the frontmatter key and the new section changed.
    const bodyOf = (text: string): string => text.slice(text.indexOf('## 講座の本体'), text.indexOf('## 位置のないトピック') + '## 位置のないトピック'.length);
    expect(bodyOf(saved)).toBe(bodyOf(source));
    expect(editor()).toBeNull();
    const named = documentOf(view).nodes.find(node => node.title === '新しい話題');
    if (!named) throw new Error('The named topic is missing');
    expect(nodes().get(named.id)?.classList.contains('is-selected')).toBe(true);
    expect(transform(named.id)).toEqual({ x: origin.x + expected.x, y: origin.y + expected.y });
    // One history step names and places the topic; the previous one added the empty section.
    await undo();
    expect(current()).toBe(`${source}\n## \n`);
    expect(projectMap(documentOf(view)).topics.at(-1)?.title).toBe('');
    await undo();
    expect(current()).toBe(source);
    expect(store.canUndo(file)).toBe(false);
    expect(nodes().size).toBe(before.nodes.length);
    await redo();
    await redo();
    expect(current()).toBe(saved);
    expect(view.snapshot()?.document?.source).toBe(saved);
  });

  it('stores the pressed point under the current layout: a topic added on the timeline gets a timeline entry only', async () => {
    const source = fixtureSource();
    const { view, canvas, source: current, settle, dblclick, key, editor } = await mount(source, 'timeline');
    const viewport = view.getState().viewport as { x: number; y: number; scale: number };
    const origin = (view as unknown as { layout: LayoutResult }).layout.origin;
    dblclick(canvas, CANVAS.left + 900, CANVAS.top + 100);
    await settle();
    const input = editor();
    if (!input) throw new Error('No inline editor');
    input.value = '時間軸の話題';
    key(input, 'Enter');
    await settle();
    const expected = { x: Math.round((900 - viewport.x) / viewport.scale - origin.x), y: Math.round((100 - viewport.y) / viewport.scale - origin.y) };
    expect(readTopicPositions(current()).get('時間軸の話題')).toEqual({ timeline: expected });
    expect(current()).toContain(`\n  時間軸の話題: { timeline: [${expected.x}, ${expected.y}] }\n---\n`);
  });

  it('handles heading documents the same way: the drag creates the frontmatter, delete removes it again', async () => {
    const source = '# Body\n\n## Child\n\n# Topic\n\n### Deep\n';
    const { view, canvas, nodes, layout, transform, source: current, settle, pointer, key, topic, undo } = await mount(source);
    const free = topic('Topic');
    expect(nodes().get(free.id)?.classList.contains('is-topic')).toBe(true);
    const origin = layout().origin;
    const before = transform(free.id);
    const element = nodes().get(free.id);
    if (!element) throw new Error('No element');
    pointer('pointerdown', element, 300, 300);
    pointer('pointermove', canvas, 306, 300);
    pointer('pointermove', canvas, 380, 340);
    pointer('pointerup', canvas, 380, 340);
    await settle();
    const moved = current();
    const stored = { x: Math.round(before.x - origin.x + 80), y: Math.round(before.y - origin.y + 40) };
    expect(moved).toBe(`---\n${TOPICS_KEY}:\n  Topic: { mindmap: [${stored.x}, ${stored.y}] }\n---\n${source}`);
    expect(documentOf(view).format).toBe('headings');
    nodes().get(topic('Topic').id)?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    key(canvas, 'Delete');
    await settle();
    // The header existed only for the topic, so its removal leaves the note exactly as it was.
    expect(current()).toBe('# Body\n\n## Child\n');
    await undo();
    expect(current()).toBe(moved);
    await undo();
    expect(current()).toBe(source);
  });

  it('Escape keeps the empty section where it was pressed; a later drag stores that position under the empty heading', async () => {
    const source = fixtureSource();
    const { view, canvas, layout, transform, source: current, settle, dblclick, key, pointer, editor, nodes, undo } = await mount(source);
    const origin = layout().origin;
    const viewport = view.getState().viewport as { x: number; y: number; scale: number };
    // World coordinates of the pressed point: the topic root's top-left lands exactly there.
    const pressed = { x: (700 - viewport.x) / viewport.scale, y: (600 - viewport.y) / viewport.scale };
    dblclick(canvas, CANVAS.left + 700, CANVAS.top + 600);
    await settle();
    const input = editor();
    if (!input) throw new Error('No inline editor');
    key(input, 'Escape');
    await settle();
    expect(current()).toBe(`${source}\n## \n`);
    expect(editor()).toBeNull();
    const blank = projectMap(documentOf(view)).topics.at(-1);
    if (!blank) throw new Error('No blank topic');
    expect(transform(blank.id)).toEqual(pressed);
    const element = nodes().get(blank.id);
    if (!element) throw new Error('No element');
    pointer('pointerdown', element, 400, 400);
    pointer('pointermove', canvas, 410, 400);
    pointer('pointermove', canvas, 450, 430);
    pointer('pointerup', canvas, 450, 430);
    await settle();
    expect(readTopicPositions(current()).get('')).toEqual({ mindmap: { x: Math.round(pressed.x - origin.x + 50), y: Math.round(pressed.y - origin.y + 30) } });
    expect(current().endsWith('\n## \n')).toBe(true);
    expect(transform(blank.id)).toEqual({ x: pressed.x + 50, y: pressed.y + 30 });
    await undo();
    await undo();
    expect(current()).toBe(source);
  });

  it('the context menu on empty canvas offers トピックを追加 and on a topic トピックを削除', async () => {
    const source = fixtureSource();
    const { view, canvas, nodes, source: current, settle, contextmenu, editor, transform } = await mount(source);
    const viewport = view.getState().viewport as { x: number; y: number; scale: number };
    const items = contextmenu(canvas, CANVAS.left + 200, CANVAS.top + 300);
    expect(items).toEqual(['トピックを追加', '元に戻す', 'やり直す']);
    menuItem('トピックを追加').click();
    await settle();
    expect(current()).toBe(`${source}\n## \n`);
    expect(editor()).not.toBeNull();
    const added = projectMap(documentOf(view)).topics.at(-1);
    if (!added) throw new Error('No topic');
    expect(transform(added.id)).toEqual({ x: (200 - viewport.x) / viewport.scale, y: (300 - viewport.y) / viewport.scale });
    editor()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await settle();
    const reference = documentOf(view).nodes.find(node => node.title === '参考資料');
    const child = documentOf(view).nodes.find(node => node.title === '回復する');
    if (!reference || !child) throw new Error('Missing nodes');
    expect(contextmenu(nodes().get(reference.id) ?? canvas, 300, 300)).toContain('トピックを削除');
    document.querySelector('.menu')?.remove();
    expect(contextmenu(nodes().get(child.id) ?? canvas, 300, 300)).toContain('枝を削除');
    document.querySelector('.menu')?.remove();
  });

  it.each(['mindmap', 'timeline'] as const)('dragging a topic in %s moves its whole tree live and stores only that layout\'s entry', async mode => {
    const source = fixtureSource();
    const { view, canvas, nodes, layout, transform, source: current, settle, pointer, topic, undo, redo } = await mount(source, mode);
    const reference = topic('参考資料');
    const child = reference.children[0];
    if (!child) throw new Error('Topic has no child');
    const rootBefore = transform(reference.id);
    const childBefore = transform(child.id);
    const edgeBefore = layout().edges.find(edge => edge.from === reference.id && edge.to === child.id)?.path;
    const element = nodes().get(reference.id);
    if (!element) throw new Error('No element');
    pointer('pointerdown', element, 500, 400);
    pointer('pointermove', canvas, 506, 400);
    pointer('pointermove', canvas, 600, 450);
    await new Promise(resolve => requestAnimationFrame(resolve));
    // Live: root, child and their connector moved by the pointer travel; nothing is saved yet.
    expect(transform(reference.id)).toEqual({ x: rootBefore.x + 100, y: rootBefore.y + 50 });
    expect(transform(child.id)).toEqual({ x: childBefore.x + 100, y: childBefore.y + 50 });
    expect(layout().edges.find(edge => edge.from === reference.id && edge.to === child.id)?.path).not.toBe(edgeBefore);
    expect(canvas.querySelector('.mappy-drag-ghost')).toBeNull();
    expect(layout().nodes.some(node => node.id === PLACEHOLDER_ID)).toBe(false);
    expect(current()).toBe(source);
    pointer('pointerup', canvas, 600, 450);
    await settle();
    const saved = current();
    const stored = readTopicPositions(source).get('参考資料');
    const other = mode === 'mindmap' ? 'timeline' : 'mindmap';
    expect(readTopicPositions(saved).get('参考資料')).toEqual({
      ...stored, [mode]: { x: (stored?.[mode]?.x ?? 0) + 100, y: (stored?.[mode]?.y ?? 0) + 50 },
    });
    expect(readTopicPositions(saved).get('参考資料')?.[other]).toEqual(stored?.[other]);
    expect(saved.slice(saved.indexOf('---\n', 4))).toBe(source.slice(source.indexOf('---\n', 4)));
    expect(saved).toContain('  "補足: 用語": { mindmap: [560, -140] }\n  消えた見出し: { mindmap: [0, 0] }\n');
    expect(transform(reference.id)).toEqual({ x: rootBefore.x + 100, y: rootBefore.y + 50 });
    await undo();
    expect(current()).toBe(source);
    expect(transform(reference.id)).toEqual(rootBefore);
    await redo();
    expect(current()).toBe(saved);
    expect(transform(reference.id)).toEqual({ x: rootBefore.x + 100, y: rootBefore.y + 50 });
    expect(view.snapshot()?.document?.source).toBe(saved);
  });

  it('Escape during a drag puts the tree back without saving; a release outside the canvas does the same', async () => {
    const source = fixtureSource();
    const { canvas, nodes, transform, source: current, settle, pointer, topic, key } = await mount(source);
    const reference = topic('参考資料');
    const before = transform(reference.id);
    const element = nodes().get(reference.id);
    if (!element) throw new Error('No element');
    pointer('pointerdown', element, 500, 400);
    pointer('pointermove', canvas, 560, 400);
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(transform(reference.id)).toEqual({ x: before.x + 60, y: before.y });
    key(canvas, 'Escape');
    await settle();
    expect(transform(reference.id)).toEqual(before);
    expect(current()).toBe(source);
    pointer('pointerdown', element, 500, 400);
    pointer('pointermove', canvas, 560, 400);
    pointer('pointermove', canvas, CANVAS.right + 50, 400);
    pointer('pointerup', canvas, CANVAS.right + 50, 400);
    await settle();
    expect(transform(reference.id)).toEqual(before);
    expect(current()).toBe(source);
  });

  it('a first move creates the entry of an unpositioned topic, and a Markdown-side rename falls back to the default slot until the next move', async () => {
    const source = fixtureSource().replace('## 参考資料', '## 参考資料 v2');
    const { canvas, nodes, layout, transform, source: current, settle, pointer, topic } = await mount(source);
    // The old key is an orphan now: the renamed heading sits in the default column under the body.
    const renamed = topic('参考資料 v2');
    const unplaced = topic('位置のないトピック');
    const origin = layout().origin;
    expect(transform(renamed.id).x).toBe(origin.x);
    expect(transform(renamed.id).y).toBeGreaterThan(origin.y);
    for (const node of [renamed, unplaced]) {
      const element = nodes().get(node.id);
      if (!element) throw new Error('No element');
      const before = transform(node.id);
      pointer('pointerdown', element, 300, 300);
      pointer('pointermove', canvas, 306, 300);
      pointer('pointermove', canvas, 340, 280);
      pointer('pointerup', canvas, 340, 280);
      await settle();
      expect(readTopicPositions(current()).get(node.title)).toEqual({ mindmap: { x: Math.round(before.x - origin.x + 40), y: Math.round(before.y - origin.y - 20) } });
    }
    const positions = readTopicPositions(current());
    expect(positions.get('参考資料')).toEqual({ mindmap: { x: -360, y: 200 }, timeline: { x: 0, y: 260 } });
    expect([...positions.keys()]).toEqual(['参考資料', '補足: 用語', '消えた見出し', '参考資料 v2', '位置のないトピック']);
    expect(current().slice(current().indexOf('---\n', 4))).toBe(source.slice(source.indexOf('---\n', 4)));
  });

  it('Delete removes the topic section and its entry together; Undo brings both back and Redo removes them again', async () => {
    const source = fixtureSource();
    const { view, canvas, nodes, source: current, settle, key, topic, undo, redo } = await mount(source);
    const reference = topic('参考資料');
    nodes().get(reference.id)?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    key(canvas, 'Delete');
    await settle();
    const deleted = current();
    expect(deleted).not.toContain('参考資料');
    expect(deleted).toContain(`${TOPICS_KEY}:\n  "補足: 用語": { mindmap: [560, -140] }\n  消えた見出し: { mindmap: [0, 0] }\n---\n`);
    expect(deleted.slice(deleted.indexOf('## 講座の本体'), deleted.indexOf('## 補足: 用語'))).toBe(source.slice(source.indexOf('## 講座の本体'), source.indexOf('## 参考資料')));
    expect(deleted.slice(deleted.indexOf('## 補足: 用語'))).toBe(source.slice(source.indexOf('## 補足: 用語')));
    expect(projectMap(documentOf(view)).topics.map(node => node.title)).toEqual(['補足: 用語', '位置のないトピック']);
    expect(nodes().size).toBe(documentOf(view).nodes.length);
    await undo();
    expect(current()).toBe(source);
    expect(projectMap(documentOf(view)).topics.map(node => node.title)).toEqual(['参考資料', '補足: 用語', '位置のないトピック']);
    expect(nodes().size).toBe(documentOf(view).nodes.length);
    await redo();
    expect(current()).toBe(deleted);
    expect(projectMap(documentOf(view)).topics.map(node => node.title)).toEqual(['補足: 用語', '位置のないトピック']);
  });

  it('deleting the last topic removes the whole key and the separating blank line, so the note reads as one without topics', async () => {
    const source = '---\nmappy: true\nmappy-topics:\n  Extra: { mindmap: [100, 100] }\n---\n## Body\n- Child\n\n## Extra\n- Under\n';
    const { canvas, nodes, source: current, settle, key, topic, undo } = await mount(source);
    const extra = topic('Extra');
    nodes().get(extra.id)?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    key(canvas, 'Backspace');
    await settle();
    expect(current()).toBe('---\nmappy: true\n---\n## Body\n- Child\n');
    await undo();
    expect(current()).toBe(source);
  });
});

describe('MindmapView keeps topics with the same heading apart (LEV-86)', () => {
  /** The fixture with two topics `同じ見出し` (a called map twice, a repeated heading) before the unpositioned one. */
  const duplicated = (): string => fixtureSource().replace('## 位置のないトピック', '## 同じ見出し\n- a\n\n## 同じ見出し\n- b\n\n## 位置のないトピック');
  const sameTitled = (view: MindmapView): [string, string] => {
    const [first, second] = projectMap(documentOf(view)).topics.filter(node => node.title === '同じ見出し').map(node => node.id);
    if (!first || !second) throw new Error('Missing the two same-titled topics');
    return [first, second];
  };

  it('dragging the second of two same-titled topics moves only that one, stores it under `同じ見出し (2)`, and keeps both ids and the selection', async () => {
    const source = duplicated();
    const { view, canvas, nodes, layout, transform, source: current, settle, pointer } = await mount(source);
    const [first, second] = sameTitled(view);
    const origin = layout().origin;
    const firstBefore = transform(first);
    const secondBefore = transform(second);
    // Both sit in the default column under the body: the second below the first.
    expect(secondBefore.y).toBeGreaterThan(firstBefore.y);
    const element = nodes().get(second);
    if (!element) throw new Error('No element');
    pointer('pointerdown', element, 300, 300);
    pointer('pointermove', canvas, 306, 300);
    pointer('pointermove', canvas, 340, 280);
    pointer('pointerup', canvas, 340, 280);
    await settle();
    const stored = { x: Math.round(secondBefore.x - origin.x + 40), y: Math.round(secondBefore.y - origin.y - 20) };
    // Only the dragged one moved, to where it was dropped; the first stays where it was (looked up by order again: the ids are checked below).
    const [firstNow, secondNow] = sameTitled(view);
    expect(transform(firstNow)).toEqual(firstBefore);
    expect(transform(secondNow)).toEqual({ x: secondBefore.x + 40, y: secondBefore.y - 20 });
    // The second topic has a key of its own; the first has none yet (it was never moved).
    const positions = readTopicPositions(current());
    expect(positions.get('同じ見出し (2)')).toEqual({ mindmap: stored });
    expect(positions.has('同じ見出し')).toBe(false);
    expect(current()).toContain(`\n  同じ見出し (2): { mindmap: [${stored.x}, ${stored.y}] }\n---\n`);
    expect(current().slice(current().indexOf('---\n', 4))).toBe(source.slice(source.indexOf('---\n', 4)));
    // The save re-parses the note: both topics keep their ids, and the dragged one stays selected.
    expect(sameTitled(view)).toEqual([first, second]);
    expect(nodes().get(second)?.classList.contains('is-selected')).toBe(true);
  });

  /** The duplicated fixture with both topics positioned: the first at (100, 600), the second at (400, 600). */
  const placed = (): string => duplicated().replace('  消えた見出し: { mindmap: [0, 0] }\n', '  消えた見出し: { mindmap: [0, 0] }\n  同じ見出し: { mindmap: [100, 600] }\n  同じ見出し (2): { mindmap: [400, 600] }\n');

  it('lays each of two positioned same-titled topics out from its own entry, and a `同じ見出し (2)` heading of its own bumps the second to `(3)`', async () => {
    const source = placed();
    const { view, layout, transform } = await mount(source);
    const [first, second] = sameTitled(view);
    const origin = layout().origin;
    expect(transform(first)).toEqual({ x: origin.x + 100, y: origin.y + 600 });
    expect(transform(second)).toEqual({ x: origin.x + 400, y: origin.y + 600 });
    document.body.replaceChildren();
    // A third topic whose heading is the text `同じ見出し (2)` owns that key; the second `同じ見出し` reads `同じ見出し (3)` instead.
    const withThird = source.replace('## 位置のないトピック', '## 同じ見出し (2)\n- c\n\n## 位置のないトピック').replace('  同じ見出し (2): { mindmap: [400, 600] }\n', '  同じ見出し (2): { mindmap: [400, 600] }\n  同じ見出し (3): { mindmap: [700, 600] }\n');
    const other = await mount(withThird);
    const [firstAgain, secondAgain] = sameTitled(other.view);
    const third = other.topic('同じ見出し (2)');
    const originAgain = other.layout().origin;
    expect(other.transform(firstAgain)).toEqual({ x: originAgain.x + 100, y: originAgain.y + 600 });
    expect(other.transform(secondAgain)).toEqual({ x: originAgain.x + 700, y: originAgain.y + 600 });
    expect(other.transform(third.id)).toEqual({ x: originAgain.x + 400, y: originAgain.y + 600 });
  });

  it('renaming the first of the two promotes the second\'s `(2)` entry to the plain key, so neither moves; Undo restores the keys', async () => {
    const source = placed();
    const { view, nodes, transform, source: current, settle, dblclick, key, editor, undo } = await mount(source);
    const [first, second] = sameTitled(view);
    const firstBefore = transform(first);
    const secondBefore = transform(second);
    const element = nodes().get(first);
    if (!element) throw new Error('No element');
    dblclick(element, 300, 300);
    await settle();
    const input = editor();
    if (!input) throw new Error('No inline editor');
    input.value = '別の見出し';
    key(input, 'Enter');
    await settle();
    const renamed = current();
    expect(renamed).toContain('  別の見出し: { mindmap: [100, 600] }\n  同じ見出し: { mindmap: [400, 600] }\n---\n');
    expect(renamed).not.toContain('同じ見出し (2)');
    expect(renamed.slice(renamed.indexOf('## 講座の本体'))).toBe(source.slice(source.indexOf('## 講座の本体')).replace('## 同じ見出し\n- a', '## 別の見出し\n- a'));
    // Both stay where they were, and the renamed one is the selection (found by the plan's offset: a heading that was one of two keeps no id through a rename).
    const renamedTopic = projectMap(documentOf(view)).topics.find(node => node.title === '別の見出し');
    const remaining = projectMap(documentOf(view)).topics.find(node => node.title === '同じ見出し');
    if (!renamedTopic || !remaining) throw new Error('Missing topics');
    expect(nodes().get(renamedTopic.id)?.classList.contains('is-selected')).toBe(true);
    expect(transform(renamedTopic.id)).toEqual(firstBefore);
    expect(transform(remaining.id)).toEqual(secondBefore);
    await undo();
    expect(current()).toBe(source);
    expect(transform(sameTitled(view)[1])).toEqual(secondBefore);
  });

  it('deleting the first of the two keeps the second where it was under the promoted key; Undo brings both back in place', async () => {
    const source = placed();
    const { view, canvas, nodes, transform, source: current, settle, key, undo, redo } = await mount(source);
    const [first, second] = sameTitled(view);
    const firstBefore = transform(first);
    const secondBefore = transform(second);
    nodes().get(first)?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    key(canvas, 'Delete');
    await settle();
    const deleted = current();
    expect(deleted).toContain('  消えた見出し: { mindmap: [0, 0] }\n  同じ見出し: { mindmap: [400, 600] }\n---\n');
    expect(deleted).not.toContain('同じ見出し (2)');
    expect(deleted).not.toContain('## 同じ見出し\n- a');
    const remaining = projectMap(documentOf(view)).topics.filter(node => node.title === '同じ見出し');
    expect(remaining).toHaveLength(1);
    expect(transform(remaining[0]?.id ?? '')).toEqual(secondBefore);
    await undo();
    expect(current()).toBe(source);
    const [firstAgain, secondAgain] = sameTitled(view);
    expect(transform(firstAgain)).toEqual(firstBefore);
    expect(transform(secondAgain)).toEqual(secondBefore);
    await redo();
    expect(current()).toBe(deleted);
  });

  it('dragging the body root writes both keys; joining the first to a node drops its key and promotes the second; detaching a branch beside a same-titled topic writes `(2)`', async () => {
    const source = duplicated();
    const { view, canvas, nodes, layout, transform, source: current, settle, pointer, hit, undo } = await mount(source);
    const { root } = projectMap(documentOf(view));
    const [first, second] = sameTitled(view);
    const origin = layout().origin;
    const firstBefore = transform(first);
    const secondBefore = transform(second);
    const body = nodes().get(root.id);
    if (!body) throw new Error('No body element');
    pointer('pointerdown', body, 500, 400);
    pointer('pointermove', canvas, 506, 400);
    pointer('pointermove', canvas, 600, 450);
    pointer('pointerup', canvas, 600, 450);
    await settle();
    const positions = readTopicPositions(current());
    expect(positions.get('同じ見出し')).toEqual({ mindmap: { x: Math.round(firstBefore.x - origin.x - 100), y: Math.round(firstBefore.y - origin.y - 50) } });
    expect(positions.get('同じ見出し (2)')).toEqual({ mindmap: { x: Math.round(secondBefore.x - origin.x - 100), y: Math.round(secondBefore.y - origin.y - 50) } });
    expect(sameTitled(view)).toEqual([first, second]);
    // Join: the first `同じ見出し` released beside 回復する becomes its child; its entry goes, the second's `(2)` entry becomes `同じ見出し`.
    const recover = documentOf(view).nodes.find(node => node.title === '回復する');
    const target = nodes().get(recover?.id ?? '');
    const element = nodes().get(first);
    if (!target || !element) throw new Error('No elements');
    pointer('pointerdown', element, 500, 400);
    pointer('pointermove', canvas, 506, 400);
    hit(target);
    pointer('pointermove', canvas, 520, 410);
    await new Promise(resolve => requestAnimationFrame(resolve));
    pointer('pointerup', canvas, 520, 410);
    await settle();
    const joined = current();
    const afterJoin = readTopicPositions(joined);
    expect(afterJoin.get('同じ見出し')).toEqual(positions.get('同じ見出し (2)'));
    expect(afterJoin.has('同じ見出し (2)')).toBe(false);
    expect(joined).toContain('  - 睡眠\n  - 同じ見出し\n    - a\n- 記録する\n');
    const remaining = projectMap(documentOf(view)).topics.filter(node => node.title === '同じ見出し');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.children.map(node => node.title)).toEqual(['b']);
    await undo();
    expect(readTopicPositions(current())).toEqual(positions);
    // Detach: a branch whose text repeats a topic's heading (the item `a` renamed to 位置のないトピック on the Markdown side)
    // released on empty canvas becomes the second topic of that heading, stored as `位置のないトピック (2)`.
    const withBranch = documentOf(view);
    const item = withBranch.nodes.find(node => node.title === 'a' && node.kind === 'list');
    if (!item) throw new Error('Missing item');
    await (view as unknown as { commit(text: string, edits: { from: number; to: number; text: string }[]): Promise<void> })
      .commit(withBranch.source, [{ from: item.titleFrom, to: item.titleTo, text: '位置のないトピック' }]);
    await settle();
    const doc = documentOf(view);
    const renamedItem = doc.nodes.find(node => node.title === '位置のないトピック' && node.kind === 'list');
    const itemElement = nodes().get(renamedItem?.id ?? '');
    if (!itemElement) throw new Error('No item element');
    hit(null);
    pointer('pointerdown', itemElement, 500, 400);
    pointer('pointermove', canvas, 506, 400);
    pointer('pointermove', canvas, 900, 700);
    pointer('pointerup', canvas, 900, 700);
    await settle();
    const detached = current();
    expect(detached.endsWith('\n## 位置のないトピック\n')).toBe(true);
    expect(readTopicPositions(detached).get('位置のないトピック (2)')?.mindmap).toBeDefined();
    // The topic that had the heading keeps the entry the body drag wrote for it.
    expect(readTopicPositions(detached).get('位置のないトピック')).toEqual(positions.get('位置のないトピック'));
    expect(projectMap(documentOf(view)).topics.filter(node => node.title === '位置のないトピック')).toHaveLength(2);
  });
});

describe('MindmapView moves the body against its topics and joins a topic to a node', () => {
  it.each(['mindmap', 'timeline'] as const)('dragging the body root in %s shifts the viewport and stores every topic\'s new offset; undo restores them', async mode => {
    const source = fixtureSource();
    const { view, canvas, nodes, layout, transform, source: current, settle, pointer, viewport, undo } = await mount(source, mode);
    const { root, topics } = projectMap(documentOf(view));
    const origin = layout().origin;
    const before = new Map(topics.map(topic => [topic.title, transform(topic.id)]));
    const bodyBefore = transform(root.id);
    const viewBefore = viewport();
    const element = nodes().get(root.id);
    if (!element) throw new Error('No body element');
    pointer('pointerdown', element, 500, 400);
    pointer('pointermove', canvas, 506, 400);
    pointer('pointermove', canvas, 600, 450);
    await new Promise(resolve => requestAnimationFrame(resolve));
    // Live: the body stays at the origin, the viewport follows the pointer and the topics move the other way.
    expect(transform(root.id)).toEqual(bodyBefore);
    expect(viewport()).toEqual({ ...viewBefore, x: viewBefore.x + 100, y: viewBefore.y + 50 });
    for (const topic of topics) expect(transform(topic.id)).toEqual({ x: (before.get(topic.title)?.x ?? 0) - 100, y: (before.get(topic.title)?.y ?? 0) - 50 });
    expect(canvas.querySelector('.mappy-drag-ghost')).toBeNull();
    expect(current()).toBe(source);
    pointer('pointerup', canvas, 600, 450);
    await settle();
    const saved = current();
    const positions = readTopicPositions(saved);
    for (const topic of topics) {
      const shown = before.get(topic.title);
      if (!shown) throw new Error('Missing position');
      expect(positions.get(topic.title)?.[mode]).toEqual({ x: Math.round(shown.x - origin.x - 100), y: Math.round(shown.y - origin.y - 50) });
    }
    const other = mode === 'mindmap' ? 'timeline' : 'mindmap';
    expect(positions.get('参考資料')?.[other]).toEqual(readTopicPositions(source).get('参考資料')?.[other]);
    expect(positions.get('消えた見出し')).toEqual({ mindmap: { x: 0, y: 0 } });
    expect(saved.slice(saved.indexOf('---\n', 4))).toBe(source.slice(source.indexOf('---\n', 4)));
    expect(viewport()).toEqual({ ...viewBefore, x: viewBefore.x + 100, y: viewBefore.y + 50 });
    for (const topic of topics) expect(transform(topic.id)).toEqual({ x: (before.get(topic.title)?.x ?? 0) - 100, y: (before.get(topic.title)?.y ?? 0) - 50 });
    await undo();
    expect(current()).toBe(source);
    for (const topic of topics) expect(transform(topic.id)).toEqual(before.get(topic.title));
  });

  it('Escape during a body drag restores the viewport and the topics without saving', async () => {
    const source = fixtureSource();
    const { view, canvas, nodes, transform, source: current, settle, pointer, viewport, key } = await mount(source);
    const { root, topics } = projectMap(documentOf(view));
    const before = new Map(topics.map(topic => [topic.id, transform(topic.id)]));
    const viewBefore = viewport();
    const element = nodes().get(root.id);
    if (!element) throw new Error('No body element');
    pointer('pointerdown', element, 500, 400);
    pointer('pointermove', canvas, 560, 430);
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(viewport()).not.toEqual(viewBefore);
    key(canvas, 'Escape');
    await settle();
    expect(viewport()).toEqual(viewBefore);
    for (const topic of topics) expect(transform(topic.id)).toEqual(before.get(topic.id));
    expect(current()).toBe(source);
  });

  it('a topic held over a node previews the slot and shows as a plain node; releasing joins it as a branch, undo brings the topic back', async () => {
    const source = fixtureSource();
    const { view, canvas, nodes, layout, source: current, settle, pointer, topic, hit, undo } = await mount(source);
    const reference = topic('参考資料');
    const recover = documentOf(view).nodes.find(node => node.title === '回復する');
    if (!recover) throw new Error('Missing node');
    const element = nodes().get(reference.id);
    const target = nodes().get(recover.id);
    if (!element || !target) throw new Error('No elements');
    pointer('pointerdown', element, 500, 400);
    pointer('pointermove', canvas, 506, 400);
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(element.classList.contains('is-drag-moving')).toBe(true);
    expect(nodes().get(reference.children[0]?.id ?? '')?.classList.contains('is-drag-moving')).toBe(true);
    expect(element.classList.contains('is-merging')).toBe(false);
    hit(target);
    pointer('pointermove', canvas, 520, 410);
    await new Promise(resolve => requestAnimationFrame(resolve));
    // The body makes room: a placeholder under 回復する with a connector, and the topic root drops its dark face.
    expect(layout().nodes.some(node => node.id === PLACEHOLDER_ID)).toBe(true);
    expect(layout().edges.some(edge => edge.from === recover.id && edge.to === PLACEHOLDER_ID)).toBe(true);
    expect(element.classList.contains('is-merging')).toBe(true);
    expect(current()).toBe(source);
    pointer('pointerup', canvas, 520, 410);
    await settle();
    const joined = current();
    expect(joined).not.toContain('## 参考資料');
    expect(readTopicPositions(joined).has('参考資料')).toBe(false);
    expect(joined).toContain('  - 睡眠\n  - 参考資料\n    位置は frontmatter の `mappy-topics` にあり、本文には何も書かない。\n\n    - [[heading-document|講座ノート]]\n    - ![[sample-image.svg]]\n    - [外部の資料](https://example.com)\n- 記録する\n');
    expect(joined).toContain('  "補足: 用語": { mindmap: [560, -140] }\n  消えた見出し: { mindmap: [0, 0] }\n---\n');
    const doc = documentOf(view);
    expect(projectMap(doc).topics.map(node => node.title)).toEqual(['補足: 用語', '位置のないトピック']);
    const item = doc.nodes.find(node => node.title === '参考資料');
    expect(item?.kind).toBe('list');
    expect(item?.parentId).toBe(doc.nodes.find(node => node.title === '回復する')?.id);
    expect(nodes().get(item?.id ?? '')?.classList.contains('is-topic')).toBe(false);
    expect(nodes().get(item?.id ?? '')?.classList.contains('is-root')).toBe(false);
    // The joined node keeps its element (same id): the moving and merging marks must not survive the drop.
    expect(nodes().get(item?.id ?? '')?.classList.contains('is-drag-moving')).toBe(false);
    expect(nodes().get(item?.id ?? '')?.classList.contains('is-merging')).toBe(false);
    expect(Array.from(nodes().values()).some(node => node.classList.contains('is-drag-moving'))).toBe(false);
    expect(layout().nodes.some(node => node.id === PLACEHOLDER_ID)).toBe(false);
    expect(nodes().size).toBe(doc.nodes.length);
    await undo();
    expect(current()).toBe(source);
    expect(projectMap(documentOf(view)).topics.map(node => node.title)).toEqual(['参考資料', '補足: 用語', '位置のないトピック']);
  });
});

describe('MindmapView detaches a branch into a new topic', () => {
  it('a body branch released on empty canvas becomes a topic at the ghost position; undo puts the branch back', async () => {
    const source = fixtureSource();
    const { view, canvas, nodes, layout, transform, source: current, settle, pointer, undo } = await mount(source);
    const recover = documentOf(view).nodes.find(node => node.title === '回復する');
    if (!recover) throw new Error('Missing node');
    const element = nodes().get(recover.id);
    if (!element) throw new Error('No element');
    const originBefore = layout().origin;
    const viewport = view.getState().viewport as { x: number; y: number; scale: number };
    // Pressed at (500, 400); jsdom rects are zero, so the grab offset is the press point itself and the ghost's top-left is the release point.
    pointer('pointerdown', element, 500, 400);
    pointer('pointermove', canvas, 506, 400);
    pointer('pointermove', canvas, 900, 700);
    pointer('pointerup', canvas, 900, 700);
    await settle();
    const detached = current();
    // The body lost a branch, so its root re-centred; the stored offset is measured from the new origin and the topic sits exactly at the drop point.
    const origin = layout().origin;
    expect(origin).not.toEqual(originBefore);
    const world = { x: (900 - CANVAS.left - 500 - viewport.x) / viewport.scale, y: (700 - CANVAS.top - 400 - viewport.y) / viewport.scale };
    const expected = { x: Math.round(world.x - origin.x), y: Math.round(world.y - origin.y) };
    expect(detached.endsWith('\n## 回復する\n\n参考: [[heading-document#回復する|回復]]\n- 休息の取り方\n- 睡眠\n')).toBe(true);
    expect(detached).not.toContain('- 回復する\n');
    expect(readTopicPositions(detached).get('回復する')).toEqual({ mindmap: expected });
    const doc = documentOf(view);
    expect(projectMap(doc).topics.map(node => node.title)).toEqual(['参考資料', '補足: 用語', '位置のないトピック', '回復する']);
    expect(projectMap(doc).root.children.map(node => node.title)).toEqual(['記録する', '習慣化する']);
    const topic = doc.nodes.find(node => node.title === '回復する');
    if (!topic) throw new Error('Missing topic');
    expect(nodes().get(topic.id)?.classList.contains('is-topic')).toBe(true);
    expect(nodes().get(topic.id)?.classList.contains('is-selected')).toBe(true);
    expect(transform(topic.id)).toEqual({ x: world.x, y: world.y });
    expect(nodes().size).toBe(doc.nodes.length);
    await undo();
    expect(current()).toBe(source);
    expect(projectMap(documentOf(view)).root.children.map(node => node.title)).toEqual(['回復する', '記録する', '習慣化する']);
  });

  it('a release close to where the node was pressed changes nothing', async () => {
    const source = fixtureSource();
    const { view, canvas, nodes, source: current, settle, pointer } = await mount(source);
    const recover = documentOf(view).nodes.find(node => node.title === '回復する');
    const element = nodes().get(recover?.id ?? '');
    if (!element) throw new Error('No element');
    // Give the node a real box (jsdom reports none), so "near its own place" means something.
    element.getBoundingClientRect = () => ({ x: 480, y: 380, left: 480, top: 380, width: 80, height: 40, right: 560, bottom: 420, toJSON: () => ({}) });
    pointer('pointerdown', element, 500, 400);
    pointer('pointermove', canvas, 508, 404);
    pointer('pointerup', canvas, 508, 404);
    await settle();
    expect(current()).toBe(source);
    // Just outside the box plus its margin, the same drag detaches.
    pointer('pointerdown', element, 500, 400);
    pointer('pointermove', canvas, 508, 404);
    pointer('pointermove', canvas, 620, 400);
    pointer('pointerup', canvas, 620, 400);
    await settle();
    expect(current()).not.toBe(source);
    expect(current().endsWith('\n## 回復する\n\n参考: [[heading-document#回復する|回復]]\n- 休息の取り方\n- 睡眠\n')).toBe(true);
  });
});

describe('MindmapView snaps a dragged topic to the slot beside its root', () => {
  type Snap = (id: string, root: { x: number; y: number; width: number; height: number }, current: MoveCommand | null) => MoveCommand | null;
  type Box = { x: number; y: number; width: number; height: number };
  const at = (view: MindmapView, world: Box) => {
    const viewport = view.getState().viewport as { x: number; y: number; scale: number };
    return { x: world.x * viewport.scale + viewport.x, y: world.y * viewport.scale + viewport.y, width: world.width * viewport.scale, height: world.height * viewport.scale };
  };
  const bind = (view: MindmapView) => ({
    shift: (view as unknown as { shiftTopic(id: string, delta: { x: number; y: number } | null): void }).shiftTopic.bind(view),
    snap: (view as unknown as { snapTarget: Snap }).snapTarget.bind(view),
    preview: (view as unknown as { previewDrop(command: MoveCommand | null): void }).previewDrop.bind(view),
  });
  const frame = (): Promise<unknown> => new Promise(resolve => requestAnimationFrame(resolve));
  /** Three childless stages: on the timeline the first and third hang their forests above the axis, the second below. */
  const THREE_STAGES = '## 本体\n\n- 回復する\n- 記録する\n- 習慣化する\n\n## 補足\n\n- 用語\n';
  /**
   * The first stage's forest reaches past the third stage in its top row only, so giving that stage a child pushes it
   * right past the forest while the child's landing spot, under the forest's short bottom row, stays clear.
   */
  const DEEP_FOREST = '## 本体\n\n- 回復する\n  - 休息\n    - 深い 1\n      - 深い 2\n  - 睡眠\n- 記録する\n- 習慣化する\n\n## 補足\n\n- 用語\n';
  /** A root of `size` centred over a timeline stage, 30 units clear of it on one side of the axis, as a hand would bring it. */
  const stageSpot = (stage: Box, side: 'above' | 'below') => ({
    x: stage.x + (stage.width - size.width) / 2, y: side === 'above' ? stage.y - 30 - size.height : stage.y + stage.height + 30, ...size,
  });
  const size = { width: 120, height: 40 };
  const placed = (view: MindmapView, node: MindNode | undefined): Box => {
    const box = (view as unknown as { layout: LayoutResult | undefined }).layout?.nodes.find(item => item.id === node?.id);
    if (!box) throw new Error(`Missing layout node ${node?.title ?? ''}`);
    return box;
  };
  /**
   * Where a root of `size` sits for each slot, from the first two children of a node: children grow
   * rightward in the map and in the timeline's forests (a column), downward in the hierarchy (a row).
   */
  const spots = (grow: 'right' | 'down', leaf: Box, second: Box) => grow === 'right' ? {
    besideLeaf: { x: leaf.x + leaf.width + 30, y: leaf.y, ...size },
    between: { x: leaf.x, y: (leaf.y + leaf.height + second.y) / 2 - size.height / 2, ...size },
    afterLast: { x: leaf.x, y: second.y + second.height / 2, ...size },
    drifted: { x: leaf.x + leaf.width + 130, y: leaf.y, ...size },
    gone: { x: leaf.x + leaf.width + 400, y: leaf.y, ...size },
  } : {
    besideLeaf: { x: leaf.x, y: leaf.y + leaf.height + 30, ...size },
    between: { x: (leaf.x + leaf.width + second.x) / 2 - size.width / 2, y: leaf.y, ...size },
    afterLast: { x: second.x + second.width / 2, y: second.y, ...size },
    drifted: { x: leaf.x, y: leaf.y + leaf.height + 130, ...size },
    gone: { x: leaf.x, y: leaf.y + leaf.height + 400, ...size },
  };

  it.each([['mindmap', 'right'], ['timeline', 'right'], ['hierarchy', 'down'], ['balanced', 'right']] as const)(
    'in %s, beside a leaf it becomes the last child; level with a node\'s children it slots in among them; far away nothing', async (mode, grow) => {
      const source = fixtureSource();
      const { view, topic } = await mount(source, mode);
      const doc = documentOf(view);
      const glossary = topic('補足: 用語');
      const rest = doc.nodes.find(node => node.title === '休息の取り方');
      const sleep = doc.nodes.find(node => node.title === '睡眠');
      const recover = doc.nodes.find(node => node.title === '回復する');
      if (!rest || !sleep || !recover) throw new Error('Missing nodes');
      const { shift, snap } = bind(view);
      shift(glossary.id, { x: 0, y: 0 });
      const spot = spots(grow, placed(view, rest), placed(view, sleep));
      // 30 layout units past the leaf, level with it: join it as its child.
      expect(snap(glossary.id, at(view, spot.besideLeaf), null)).toEqual({ type: 'move', nodeId: glossary.id, parentId: rest.id, index: 0 });
      // Among the children of 回復する, between 休息の取り方 and 睡眠: before 睡眠.
      expect(snap(glossary.id, at(view, spot.between), null)).toEqual({ type: 'move', nodeId: glossary.id, parentId: recover.id, index: 1 });
      // Level with the far half of the last child: after it.
      expect(snap(glossary.id, at(view, spot.afterLast), null)).toEqual({ type: 'move', nodeId: glossary.id, parentId: recover.id, index: 2 });
      // Far from everything: nothing.
      expect(snap(glossary.id, at(view, { x: 2000, y: 2000, ...size }), null)).toBeNull();
      // The current slot survives a little drift beyond the plain zone, then lets go.
      const current = { type: 'move' as const, nodeId: glossary.id, parentId: rest.id, index: 0 };
      expect(snap(glossary.id, at(view, spot.drifted), current)).toBe(current);
      expect(snap(glossary.id, at(view, spot.drifted), null)).not.toEqual(current);
      expect(snap(glossary.id, at(view, spot.gone), current)).not.toBe(current);
      shift(glossary.id, null);
    },
  );

  it('in the hierarchy, level with the children row of the body root it slots in by horizontal position, and under a leaf of that row it becomes its child', async () => {
    const source = fixtureSource();
    const { view, topic } = await mount(source, 'hierarchy');
    const doc = documentOf(view);
    const body = projectMap(doc).root;
    const glossary = topic('補足: 用語');
    const habit = doc.nodes.find(node => node.title === '習慣化する');
    if (!habit) throw new Error('Missing node');
    const { shift, snap } = bind(view);
    shift(glossary.id, { x: 0, y: 0 });
    const recover = placed(view, doc.nodes.find(node => node.title === '回復する'));
    const record = placed(view, doc.nodes.find(node => node.title === '記録する'));
    const last = placed(view, habit);
    // Top edge on the row, centred in the gap between 回復する and 記録する: before 記録する.
    const gap = (recover.x + recover.width + record.x) / 2;
    expect(snap(glossary.id, at(view, { x: gap - size.width / 2, y: last.y, ...size }), null))
      .toEqual({ type: 'move', nodeId: glossary.id, parentId: body.id, index: 1 });
    // Over the right half of the last sibling: after it.
    expect(snap(glossary.id, at(view, { x: last.x + last.width / 2, y: last.y, ...size }), null))
      .toEqual({ type: 'move', nodeId: glossary.id, parentId: body.id, index: 3 });
    // Under the leaf 習慣化する, off the row: its child.
    expect(snap(glossary.id, at(view, { x: last.x, y: last.y + last.height + 30, ...size }), null))
      .toEqual({ type: 'move', nodeId: glossary.id, parentId: habit.id, index: 0 });
    // Right of it, where the map would put a child, is nothing in the hierarchy.
    expect(snap(glossary.id, at(view, { x: last.x + last.width + 30, y: last.y + last.height + 30, ...size }), null)).toBeNull();
    shift(glossary.id, null);
  });

  it('in the balanced map, a left branch takes the topic on its left, its children line up on their right edges, and the root has a column on each side', async () => {
    const source = fixtureSource();
    const { view, topic } = await mount(source, 'balanced');
    const doc = documentOf(view);
    const body = projectMap(doc).root;
    const glossary = topic('補足: 用語');
    const record = doc.nodes.find(node => node.title === '記録する');
    const review = doc.nodes.find(node => node.title === 'ふりかえる');
    const habit = doc.nodes.find(node => node.title === '習慣化する');
    if (!record || !review || !habit) throw new Error('Missing nodes');
    const { shift, snap } = bind(view);
    shift(glossary.id, { x: 0, y: 0 });
    const root = placed(view, body);
    const recover = placed(view, doc.nodes.find(node => node.title === '回復する'));
    const left = placed(view, record);
    const leftLeaf = placed(view, review);
    const last = placed(view, habit);
    // 記録する (second child) hangs left of the root with ふりかえる on its left; 回復する and 習慣化する hang right.
    expect(left.x + left.width).toBe(root.x - 80);
    expect(leftLeaf.x + leftLeaf.width).toBe(left.x - 56);
    expect(recover.x).toBe(root.x + root.width + 80);
    expect(last.x).toBe(recover.x);
    // Left of the left leaf, level with it: its child. Right of it (between it and its parent) is nothing.
    expect(snap(glossary.id, at(view, { x: leftLeaf.x - 30 - size.width, y: leftLeaf.y, ...size }), null))
      .toEqual({ type: 'move', nodeId: glossary.id, parentId: review.id, index: 0 });
    expect(snap(glossary.id, at(view, { x: leftLeaf.x + leftLeaf.width + 8, y: leftLeaf.y, ...size }), null)).toBeNull();
    // On the left column's line (right edges), centred on 記録する's top edge: before it (source index 1, the left side).
    // On its lower half: the next index, 3, is dealt to the left, so the topic joins as the last child of all and lands under 記録する.
    expect(snap(glossary.id, at(view, { x: left.x + left.width - size.width, y: left.y - size.height / 2, ...size }), null))
      .toEqual({ type: 'move', nodeId: glossary.id, parentId: body.id, index: 1 });
    expect(snap(glossary.id, at(view, { x: left.x + left.width - size.width, y: left.y + left.height / 2, ...size }), null))
      .toEqual({ type: 'move', nodeId: glossary.id, parentId: body.id, index: 3 });
    // On the right column's line (left edges), centred just above 習慣化する: before it (index 2, the right side).
    // On its lower half nothing: no even index is free after the last child, and a slot that jumps to the left is not offered.
    expect(snap(glossary.id, at(view, { x: last.x, y: last.y - size.height / 2 - 4, ...size }), null))
      .toEqual({ type: 'move', nodeId: glossary.id, parentId: body.id, index: 2 });
    expect(snap(glossary.id, at(view, { x: last.x, y: last.y + last.height / 2, ...size }), null)).toBeNull();
    // Right of the right leaf 習慣化する: its child, as in the map.
    expect(snap(glossary.id, at(view, { x: last.x + last.width + 30, y: last.y, ...size }), null))
      .toEqual({ type: 'move', nodeId: glossary.id, parentId: habit.id, index: 0 });
    shift(glossary.id, null);
  });

  it('on the timeline, centred on the axis it slots in among the stages by horizontal position, and over a leaf stage on its forest\'s side it becomes its child', async () => {
    const source = fixtureSource();
    const { view, topic } = await mount(source, 'timeline');
    const doc = documentOf(view);
    const body = projectMap(doc).root;
    const glossary = topic('補足: 用語');
    const habit = doc.nodes.find(node => node.title === '習慣化する');
    if (!habit) throw new Error('Missing node');
    const { shift, snap } = bind(view);
    shift(glossary.id, { x: 0, y: 0 });
    const recover = placed(view, doc.nodes.find(node => node.title === '回復する'));
    const record = placed(view, doc.nodes.find(node => node.title === '記録する'));
    const last = placed(view, habit);
    const axis = last.y + last.height / 2;
    // Centred on the axis in the gap between 回復する and 記録する: before 記録する.
    const gap = (recover.x + recover.width + record.x) / 2;
    expect(snap(glossary.id, at(view, { x: gap - size.width / 2, y: axis - size.height / 2, ...size }), null))
      .toEqual({ type: 'move', nodeId: glossary.id, parentId: body.id, index: 1 });
    // Over the right half of the last stage: after it.
    expect(snap(glossary.id, at(view, { x: last.x + last.width / 2, y: axis - size.height / 2, ...size }), null))
      .toEqual({ type: 'move', nodeId: glossary.id, parentId: body.id, index: 3 });
    // Above the leaf stage 習慣化する (the third stage hangs its forest above the axis): its child. Below it is nothing.
    expect(snap(glossary.id, at(view, { x: last.x, y: last.y - 30 - size.height, ...size }), null))
      .toEqual({ type: 'move', nodeId: glossary.id, parentId: habit.id, index: 0 });
    expect(snap(glossary.id, at(view, { x: last.x, y: last.y + last.height + 30, ...size }), null)).toBeNull();
    // Right of it on the axis is the next stage's place, not a child's, and too far for "after".
    expect(snap(glossary.id, at(view, { x: last.x + last.width + 60, y: axis - size.height / 2, ...size }), null)).toBeNull();
    shift(glossary.id, null);
  });

  it('on the timeline a childless stage takes the topic only on the side its forest hangs: above for even stages, below for odd', async () => {
    const { view, topic } = await mount(THREE_STAGES, 'timeline');
    const doc = documentOf(view);
    const glossary = topic('補足');
    const record = doc.nodes.find(node => node.title === '記録する');
    const habit = doc.nodes.find(node => node.title === '習慣化する');
    if (!record || !habit) throw new Error('Missing nodes');
    const { shift, snap } = bind(view);
    shift(glossary.id, { x: 0, y: 0 });
    const lower = placed(view, record);
    const upper = placed(view, habit);
    expect(snap(glossary.id, at(view, stageSpot(lower, 'below')), null)).toEqual({ type: 'move', nodeId: glossary.id, parentId: record.id, index: 0 });
    expect(snap(glossary.id, at(view, stageSpot(lower, 'above')), null)).toBeNull();
    expect(snap(glossary.id, at(view, stageSpot(upper, 'above')), null)).toEqual({ type: 'move', nodeId: glossary.id, parentId: habit.id, index: 0 });
    expect(snap(glossary.id, at(view, stageSpot(upper, 'below')), null)).toBeNull();
    shift(glossary.id, null);
  });

  it('keeps the slot it shows while its own placeholder shifts the hierarchy row under the root', async () => {
    const source = fixtureSource();
    const { view, topic } = await mount(source, 'hierarchy');
    const doc = documentOf(view);
    const body = projectMap(doc).root;
    const glossary = topic('補足: 用語');
    const habit = doc.nodes.find(node => node.title === '習慣化する');
    if (!habit) throw new Error('Missing node');
    const { shift, snap, preview } = bind(view);
    shift(glossary.id, { x: 0, y: 0 });
    const last = placed(view, habit);
    const spot = { x: last.x + last.width / 2, y: last.y, ...size };
    const command = snap(glossary.id, at(view, spot), null);
    expect(command).toEqual({ type: 'move', nodeId: glossary.id, parentId: body.id, index: 3 });
    // The placeholder joins the row, which re-centres under the root: every sibling moves left by half the added width.
    preview(command);
    await frame();
    expect(placed(view, habit).x).toBeLessThan(last.x - 60);
    expect(snap(glossary.id, at(view, spot), command)).toBe(command);
    preview(null);
    shift(glossary.id, null);
  });

  it('keeps the slot it shows while its own placeholder pushes the timeline stage right past a forest', async () => {
    const { view, topic } = await mount(DEEP_FOREST, 'timeline');
    const doc = documentOf(view);
    const glossary = topic('補足');
    const habit = doc.nodes.find(node => node.title === '習慣化する');
    if (!habit) throw new Error('Missing node');
    const { shift, snap, preview } = bind(view);
    shift(glossary.id, { x: 0, y: 0 });
    const stage = placed(view, habit);
    const spot = stageSpot(stage, 'above');
    const command = snap(glossary.id, at(view, spot), null);
    expect(command).toEqual({ type: 'move', nodeId: glossary.id, parentId: habit.id, index: 0 });
    // With a child the stage must clear the first stage's forest on its side, so it jumps right, out from under the root.
    preview(command);
    await frame();
    expect(placed(view, habit).x).toBeGreaterThan(stage.x + 100);
    expect(snap(glossary.id, at(view, spot), command)).toBe(command);
    preview(null);
    shift(glossary.id, null);
  });

  it('never snaps the body root, and a topic does not snap onto its own tree', async () => {
    const source = fixtureSource();
    const { view, layout, topic } = await mount(source);
    const doc = documentOf(view);
    const { root } = projectMap(doc);
    const reference = topic('参考資料');
    const own = reference.children[0];
    if (!own) throw new Error('Missing child');
    const shift = (view as unknown as { shiftTopic(id: string, delta: { x: number; y: number } | null): void }).shiftTopic.bind(view);
    const snap = (view as unknown as { snapTarget: Snap }).snapTarget.bind(view);
    const size = { width: 120, height: 40 };
    shift(root.id, { x: 0, y: 0 });
    const child = layout().nodes.find(node => node.id === doc.nodes.find(item => item.title === '用語 A')?.id);
    if (!child) throw new Error('Missing layout node');
    expect(snap(root.id, at(view, { x: child.x + child.width + 20, y: child.y, ...size }), null)).toBeNull();
    shift(root.id, null);
    shift(reference.id, { x: 0, y: 0 });
    const ownLayout = layout().nodes.find(node => node.id === own.id);
    if (!ownLayout) throw new Error('Missing layout node');
    expect(snap(reference.id, at(view, { x: ownLayout.x + ownLayout.width + 20, y: ownLayout.y, ...size }), null)).toBeNull();
    shift(reference.id, null);
  });
});
