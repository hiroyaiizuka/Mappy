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
import type { MindmapView } from '../../src/ui/mindmap-view';
import { mountMapView, type MountedMapView } from './map-view-mount';
import { closeOpenViews } from '../mocks/open-views';

vi.mock('obsidian', () => import('../browser-harness/obsidian'));
beforeAll(() => { installObsidianDom(); });

const PATH = 'Fixtures/exit-draft.md';
const SOURCE = ['---', 'mappy: true', '---', '## 下書き', '', '- 親', '  - 子ノード', '- 別のノード', ''].join('\n');
const renamed = (title: string, from = SOURCE): string => from.replace('  - 子ノード\n', `  - ${title}\n`);

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
    expect(Notice.log).toEqual([]);
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
    expect(Notice.log).toEqual([]);
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
    expect(Notice.log).toEqual([notWritten('exitKeptRefused', '前のページの下書き', 'Fixtures/other.md', 'x')]);
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
    // A few characters into the line after the edited one, then all but the last line break. (Cut just after the edited
    // line, the change touches the edit and was refused already.)
    const midLine = SOURCE.slice(0, SOURCE.indexOf('- 別のノード') + 3);
    const lineBreak = SOURCE.slice(0, -1);
    mounted.app.put(PATH, midLine);
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(midLine);
    expect(keptOf(app)).toEqual(kept);
    expect((kept[0] as { source?: string }).source).toBe(SOURCE);
    const notice = notWritten('exitKeptSource', '前半だけ残ったノートの下書き', PATH, t().exitNoteChanged);
    expect(Notice.log).toEqual([notice]);
    app.put(PATH, lineBreak);
    await loadAgain(app);
    expect(noteOf(app)).toBe(lineBreak);
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
    expect(Notice.log).toEqual([notWritten('exitKeptSource', '書き込みを拒否された下書き', PATH, '書き込みが拒否されました。')]);
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
    expect(Notice.log).toEqual([notice, notice]);
  });

  it('drops a written draft and keeps one that was not, in the same entry', async () => {
    const { mounted, owner, kept } = await keep('入る下書き');
    const other = { path: 'Fixtures/other.md', title: '入らない下書き', at: Date.now(), refused: 'x' };
    mounted.app.saveLocalStorage(EXIT_DRAFTS_KEY, [other, ...kept]);
    const app = await reload(mounted, owner);
    expect(noteOf(app)).toBe(renamed('入る下書き'));
    expect(keptOf(app)).toEqual([other]);
    expect(Notice.log).toEqual([notWritten('exitKeptRefused', '入らない下書き', 'Fixtures/other.md', 'x')]);
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
    expect(Notice.log).toEqual([notWritten('exitKeptEdits', '原文を外されて残る下書き', 'Fixtures/gone.md', t().exitNoteGone)]);
  });
});
