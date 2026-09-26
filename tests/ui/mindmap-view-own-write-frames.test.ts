// @vitest-environment jsdom
/**
 * A write of the map's own shows what it wrote from the moment it lands (LEV-219). `writeOwn` re-reads the note after
 * the write, and the modify watcher of that very write schedules a re-read of its own (45 ms debounce). When a read
 * takes longer than the debounce (E53's `slow`: every read answered 80 ms late), the watcher's re-read starts while the
 * save's is still reading, the save's gives up (the epoch), and until the watcher's re-read draws, the map drew the
 * note from before the write: the old title, no new node, the node back in its old place, a topic dropped on a slot or
 * a branch detached back where it was pressed.
 *
 * The matrix is what the user did (F2 rename, Tab, ⌥↓／⌥↑, ⌘Z, ⌘⇧Z, a topic dropped on a node's slot, a branch detached
 * onto the canvas) × the node it was done to (one title, the second untitled node, the second of two same-titled
 * nodes, a topic). Every frame from the write's landing until the watcher's re-read has drawn is sampled; none may
 * show the note from before the write. Each row also checks that the save's re-read was superseded, which is the
 * order the ticket is about (without it the row would pass for the wrong reason).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { Notice } from '../../harness/browser/obsidian';
import type { MoveCommand } from '../../src/core/commands';
import { projectMap, type MindDocument } from '../../src/core/markdown';
import { mountMapView, type MountedMapView } from './map-view-mount';
import { accessibleName } from './accessible-name';

vi.mock('obsidian', () => import('../../harness/browser/obsidian'));
beforeAll(() => { installObsidianDom(); });

const opened: MountedMapView[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const mounted of opened.splice(0)) await mounted.close();
  document.body.replaceChildren();
  Notice.log.length = 0;
});

const PATH = 'Fixtures/own-write-frames.md';
const EMPTY_LABEL = '空のノード';
const SOURCE = [
  '---', 'mappy: true', 'mappy-topics:', '  トピック: { mindmap: [40, 400] }', '---',
  '## 本体', '',
  '- 親', '  - 子1', '  - 子2',
  '- ', '  - 空の子',
  '- ', '  - 空の子2',
  '- 同名', '  - 同名の子A',
  '- 同名', '  - 同名の子B',
  '', '## トピック', '',
  '- 枝', '',
].join('\n');
/** How late every read answers in the slow rows: longer than the watcher's 45 ms debounce, as E53's `slow`. */
const SLOW_MS = 80;

interface ViewState {
  document: MindDocument | undefined; epoch: number; saving: boolean;
  refreshTimer: number | undefined; refreshing: Promise<void> | undefined;
}
const state = (mounted: MountedMapView): ViewState => mounted.view as unknown as ViewState;
const frame = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => resolve()));

async function mount(): Promise<MountedMapView> {
  const mounted = await mountMapView(PATH, SOURCE, 'mindmap');
  opened.push(mounted);
  return mounted;
}

/** Every write and re-read done, with the map showing what the note holds. */
async function settled(mounted: MountedMapView): Promise<void> {
  const view = state(mounted);
  await vi.waitFor(() => {
    expect({ timer: view.refreshTimer, read: view.refreshing, saving: view.saving, current: view.document?.source === mounted.source() })
      .toEqual({ timer: undefined, read: undefined, saving: false, current: true });
  }, { timeout: 3000, interval: 5 });
  await mounted.settle();
}

/** The `index`-th node on screen with this label (an untitled node reads as 空のノード). */
function nodeNamed(mounted: MountedMapView, label: string, index = 0): HTMLElement {
  const found = Array.from(mounted.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node')).filter(node => accessibleName(node) === label)[index];
  if (!found) throw new Error(`No node ${label} #${index}`);
  return found;
}

/** The labels of the nodes on screen, in document order. */
function labels(mounted: MountedMapView): string[] {
  return Array.from(mounted.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node'), node => accessibleName(node));
}

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function idOf(mounted: MountedMapView, label: string, index = 0): string {
  const id = nodeNamed(mounted, label, index).dataset.nodeId;
  if (!id) throw new Error(`No id for ${label}`);
  return id;
}

/** F2 on the node, the draft set to `title`, Enter. */
function rename(mounted: MountedMapView, label: string, index: number, title: string): void {
  click(nodeNamed(mounted, label, index));
  mounted.key(mounted.canvas, 'F2');
  const editor = mounted.editor();
  if (!editor) throw new Error('F2 opened no editor');
  editor.value = title;
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  mounted.key(editor, 'Enter');
}

interface Watched {
  /** What the map showed on each frame from the write's landing until everything settled: the note, and the labels drawn. */
  frames: { source: string; labels: string[] }[];
  /** Whether the first re-read begun after the write gave up to a newer one (the order under test). */
  superseded: boolean | null;
}

/**
 * Runs `act` with every read answered SLOW_MS late, and samples the note the map shows on each frame from the moment
 * the store's write (an edit, Undo, Redo) resolves until every re-read has drawn.
 */
async function watch(mounted: MountedMapView, act: () => void | Promise<void>): Promise<Watched> {
  const view = state(mounted);
  const store = (mounted.view as unknown as { store: {
    read(file: unknown): Promise<string>; applyOver(...args: unknown[]): Promise<unknown>;
    undo(...args: unknown[]): Promise<unknown>; redo(...args: unknown[]): Promise<unknown>;
  } }).store;
  let landed = false;
  let superseded: boolean | null = null;
  let claimed = false;
  const read = store.read.bind(store);
  vi.spyOn(store, 'read').mockImplementation(async file => {
    const epoch = view.epoch;
    const first = landed && !claimed;
    if (first) claimed = true;
    await new Promise(resolve => setTimeout(resolve, SLOW_MS));
    if (first) superseded = view.epoch !== epoch;
    return read(file);
  });
  for (const method of ['applyOver', 'undo', 'redo'] as const) {
    const original = store[method].bind(store);
    vi.spyOn(store, method).mockImplementation(async (...args: unknown[]) => {
      const result = await original(...args);
      landed = true;
      return result;
    });
  }
  const frames: Watched['frames'] = [];
  let done = false;
  const sampling = (async () => {
    while (!done) {
      await frame();
      if (landed) frames.push({ source: view.document?.source ?? '', labels: labels(mounted) });
    }
  })();
  await act();
  await vi.waitFor(() => { expect(landed).toBe(true); }, { timeout: 3000, interval: 2 });
  await settled(mounted);
  done = true;
  await sampling;
  vi.restoreAllMocks();
  return { frames, superseded };
}

/** No frame after the write showed `before`, and the write's own re-read was superseded (the order under test). */
function expectNoStaleFrame(watched: Watched, before: string, after: string): void {
  expect(watched.superseded).toBe(true);
  expect(watched.frames.length).toBeGreaterThan(1);
  expect(after).not.toBe(before);
  const stale = watched.frames.flatMap((shown, index) => shown.source === before ? [index] : []);
  expect({ stale, last: watched.frames[watched.frames.length - 1]?.source === after }).toEqual({ stale: [], last: true });
}

const SHAPES = [
  { shape: '通常', label: '子1', index: 0 },
  { shape: '空題名 (the second)', label: EMPTY_LABEL, index: 1 },
  { shape: '同名 (the second)', label: '同名', index: 1 },
  { shape: 'トピック', label: 'トピック', index: 0 },
] as const;

describe('MindmapView never draws the note from before its own write while a slow re-read gives way (LEV-219)', () => {
  for (const { shape, label, index } of SHAPES) {
    it(`F2 rename of ${shape}`, async () => {
      const mounted = await mount();
      const before = mounted.source();
      const watched = await watch(mounted, () => { rename(mounted, label, index, '改名後'); });
      expectNoStaleFrame(watched, before, mounted.source());
      expect(mounted.source()).toContain('改名後');
    });

    it(`Tab (a child added) on ${shape}`, async () => {
      const mounted = await mount();
      const before = mounted.source();
      const watched = await watch(mounted, () => {
        click(nodeNamed(mounted, label, index));
        mounted.key(mounted.canvas, 'Tab');
      });
      expectNoStaleFrame(watched, before, mounted.source());
    });

    for (const redo of [false, true]) {
      it(`${redo ? '⌘⇧Z' : '⌘Z'} of a rename of ${shape}`, async () => {
        const mounted = await mount();
        rename(mounted, label, index, '改名後');
        await settled(mounted);
        if (redo) {
          mounted.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }));
          await settled(mounted);
        }
        const before = mounted.source();
        const watched = await watch(mounted, () => {
          mounted.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: redo, bubbles: true, cancelable: true }));
        });
        expectNoStaleFrame(watched, before, mounted.source());
      });
    }
  }

  for (const { shape, label, index } of SHAPES.filter(item => item.shape !== 'トピック')) {
    // The second 同名 is the body's last item: ⌥↓ would write nothing, so it moves up.
    const arrow = shape.startsWith('同名') ? 'ArrowUp' : 'ArrowDown';
    it(`${arrow === 'ArrowUp' ? '⌥↑' : '⌥↓'} (a key move) of ${shape}`, async () => {
      const mounted = await mount();
      const before = mounted.source();
      const watched = await watch(mounted, () => {
        click(nodeNamed(mounted, label, index));
        mounted.key(mounted.canvas, arrow, { altKey: true });
      });
      expectNoStaleFrame(watched, before, mounted.source());
    });

    it(`${shape} detached onto the canvas`, async () => {
      const mounted = await mount();
      const before = mounted.source();
      const id = idOf(mounted, label, index);
      const detach = (mounted.view as unknown as { detachNode(id: string, point: { x: number; y: number }): Promise<void> }).detachNode.bind(mounted.view);
      const watched = await watch(mounted, () => detach(id, { x: 700, y: 600 }));
      expectNoStaleFrame(watched, before, mounted.source());
    });
  }

  for (const { shape, label, index } of SHAPES.filter(item => item.shape !== 'トピック')) {
    it(`the topic dropped on the slot under ${shape}`, async () => {
      const mounted = await mount();
      const before = mounted.source();
      const topic = projectMap(state(mounted).document as MindDocument).topics.find(node => node.title === 'トピック');
      if (!topic) throw new Error('No topic');
      const parentId = idOf(mounted, label, index);
      const internals = mounted.view as unknown as {
        shiftTopic(id: string, delta: { x: number; y: number } | null): void; executeDrop(command: MoveCommand): Promise<void>;
      };
      internals.shiftTopic(topic.id, { x: 30, y: -40 });
      await frame();
      const watched = await watch(mounted, () => internals.executeDrop({ type: 'move', nodeId: topic.id, parentId, index: 0 }));
      expectNoStaleFrame(watched, before, mounted.source());
      expect(projectMap(state(mounted).document as MindDocument).topics.some(node => node.title === 'トピック')).toBe(false);
    });
  }
});

describe('the maps the items call, shown with a write of the map\'s own before its re-read (LEV-219)', () => {
  // The write is shown before the re-read reads the called maps again, with the maps read for the last draw: an item
  // the write left alone keeps its map, one it renamed to another embed waits for the read rather than show the map
  // its old text called under the new one.
  const MAP_A = '---\nmappy: true\n---\n## 地図A\n- A の枝\n';
  const MAP_B = '---\nmappy: true\n---\n## 地図B\n- B の枝\n';
  const HOST = ['---', 'mappy: true', '---', '## 本体', '', '- ![[map-a]]', '- 子1', ''].join('\n');

  async function mountCalls(): Promise<MountedMapView> {
    const app = new HarnessApp();
    app.put('Fixtures/map-a.md', MAP_A);
    app.put('Fixtures/map-b.md', MAP_B);
    const mounted = await mountMapView(PATH, HOST, 'mindmap', app);
    opened.push(mounted);
    await settled(mounted);
    expect(labels(mounted)).toEqual(expect.arrayContaining(['地図A', 'A の枝']));
    return mounted;
  }

  it('an item the write left alone keeps the map it calls on every frame', async () => {
    const mounted = await mountCalls();
    const before = mounted.source();
    const watched = await watch(mounted, () => { rename(mounted, '子1', 0, '改名後'); });
    expectNoStaleFrame(watched, before, mounted.source());
    const missing = watched.frames.flatMap((shown, index) => shown.labels.includes('A の枝') ? [] : [index]);
    expect(missing).toEqual([]);
  });

  it('an item renamed to another embed never shows the map it called before', async () => {
    const mounted = await mountCalls();
    const before = mounted.source();
    const watched = await watch(mounted, () => { rename(mounted, '地図A', 0, '![[map-b]]'); });
    expectNoStaleFrame(watched, before, mounted.source());
    const old = watched.frames.flatMap((shown, index) => shown.labels.includes('A の枝') ? [index] : []);
    expect(old).toEqual([]);
    expect(labels(mounted)).toEqual(expect.arrayContaining(['地図B', 'B の枝']));
  });
});

describe('the re-read after a write the map already shows (LEV-219, code review 1)', () => {
  // The save shows the text it wrote before its re-read reads it; that re-read then finds the same text, and drawing
  // it again would be one more full redraw of every node per edit on a large map. The watcher's re-read of the write
  // still draws once, as the save's re-read and the watcher's drew twice before LEV-219: one draw by a read in all.
  it('draws it once more, by the watcher\'s re-read only', async () => {
    const mounted = await mount();
    const view = state(mounted);
    let drawnByReads = 0;
    const draw = (mounted.view as unknown as { draw(): void }).draw.bind(mounted.view);
    vi.spyOn(mounted.view as unknown as { draw(): void }, 'draw').mockImplementation(() => {
      if (view.refreshing !== undefined) drawnByReads += 1;
      draw();
    });
    rename(mounted, '子1', 0, '改名後');
    await settled(mounted);
    expect(mounted.source()).toContain('- 改名後\n');
    expect(drawnByReads).toBe(1);
  });
});
