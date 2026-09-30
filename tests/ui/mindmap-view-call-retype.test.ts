// @vitest-environment jsdom
/**
 * A map called from an item of another map (§5 M12) keeps its ids, and with them the folds the reader set on the called
 * branches in the calling map, when the calling item's own link is broken for a while on the Markdown side and put back
 * (LEV-260). Before the fix the calling map let go of the called note's parse the moment no item called a map
 * (`CallReader.clear`), and pruned the folds of an item that no longer read `![[…]]` (`CallReader.waiting` saw only those):
 * the link typed back parsed the note anew, every called node took a new id, and the branch the reader opened closed.
 *
 * The matrix is what the reader does to the calling item's text on the Markdown side (a `]` deleted and typed again, the
 * `!` deleted and typed again, the whole title deleted and put back with Undo, the name typed again through a prefix no
 * note has, an alias typed in, the link pointed at another map for a while, the heading part typed again, the name typed
 * back through maps whose names begin it) × the calling note's shape (one item, two
 * items calling the two parts of one note, two items calling different notes) × the shape of the called node the reader
 * toggled (one title, the second untitled node, the second of two same-titled nodes, a branch under a called topic).
 * Two items with the same title are the limit (the last test): the Markdown side's edit renumbers the calling item itself.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { installObsidianDom } from '../browser-harness/dom';
import { HarnessApp } from '../browser-harness/app';
import type { CallTargets } from '../../src/core/calls';
import { mountMapView, type MountedMapView } from './map-view-mount';
import { closeOpenViews } from '../mocks/open-views';
import { accessibleName } from './accessible-name';

vi.mock('obsidian', () => import('../browser-harness/obsidian'));
beforeAll(() => { installObsidianDom(); });

const PATH = 'Fixtures/undo-ids.md';
const OTHER = 'Fixtures/other.md';
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
const OTHER_SOURCE = ['---', 'mappy: true', '---', '## 別のマップ', '', '- 別の枝', '  - 別の子', ''].join('\n');

afterEach(async () => {
  await closeOpenViews();
  document.body.replaceChildren();
});

interface ViewState { refreshTimer: number | undefined; recallTimer: number | undefined; refreshing: Promise<void> | undefined; targets: CallTargets }

const hostSource = (items: readonly string[]): string =>
  `---\nmappy: true\n---\n## 呼び出し元\n${items.map(item => `- ${item}\n`).join('')}`;

/**
 * The calling note's items; the reader breaks the first one's link (`first`), which calls what the shape is drawn from
 * (`call`). The other item of two calls the other part of the same note (so the note is still read while the first is
 * broken), or another note.
 */
const HOSTS = [
  { host: 'one item', items: (first: string) => [first] },
  {
    host: 'two items, the other calling the other part of the same note',
    items: (first: string, call: string) => [first, call === 'undo-ids' ? '![[undo-ids#トピック]]' : '![[undo-ids]]'],
  },
  { host: 'two items, the other calling another note', items: (first: string) => [first, '![[other]]'] },
] as const;

/** The broken item calls the whole note, or the topic for the shape under it. */
const SHAPES = [
  { shape: '通常', label: '親', index: 0, call: 'undo-ids' },
  { shape: '空題名 (the second)', label: EMPTY_LABEL, index: 1, call: 'undo-ids' },
  { shape: '同名 (the second)', label: '同名', index: 1, call: 'undo-ids' },
  { shape: 'トピック (a branch under the called topic)', label: '枝', index: 0, call: 'undo-ids#トピック' },
] as const;

/** The titles the broken item goes through, the last one its own again (or with an alias): each is saved and read in turn. */
const OPERATIONS: { operation: string; steps: (call: string) => string[] }[] = [
  { operation: 'the closing `]` deleted and typed again', steps: call => [`![[${call}]`, `![[${call}]]`] },
  { operation: 'the `!` deleted and typed again', steps: call => [`[[${call}]]`, `![[${call}]]`] },
  { operation: 'the whole title deleted, then Undo', steps: call => ['', `![[${call}]]`] },
  { operation: 'the name typed again through a prefix no note has', steps: call => [`![[${call}`, '![[undo]]', `![[${call}]]`] },
  { operation: 'an alias typed in', steps: call => [`![[${call}|`, `![[${call}|別名]`, `![[${call}|別名]]`] },
  { operation: 'pointed at another map for a while', steps: call => ['![[other]]', `![[${call}]]`] },
  {
    // The link still reaches the note, at a heading it does not have (code review 2): the item draws nothing for a while.
    operation: 'the heading part typed again',
    steps: call => call.includes('#') ? [`![[${call.slice(0, -1)}]]`, `![[${call}]]`] : [`![[${call}#無い見出し]]`, `![[${call}]]`],
  },
  {
    // The name deleted and typed back letter by letter, the brackets closed by the editor: each prefix that names a map
    // (`u`, `un`, `und` are maps here) draws that map on the way (code review 1: two notes an item were not enough).
    operation: 'the name typed back through maps whose names begin it',
    steps: call => ['![[]]', '![[u]]', '![[un]]', '![[und]]', '![[undo]]', `![[${call}]]`],
  },
];

async function open(items: readonly string[]): Promise<MountedMapView> {
  const app = new HarnessApp();
  app.put(PATH, SOURCE);
  app.put(OTHER, OTHER_SOURCE);
  for (const prefix of ['u', 'un', 'und']) app.put(`Fixtures/${prefix}.md`, OTHER_SOURCE);
  const host = await mountMapView(HOST, hostSource(items), 'mindmap', app);
  await settled(host);
  return host;
}

/** No read pending in the calling map. */
async function settled(host: MountedMapView): Promise<void> {
  const view = host.view as unknown as ViewState;
  await vi.waitFor(() => {
    expect({ timer: view.refreshTimer, recall: view.recallTimer, read: view.refreshing })
      .toEqual({ timer: undefined, recall: undefined, read: undefined });
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

/** The node drawn under `id` now: its label and whether it is folded (the order of the nodes may change with a redraw). */
function seenById(host: MountedMapView, id: string | undefined): { id: string | undefined; label: string | undefined; folded: boolean } | undefined {
  const node = Array.from(host.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node')).find(element => element.dataset.nodeId === id);
  return node && { id: node.dataset.nodeId, label: accessibleName(node), folded: node.hasClass('is-collapsed') };
}

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

/** The Markdown side saves the calling note with the broken item's title replaced (the other items as they were). */
async function retitle(host: MountedMapView, items: readonly string[]): Promise<void> {
  await host.app.asApp<App>().vault.process(host.file, () => hostSource(items));
  await settled(host);
}

/**
 * The same on the map: the calling item edited with F2 (the item's own text, `![[…]]`, in the inline editor) and Enter.
 * The map shows its own write at once, before the reader reads the calls again (`showOwnWrite`, LEV-219).
 */
async function retitleOnMap(host: MountedMapView, id: string, title: string): Promise<void> {
  const item = Array.from(host.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node')).find(node => node.dataset.nodeId === id);
  if (!item) throw new Error(`No calling item ${id}`);
  item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  host.key(host.canvas, 'F2');
  const editor = host.editor();
  if (!editor) throw new Error('F2 opened no editor');
  editor.value = title;
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  host.key(editor, 'Enter');
  await vi.waitFor(() => expect(host.source()).toContain(`- ${title}\n`), { timeout: 2000, interval: 5 });
  await settled(host);
}

const MATRIX = OPERATIONS.flatMap(({ operation, steps }) => HOSTS.flatMap(({ host, items }) =>
  SHAPES.map(shape => ({ operation, steps, host, items, ...shape }))));

describe('the calling map\'s folds through the calling item\'s link broken on the Markdown side and put back (LEV-260)', () => {
  it.each(MATRIX)('$operation, $host: the $shape node the reader opened keeps its id and stays open', async ({ steps, items, call, label, index }) => {
    const host = await open(items(`![[${call}]]`, call));
    const opened = await unfold(host, label, index);
    for (const title of steps(call)) await retitle(host, items(title, call));
    expect(seenById(host, opened.id)).toEqual({ ...opened, label });
  });

  // Not the whole title deleted (Undo on the map is its own history, LEV-150), nor a name typed through an unclosed
  // `![[…`: Enter there picks the link suggestion (`link-suggest`), so the map never writes that step.
  const ON_MAP = OPERATIONS.filter(({ operation }) => !operation.startsWith('the whole title') && !operation.startsWith('the name typed'))
    .flatMap(({ operation, steps }) => HOSTS.flatMap(({ host, items }) => SHAPES.map(shape => ({ operation, steps, host, items, ...shape }))));

  it.each(ON_MAP)('on the map with F2, $operation, $host: the $shape node the reader opened keeps its id and stays open', async ({ steps, items, call, label, index }) => {
    const host = await open(items(`![[${call}]]`, call));
    const opened = await unfold(host, label, index);
    const caller = (opened.id ?? '').split('/')[0] ?? '';
    for (const title of steps(call)) await retitleOnMap(host, caller, title);
    expect(seenById(host, opened.id)).toEqual({ ...opened, label });
  });

  it('the folds of a calling item go with the item: deleted, its called nodes are forgotten, and a new item starts folded (the hold\'s end)', async () => {
    const host = await open(['![[undo-ids]]', '![[other]]']);
    const opened = await unfold(host, '親', 0);
    const view = host.view as unknown as { collapsed: Set<string>; knownCalled: Set<string> };
    const caller = (opened.id ?? '').split('/')[0] ?? '';
    const mine = (): string[] => [...view.collapsed, ...view.knownCalled].filter(id => id.startsWith(`${caller}/`));
    await retitle(host, ['![[undo-ids]', '![[other]]']);
    expect(mine().length).toBeGreaterThan(0);
    await retitle(host, ['![[other]]']);
    expect(mine()).toEqual([]);
    await retitle(host, ['![[undo-ids]]', '![[other]]']);
    expect(seen(host, '親', 0).folded).toBe(true);
  });

  it('two items calling the same note with the same title: the edit renumbers the calling item itself, so its branch starts anew (E05)', async () => {
    // Not the bug: it pins the limit of the fix. An edit on the Markdown side is an external change, matched by titles
    // alone, and neither of two same-titled items is guessed at by its place (E05), so the item broken and typed again
    // is another item to the map, and the called nodes' ids are made of the item's. The reader still reads the note under
    // the same ids (the called node's own id, after the `/`), which the next edit of the map's own carries.
    const items = (first: string) => [first, '![[undo-ids]]'];
    const host = await open(items('![[undo-ids]]'));
    const opened = await unfold(host, '親', 0);
    for (const title of ['![[undo-ids]', '![[undo-ids]]']) await retitle(host, items(title));
    const [caller, called] = (opened.id ?? '').split('/');
    const now = Array.from(host.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node'))
      .map(node => node.dataset.nodeId ?? '').filter(id => id.endsWith(`/${called}`));
    expect({ twins: now.length, caller: now.some(id => id.startsWith(`${caller}/`)) }).toEqual({ twins: 2, caller: false });
  });
});
