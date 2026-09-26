// @vitest-environment jsdom
/**
 * The layout buttons write the note's `mappy-layout` (LEV-196), and the user acts at the same moment: the matrix
 * is what the user does right after the button × the node it lands on.
 *
 * Written through `processFrontMatter` (before), the key changed the note beside the map's own save path, and
 * `document.source` stayed on the text before it until the watcher's re-read: an edit planned in between was
 * refused as someone else's change (「Markdown が変更されています」), and the re-read, having no edits to carry
 * ids, dropped the fold and the selection of a node whose title repeats or is empty (LEV-150's layout half). The
 * harness's own `processFrontMatter` edits its metadata cache only, so every row here swaps in one that rewrites
 * the header in the text, as Obsidian's does (`vault.process`); the fixed view does not call it at all.
 *
 * `scripts/e2e/layout-switch.mjs` runs the draft, key and fold rows on the real Obsidian; the drop rows are here only
 * (a mouse cannot reach the button during a drag, and CDP's touch does not start the map's drag on desktop).
 *
 * With the view from before LEV-196, every row fails but two (`artifacts/lev-196-layout-switch/tests-reverted.log`):
 * the external change (E05) and the note that is not a map. Those two are not regression tests of the bug; they pin
 * what the fix must not do — carry an edit over someone else's change, or give a note that is not a map a layout.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, TFile } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp, parseFrontmatter } from '../../harness/browser/app';
import { Notice } from '../../harness/browser/obsidian';
import { LAYOUT_LABELS, type LayoutMode } from '../../src/core/layout-mode';
import { readTopicPositions } from '../../src/core/topics';
import { projectMap, type MindDocument } from '../../src/core/markdown';
import { conflictMessage } from '../../src/obsidian/document-store';
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

const PATH = 'Fixtures/layout-write.md';
const EMPTY_LABEL = '空のノード';
const HEADER = ['---', 'mappy: true', '---'];
const SOURCE = [
  ...HEADER,
  '## 切替', '',
  '- 親', '  - 子1',
  '- ', '  - 空の子',
  '- ', '  - 空の子2',
  '- 同名', '  - 同名の子A',
  '- 同名', '  - 同名の子B',
  '', '## トピック', '',
  '- 枝', '',
].join('\n');

/** Obsidian's `processFrontMatter`: the header is rewritten in the note's text, and the watcher reports the change. */
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

async function mount(source = SOURCE): Promise<MountedMapView> {
  const app = new HarnessApp();
  rewritingFrontmatter(app);
  const mounted = await mountMapView(PATH, source, 'mindmap', app);
  opened.push(mounted);
  return mounted;
}

function documentOf(mounted: MountedMapView): MindDocument {
  const document = (mounted.view as unknown as { document: MindDocument | undefined }).document;
  if (!document) throw new Error('No document');
  return document;
}

/** The button a click on which runs `selectMode`, found by its label as the user finds it. */
function clickLayout(mounted: MountedMapView, mode: LayoutMode): void {
  const button = mounted.view.containerEl.querySelector<HTMLButtonElement>(`.mappy-modes button[aria-label="${LAYOUT_LABELS[mode]}"]`);
  if (!button) throw new Error(`No button for ${mode}`);
  button.click();
}

/**
 * Every write and re-read done: `reached` holds for the note (the button's line, the edit's text), the map shows
 * what the note holds, and no refresh is waiting. The writes start a task or more after the click or the key, so
 * without `reached` the first look can come before any of them and pass on the map from before.
 */
async function settled(mounted: MountedMapView, reached: (source: string) => boolean): Promise<void> {
  const view = mounted.view as unknown as { refreshTimer: number | undefined; refreshing: Promise<void> | undefined; saving: boolean };
  await vi.waitFor(() => {
    expect({
      reached: reached(mounted.source()), timer: view.refreshTimer, read: view.refreshing, saving: view.saving,
      current: documentOf(mounted).source === mounted.source(),
    }).toEqual({ reached: true, timer: undefined, read: undefined, saving: false, current: true });
  }, { timeout: 2000, interval: 5 });
  await mounted.settle();
}

/**
 * The next task, where a key or a finger's release after the click on a button arrives on the real Obsidian: by then
 * the button's write is queued in the store, so the edit is queued behind it and planned on the text before it —
 * the edit the store has to carry over it. (Sent in the click's own task, the edit is queued first and never meets
 * the button's write; the draft rows are that order, since the blur comes before the click.)
 */
const nextTask = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0); });

/** The note asks for `mode`. */
const asks = (mode: LayoutMode) => (source: string): boolean => source.includes(`mappy-layout: ${mode}\n`);

/** The `index`-th node on screen with this label (an untitled node reads as 空のノード). */
function nodeNamed(mounted: MountedMapView, label: string, index = 0): HTMLElement {
  const found = Array.from(mounted.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node')).filter(node => accessibleName(node) === label)[index];
  if (!found) throw new Error(`No node ${label} #${index}`);
  return found;
}

function selectNode(mounted: MountedMapView, label: string, index = 0): HTMLElement {
  const element = nodeNamed(mounted, label, index);
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return element;
}

function refusals(): string[] {
  return Notice.log.filter(message => message === conflictMessage || message.includes('保存処理'));
}

const SHAPES = [
  { name: '通常', label: '子1' },
  { name: '空題名', label: EMPTY_LABEL },
  { name: 'トピック', label: 'トピック' },
] as const;

describe('an edit started right after a layout button, before the re-read (LEV-196)', () => {
  it.each(SHAPES.flatMap(shape => (['Enter', 'Tab', 'Delete'] as const).map(key => ({ ...shape, key }))))(
    '$key on the $name node is saved, and the layout with it', async ({ label, key }) => {
      const mounted = await mount();
      selectNode(mounted, label);
      clickLayout(mounted, 'timeline');
      await nextTask();
      const before = mounted.source();
      mounted.key(mounted.canvas, key);
      await settled(mounted, asks('timeline'));
      expect(refusals()).toEqual([]);
      expect(mounted.source()).toContain('mappy-layout: timeline\n');
      // The key's own edit reached the note too: more than the layout line changed.
      expect(mounted.source()).not.toBe(before.includes('mappy-layout') ? before : before.replace('mappy: true\n', 'mappy: true\nmappy-layout: timeline\n'));
    });

  it.each(SHAPES)('F2 on the $name node, confirmed with Enter, is saved', async ({ label }) => {
    const mounted = await mount();
    selectNode(mounted, label);
    clickLayout(mounted, 'hierarchy');
    await nextTask();
    mounted.key(mounted.canvas, 'F2');
    const editor = mounted.editor();
    if (!editor) throw new Error('F2 opened no editor');
    editor.value = '改名';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    mounted.key(editor, 'Enter');
    await settled(mounted, source => asks('hierarchy')(source) && source.includes('改名'));
    expect(refusals()).toEqual([]);
    expect(mounted.view.containerEl.querySelector('.mappy-inline-error')?.textContent ?? '').toBe('');
    expect(mounted.editor()).toBeNull();
    expect(mounted.source()).toContain('改名');
    expect(mounted.source()).toContain('mappy-layout: hierarchy\n');
  });

  it.each(SHAPES)('a draft on the $name node saved by the blur of the click on the button is saved, and the layout with it', async ({ label }) => {
    // The press on the button takes the focus from the draft (its blur saves it) before the click selects the layout.
    const mounted = await mount();
    selectNode(mounted, label);
    mounted.key(mounted.canvas, 'F2');
    const editor = mounted.editor();
    if (!editor) throw new Error('F2 opened no editor');
    editor.value = '改名';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.blur();
    clickLayout(mounted, 'balanced');
    await settled(mounted, source => asks('balanced')(source) && source.includes('改名'));
    expect(mounted.view.containerEl.querySelector('.mappy-inline-error')?.textContent ?? '').toBe('');
    expect(mounted.editor()).toBeNull();
    expect(mounted.source()).toContain('改名');
    expect(mounted.source()).toContain('mappy-layout: balanced\n');
  });

  it.each([
    { name: 'トピック', body: false },
    { name: '本体', body: true },
  ])('a drag of the $name released right after the button keeps the position it was dropped at', async ({ body }) => {
    // LEV-182's touch: one finger carries the tree, another taps the button, the first lets go.
    const mounted = await mount();
    const view = mounted.view as unknown as {
      shiftTopic(id: string, delta: { x: number; y: number } | null): void;
      placeTopic(id: string, delta: { x: number; y: number }): Promise<void>;
    };
    const { root, topics } = projectMap(documentOf(mounted));
    const id = body ? root.id : topics.find(node => node.title === 'トピック')?.id;
    if (!id) throw new Error('No tree to drag');
    view.shiftTopic(id, { x: 40, y: 30 });
    clickLayout(mounted, 'timeline');
    await nextTask();
    await view.placeTopic(id, { x: 80, y: 60 });
    await settled(mounted, asks('timeline'));
    expect(refusals()).toEqual([]);
    expect(mounted.source()).toContain('mappy-layout: timeline\n');
    expect(readTopicPositions(mounted.source()).get('トピック')?.timeline).toBeDefined();
  });

  // Pins the outcome of two presses around one edit, not which of them lands first: here the edit's write is queued
  // before the second button's (which then plans on it), so `commit` waiting for the second press as well is not
  // what this row exercises; it fails on the view from before LEV-196 like the rows above.
  it('a second button pressed while the edit waits for the first is saved with the edit', async () => {
    const mounted = await mount();
    selectNode(mounted, '子1');
    clickLayout(mounted, 'timeline');
    await nextTask();
    mounted.key(mounted.canvas, 'Delete');
    clickLayout(mounted, 'hierarchy');
    await settled(mounted, source => asks('hierarchy')(source) && !source.includes('子1'));
    expect(refusals()).toEqual([]);
  });

  it('Undo after the button and an edit takes back the edit only; the layout stays', async () => {
    const mounted = await mount();
    selectNode(mounted, '子1');
    clickLayout(mounted, 'timeline');
    // Queued after the edit, the button's write would drop the edit's step with the rest of the history (LEV-206).
    await nextTask();
    mounted.key(mounted.canvas, 'Delete');
    await settled(mounted, source => asks('timeline')(source) && !source.includes('子1'));
    mounted.key(mounted.canvas, 'z', { metaKey: true });
    await settled(mounted, source => source.includes('子1'));
    expect(mounted.source()).toBe(SOURCE.replace('mappy: true\n', 'mappy: true\nmappy-layout: timeline\n'));
  });

  it('an external change between the button and the edit is still refused (E05)', async () => {
    const mounted = await mount();
    selectNode(mounted, '子1');
    clickLayout(mounted, 'timeline');
    // The button's write has landed, its re-read has not: the map still shows the text before both.
    await vi.waitFor(() => { expect(mounted.source()).toContain('mappy-layout: timeline\n'); });
    const external = `${mounted.source()}- 外から\n`;
    mounted.app.put(PATH, external);
    mounted.key(mounted.canvas, 'Delete');
    await settled(mounted, source => source === external);
    await vi.waitFor(() => { expect(Notice.log).toContain(conflictMessage); });
    expect(mounted.source()).toBe(external);
  });

  it('an image pasted right after the button is linked, not refused as someone else\'s change', async () => {
    const mounted = await mount();
    selectNode(mounted, '子1');
    clickLayout(mounted, 'timeline');
    await nextTask();
    const image = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { files: [image] } });
    mounted.canvas.dispatchEvent(paste);
    await settled(mounted, source => asks('timeline')(source) && source.includes('shot.png'));
    expect(Notice.log).toEqual([]);
  });

  // Pins the outcome, not the guard in `overLayoutWrites` that drops a round trip: a body edit carried over the line
  // inserted and then removed lands where it was planned either way, so this row also passes without that guard.
  it('a button pressed and then taken back (to the text before it) carries nothing: an edit right after is saved', async () => {
    const mounted = await mount();
    selectNode(mounted, '子1');
    clickLayout(mounted, 'timeline');
    clickLayout(mounted, 'mindmap');
    await nextTask();
    mounted.key(mounted.canvas, 'Delete');
    await settled(mounted, source => !source.includes('子1'));
    expect(refusals()).toEqual([]);
    expect(mounted.source()).toBe(SOURCE.replace('  - 子1\n', ''));
  });

  it('a spent button write is not carried again once the note is back at the text before it (an editor Undo)', async () => {
    // The button and an edit right after it: the edit is carried over the button's write. The note then goes back
    // to exactly the text before both. An edit there is planned on that text and applies to it as it stands.
    const mounted = await mount();
    selectNode(mounted, '子1');
    clickLayout(mounted, 'timeline');
    await nextTask();
    mounted.key(mounted.canvas, 'Delete');
    await settled(mounted, source => asks('timeline')(source) && !source.includes('子1'));
    mounted.app.put(PATH, SOURCE);
    await settled(mounted, source => source === SOURCE);
    selectNode(mounted, '親');
    mounted.key(mounted.canvas, 'Tab');
    await settled(mounted, source => source !== SOURCE);
    expect(refusals()).toEqual([]);
  });

  it('a note that is not a map gets no layout from the button, and a drop right after it is saved as usual', async () => {
    // The button records a preference of a map (`planMapLayout`): with no `mappy: true` it writes nothing, so a
    // topic's first position, which creates the header, has nothing to be carried over.
    const bare = SOURCE.split('\n').slice(HEADER.length).join('\n');
    const mounted = await mount(bare);
    const view = mounted.view as unknown as {
      shiftTopic(id: string, delta: { x: number; y: number } | null): void;
      placeTopic(id: string, delta: { x: number; y: number }): Promise<void>;
    };
    const topic = documentOf(mounted).nodes.find(node => node.title === 'トピック');
    if (!topic) throw new Error('No topic');
    view.shiftTopic(topic.id, { x: 40, y: 30 });
    clickLayout(mounted, 'timeline');
    await view.placeTopic(topic.id, { x: 80, y: 60 });
    await settled(mounted, source => readTopicPositions(source).get('トピック')?.timeline !== undefined);
    expect(refusals()).toEqual([]);
    expect(mounted.source()).not.toContain('mappy-layout');
    expect(mounted.source().split('\n').filter(line => line === '---')).toHaveLength(2);
  });

  it('an image whose reading outlasts the re-read of the button\'s write is still linked', async () => {
    // The store keeps the button's write to carry the link over until the next edit, whatever the view re-reads
    // in between; the view's own record of it (spent by that re-read) is not what the check asks.
    const mounted = await mount();
    selectNode(mounted, '子1');
    clickLayout(mounted, 'timeline');
    await nextTask();
    const image = new File([new Uint8Array([1, 2, 3])], 'slow.png', { type: 'image/png' });
    const bytes = image.arrayBuffer.bind(image);
    let reread = false;
    Object.defineProperty(image, 'arrayBuffer', { value: async () => {
      await settled(mounted, asks('timeline'));
      reread = true;
      return bytes();
    } });
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { files: [image] } });
    mounted.canvas.dispatchEvent(paste);
    await settled(mounted, source => source.includes('slow.png'));
    expect(reread).toBe(true);
    expect(Notice.log).toEqual([]);
  });
});

describe('the fold and the selection through a layout button (LEV-150, the layout half)', () => {
  it.each([
    { name: '同名 (the second)', label: '同名', index: 1 },
    { name: '空題名 (the second)', label: EMPTY_LABEL, index: 1 },
  ])('a folded, selected $name node stays folded and selected', async ({ label, index }) => {
    const mounted = await mount();
    const element = selectNode(mounted, label, index);
    const id = element.dataset.nodeId ?? '';
    const toggle = element.querySelector<HTMLElement>('.mappy-node-toggle');
    if (!toggle) throw new Error('No toggle');
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await mounted.settle();
    const view = mounted.view as unknown as { collapsed: Set<string>; selectedId: string | null };
    expect([...view.collapsed]).toEqual([id]);
    const shown = Array.from(mounted.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node'), accessibleName).sort();
    clickLayout(mounted, 'balanced');
    await settled(mounted, asks('balanced'));
    const after = nodeNamed(mounted, label, index).dataset.nodeId;
    expect([...view.collapsed]).toEqual([after]);
    expect(view.selectedId).toBe(after);
    expect(Array.from(mounted.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node'), accessibleName).sort()).toEqual(shown);
  });
});
