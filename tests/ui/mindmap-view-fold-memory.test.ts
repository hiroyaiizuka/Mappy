// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { installObsidianDom } from '../browser-harness/dom';
import { HarnessApp } from '../browser-harness/app';
import { FoldStore, type FoldAdapter } from '../../src/obsidian/fold-store';
import { closeOpenViews } from '../mocks/open-views';
import { accessibleName } from './accessible-name';
import { mountMapView, type MountedMapView } from './map-view-mount';

/**
 * LEV-365 (the person's report of 2026-10-19): branches folded by hand came back open once another note had been
 * opened in the tab, in another tab, or after Markdown and back. With the memory (src/main.ts gives every view one),
 * the map shows the folds it was left with at each of those, its own and a called map's (a called branch that starts
 * folded and was opened stays open), and after a change made outside the map it opens as it showed. The shipped view, store, reader and memory run against the harness's `obsidian`; the memory's file is a fake
 * adapter's (its writes and limits are tests/obsidian/fold-store.test.ts's).
 */
vi.mock('obsidian', () => import('../browser-harness/obsidian'));

beforeAll(() => { installObsidianDom(); });

afterEach(async () => {
  await closeOpenViews();
  document.body.replaceChildren();
});

const PATH = 'Maps/リスト.md';
const OTHER = 'Maps/ほか.md';
const CALLED = 'Maps/先.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 根',
  '- 枝', '  - 葉',
  '- 同名', '  - 子1',
  '- 同名', '  - 子2',
  '- 開いたまま', '  - 見える',
  '- ![[先]]',
  '',
].join('\n');
const CALLED_SOURCE = ['---', 'mappy: true', '---', '## 先', '- C1', '  - C1a', '- C2', '  - C2a', ''].join('\n');
const OTHER_SOURCE = ['---', 'mappy: true', '---', '## ほか', '- 何か', ''].join('\n');

function memoryFor(app: HarnessApp): FoldStore {
  const files = new Map<string, string>();
  const adapter: FoldAdapter = {
    read: path => files.has(path) ? Promise.resolve(files.get(path)!) : Promise.reject(new Error('ENOENT')),
    write: (path, data) => { files.set(path, data); return Promise.resolve(); },
    remove: path => { files.delete(path); return Promise.resolve(); },
    rename: (from, to) => { files.set(to, files.get(from)!); files.delete(from); return Promise.resolve(); },
    exists: path => Promise.resolve(files.has(path)),
    stat: path => Promise.resolve(files.has(path) ? { type: 'file', ctime: 0, mtime: 0, size: files.get(path)!.length } : null),
  };
  return new FoldStore(adapter, 'cfg/plugins/mappy/folds.json', path => app.asApp<App>().vault.getAbstractFileByPath(path) !== null);
}

/** The names of the nodes drawn folded, `<name>#<n>` counting the nodes of that name in the order the map lists them. */
function folded(mounted: MountedMapView): string[] {
  const nodes = Array.from(mounted.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node'));
  const order = (mounted.view as unknown as { visible(): { id: string }[] }).visible().map(node => node.id);
  nodes.sort((a, b) => order.indexOf(a.dataset.nodeId!) - order.indexOf(b.dataset.nodeId!));
  const seen = new Map<string, number>();
  const names: string[] = [];
  for (const node of nodes) {
    const name = accessibleName(node);
    const nth = (seen.get(name) ?? 0) + 1;
    seen.set(name, nth);
    if (node.classList.contains('is-collapsed')) names.push(`${name}#${nth}`);
  }
  return names.sort();
}

/** A click on the fold control of the n-th node of that name, as a pointer gives it. */
function toggle(mounted: MountedMapView, name: string, nth = 1): void {
  const order = (mounted.view as unknown as { visible(): { id: string }[] }).visible().map(node => node.id);
  const nodes = Array.from(mounted.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node'))
    .filter(node => accessibleName(node) === name)
    .sort((a, b) => order.indexOf(a.dataset.nodeId!) - order.indexOf(b.dataset.nodeId!));
  const control = nodes[nth - 1]?.querySelector('.mappy-node-toggle');
  if (!control) throw new Error(`No fold control on ${name} #${nth}`);
  control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

async function mount(memory?: FoldStore, app = new HarnessApp()): Promise<MountedMapView> {
  app.put(CALLED, CALLED_SOURCE);
  app.put(OTHER, OTHER_SOURCE);
  const mounted = await mountMapView(PATH, SOURCE, 'mindmap', app, { ...(memory ? { memory } : {}) });
  await mounted.settle();
  return mounted;
}

/** Another note in the view's own tab, then the map's note again (the explorer, a link, back: `FileView.setState`). */
async function awayAndBack(mounted: MountedMapView): Promise<void> {
  await mounted.view.setState({ file: OTHER }, { history: true });
  await mounted.settle();
  await mounted.view.setState({ file: PATH }, { history: true });
  await mounted.settle();
}

/** The folds the cases start from: a branch, the second of two same-titled nodes, and the called C1 opened (C1 and C2 start folded). */
async function foldSome(mounted: MountedMapView): Promise<string[]> {
  toggle(mounted, '枝');
  toggle(mounted, '同名', 2);
  toggle(mounted, 'C1');
  await mounted.settle();
  return folded(mounted);
}

describe('the folds kept between openings of a note (LEV-365)', () => {
  it('starts a called map folded below its root’s children, as before', async () => {
    const app = new HarnessApp();
    const mounted = await mount(memoryFor(app), app);
    expect(folded(mounted)).toEqual(['C1#1', 'C2#1']);
  });

  it('shows the folds again once another note was opened in the tab and the map’s note came back', async () => {
    const app = new HarnessApp();
    const mounted = await mount(memoryFor(app), app);
    const left = await foldSome(mounted);
    // C1 opened stays open (it starts folded at every opening), C2 stays as it starts.
    expect(left).toEqual(['C2#1', '同名#2', '枝#1']);
    await awayAndBack(mounted);
    expect(folded(mounted)).toEqual(left);
  });

  it('opens the note in another tab with the folds the first left, and each keeps its own while both are open', async () => {
    const app = new HarnessApp();
    const memory = memoryFor(app);
    const first = await mount(memory, app);
    const left = await foldSome(first);
    const second = await mountMapView(PATH, SOURCE, 'mindmap', app, { memory });
    await second.settle();
    expect(folded(second)).toEqual(left);
    toggle(second, '枝');
    await second.settle();
    expect(folded(first)).toEqual(left);
    const third = await mountMapView(PATH, SOURCE, 'mindmap', app, { memory });
    await third.settle();
    expect(folded(third)).toEqual(['C2#1', '同名#2']);
  });

  it('opens again as the map showed it after a change made outside the map, which drops a same-titled node’s fold as before (E05)', async () => {
    const app = new HarnessApp();
    const mounted = await mount(memoryFor(app), app);
    await foldSome(mounted);
    app.put(PATH, SOURCE.replace('- 枝\n  - 葉\n', '- 枝\n  - 葉\n  - 足した葉\n'));
    await new Promise(resolve => setTimeout(resolve, 80));
    await mounted.settle();
    // The parse matches unique titles only (a same-titled node gets a new id, its fold going with the old one: LEV-237).
    const shown = folded(mounted);
    expect(shown).toEqual(['C2#1', '枝#1']);
    await awayAndBack(mounted);
    expect(folded(mounted)).toEqual(shown);
  });

  it('forgets nothing it was not given: without a memory the map opens unfolded again, as before LEV-365', async () => {
    const mounted = await mount();
    await foldSome(mounted);
    await awayAndBack(mounted);
    expect(folded(mounted)).toEqual(['C1#1', 'C2#1']);
  });
});
