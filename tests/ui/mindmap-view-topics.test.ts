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
import { fitToBounds } from '../../src/interaction/viewport';
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

  it('keeps a just-added, unnamed topic where it was pressed when the layout switches by button before it is named (LEV-129)', async () => {
    // pendingTopic is tagged with the mode it was pressed in (topicLayouts() only uses it when that tag
    // matches this.mode); Escape closes the inline editor without saving (InlineEditor.dispose(), not
    // save()) but leaves pendingTopic itself in place. Before the fix, a layout switch by button left the
    // tag stale, so the guard failed and the still-unnamed topic fell back to the default stacked slot.
    const source = fixtureSource();
    const { view, canvas, layout, transform, dblclick, key, editor, settle } = await mount(source, 'mindmap');
    const viewport = view.getState().viewport as { x: number; y: number; scale: number };
    const pressed = { x: (700 - viewport.x) / viewport.scale, y: (600 - viewport.y) / viewport.scale };
    dblclick(canvas, CANVAS.left + 700, CANVAS.top + 600);
    await settle();
    const input = editor();
    if (!input) throw new Error('No inline editor');
    key(input, 'Escape');
    await settle();
    const blank = projectMap(documentOf(view)).topics.at(-1);
    if (!blank) throw new Error('No blank topic');
    expect(transform(blank.id)).toEqual(pressed);
    const originBefore = layout().origin;
    view.containerEl.querySelector<HTMLButtonElement>('.mappy-modes button[aria-label="左右バランス"]')?.click();
    await settle();
    expect(layout().origin).not.toEqual(originBefore);
    // The pointer never touched the topic; only the layout changed. It must still sit exactly where it was pressed.
    expect(transform(blank.id)).toEqual(pressed);
  });

  it('keeps a still-unnamed topic where it was pressed after a drag crossing a layout switch is cancelled with Escape (LEV-129, code review\'s sharper repro)', async () => {
    // The code review found a tighter case than the one above: rather than switching after the inline
    // editor closes, drag the still-unnamed topic itself, switch layout mid-drag (which also rebases the
    // drag, per the case before this one), then Escape the drag (`endTopicDrag` never touches
    // `pendingTopic`). Without rebasing `pendingTopic` on every mode change — not only when no drag is
    // active — its `layout` tag would still read the mode it was pressed in, not the one the cancelled
    // drag leaves the view in, and it would fall back to the default slot once the drag lets go of it.
    const source = fixtureSource();
    const { view, canvas, transform, dblclick, settle } = await mount(source, 'mindmap');
    const viewport = view.getState().viewport as { x: number; y: number; scale: number };
    const pressed = { x: (700 - viewport.x) / viewport.scale, y: (600 - viewport.y) / viewport.scale };
    dblclick(canvas, CANVAS.left + 700, CANVAS.top + 600);
    await settle();
    const blank = projectMap(documentOf(view)).topics.at(-1);
    if (!blank) throw new Error('No blank topic');
    const shift = (view as unknown as { shiftTopic(id: string, delta: { x: number; y: number } | null): void }).shiftTopic.bind(view);
    shift(blank.id, { x: 0, y: 0 });
    await new Promise(resolve => requestAnimationFrame(resolve));
    view.containerEl.querySelector<HTMLButtonElement>('.mappy-modes button[aria-label="左右バランス"]')?.click();
    await settle();
    shift(blank.id, null); // Escape-equivalent: cancels the drag and restores it (`endTopicDrag(id, true)`).
    await settle();
    expect(transform(blank.id)).toEqual(pressed);
  });

  it('composes two layout switches ahead of a single frame without an extra drift (LEV-129, code review\'s double-switch case)', async () => {
    // applyMode reads `originFor()` fresh on both sides of every switch rather than a frame-cached origin
    // (`topicDrag.base.origin`, only refreshed by the next `requestAnimationFrame`), so a second switch
    // ahead of any frame still rebases from the true preceding origin instead of the one before that.
    const source = '## 本体\n\n- 回復する\n\n## 資料\n\n- 甲\n- 乙\n\n## 補足\n\n- 用語\n';
    const { view, transform, topic } = await mount(source, 'mindmap');
    const dragged = topic('資料');
    const shift = (view as unknown as { shiftTopic(id: string, delta: { x: number; y: number } | null): void }).shiftTopic.bind(view);
    shift(dragged.id, { x: 40, y: -40 });
    await new Promise(resolve => requestAnimationFrame(resolve));
    const beforeSwitch = transform(dragged.id);
    await view.setState({ file: PATH, layout: 'balanced' }, { history: false } satisfies ViewStateResult);
    await view.setState({ file: PATH, layout: 'hierarchy' }, { history: false } satisfies ViewStateResult);
    await new Promise(resolve => requestAnimationFrame(resolve));
    // Neither switch was a pointer move: the tree must be exactly where it was, not off by the first switch's origin delta.
    expect(transform(dragged.id)).toEqual(beforeSwitch);
    shift(dragged.id, null);
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
    // Both stay where they were; the untouched one keeps its id, the renamed one is the selection (found by the plan's
    // offset: a heading that was one of two keeps no id through a rename that also rewrites the frontmatter).
    const renamedTopic = projectMap(documentOf(view)).topics.find(node => node.title === '別の見出し');
    const remaining = projectMap(documentOf(view)).topics.find(node => node.title === '同じ見出し');
    if (!renamedTopic || !remaining) throw new Error('Missing topics');
    expect(remaining.id).toBe(second);
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
    // Its text did not change, so it keeps its id through the re-parse (and with it any fold on its branches).
    expect(remaining[0]?.id).toBe(second);
    expect(transform(second)).toEqual(secondBefore);
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

  it('keeps a dragged body (and its topics) steady on screen when the layout switches mid-drag, and saves what is shown (LEV-129)', async () => {
    // A body drag moves the viewport to carry the body while every topic's `overrides` cancels that pan
    // (LEV-129's fix leaves them alone on a mid-drag switch): what must not jump on screen is the pan
    // itself, since the body sits exactly at `origin` and a mode switch moves `origin` under it.
    const source = fixtureSource();
    const { view, canvas, nodes, layout, transform, source: current, settle, pointer, viewport } = await mount(source, 'mindmap');
    const { root, topics } = projectMap(documentOf(view));
    const screenOf = (id: string): { x: number; y: number } => {
      const t = transform(id);
      const v = viewport();
      return { x: t.x * v.scale + v.x, y: t.y * v.scale + v.y };
    };
    const element = nodes().get(root.id);
    if (!element) throw new Error('No body element');
    pointer('pointerdown', element, 500, 400);
    pointer('pointermove', canvas, 506, 400);
    pointer('pointermove', canvas, 560, 430);
    await new Promise(resolve => requestAnimationFrame(resolve));
    const bodyMidDrag = screenOf(root.id);
    const topicsMidDrag = new Map(topics.map(topic => [topic.id, screenOf(topic.id)]));
    await view.setState({ file: PATH, layout: 'balanced' }, { history: false } satisfies ViewStateResult);
    await new Promise(resolve => requestAnimationFrame(resolve));
    // The pointer has not moved, only the layout switched: the body and every topic must sit exactly where they did.
    expect(screenOf(root.id)).toEqual(bodyMidDrag);
    for (const topic of topics) expect(screenOf(topic.id)).toEqual(topicsMidDrag.get(topic.id));
    pointer('pointermove', canvas, 620, 470);
    await new Promise(resolve => requestAnimationFrame(resolve));
    const releasedWorld = new Map(topics.map(topic => [topic.id, transform(topic.id)]));
    const origin = layout().origin;
    pointer('pointerup', canvas, 620, 470);
    await settle();
    const positions = readTopicPositions(current());
    for (const topic of topics) {
      const world = releasedWorld.get(topic.id);
      if (!world) throw new Error('Missing topic');
      expect(positions.get(topic.title)?.balanced).toEqual({ x: Math.round(world.x - origin.x), y: Math.round(world.y - origin.y) });
    }
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

  it('on the timeline a short stage beside a tall one takes the topic where its first child lands: past the tall stage\'s half, not its own', async () => {
    const { view, topic, nodes } = await mount(THREE_STAGES, 'timeline');
    const doc = documentOf(view);
    const glossary = topic('補足');
    const tall = doc.nodes.find(node => node.title === '回復する');
    const record = doc.nodes.find(node => node.title === '記録する');
    const habit = doc.nodes.find(node => node.title === '習慣化する');
    if (!tall || !record || !habit) throw new Error('Missing nodes');
    // jsdom measures every node as 0 × 0 (so 160 × 44); the first stage 回復する measures 200 tall from here on, as one with
    // an image would, and the drag's first frame lays the map out again with it.
    const element = nodes().get(tall.id);
    if (!element) throw new Error('Missing the tall stage element');
    Object.defineProperty(element, 'offsetHeight', { value: 200 });
    const { shift, snap } = bind(view);
    shift(glossary.id, { x: 0, y: 0 });
    await frame();
    const lower = placed(view, record);
    const upper = placed(view, habit);
    expect(placed(view, tall).height).toBe(200);
    expect(lower.height).toBe(44);
    const axis = lower.y + lower.height / 2;
    // The band around the axis is the tall stage's half-height; the forests start 34 past it, 112 past a short stage's edge.
    const band = 100;
    const landing = (stage: Box, side: 'above' | 'below') => ({
      x: stage.x + stage.width / 2 + 20, y: side === 'below' ? axis + band + 34 : axis - band - 34 - size.height, ...size,
    });
    expect(snap(glossary.id, at(view, landing(lower, 'below')), null)).toEqual({ type: 'move', nodeId: glossary.id, parentId: record.id, index: 0 });
    expect(snap(glossary.id, at(view, landing(upper, 'above')), null)).toEqual({ type: 'move', nodeId: glossary.id, parentId: habit.id, index: 0 });
    // Just past the stage itself still counts: the zone reaches back to the stage.
    expect(snap(glossary.id, at(view, stageSpot(lower, 'below')), null)).toEqual({ type: 'move', nodeId: glossary.id, parentId: record.id, index: 0 });
    // Above the axis, the lower stage's landing column overlaps the upper stage 習慣化する, whose zone that is; 20 units
    // in from the lower stage's left edge overlaps neither upper stage, and the lower stage takes nothing above the axis.
    expect(snap(glossary.id, at(view, landing(lower, 'above')), null)).toEqual({ type: 'move', nodeId: glossary.id, parentId: habit.id, index: 0 });
    expect(snap(glossary.id, at(view, { ...landing(lower, 'above'), x: lower.x + 20 }), null)).toBeNull();
    // 73 past the band is out, as 73 past a stage of the band's height would be.
    expect(snap(glossary.id, at(view, { ...landing(lower, 'below'), y: axis + band + 73 }), null)).toBeNull();
    shift(glossary.id, null);
  });

  it.each(['mindmap', 'balanced'] as const)(
    'in %s a root with nothing under it takes the topic where its first child lands, a root gap (80) past it: farther than a branch\'s child (56)', async mode => {
      // The topic 空の話題 is only its heading, so its first child would hang 80 past it (right, in the balanced map too);
      // the leaf 回復する under the body root hangs its child 56 past itself.
      const { view, topic } = await mount('## 本体\n\n- 回復する\n\n## 空の話題\n\n## 補足\n\n- 用語\n', mode);
      const doc = documentOf(view);
      const glossary = topic('補足');
      const empty = topic('空の話題');
      const recover = doc.nodes.find(node => node.title === '回復する');
      if (!recover) throw new Error('Missing node');
      const { shift, snap } = bind(view);
      shift(glossary.id, { x: 0, y: 0 });
      const root = placed(view, empty);
      const leaf = placed(view, recover);
      const level = (box: Box, x: number) => ({ x, y: box.y + (box.height - size.height) / 2, ...size });
      const joinsRoot = { type: 'move', nodeId: glossary.id, parentId: empty.id, index: 0 };
      // At the landing, and up to 16 past it (the same margin a branch's zone leaves past its child); 17 past is out.
      expect(snap(glossary.id, at(view, level(root, root.x + root.width + 80)), null)).toEqual(joinsRoot);
      expect(snap(glossary.id, at(view, level(root, root.x + root.width + 96)), null)).toEqual(joinsRoot);
      expect(snap(glossary.id, at(view, level(root, root.x + root.width + 97)), null)).toBeNull();
      // Snug against the root still counts, and its left side is nothing: the first child goes right.
      expect(snap(glossary.id, at(view, level(root, root.x + root.width - 8)), null)).toEqual(joinsRoot);
      expect(snap(glossary.id, at(view, level(root, root.x - 80 - size.width)), null)).toBeNull();
      // The leaf keeps the plain zone: 80 past it is out, 56 (its landing) is in.
      expect(snap(glossary.id, at(view, level(leaf, leaf.x + leaf.width + 80)), null)).toBeNull();
      expect(snap(glossary.id, at(view, level(leaf, leaf.x + leaf.width + 56)), null)).toEqual({ type: 'move', nodeId: glossary.id, parentId: recover.id, index: 0 });
      if (mode === 'balanced') {
        // The body root's one child was dealt right; the second goes left, a root gap out, so that empty side is the same zone mirrored.
        const bodyRoot = projectMap(doc).root;
        const body = placed(view, bodyRoot);
        expect(snap(glossary.id, at(view, level(body, body.x - 80 - size.width)), null)).toEqual({ type: 'move', nodeId: glossary.id, parentId: bodyRoot.id, index: 1 });
        expect(snap(glossary.id, at(view, level(body, body.x - 97 - size.width)), null)).toBeNull();
      }
      shift(glossary.id, null);
    },
  );

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

  it.each([['balanced', 'right'], ['hierarchy', 'below']] as const)(
    'in %s a topic with no position keeps its slot in the stack while the slot beside it is previewed: the placeholder hangs where the dragged root is, and the stack under it stays (LEV-95)', async (mode, side) => {
      // No topic has a position: 空の話題 (only its heading) stacks first under the body, 補足 under it, 余談 last. 補足 is carried
      // to where 空の話題's first child lands (a root gap right of it in the balanced map, one under it in the hierarchy).
      const { view, layout, topic } = await mount('## 本体\n\n- 回復する\n\n## 空の話題\n\n## 補足\n\n- 用語\n\n## 余談\n\n- 補遺\n', mode);
      const glossary = topic('補足');
      const empty = topic('空の話題');
      const aside = topic('余談');
      const { shift, snap, preview } = bind(view);
      shift(glossary.id, { x: 0, y: 0 });
      const root = placed(view, empty);
      const held = placed(view, glossary);
      const landing = side === 'right'
        ? { x: root.x + root.width + 80, y: root.y + (root.height - held.height) / 2 }
        : { x: root.x + (root.width - held.width) / 2, y: root.y + root.height + 48 };
      const { scale } = view.getState().viewport as { scale: number };
      shift(glossary.id, { x: (landing.x - held.x) * scale, y: (landing.y - held.y) * scale });
      await frame();
      // The dragged root sits at the landing; the parent, beside it and clear of it, has not moved.
      expect(placed(view, glossary).x).toBeCloseTo(landing.x, 6);
      expect(placed(view, glossary).y).toBeCloseTo(landing.y, 6);
      expect(placed(view, empty)).toEqual(root);
      const stacked = placed(view, aside);
      const command = snap(glossary.id, at(view, { ...landing, width: held.width, height: held.height }), null);
      expect(command).toEqual({ type: 'move', nodeId: glossary.id, parentId: empty.id, index: 0 });
      preview(command);
      await frame();
      // The placeholder widens the parent's tree, which neither re-centres under the body root nor restacks clear of the
      // dragged tree: the parent stays where the snap judged it, so the slot hangs exactly where the dragged root is.
      const parent = placed(view, empty);
      expect(parent.x).toBeCloseTo(root.x, 6);
      expect(parent.y).toBeCloseTo(root.y, 6);
      const slot = layout().nodes.find(node => node.id === PLACEHOLDER_ID);
      expect(slot?.x).toBeCloseTo(landing.x, 6);
      expect(slot?.y).toBeCloseTo(landing.y, 6);
      expect(layout().edges.some(edge => edge.from === empty.id && edge.to === PLACEHOLDER_ID)).toBe(true);
      // The rest of the stack keeps the slots the placeholder-free layout gave it as well.
      expect(placed(view, aside).x).toBeCloseTo(stacked.x, 6);
      expect(placed(view, aside).y).toBeCloseTo(stacked.y, 6);
      expect(snap(glossary.id, at(view, { ...landing, width: held.width, height: held.height }), command)).toBe(command);
      preview(null);
      await frame();
      expect(placed(view, empty)).toEqual(root);
      shift(glossary.id, null);
    },
  );

  it('a body branch previewed onto a topic with no position (a hover, no topic drag) leaves that topic and the stack where they are', async () => {
    // The same widening, from the other kind of drag: the ghost of 回復する held over the heading-only topic 空の話題
    // previews a slot a root gap right of it. Without the hold the topic re-centred out from under the pointer.
    const { view, layout, topic } = await mount('## 本体\n\n- 回復する\n\n## 空の話題\n\n## 補足\n\n- 用語\n', 'balanced');
    const doc = documentOf(view);
    const empty = topic('空の話題');
    const glossary = topic('補足');
    const recover = doc.nodes.find(node => node.title === '回復する');
    if (!recover) throw new Error('Missing node');
    const { preview } = bind(view);
    const root = placed(view, empty);
    const stacked = placed(view, glossary);
    preview({ type: 'move', nodeId: recover.id, parentId: empty.id, index: 0 });
    await frame();
    expect(placed(view, empty).x).toBeCloseTo(root.x, 6);
    expect(placed(view, empty).y).toBeCloseTo(root.y, 6);
    expect(placed(view, glossary).x).toBeCloseTo(stacked.x, 6);
    expect(placed(view, glossary).y).toBeCloseTo(stacked.y, 6);
    const slot = layout().nodes.find(node => node.id === PLACEHOLDER_ID);
    expect(slot?.x).toBeCloseTo(root.x + root.width + 80, 6);
    preview(null);
    await frame();
    expect(placed(view, empty)).toEqual(root);
  });

  it.each(['mindmap', 'timeline', 'hierarchy', 'balanced'] as const)(
    'in %s, dragging a topic into an unpositioned topic\'s child column keeps the parent in place and exposes the trailing slot',
    async mode => {
      const source = '## 本体\n\n- 回復する\n\n## 資料\n\n- 甲\n- 乙\n\n## 補足\n\n- 用語\n';
      const { view, topic, source: current, settle, undo, redo } = await mount(source, mode);
      const doc = documentOf(view);
      const parent = topic('資料');
      const glossary = topic('補足');
      const trailing = doc.nodes.find(node => node.title === '乙');
      const right = doc.nodes.find(node => node.title === '甲');
      if (!trailing || !right) throw new Error('Missing node');
      const { shift, snap, preview } = bind(view);
      const root = placed(view, parent);
      // Balanced appends index 2 on the right column (after 甲); the ordinary map has one column (after 乙).
      const child = placed(view, mode === 'balanced' ? right : trailing);
      const moving = placed(view, glossary);
      const viewport = view.getState().viewport as { x: number; y: number; scale: number };
      // Each layout judges the slot on the line its children share, so the landing is measured against that line
      // (`snapSlot`): the column's left edge in the map and the balanced map, where the trailing slot is under the
      // last child's lower half; the row's top edge in the hierarchy and the axis (the children's centre) in the
      // timeline, where it is three quarters along the last child — the root's own centre decides a row (LEV-125).
      const along = { x: child.x + child.width * 0.75 - moving.width / 2, width: moving.width, height: moving.height };
      const landing = mode === 'hierarchy' ? { ...along, y: child.y }
        : mode === 'timeline' ? { ...along, y: child.y + (child.height - moving.height) / 2 }
          : { x: child.x, y: child.y + child.height / 2, width: moving.width, height: moving.height };
      shift(glossary.id, {
        x: (landing.x - moving.x) * viewport.scale,
        y: (landing.y - moving.y) * viewport.scale,
      });
      await frame();
      expect(placed(view, parent)).toEqual(root);
      const command = snap(glossary.id, at(view, landing), null);
      expect(command).toEqual({ type: 'move', nodeId: glossary.id, parentId: parent.id, index: 2 });
      if (!command) throw new Error('Missing trailing slot');
      preview(command);
      await frame();
      expect(placed(view, parent)).toEqual(root);
      preview(null);
      await (view as unknown as { executeDrop(command: MoveCommand): Promise<void> }).executeDrop(command);
      await settle();
      const joined = '## 本体\n\n- 回復する\n\n## 資料\n\n- 甲\n- 乙\n- 補足\n  - 用語\n';
      expect(current()).toBe(joined);
      const joinedSource = projectMap(documentOf(view)).topics.find(node => node.title === '資料');
      expect(joinedSource?.children.map(node => node.title)).toEqual(['甲', '乙', '補足']);
      expect(joinedSource?.children[2]?.children.map(node => node.title)).toEqual(['用語']);
      await undo();
      expect(current()).toBe(source);
      await redo();
      expect(current()).toBe(joined);
    },
  );

  it.each(['mindmap', 'timeline', 'hierarchy', 'balanced'] as const)(
    'in %s the stack does not part for the tree being dragged: the topic stacked under it keeps its slot while the two overlap, and takes it again when the drag is dropped',
    async mode => {
      // The price of the hold, written down (LEV-117 for the map and the balanced map, LEV-125 for the other two):
      // while a topic is carried, the unpositioned topics no longer restack around it, so the trees may overlap on
      // screen. Carrying 補足 onto 余談 is the plainest case of it; without the hold, 余談 rose into the slot 補足
      // had left the moment the drag began (timeline y 162 → 70, hierarchy 368 → 184).
      const { view, topic } = await mount('## 本体\n\n- 回復する\n\n## 補足\n\n- 用語\n\n## 余談\n\n- 補遺\n', mode);
      const glossary = topic('補足');
      const aside = topic('余談');
      const { shift } = bind(view);
      const moving = placed(view, glossary);
      const stacked = placed(view, aside);
      const { scale } = view.getState().viewport as { scale: number };
      shift(glossary.id, { x: (stacked.x - moving.x) * scale, y: (stacked.y - moving.y) * scale });
      await frame();
      expect(placed(view, glossary).x).toBeCloseTo(stacked.x, 6);
      expect(placed(view, glossary).y).toBeCloseTo(stacked.y, 6);
      expect(placed(view, aside)).toEqual(stacked);
      // Dropped without a slot under it, the topic keeps where it was left and the stack is dealt again from there.
      shift(glossary.id, null);
      await frame();
      expect(placed(view, glossary)).toEqual(moving);
      expect(placed(view, aside)).toEqual(stacked);
    },
  );

  it('drops the hold when the layout is switched during a topic drag, so the topics re-stack in the new layout', async () => {
    // No button reaches a held pointer, but `setState` switches layouts (a restored workspace, a pane opened on the
    // same note): the hold measures from the layout it was taken in, so it must not survive into another one.
    const source = '## 本体\n\n- 回復する\n\n## 資料\n\n- 甲\n- 乙\n\n## 補足\n\n- 用語\n';
    // The layout node carries its id; the two mounts number their nodes apart, so compare the box alone.
    const rect = ({ x, y, width, height }: Box): Box => ({ x, y, width, height });
    const balanced = await mount(source, 'balanced');
    const settled = rect(placed(balanced.view, balanced.topic('資料')));
    document.body.replaceChildren();
    const { view, topic } = await mount(source, 'mindmap');
    const parent = topic('資料');
    const { shift } = bind(view);
    // Far clear of the stack, so the only thing that can move 資料 is the layout it is measured in.
    shift(topic('補足').id, { x: 900, y: 40 });
    await frame();
    expect(placed(view, parent).y).toBe(125);
    await view.setState({ file: PATH, layout: 'balanced' }, { history: false } satisfies ViewStateResult);
    await frame();
    // Held from the map's layout, 資料 would sit at y 103: its map offset measured from the balanced origin.
    expect(rect(placed(view, parent))).toEqual(settled);
  });

  it('keeps the carried tree itself under the pointer when the layout switches mid-drag, and drops where it is shown (LEV-129)', async () => {
    // `topicDrag.from`/`overrides` are offsets from the body root's top-left, which the map and the balanced
    // map place differently (`layoutTree`'s `origin`). Before the fix, switching layouts mid-drag left them
    // measured from the map's origin, so the carried tree jumped by the origins' difference and the drop
    // saved that jumped position under the balanced key.
    const source = '## 本体\n\n- 回復する\n\n## 資料\n\n- 甲\n- 乙\n\n## 補足\n\n- 用語\n';
    const { view, layout, topic, source: current } = await mount(source, 'mindmap');
    const dragged = topic('資料');
    const { shift } = bind(view);
    const place = (view as unknown as { placeTopic(id: string, delta: { x: number; y: number }): Promise<void> }).placeTopic.bind(view);
    shift(dragged.id, { x: 40, y: -40 });
    await frame();
    const beforeSwitch = placed(view, dragged);
    await view.setState({ file: PATH, layout: 'balanced' }, { history: false } satisfies ViewStateResult);
    await frame();
    // The pointer has not moved, only the layout switched: the carried tree must sit exactly where it did.
    expect(placed(view, dragged)).toEqual(beforeSwitch);
    // The drag continues normally from there: further travel lands exactly that far from where it was held.
    shift(dragged.id, { x: 70, y: -10 });
    await frame();
    const released = placed(view, dragged);
    const origin = layout().origin;
    await place(dragged.id, { x: 70, y: -10 });
    const expected = { x: Math.round(released.x - origin.x), y: Math.round(released.y - origin.y) };
    expect(readTopicPositions(current()).get('資料')?.balanced).toEqual(expected);
  });

  it('refreshes the drag\'s own snap map synchronously on a mid-drag layout switch, ahead of the next frame (LEV-129)', async () => {
    // `topicDrag.base`/`index` (what the snap judges against) are otherwise only refreshed by the next
    // layout frame (`requestAnimationFrame`); `setState` calls `applyMode` synchronously, then awaits a
    // store read before its own draw runs. A pointer move landing in that gap would judge the new mode's
    // positions against the old mode's map unless `base`/`index` are current the instant the mode changes.
    const source = fixtureSource();
    const { view, topic } = await mount(source, 'mindmap');
    const glossary = topic('補足: 用語');
    const { shift } = bind(view);
    shift(glossary.id, { x: 0, y: 0 });
    await frame();
    await view.setState({ file: PATH, layout: 'balanced' }, { history: false } satisfies ViewStateResult);
    // No frame awaited here on purpose: the assertion below must hold before the next one runs.
    const drag = (view as unknown as { topicDrag: { base: LayoutResult; index: unknown } | null }).topicDrag;
    if (!drag) throw new Error('Drag ended');
    const fresh = (view as unknown as { originFor(doc: MindDocument): { x: number; y: number } }).originFor(documentOf(view));
    expect(drag.base.origin).toEqual(fresh);
    expect(drag.index).toBeNull();
    shift(glossary.id, null);
  });

  it('in the map a topic with no position and two children keeps its slot while a third is previewed under them', async () => {
    // The stack is flush left in the map, so no column moves; but the placeholder adds a row to the forest, on which
    // placeSideways re-centres the root, and the widened bounds reach the dragged tree stacked below, which used to push
    // the topic under it. (The slot is previewed directly: a dragged tree brought to the children's column overlaps the
    // topic's bounds, and the stack yields to a dragged tree before any slot is shown.)
    const { view, layout, topic } = await mount('## 本体\n\n- 回復する\n\n## 資料\n\n- 甲\n- 乙\n\n## 補足\n\n- 用語\n', 'mindmap');
    const doc = documentOf(view);
    const source = topic('資料');
    const glossary = topic('補足');
    const second = doc.nodes.find(node => node.title === '乙');
    if (!second) throw new Error('Missing node');
    const { shift, preview } = bind(view);
    shift(glossary.id, { x: 0, y: 0 });
    const root = placed(view, source);
    const last = placed(view, second);
    preview({ type: 'move', nodeId: glossary.id, parentId: source.id, index: 2 });
    await frame();
    expect(placed(view, source).x).toBeCloseTo(root.x, 6);
    expect(placed(view, source).y).toBeCloseTo(root.y, 6);
    // The forest, a row taller, re-centres on the root that stayed: the children move up and the slot hangs under the last.
    const slot = layout().nodes.find(node => node.id === PLACEHOLDER_ID);
    const moved = placed(view, second);
    expect(moved.y).toBeLessThan(last.y);
    expect(slot?.x).toBeCloseTo(last.x, 6);
    expect(slot?.y).toBeGreaterThan(moved.y + moved.height);
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

  it('reads the map once per base while only the carried tree moves, and again when a node\'s size changes under it (LEV-126)', async () => {
    // The index the snap reads is kept across the frames of one drag. Counting the reads shows both halves:
    // carrying the tree does not rebuild it, and a size the layout was never told about does.
    const { view, topic, nodes } = await mount(fixtureSource());
    const doc = documentOf(view);
    const rest = doc.nodes.find(node => node.title === '休息の取り方');
    const recover = doc.nodes.find(node => node.title === '回復する');
    if (!rest || !recover) throw new Error('Missing nodes');
    const glossary = topic('補足: 用語');
    const { shift, snap } = bind(view);
    const inner = view as unknown as { snapIndex(...args: unknown[]) : unknown };
    const original = inner.snapIndex.bind(view);
    const reads = vi.fn(original);
    inner.snapIndex = reads;
    const beside = () => {
      const leaf = placed(view, rest);
      return at(view, { x: leaf.x + leaf.width + 30, y: leaf.y, width: 120, height: 40 });
    };
    shift(glossary.id, { x: 0, y: 0 });
    await frame();
    const slot = { type: 'move' as const, nodeId: glossary.id, parentId: rest.id, index: 0 };
    expect(snap(glossary.id, beside(), null)).toEqual(slot);
    expect(reads).toHaveBeenCalledTimes(1);
    // Three more frames of carrying the tree, and the reading of the map still stands.
    for (const step of [4, 8, 12]) {
      shift(glossary.id, { x: step, y: 0 });
      await frame();
      expect(snap(glossary.id, beside(), null)).toEqual(slot);
    }
    expect(reads).toHaveBeenCalledTimes(1);
    // A node grows without anything asking for a layout (a theme class, a font arriving): the next base is
    // a different map, so the reading has to be taken again — and it describes the map as it now is.
    const element = nodes().get(recover.id);
    if (!element) throw new Error('Missing the node element');
    Object.defineProperty(element, 'offsetHeight', { value: 200 });
    shift(glossary.id, { x: 16, y: 0 });
    await frame();
    expect(placed(view, recover).height).toBe(200);
    expect(snap(glossary.id, beside(), null)).toEqual(slot);
    expect(reads).toHaveBeenCalledTimes(2);
    shift(glossary.id, null);
    inner.snapIndex = original;
  });
});

describe('MindmapView holds the viewport through a layout switch made mid-drag, and fits once the drag ends (LEV-182)', () => {
  // `selectMode()` (the layout buttons) asks for a fit. With a drag in progress, that fit rewrites the viewport's
  // pan and scale under the pointer: a carried topic, placed at its origin-relative offset through the viewport,
  // leaves the pointer; a dragged body, carried by the viewport pan itself, jumps until the next move puts the pan
  // back and the fit is lost. A single mouse cannot reach the button (the canvas holds pointer capture), but a
  // second pointer (a finger) can, so the view is driven here directly.
  const frame = (): Promise<unknown> => new Promise(resolve => requestAnimationFrame(resolve));
  const select = (view: MindmapView, mode: LayoutMode): void => {
    (view as unknown as { selectMode(mode: LayoutMode): void }).selectMode(mode);
  };
  const shiftOf = (view: MindmapView) =>
    (view as unknown as { shiftTopic(id: string, delta: { x: number; y: number } | null): void }).shiftTopic.bind(view);
  /** The canvas gets a size (jsdom has none, so no fit ever runs), and the fit that was waiting for it is consumed first. */
  const sized = async (mounted: Mounted): Promise<void> => {
    Object.defineProperty(mounted.canvas, 'clientWidth', { value: CANVAS.width, configurable: true });
    Object.defineProperty(mounted.canvas, 'clientHeight', { value: CANVAS.height, configurable: true });
    (mounted.view as unknown as { scheduleLayout(): void }).scheduleLayout();
    await frame();
    // Then away from the fit, so a fit afterwards shows as a change.
    const fitted = mounted.viewport();
    mounted.view.containerEl.querySelector<HTMLButtonElement>('button[aria-label="拡大"]')?.click();
    expect(mounted.viewport()).not.toEqual(fitted);
  };
  const fitted = (mounted: Mounted) => fitToBounds(mounted.layout().bounds, CANVAS.width, CANVAS.height);
  const screenOf = (mounted: Mounted, id: string): { x: number; y: number } => {
    const t = mounted.transform(id);
    const v = mounted.viewport();
    return { x: t.x * v.scale + v.x, y: t.y * v.scale + v.y };
  };
  /** Screen points agree to well under a pixel; the switch's rebase goes through the origin in world units and back. */
  const expectAt = (actual: { x: number; y: number }, expected: { x: number; y: number } | undefined): void => {
    if (!expected) throw new Error('Missing position');
    expect(actual.x).toBeCloseTo(expected.x, 6);
    expect(actual.y).toBeCloseTo(expected.y, 6);
  };

  it('a topic drag: the viewport and the carried tree stay put on screen through the switch; releasing fits', async () => {
    const mounted = await mount('## 本体\n\n- 回復する\n\n## 資料\n\n- 甲\n- 乙\n\n## 補足\n\n- 用語\n', 'mindmap');
    await sized(mounted);
    const { view, topic, viewport } = mounted;
    const dragged = topic('資料');
    const shift = shiftOf(view);
    shift(dragged.id, { x: 40, y: -40 });
    await frame();
    const viewBefore = viewport();
    const shownBefore = screenOf(mounted, dragged.id);
    select(view, 'balanced');
    await frame();
    expect(viewport()).toEqual(viewBefore);
    expectAt(screenOf(mounted, dragged.id), shownBefore);
    // The drag continues from there at the same scale: 30 more screen pixels of travel move the tree 30 pixels.
    shift(dragged.id, { x: 70, y: -40 });
    await frame();
    expect(viewport()).toEqual(viewBefore);
    expectAt(screenOf(mounted, dragged.id), { x: shownBefore.x + 30, y: shownBefore.y });
    const place = (view as unknown as { placeTopic(id: string, delta: { x: number; y: number }): Promise<void> }).placeTopic.bind(view);
    await place(dragged.id, { x: 70, y: -40 });
    await mounted.settle();
    expect(viewport()).toEqual(fitted(mounted));
  });

  it('a topic drag cancelled after the switch also fits once it has put the tree back', async () => {
    const mounted = await mount('## 本体\n\n- 回復する\n\n## 資料\n\n- 甲\n- 乙\n\n## 補足\n\n- 用語\n', 'mindmap');
    await sized(mounted);
    const { view, topic, viewport } = mounted;
    const dragged = topic('資料');
    const shift = shiftOf(view);
    shift(dragged.id, { x: 40, y: -40 });
    await frame();
    const viewBefore = viewport();
    select(view, 'balanced');
    await frame();
    expect(viewport()).toEqual(viewBefore);
    shift(dragged.id, null);
    await frame();
    expect(viewport()).toEqual(fitted(mounted));
  });

  it('a body drag: the pan that carries the body is not overwritten by the switch; releasing fits', async () => {
    const mounted = await mount(fixtureSource(), 'mindmap');
    await sized(mounted);
    const { view, canvas, nodes, pointer, viewport } = mounted;
    const { root, topics } = projectMap(documentOf(view));
    const element = nodes().get(root.id);
    if (!element) throw new Error('No body element');
    pointer('pointerdown', element, 500, 400);
    pointer('pointermove', canvas, 506, 400);
    pointer('pointermove', canvas, 560, 430);
    await frame();
    const bodyBefore = screenOf(mounted, root.id);
    const topicsBefore = new Map(topics.map(item => [item.id, screenOf(mounted, item.id)]));
    select(view, 'balanced');
    await frame();
    expectAt(screenOf(mounted, root.id), bodyBefore);
    for (const item of topics) expectAt(screenOf(mounted, item.id), topicsBefore.get(item.id));
    pointer('pointermove', canvas, 590, 430);
    await frame();
    expectAt(screenOf(mounted, root.id), { x: bodyBefore.x + 30, y: bodyBefore.y });
    pointer('pointerup', canvas, 590, 430);
    await mounted.settle();
    expect(viewport()).toEqual(fitted(mounted));
  });

  it('with no drag, a layout switch fits at once as before', async () => {
    // Holds before and after the fix alike: it pins the half of the acceptance that must not change.
    const mounted = await mount(fixtureSource(), 'mindmap');
    await sized(mounted);
    select(mounted.view, 'balanced');
    await frame();
    expect(mounted.viewport()).toEqual(fitted(mounted));
  });
});
