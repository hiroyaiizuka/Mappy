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
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { Component, Notice } from '../../harness/browser/obsidian';
import { DocumentStore } from '../../src/obsidian/document-store';
import { t } from '../../src/i18n';
import { installExitDrafts, EXIT_DRAFTS_KEY } from '../../src/ui/exit-drafts';
import type { MindmapView } from '../../src/ui/mindmap-view';
import { mountMapView, type MountedMapView } from './map-view-mount';

vi.mock('obsidian', () => import('../../harness/browser/obsidian'));
beforeAll(() => { installObsidianDom(); });

const PATH = 'Fixtures/exit-draft.md';
const SOURCE = ['---', 'mappy: true', '---', '## 下書き', '', '- 親', '  - 子ノード', '- 別のノード', ''].join('\n');
const renamed = (title: string, from = SOURCE): string => from.replace('  - 子ノード\n', `  - ${title}\n`);

const owners: Component[] = [];
const opened: MountedMapView[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  Notice.log.length = 0;
  for (const owner of owners.splice(0)) owner.unload();
  for (const mounted of opened.splice(0)) await mounted.close();
  window.localStorage.clear();
  document.body.replaceChildren();
});

/** The plugin's part (src/main.ts): the handlers on the page, for the views open on it. */
function install(app: HarnessApp, store: DocumentStore, views: () => readonly MindmapView[]): Component {
  const owner = new Component();
  owner.load();
  owners.push(owner);
  installExitDrafts(owner as never, app.asApp<App>(), store, views);
  return owner;
}

/** A map with F2 on 「子ノード」 and `title` typed, and the plugin's handlers installed for it. */
async function draft(title: string, source = SOURCE): Promise<{ mounted: MountedMapView; input: HTMLTextAreaElement; owner: Component }> {
  const mounted = await mountMapView(PATH, source);
  opened.push(mounted);
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
async function reload(mounted: MountedMapView, owner: Component): Promise<HarnessApp> {
  window.dispatchEvent(new Event('pagehide'));
  const left = mounted.source();
  owner.unload();
  opened.splice(opened.indexOf(mounted), 1);
  mounted.view.containerEl.remove();
  const app = new HarnessApp();
  app.put(PATH, left);
  install(app, new DocumentStore(app.asApp<App>()), () => []);
  for (let round = 0; round < 5; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
  return app;
}

const noteOf = (app: HarnessApp): string => app.content(app.asApp<App>().vault.getFileByPath(PATH)!);

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
    expect(Notice.log).toEqual([]);
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
    expect(Notice.log).toEqual([]);
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
    expect(Notice.log).toEqual([]);
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
    expect(Notice.log).toEqual([t().exitDraftNotSaved('外で変わったノードの下書き', t().draftChanged)]);
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
    expect(Notice.log).toEqual([]);
  });

  it('leaves the note and says so when the node itself changed while the window reloaded', async () => {
    const { mounted, owner } = await draft('間に変わったノードの下書き');
    window.dispatchEvent(new Event('pagehide'));
    const changed = SOURCE.replace('  - 子ノード\n', '  - 子ノード（外で）\n');
    mounted.app.put(PATH, changed);
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(changed);
    expect(Notice.log).toEqual([t().exitDraftNotSaved('間に変わったノードの下書き', t().exitNoteChanged)]);
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
    expect(Notice.log).toEqual([]);
  });

  // Review 1: two maps of one note each with a draft; the first applied made the second's note stale.
  it('applies the drafts of two maps of the same note on different nodes', async () => {
    const first = await mountMapView(PATH, SOURCE);
    opened.push(first);
    const store = (first.view as unknown as { store: DocumentStore }).store;
    const second = await mountMapView(PATH, SOURCE, 'mindmap', first.app, { store });
    opened.push(second);
    const owner = install(first.app, store, () => [first.view, second.view]);
    for (const [mounted, node, title] of [[first, '子ノード', '一つ目のマップの下書き'], [second, '別のノード', '二つ目のマップの下書き']] as const) {
      mounted.key(mounted.select(node), 'F2');
      await mounted.settle();
      const input = mounted.editor()!;
      input.value = title;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    opened.splice(opened.indexOf(second), 1);
    second.view.containerEl.remove();
    const app = await reload(first, owner);
    expect(noteOf(app)).toBe(renamed('一つ目のマップの下書き').replace('- 別のノード\n', '- 二つ目のマップの下書き\n'));
    expect(Notice.log).toEqual([]);
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
    expect(Notice.log).toEqual([t().exitDraftNotSaved('前のページの下書き', 'x')]);
  });

  // Review 2: a draft kept for long (Mappy disabled for weeks, the note worked on elsewhere) was written unasked.
  it('does not write a draft kept for more than a day, and says so', async () => {
    const { mounted, owner } = await draft('古い下書き');
    window.dispatchEvent(new Event('pagehide'));
    const [kept] = mounted.app.loadLocalStorage(EXIT_DRAFTS_KEY) as { at: number }[];
    mounted.app.saveLocalStorage(EXIT_DRAFTS_KEY, [{ ...kept, at: Date.now() - 2 * 24 * 60 * 60 * 1000 }]);
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(SOURCE);
    expect(Notice.log).toEqual([t().exitDraftNotSaved('古い下書き', t().exitDraftExpired)]);
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
    expect(Notice.log).toEqual([]);
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
    opened.splice(opened.indexOf(mounted), 1);
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
    installExitDrafts(owner as never, app.asApp<App>(), new DocumentStore(app.asApp<App>()), () => []);
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
    opened.splice(opened.indexOf(mounted), 1);
    mounted.view.containerEl.remove();
    const app = new HarnessApp();
    install(app, new DocumentStore(app.asApp<App>()), () => []);
    for (let round = 0; round < 5; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
    expect(Notice.log).toEqual([t().exitDraftNotSaved('消えたノートの下書き', t().exitNoteGone)]);
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
    expect(Notice.log).toEqual([]);
  });

  it('ignores what it cannot read as kept drafts', async () => {
    const app = new HarnessApp();
    app.put(PATH, SOURCE);
    app.saveLocalStorage(EXIT_DRAFTS_KEY, [{ path: PATH, title: 1 }, 'x', { path: PATH, title: 'a', before: 'b', after: 'c', edits: [{ from: 'x' }] }]);
    install(app, new DocumentStore(app.asApp<App>()), () => []);
    for (let round = 0; round < 5; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
    expect(noteOf(app)).toBe(SOURCE);
    expect(Notice.log).toEqual([]);
    expect(app.loadLocalStorage(EXIT_DRAFTS_KEY)).toBeNull();
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
    expect(Notice.log).toEqual([]);
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
