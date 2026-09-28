// @vitest-environment jsdom
/**
 * A map called from an item of another map (§5 M12, `CallReader`) is read again after every write the called note's
 * own map tab makes, and carries the ids over with the edits of that write, as the tab (LEV-150) and an embed (LEV-217)
 * do: the folds the reader set on the called branches in the calling map stay on a node whose title repeats or is
 * empty (LEV-221). The matrix is what the user does in the called note's tab (an edit, a layout button, ⌘Z, ⌘⇧Z; an
 * Undo in the Markdown pane, as a write put back) × the shape of the called node the reader toggled in the calling map
 * (one title, the second untitled node, the second of two same-titled nodes, a branch under a called topic).
 *
 * Every called branch starts folded (`initialCallFolds`), and a called node the re-read cannot place (a new id) is
 * folded as new, so what the reader loses is a branch they opened: it closes again. The 通常 and トピック rows hold
 * before the fix too; they pin that the carried ids do not move a node matched by its title. The E05 row pins what the
 * fix must not do: an external change is still matched by titles alone (it holds before the fix too).
 *
 * Before the fix the 空題名 and 同名 rows failed at the first edit (a new id, folded again), and so did both put-back
 * twin rows and the listener row (`artifacts/lev-221-call-reader-onwrite/tests-before-fix.log`). What each other row
 * pins of the fix, each part taken out on its own (`run-variants.sh` → `variants.txt`): the external change after a
 * put-back fails without the writes recorded before the read dropped (`mark`); the writes that came back fail without
 * them spent (`spend`, and without `mark` too); the listener row fails when the view does not end the subscription.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { layoutLabel } from '../../src/core/layout-mode';
import type { CallTargets } from '../../src/core/calls';
import type { DocumentStore } from '../../src/obsidian/document-store';
import { mountMapView, type MountedMapView } from './map-view-mount';
import { accessibleName } from './accessible-name';

vi.mock('obsidian', () => import('../../harness/browser/obsidian'));
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
/** The whole called map under one item, and its free topic under another (a whole-note call draws the body root only). */
const HOST_SOURCE = '---\nmappy: true\n---\n## 呼び出し元\n- ![[undo-ids]]\n- ![[undo-ids#トピック]]\n';

interface Opened { called: MountedMapView; host: MountedMapView; store: DocumentStore }
const opened: Opened[] = [];
afterEach(async () => {
  for (const { called, host } of opened.splice(0)) {
    await host.close();
    await called.close();
  }
  document.body.replaceChildren();
});

/** The called note open in its own map tab, and the calling note in another; the plugin gives both one store (src/main.ts). */
async function open(): Promise<Opened> {
  const app = new HarnessApp();
  const called = await mountMapView(PATH, SOURCE, 'mindmap', app);
  const store = (called.view as unknown as { store: DocumentStore }).store;
  app.put(HOST, HOST_SOURCE);
  const host = await mountMapView(HOST, HOST_SOURCE, 'mindmap', app, { store });
  const result = { called, host, store };
  opened.push(result);
  await settled(result, () => true);
  return result;
}

interface ViewState {
  document: { source: string } | undefined; refreshTimer: number | undefined; recallTimer: number | undefined;
  refreshing: Promise<void> | undefined; saving: boolean; targets: CallTargets;
}

/** Every write and re-read done: the called tab shows what the note holds, and the calling map draws it. */
async function settled({ called, host }: Opened, reached: (source: string) => boolean): Promise<void> {
  const tab = called.view as unknown as ViewState;
  const caller = host.view as unknown as ViewState;
  await vi.waitFor(() => {
    const drawn = Array.from(caller.targets.values(), target => target.document.source);
    expect({
      reached: reached(called.source()), timer: tab.refreshTimer, read: tab.refreshing, saving: tab.saving,
      tab: tab.document?.source === called.source(), recall: caller.recallTimer, hostRead: caller.refreshing,
      host: drawn.length === 2 && drawn.every(source => source === called.source()),
    }).toEqual({ reached: true, timer: undefined, read: undefined, saving: false, tab: true, recall: undefined, hostRead: undefined, host: true });
  }, { timeout: 2000, interval: 5 });
  await host.settle();
}

/**
 * The 45 ms debounces (the tab's re-read, the calling map's read of its calls) held instead of run, until `release`
 * runs the ones still set; every other timer runs as usual.
 */
function holdDebounces(): { release: () => void } {
  const set = window.setTimeout.bind(window);
  const clear = window.clearTimeout.bind(window);
  let next = -1;
  const held = new Map<number, () => void>();
  window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]): number => {
    if (delay !== 45 || typeof handler !== 'function') return set(handler, delay, ...args);
    const id = next--;
    held.set(id, () => { (handler as (...data: unknown[]) => void)(...args); });
    return id;
  }) as unknown as typeof window.setTimeout;
  window.clearTimeout = (id => { if (typeof id === 'number' && held.delete(id)) return; clear(id); });
  return {
    release: () => {
      window.setTimeout = set;
      window.clearTimeout = clear;
      for (const run of Array.from(held.values())) set(run, 45);
      held.clear();
    },
  };
}

/** The `index`-th node with this label (an untitled node reads as 空のノード) inside `root`. */
function nodeNamed(root: ParentNode, label: string, index = 0): HTMLElement {
  const found = Array.from(root.querySelectorAll<HTMLElement>('.mappy-node')).filter(node => accessibleName(node) === label)[index];
  if (!found) throw new Error(`No node ${label} #${index}`);
  return found;
}

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/** What the reader sees of a called node in the calling map: its id and whether its branch is folded. */
function seen({ host }: Opened, label: string, index: number): { id: string | undefined; folded: boolean } {
  const node = nodeNamed(host.view.containerEl, label, index);
  return { id: node.dataset.nodeId, folded: node.hasClass('is-collapsed') };
}

/** The reader toggles the `index`-th called `label` in the calling map; returns what they see of it then. */
async function toggle(opened: Opened, label: string, index: number): Promise<{ id: string | undefined; folded: boolean }> {
  const before = seen(opened, label, index);
  const node = nodeNamed(opened.host.view.containerEl, label, index);
  const button = node.querySelector<HTMLElement>('.mappy-node-toggle');
  if (!button) throw new Error(`${label} #${index} has no toggle`);
  click(button);
  await opened.host.settle();
  const after = seen(opened, label, index);
  expect(after).toEqual({ id: before.id, folded: !before.folded });
  return after;
}

/** `from` renamed with F2 in the called note's tab (子1 by default, to a longer title so every node after it moves). */
async function rename(opened: Opened, from = '子1', to = 'ずっと長い題名に改名', index = 0): Promise<void> {
  const { called } = opened;
  click(nodeNamed(called.view.containerEl, from, index));
  called.key(called.canvas, 'F2');
  const editor = called.editor();
  if (!editor) throw new Error('F2 opened no editor');
  editor.value = to;
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  called.key(editor, 'Enter');
  await settled(opened, source => source.includes(`- ${to}\n`));
}

async function layout(opened: Opened): Promise<void> {
  const button = opened.called.view.containerEl.querySelector<HTMLButtonElement>(`.mappy-modes button[aria-label="${layoutLabel('timeline')}"]`);
  if (!button) throw new Error('No layout button');
  button.click();
  await settled(opened, source => source.includes('mappy-layout: timeline\n'));
}

/** ⌘Z, or ⌘⇧Z, on the called note's tab. */
async function history(opened: Opened, redo: boolean, reached: (source: string) => boolean): Promise<void> {
  opened.called.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: redo, bubbles: true, cancelable: true }));
  await settled(opened, reached);
}

const SHAPES = [
  { shape: '通常', label: '親', index: 0 },
  { shape: '空題名 (the second)', label: EMPTY_LABEL, index: 1 },
  { shape: '同名 (the second)', label: '同名', index: 1 },
  { shape: 'トピック (a branch under the called topic)', label: '枝', index: 0 },
] as const;

describe("the calling map's folds through the writes of the called note's map tab (LEV-221)", () => {
  it.each(SHAPES)('an edit, a layout button, ⌘Z and ⌘⇧Z in the called tab: the $shape node the reader toggled keeps its id and its fold', async ({ label, index }) => {
    const opened = await open();
    const toggled = await toggle(opened, label, index);
    await rename(opened);
    expect({ step: 'edit', ...seen(opened, label, index) }).toEqual({ step: 'edit', ...toggled });
    await layout(opened);
    expect({ step: 'layout', ...seen(opened, label, index) }).toEqual({ step: 'layout', ...toggled });
    // The layout button is not a step of its own (LEV-206): ⌘Z takes the rename back under the new layout.
    await history(opened, false, source => source.includes('  - 子1\n') && source.includes('mappy-layout: timeline\n'));
    expect({ step: '⌘Z', ...seen(opened, label, index) }).toEqual({ step: '⌘Z', ...toggled });
    await history(opened, true, source => source.includes('- ずっと長い題名に改名\n'));
    expect({ step: '⌘⇧Z', ...seen(opened, label, index) }).toEqual({ step: '⌘⇧Z', ...toggled });
  }, 20_000); // five writes, each waited for in both tabs: past the default 5 s on a loaded machine

  it('an external change is still matched by titles alone, and a same-titled node is not guessed (E05)', async () => {
    // Not a regression test of the bug: it pins what the fix must not do — take someone else's change for the tab's own.
    const opened = await open();
    await rename(opened);
    const { id } = seen(opened, EMPTY_LABEL, 1);
    await opened.called.app.asApp<App>().vault.process(opened.called.file, text => text.replace('- 子2\n', '- 外から\n'));
    await settled(opened, source => source.includes('- 外から\n'));
    expect(seen(opened, EMPTY_LABEL, 1).id).not.toBe(id);
  });

  describe('a write put back before the calling map read it (Undo in the Markdown pane, LEV-224)', () => {
    // A read of the text already drawn keeps only the writes recorded while it was under way; one recorded before it
    // began was there for it to find, so someone put the note back. Kept, it would stand at the end of the record, the
    // next write — made on the text drawn — could not follow it, and its read would match the called nodes by title:
    // with the twin before it renamed, the node the reader opened would take the twin's id and close again.
    const TWINS = [
      { shape: '空題名 (the second)', label: EMPTY_LABEL, twin: '- \n' },
      { shape: '同名 (the second)', label: '同名', twin: '- 同名\n' },
    ] as const;

    it.each(TWINS)('a rename of the twin before $shape after a write was put back keeps its id and fold', async ({ label, twin }) => {
      const opened = await open();
      const { called, store } = opened;
      const opens = await toggle(opened, label, 1);
      // The store renames 子1, and the note is put back before either tab re-reads (their debounces held): were the
      // calling map to read the rename first, it would be spent, and the row would pass whatever the fix does.
      const held = holdDebounces();
      try {
        const from = SOURCE.indexOf('- 子1\n') + 2;
        await store.applyLatest(called.file, () => [{ from, to: from + 2, text: '改名' }]);
        called.app.put(PATH, SOURCE);
      } finally {
        held.release();
      }
      await settled(opened, source => source === SOURCE);
      await store.applyLatest(called.file, source => {
        const at = source.indexOf(twin) + 2;
        return [{ from: at, to: at + twin.length - 3, text: '命名' }];
      });
      await settled(opened, source => source.includes('- 命名\n'));
      expect(seen(opened, label, 0)).toEqual(opens);
    });

    it('an external change after a write was put back is matched by titles from the text drawn, not from the write', async () => {
      // The rows above hold on the record started again by the next write alone. Here no write of the store comes in
      // between: kept, the rename of 親 taken back would still lead from the text drawn, and the external change would
      // be matched from the text it reached, where 親 is 改名 — 親 would be new, and come back folded.
      const opened = await open();
      const { called, store } = opened;
      const opens = await toggle(opened, '親', 0);
      const held = holdDebounces();
      try {
        const from = SOURCE.indexOf('- 親\n') + 2;
        await store.applyLatest(called.file, () => [{ from, to: from + 1, text: '改名' }]);
        called.app.put(PATH, SOURCE);
      } finally {
        held.release();
      }
      await settled(opened, source => source === SOURCE);
      await called.app.asApp<App>().vault.process(called.file, text => text.replace('- 子2\n', '- 外から\n'));
      await settled(opened, source => source.includes('- 外から\n'));
      expect(seen(opened, '親', 0)).toEqual(opens);
    });
  });

  it('writes that came back to the text drawn before the calling map read are spent, so the next write carries the ids from it', async () => {
    // The tab deletes the second untitled node and puts it back (a delete then ⌘Z) within one debounce: the calling map
    // reads the text it drew. Kept, those two writes would be replayed before the next one, and the node put back by
    // the second is parsed as new: the branch the reader opened would close.
    const opened = await open();
    const { called, store } = opened;
    const opens = await toggle(opened, EMPTY_LABEL, 1);
    const block = '- \n  - 空の子2\n';
    const at = SOURCE.indexOf(block);
    const held = holdDebounces();
    try {
      await store.applyLatest(called.file, () => [{ from: at, to: at + block.length, text: '' }]);
      await store.applyLatest(called.file, () => [{ from: at, to: at, text: block }]);
      expect(called.source()).toBe(SOURCE);
    } finally {
      held.release();
    }
    await settled(opened, source => source === SOURCE);
    const first = SOURCE.indexOf('- \n') + 2;
    await store.applyLatest(called.file, () => [{ from: first, to: first, text: '命名' }]);
    await settled(opened, source => source.includes('- 命名\n'));
    expect(seen(opened, EMPTY_LABEL, 0)).toEqual(opens);
  });

  it('the calling map listens to the store while it is open, and not after it closed', async () => {
    // The reader has no unload of its own: the view that holds it ends its subscription (LEV-221).
    const opened = await open();
    const listeners = (opened.store as unknown as { writeListeners: Set<unknown> }).writeListeners;
    const count = listeners.size;
    await opened.host.close();
    opened.host.close = () => Promise.resolve();
    // The host view's own subscription and its reader's.
    expect(count - listeners.size).toBe(2);
  });
});
