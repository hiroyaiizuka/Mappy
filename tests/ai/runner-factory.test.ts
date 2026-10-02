import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiRequest } from '../../src/ai/contract';
import type { NodeHost } from '../../src/ai/host/node-host';
import { createRunnerFactory, type RunnerFactoryOptions } from '../../src/ai/runner-factory';
import { DEFAULT_AI_PREFS, EMPTY_PATHS } from '../../src/ai/settings';
import { FakeHost } from './fake-host';

/**
 * The factory is the only caller of `loadNode()` (architecture.md §11.1, §11.7): with the license off it never loads
 * Node, so the free state starts no CLI. The runs it made stop when the plugin unloads and on `pagehide`.
 */

beforeEach(() => { vi.stubGlobal('window', globalThis); });
afterEach(() => { vi.unstubAllGlobals(); });

const request: AiRequest = {
  engine: 'claude', template: 'free', instruction: 'x', depth: 1, webSearch: false, context: { ancestors: [], title: 't', body: '' }, materials: [],
};

function factory(entitled: () => boolean, overrides: Partial<RunnerFactoryOptions> = {}, host: NodeHost | null = new FakeHost()) {
  const load = vi.fn((desktop: boolean) => (desktop ? host : null));
  const target = new EventTarget();
  const made = createRunnerFactory({
    isEntitled: entitled, prefs: () => DEFAULT_AI_PREFS, paths: { current: () => EMPTY_PATHS, save: () => undefined },
    vault: null, language: () => 'ja', platform: { isDesktopApp: true, isWin: false }, load, target, ...overrides,
  });
  return { made, load, target };
}

describe('createRunnerFactory', () => {
  it('never loads Node while the license is off', () => {
    const { made, load } = factory(() => false);
    expect(made.create()).toBeNull();
    expect(made.host()).toBeNull();
    expect(made.availability()).toBe('not-entitled');
    expect(load).not.toHaveBeenCalled();
  });

  it('loads Node once the license is on, and only once', () => {
    let entitled = false;
    const { made, load } = factory(() => entitled);
    made.create();
    entitled = true;
    expect(made.availability()).toBe('available');
    expect(made.create()).not.toBeNull();
    expect(made.host()).not.toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(true);
    // The license going away closes the door again, though Node was loaded.
    entitled = false;
    expect(made.create()).toBeNull();
    expect(made.host()).toBeNull();
  });

  it('offers nothing on Windows or outside the desktop app, without loading Node', () => {
    for (const platform of [{ isDesktopApp: true, isWin: true }, { isDesktopApp: false, isWin: false }]) {
      const { made, load } = factory(() => true, { platform });
      expect(made.availability()).toBe('unsupported-platform');
      expect(made.create()).toBeNull();
      expect(load).not.toHaveBeenCalled();
    }
  });

  it('says no-node when the desktop app has no Node to give', () => {
    const { made } = factory(() => true, {}, null);
    expect(made.availability()).toBe('no-node');
    expect(made.create()).toBeNull();
  });

  /** A runner whose CLI never ends by itself: only a stop ends it. */
  function hanging() {
    const host = new FakeHost({ executables: ['/Users/user/.local/share/mise/shims/claude'] });
    const { made, target } = factory(() => true, {}, host);
    const runner = made.create();
    if (!runner) throw new Error('no runner');
    return { host, made, target, runner };
  }

  async function started(host: FakeHost): Promise<void> {
    for (let i = 0; i < 50 && host.children.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(host.children).toHaveLength(1);
  }

  it('stops every run on dispose (the plugin unloading)', async () => {
    const { host, made, runner } = hanging();
    const running = vi.fn();
    made.onRunningChange(running);
    const done = runner.run(request, () => undefined, new AbortController().signal);
    await started(host);
    expect(made.isRunning()).toBe(true);
    made.dispose();
    await expect(done).resolves.toEqual({ kind: 'cancelled' });
    expect(host.kills[0]).toEqual({ pid: 1000, signal: 'SIGTERM' });
    expect(made.isRunning()).toBe(false);
    expect(running.mock.calls).toEqual([[true]]);
  });

  it('stops every run on pagehide (Obsidian quitting or reloading)', async () => {
    const { host, target, runner } = hanging();
    const done = runner.run(request, () => undefined, new AbortController().signal);
    await started(host);
    target.dispatchEvent(new Event('pagehide'));
    await expect(done).resolves.toEqual({ kind: 'cancelled' });
  });

  it('stops a run on its own signal (the view closing, the note changing, the cancel button)', async () => {
    const { host, runner } = hanging();
    const controller = new AbortController();
    const done = runner.run(request, () => undefined, controller.signal);
    await started(host);
    controller.abort();
    await expect(done).resolves.toEqual({ kind: 'cancelled' });
  });

  it('lets go of pagehide on dispose', () => {
    const { made, target } = factory(() => true);
    const remove = vi.spyOn(target, 'removeEventListener');
    made.create();
    made.dispose();
    expect(remove).toHaveBeenCalledWith('pagehide', expect.any(Function));
  });
});
