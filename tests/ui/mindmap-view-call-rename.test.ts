// @vitest-environment jsdom
/**
 * A map called from an item of another map (§5 M12, `CallReader`) keeps its ids, and with them the folds the reader
 * set on the called branches in the calling map, when the called note is renamed or moved, and when it cannot be read
 * or stops being a map for a while and comes back (LEV-246). Before the fix the reader held its parses by path, so a
 * rename parsed the note under its new path with no previous parse, and a failed read threw the previous parse away:
 * every called node took a new id and the branch the reader opened closed again, whatever its shape.
 *
 * The matrix is what happens to the called note (renamed with the link in the calling note updated before or after
 * the calling map read the calls again, moved to another folder, unreadable for a read, not a map by its saved text,
 * not a map by its text while the cache still says map) × the shape of the called node the reader toggled (one title,
 * the second untitled node, the second of two same-titled nodes, a branch under a called topic).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { installObsidianDom } from '../browser-harness/dom';
import { HarnessApp } from '../browser-harness/app';
import type { CallTargets } from '../../src/core/calls';
import type { DocumentStore } from '../../src/obsidian/document-store';
import { mountMapView, type MountedMapView } from './map-view-mount';
import { closeOpenViews } from '../mocks/open-views';
import { accessibleName } from './accessible-name';

vi.mock('obsidian', () => import('../browser-harness/obsidian'));
beforeAll(() => { installObsidianDom(); });

const PATH = 'Fixtures/undo-ids.md';
const HOST = 'Fixtures/caller.md';
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
  '- 枝', '  - 枝の子', '',
].join('\n');
/** The calling note's items: the whole called map under one, its free topic under another (by default). */
type Calls = readonly ((name: string) => string)[];
const WHOLE_AND_TOPIC: Calls = [name => `![[${name}]]`, name => `![[${name}#トピック]]`];
/** How many of the items call a map (an item that only mentions the note is a link). */
const callCount = (calls: Calls): number => calls.filter(call => call('x').startsWith('![[')).length;
const hostSource = (name: string, calls: Calls = WHOLE_AND_TOPIC): string =>
  `---\nmappy: true\n---\n## 呼び出し元\n${calls.map(call => `- ${call(name)}\n`).join('')}`;

afterEach(async () => {
  await closeOpenViews();
  document.body.replaceChildren();
});

interface ViewState { refreshTimer: number | undefined; recallTimer: number | undefined; refreshing: Promise<void> | undefined; targets: CallTargets }

/** The calling note open in a map tab, the called note in the vault only. */
async function open(calls: Calls = WHOLE_AND_TOPIC): Promise<MountedMapView> {
  const app = new HarnessApp();
  app.put(PATH, SOURCE);
  const host = await mountMapView(HOST, hostSource('undo-ids', calls), 'mindmap', app);
  await settled(host, callCount(calls));
  return host;
}

/** No read pending in the calling map, and it draws `calls` called maps. */
async function settled(host: MountedMapView, calls: number): Promise<void> {
  const view = host.view as unknown as ViewState;
  await vi.waitFor(() => {
    expect({ timer: view.refreshTimer, recall: view.recallTimer, read: view.refreshing, calls: view.targets.size })
      .toEqual({ timer: undefined, recall: undefined, read: undefined, calls });
  }, { timeout: 2000, interval: 5 });
  await host.settle();
}

function nodeNamed(root: ParentNode, label: string, index = 0): HTMLElement {
  const found = Array.from(root.querySelectorAll<HTMLElement>('.mappy-node')).filter(node => accessibleName(node) === label)[index];
  if (!found) throw new Error(`No node ${label} #${index}`);
  return found;
}

function seen(host: MountedMapView, label: string, index: number): { id: string | undefined; folded: boolean } {
  const node = nodeNamed(host.view.containerEl, label, index);
  return { id: node.dataset.nodeId, folded: node.hasClass('is-collapsed') };
}

/** The reader opens the `index`-th called `label` in the calling map (every called branch starts folded). */
async function unfold(host: MountedMapView, label: string, index: number): Promise<{ id: string | undefined; folded: boolean }> {
  const before = seen(host, label, index);
  expect(before.folded).toBe(true);
  const button = nodeNamed(host.view.containerEl, label, index).querySelector<HTMLElement>('.mappy-node-toggle');
  if (!button) throw new Error(`${label} #${index} has no toggle`);
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await host.settle();
  const after = seen(host, label, index);
  expect(after).toEqual({ id: before.id, folded: false });
  return after;
}

const SHAPES = [
  { shape: '通常', label: '親', index: 0 },
  { shape: '空題名 (the second)', label: EMPTY_LABEL, index: 1 },
  { shape: '同名 (the second)', label: '同名', index: 1 },
  { shape: 'トピック (a branch under the called topic)', label: '枝', index: 0 },
] as const;

/** Obsidian's link update after a rename: the calling note's links rewritten in its file. */
async function relink(host: MountedMapView, name: string, calls: Calls): Promise<void> {
  await host.app.asApp<App>().vault.process(host.file, () => hostSource(name, calls));
}

const OPERATIONS: { operation: string; run: (host: MountedMapView, calls: Calls) => Promise<void> }[] = [
  {
    // The link is rewritten in the tick of the rename, within one debounce; the read of the calls the rename asked for
    // still runs first, on the old link, and draws the items as links for a moment (as in the row below).
    operation: 'renamed, the link updated at once',
    run: async (host, calls) => {
      host.app.rename(PATH, 'Fixtures/改名後.md');
      await relink(host, '改名後', calls);
      await settled(host, callCount(calls));
    },
  },
  {
    // The calling map reads its calls in between, finds the old link unresolved and draws the items as links.
    operation: 'renamed, the link updated after the calling map drew the items as links',
    run: async (host, calls) => {
      host.app.rename(PATH, 'Fixtures/改名後.md');
      await settled(host, 0);
      await relink(host, '改名後', calls);
      await settled(host, callCount(calls));
    },
  },
  {
    // The link resolves by the note's name, which a move keeps: the calling note is not rewritten.
    operation: 'moved to another folder',
    run: async host => {
      host.app.rename(PATH, 'Elsewhere/undo-ids.md');
      await settled(host, 2);
    },
  },
  {
    operation: 'unreadable for a read, then read again',
    run: async host => {
      const store = (host.view as unknown as { store: DocumentStore }).store;
      const read = store.read.bind(store);
      const spy = vi.spyOn(store, 'read').mockImplementation(file => file.path === PATH ? Promise.reject(new Error('busy')) : read(file));
      const file = host.app.asApp<App>().vault.getAbstractFileByPath(PATH);
      host.app.vaultEvents.trigger('modify', file);
      await settled(host, 0);
      spy.mockRestore();
      host.app.vaultEvents.trigger('modify', file);
      await settled(host, 2);
    },
  },
  {
    operation: 'not a map by its saved text, then a map again',
    run: async host => {
      host.app.put(PATH, SOURCE.replace('mappy: true\n', ''));
      await settled(host, 0);
      host.app.put(PATH, SOURCE);
      await settled(host, 2);
    },
  },
  {
    // The cache still says map (an unsaved edit in the header that broke `mappy: true`), the text does not.
    operation: 'not a map by its text while the cache says map, then a map again',
    run: async host => {
      host.app.put(PATH, SOURCE.replace('mappy: true', 'mappy: "true"'));
      await settled(host, 0);
      host.app.put(PATH, SOURCE);
      await settled(host, 2);
    },
  },
];

const MATRIX = OPERATIONS.flatMap(({ operation, run }) => SHAPES.map(shape => ({ operation, run, ...shape })));

/**
 * The calling note's shape, for the renames (the only operation that rewrites the calling note): the link update
 * rewrites every item calling the renamed note at once. One item alone was matched before the fix too (the single
 * title-only edit); two items, or two items with the same title, are matched by nothing but their place.
 */
const HOSTS = [
  { host: 'one item calling the whole map', calls: [(name: string) => `![[${name}]]`] as Calls },
  { host: 'two items calling the same whole map', calls: [(name: string) => `![[${name}]]`, (name: string) => `![[${name}]]`] as Calls },
  {
    host: 'two items calling the same whole map and one linking to it',
    calls: [(name: string) => `![[${name}]]`, (name: string) => `![[${name}]]`, (name: string) => `参照 [[${name}]]`] as Calls,
  },
] as const;
const RENAMES = OPERATIONS.slice(0, 2).flatMap(({ operation, run }) => HOSTS.flatMap(({ host, calls }) =>
  SHAPES.filter(({ label }) => label !== '枝').map(shape => ({ operation, run, host, calls, ...shape }))));

describe('the calling map\'s folds through a rename, a move or a failed read of the called note (LEV-246)', () => {
  it.each(MATRIX)('$operation: the $shape node the reader opened keeps its id and stays open', async ({ run, label, index }) => {
    const host = await open();
    const opened = await unfold(host, label, index);
    await run(host, WHOLE_AND_TOPIC);
    expect(seen(host, label, index)).toEqual(opened);
  });

  it.each(RENAMES)('$operation, $host: the $shape node the reader opened keeps its id and stays open', async ({ run, calls, label, index }) => {
    const host = await open(calls);
    const opened = await unfold(host, label, index);
    await run(host, calls);
    expect(seen(host, label, index)).toEqual(opened);
  });
});
