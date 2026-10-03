// @vitest-environment jsdom
/**
 * LEV-307: ⌘↵ in the AI's input against Obsidian's keymap. Obsidian 1.14.4 runs its keymap at the window's capture
 * phase, and the default hotkey Mod+Enter (`editor:open-link-in-new-leaf`) always reports itself run, so the keymap
 * prevented and stopped the key before the card's keydown heard it: ⌘↵ ran nothing. jsdom has no Obsidian keymap; here
 * the harness `Keymap` (a copy of 1.14.4's `onKeyEvent` and scope stack) is routed from the window's capture phase, and
 * the root scope holds a stand-in for that hotkey that consumes Mod+Enter wherever it is offered. Mod is Meta: the
 * platform is a Mac for this file. This is not the real key on the real app — that is the CDP case on the test vault
 * (`npm run harness:e2e:ai-fake-engine`), which the orchestrator runs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HarnessApp } from '../browser-harness/app';
import { installObsidianDom } from '../browser-harness/dom';
import { Notice, Scope, WorkspaceScope } from '../browser-harness/obsidian';
import type { AiProgress, AiRequest, AiResult, AiRunner } from '../../src/ai/contract';
import { t } from '../../src/i18n';
import { aiRunLock, type AiServices } from '../../src/ui/ai/services';
import { mountMapView } from './map-view-mount';
import { closeOpenViews } from '../mocks/open-views';

vi.mock('obsidian', () => import('../browser-harness/obsidian'));

const platform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
beforeAll(() => {
  installObsidianDom();
  Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' });
});
afterAll(() => {
  Reflect.deleteProperty(navigator, 'platform');
  if (platform) Object.defineProperty(Navigator.prototype, 'platform', platform);
});

const uninstalls: (() => void)[] = [];
afterEach(async () => {
  for (const uninstall of uninstalls.splice(0)) uninstall();
  await closeOpenViews();
  document.body.replaceChildren();
  Notice.log.length = 0;
});

const PATH = 'Fixtures/ai-keys.md';
const LIST = ['---', 'mappy: true', '---', '## 旅の計画', '', '- 温泉旅行', '  - 予約', '- 持ち物', ''].join('\n');

class HandRunner implements AiRunner {
  readonly requests: AiRequest[] = [];
  run(request: AiRequest, _progress: (progress: AiProgress) => void, signal: AbortSignal): Promise<AiResult> {
    this.requests.push(request);
    return new Promise(resolve => { signal.addEventListener('abort', () => { resolve({ kind: 'cancelled' }); }); });
  }
}

function services(runner: AiRunner): AiServices {
  return {
    state: () => ({ kind: 'active' }),
    onChange: () => () => undefined,
    refresh: () => Promise.resolve({ kind: 'active' }),
    createRunner: () => runner,
    defaultEngine: () => 'claude',
    readAttachment: () => Promise.reject(new Error('No attachment in these cases')),
  };
}

/**
 * The map with the AI, Obsidian's keymap on the window's capture phase, and the default Mod+Enter on the root scope.
 * `stops: false` is a keymap that prevents a consumed key but lets it go on to the card, so the card's own keydown
 * hears the key the input's scope already ran.
 */
async function mount(options: { stops?: boolean } = {}) {
  const app = new HarnessApp();
  const runner = new HandRunner();
  const mounted = await mountMapView(PATH, LIST, 'mindmap', app, { prepare: view => { view.setAi(services(runner)); } });
  const keymap = app.keymap;
  // The window's base scope (1.14.4): the workspace's, over the app's, handing keys to the active view's scope — the map's.
  const workspace = new WorkspaceScope(app.scope, () => mounted.view.scope as unknown as Scope | null);
  keymap.pushScope(workspace);
  const base = keymap.scope;
  // What the default Mod+Enter did: its command ran (it dispatches `open-link` on the focus) and the key was consumed.
  const defaults: (EventTarget | null)[] = [];
  app.scope.register(null, null, (event, context) => {
    if (context.modifiers !== 'Meta' || event.key !== 'Enter') return undefined;
    defaults.push(event.target);
    return false;
  });
  const onKey = (event: KeyboardEvent): void => {
    if (options.stops === false) { if (keymap.scope.handleKey(event) === false) event.preventDefault(); }
    else keymap.onKeyEvent(event);
  };
  window.addEventListener('keydown', onKey, true);
  uninstalls.push(() => { window.removeEventListener('keydown', onKey, true); });
  const card = (): HTMLElement => {
    const element = mounted.view.containerEl.querySelector<HTMLElement>('.mappy-ai-card');
    if (!element) throw new Error('No AI card');
    return element;
  };
  const open = async (): Promise<HTMLTextAreaElement> => {
    mounted.select('温泉旅行');
    const button = mounted.view.containerEl.querySelector<HTMLButtonElement>('.mappy-ai-button');
    if (!button) throw new Error('No AI button');
    button.click();
    await mounted.settle();
    const input = card().querySelector<HTMLTextAreaElement>('textarea.mappy-ai-instruction');
    if (!input) throw new Error('The input did not open');
    input.value = 'この旅行で決めることは？';
    return input;
  };
  const press = async (target: EventTarget, init: KeyboardEventInit = {}): Promise<KeyboardEvent> => {
    const event = mounted.key(target, 'Enter', { metaKey: true, ...init });
    await mounted.settle();
    return event;
  };
  return { ...mounted, keymap, base, defaults, runner, card, open, press };
}

describe('⌘↵ in the AI input against Obsidian\'s Mod+Enter (LEV-307)', () => {
  it('runs once with the focus in the input, though the default Mod+Enter takes the key first', async () => {
    const mounted = await mount();
    const input = await mounted.open();
    expect(document.activeElement).toBe(input);
    const event = await mounted.press(input);
    expect(mounted.runner.requests.map(request => request.instruction)).toEqual(['この旅行で決めることは？']);
    expect(event.defaultPrevented).toBe(true);
    expect(mounted.defaults).toEqual([]);
    // The run started and the input closed: the key is Obsidian's again.
    expect(mounted.card().querySelector('textarea')).toBeNull();
    expect(mounted.keymap.scope).toBe(mounted.base);
  });

  // jsdom's synthetic composition events and key flags, not an OS IME: the real IME is the person's check (LEV-307 PR).
  it('runs nothing on synthetic composition keys (compositionstart, isComposing, Process), and runs once after them', async () => {
    const mounted = await mount();
    const input = await mounted.open();
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const composing = await mounted.press(input);
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    const flagged = await mounted.press(input, { isComposing: true });
    mounted.key(input, 'Process', { metaKey: true });
    await mounted.settle();
    expect(mounted.runner.requests).toHaveLength(0);
    // The IME's key is not handed to the default either: no new tab opens over the reading being confirmed.
    expect(composing.defaultPrevented).toBe(true);
    expect(flagged.defaultPrevented).toBe(true);
    expect(mounted.defaults).toEqual([]);
    expect(mounted.card().querySelector('textarea')).toBe(input);
    await mounted.press(input);
    expect(mounted.runner.requests).toHaveLength(1);
  });

  it('sends once: the input\'s scope runs the key and the card\'s keydown never hears it', async () => {
    const mounted = await mount();
    const input = await mounted.open();
    const heard: string[] = [];
    input.addEventListener('keydown', event => { heard.push(event.key); });
    await mounted.press(input);
    expect(mounted.runner.requests).toHaveLength(1);
    expect(heard).toEqual([]);
    // A second submit would have found the run lock taken and said so.
    expect(Notice.log.filter(message => message === t().aiBusy)).toEqual([]);
    expect(aiRunLock.busy()).toBe(true);
  });

  // Passes without the LEV-307 fix too (then only the card runs the key): not one of its regression tests. It holds the
  // scope's own run to stopping the key before the card, so a keymap that does not stop it cannot make two sends.
  it('sends once with a keymap that lets a consumed key go on: the scope\'s run stops it before the card', async () => {
    const mounted = await mount({ stops: false });
    const input = await mounted.open();
    await mounted.press(input);
    expect(mounted.runner.requests).toHaveLength(1);
    expect(Notice.log.filter(message => message === t().aiBusy)).toEqual([]);
  });

  it('leaves Mod+Enter to Obsidian with the focus off the input: on the map, elsewhere, and after the card closes', async () => {
    const mounted = await mount();
    // The map before the input opens: Obsidian's default runs, the AI does not.
    mounted.select('温泉旅行');
    await mounted.press(mounted.node('温泉旅行'));
    expect(mounted.defaults).toHaveLength(1);
    // The input open but the focus back on the map (a click on a node): Obsidian's again.
    const input = await mounted.open();
    expect(mounted.keymap.scope).not.toBe(mounted.base);
    mounted.node('温泉旅行').focus();
    // The card reads the focus a microtask after `focusout`; a real click and the next key come in separate tasks, so
    // the read is done before the key. Sent in the same task, the scope would still be on the stack, take itself off
    // at this key and lose it to Obsidian (the self-repair's one key) — not a sequence a person can make.
    await Promise.resolve();
    await mounted.press(mounted.node('温泉旅行'));
    expect(mounted.defaults).toHaveLength(2);
    expect(mounted.keymap.scope).toBe(mounted.base);
    // Outside the view (another note's editor): Obsidian's.
    const other = document.body.createEl('textarea');
    other.focus();
    await mounted.press(other);
    expect(mounted.defaults).toHaveLength(3);
    // Back in the input it is the AI's; Escape closes the card and gives the key back.
    input.focus();
    expect(mounted.keymap.scope).not.toBe(mounted.base);
    mounted.key(input, 'Escape');
    await mounted.settle();
    expect(mounted.card().hidden).toBe(true);
    expect(mounted.keymap.scope).toBe(mounted.base);
    await mounted.press(document.activeElement ?? document.body);
    expect(mounted.defaults).toHaveLength(4);
    expect(mounted.runner.requests).toHaveLength(0);
  });

  // Review #1 of 0215983: no code change; this holds the chain from the input to what the workspace's scope gave before.
  it('passes every other key on as the workspace\'s scope did: F2 to the view\'s scope, ⌘W to the app\'s', async () => {
    const mounted = await mount();
    const offered: string[] = [];
    mounted.app.scope.register(null, null, event => { offered.push(event.key); return undefined; });
    const input = await mounted.open();
    expect(mounted.keymap.scope).not.toBe(mounted.base);
    expect(mounted.keymap.prevScopes.at(-1)).toBe(mounted.base);
    const f2 = mounted.key(input, 'F2');
    expect(f2.defaultPrevented).toBe(true);
    mounted.key(input, 'w', { metaKey: true });
    expect(offered).toEqual(['w']);
  });

  it('takes a scope left on the stack off at the first ⌘↵ outside the card; the next ⌘↵ is Obsidian\'s', async () => {
    const mounted = await mount();
    const input = await mounted.open();
    const keys = mounted.keymap.scope;
    mounted.key(input, 'Escape');
    await mounted.settle();
    expect(mounted.keymap.scope).toBe(mounted.base);
    // A copy left behind (a popout's stack, a missed pop): put back by hand.
    mounted.keymap.pushScope(keys);
    const node = mounted.node('温泉旅行');
    node.focus();
    const first = await mounted.press(node);
    // That one key is lost to Obsidian (a scope with the key offers it to no other handler), but not consumed.
    expect(first.defaultPrevented).toBe(false);
    expect(mounted.defaults).toEqual([]);
    expect(mounted.keymap.scope).toBe(mounted.base);
    await mounted.press(node);
    expect(mounted.defaults).toEqual([node]);
    expect(mounted.runner.requests).toHaveLength(0);
  });

  it('keeps the scope through a focusout that leaves the focus on the card (the window losing it)', async () => {
    const mounted = await mount();
    const input = await mounted.open();
    const keys = mounted.keymap.scope;
    // What a window blur sends: no related target, and the focus still on the request.
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    await mounted.settle();
    expect(document.activeElement).toBe(input);
    expect(mounted.keymap.scope).toBe(keys);
    await mounted.press(input);
    expect(mounted.runner.requests).toHaveLength(1);
    expect(mounted.defaults).toEqual([]);
  });

  it('pushes only on the card\'s window: with another window active, it waits a task and pushes once the card\'s is', async () => {
    const mounted = await mount();
    const input = await mounted.open();
    const field = document.body.createEl('input');
    field.focus();
    await mounted.settle();
    expect(mounted.keymap.scope).toBe(mounted.base);
    const host = window as unknown as { activeWindow: Window };
    uninstalls.push(() => { host.activeWindow = window; });
    // A popout's focus arriving before Obsidian makes its window the active one: another window is active.
    host.activeWindow = {} as Window;
    input.focus();
    expect(mounted.keymap.scope).toBe(mounted.base);
    host.activeWindow = window;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mounted.keymap.scope).not.toBe(mounted.base);
    expect(mounted.keymap.prevScopes.at(-1)).toBe(mounted.base);
  });

  it('is on the stack once when the focus comes back before the Modal over the input pops its scope', async () => {
    const mounted = await mount();
    const input = await mounted.open();
    const keys = mounted.keymap.scope;
    const modal = new Scope();
    mounted.keymap.pushScope(modal);
    const field = document.body.createEl('input');
    field.focus();
    await mounted.settle();
    // The focus back on the request first: the input's scope goes over the Modal's, which then pops from under it.
    input.focus();
    field.remove();
    expect(mounted.keymap.scope).toBe(keys);
    mounted.keymap.popScope(modal);
    expect(mounted.keymap.scope).toBe(keys);
    expect(mounted.keymap.prevScopes.includes(modal)).toBe(false);
    expect(mounted.keymap.prevScopes.filter(scope => scope === keys)).toEqual([]);
    await mounted.press(input);
    expect(mounted.runner.requests).toHaveLength(1);
    expect(mounted.keymap.scope).toBe(mounted.base);
  });

  it('is on the stack once after a Modal over the input closes, and off it once the card closes', async () => {
    const mounted = await mount();
    const input = await mounted.open();
    const keys = mounted.keymap.scope;
    expect(keys).not.toBe(mounted.base);
    // The attachment Modal: its scope over the input's, the focus in its own field outside the card.
    const modal = new Scope();
    mounted.keymap.pushScope(modal);
    const field = document.body.createEl('input');
    field.focus();
    mounted.keymap.popScope(modal);
    field.remove();
    input.focus();
    expect(mounted.keymap.scope).toBe(keys);
    expect(mounted.keymap.prevScopes.filter(scope => scope === keys)).toEqual([]);
    mounted.key(input, 'Escape');
    await mounted.settle();
    expect(mounted.keymap.scope).toBe(mounted.base);
    expect(mounted.keymap.prevScopes.includes(keys)).toBe(false);
    // ⌘↵ on the map is Obsidian's again.
    await mounted.press(mounted.node('温泉旅行'));
    expect(mounted.defaults).toHaveLength(1);
    expect(mounted.runner.requests).toHaveLength(0);
  });

  it('takes its scope off the keymap when the view closes with the input open', async () => {
    const mounted = await mount();
    await mounted.open();
    expect(mounted.keymap.scope).not.toBe(mounted.base);
    await mounted.close();
    expect(mounted.keymap.scope).toBe(mounted.base);
  });
});
