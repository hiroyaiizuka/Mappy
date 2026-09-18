// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, WorkspaceLeaf as ObsidianLeaf, ViewStateResult } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { WorkspaceLeaf } from '../../harness/browser/obsidian';
import type { MindDocument, MindNode } from '../../src/core/markdown';
import { DocumentStore } from '../../src/obsidian/document-store';
import type { ViewRouter } from '../../src/obsidian/view-routing';
import { MindmapView } from '../../src/ui/mindmap-view';

// The browser-harness stand-in for `obsidian`, so the shipped view, renderer, store and modals run against a real DOM.
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });
afterEach(() => { document.body.replaceChildren(); });

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

function documentOf(view: MindmapView): MindDocument {
  const document = view.snapshot()?.document;
  if (!document) throw new Error('The view has not parsed its note');
  return document;
}

interface Mounted {
  view: MindmapView;
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
  view.load();
  await view.onOpen();
  await view.setState({ file: PATH, layout: 'mindmap' }, { history: false } satisfies ViewStateResult);
  await new Promise(resolve => requestAnimationFrame(resolve));
  const canvas = view.containerEl.querySelector<HTMLElement>('.mappy-canvas');
  if (!canvas) throw new Error('The view has no canvas');
  const file = app.asApp<App>().vault.getAbstractFileByPath(PATH);
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
    view, canvas, settle, node, element, key, editor,
    source: () => app.content(file as never),
    external: text => { app.put(PATH, text); },
    refreshed: async () => { await new Promise(resolve => setTimeout(resolve, 60)); await settle(); },
    labels: () => Array.from(view.containerEl.querySelectorAll('.mappy-node'), item => item.getAttribute('aria-label') ?? ''),
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
async function refused(mounted: Mounted, input: HTMLTextAreaElement, text: string): Promise<void> {
  const { source, key, editor, error, refreshed } = mounted;
  const typed = input.value;
  mounted.external(text);
  await refreshed();
  expect(documentOf(mounted.view).source).toBe(text);
  key(input, 'Enter');
  await refreshed();
  expect(source()).toBe(text);
  expect(error()).not.toBe('');
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

    // The map refreshes on its own; the draft is still open on the same node.
    await refreshed();
    expect(labels()).toContain('記録する（外部）');
    expect(documentOf(view).source).toBe(EXTERNAL);
    expect(editor()).toBe(input);

    // Enter again applies the draft on top of the external text instead of failing forever.
    key(input, 'Enter');
    await refreshed();
    const renamed = EXTERNAL.replace('  - 学ぶこと\n', '  - 学ぶこと（編集）\n');
    expect(source()).toBe(renamed);
    expect(editor()).toBeNull();
    expect(view.containerEl.querySelector('.mappy-node.is-selected')?.getAttribute('aria-label')).toBe('学ぶこと（編集）');
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
    await refused(mounted, input, SOURCE.replace('  - 学ぶこと\n', ''));
  });

  it('never guesses which same-named node a draft belongs to after an external change (E04 × E05)', async () => {
    const mounted = await mount(SOURCE);
    const input = await mounted.draft('同じ名前', '同じ名前（編集）', '二つ目');
    await refused(mounted, input, EXTERNAL);
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
    key(input, 'Enter', { metaKey: true });
    await refreshed();
    expect(source()).toBe(EXTERNAL.replace('  - 学ぶこと\n', '  - 学ぶこと\n\n    新しい本文\n'));
    expect(document.contains(input)).toBe(false);
  });
});
