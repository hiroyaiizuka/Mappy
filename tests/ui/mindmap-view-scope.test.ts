// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, WorkspaceLeaf as ObsidianLeaf, ViewStateResult } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { Scope, WorkspaceLeaf } from '../../harness/browser/obsidian';
import { DocumentStore } from '../../src/obsidian/document-store';
import type { ViewRouter } from '../../src/obsidian/view-routing';
import { MindmapView } from '../../src/ui/mindmap-view';

// The browser-harness stand-in for `obsidian`, so the shipped view, renderer and inline editor run against a real DOM.
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });
const opened: MindmapView[] = [];
afterEach(async () => {
  for (const view of opened.splice(0)) { await view.onClose(); view.unload(); }
  document.body.replaceChildren();
});

const PATH = 'Fixtures/scope.md';
const SOURCE = ['---', 'mappy: true', '---', '## 講座の構成', '', '- はじめに', '  - 学ぶこと', '- 記録する', ''].join('\n');

/**
 * E02 / LEV-48: a real F2 is consumed by Obsidian's default hotkey `workspace:edit-file-title` at the window's capture
 * phase unless the active view's scope takes it first. jsdom has no Obsidian keymap, so this fixes what the view
 * registers and how the handler answers; the real key goes through CDP on the test vault (artifacts/lev-48-f2-scope).
 */
async function mount() {
  const app = new HarnessApp();
  app.put(PATH, SOURCE);
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
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 3; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => requestAnimationFrame(resolve));
  };
  const node = (title: string): HTMLElement => {
    const found = Array.from(view.containerEl.querySelectorAll<HTMLElement>('.mappy-node')).find(el => el.getAttribute('aria-label') === title);
    if (!found) throw new Error(`No element for ${title}`);
    return found;
  };
  const key = (target: EventTarget, value: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const editor = (): HTMLTextAreaElement | null => view.containerEl.querySelector<HTMLTextAreaElement>('textarea.mappy-inline-input');
  const select = (title: string): HTMLElement => {
    const element = node(title);
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return element;
  };
  return { app, view, settle, node, key, editor, select, source: () => app.content(app.asApp<App>().vault.getAbstractFileByPath(PATH) as never) };
}

/**
 * What Obsidian 1.14.2 does on a keydown (app.js: Keymap.onKeyEvent → Workspace.scope → the active view's scope →
 * Scope.handleKey): the first handler matching the key runs at the window's capture phase, and `false` from it
 * prevents the default and stops the event, so neither the global hotkey nor the canvas listener sees it.
 */
function installKeymap(view: MindmapView): () => void {
  const onKey = (event: KeyboardEvent): void => {
    const scope = view.scope as Scope | null;
    if (!scope) return;
    const modifiers = [event.altKey && 'Alt', event.ctrlKey && 'Ctrl', event.metaKey && 'Meta', event.shiftKey && 'Shift'].filter(Boolean).join(',');
    for (const handler of scope.keys) {
      if ((handler.key === null || handler.key === event.key) && (handler.modifiers === null || handler.modifiers === modifiers)) {
        const result: unknown = handler.func(event, { key: event.key, modifiers, vkey: event.key });
        if (result === false) { event.preventDefault(); event.stopPropagation(); }
        return;
      }
    }
  };
  window.addEventListener('keydown', onKey, true);
  return () => { window.removeEventListener('keydown', onKey, true); };
}

describe('MindmapView keyboard scope (E02: F2 against the default hotkey)', () => {
  it('registers F2 without modifiers on its own scope under the app scope', async () => {
    const { app, view } = await mount();
    const scope = view.scope as Scope | null;
    expect(scope).toBeInstanceOf(Scope);
    expect(scope?.parent).toBe(app.scope);
    expect(scope?.keys.map(handler => ({ modifiers: handler.modifiers, key: handler.key }))).toEqual([{ modifiers: '', key: 'F2' }]);
  });

  it('opens the inline editor once when the keymap hands F2 to the scope, and Escape closes it without a write', async () => {
    const { view, settle, key, editor, select, source } = await mount();
    const uninstall = installKeymap(view);
    try {
      const element = select('学ぶこと');
      const event = key(element, 'F2');
      await settle();
      expect(event.defaultPrevented).toBe(true);
      const input = editor();
      expect(input).not.toBeNull();
      expect(input?.value).toBe('学ぶこと');
      expect(view.containerEl.querySelectorAll('textarea.mappy-inline-input')).toHaveLength(1);
      // F2 inside the editor is left to the editor (the scope declines, the canvas listener ignores inputs).
      const again = key(input as HTMLTextAreaElement, 'F2');
      await settle();
      expect(again.defaultPrevented).toBe(false);
      expect(editor()).toBe(input);
      key(input as HTMLTextAreaElement, 'Escape');
      await settle();
      expect(editor()).toBeNull();
      expect(source()).toBe(SOURCE);
    } finally { uninstall(); }
  });

  it('takes F2 on the node selected at open, and declines it on a floating control outside the canvas', async () => {
    const { view, settle, key, editor, node } = await mount();
    const scope = view.scope as Scope;
    const [handler] = scope.keys;
    if (!handler) throw new Error('No F2 handler');
    const context = { key: 'F2', modifiers: '', vkey: 'F2' };
    const f2 = (target: Element | null): KeyboardEvent => {
      const event = new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true });
      Object.defineProperty(event, 'target', { value: target });
      return event;
    };
    // The H2 is selected when the map opens; the focused node is where a real F2 lands after Tab into the canvas.
    const selected = f2(node('講座の構成'));
    expect(handler.func(selected, context)).toBe(false);
    expect(selected.defaultPrevented).toBe(true);
    await settle();
    expect(editor()?.value).toBe('講座の構成');
    key(editor() as HTMLTextAreaElement, 'Escape');
    await settle();
    expect(editor()).toBeNull();
    // A floating control of the same view, outside the canvas: not the map's key.
    const outside = f2(view.containerEl.querySelector('.mappy-floating button'));
    expect(handler.func(outside, context)).toBeUndefined();
    expect(outside.defaultPrevented).toBe(false);
    await settle();
    expect(editor()).toBeNull();
  });
});
