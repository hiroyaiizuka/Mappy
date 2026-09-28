// @vitest-environment jsdom
/**
 * LEV-215: a title draft open (F2, neither Enter nor Escape) when its map view closes — the tab closed (⌘W,
 * `leaf.detach()`), the window closed, the plugin disabled. Decided 2026-09-27: the draft is saved, as a Markdown tab
 * keeps what was typed, and as a navigation in the leaf saves it (`onUnloadFile`, LEV-74). Through 0.3.8 only the
 * textarea's blur saved it — Obsidian takes the view's element out of the document before `onClose`, and Chromium blurs
 * the focused draft as it goes — while `onClose` itself dropped the draft. So what the blur does not save was lost
 * without a word: a draft mid IME composition (the blur waits for the composition's end, which never comes), a draft
 * held with a reason on its error line (blur never saves one, LEV-202), and a close that sends no blur at all.
 *
 * The rows are the close × the draft's shape: plain (with and without the blur), mid composition, held after the note
 * was re-read (the same Enter would now apply it), held by a change to its own node (it cannot apply: the note is
 * left alone and a Notice says the draft was not saved), and a node just added under its provisional name. Review 1
 * added the close right after a change the map had not read yet, the close during another write of the map's, and
 * the close with a watcher's re-read scheduled (nothing is read or drawn into the closing view).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installObsidianDom } from '../../harness/browser/dom';
import { Notice } from '../../harness/browser/obsidian';
import { t } from '../../src/i18n';
import { mountMapView, type MountedMapView } from './map-view-mount';
import { closeOpenViews } from '../mocks/open-views';

vi.mock('obsidian', () => import('../../harness/browser/obsidian'));
beforeAll(() => { installObsidianDom(); });

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenViews();
  Notice.log.length = 0;
  document.body.replaceChildren();
});

const PATH = 'Fixtures/close-draft.md';
const SOURCE = ['---', 'mappy: true', '---', '## 下書き', '', '- 親', '  - 子ノード', '- 別のノード', ''].join('\n');
const renamed = (title: string, from = SOURCE): string => from.replace('  - 子ノード\n', `  - ${title}\n`);

/** F2 on 「子ノード」 with `title` typed, as the E59 case does on the real Obsidian. */
async function draft(title: string): Promise<{ mounted: MountedMapView; input: HTMLTextAreaElement }> {
  const mounted = await mountMapView(PATH, SOURCE);
  mounted.key(mounted.select('子ノード'), 'F2');
  await mounted.settle();
  const input = mounted.editor();
  if (!input) throw new Error('F2 did not open the draft');
  input.value = title;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return { mounted, input };
}

/**
 * Close the view as Obsidian 1.14.2 does: its element out of the document first, then `onClose` (LEV-215's stack:
 * `Node.detach` ← `removeChild`). `blur`: Chromium blurs the focused draft as it leaves the document; jsdom does not,
 * so it is sent here. `false` is a close that sends none (a window without the OS focus has no focused element to blur).
 */
async function closeView(mounted: MountedMapView, input: HTMLTextAreaElement, blur: boolean): Promise<void> {
  mounted.view.containerEl.remove();
  if (blur) input.dispatchEvent(new FocusEvent('blur'));
  await mounted.close();
  await mounted.settle();
}

describe('a title draft open when its map view closes (LEV-215)', () => {
  // Passes on 0.3.8 too (its blur saved it): pins that the save on close does not write the draft twice or fail on the
  // blur's save under way.
  it('is saved once when the tab closes (the element out, its blur, then onClose)', async () => {
    const { mounted, input } = await draft('下書き');
    await closeView(mounted, input, true);
    expect(mounted.source()).toBe(renamed('下書き'));
    expect(Notice.log).toEqual([]);
  });

  it('is saved when the view closes with no blur on the way', async () => {
    const { mounted, input } = await draft('blur なしで閉じた下書き');
    await closeView(mounted, input, false);
    expect(mounted.source()).toBe(renamed('blur なしで閉じた下書き'));
    expect(Notice.log).toEqual([]);
  });

  it('is saved when the tab closes mid IME composition', async () => {
    const { mounted, input } = await draft('子ノード');
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    // The text in the composition is the textarea's value in Chromium, as it is typed.
    input.value = 'へんかんちゅう';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await closeView(mounted, input, true);
    expect(mounted.source()).toBe(renamed('へんかんちゅう'));
    expect(Notice.log).toEqual([]);
  });

  it('applies a draft held after the note was re-read, which its Enter would now apply', async () => {
    const { mounted, input } = await draft('再読込のあとの下書き');
    // Another line changed outside the map with no event the map hears (E05): the Enter's save is refused as a change
    // the map had not read, the map re-reads the note, and the error line says the same Enter now applies the draft.
    const other = SOURCE.replace('- 別のノード\n', '- 外で書き足した\n');
    const silent = vi.spyOn(mounted.app.vaultEvents, 'trigger').mockImplementation(() => undefined);
    mounted.app.put(PATH, other);
    silent.mockRestore();
    mounted.key(input, 'Enter');
    await new Promise(resolve => setTimeout(resolve, 200));
    await mounted.settle();
    const error = mounted.view.containerEl.querySelector('.mappy-inline-error')?.textContent ?? '';
    expect(error).toContain('もう一度確定すると');
    expect(mounted.source()).toBe(other);
    await closeView(mounted, input, true);
    expect(mounted.source()).toBe(renamed('再読込のあとの下書き', other));
    expect(Notice.log).toEqual([]);
  });

  // Review 1: the save on close was planned on the note the map had last read, and a refusal for a change it had not
  // read yet lost the draft, although its Enter would have applied after the re-read (row above).
  it.each([true, false])('applies over another line changed outside the map that it has not read yet (blur %s)', async (blur) => {
    const { mounted, input } = await draft('読む前に閉じた下書き');
    const other = SOURCE.replace('- 別のノード\n', '- 外で書き足した\n');
    const silent = vi.spyOn(mounted.app.vaultEvents, 'trigger').mockImplementation(() => undefined);
    mounted.app.put(PATH, other);
    silent.mockRestore();
    await closeView(mounted, input, blur);
    expect(mounted.source()).toBe(renamed('読む前に閉じた下書き', other));
    expect(Notice.log).toEqual([]);
  });

  // Review 1: another write of the view's under way (here an image pasted onto the node being edited, LEV-142) refused
  // the save on close (「保存処理が終わってから…」) instead of letting it go first.
  it('waits for another write of the map under way, then saves', async () => {
    const { mounted, input } = await draft('貼り付けの最中に閉じた下書き');
    const store = (mounted.view as unknown as { store: { applyOver: (...args: unknown[]) => Promise<unknown> } }).store;
    const applyOver = store.applyOver.bind(store);
    vi.spyOn(store, 'applyOver').mockImplementationOnce(async (...args: unknown[]) => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return applyOver(...args);
    });
    const image = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { files: [image] } });
    input.dispatchEvent(paste);
    await new Promise(resolve => setTimeout(resolve, 20));
    await closeView(mounted, input, true);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(mounted.source()).toContain('  - 貼り付けの最中に閉じた下書き');
    expect(mounted.source()).toContain('![[');
    expect(Notice.log).toEqual([]);
  });

  // Review 1: `onClose` awaits the save before it sets `closed`, and the refresh a watcher had scheduled then read and
  // drew the note into the view being closed. The timers stop as the close starts (the save's own re-read of a refused
  // save still reads: the rows above).
  it('runs no re-read a watcher scheduled while the closing view saves its draft', async () => {
    const { mounted, input } = await draft('読み直さずに閉じた下書き');
    const store = (mounted.view as unknown as { store: { applyOver: (...args: unknown[]) => Promise<unknown>; read: (...args: unknown[]) => Promise<string> } }).store;
    const applyOver = store.applyOver.bind(store);
    vi.spyOn(store, 'applyOver').mockImplementation(async (...args: unknown[]) => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return applyOver(...args);
    });
    // A watcher's event for the note: the map schedules its re-read on the 45 ms debounce.
    mounted.app.vaultEvents.trigger('modify', mounted.file);
    const read = vi.spyOn(store, 'read');
    await closeView(mounted, input, false);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(mounted.source()).toBe(renamed('読み直さずに閉じた下書き'));
    expect(read).not.toHaveBeenCalled();
  });

  // Review 2: the re-read on close must not hand the draft to another node of the same title (AGENTS.md: 同名見出し).
  it('does not rename another node of the same title after a change it had not read', async () => {
    const twins = ['---', 'mappy: true', '---', '## 下書き', '', '- 親', '  - 子ノード', '  - 子ノード', '- 別のノード', ''].join('\n');
    const mounted = await mountMapView(PATH, twins);
    const second = Array.from(mounted.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node'))
      .filter(item => item.textContent?.includes('子ノード'))[1];
    if (!second) throw new Error('no second 子ノード');
    second.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    mounted.key(second, 'F2');
    await mounted.settle();
    const input = mounted.editor();
    if (!input) throw new Error('F2 did not open the draft');
    input.value = '二つ目の下書き';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // A line inserted above the twins outside the map, not heard yet.
    const other = twins.replace('- 親\n', '- 親\n  - 外で足した\n');
    const silent = vi.spyOn(mounted.app.vaultEvents, 'trigger').mockImplementation(() => undefined);
    mounted.app.put(PATH, other);
    silent.mockRestore();
    await closeView(mounted, input, true);
    // An external change carries ids only where titles are unique (draftTarget): the twin is not guessed, nothing is
    // written, and the Notice says so. Passes on the commit before too: it pins that the retry keeps that refusal.
    expect(mounted.source()).toBe(other);
    expect(Notice.log).toEqual(['編集中の内容を保存できませんでした。編集していたノードが Markdown 側で見つかりません。マップでノードを選び直してください。']);
  });

  // Review 2: on a navigation (not a close, so the refusal's own re-read is scheduled), that re-read's timer fired while
  // the save's re-read was reading and took its epoch, so the retry was planned on the old note and refused again.
  it('applies over an unread change on a navigation even when the read is slower than the re-read debounce', async () => {
    const { mounted } = await draft('移動の前の下書き');
    const other = SOURCE.replace('- 別のノード\n', '- 外で書き足した\n');
    const silent = vi.spyOn(mounted.app.vaultEvents, 'trigger').mockImplementation(() => undefined);
    mounted.app.put(PATH, other);
    silent.mockRestore();
    const store = (mounted.view as unknown as { store: { read: (...args: unknown[]) => Promise<string> } }).store;
    const read = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation(async (...args: unknown[]) => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return read(...args);
    });
    await mounted.view.onUnloadFile(mounted.file);
    expect(mounted.source()).toBe(renamed('移動の前の下書き', other));
    expect(Notice.log).toEqual([]);
  });

  // Review 3: the watcher's own event for the same change, arriving while the save's re-read reads, took its epoch too.
  it('applies over an unread change on a navigation when the watcher reports it during the re-read', async () => {
    const { mounted } = await draft('知らせの届く前の下書き');
    const other = SOURCE.replace('- 別のノード\n', '- 外で書き足した\n');
    const silent = vi.spyOn(mounted.app.vaultEvents, 'trigger').mockImplementation(() => undefined);
    mounted.app.put(PATH, other);
    silent.mockRestore();
    const store = (mounted.view as unknown as { store: { read: (...args: unknown[]) => Promise<string> } }).store;
    const read = store.read.bind(store);
    let reported = false;
    vi.spyOn(store, 'read').mockImplementation(async (...args: unknown[]) => {
      if (!reported) { reported = true; mounted.app.vaultEvents.trigger('modify', mounted.file); }
      await new Promise(resolve => setTimeout(resolve, 20));
      return read(...args);
    });
    await mounted.view.onUnloadFile(mounted.file);
    expect(mounted.source()).toBe(renamed('知らせの届く前の下書き', other));
    expect(Notice.log).toEqual([]);
  });

  // Review 3: the delete watcher's deferred unload ran on a view still saving on close (`closed` comes after the save).
  // That was with the harness closing in the wrong order (`onClose`, then `unload`). Closed as 1.14.2 closes a tab
  // (LEV-239: the view unloads, then `onClose` saves), FileView's delete subscription and the map's are gone before the
  // save, so the note deleted meanwhile is unloaded once, by the teardown. This pins that count; the `closing` guard in
  // the delete watcher is no longer reached from here (taking it out still passes, checked on LEV-239, as it does for a
  // delete in the same tick as the close, with or without a write of the map's under way: LEV-242).
  it('lets a note deleted while the view closes go without a save or a second unload', async () => {
    const { mounted, input } = await draft('消えるノートの下書き');
    const unload = vi.spyOn(mounted.view, 'onUnloadFile');
    const store = (mounted.view as unknown as { store: { applyOver: (...args: unknown[]) => Promise<unknown> } }).store;
    const applyOver = store.applyOver.bind(store);
    vi.spyOn(store, 'applyOver').mockImplementation(async (...args: unknown[]) => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return applyOver(...args);
    });
    const closing = closeView(mounted, input, false);
    await new Promise(resolve => setTimeout(resolve, 10));
    mounted.app.remove(PATH);
    await closing;
    await new Promise(resolve => setTimeout(resolve, 100));
    // Only FileView's teardown unloads the note: the delete came after `unload` took both subscriptions away.
    expect(unload).toHaveBeenCalledTimes(1);
  });

  // Review 2 (passes on the commit before it too, where the second save saw the first's write under way and the draft
  // gone after it): a close right after a navigation began its save must not save twice or clear `unloading` under it.
  it('saves once when the view closes while a navigation is saving the draft', async () => {
    const { mounted, input } = await draft('移動の最中に閉じた下書き');
    const store = (mounted.view as unknown as { store: { applyOver: (...args: unknown[]) => Promise<unknown> } }).store;
    const applyOver = store.applyOver.bind(store);
    const writes = vi.spyOn(store, 'applyOver').mockImplementation(async (...args: unknown[]) => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return applyOver(...args);
    });
    const leaving = mounted.view.onUnloadFile(mounted.file);
    await closeView(mounted, input, false);
    await leaving;
    expect(mounted.source()).toBe(renamed('移動の最中に閉じた下書き'));
    expect(writes).toHaveBeenCalledTimes(1);
    expect(Notice.log).toEqual([]);
  });

  it('leaves a node changed outside the map as it is, and says the draft was not saved', async () => {
    const { mounted, input } = await draft('外で変わったノードの下書き');
    const external = SOURCE.replace('  - 子ノード\n', '  - 外で書き換えた\n');
    mounted.app.put(PATH, external);
    await new Promise(resolve => setTimeout(resolve, 200));
    await mounted.settle();
    mounted.key(input, 'Enter');
    await mounted.settle();
    expect(mounted.view.containerEl.querySelector('.mappy-inline-error')?.textContent ?? '').not.toBe('');
    await closeView(mounted, input, true);
    expect(mounted.source()).toBe(external);
    expect(Notice.log).toHaveLength(1);
    expect(Notice.log[0]).toContain('編集中の内容を保存できませんでした');
  });

  // Passes on 0.3.8 too: the provisional name is what the note has, and closing neither takes the node back (only
  // Escape does, LEV-203) nor writes anything more.
  it('keeps a node just added under its untouched provisional name', async () => {
    const mounted = await mountMapView(PATH, SOURCE);
    mounted.key(mounted.select('別のノード'), 'Tab');
    await mounted.settle();
    const added = mounted.source();
    expect(added).toContain(`  - ${t().newNodeTitle}`);
    const input = mounted.editor();
    if (!input) throw new Error('Tab did not open the new node\'s draft');
    await closeView(mounted, input, true);
    expect(mounted.source()).toBe(added);
    expect(Notice.log).toEqual([]);
  });
});
