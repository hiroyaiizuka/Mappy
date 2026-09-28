// @vitest-environment jsdom
/**
 * LEV-234 (architecture.md §9e「文言を比べて挙動を決めない」): the store refuses a write the note has moved under
 * (`ConflictError`), and the view reacts to that refusal by re-reading the note — on a kept draft's error line, on
 * the save a close makes, on Undo and on taking back a new topic. Through LEV-233 each of these compared the error's
 * text with the store's message, so a refusal worded in one language and judged in another (a message resolved at
 * another time, or by another table) was not recognised, and the re-read, the retry or the swap of the line was
 * silently skipped. Every row here has the refusal worded in English and judged while the app is in Japanese.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { Notice } from '../../harness/browser/obsidian';
import { setLanguage, t } from '../../src/i18n';
import { DocumentStore } from '../../src/obsidian/document-store';
import { accessibleName } from './accessible-name';
import { mountMapView, type MountedMapView } from './map-view-mount';

vi.mock('obsidian', () => import('../../harness/browser/obsidian'));
beforeAll(() => { installObsidianDom(); });

const opened: MountedMapView[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  setLanguage('ja');
  Notice.log.length = 0;
  for (const mounted of opened.splice(0)) await mounted.close();
  document.body.replaceChildren();
});

const PATH = 'Fixtures/conflict-kind.md';
const SOURCE = ['---', 'mappy: true', '---', '## 旅の計画', '', '- 温泉旅行', '  - 予約', '- 持ち物', ''].join('\n');
/** A change written behind the view's back, on a branch no draft here touches. */
const OTHER = SOURCE.replace('- 持ち物\n', '- 持ち物（外部）\n');

interface Mounted extends MountedMapView { store: DocumentStore }

async function mount(): Promise<Mounted> {
  const app = new HarnessApp();
  app.put(PATH, SOURCE);
  const store = new DocumentStore(app.asApp<App>());
  const mounted = await mountMapView(PATH, SOURCE, 'mindmap', app, { store });
  opened.push(mounted);
  return { ...mounted, store };
}

/** The store's own refusal, made while the app runs in English: a write planned on a text the note no longer has. */
async function englishRefusal(): Promise<Error> {
  const app = new HarnessApp();
  app.put('Fixtures/other.md', '# A\n');
  const store = new DocumentStore(app.asApp<App>());
  const file = app.asApp<App>().vault.getFileByPath('Fixtures/other.md');
  if (!file) throw new Error('No note to refuse a write on');
  setLanguage('en');
  try {
    const refusal: unknown = await store.apply(file, '# B\n', [{ from: 2, to: 3, text: 'C' }]).then(() => null, (error: unknown) => error);
    if (!(refusal instanceof Error)) throw new Error('The store applied a write planned on another text');
    return refusal;
  } finally { setLanguage('ja'); }
}

/** Change the note on disk with the watcher silent, so only a refusal can tell the view. */
function silently(mounted: Mounted, text: string): void {
  const silent = vi.spyOn(mounted.app.vaultEvents, 'trigger').mockImplementation(() => undefined);
  mounted.app.put(PATH, text);
  silent.mockRestore();
}

function labels(mounted: Mounted): string[] {
  return Array.from(mounted.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node'), element => accessibleName(element));
}

async function draft(mounted: Mounted, title: string, text: string): Promise<HTMLTextAreaElement> {
  mounted.key(mounted.select(title), 'F2');
  await mounted.settle();
  const input = mounted.editor();
  if (!input) throw new Error('F2 did not open the draft');
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input;
}

const refreshed = async (mounted: Mounted): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 60)); await mounted.settle(); };

describe('a refusal is told by its kind, not its wording (LEV-234)', () => {
  it('the englishRefusal helper really is the store refusing, in English', async () => {
    const refusal = await englishRefusal();
    setLanguage('en');
    expect(refusal.message).toBe(t().conflict);
  });

  it('a draft refused in English learns in Japanese that the map was re-read, and its next Enter applies', async () => {
    const mounted = await mount();
    const input = await draft(mounted, '予約', '予約（編集）');
    silently(mounted, OTHER);
    setLanguage('en');
    mounted.key(input, 'Enter');
    // One task: the refusal is made (and worded) in English, and the view's own re-read has not run yet. Waiting
    // longer would let that re-read run in English too; the check right below fails if the timing ever changes.
    await new Promise(resolve => setTimeout(resolve, 0));
    const english = t().conflict;
    setLanguage('ja');
    expect(mounted.view.containerEl.querySelector('.mappy-inline-error')?.textContent).toBe(english);
    await refreshed(mounted);
    expect(labels(mounted)).toContain('持ち物（外部）');
    expect(mounted.view.containerEl.querySelector('.mappy-inline-error')?.textContent)
      .toBe('Markdown が更新されました。もう一度確定すると新しい内容に適用し、取り消すと閉じます。');
    mounted.key(input, 'Enter');
    await refreshed(mounted);
    expect(mounted.source()).toBe(OTHER.replace('  - 予約\n', '  - 予約（編集）\n'));
  });

  it('the save a closing view makes reads the note and applies the draft after an English refusal', async () => {
    const mounted = await mount();
    await draft(mounted, '予約', '閉じる前の下書き');
    silently(mounted, OTHER);
    const refusal = await englishRefusal();
    const applyOver = mounted.store.applyOver.bind(mounted.store);
    vi.spyOn(mounted.store, 'applyOver').mockImplementationOnce(() => Promise.reject(refusal)).mockImplementation(applyOver);
    await mounted.view.onUnloadFile(mounted.file);
    expect(mounted.source()).toBe(OTHER.replace('  - 予約\n', '  - 閉じる前の下書き\n'));
    expect(Notice.log).toEqual([]);
  });

  it('Undo refused in English re-reads the note, as a refused edit does', async () => {
    const mounted = await mount();
    silently(mounted, OTHER);
    const refusal = await englishRefusal();
    vi.spyOn(mounted.store, 'undo').mockImplementation(() => Promise.reject(refusal));
    mounted.key(mounted.canvas, 'z', { metaKey: true });
    await refreshed(mounted);
    expect(labels(mounted)).toContain('持ち物（外部）');
  });

  it('a new topic whose taking back is refused in English stays, with no error, as after any Escape', async () => {
    const mounted = await mount();
    mounted.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await mounted.settle();
    const refusal = await englishRefusal();
    vi.spyOn(mounted.store, 'retract').mockImplementation(() => Promise.reject(refusal));
    const input = mounted.editor();
    if (!input) throw new Error('No draft on the new topic');
    mounted.key(input, 'Escape');
    await mounted.settle();
    expect(mounted.source()).toBe(`${SOURCE}\n## ${t().newTopicTitle}\n`);
    expect(Notice.log).toEqual([]);
    expect(mounted.editor()).toBeNull();
  });
});
