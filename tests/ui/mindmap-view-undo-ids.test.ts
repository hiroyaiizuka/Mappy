// @vitest-environment jsdom
/**
 * Undo／Redo are writes of the map's own (LEV-150, the Undo／Redo half): the fold and the selection name nodes by
 * id, and the re-read after ⌘Z／⌘⇧Z has to carry every id over as the re-read after an edit does (LEV-146). The
 * matrix is what the user did before ⌘Z (an edit of another node, and that edit then a layout button — LEV-206
 * carries the history over the button) × the shape of the folded, selected node (one title, an untitled node, the
 * second of two same-titled nodes, a topic).
 *
 * Before the fix the store's Undo／Redo returned only the text, the re-read had no edits, and a node matched only by
 * its title — the untitled one and the second 同名 — came back with a new id: its branch opened and the selection
 * left it (`artifacts/lev-150-undo-redo-ids/tests-before-fix.log`, the same-length rename rows). The 通常 and トピック
 * rows hold there too; they pin that the carried ids do not move a node matched by its title. The longer rename and
 * the delete move the nodes after them, so only the edits the step really made carry the ids (a wrong set fails them:
 * `mutations-review1.txt`); the two-map row and the refused ⌘Z are from the first code review.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, TFile } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp, parseFrontmatter } from '../../harness/browser/app';
import { Notice } from '../../harness/browser/obsidian';
import { LAYOUT_LABELS } from '../../src/core/layout-mode';
import type { MindDocument } from '../../src/core/markdown';
import { conflictMessage, type DocumentStore } from '../../src/obsidian/document-store';
import { mountMapView, type MountedMapView } from './map-view-mount';
import { accessibleName } from './accessible-name';

vi.mock('obsidian', () => import('../../harness/browser/obsidian'));
beforeAll(() => { installObsidianDom(); });

const opened: MountedMapView[] = [];
afterEach(async () => {
  for (const mounted of opened.splice(0)) await mounted.close();
  document.body.replaceChildren();
  Notice.log.length = 0;
});

const PATH = 'Fixtures/undo-ids.md';
const EMPTY_LABEL = '空のノード';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 履歴', '',
  '- 親', '  - 子1', '  - 子2',
  '- ', '  - 空の子',
  '- ', '  - 空の子2',
  '- 同名', '  - 同名の子A',
  '- 同名', '  - 同名の子B',
  '', '## トピック', '',
  '- 枝', '',
].join('\n');

/** Obsidian's `processFrontMatter` rewrites the header in the note's text (the harness's edits its cache only). */
function rewritingFrontmatter(app: HarnessApp): void {
  app.fileManager.processFrontMatter = async (file, change) => {
    await app.asApp<App>().vault.process(file as unknown as TFile, text => {
      const properties = parseFrontmatter(text) ?? {};
      change(properties);
      const body = text.replace(/^---\n[\s\S]*?\n---\n/u, '');
      return `---\n${Object.entries(properties).map(([key, value]) => `${key}: ${String(value)}`).join('\n')}\n---\n${body}`;
    });
  };
}

async function mount(): Promise<MountedMapView> {
  const app = new HarnessApp();
  rewritingFrontmatter(app);
  const mounted = await mountMapView(PATH, SOURCE, 'mindmap', app);
  opened.push(mounted);
  return mounted;
}

interface ViewState {
  document: MindDocument | undefined; collapsed: Set<string>; selectedId: string | null;
  refreshTimer: number | undefined; refreshing: Promise<void> | undefined; saving: boolean;
}
const state = (mounted: MountedMapView): ViewState => mounted.view as unknown as ViewState;

/** Every write and re-read done, with the map showing what the note holds. */
async function settled(mounted: MountedMapView, reached: (source: string) => boolean): Promise<void> {
  const view = state(mounted);
  await vi.waitFor(() => {
    expect({
      reached: reached(mounted.source()), timer: view.refreshTimer, read: view.refreshing, saving: view.saving,
      current: view.document?.source === mounted.source(),
    }).toEqual({ reached: true, timer: undefined, read: undefined, saving: false, current: true });
  }, { timeout: 2000, interval: 5 });
  await mounted.settle();
}

/** The `index`-th node on screen with this label (an untitled node reads as 空のノード). */
function nodeNamed(mounted: MountedMapView, label: string, index = 0): HTMLElement {
  const found = Array.from(mounted.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node')).filter(node => accessibleName(node) === label)[index];
  if (!found) throw new Error(`No node ${label} #${index}`);
  return found;
}

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/** ⌘Z, or ⌘⇧Z, on the canvas. */
async function history(mounted: MountedMapView, redo: boolean, reached: (source: string) => boolean): Promise<void> {
  mounted.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: redo, bubbles: true, cancelable: true }));
  await settled(mounted, reached);
}

/** 子1 renamed with F2 to `title`: the step ⌘Z takes back. */
async function rename(mounted: MountedMapView, title: string): Promise<void> {
  click(nodeNamed(mounted, '子1'));
  mounted.key(mounted.canvas, 'F2');
  const editor = mounted.editor();
  if (!editor) throw new Error('F2 opened no editor');
  editor.value = title;
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  mounted.key(editor, 'Enter');
  await settled(mounted, source => source.includes(`- ${title}\n`));
}

/**
 * The step ⌘Z takes back, above every folded node: a rename that keeps the length (no node moves), one that makes
 * the title longer and a delete (every node after it moves), so the edits Undo／Redo hand the view are the ones that
 * move the nodes' places — a wrong set would carry the ids to other nodes or to none.
 */
const EDITS = [
  { edit: 'a rename of the same length', run: (mounted: MountedMapView) => rename(mounted, '改名'), done: '  - 改名\n' },
  { edit: 'a longer rename', run: (mounted: MountedMapView) => rename(mounted, 'ずっと長い題名に改名'), done: '  - ずっと長い題名に改名\n' },
  {
    edit: 'a delete', done: null,
    run: async (mounted: MountedMapView) => {
      click(nodeNamed(mounted, '子1'));
      mounted.key(mounted.canvas, 'Delete');
      await settled(mounted, source => !source.includes('- 子1\n'));
    },
  },
] as const;

/** The note holds what `edit` wrote (`done`), or, for the delete, no 子1. */
const edited = (done: string | null) => (source: string): boolean => done === null ? !source.includes('  - 子1\n') : source.includes(done);

const SHAPES = [
  { shape: '通常', label: '親', index: 0 },
  { shape: '空題名 (the second)', label: EMPTY_LABEL, index: 1 },
  { shape: '同名 (the second)', label: '同名', index: 1 },
  { shape: 'トピック', label: 'トピック', index: 0 },
] as const;

const BEFORE = [
  { before: 'with no layout button', layout: false },
  { before: 'then a layout button', layout: true },
] as const;

/** Select `label`'s `index`-th node and fold it with its toggle; returns its id. */
async function foldAndSelect(mounted: MountedMapView, label: string, index: number): Promise<string> {
  const element = nodeNamed(mounted, label, index);
  click(element);
  const id = element.dataset.nodeId ?? '';
  const toggle = element.querySelector<HTMLElement>('.mappy-node-toggle');
  if (!toggle) throw new Error('No toggle');
  click(toggle);
  await mounted.settle();
  const view = state(mounted);
  expect({ collapsed: [...view.collapsed], selected: view.selectedId }).toEqual({ collapsed: [id], selected: id });
  return id;
}

function expectKept(mounted: MountedMapView, label: string, index: number, id: string): void {
  const view = state(mounted);
  expect({ collapsed: [...view.collapsed], selected: view.selectedId, id: nodeNamed(mounted, label, index).dataset.nodeId })
    .toEqual({ collapsed: [id], selected: id, id });
}

describe('the fold and the selection through Undo／Redo (LEV-150, the Undo／Redo half)', () => {
  it.each(EDITS.flatMap(edit => BEFORE.flatMap(before => SHAPES.map(shape => ({ ...edit, ...before, ...shape })))))(
    '$edit, $before, then ⌘Z and ⌘⇧Z: a folded, selected $shape node stays folded and selected', async ({ run, done, layout, label, index }) => {
      const mounted = await mount();
      await run(mounted);
      if (layout) {
        const button = mounted.view.containerEl.querySelector<HTMLButtonElement>(`.mappy-modes button[aria-label="${LAYOUT_LABELS.timeline}"]`);
        if (!button) throw new Error('No layout button');
        button.click();
        await settled(mounted, source => source.includes('mappy-layout: timeline\n'));
      }
      const id = await foldAndSelect(mounted, label, index);

      await history(mounted, false, source => source.includes('  - 子1\n'));
      expectKept(mounted, label, index, id);

      await history(mounted, true, edited(done));
      expectKept(mounted, label, index, id);
      if (layout) expect(mounted.source()).toContain('mappy-layout: timeline\n');
      expect(Notice.log).toEqual([]);
    });

  it('⌘Z in one map keeps the fold and the selection of another map of the note (the history is shared)', async () => {
    const first = await mount();
    const store = (first.view as unknown as { store: DocumentStore }).store;
    const second = await mountMapView(PATH, SOURCE, 'mindmap', first.app, { store });
    opened.push(second);
    await rename(first, 'ずっと長い題名に改名');
    await settled(second, source => source.includes('ずっと長い題名に改名'));
    const id = await foldAndSelect(second, EMPTY_LABEL, 1);
    await history(first, false, source => source.includes('  - 子1\n'));
    await settled(second, source => source.includes('  - 子1\n'));
    expectKept(second, EMPTY_LABEL, 1, id);
    expect(Notice.log).toEqual([]);
  });

  it.each([
    { action: 'a longer rename', run: (mounted: MountedMapView) => rename(mounted, 'ずっと長い題名に改名'), reached: (source: string) => source.includes('ずっと長い題名に改名') },
    {
      action: 'a layout button', reached: (source: string) => source.includes('mappy-layout: timeline\n'),
      run: async (mounted: MountedMapView) => {
        mounted.view.containerEl.querySelector<HTMLButtonElement>(`.mappy-modes button[aria-label="${LAYOUT_LABELS.timeline}"]`)?.click();
        await settled(mounted, source => source.includes('mappy-layout: timeline\n'));
      },
    },
  ])('$action in one map keeps the fold and the selection of another map of the note (code review 2)', async ({ run, reached }) => {
    // Every write the store makes reaches every map of the note with its edits, not only the history's steps.
    const first = await mount();
    const store = (first.view as unknown as { store: DocumentStore }).store;
    const second = await mountMapView(PATH, SOURCE, 'mindmap', first.app, { store });
    opened.push(second);
    const id = await foldAndSelect(second, '同名', 1);
    await run(first);
    await settled(second, reached);
    expectKept(second, '同名', 1, id);
    expect(Notice.log).toEqual([]);
  });

  it('Escape on a node just added in one map keeps the fold and the selection of another map (retract)', async () => {
    // Code review 2: taking the addition back is a step of the shared history too (LEV-203's `retract`).
    const first = await mount();
    const store = (first.view as unknown as { store: DocumentStore }).store;
    const second = await mountMapView(PATH, SOURCE, 'mindmap', first.app, { store });
    opened.push(second);
    const id = await foldAndSelect(second, '同名', 1);
    click(nodeNamed(first, '子1'));
    first.key(first.canvas, 'Tab');
    await settled(first, source => source.includes('サブトピック'));
    await settled(second, source => source.includes('サブトピック'));
    const input = first.editor();
    if (!input) throw new Error('Tab opened no editor');
    first.key(input, 'Escape');
    await settled(first, source => source === SOURCE);
    await settled(second, source => source === SOURCE);
    expectKept(second, '同名', 1, id);
    expect(Notice.log).toEqual([]);
  });

  it('⌘Z, ⌘⇧Z, ⌘Z before the other map re-reads, then an edit there: its fold and selection stay', async () => {
    // Code review 2: the three steps write the same texts twice; each is recorded in order, none matched to an earlier one.
    const first = await mount();
    const store = (first.view as unknown as { store: DocumentStore }).store;
    const second = await mountMapView(PATH, SOURCE, 'mindmap', first.app, { store });
    opened.push(second);
    await rename(first, 'ずっと長い題名に改名');
    await settled(second, source => source.includes('ずっと長い題名に改名'));
    const id = await foldAndSelect(second, EMPTY_LABEL, 1);
    await store.undo(first.file);
    await store.redo(first.file);
    await store.undo(first.file);
    await settled(second, source => source.includes('  - 子1\n'));
    expectKept(second, EMPTY_LABEL, 1, id);
    // The rename selects 子1 (the click that starts F2); the fold and the node's id are what must stay.
    await rename(second, '別のもっと長い題名');
    expect({ collapsed: [...state(second).collapsed], id: nodeNamed(second, EMPTY_LABEL, 1).dataset.nodeId }).toEqual({ collapsed: [id], id });
    expect(Notice.log).toEqual([]);
  });

  it('a refused ⌘Z re-reads the note even when no watcher reports the change', async () => {
    // Not about the ids: the one own write of the view that did not re-read on a refusal (as `writeOwn` does).
    const mounted = await mount();
    await rename(mounted, '改名');
    const entries = (mounted.app as unknown as { entries: Map<string, { content: string }> }).entries;
    const entry = entries.get(PATH);
    if (!entry) throw new Error('No note');
    entry.content = entry.content.replace('- 子2\n', '- 外から\n');
    mounted.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }));
    await settled(mounted, () => true);
    expect(Notice.log).toContain(conflictMessage);
    expect(state(mounted).document?.source).toContain('- 外から\n');
  });

  it('an external change after the edit still drops the history, and a same-titled node is not guessed (E05)', async () => {
    // Not a regression test of the bug: it pins what the fix must not do — take someone else's change for the map's own.
    const mounted = await mount();
    await rename(mounted, '改名');
    const id = nodeNamed(mounted, EMPTY_LABEL, 1).dataset.nodeId ?? '';
    await mounted.app.asApp<App>().vault.process(mounted.file, text => text.replace('- 子2\n', '- 外から\n'));
    await settled(mounted, source => source.includes('- 外から\n'));
    expect(nodeNamed(mounted, EMPTY_LABEL, 1).dataset.nodeId).not.toBe(id);
    const after = nodeNamed(mounted, EMPTY_LABEL, 1).dataset.nodeId;
    mounted.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }));
    // The store's queue has taken the ⌘Z (a read waits behind it) before the map is looked at.
    await (mounted.view as unknown as { store: DocumentStore }).store.read(mounted.file);
    await settled(mounted, () => true);
    expect(mounted.source()).toContain('- 改名\n');
    expect(nodeNamed(mounted, EMPTY_LABEL, 1).dataset.nodeId).toBe(after);
  });
});
