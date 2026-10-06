// @vitest-environment jsdom
/**
 * LEV-230: a title draft open (F2, neither Enter nor Escape) when the window reloads (`app:reload`) or Obsidian quits.
 * Neither goes through the view's `onClose` (LEV-215). Obsidian 1.14.2 on a reload sends the page `beforeunload`,
 * `pagehide` and `unload` and nothing else: no `quit`, no blur. Through 0.3.9 the draft was lost without a word. A quit
 * saved it only by accident: the window's blur after `unload` started the draft's blur save, whose write happened to
 * land (artifacts/lev-230).
 *
 * The rows are the way out × the draft's shape. A reload cannot write the note (a write started at `pagehide` empties
 * the file: artifacts/lev-230), so the draft is planned as its edit at `pagehide` and kept in the vault's
 * `localStorage`, and the reloaded plugin applies it through the store, checked against the note it was planned on.
 * A quit sends `pagehide` too and takes the same way (a quit task would keep Obsidian running on macOS).
 * A draft not written stays kept and is reported at every load (LEV-240, the last block).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { installObsidianDom } from '../browser-harness/dom';
import { HarnessApp } from '../browser-harness/app';
import { Component, Notice } from '../browser-harness/obsidian';
import { DocumentStore } from '../../src/obsidian/document-store';
import { setLanguage, t } from '../../src/i18n';
import { installExitDrafts, EXIT_DRAFTS_KEY } from '../../src/ui/exit-drafts';
import { applyEdits } from '../../src/core/commands';
import { textFingerprint, type ExitDraft } from '../../src/core/exit-drafts';
import {
  EXIT_BACKUP_LIMIT, appliedName, backupId, backupText, makeExitBackup, preparedName, readExitBackup, utf8Bytes,
} from '../../src/core/exit-backup';
import { ExitBackupStore, exitBackupFolder, type BackupAdapter } from '../../src/obsidian/exit-backup-store';
import { rescueExitDrafts } from '../../src/ui/exit-draft-recovery';
import type { MindmapView } from '../../src/ui/mindmap-view';
import { mountMapView, type MountedMapView } from './map-view-mount';
import { closeOpenViews } from '../mocks/open-views';

vi.mock('obsidian', () => import('../browser-harness/obsidian'));
beforeAll(() => { installObsidianDom(); });

const PATH = 'Fixtures/exit-draft.md';
const SOURCE = ['---', 'mappy: true', '---', '## 下書き', '', '- 親', '  - 子ノード', '- 別のノード', ''].join('\n');
const renamed = (title: string, from = SOURCE): string => from.replace('  - 子ノード\n', `  - ${title}\n`);

/** The plugin's folder, where the backups go (`exit-backups/`). */
const PLUGIN = '.config/plugins/mappy';
const BACKUPS = exitBackupFolder(PLUGIN);
type Step = 'exists' | 'stat' | 'list' | 'read' | 'write' | 'rename' | 'mkdir';

/**
 * The disk under the plugin's folder, kept across a reload as the vault's files are, through the adapter's part the
 * backups use (`HarnessApp` has no adapter). A row can make a step fail, and nothing on it is ever deleted.
 */
class Disk {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>([PLUGIN]);
  readonly calls: string[] = [];
  fault: (step: Step, path: string) => Error | null = () => null;
  /** What a read gives back for a path holding `text`. */
  readBack = (_path: string, text: string): string => text;
  private run<T>(step: Step, path: string, body: () => T): Promise<T> {
    this.calls.push(`${step} ${path}`);
    const error = this.fault(step, path);
    if (error) return Promise.reject(error);
    try { return Promise.resolve(body()); } catch (thrown) { return Promise.reject(thrown instanceof Error ? thrown : new Error(String(thrown))); }
  }
  readonly adapter: BackupAdapter = {
    exists: path => this.run('exists', path, () => this.files.has(path) || this.folders.has(path)),
    stat: path => this.run('stat', path, () => this.folders.has(path) ? { type: 'folder' as const, ctime: 0, mtime: 0, size: 0 }
      : this.files.has(path) ? { type: 'file' as const, ctime: 0, mtime: 0, size: utf8Bytes(this.files.get(path)!) } : null),
    list: path => this.run('list', path, () => {
      const under = (item: string) => item.startsWith(`${path}/`) && !item.slice(path.length + 1).includes('/');
      return { files: [...this.files.keys()].filter(under), folders: [...this.folders].filter(under) };
    }),
    read: path => this.run('read', path, () => { const text = this.files.get(path); if (text === undefined) throw new Error('ENOENT'); return this.readBack(path, text); }),
    write: (path, data) => this.run('write', path, () => { this.files.set(path, data); }),
    rename: (from, to) => this.run('rename', from, () => {
      const text = this.files.get(from);
      if (text === undefined || this.files.has(to)) throw new Error(`rename ${from} ${to}`);
      this.files.delete(from);
      this.files.set(to, text);
    }),
    mkdir: path => this.run('mkdir', path, () => { this.folders.add(path); }),
  };
  /** The names in the backup folder. */
  names(): string[] { return [...this.files.keys()].filter(path => path.startsWith(`${BACKUPS}/`)).map(path => path.slice(BACKUPS.length + 1)).sort(); }
}
let disk = new Disk();

const owners: Component[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const owner of owners.splice(0)) owner.unload();
  // The views a reload left behind (no `onClose` on a reload) are closed too, after the test has read everything: their
  // title drafts went at `pagehide` (`takeExitDraft`), so the close saves nothing and says nothing, and their timers stop
  // (LEV-239: checked with the store's writes and `Notice.log` watched across this close in every test; the one write
  // is the kept page's, whose draft stays open and is saved on close as LEV-215 decided, as it was before LEV-239).
  await closeOpenViews();
  Notice.log.length = 0;
  window.localStorage.clear();
  document.body.replaceChildren();
  disk = new Disk();
});

/**
 * The plugin's part (src/main.ts): the handlers on the page, for the views open on it, with the backups on `disk` (one
 * store per load, as the plugin makes one, unless a row shares its own with the rescue command).
 */
function install(app: HarnessApp, store: DocumentStore, views: () => readonly MindmapView[], backups = new ExitBackupStore(disk.adapter, BACKUPS, '0.4.6')): Component {
  const owner = new Component();
  owner.load();
  owners.push(owner);
  idle = installExitDrafts(owner as never, app.asApp<App>(), store, backups, views);
  return owner;
}

/** When the pass the last `install` started is over (`installExitDrafts`'s answer). */
let idle: () => Promise<void> = () => Promise.resolve();

/** A map with F2 on 「子ノード」 and `title` typed, and the plugin's handlers installed for it. */
async function draft(title: string, source = SOURCE): Promise<{ mounted: MountedMapView; input: HTMLTextAreaElement; owner: Component }> {
  const mounted = await mountMapView(PATH, source);
  const store = (mounted.view as unknown as { store: DocumentStore }).store;
  const owner = install(mounted.app, store, () => [mounted.view]);
  mounted.key(mounted.select('子ノード'), 'F2');
  await mounted.settle();
  const input = mounted.editor();
  if (!input) throw new Error('F2 did not open the draft');
  input.value = title;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return { mounted, input, owner };
}

/**
 * The page goes as `app:reload` takes it: `pagehide` and nothing more reaches the page (no close, no blur), and the
 * view is gone with it. What the vault holds then is what the reloaded page starts from; the plugin loads again on
 * it and its layout is ready. Resolves to the reloaded vault.
 */
async function reload(mounted: MountedMapView, owner: Component, prepare?: (app: HarnessApp, store: DocumentStore) => void): Promise<HarnessApp> {
  window.dispatchEvent(new Event('pagehide'));
  const left = mounted.source();
  owner.unload();
  mounted.view.containerEl.remove();
  const app = new HarnessApp();
  app.put(PATH, left);
  const store = new DocumentStore(app.asApp<App>());
  prepare?.(app, store);
  install(app, store, () => []);
  await rounds();
  return app;
}

/** Enough turns of the event loop for the kept drafts to be applied. */
async function rounds(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
  // The backups' hashing and file steps (LEV-309) take turns of their own: the pass is waited for, not counted.
  await idle();
  for (let round = 0; round < 2; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
}

/** Another load of the plugin on the same vault (the next reload): the kept drafts are tried again. */
async function loadAgain(app: HarnessApp): Promise<void> {
  install(app, new DocumentStore(app.asApp<App>()), () => []);
  await rounds();
}

const noteOf = (app: HarnessApp): string => app.content(app.asApp<App>().vault.getFileByPath(PATH)!);

/**
 * The Notice for a kept draft not written: what was typed and where, why, then what is kept (`tail`). Japanese sentences
 * follow one another with no space after 「。」; a reason without one (a test's `x`) is followed by a space, an empty one
 * adds nothing (as `joinSentences`).
 */
const notWritten = (tail: 'exitKeptSource' | 'exitKeptEdits' | 'exitKeptRefused' | 'exitKeepUnconfirmed', title: string, note: string, reason: string): string =>
  `${t().exitDraftNotWritten(title, note)}${reason}${reason === '' || reason.endsWith('。') ? '' : ' '}${tail === 'exitKeepUnconfirmed' ? t().exitKeepUnconfirmed : t()[tail](t().cmdRescueDrafts)}`;

/** The Notice a kept draft's write shows once, with the backup it left first (LEV-309). */
const wrote = (title: string, note = PATH): string => t().exitWrittenWithBackup(title, note, t().cmdRescueDrafts);

/** Obsidian's `Tasks` (`workspace.on('quit')`): what a handler adds, awaited before the window closes. */
class Tasks {
  readonly promises: Promise<unknown>[] = [];
  add(callback: () => Promise<unknown>): void { this.promises.push(callback()); }
  addPromise(promise: Promise<unknown>): void { this.promises.push(promise); }
  isEmpty(): boolean { return this.promises.length === 0; }
  promise(): Promise<unknown> { return Promise.all(this.promises); }
}

describe('a title draft open when the window reloads (LEV-230)', () => {
  it('is in the note after the reload', async () => {
    const { mounted, owner } = await draft('再読込の前の下書き');
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(renamed('再読込の前の下書き'));
    expect(Notice.log).toEqual([wrote('再読込の前の下書き')]);
  });

  it('writes nothing at pagehide itself (a write started there can empty the note)', async () => {
    const { mounted } = await draft('書かずに預ける下書き');
    window.dispatchEvent(new Event('pagehide'));
    await mounted.settle();
    expect(mounted.source()).toBe(SOURCE);
  });

  it('is saved as the draft showed it mid IME composition', async () => {
    const { mounted, input, owner } = await draft('子ノード');
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.value = 'へんかんちゅう';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(renamed('へんかんちゅう'));
    expect(Notice.log).toEqual([wrote('へんかんちゅう')]);
  });

  it('keeps line breaks typed in the draft as the save writes them', async () => {
    const { mounted, owner } = await draft('一行目\n二行目');
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(renamed('一行目<br>二行目'));
  });

  it('applies a draft held after the note was re-read, as its Enter would', async () => {
    const { mounted, input, owner } = await draft('再読込のあとの下書き');
    const other = SOURCE.replace('- 別のノード\n', '- 外で書き足した\n');
    const silent = vi.spyOn(mounted.app.vaultEvents, 'trigger').mockImplementation(() => undefined);
    mounted.app.put(PATH, other);
    silent.mockRestore();
    mounted.key(input, 'Enter');
    await new Promise(resolve => setTimeout(resolve, 200));
    await mounted.settle();
    expect(mounted.view.containerEl.querySelector('.mappy-inline-error')?.textContent ?? '').toContain('もう一度確定すると');
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(renamed('再読込のあとの下書き', other));
    expect(Notice.log).toEqual([wrote('再読込のあとの下書き')]);
  });

  it('leaves the note and says which draft was not saved when its node changed outside the map', async () => {
    const { mounted, input, owner } = await draft('外で変わったノードの下書き');
    const external = SOURCE.replace('  - 子ノード\n', '  - 外で書き換えた\n');
    mounted.app.put(PATH, external);
    await new Promise(resolve => setTimeout(resolve, 100));
    await mounted.settle();
    mounted.key(input, 'Enter');
    await mounted.settle();
    expect(mounted.view.containerEl.querySelector('.mappy-inline-error')?.textContent).toBe(t().draftChanged);
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(external);
    expect(Notice.log).toEqual([notWritten('exitKeptRefused', '外で変わったノードの下書き', PATH, t().draftChanged)]);
  });

  // Review 1: the kept edit was checked against the exact note it was planned on, so any change elsewhere in the
  // meantime dropped it.
  it('applies over another line changed while the window reloaded', async () => {
    const { mounted, owner } = await draft('間に変わったノートの下書き');
    window.dispatchEvent(new Event('pagehide'));
    const changed = SOURCE.replace('- 別のノード\n', '- 再読込の間に足した\n');
    mounted.app.put(PATH, changed);
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(renamed('間に変わったノートの下書き', changed));
    expect(Notice.log).toEqual([wrote('間に変わったノートの下書き')]);
  });

  it('leaves the note and says so when the node itself changed while the window reloaded', async () => {
    const { mounted, owner } = await draft('間に変わったノードの下書き');
    window.dispatchEvent(new Event('pagehide'));
    const changed = SOURCE.replace('  - 子ノード\n', '  - 子ノード（外で）\n');
    mounted.app.put(PATH, changed);
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(changed);
    expect(Notice.log).toEqual([notWritten('exitKeptSource', '間に変わったノードの下書き', PATH, t().exitNoteChanged)]);
  });

  // Review 1: a change the map had not read yet (within the re-read's debounce) made the kept edit's note stale.
  it('applies over another line changed outside the map that it had not read when the page went', async () => {
    const { mounted, owner } = await draft('読む前に再読込した下書き');
    const other = SOURCE.replace('- 別のノード\n', '- 外で書き足した\n');
    const silent = vi.spyOn(mounted.app.vaultEvents, 'trigger').mockImplementation(() => undefined);
    mounted.app.put(PATH, other);
    silent.mockRestore();
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(renamed('読む前に再読込した下書き', other));
    expect(Notice.log).toEqual([wrote('読む前に再読込した下書き')]);
  });

  // Review 1: two maps of one note each with a draft; the first applied made the second's note stale.
  it('applies the drafts of two maps of the same note on different nodes', async () => {
    const first = await mountMapView(PATH, SOURCE);
    const store = (first.view as unknown as { store: DocumentStore }).store;
    const second = await mountMapView(PATH, SOURCE, 'mindmap', first.app, { store });
    const owner = install(first.app, store, () => [first.view, second.view]);
    for (const [mounted, node, title] of [[first, '子ノード', '一つ目のマップの下書き'], [second, '別のノード', '二つ目のマップの下書き']] as const) {
      mounted.key(mounted.select(node), 'F2');
      await mounted.settle();
      const input = mounted.editor()!;
      input.value = title;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    second.view.containerEl.remove();
    const app = await reload(first, owner);
    expect(noteOf(app)).toBe(renamed('一つ目のマップの下書き').replace('- 別のノード\n', '- 二つ目のマップの下書き\n'));
    // Only the second map's draft is kept: F2 in it took the focus, and the first's blur saved its draft (LEV-311).
    expect(Notice.log).toEqual([wrote('二つ目のマップの下書き')]);
  });

  // LEV-309, review 1: drafts of a note kept at once (a draft blur does not save, an error row's or one mid IME
  // composition, in one map, and one in another; E59's 9). The first renamed the last node of a note without a final
  // line break, which the next one's move took for the note's end cut off. Their edits are known, and each moves over
  // those before it (two pass before LEV-309 too, where the diff moved them, and fail with its guard alone; review 2:
  // a third matched neither earlier draft's `after`, and was refused again).
  it.each([2, 3])('applies %i kept drafts of a note when the first renames the last node of a note without a final line break', async (count) => {
    const bare = SOURCE.slice(0, -1);
    const at = (text: string) => bare.indexOf(text);
    const edits = [
      [{ from: at('別のノード'), to: bare.length, text: '一つ目の下書き' }],
      [{ from: at('子ノード'), to: at('子ノード') + 4, text: '二つ目の下書き' }],
      [{ from: at('親'), to: at('親') + 1, text: '三つ目の下書き' }],
    ].slice(0, count);
    const app = new HarnessApp();
    app.put(PATH, bare);
    app.saveLocalStorage(EXIT_DRAFTS_KEY, edits.map((planned, index) => ({
      path: PATH, title: `下書き${index}`, at: Date.now(), before: textFingerprint(bare), after: textFingerprint(applyEdits(bare, planned)), edits: planned, source: bare,
    })));
    await loadAgain(app);
    expect(noteOf(app)).toBe(applyEdits(bare, edits.flat()));
    expect(app.loadLocalStorage(EXIT_DRAFTS_KEY)).toBeNull();
    expect(Notice.log).toEqual(edits.map((_planned, index) => wrote(`下書き${index}`)));
  });

  // LEV-309, review 3: the first draft was written at an earlier load and the page went before the entry let it go. The
  // note has its edits as planned; the second draft moves over them, not by the diff, which took the last line renamed
  // to the very end for a cut.
  it('applies a kept draft over another draft of the note that the note has already', async () => {
    const bare = SOURCE.slice(0, -1);
    const at = (text: string) => bare.indexOf(text);
    const first = [{ from: at('別のノード'), to: bare.length, text: '一つ目の下書き' }];
    const second = [{ from: at('子ノード'), to: at('子ノード') + 4, text: '二つ目の下書き' }];
    const kept = (title: string, planned: typeof first) => ({
      path: PATH, title, at: Date.now(), before: textFingerprint(bare), after: textFingerprint(applyEdits(bare, planned)), edits: planned, source: bare,
    });
    const app = new HarnessApp();
    app.put(PATH, applyEdits(bare, first));
    app.saveLocalStorage(EXIT_DRAFTS_KEY, [kept('一つ目', first), kept('二つ目', second)]);
    await loadAgain(app);
    expect(noteOf(app)).toBe(applyEdits(bare, [...first, ...second]));
    expect(app.loadLocalStorage(EXIT_DRAFTS_KEY)).toBeNull();
    expect(Notice.log).toEqual([wrote('二つ目')]);
  });

  // Review 1: a page kept for coming back to (`persisted`) is not going; its draft stays open.
  it('keeps the draft open on a pagehide of a page that is kept', async () => {
    const { mounted } = await draft('残るページの下書き');
    const event = new Event('pagehide');
    Object.defineProperty(event, 'persisted', { value: true });
    window.dispatchEvent(event);
    expect(mounted.editor()).not.toBeNull();
    expect(mounted.app.loadLocalStorage(EXIT_DRAFTS_KEY)).toBeNull();
  });

  // Review 1: a page that went before applying what the page before it kept overwrote that.
  it('adds to drafts kept by an earlier page that were not applied yet', async () => {
    const { mounted, owner } = await draft('二度目の再読込の下書き');
    const earlier = [{ path: 'Fixtures/other.md', title: '前のページの下書き', at: Date.now(), refused: 'x' }];
    mounted.app.saveLocalStorage(EXIT_DRAFTS_KEY, earlier);
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(renamed('二度目の再読込の下書き'));
    expect(Notice.log).toEqual([notWritten('exitKeptRefused', '前のページの下書き', 'Fixtures/other.md', 'x'), wrote('二度目の再読込の下書き')]);
  });

  // Review 2: a draft kept for long (Mappy disabled for weeks, the note worked on elsewhere) was written unasked.
  it('does not write a draft kept for more than a day, and says so', async () => {
    const { mounted, owner } = await draft('古い下書き');
    window.dispatchEvent(new Event('pagehide'));
    const [kept] = mounted.app.loadLocalStorage(EXIT_DRAFTS_KEY) as { at: number }[];
    mounted.app.saveLocalStorage(EXIT_DRAFTS_KEY, [{ ...kept, at: Date.now() - 2 * 24 * 60 * 60 * 1000 }]);
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(SOURCE);
    expect(Notice.log).toEqual([notWritten('exitKeptSource', '古い下書き', PATH, t().exitDraftExpired)]);
  });

  // Review 2: a full localStorage dropped every draft, though they fit without the note texts.
  it('keeps the drafts without the note texts when they do not fit with them', async () => {
    const { mounted, owner } = await draft('容量の足りない下書き');
    const save = mounted.app.saveLocalStorage.bind(mounted.app);
    vi.spyOn(mounted.app, 'saveLocalStorage').mockImplementation((key: string, data: unknown) => {
      if (JSON.stringify(data ?? null).includes('"source"')) throw new DOMException('full', 'QuotaExceededError');
      save(key, data);
    });
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(renamed('容量の足りない下書き'));
    expect(Notice.log).toEqual([wrote('容量の足りない下書き')]);
  });

  // Review 2: a page that sends pagehide and is kept after all (a mobile WebView) lost the open draft until some later load.
  it('applies the kept draft at once when the page shows again', async () => {
    const { mounted } = await draft('戻ってきたページの下書き');
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pageshow'));
    for (let round = 0; round < 5; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
    await mounted.settle();
    expect(mounted.source()).toBe(renamed('戻ってきたページの下書き'));
    expect(mounted.app.loadLocalStorage(EXIT_DRAFTS_KEY)).toBeNull();
  });

  // Review 2: the entry dropped a draft before its write, so a page that went during the write lost it.
  it('keeps a draft in the entry until its write is done', async () => {
    const { mounted, owner } = await draft('書き込み中も残る下書き');
    window.dispatchEvent(new Event('pagehide'));
    const left = mounted.source();
    owner.unload();
    mounted.view.containerEl.remove();
    const app = new HarnessApp();
    app.put(PATH, left);
    const store = new DocumentStore(app.asApp<App>());
    let during: unknown = 'not written';
    const applyOver = store.applyOver.bind(store);
    vi.spyOn(store, 'applyOver').mockImplementation(async (...args: Parameters<DocumentStore['applyOver']>) => {
      during = app.loadLocalStorage(EXIT_DRAFTS_KEY);
      return applyOver(...args);
    });
    install(app, store, () => []);
    for (let round = 0; round < 5; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
    expect(Array.isArray(during) && during.length).toBe(1);
    expect(noteOf(app)).toBe(renamed('書き込み中も残る下書き'));
    expect(app.loadLocalStorage(EXIT_DRAFTS_KEY)).toBeNull();
  });

  // Review 3: pagehide closed the 本文・リンクを編集 modal too, and on a page kept after all (the pageshow path) the
  // body typed there was gone without a word. Only the title draft is taken.
  it('leaves the body modal open at pagehide', async () => {
    const mounted = await mountMapView(PATH, SOURCE);
    install(mounted.app, (mounted.view as unknown as { store: DocumentStore }).store, () => [mounted.view]);
    mounted.node('子ノード').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    const item = Array.from(document.querySelectorAll<HTMLElement>('.menu .menu-item'))
      .find(candidate => candidate.querySelector('.menu-item-title')?.textContent === t().editBody);
    if (!item) throw new Error('no 本文・リンクを編集 in the menu');
    item.click();
    await mounted.settle();
    const input = document.querySelector<HTMLTextAreaElement>('.modal .mappy-edit-input');
    if (!input) throw new Error('The body modal did not open');
    input.value = '残る本文';
    window.dispatchEvent(new Event('pagehide'));
    expect(document.contains(input)).toBe(true);
    expect(input.value).toBe('残る本文');
  });

  it('applies nothing once Mappy is unloaded, and leaves the rest for the next load', async () => {
    const app = new HarnessApp();
    app.put(PATH, SOURCE);
    const kept = [{ path: 'Fixtures/other.md', title: '後の読み込みへ', at: Date.now(), refused: 'x' }];
    app.saveLocalStorage(EXIT_DRAFTS_KEY, kept);
    // The layout becomes ready only after Mappy was unloaded (disabled or reloaded during startup).
    let ready: () => unknown = () => undefined;
    vi.spyOn(app.workspace, 'onLayoutReady').mockImplementation(callback => { ready = callback; });
    const owner = new Component();
    owner.load();
    installExitDrafts(owner as never, app.asApp<App>(), new DocumentStore(app.asApp<App>()), new ExitBackupStore(disk.adapter, BACKUPS, '0.4.6'), () => []);
    owner.unload();
    ready();
    for (let round = 0; round < 5; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
    expect(Notice.log).toEqual([]);
    expect(app.loadLocalStorage(EXIT_DRAFTS_KEY)).toEqual(kept);
  });

  it('says so when the note is gone after the reload', async () => {
    const { mounted, owner } = await draft('消えたノートの下書き');
    window.dispatchEvent(new Event('pagehide'));
    owner.unload();
    mounted.view.containerEl.remove();
    const app = new HarnessApp();
    install(app, new DocumentStore(app.asApp<App>()), () => []);
    for (let round = 0; round < 5; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
    expect(Notice.log).toEqual([notWritten('exitKeptSource', '消えたノートの下書き', PATH, t().exitNoteGone)]);
  });

  it('does nothing when the note already has the draft (a save that landed after all)', async () => {
    const { mounted, owner } = await draft('間に合った下書き');
    window.dispatchEvent(new Event('pagehide'));
    mounted.app.put(PATH, renamed('間に合った下書き'));
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(renamed('間に合った下書き'));
    expect(Notice.log).toEqual([]);
  });

  it('keeps nothing for a draft that would not change the note, and nothing without a draft', async () => {
    const { mounted, owner } = await draft('子ノード');
    window.dispatchEvent(new Event('pagehide'));
    expect(mounted.app.loadLocalStorage(EXIT_DRAFTS_KEY)).toBeNull();
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(SOURCE);
    expect(Notice.log).toEqual([]);
  });

  it('applies the kept draft once: the next reload does not apply or report it again', async () => {
    const { mounted, owner } = await draft('一度だけの下書き');
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(renamed('一度だけの下書き'));
    expect(app.loadLocalStorage(EXIT_DRAFTS_KEY)).toBeNull();
    app.put(PATH, SOURCE);
    install(app, new DocumentStore(app.asApp<App>()), () => []);
    for (let round = 0; round < 5; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
    expect(noteOf(app)).toBe(SOURCE);
    expect(Notice.log).toEqual([wrote('一度だけの下書き')]);
  });

  it('ignores what it cannot read as kept drafts', async () => {
    const app = new HarnessApp();
    app.put(PATH, SOURCE);
    const unreadable = [{ path: PATH, title: 1 }, 'x', { path: PATH, title: 'a', before: 'b', after: 'c', edits: [{ from: 'x' }] }];
    app.saveLocalStorage(EXIT_DRAFTS_KEY, unreadable);
    install(app, new DocumentStore(app.asApp<App>()), () => []);
    for (let round = 0; round < 5; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
    expect(noteOf(app)).toBe(SOURCE);
    expect(Notice.log).toEqual([]);
    // LEV-309: left as it is (it was taken out before), so nothing it may hold goes unasked.
    expect(app.loadLocalStorage(EXIT_DRAFTS_KEY)).toEqual(unreadable);
  });
});

describe('a title draft open when Obsidian quits (LEV-230)', () => {
  // A task would make Obsidian wait, and waiting cancels the quit: on macOS only the window closes, and Obsidian keeps
  // running with no window (seen on the real app with the build that added one). Quitting also sends `pagehide`.
  it('adds no task to the quit, and the draft kept at pagehide is in the note at the next launch', async () => {
    const { mounted, owner } = await draft('終了の前の下書き');
    const tasks = new Tasks();
    mounted.app.workspaceEvents.trigger('quit', tasks);
    expect(tasks.isEmpty()).toBe(true);
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(renamed('終了の前の下書き'));
    expect(Notice.log).toEqual([wrote('終了の前の下書き')]);
  });

  // On a quit the window's blur comes after `unload` (artifacts/lev-230), and the draft's blur save (LEV-216) started a
  // write there that the page's end can cut after the file was emptied.
  it('starts no save on the blur that follows pagehide', async () => {
    const { mounted, input } = await draft('後から blur が来た下書き');
    const applyOver = vi.spyOn((mounted.view as unknown as { store: DocumentStore }).store, 'applyOver');
    window.dispatchEvent(new Event('pagehide'));
    input.dispatchEvent(new FocusEvent('blur'));
    await mounted.settle();
    expect(applyOver).not.toHaveBeenCalled();
    expect(mounted.source()).toBe(SOURCE);
    expect(mounted.editor()).toBeNull();
  });
});

/**
 * LEV-240: a draft the next load could not write was dropped from the entry as its Notice showed, the note's text it
 * held (the only copy, when the note was left empty by a write cut off as the page went) with it. Now only a draft
 * written, or one the note has already, leaves the entry; any other stays as it was kept, is tried again at every load,
 * and its Notice says what is kept and how to save it to a separate file. The rows are the ways a draft is not written.
 */
describe('a kept draft that could not be written (LEV-240)', () => {
  const keptOf = (app: HarnessApp): unknown => app.loadLocalStorage(EXIT_DRAFTS_KEY);

  /** F2 on 「子ノード」, `title` typed, then `pagehide`: the vault and what the page kept. */
  async function keep(title: string): Promise<{ mounted: MountedMapView; owner: Component; kept: unknown[] }> {
    const { mounted, owner } = await draft(title);
    window.dispatchEvent(new Event('pagehide'));
    const kept = mounted.app.loadLocalStorage(EXIT_DRAFTS_KEY) as unknown[];
    if (!Array.isArray(kept) || kept.length !== 1) throw new Error('pagehide did not keep the draft');
    return { mounted, owner, kept };
  }

  it('keeps a draft whose node changed meanwhile as it was, with its note text, and says so', async () => {
    const { mounted, owner, kept } = await keep('間に変わったノードの下書き');
    const changed = SOURCE.replace('  - 子ノード\n', '  - 子ノード（外で）\n');
    mounted.app.put(PATH, changed);
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(changed);
    expect(keptOf(app)).toEqual(kept);
    expect((kept[0] as { source?: string }).source).toBe(SOURCE);
    expect(Notice.log).toEqual([notWritten('exitKeptSource', '間に変わったノードの下書き', PATH, t().exitNoteChanged)]);
  });

  // The shape s2-m1 of the investigation left (REPORT.md): the note emptied by a write cut off as the page went.
  it('keeps the draft and the note text it was planned on when the note was left empty', async () => {
    const { mounted, owner, kept } = await keep('空になったノートの下書き');
    mounted.app.put(PATH, '');
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe('');
    expect(keptOf(app)).toEqual(kept);
    expect(Notice.log).toEqual([notWritten('exitKeptSource', '空になったノートの下書き', PATH, t().exitNoteChanged)]);
  });

  // LEV-309: the shape the investigation did not see, a write cut off with the first part of the note left. The lost
  // end is clear of the rename before it, so the rename was written over what was left, and the draft holding the
  // note's text went, with no Notice.
  it('keeps the draft and the note text it was planned on when only the first part of the note was left', async () => {
    const { mounted, owner, kept } = await keep('前半だけ残ったノートの下書き');
    // A few characters into the line after the edited one (cut just after the edited line, the change touches the edit
    // and was refused already); then what a write putting a line in there left, longer than the note was.
    const midLine = SOURCE.slice(0, SOURCE.indexOf('- 別のノード') + 3);
    const longer = SOURCE.replace('- 別のノード\n', '- 足しかけた\n- 別のノード\n').slice(0, -2);
    mounted.app.put(PATH, midLine);
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(midLine);
    expect(keptOf(app)).toEqual(kept);
    expect((kept[0] as { source?: string }).source).toBe(SOURCE);
    const notice = notWritten('exitKeptSource', '前半だけ残ったノートの下書き', PATH, t().exitNoteChanged);
    expect(Notice.log).toEqual([notice]);
    app.put(PATH, longer);
    await loadAgain(app);
    expect(noteOf(app)).toBe(longer);
    expect(keptOf(app)).toEqual(kept);
    expect(Notice.log).toEqual([notice, notice]);
  });

  it('keeps a draft that could not be planned (refused) and says only its title and reason are kept', async () => {
    const { mounted, input, owner } = await draft('計画できなかった下書き');
    const external = SOURCE.replace('  - 子ノード\n', '  - 外で書き換えた\n');
    mounted.app.put(PATH, external);
    await new Promise(resolve => setTimeout(resolve, 100));
    await mounted.settle();
    mounted.key(input, 'Enter');
    await mounted.settle();
    window.dispatchEvent(new Event('pagehide'));
    const kept = mounted.app.loadLocalStorage(EXIT_DRAFTS_KEY);
    expect(kept).toEqual([expect.objectContaining({ refused: t().draftChanged })]);
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(external);
    expect(keptOf(app)).toEqual(kept);
    expect(Notice.log).toEqual([notWritten('exitKeptRefused', '計画できなかった下書き', PATH, t().draftChanged)]);
  });

  it('keeps a draft whose note is gone', async () => {
    const { mounted, owner, kept } = await keep('消えたノートに残る下書き');
    owner.unload();
    mounted.view.containerEl.remove();
    const app = new HarnessApp();
    await loadAgain(app);
    expect(keptOf(app)).toEqual(kept);
    expect(Notice.log).toEqual([notWritten('exitKeptSource', '消えたノートに残る下書き', PATH, t().exitNoteGone)]);
  });

  it('keeps a draft kept for more than a day, its time unchanged, without writing it', async () => {
    const { mounted, owner, kept } = await keep('一日を過ぎて残る下書き');
    const old = [{ ...(kept[0] as object), at: Date.now() - 2 * 24 * 60 * 60 * 1000 }];
    mounted.app.saveLocalStorage(EXIT_DRAFTS_KEY, old);
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(SOURCE);
    expect(keptOf(app)).toEqual(old);
    expect(Notice.log).toEqual([notWritten('exitKeptSource', '一日を過ぎて残る下書き', PATH, t().exitDraftExpired)]);
  });

  it('keeps a draft whose write the store refused', async () => {
    const { mounted, owner, kept } = await keep('書き込みを拒否された下書き');
    const app = await reload(mounted, owner, (_app, store) => {
      vi.spyOn(store, 'applyOver').mockRejectedValue(new Error('書き込みが拒否されました。'));
    });
    expect(noteOf(app)).toBe(SOURCE);
    expect(keptOf(app)).toEqual(kept);
    expect(Notice.log).toEqual([notWritten('exitKeptSource', '書き込みを拒否された下書き', PATH, `書き込みが拒否されました。${t().exitBackupLeftPrepared}`)]);
  });

  it('says the note text is not kept for a draft kept without it', async () => {
    const { mounted, owner, kept } = await keep('原文なしで残る下書き');
    const bare = { ...(kept[0] as object) } as { source?: string };
    delete bare.source;
    mounted.app.saveLocalStorage(EXIT_DRAFTS_KEY, [bare]);
    const changed = SOURCE.replace('- 別のノード\n', '- 再読込の間に足した\n');
    mounted.app.put(PATH, changed);
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(changed);
    expect(keptOf(app)).toEqual([bare]);
    expect(Notice.log).toEqual([notWritten('exitKeptEdits', '原文なしで残る下書き', PATH, t().exitNoteChanged)]);
  });

  it('tries the kept draft again at the next load, and says so again while it cannot be written', async () => {
    const { mounted, owner, kept } = await keep('次の読み込みで入る下書き');
    owner.unload();
    mounted.view.containerEl.remove();
    const app = new HarnessApp();
    await loadAgain(app);
    await loadAgain(app);
    const notice = notWritten('exitKeptSource', '次の読み込みで入る下書き', PATH, t().exitNoteGone);
    expect(Notice.log).toEqual([notice, notice]);
    expect(keptOf(app)).toEqual(kept);
    app.put(PATH, SOURCE);
    await loadAgain(app);
    expect(noteOf(app)).toBe(renamed('次の読み込みで入る下書き'));
    expect(keptOf(app)).toBeNull();
    expect(Notice.log).toEqual([notice, notice, wrote('次の読み込みで入る下書き')]);
  });

  it('drops a written draft and keeps one that was not, in the same entry', async () => {
    const { mounted, owner, kept } = await keep('入る下書き');
    const other = { path: 'Fixtures/other.md', title: '入らない下書き', at: Date.now(), refused: 'x' };
    mounted.app.saveLocalStorage(EXIT_DRAFTS_KEY, [other, ...kept]);
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(renamed('入る下書き'));
    expect(keptOf(app)).toEqual([other]);
    expect(Notice.log).toEqual([notWritten('exitKeptRefused', '入らない下書き', 'Fixtures/other.md', 'x'), wrote('入る下書き')]);
  });

  it('drops a draft the note has already', async () => {
    const { mounted, owner } = await keep('入っていた下書き');
    mounted.app.put(PATH, renamed('入っていた下書き'));
    const app = await reload(mounted, owner);
    expect(keptOf(app)).toBeNull();
    expect(Notice.log).toEqual([]);
  });

  // A page that sends pagehide and is kept after all adds its drafts while the earlier ones are being written.
  it('keeps a draft added to the entry while another was being written', async () => {
    const { mounted, owner, kept } = await keep('書いている間の下書き');
    const added = { path: 'Fixtures/other.md', title: '間に足された下書き', at: Date.now(), refused: 'y' };
    const app = await reload(mounted, owner, (vault, store) => {
      const applyOver = store.applyOver.bind(store);
      vi.spyOn(store, 'applyOver').mockImplementation(async (...args: Parameters<DocumentStore['applyOver']>) => {
        vault.saveLocalStorage(EXIT_DRAFTS_KEY, [...kept, added]);
        return applyOver(...args);
      });
    });
    expect(noteOf(app)).toBe(renamed('書いている間の下書き'));
    expect(keptOf(app)).toEqual([added]);
  });

  it('does not say the draft is kept when the entry could not be written', async () => {
    const { mounted, owner, kept } = await keep('残せたか分からない下書き');
    const changed = SOURCE.replace('  - 子ノード\n', '  - 子ノード（外で）\n');
    mounted.app.put(PATH, changed);
    const app = await reload(mounted, owner, vault => {
      vi.spyOn(vault, 'saveLocalStorage').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    });
    expect(noteOf(app)).toBe(changed);
    expect(app.loadLocalStorage(EXIT_DRAFTS_KEY)).toEqual(kept);
    expect(Notice.log).toEqual([notWritten('exitKeepUnconfirmed', '残せたか分からない下書き', PATH, t().exitNoteChanged)]);
    expect(Notice.log[0]).not.toContain('残してあります');
  });

  // What each Notice says is kept, and the command it names, read off the Notices a load shows (not the table).
  it('names the rescue command and what is kept in the Notice of each kind of draft', async () => {
    const at = Date.now();
    const edits = [{ from: 0, to: 1, text: 'a' }];
    const app = new HarnessApp();
    app.saveLocalStorage(EXIT_DRAFTS_KEY, [
      { path: 'Fixtures/a.md', title: 'a', at, before: '1:x', after: '1:y', edits, source: 'b' },
      { path: 'Fixtures/b.md', title: 'b', at, before: '1:x', after: '1:y', edits },
      { path: 'Fixtures/c.md', title: 'c', at, refused: 'x' },
    ]);
    await loadAgain(app);
    expect(Notice.log).toHaveLength(3);
    for (const notice of Notice.log) expect(notice).toContain('コマンド「保存できなかった下書きを救出」');
    expect(Notice.log[0]).toContain('入力と元の原文は残してあります');
    expect(Notice.log[1]).toContain('入力中の題名と変更内容は残してありますが、ノートの原文は保存されていないため、本文全体は復元できません。');
    expect(Notice.log[2]).toContain('入力中の題名と失敗理由を残しています。ノートの原文は保存されていないため、本文全体は復元できません。');
  });

  // Second independent review (Info): the helper above added a space after an empty reason, where the Notice adds none.
  it('adds nothing for an empty reason, as the helper expects', async () => {
    const app = new HarnessApp();
    app.saveLocalStorage(EXIT_DRAFTS_KEY, [{ path: PATH, title: '理由のない下書き', at: Date.now(), refused: '' }]);
    await loadAgain(app);
    expect(Notice.log).toEqual([notWritten('exitKeptRefused', '理由のない下書き', PATH, '')]);
    expect(Notice.log[0]).toContain('書き込めませんでした。入力中の題名と失敗理由');
  });

  // Independent review of 2a0eedb (L4): a space came after 「。」 between the reason and what is kept.
  it('puts no space after a Japanese full stop, and no double space in English when the reason is empty', async () => {
    const { mounted, owner } = await keep('句点の下書き');
    mounted.app.put(PATH, '');
    await reload(mounted, owner);
    expect(Notice.log).toEqual([`再読込・終了のときに ${PATH} で編集していた「句点の下書き」を書き込めませんでした。その間にノートが変わりました。入力と元の原文は残してあります。コマンド「保存できなかった下書きを救出」で別ファイルに保存できます。`]);
    Notice.log.length = 0;
    setLanguage('en');
    try {
      const app = new HarnessApp();
      app.saveLocalStorage(EXIT_DRAFTS_KEY, [{ path: PATH, title: 'a', at: Date.now(), refused: '' }]);
      await loadAgain(app);
      expect(Notice.log).toHaveLength(1);
      expect(Notice.log[0]).not.toContain('  ');
      expect(Notice.log[0]).toContain('reloaded or quit. The title you typed');
      // Second independent review: a reason ending in 「。」 was run into the next sentence in the English UI.
      Notice.log.length = 0;
      app.saveLocalStorage(EXIT_DRAFTS_KEY, [{ path: PATH, title: 'a', at: Date.now(), refused: '日本語の理由。' }]);
      await loadAgain(app);
      expect(Notice.log).toHaveLength(1);
      expect(Notice.log[0]).toContain('reloaded or quit. 日本語の理由。 The title you typed');
    } finally { setLanguage('ja'); }
  });

  // Review 1: pageshow and the layout's readiness both apply in one load; the Notice that stays was shown twice.
  it('reports a kept draft once per load though it is applied again in the same load', async () => {
    const { mounted, owner } = await keep('一度だけ知らせる下書き');
    owner.unload();
    mounted.view.containerEl.remove();
    const app = new HarnessApp();
    await loadAgain(app);
    window.dispatchEvent(new Event('pageshow'));
    await rounds();
    expect(Notice.log).toEqual([notWritten('exitKeptSource', '一度だけ知らせる下書き', PATH, t().exitNoteGone)]);
  });

  // Review 1: drafts not written were written back one by one, the whole entry each time.
  it('writes the entry back once for the drafts not written', async () => {
    const app = new HarnessApp();
    const drafts = [1, 2, 3].map(index => ({ path: `Fixtures/gone-${index}.md`, title: `下書き${index}`, at: Date.now(), refused: 'x' }));
    app.saveLocalStorage(EXIT_DRAFTS_KEY, drafts);
    const save = vi.spyOn(app, 'saveLocalStorage');
    await loadAgain(app);
    expect(save).toHaveBeenCalledTimes(1);
    expect(keptOf(app)).toEqual(drafts);
    expect(Notice.log).toHaveLength(3);
  });

  // Review 1: drafts were told apart by every field, so one a pagehide kept again without its note text (storage short)
  // was neither taken out once written nor found kept.
  it('tells a draft kept again without its note text meanwhile from the others', async () => {
    const { mounted, owner, kept } = await keep('原文を外されても入る下書き');
    const gone = { ...(kept[0] as object), path: 'Fixtures/gone.md', title: '原文を外されて残る下書き' } as { source?: string };
    mounted.app.saveLocalStorage(EXIT_DRAFTS_KEY, [...kept, gone]);
    const bare = (items: unknown[]): unknown[] => items.map(item => { const copy = { ...(item as object) } as { source?: string }; delete copy.source; return copy; });
    const app = await reload(mounted, owner, (vault, store) => {
      const applyOver = store.applyOver.bind(store);
      vi.spyOn(store, 'applyOver').mockImplementation(async (...args: Parameters<DocumentStore['applyOver']>) => {
        vault.saveLocalStorage(EXIT_DRAFTS_KEY, bare([...kept, gone]));
        return applyOver(...args);
      });
    });
    expect(noteOf(app)).toBe(renamed('原文を外されても入る下書き'));
    expect(keptOf(app)).toEqual(bare([gone]));
    expect(Notice.log).toEqual([wrote('原文を外されても入る下書き'), notWritten('exitKeptEdits', '原文を外されて残る下書き', 'Fixtures/gone.md', t().exitNoteGone)]);
  });
});

/**
 * LEV-309, the owner's decision of 2026-10-06: every write of a kept draft backs the whole note up first, in the
 * plugin's folder, read back before the note is written (S1 the temporary file, S2 the prepared one read back, S3 the
 * write, S4 the backup marked applied, S5 the draft out of the entry); a note shorter than the one the draft was
 * planned on is not written at all; and what the folder holds at the next load decides what may be written. The rows
 * are what the note became (a cut that ends like the note, longer, shorter, a cut the old guards saw) × each step
 * failing or stopped × what the folder holds (temporary, broken, unknown files, a file in its place, an earlier
 * backup of the draft) × the size of the folder.
 */
describe('a backup before each write of a kept draft (LEV-309)', () => {
  const keptOf = (app: HarnessApp): unknown => app.loadLocalStorage(EXIT_DRAFTS_KEY);
  /** A map note whose last nodes can be moved and cut. */
  const NOTE = ['---', 'mappy: true', '---', '## 下書き', '', '- 親', '  - 子ノード', '- 一', '- メモ', '- 別', '- メモ', ''].join('\n');
  const renameIn = (source: string, title: string) => [{ from: source.indexOf('子ノード'), to: source.indexOf('子ノード') + 4, text: title }];
  /** A draft as `pagehide` keeps it: renaming 「子ノード」 in `source` to `title`. */
  const keptDraft = (title: string, source = NOTE, withSource = true): ExitDraft => {
    const edits = renameIn(source, title);
    return {
      path: PATH, title, at: Date.now(), before: textFingerprint(source), after: textFingerprint(applyEdits(source, edits)), edits,
      ...(withSource ? { source } : {}),
    };
  };
  const recordPath = async (draft: ExitDraft, kind: 'prepared' | 'applied'): Promise<string> =>
    `${BACKUPS}/${(kind === 'applied' ? appliedName : preparedName)(await backupId(draft))}`;
  /** A load of the plugin on `app` (the note there as a row put it), the store's writes marked in `disk.calls`. */
  async function load(app: HarnessApp, options: { refuse?: Error; backups?: ExitBackupStore } = {}): Promise<void> {
    const store = new DocumentStore(app.asApp<App>());
    const applyOver = store.applyOver.bind(store);
    vi.spyOn(store, 'applyOver').mockImplementation(async (...args: Parameters<DocumentStore['applyOver']>) => {
      disk.calls.push('applyOver');
      if (options.refuse) throw options.refuse;
      return applyOver(...args);
    });
    install(app, store, () => [], options.backups);
    await rounds();
  }
  /** A vault holding the note as `current`, with `drafts` kept. */
  const vaultWith = (current: string, drafts: unknown[]): HarnessApp => {
    const app = new HarnessApp();
    app.put(PATH, current);
    app.saveLocalStorage(EXIT_DRAFTS_KEY, drafts);
    return app;
  };
  const changed = (title: string, reason: string, tail: 'exitKeptSource' | 'exitKeptEdits' = 'exitKeptSource'): string => notWritten(tail, title, PATH, reason);

  // Acceptance 1: what a write cut off can leave and the earlier guards let through, the note shorter than it was.
  it.each([
    ['the last node moved up, cut after it', NOTE.replace('- 別\n- メモ\n', '- メモ\n- 別\n').slice(0, NOTE.replace('- 別\n- メモ\n', '- メモ\n- 別\n').lastIndexOf('- 別'))],
    ['a line above changed, cut just after a line the same as the last one', NOTE.replace('- 一\n', '- 一つ\n').slice(0, NOTE.replace('- 一\n', '- 一つ\n').indexOf('- 別'))],
  ])('does not write a shorter note (%s): the draft and its note text stay, nothing is backed up, and it says so', async (_shape, current) => {
    expect(current.length).toBeLessThan(NOTE.length);
    const draft = keptDraft('短くなったノートの下書き');
    const app = vaultWith(current, [draft]);
    await load(app);
    expect(noteOf(app)).toBe(current);
    expect(keptOf(app)).toEqual([draft]);
    expect(disk.names()).toEqual([]);
    expect(Notice.log).toEqual([changed('短くなったノートの下書き', t().exitNoteChanged)]);
  });

  // Acceptance 2: the same shape, but longer than the note was: written, after a backup read back first.
  it('writes a cut it cannot tell when the note is longer, after a backup of it read back, and lists the backup for the rescue', async () => {
    const written = NOTE.replace('- 一\n', '- 一つめの長い長い長い長い名前に変えていた\n');
    const current = written.slice(0, written.indexOf('- 別'));
    expect(current.length).toBeGreaterThanOrEqual(NOTE.length);
    const draft = keptDraft('長くなったノートの下書き');
    const app = vaultWith(current, [draft]);
    await load(app);
    const id = await backupId(draft);
    expect(noteOf(app)).toBe(current.replace('子ノード', '長くなったノートの下書き'));
    expect(keptOf(app)).toBeNull();
    expect(disk.names()).toEqual([appliedName(id)]);
    const backup = readExitBackup(disk.files.get(await recordPath(draft, 'applied'))!);
    expect(backup?.note.before).toBe(current);
    // The text the cut lost is in the backup, with the draft as it was kept.
    expect(backup?.draft.source).toBe(NOTE);
    const prepared = await recordPath(draft, 'prepared');
    expect(disk.calls.indexOf(`read ${prepared}`)).toBeGreaterThan(disk.calls.findIndex(call => call.startsWith('write ') && call.includes('.tmp-')));
    expect(disk.calls.indexOf(`read ${prepared}`)).toBeLessThan(disk.calls.indexOf('applyOver'));
    expect(disk.calls.indexOf(`rename ${prepared}`)).toBeGreaterThan(disk.calls.indexOf('applyOver'));
    expect(Notice.log).toEqual([wrote('長くなったノートの下書き')]);
    await rescueExitDrafts(app.asApp<App>(), new ExitBackupStore(disk.adapter, BACKUPS, '0.4.6'));
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.modal .setting-item'));
    expect(rows.map(row => row.dataset.mappyRescue)).toEqual(['applied']);
    expect(rows[0]?.querySelector('.setting-item-name')?.textContent).toBe(PATH);
  });

  // Acceptance 3: the cut LEV-309's first guards see, and a deletion the person made, are not written either.
  it('does not write a cut the earlier guards see, nor over a line the person took out', async () => {
    const putIn = NOTE.replace('- 別\n', '- 足しかけた行\n- 別\n').slice(0, -2);
    expect(putIn.length).toBeGreaterThanOrEqual(NOTE.length);
    const deleted = NOTE.replace('- 一\n', '');
    for (const current of [putIn, deleted]) {
      disk = new Disk();
      Notice.log.length = 0;
      const draft = keptDraft('止まる下書き');
      const app = vaultWith(current, [draft]);
      await load(app);
      expect(noteOf(app)).toBe(current);
      expect(keptOf(app)).toEqual([draft]);
      expect(disk.names()).toEqual([]);
      expect(Notice.log).toEqual([changed('止まる下書き', t().exitNoteChanged)]);
    }
  });

  // Acceptance 4: a draft kept without the note text (a long note, or kept by an earlier version) is backed up too,
  // the whole note as it is, before it is written on the note it was planned on; without the backup it is not written.
  it('backs up the whole note before writing a draft kept without its note text, and does not write it without the backup', async () => {
    const draft = keptDraft('原文なしの下書き', NOTE, false);
    const app = vaultWith(NOTE, [draft]);
    await load(app);
    expect(noteOf(app)).toBe(NOTE.replace('子ノード', '原文なしの下書き'));
    const backup = readExitBackup(disk.files.get(await recordPath(draft, 'applied'))!);
    expect(backup?.note.before).toBe(NOTE);
    expect(backup?.draft.source).toBeUndefined();
    disk = new Disk();
    Notice.log.length = 0;
    disk.fault = (step, path) => step === 'write' && path.includes('.tmp-') ? new Error('ENOSPC: no space left on device') : null;
    const blocked = vaultWith(NOTE, [draft]);
    await load(blocked);
    expect(noteOf(blocked)).toBe(NOTE);
    expect(keptOf(blocked)).toEqual([draft]);
    expect(disk.calls).not.toContain('applyOver');
    expect(Notice.log).toEqual([changed('原文なしの下書き', t().exitBackupNotSaved('ENOSPC: no space left on device'), 'exitKeptEdits')]);
  });

  // Acceptance 5: each step failing or stopped. Nothing is written twice, and nothing is deleted.
  describe('a step that fails or stops', () => {
    const title = '途中で止まる下書き';

    it('S1: the temporary file cannot be written: the note is not written', async () => {
      disk.fault = (step, path) => step === 'write' && path.includes('.tmp-') ? new Error('EACCES: permission denied') : null;
      const draft = keptDraft(title);
      const app = vaultWith(NOTE, [draft]);
      await load(app);
      expect(noteOf(app)).toBe(NOTE);
      expect(keptOf(app)).toEqual([draft]);
      expect(disk.calls).not.toContain('applyOver');
      expect(Notice.log).toEqual([changed(title, t().exitBackupNotSaved('EACCES: permission denied'))]);
    });

    it('S2: the temporary file is left (renamed or not), and the next load writes nothing at all', async () => {
      disk.fault = (step, path) => step === 'rename' && path.includes('.tmp-') ? new Error('EPERM') : null;
      const draft = keptDraft(title);
      const app = vaultWith(NOTE, [draft]);
      await load(app);
      expect(noteOf(app)).toBe(NOTE);
      const left = disk.names();
      expect(left).toHaveLength(1);
      expect(left[0]).toMatch(/\.tmp-[0-9a-f]{12}\.json$/u);
      disk.fault = () => null;
      Notice.log.length = 0;
      await load(app);
      expect(noteOf(app)).toBe(NOTE);
      expect(keptOf(app)).toEqual([draft]);
      expect(disk.names()).toEqual(left);
      expect(Notice.log).toEqual([changed(title, t().exitBackupUnverified(BACKUPS))]);
    });

    it('S2: the prepared backup reads back changed: the note is not written, and the next load does not write it either', async () => {
      disk.readBack = (path, text) => path.endsWith('.prepared.json') ? text.replace('子ノード', '子ノーX') : text;
      const draft = keptDraft(title);
      const app = vaultWith(NOTE, [draft]);
      await load(app);
      expect(noteOf(app)).toBe(NOTE);
      expect(Notice.log).toEqual([changed(title, t().exitBackupMismatch)]);
      disk.readBack = (_path, text) => text;
      Notice.log.length = 0;
      await load(app);
      expect(noteOf(app)).toBe(NOTE);
      expect(keptOf(app)).toEqual([draft]);
      expect(disk.names()).toEqual([preparedName(await backupId(draft))]);
      expect(Notice.log).toEqual([changed(title, t().exitBackupPending)]);
    });

    it('S3: the store refuses the write: the prepared backup and the draft stay, and the next load does not write it', async () => {
      const draft = keptDraft(title);
      const app = vaultWith(NOTE, [draft]);
      await load(app, { refuse: new Error('書き込みが拒否されました。') });
      expect(noteOf(app)).toBe(NOTE);
      expect(keptOf(app)).toEqual([draft]);
      expect(disk.names()).toEqual([preparedName(await backupId(draft))]);
      expect(Notice.log).toEqual([changed(title, `書き込みが拒否されました。${t().exitBackupLeftPrepared}`)]);
      Notice.log.length = 0;
      await load(app);
      expect(noteOf(app)).toBe(NOTE);
      expect(disk.calls.filter(call => call === 'applyOver')).toHaveLength(1);
      expect(Notice.log).toEqual([changed(title, t().exitBackupPending)]);
    });

    it('S4: the backup cannot be marked applied: written once, the draft stays, and it is not written again', async () => {
      disk.fault = (step, path) => step === 'rename' && path.endsWith('.prepared.json') ? new Error('EPERM') : null;
      const draft = keptDraft(title);
      const app = vaultWith(NOTE, [draft]);
      await load(app);
      const once = NOTE.replace('子ノード', title);
      expect(noteOf(app)).toBe(once);
      expect(keptOf(app)).toEqual([draft]);
      expect(disk.names()).toEqual([preparedName(await backupId(draft))]);
      expect(Notice.log).toEqual([t().exitWrittenNotMarked(title, PATH, t().cmdRescueDrafts)]);
      disk.fault = () => null;
      Notice.log.length = 0;
      await load(app);
      expect(noteOf(app)).toBe(once);
      expect(disk.calls.filter(call => call === 'applyOver')).toHaveLength(1);
      expect(keptOf(app)).toEqual([draft]);
      expect(Notice.log).toEqual([changed(title, t().exitBackupPending)]);
    });

    it('S5: the draft cannot be taken out of the entry: the next load finds the applied backup and writes nothing', async () => {
      const draft = keptDraft(title);
      const app = vaultWith(NOTE, [draft]);
      const save = app.saveLocalStorage.bind(app);
      const refused = vi.spyOn(app, 'saveLocalStorage').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
      await load(app);
      const once = NOTE.replace('子ノード', title);
      expect(noteOf(app)).toBe(once);
      expect(keptOf(app)).toEqual([draft]);
      expect(disk.names()).toEqual([appliedName(await backupId(draft))]);
      refused.mockImplementation(save);
      Notice.log.length = 0;
      await load(app);
      expect(noteOf(app)).toBe(once);
      expect(disk.calls.filter(call => call === 'applyOver')).toHaveLength(1);
      expect(keptOf(app)).toEqual([draft]);
      expect(Notice.log).toEqual([changed(title, t().exitBackupAlreadyApplied)]);
    });
  });

  // Acceptance 6: the folder's size, every file counted (the store's rows hold the edges: tests/obsidian).
  it('stops before the write when the backup would take the folder over 10 MiB, deletes nothing, and uses no more localStorage', async () => {
    // An applied backup of another draft, 100 bytes short of the limit: this draft's backup takes more than that.
    const other = keptDraft('前の下書き') as Exclude<ExitDraft, { refused: string }>;
    const fill = async (length: number) => backupText(await makeExitBackup({
      draft: other, path: PATH, before: 'x'.repeat(length), after: 'y', edits: other.edits, mappyVersion: '0.4.6', createdAt: 1,
    }));
    const target = EXIT_BACKUP_LIMIT - 100;
    let length = target - utf8Bytes(await fill(0));
    let text = await fill(length);
    length += target - utf8Bytes(text);
    text = await fill(length);
    expect(utf8Bytes(text)).toBe(target);
    disk.folders.add(BACKUPS);
    disk.files.set(`${BACKUPS}/${appliedName(await backupId(other))}`, text);
    const files = new Map(disk.files);
    const draft = keptDraft('入らない下書き');
    const app = vaultWith(NOTE, [draft]);
    const keys = Object.keys(window.localStorage).sort();
    const entry = window.localStorage.getItem(`mappy-harness-${EXIT_DRAFTS_KEY}`);
    await load(app);
    await vi.waitFor(() => { expect(Notice.log).toHaveLength(1); }, { timeout: 20_000 });
    expect(noteOf(app)).toBe(NOTE);
    expect(disk.files).toEqual(files);
    expect(disk.calls).not.toContain('applyOver');
    expect(Notice.log).toEqual([changed('入らない下書き', t().exitBackupFull('10 MiB'))]);
    expect(Object.keys(window.localStorage).sort()).toEqual(keys);
    expect(window.localStorage.getItem(`mappy-harness-${EXIT_DRAFTS_KEY}`)).toBe(entry);
  }, 30_000);

  // Acceptance 7: what the folder holds that is not a backup, or a folder that cannot be read: nothing is written,
  // in any note, and nothing is deleted.
  it.each([
    ['a temporary file', () => { disk.folders.add(BACKUPS); disk.files.set(`${BACKUPS}/${'a'.repeat(64)}.tmp-000000000000.json`, '{'); }],
    ['a file that does not read', () => { disk.folders.add(BACKUPS); disk.files.set(`${BACKUPS}/${'b'.repeat(64)}.applied.json`, '{ broken'); }],
    ['an unknown file', () => { disk.folders.add(BACKUPS); disk.files.set(`${BACKUPS}/memo.txt`, 'x'); }],
    ['a file in the folder\'s place', () => { disk.files.set(BACKUPS, 'a file'); }],
  ])('writes no draft when the backup folder holds %s', async (_case, put) => {
    put();
    const files = new Map(disk.files);
    const drafts = [keptDraft('一つ目の止まる下書き'), { ...keptDraft('二つ目の止まる下書き'), path: 'Fixtures/other.md' }];
    const app = vaultWith(NOTE, drafts);
    app.put('Fixtures/other.md', NOTE);
    await load(app);
    expect(noteOf(app)).toBe(NOTE);
    expect(app.content(app.asApp<App>().vault.getFileByPath('Fixtures/other.md')!)).toBe(NOTE);
    expect(keptOf(app)).toEqual(drafts);
    expect(disk.files).toEqual(files);
    expect(disk.calls).not.toContain('applyOver');
    expect(Notice.log).toEqual([changed('一つ目の止まる下書き', t().exitBackupUnverified(BACKUPS)),
      notWritten('exitKeptSource', '二つ目の止まる下書き', 'Fixtures/other.md', t().exitBackupUnverified(BACKUPS))]);
  });

  // A draft that could not be planned is never written: what it says is its own reason, whatever the folder holds.
  it('says the reason of a draft that could not be planned though the backup folder stops the writes', async () => {
    disk.folders.add(BACKUPS);
    disk.files.set(`${BACKUPS}/memo.txt`, 'x');
    const refusedDraft = { path: PATH, title: '計画できなかった下書き', at: Date.now(), refused: '理由' };
    const app = vaultWith(NOTE, [refusedDraft]);
    await load(app);
    expect(Notice.log).toEqual([notWritten('exitKeptRefused', '計画できなかった下書き', PATH, '理由')]);
    expect(keptOf(app)).toEqual([refusedDraft]);
  });

  it('writes no draft when the backup folder cannot be listed', async () => {
    disk.folders.add(BACKUPS);
    disk.fault = step => step === 'list' ? new Error('EACCES') : null;
    const draft = keptDraft('読めない保存先の下書き');
    const app = vaultWith(NOTE, [draft]);
    await load(app);
    expect(noteOf(app)).toBe(NOTE);
    expect(keptOf(app)).toEqual([draft]);
    expect(Notice.log).toEqual([changed('読めない保存先の下書き', t().exitBackupUnlisted(BACKUPS))]);
  });

  // Acceptance 8: a backup of the same id that is not of this very draft, and a rescue reading while a load writes.
  it('does not write a draft whose backup there is of another generation (kept again without its note text)', async () => {
    const draft = keptDraft('世代の違う下書き');
    const store = new ExitBackupStore(disk.adapter, BACKUPS, '0.4.6');
    await store.prepare(draft as never, PATH, NOTE, applyEdits(NOTE, renameIn(NOTE, '世代の違う下書き')), renameIn(NOTE, '世代の違う下書き'));
    await store.markApplied(await backupId(draft));
    const bare = { ...draft } as { source?: string };
    delete bare.source;
    const app = vaultWith(NOTE, [bare]);
    await load(app);
    expect(noteOf(app)).toBe(NOTE);
    expect(keptOf(app)).toEqual([bare]);
    expect(Notice.log).toEqual([changed('世代の違う下書き', t().exitBackupOtherGeneration, 'exitKeptEdits')]);
  });

  it('runs a rescue that reads the folder while a load writes one after the other, on the one chain', async () => {
    const backups = new ExitBackupStore(disk.adapter, BACKUPS, '0.4.6');
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const write = disk.adapter.write;
    disk.adapter.write = async (path: string, data: string) => { disk.calls.push('write held'); await held; return write(path, data); };
    const draft = keptDraft('同時の下書き');
    const app = vaultWith(NOTE, [draft]);
    const loading = load(app, { backups });
    // The rescue asks while the backup is being written: it reads once that step is done.
    await vi.waitFor(() => { expect(disk.calls).toContain('write held'); });
    const rescuing = backups.survey().then(survey => { disk.calls.push('rescue read'); return survey; });
    release();
    const [survey] = await Promise.all([rescuing, loading]);
    // The rescue read once the backup was prepared and read back, before the note was written and the backup marked.
    expect(survey.records.get(await backupId(draft))?.prepared).toBeDefined();
    const prepared = await recordPath(draft, 'prepared');
    expect(disk.calls.indexOf('rescue read')).toBeGreaterThan(disk.calls.indexOf(`read ${prepared}`));
    expect(disk.calls.indexOf('rescue read')).toBeLessThan(disk.calls.indexOf(`rename ${prepared}`));
    expect(noteOf(app)).toBe(NOTE.replace('子ノード', '同時の下書き'));
  });

  // Acceptance 10: the entry keeps its shape (an earlier version reads it as before and knows nothing of backups), and
  // what does not read in it stays.
  it('keeps the entry in the shape an earlier version reads, and leaves an item that does not read in it', async () => {
    const { mounted, owner } = await draft('形の変わらない下書き');
    window.dispatchEvent(new Event('pagehide'));
    const [kept] = mounted.app.loadLocalStorage(EXIT_DRAFTS_KEY) as Record<string, unknown>[];
    expect(Object.keys(kept!)).toEqual(['path', 'title', 'at', 'before', 'after', 'edits', 'source']);
    const unreadable = { path: 'Fixtures/other.md', title: 1 };
    mounted.app.saveLocalStorage(EXIT_DRAFTS_KEY, [unreadable, kept]);
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(renamed('形の変わらない下書き'));
    expect(keptOf(app)).toEqual([unreadable]);
    expect(Object.keys(window.localStorage).filter(key => key.includes('backup'))).toEqual([]);
  });
});
