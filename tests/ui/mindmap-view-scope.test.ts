// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installObsidianDom } from '../../harness/browser/dom';
import { Scope } from '../../harness/browser/obsidian';
import type { MindmapView } from '../../src/ui/mindmap-view';
import { keyAt } from './keys';
import { mountMapView, type MountedMapView } from './map-view-mount';

// The browser-harness stand-in for `obsidian`, so the shipped view, renderer and inline editor run against a real DOM.
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });
const opened: MountedMapView[] = [];
afterEach(async () => {
  for (const mounted of opened.splice(0)) await mounted.close();
  document.body.replaceChildren();
});

const PATH = 'Fixtures/scope.md';
const SOURCE = ['---', 'mappy: true', '---', '## 講座の構成', '', '- はじめに', '  - 学ぶこと', '- 記録する', ''].join('\n');

/**
 * E02 / LEV-48: a real F2 is consumed by Obsidian's default hotkey `workspace:edit-file-title` at the window's capture
 * phase unless the active view's scope takes it first. jsdom has no Obsidian keymap, so this fixes what the view
 * registers and how the handler answers, and routes keydowns through the harness Scope's copy of Obsidian's
 * `handleKey`; the real key goes through CDP on the test vault (artifacts/lev-48-f2-scope).
 */
async function mount() {
  const mounted = await mountMapView(PATH, SOURCE);
  opened.push(mounted);
  // Stands in for Obsidian's HotkeyManager on the root scope: a catch-all that records every key it is offered.
  const offered: string[] = [];
  mounted.app.scope.register(null, null, event => { offered.push(event.key); return undefined; });
  return { ...mounted, offered, scope: mounted.view.scope as Scope };
}

/** What Obsidian's Keymap does at the window's capture phase: the active view's scope decides, `false` consumes the key. */
function installKeymap(view: MindmapView): () => void {
  const onKey = (event: KeyboardEvent): void => {
    const scope = view.scope as Scope | null;
    if (scope?.handleKey(event) === false) { event.preventDefault(); event.stopPropagation(); }
  };
  window.addEventListener('keydown', onKey, true);
  return () => { window.removeEventListener('keydown', onKey, true); };
}

describe('MindmapView keyboard scope (E02: F2 against the default hotkey)', () => {
  it('registers F2 without modifiers on its own scope under the app scope', async () => {
    const { app, scope } = await mount();
    expect(scope).toBeInstanceOf(Scope);
    expect(scope.parent).toBe(app.scope);
    expect(scope.keys.map(handler => ({ modifiers: handler.modifiers, key: handler.key }))).toEqual([{ modifiers: '', key: 'F2' }]);
  });

  it('opens the inline editor once when the keymap hands F2 to the scope, and Escape closes it without a write', async () => {
    const { view, settle, key, editor, select, source, offered } = await mount();
    const uninstall = installKeymap(view);
    try {
      const event = key(select('学ぶこと'), 'F2');
      await settle();
      expect(event.defaultPrevented).toBe(true);
      const input = editor();
      expect(input?.value).toBe('学ぶこと');
      expect(view.containerEl.querySelectorAll('textarea.mappy-inline-input')).toHaveLength(1);
      // F2 inside the editor stays the map's key: nothing happens, and the default hotkey is not offered it.
      const again = key(input as HTMLTextAreaElement, 'F2');
      await settle();
      expect(again.defaultPrevented).toBe(true);
      expect(editor()).toBe(input);
      expect(input?.value).toBe('学ぶこと');
      key(input as HTMLTextAreaElement, 'Escape');
      await settle();
      expect(editor()).toBeNull();
      expect(source()).toBe(SOURCE);
      // Escape went past the view's scope to the root, as any key the map did not register does; F2 never did.
      expect(offered).toEqual(['Escape']);
    } finally { uninstall(); }
  });

  it('takes F2 anywhere in the view — editing on the canvas, idle on a floating control — and declines it outside', async () => {
    const { view, settle, key, editor, node, scope, offered } = await mount();
    // The H2 is selected when the map opens; the focused node is where a real F2 lands after Tab into the canvas.
    const selected = keyAt(node('講座の構成'), 'F2');
    expect(scope.handleKey(selected)).toBe(false);
    await settle();
    expect(editor()?.value).toBe('講座の構成');
    key(editor() as HTMLTextAreaElement, 'Escape');
    await settle();
    expect(editor()).toBeNull();
    // A floating control of the same view: the map keeps the key and does nothing with it.
    const button = view.containerEl.querySelector('.mappy-floating button');
    expect(button).not.toBeNull();
    expect(scope.handleKey(keyAt(button, 'F2'))).toBe(false);
    await settle();
    expect(editor()).toBeNull();
    // Outside the view (the leaf is active, the focus is elsewhere): declined. Obsidian 1.14.2 then runs no other
    // handler for a key the view registered, which the harness Scope copies, so the default is not offered either.
    expect(scope.handleKey(keyAt(document.body, 'F2'))).toBeUndefined();
    expect(offered).toEqual([]);
    // Any other key passes the view's scope by and reaches the root scope, where Obsidian's hotkeys live.
    expect(scope.handleKey(keyAt(node('講座の構成'), 'Enter'))).toBeUndefined();
    expect(scope.handleKey(keyAt(node('講座の構成'), 'F2', { shiftKey: true }))).toBeUndefined();
    expect(offered).toEqual(['Enter', 'F2']);
    expect(editor()).toBeNull();
  });
});
