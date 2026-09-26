// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, TFile, WorkspaceLeaf as ObsidianLeaf, ViewStateResult } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { WorkspaceLeaf } from '../../harness/browser/obsidian';
import type { MindDocument, MindNode } from '../../src/core/markdown';
import { DocumentStore } from '../../src/obsidian/document-store';
import type { ViewRouter } from '../../src/obsidian/view-routing';
import { MindmapView, NODE_GONE_MESSAGE } from '../../src/ui/mindmap-view';
import { accessibleName } from './accessible-name';

// The browser-harness stand-in for `obsidian`, so the shipped view, renderer, store and modals run against a real DOM.
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });
/** Views opened by `mount`, closed after each test so their refresh timers and vault listeners do not outlive it. */
const opened: MindmapView[] = [];
afterEach(async () => {
  for (const view of opened.splice(0)) { await view.onClose(); view.unload(); }
  document.body.replaceChildren();
});

const PATH = 'Fixtures/external.md';
/** The list note the LEV-16 probe edits on the real Obsidian: two same-named branches, each with a body and a child. */
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 講座の構成', '',
  '- はじめに', '  - 学ぶこと', '  - 全体の流れ',
  '- 同じ名前', '  一つ目の本文', '  - 一つ目の子',
  '- 同じ名前', '  二つ目の本文', '  - 二つ目の子',
  '- 記録する', '  - 毎日のログ', '',
].join('\n');
/** What a sync tool or another app writes while a draft is open: a branch the draft does not touch. */
const EXTERNAL = SOURCE.replace('- 記録する\n', '- 記録する（外部）\n');
const CONFLICT = 'Markdown が変更されています。マップを更新してから再編集してください。';
const REFRESHED = 'Markdown が更新されました。もう一度確定すると新しい内容に適用し、取り消すと閉じます。';
const NODE_CHANGED = NODE_GONE_MESSAGE;
const TEXT_CHANGED = '編集中の内容が Markdown 側で変わりました。取り消して新しい内容を確認してください。';

function documentOf(view: MindmapView): MindDocument {
  const document = view.snapshot()?.document;
  if (!document) throw new Error('The view has not parsed its note');
  return document;
}

interface Mounted {
  app: HarnessApp;
  view: MindmapView;
  file: TFile;
  canvas: HTMLElement;
  source: () => string;
  /** Rewrite the note behind the view's back, as a sync tool or another app would. */
  external: (text: string) => void;
  /** Let queued saves, refreshes and one layout frame run. */
  settle: () => Promise<void>;
  /** Wait out the view's 45 ms refresh debounce after a `modify`, then settle. */
  refreshed: () => Promise<void>;
  node: (title: string, bodyHint?: string) => MindNode;
  element: (id: string) => HTMLElement;
  labels: () => string[];
  key: (target: EventTarget, key: string, init?: KeyboardEventInit) => void;
  /** The inline title editor and its error line. */
  editor: () => HTMLTextAreaElement | null;
  error: () => string;
  /** Open the inline editor on a node and type a draft without committing it. */
  draft: (title: string, text: string, bodyHint?: string) => Promise<HTMLTextAreaElement>;
}

async function mount(source: string): Promise<Mounted> {
  const app = new HarnessApp();
  app.put(PATH, source);
  const leaf = new WorkspaceLeaf(app.asApp<App>());
  const store = new DocumentStore(app.asApp<App>());
  const view = new MindmapView(leaf as unknown as ObsidianLeaf, store, {} as ViewRouter);
  leaf.view = view as unknown as WorkspaceLeaf['view'];
  document.body.append(view.containerEl);
  opened.push(view);
  view.load();
  await view.onOpen();
  await view.setState({ file: PATH, layout: 'mindmap' }, { history: false } satisfies ViewStateResult);
  await new Promise(resolve => requestAnimationFrame(resolve));
  const canvas = view.containerEl.querySelector<HTMLElement>('.mappy-canvas');
  if (!canvas) throw new Error('The view has no canvas');
  const file = app.asApp<App>().vault.getAbstractFileByPath(PATH) as TFile | null;
  if (!file) throw new Error('The note is missing from the harness vault');
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 3; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => requestAnimationFrame(resolve));
  };
  const element = (id: string): HTMLElement => {
    const found = view.containerEl.querySelector<HTMLElement>(`.mappy-node[data-node-id="${id}"]`);
    if (!found) throw new Error(`No element for ${id}`);
    return found;
  };
  const node = (title: string, bodyHint?: string): MindNode => {
    const doc = documentOf(view);
    const matches = doc.nodes.filter(candidate => candidate.title === title
      && (!bodyHint || doc.source.slice(candidate.bodyFrom, candidate.bodyTo).includes(bodyHint)));
    const [match] = matches;
    if (matches.length !== 1 || !match) throw new Error(`Expected one node ${title}, got ${matches.length}`);
    return match;
  };
  const key = (target: EventTarget, value: string, init: KeyboardEventInit = {}): void => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init }));
  };
  const editor = (): HTMLTextAreaElement | null => view.containerEl.querySelector<HTMLTextAreaElement>('textarea.mappy-inline-input');
  return {
    app, view, file, canvas, settle, node, element, key, editor,
    source: () => app.content(file),
    external: text => { app.put(PATH, text); },
    refreshed: async () => { await new Promise(resolve => setTimeout(resolve, 60)); await settle(); },
    labels: () => Array.from(view.containerEl.querySelectorAll('.mappy-node'), item => accessibleName(item)),
    error: () => view.containerEl.querySelector('.mappy-inline-error')?.textContent ?? '',
    draft: async (title, text, bodyHint) => {
      const target = element(node(title, bodyHint).id);
      target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      await settle();
      const input = editor();
      if (!input) throw new Error(`The inline editor did not open on ${title}`);
      input.value = text;
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return input;
    },
  };
}

function menuItem(title: string): HTMLElement {
  const item = Array.from(document.querySelectorAll<HTMLElement>('.menu .menu-item'))
    .find(candidate => candidate.querySelector('.menu-item-title')?.textContent === title);
  if (!item) throw new Error(`Menu item ${title} is not open`);
  return item;
}

/** An external text the draft cannot be applied to: the note is not overwritten and the draft stays open until Escape. */
async function refused(mounted: Mounted, input: HTMLTextAreaElement, text: string, message: string): Promise<void> {
  const { source, key, editor, error, refreshed } = mounted;
  const typed = input.value;
  mounted.external(text);
  await refreshed();
  expect(documentOf(mounted.view).source).toBe(text);
  key(input, 'Enter');
  await refreshed();
  expect(source()).toBe(text);
  expect(error()).toBe(message);
  expect(editor()).toBe(input);
  expect(input.value).toBe(typed);
  key(input, 'Escape');
  await refreshed();
  expect(editor()).toBeNull();
  expect(source()).toBe(text);
}

describe('MindmapView drafts across an external change (E05 with E03 and E04)', () => {
  it('refuses the draft while the map is stale, keeps it, then applies it to the refreshed note on the next Enter', async () => {
    const mounted = await mount(SOURCE);
    const { source, key, editor, error, draft, refreshed, labels, view, external, node, canvas } = mounted;
    const input = await draft('学ぶこと', '学ぶこと（編集）');
    // The external write lands and Enter follows before the 45 ms refresh: the map still holds the old note.
    external(EXTERNAL);
    key(input, 'Enter');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(source()).toBe(EXTERNAL);
    expect(error()).toBe(CONFLICT);
    expect(editor()).toBe(input);
    expect(input.value).toBe('学ぶこと（編集）');

    // The map refreshes on its own; the draft is still open on the same node and the error line says what to do now.
    await refreshed();
    expect(labels()).toContain('記録する（外部）');
    expect(documentOf(view).source).toBe(EXTERNAL);
    expect(editor()).toBe(input);
    expect(error()).toBe(REFRESHED);

    // Enter again applies the draft on top of the external text instead of failing forever.
    key(input, 'Enter');
    await refreshed();
    const renamed = EXTERNAL.replace('  - 学ぶこと\n', '  - 学ぶこと（編集）\n');
    expect(source()).toBe(renamed);
    expect(editor()).toBeNull();
    expect(accessibleName(view.containerEl.querySelector('.mappy-node.is-selected') as HTMLElement)).toBe('学ぶこと（編集）');
    expect(node('学ぶこと（編集）').title).toBe('学ぶこと（編集）');

    // E03: the retried rename is one history entry on top of the external text.
    key(canvas, 'z', { metaKey: true });
    await refreshed();
    expect(source()).toBe(EXTERNAL);
    key(canvas, 'z', { metaKey: true, shiftKey: true });
    await refreshed();
    expect(source()).toBe(renamed);
  });

  it('keeps the draft and refuses it when the external change removed the node', async () => {
    const mounted = await mount(SOURCE);
    const input = await mounted.draft('学ぶこと', '学ぶこと（編集）');
    await refused(mounted, input, SOURCE.replace('  - 学ぶこと\n', ''), NODE_CHANGED);
  });

  it('never guesses which same-named node a draft belongs to after an external change (E04 × E05)', async () => {
    const mounted = await mount(SOURCE);
    const input = await mounted.draft('同じ名前', '同じ名前（編集）', '二つ目');
    await refused(mounted, input, EXTERNAL, NODE_CHANGED);
  });

  it('refuses the draft when the external change renamed the very node being edited, even though its id carried over', async () => {
    const mounted = await mount(SOURCE);
    const input = await mounted.draft('学ぶこと', '学ぶこと（編集）');
    // A title-only edit keeps the node's id (matched by its unchanged surroundings), so the text itself is what must match.
    await refused(mounted, input, SOURCE.replace('  - 学ぶこと\n', '  - 学ぶこと（外部）\n'), TEXT_CHANGED);
    expect(mounted.node('学ぶこと（外部）').title).toBe('学ぶこと（外部）');
  });

  it('applies the draft to a node that only moved, its title and body unchanged', async () => {
    const mounted = await mount(SOURCE);
    const { source, key, editor, refreshed, external } = mounted;
    const input = await mounted.draft('学ぶこと', '学ぶこと（編集）');
    const moved = SOURCE.replace('  - 学ぶこと\n', '').replace('  - 毎日のログ\n', '  - 毎日のログ\n  - 学ぶこと\n');
    external(moved);
    await refreshed();
    key(input, 'Enter');
    await refreshed();
    expect(source()).toBe(moved.replace('  - 学ぶこと\n', '  - 学ぶこと（編集）\n'));
    expect(editor()).toBeNull();
  });

  it('refuses a body draft when the external change wrote a body under the same node', async () => {
    const { source, key, refreshed, element, node, external, settle } = await mount(SOURCE);
    element(node('学ぶこと').id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    menuItem('本文・リンクを編集').click();
    await settle();
    const input = document.querySelector<HTMLTextAreaElement>('.modal .mappy-edit-input');
    if (!input) throw new Error('The body modal did not open');
    expect(input.value).toBe('');
    input.value = '新しい本文';
    const withBody = SOURCE.replace('  - 学ぶこと\n', '  - 学ぶこと\n    外部の本文\n');
    external(withBody);
    await refreshed();
    key(input, 'Enter', { metaKey: true });
    await refreshed();
    expect(source()).toBe(withBody);
    expect(document.querySelector('.modal .mappy-edit-error')?.textContent).toBe(TEXT_CHANGED);
    expect(document.contains(input)).toBe(true);
    expect(input.value).toBe('新しい本文');
  });

  it('applies a body draft kept through an external change once the map has refreshed', async () => {
    const { source, key, refreshed, element, node, external, settle } = await mount(SOURCE);
    const target = element(node('学ぶこと').id);
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    menuItem('本文・リンクを編集').click();
    await settle();
    const input = document.querySelector<HTMLTextAreaElement>('.modal .mappy-edit-input');
    if (!input) throw new Error('The body modal did not open');
    input.value = '新しい本文';
    external(EXTERNAL);
    key(input, 'Enter', { metaKey: true });
    await settle();
    expect(source()).toBe(EXTERNAL);
    expect(document.querySelector('.modal .mappy-edit-error')?.textContent).toBe(CONFLICT);
    expect(document.contains(input)).toBe(true);

    await refreshed();
    expect(document.querySelector('.modal .mappy-edit-error')?.textContent).toBe(REFRESHED);
    key(input, 'Enter', { metaKey: true });
    await refreshed();
    expect(source()).toBe(EXTERNAL.replace('  - 学ぶこと\n', '  - 学ぶこと\n\n    新しい本文\n'));
    expect(document.contains(input)).toBe(false);
  });

  it('refuses a title draft when the external change wrote a body under the node, as the doc row says', async () => {
    const mounted = await mount(SOURCE);
    const input = await mounted.draft('学ぶこと', '学ぶこと（編集）');
    await refused(mounted, input, SOURCE.replace('  - 学ぶこと\n', '  - 学ぶこと\n    外部の本文\n'), TEXT_CHANGED);
  });

  it('re-reads the note itself after a refused save, so the retry works even where no vault event reports the change', async () => {
    const mounted = await mount(SOURCE);
    const { app, source, key, editor, error, draft, refreshed, labels } = mounted;
    const input = await draft('学ぶこと', '学ぶこと（編集）');
    // The note changes on disk but the watcher stays silent (a mount Obsidian does not observe, an app that has lost focus).
    const silent = vi.spyOn(app.vaultEvents, 'trigger').mockImplementation(() => undefined);
    app.put(PATH, EXTERNAL);
    silent.mockRestore();
    key(input, 'Enter');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(source()).toBe(EXTERNAL);
    expect(error()).toBe(CONFLICT);
    await refreshed();
    expect(labels()).toContain('記録する（外部）');
    expect(error()).toBe(REFRESHED);
    key(input, 'Enter');
    await refreshed();
    expect(source()).toBe(EXTERNAL.replace('  - 学ぶこと\n', '  - 学ぶこと（編集）\n'));
    expect(editor()).toBeNull();
  });

  // Review 3 of LEV-202: asking for another edit (a double click) confirmed the open draft, which wrote one held
  // after an external change without the Enter its REFRESHED line asks for. Blur never saves such a draft either.
  it.each(['another node', 'the empty canvas'])('does not write a draft held after an external change when %s is double-clicked', async (where) => {
    const mounted = await mount(SOURCE);
    const { app, source, key, editor, error, draft, refreshed, canvas, element, node } = mounted;
    const input = await draft('学ぶこと', '学ぶこと（編集）');
    const silent = vi.spyOn(app.vaultEvents, 'trigger').mockImplementation(() => undefined);
    app.put(PATH, EXTERNAL);
    silent.mockRestore();
    key(input, 'Enter');
    await refreshed();
    expect(error()).toBe(REFRESHED);
    const target = where === 'another node' ? element(node('毎日のログ').id) : canvas;
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await refreshed();
    expect(source()).toBe(EXTERNAL);
    expect(editor()).toBe(input);
    expect(input.value).toBe('学ぶこと（編集）');
    expect(error()).toBe(REFRESHED);
  });

  it('leaves a validation error alone when the map refreshes, since Enter would not apply that draft', async () => {
    const mounted = await mount(SOURCE);
    const { source, key, editor, error, draft, refreshed, external } = mounted;
    // A line break was the example until LEV-202 made it a break inside the node; a task marker still changes the syntax.
    const input = await draft('学ぶこと', '[ ] 学ぶこと');
    key(input, 'Enter');
    await refreshed();
    const validation = error();
    expect(validation).toBe('この名前は見出し構文を変えてしまいます。Markdown 側で編集してください。');
    external(EXTERNAL);
    await refreshed();
    expect(error()).toBe(validation);
    expect(editor()).toBe(input);
    expect(source()).toBe(EXTERNAL);
  });

  it('drops a kept draft when the note itself is deleted', async () => {
    const mounted = await mount(SOURCE);
    const { app, file, key, editor, draft, refreshed, external } = mounted;
    const input = await draft('学ぶこと', '学ぶこと（編集）');
    external(EXTERNAL);
    key(input, 'Enter');
    await refreshed();
    expect(editor()).toBe(input);
    app.vaultEvents.trigger('delete', file);
    await refreshed();
    expect(editor()).toBeNull();
    expect(mounted.view.containerEl.querySelector('.mappy-inline-error')).toBeNull();
  });

  // LEV-140: the view's own writes are not an external change. Pasting an image while a node is being edited
  // used to append the image to that node's body, then refuse the edit because "the body changed".
  it('keeps the draft usable after the map itself attaches an image to the node being edited', async () => {
    const mounted = await mount(SOURCE);
    const { canvas, source, key, editor, error, draft, refreshed, settle } = mounted;
    const input = await draft('学ぶこと', '学ぶこと（編集）');
    const image = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { files: [image] } });
    canvas.dispatchEvent(paste);
    await settle();
    await settle();
    // The image lands under the node being edited, and the draft is still the user's text.
    expect(source()).toContain('![[1-shot.png]]');
    expect(editor()).toBe(input);
    expect(error()).toBe('');
    // Enter applies the draft to the note the map itself has just written.
    key(input, 'Enter');
    await refreshed();
    expect(error()).toBe('');
    expect(editor()).toBeNull();
    expect(source()).toContain('- 学ぶこと（編集）');
    expect(source()).toContain('![[1-shot.png]]');
  });

  it('confirms the open draft and runs the command instead of refusing it', async () => {
    const mounted = await mount(SOURCE);
    const { view, source, editor, draft, refreshed } = mounted;
    const input = await draft('学ぶこと', '学ぶこと（編集）');
    const target = documentOf(view).nodes.find(candidate => candidate.title === 'はじめに');
    if (!target) throw new Error('Missing node');
    await (view as unknown as { execute(command: unknown): Promise<void> }).execute({ type: 'add-child', nodeId: target.id });
    await refreshed();
    // The draft was written, not thrown away, and the command ran.
    expect(source()).toContain('- 学ぶこと（編集）');
    expect(documentOf(view).nodes.filter(node => node.title === '').length).toBe(1);
    expect(editor()).not.toBe(input);
  });



  it('keeps the ids of the same-named nodes across a write of its own, so the draft stays on its node', async () => {
    // LEV-142 / LEV-146: matched by what the text says, ids can only be carried for titles that are unique,
    // so every node sharing a title used to get a fresh one whenever the note was written — including by the
    // map itself. The draft then failed to find its node although nothing moved. A write of the map's own
    // carries the ids by where its edits leave each node (`parseMarkdown(…, edits)`), so nothing is renumbered.
    const mounted = await mount(SOURCE);
    const { canvas, source, key, editor, error, draft, refreshed, settle, view } = mounted;
    const input = await draft('同じ名前', '同じ名前（編集）', '一つ目の本文');
    const before = documentOf(view).nodes.filter(node => node.title === '同じ名前').map(node => node.id);
    const image = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { files: [image] } });
    canvas.dispatchEvent(paste);
    await settle();
    await settle();
    expect(source()).toContain('![[1-shot.png]]');
    // Both kept their ids, which is what keeps the draft — and the folds, and the selection — on their nodes.
    const after = documentOf(view).nodes.filter(node => node.title === '同じ名前').map(node => node.id);
    expect(after).toEqual(before);
    // The draft is still on the node it was opened on, so Enter writes it.
    key(input, 'Enter');
    await refreshed();
    expect(error()).toBe('');
    expect(editor()).toBeNull();
    expect(source()).toContain('- 同じ名前（編集）');
    expect(source()).toContain('![[1-shot.png]]');
  });


  it('stops trusting where its own write left the node once someone else edits the note', async () => {
    // The ids a write carries (LEV-146) answer for that write alone. An external change after it leaves the
    // places a guess again, and E05 does not guess: the draft is refused, not applied to whatever now sits
    // where its node was.
    const mounted = await mount(SOURCE);
    const { canvas, source, key, editor, error, draft, refreshed, settle, external } = mounted;
    const input = await draft('同じ名前', '同じ名前（編集）', '一つ目の本文');
    const image = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { files: [image] } });
    canvas.dispatchEvent(paste);
    await settle();
    await settle();
    const written = source();
    expect(written).toContain('![[1-shot.png]]');
    // Someone else now writes the note, and this map has no edits of theirs to carry its nodes by.
    const outside = written.replace('## 講座の構成\n', '## 講座の構成\n\n外から足した前書き。\n');
    external(outside);
    await refreshed();
    key(input, 'Enter');
    await refreshed();
    // Refused, and the draft is still there to retry or cancel — not written onto a node it guessed at.
    expect(error()).not.toBe('');
    expect(editor()).toBe(input);
    expect(source()).toBe(outside);
  });

});

describe('MindmapView keeps the open draft measured when a refresh restyles its node (LEV-198)', () => {
  it('measures the draft again after an external change moves the node being edited to the first level', async () => {
    // The measuring path (no `field-sizing`): jsdom has no layout, so a first-level node's bolder text reads wider.
    vi.stubGlobal('CSS', { supports: () => false });
    const scrollWidth = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLTextAreaElement) {
      return this.closest('.mappy-node')?.classList.contains('is-stage') ? 200 : 100;
    });
    try {
      const mounted = await mount(SOURCE);
      const input = await mounted.draft('学ぶこと', '学ぶこと（編集）');
      expect(input.closest('.mappy-node')?.classList.contains('is-stage')).toBe(false);
      expect(input.style.width).toBe('102px');
      // 学ぶこと becomes a first-level item: its text (and the draft) is drawn at weight 600 from now on.
      mounted.external(SOURCE.replace('- はじめに\n  - 学ぶこと\n', '- 学ぶこと\n- はじめに\n'));
      await mounted.refreshed();
      expect(mounted.editor()).toBe(input);
      expect(input.closest('.mappy-node')?.classList.contains('is-stage')).toBe(true);
      expect(input.style.width).toBe('202px');
    } finally {
      scrollWidth.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('measures a draft opened in a pane with no layout once the pane is resized into view', async () => {
    vi.stubGlobal('CSS', { supports: () => false });
    let width = 0;
    const scrollWidth = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollWidth', 'get').mockImplementation(() => width);
    try {
      const mounted = await mount(SOURCE);
      const input = await mounted.draft('学ぶこと', '学ぶこと（編集）');
      // Hidden: nothing to measure, and no width is pinned.
      expect(input.style.width).toBe('');
      width = 150;
      mounted.view.onResize();
      expect(input.style.width).toBe('152px');
    } finally {
      scrollWidth.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
