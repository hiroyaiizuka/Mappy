// @vitest-environment jsdom
/**
 * A re-read that finds the text the map already shows keeps the record of the map's own writes (LEV-218). Before the
 * fix `reread` dropped the whole record whenever it did not lead to the text read (`if (!replayed) this.ownWrites =
 * []`). After LEV-219 the save shows what it wrote at once and spends the record (`showOwnWrite`), so both the save's
 * re-read and the watcher's find the text on screen. A second write W2 recorded while one of them reads — its start is
 * the text on screen, so the record takes it (`recordOwn`) — was then open to that drop, and W2's own re-read, with no
 * edits to carry the ids, would match nodes by title: the fold of the second untitled or same-titled node would go
 * (the LEV-146／LEV-150 symptom). The selection is not in the matrix: the rename itself selects 子1 before the window.
 *
 * The matrix is what the user does while the rename's last re-read is reading (the map's reads answered 200 ms late,
 * past the watcher's debounce like E53's `slow`, so the second write lands inside that read and its own re-read ends
 * after it) — this map's layout button, another map's button, edit or ⌘Z (the shared history), and this map's next
 * key (⌥↑) or ⌘Z — × the node folded. Each row checks that the read W2 landed in found the text on screen, was still
 * the newest right before W2 and had not answered yet when the map recorded W2, which is the window the ticket names;
 * without that a row could pass because the window was never hit.
 *
 * Two things keep the record, and each is enough alone:
 * - the fix: a read of the text on screen keeps the writes recorded while it was under way that lead on from it
 *   (`reread`), and a write made on the text on screen starts the record again when it ends on a text someone took
 *   back (`recordOwn`);
 * - the order: every write the record takes is one the store has just made on this note, and the note's watcher
 *   (`modify` for a note no editor holds, `editor-change` for one it does) moves the epoch before the store tells the
 *   view (`DocumentStore.tell` after `writeSafely`), so the read gives up at the epoch check right after `store.read`.
 * The first describe keeps the order (in jsdom by construction: the harness vault fires `modify` inside its write; on
 * Obsidian's own events it is E58, `scripts/e2e/reread-own-writes.mjs`) and also checks that the read gave up. The
 * second breaks it — `modify` reaches the maps late — so only the fix holds there. The third is a write someone else
 * took back (code reviews 1 and 2 of the fix): how far the fix may go.
 *
 * Against each version (`artifacts/lev-218-reread-own-writes/run-jsdom-variants.sh`, `jsdom-*.log`): the fix passes
 * all 25, and all 25 with the epoch check taken out too. The code before it fails 10 (the 8 of the second describe and
 * the 2 layout-button rows of the third), 18 with the epoch check also taken out. Keeping every write on a read of the
 * text on screen (this branch's first fix) fails 5 of the third, keeping those recorded during the read without the
 * other two rules fails 3. Of the rows that never fail, 4 are this map's own ⌥↑ and ⌘Z, on both shapes: they are shown
 * and spent the moment they land (`showOwnWrite`, LEV-219), so no read ever holds them. They are not regression tests
 * of either; they pin that the user's own next key keeps the fold through the window.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { Notice } from '../../harness/browser/obsidian';
import { LAYOUT_LABELS, type LayoutMode } from '../../src/core/layout-mode';
import type { MindDocument } from '../../src/core/markdown';
import type { DocumentStore } from '../../src/obsidian/document-store';
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

const PATH = 'Fixtures/reread-own-writes.md';
const EMPTY_LABEL = '空のノード';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 本体', '',
  '- 親', '  - 子1', '  - 子2',
  '- ', '  - 空の子',
  '- ', '  - 空の子2',
  '- 同名', '  - 同名の子A',
  '- 同名', '  - 同名の子B',
  '',
].join('\n');
/** How late the map's reads answer (all but the save's own re-read): past the watcher's 45 ms debounce (E53's `slow` is 80 ms), with room for a loaded machine. */
const SLOW_MS = 200;
/** When, inside a read of the text on screen, the second write is made. */
const INSIDE_MS = 100;
/**
 * How late the note's `modify` arrives in the rows where the watcher comes after the store's word: well past the read's
 * answer (SLOW_MS after the read has its text, which may itself wait behind the store's queue).
 */
const LATE_MS = 400;

interface ViewState {
  document: MindDocument | undefined; epoch: number; saving: boolean; ownWrites: unknown[];
  collapsed: Set<string>; selectedId: string | null;
  refreshTimer: number | undefined; refreshing: Promise<void> | undefined;
}
const state = (mounted: MountedMapView): ViewState => mounted.view as unknown as ViewState;
const storeOf = (mounted: MountedMapView): DocumentStore => (mounted.view as unknown as { store: DocumentStore }).store;

async function mount(app = new HarnessApp(), store?: DocumentStore): Promise<MountedMapView> {
  const mounted = await mountMapView(PATH, SOURCE, 'mindmap', app, store ? { store } : {});
  opened.push(mounted);
  return mounted;
}

/** Every write and re-read of these views done, each showing what the note holds. */
async function settled(...views: MountedMapView[]): Promise<void> {
  await vi.waitFor(() => {
    for (const mounted of views) {
      const view = state(mounted);
      expect({ timer: view.refreshTimer, read: view.refreshing, saving: view.saving, current: view.document?.source === mounted.source() })
        .toEqual({ timer: undefined, read: undefined, saving: false, current: true });
    }
  }, { timeout: 3000, interval: 5 });
  for (const mounted of views) await mounted.settle();
}

function nodeNamed(mounted: MountedMapView, label: string, index = 0): HTMLElement {
  const found = Array.from(mounted.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node')).filter(node => accessibleName(node) === label)[index];
  if (!found) throw new Error(`No node ${label} #${index}`);
  return found;
}

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function clickLayout(mounted: MountedMapView, mode: LayoutMode): void {
  const button = mounted.view.containerEl.querySelector<HTMLButtonElement>(`.mappy-modes button[aria-label="${LAYOUT_LABELS[mode]}"]`);
  if (!button) throw new Error(`No button for ${mode}`);
  button.click();
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

/** The node folded (its toggle clicked) and selected, as the user leaves it; returns its id. */
function foldAndSelect(mounted: MountedMapView, label: string, index: number): string {
  const element = nodeNamed(mounted, label, index);
  const id = element.dataset.nodeId ?? '';
  click(element);
  const toggle = element.querySelector<HTMLElement>('.mappy-node-toggle');
  if (!toggle) throw new Error('No toggle');
  click(toggle);
  const view = state(mounted);
  expect({ collapsed: [...view.collapsed], selected: view.selectedId }).toEqual({ collapsed: [id], selected: id });
  return id;
}

interface Found {
  /** The read the second write landed inside found the text on screen (`landedIn`) and gave up to a newer epoch (`gaveUp`). */
  landedIn: boolean | null; gaveUp: boolean | null;
  /** Right before the second write, whether that read was still the newest (nothing else had superseded it). */
  newestBefore: boolean | null;
  /** At the moment the map recorded the second write, whether its epoch had already moved past the read in flight. */
  movedBeforeRecord: boolean | null;
  /** Whether the map recorded the second write (its record held it right after). */
  recorded: boolean | null;
  /** Whether it recorded it before that read answered: after, the read would have had nothing to drop, and the row no window. */
  beforeAnswer: boolean | null;
}

/**
 * The rename of 子1 in `mounted`. The read the second write lands in is the rename's last one: the watcher's re-read
 * (no refresh is scheduled when it starts), which finds the text the save has already shown (LEV-219) and which
 * nothing else supersedes. INSIDE_MS into it, `second` makes the second write. The map's reads are answered SLOW_MS
 * late but for the save's own re-read (`reread(true)`): with it slow the save would still be under way (`saving`)
 * then, and this map's own key would be refused.
 */
async function renameThen(mounted: MountedMapView, second: () => void, { late = false } = {}): Promise<Found> {
  const view = state(mounted);
  const store = storeOf(mounted);
  const found: Found = { landedIn: null, gaveUp: null, newestBefore: null, movedBeforeRecord: null, recorded: null, beforeAnswer: null };
  let answered = false;
  let landed = false;
  let inFlight: number | null = null;
  // The store is shared with the other map: only the reads this map's re-read asks for (synchronously, as it starts) count.
  let asking: 'own' | 'watch' | null = null;
  const internals = mounted.view as unknown as {
    reread(own?: boolean): Promise<void>; recordWrite(file: unknown, write: { after: string }): void;
  };
  const reread = internals.reread.bind(mounted.view);
  vi.spyOn(internals, 'reread').mockImplementation(own => {
    asking = own ? 'own' : 'watch';
    try { return reread(own); } finally { asking = null; }
  });
  const read = store.read.bind(store);
  vi.spyOn(store, 'read').mockImplementation(async file => {
    const mine = asking;
    asking = null;
    if (mine === null) return read(file);
    const epoch = view.epoch;
    const shown = view.document?.source;
    if (mine === 'own') return read(file);
    const carries = landed && inFlight === null && view.refreshTimer === undefined;
    if (carries) {
      inFlight = epoch;
      // The watcher after the store's word (`late`): from here on the note's `modify` reaches the maps LATE_MS late.
      if (late) {
        const trigger = mounted.app.vaultEvents.trigger.bind(mounted.app.vaultEvents);
        vi.spyOn(mounted.app.vaultEvents, 'trigger').mockImplementation((name, ...data) => {
          if (name === 'modify') setTimeout(() => { trigger(name, ...data); }, LATE_MS);
          else trigger(name, ...data);
        });
      }
      setTimeout(() => { found.newestBefore = view.epoch === epoch; second(); }, INSIDE_MS);
    }
    // Read first, answered late: the second write lands between the read and its answer.
    const source = await read(file);
    await new Promise(resolve => setTimeout(resolve, SLOW_MS));
    if (carries) {
      answered = true;
      found.landedIn = source === shown;
      found.gaveUp = view.epoch !== epoch;
    }
    return source;
  });
  const applyOver = store.applyOver.bind(store);
  vi.spyOn(store, 'applyOver').mockImplementation(async (...args: Parameters<DocumentStore['applyOver']>) => {
    const result = await applyOver(...args);
    landed = true;
    return result;
  });
  const recordWrite = internals.recordWrite.bind(mounted.view);
  vi.spyOn(internals, 'recordWrite').mockImplementation((file, write) => {
    recordWrite(file, write);
    if (found.newestBefore === null || found.recorded !== null || inFlight === null) return;
    found.movedBeforeRecord = view.epoch !== inFlight;
    found.recorded = view.ownWrites.some(own => (own as { after: string }).after === write.after);
    found.beforeAnswer = !answered;
  });
  rename(mounted, '子1', 0, '改名後');
  await vi.waitFor(() => { expect(found.landedIn).not.toBeNull(); }, { timeout: 3000, interval: 2 });
  return found;
}

/**
 * The second write landed inside a read of the text on screen that nothing else had superseded, the map recorded
 * it before that read answered, the epoch had moved by then, and the read gave up: the window of the ticket, closed
 * by the epoch.
 */
function expectWindowHit(found: Found): void {
  expect(found).toEqual({ landedIn: true, newestBefore: true, recorded: true, beforeAnswer: true, movedBeforeRecord: true, gaveUp: true });
}

function expectFolded(mounted: MountedMapView, label: string, index: number, id: string): void {
  const view = state(mounted);
  expect({ collapsed: [...view.collapsed], at: nodeNamed(mounted, label, index).dataset.nodeId }).toEqual({ collapsed: [id], at: id });
  expect(Notice.log).toEqual([]);
}

const SHAPES = [
  { shape: '空題名 (the second)', label: EMPTY_LABEL, index: 1 },
  { shape: '同名 (the second)', label: '同名', index: 1 },
] as const;

describe('a read of the text on screen, with a write of the map\'s own recorded while it reads (LEV-218)', () => {
  for (const { shape, label, index } of SHAPES) {
    it(`⌥↑ on 子2 (this map's next key) during the rename's last re-read keeps the fold of ${shape}`, async () => {
      const mounted = await mount();
      const id = foldAndSelect(mounted, label, index);
      const found = await renameThen(mounted, () => {
        click(nodeNamed(mounted, '子2'));
        mounted.key(mounted.canvas, 'ArrowUp', { altKey: true });
      });
      await settled(mounted);
      expectWindowHit(found);
      expect(mounted.source()).toContain('  - 子2\n  - 改名後\n');
      expectFolded(mounted, label, index, id);
    });

    it(`⌘Z (this map) during the rename's last re-read keeps the fold of ${shape}`, async () => {
      const mounted = await mount();
      const id = foldAndSelect(mounted, label, index);
      const found = await renameThen(mounted, () => {
        mounted.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }));
      });
      await settled(mounted);
      expectWindowHit(found);
      expect(mounted.source()).toBe(SOURCE);
      expectFolded(mounted, label, index, id);
    });

    it(`a layout button pressed during the rename's last re-read keeps the fold of ${shape}`, async () => {
      const mounted = await mount();
      const id = foldAndSelect(mounted, label, index);
      const found = await renameThen(mounted, () => { clickLayout(mounted, 'timeline'); });
      await settled(mounted);
      expectWindowHit(found);
      expect(mounted.source()).toContain('mappy-layout: timeline\n');
      expect(mounted.source()).toContain('- 改名後\n');
      expectFolded(mounted, label, index, id);
    });

    it(`another map's layout button during the rename's last re-read keeps the fold of ${shape}`, async () => {
      const mounted = await mount();
      const other = await mount(mounted.app, storeOf(mounted));
      const id = foldAndSelect(mounted, label, index);
      const found = await renameThen(mounted, () => { clickLayout(other, 'hierarchy'); });
      await settled(mounted, other);
      expectWindowHit(found);
      expect(mounted.source()).toContain('mappy-layout: hierarchy\n');
      expectFolded(mounted, label, index, id);
    });

    it(`another map's edit during the rename's last re-read keeps the fold of ${shape}`, async () => {
      // The other map moves 子2 up (⌥↑, as E58): an edit whose start is the text this map shows.
      const mounted = await mount();
      const other = await mount(mounted.app, storeOf(mounted));
      const id = foldAndSelect(mounted, label, index);
      // The other map has re-read the rename by then (its reads are not slowed): an edit planned on the note before it
      // would be refused as someone else's change, which is not this row.
      let caughtUp: boolean | null = null;
      const found = await renameThen(mounted, () => {
        caughtUp = state(other).document?.source === mounted.source();
        click(nodeNamed(other, '子2'));
        other.key(other.canvas, 'ArrowUp', { altKey: true });
      });
      await settled(mounted, other);
      expect(caughtUp).toBe(true);
      expectWindowHit(found);
      expect(mounted.source()).toContain('  - 子2\n  - 改名後\n');
      expectFolded(mounted, label, index, id);
    });

    it(`another map's ⌘Z (the shared history) during the rename's last re-read keeps the fold of ${shape}`, async () => {
      // The store keeps one history per note: ⌘Z in the other map takes back this map's rename, and this map only hears it.
      const mounted = await mount();
      const other = await mount(mounted.app, storeOf(mounted));
      const id = foldAndSelect(mounted, label, index);
      const found = await renameThen(mounted, () => {
        other.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }));
      });
      await settled(mounted, other);
      expectWindowHit(found);
      expect(mounted.source()).toBe(SOURCE);
      expectFolded(mounted, label, index, id);
    });
  }
});

describe('the same window with the note\'s watcher arriving after the store has told the map (LEV-218)', () => {
  // The rows above hold by the order: the watcher moves the epoch before the map records W2, and the read gives up.
  // Here that order is broken — `modify` reaches the maps LATE_MS late, after the read answers, as it would on an
  // Obsidian whose `modify` came after `vault.process` resolved — so the read goes on with the text on screen and W2
  // on its record. A read of the text on screen keeps the record (`reread`): W2's own re-read, when its watcher comes,
  // still carries every id. With the record dropped on such a read (before the fix) these rows fail
  // (`artifacts/lev-218-reread-own-writes/tests-late-unfixed.log`); the rows above do not, which is why these exist.
  function expectLateWindow(found: Found): void {
    expect(found).toEqual({ landedIn: true, newestBefore: true, recorded: true, beforeAnswer: true, movedBeforeRecord: false, gaveUp: false });
  }

  for (const { shape, label, index } of SHAPES) {
    it(`a layout button pressed during the rename's last re-read keeps the fold of ${shape}`, async () => {
      const mounted = await mount();
      const id = foldAndSelect(mounted, label, index);
      const found = await renameThen(mounted, () => { clickLayout(mounted, 'timeline'); }, { late: true });
      await settled(mounted);
      expectLateWindow(found);
      expect(mounted.source()).toContain('mappy-layout: timeline\n');
      expectFolded(mounted, label, index, id);
    });

    it(`another map's layout button during the rename's last re-read keeps the fold of ${shape}`, async () => {
      const mounted = await mount();
      const other = await mount(mounted.app, storeOf(mounted));
      const id = foldAndSelect(mounted, label, index);
      const found = await renameThen(mounted, () => { clickLayout(other, 'hierarchy'); }, { late: true });
      await settled(mounted, other);
      expectLateWindow(found);
      expect(mounted.source()).toContain('mappy-layout: hierarchy\n');
      expectFolded(mounted, label, index, id);
    });

    it(`another map's edit during the rename's last re-read keeps the fold of ${shape}`, async () => {
      const mounted = await mount();
      const other = await mount(mounted.app, storeOf(mounted));
      const id = foldAndSelect(mounted, label, index);
      let caughtUp: boolean | null = null;
      const found = await renameThen(mounted, () => {
        caughtUp = state(other).document?.source === mounted.source();
        click(nodeNamed(other, '子2'));
        other.key(other.canvas, 'ArrowUp', { altKey: true });
      }, { late: true });
      await settled(mounted, other);
      expect(caughtUp).toBe(true);
      expectLateWindow(found);
      expect(mounted.source()).toContain('  - 子2\n  - 改名後\n');
      expectFolded(mounted, label, index, id);
    });

    it(`another map's ⌘Z during the rename's last re-read keeps the fold of ${shape}`, async () => {
      const mounted = await mount();
      const other = await mount(mounted.app, storeOf(mounted));
      const id = foldAndSelect(mounted, label, index);
      const found = await renameThen(mounted, () => {
        other.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }));
      }, { late: true });
      await settled(mounted, other);
      expectLateWindow(found);
      expect(mounted.source()).toBe(SOURCE);
      expectFolded(mounted, label, index, id);
    });
  }
});

describe('a write taken back by someone else before the map re-read it (LEV-218, code review 1)', () => {
  // A read of the text on screen keeps only the writes recorded while it was under way. One recorded before it began
  // was there for the read to find; finding the text on screen instead means someone put the note back (Undo in the
  // Markdown pane, a sync), and kept, that write would stand at the end of the record, so the map's next own write —
  // whose start is the text on screen, not that write's end — could not be recorded, nor shown at once, and its
  // re-read would match nodes by title: with the twin before it renamed, the folded node would take the twin's id. With
  // every write kept on such a read, these rows fail
  // (`artifacts/lev-218-reread-own-writes/tests-aba-keep-all.log`).
  for (const { shape, label, index } of SHAPES) {
    it(`a rename of the twin before ${shape} after another map's move was put back keeps its fold`, async () => {
      const mounted = await mount();
      const other = await mount(mounted.app, storeOf(mounted));
      const id = foldAndSelect(mounted, label, index);
      click(nodeNamed(other, '子2'));
      other.key(other.canvas, 'ArrowUp', { altKey: true });
      // Put back the moment it lands, before either map's watcher re-reads it (45 ms).
      await vi.waitFor(() => { expect(mounted.source()).not.toBe(SOURCE); }, { timeout: 1000, interval: 1 });
      expect(state(mounted).ownWrites).toHaveLength(1);
      mounted.app.put(PATH, SOURCE);
      await settled(mounted, other);
      expect(state(mounted).document?.source).toBe(SOURCE);
      // Its twin before it renamed: matched by titles alone, the folded node would take the twin's id.
      rename(mounted, label, index - 1, '命名');
      await vi.waitFor(() => { expect(mounted.source()).toContain('命名'); }, { timeout: 1000, interval: 2 });
      await settled(mounted, other);
      expectFolded(mounted, label, index - 1, id);
    });

    it(`a layout button pressed while the map re-reads the put-back note keeps the fold of ${shape}`, async () => {
      // The write taken back is still at the end of the record while the re-read of the put-back note reads: the button
      // pressed meanwhile starts from the text on screen, not from that write's end, and must be recorded all the same
      // (it replaces the record). Refused, its re-read would match nodes by title and the fold would go (LEV-150).
      const mounted = await mount();
      const other = await mount(mounted.app, storeOf(mounted));
      const id = foldAndSelect(mounted, label, index);
      click(nodeNamed(other, '子2'));
      other.key(other.canvas, 'ArrowUp', { altKey: true });
      await vi.waitFor(() => { expect(mounted.source()).not.toBe(SOURCE); }, { timeout: 1000, interval: 1 });
      // The re-read of the put-back note is answered SLOW_MS late, and the button is pressed INSIDE_MS into it.
      const view = state(mounted);
      const store = storeOf(mounted);
      const read = store.read.bind(store);
      let pressed: { stale: boolean; recorded: boolean | null; answered: boolean } | null = null;
      let slowed = false;
      let answered = false;
      vi.spyOn(store, 'read').mockImplementation(async file => {
        const text = await read(file);
        if (slowed || text !== SOURCE || view.document?.source !== SOURCE) return text;
        slowed = true;
        setTimeout(() => {
          pressed = { stale: view.ownWrites.length === 1, recorded: null, answered: false };
          clickLayout(mounted, 'timeline');
        }, INSIDE_MS);
        await new Promise(resolve => setTimeout(resolve, SLOW_MS));
        answered = true;
        return text;
      });
      const internals = mounted.view as unknown as { recordWrite(file: unknown, write: { after: string }): void };
      const recordWrite = internals.recordWrite.bind(mounted.view);
      vi.spyOn(internals, 'recordWrite').mockImplementation((file, write) => {
        recordWrite(file, write);
        if (pressed && pressed.recorded === null && write.after.includes('mappy-layout: timeline')) {
          pressed = { ...pressed, answered, recorded: view.ownWrites.some(own => (own as { after: string }).after === write.after) };
        }
      });
      mounted.app.put(PATH, SOURCE);
      await vi.waitFor(() => { expect(pressed?.recorded).not.toBeNull(); }, { timeout: 2000, interval: 2 });
      await settled(mounted, other);
      // The stale write was still there when the button was pressed, the read had not answered when the store told the
      // map, and the map recorded the button's write.
      expect(pressed).toEqual({ stale: true, answered: false, recorded: true });
      expect(mounted.source()).toContain('mappy-layout: timeline\n');
      expectFolded(mounted, label, index, id);
    });
  }

  it('a read of the text on screen keeps only writes that lead on from it', async () => {
    // White-box: the record is [W1: S→A] when the read begins, W2 (A→B) is recorded while it reads, and the read finds S
    // (someone put the note back). W1 goes (recorded before the read), and W2 with it: kept, it would start the record
    // at A, a text the map does not show, and no write made on the text on screen could follow it.
    const mounted = await mount();
    const view = state(mounted);
    const internals = mounted.view as unknown as {
      recordWrite(file: unknown, write: { before: string; after: string; edits: unknown[] }): void; refresh(): Promise<void>;
    };
    const a = SOURCE.replace('  - 子2\n', '  - 子二\n');
    const b = a.replace('  - 子1\n', '  - 子一\n');
    internals.recordWrite(mounted.file, { before: SOURCE, after: a, edits: [] });
    expect(view.ownWrites).toHaveLength(1);
    const store = storeOf(mounted);
    const read = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation(async file => {
      internals.recordWrite(mounted.file, { before: a, after: b, edits: [] });
      expect(view.ownWrites).toHaveLength(2);
      return read(file);
    });
    await internals.refresh();
    expect(view.document?.source).toBe(SOURCE);
    expect(view.ownWrites).toEqual([]);
  });
});
