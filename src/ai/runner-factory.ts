import { Platform } from 'obsidian';
import type { AiRunner } from './contract';
import type { PromptLanguage } from './core/prompt';
import { KILL_NOW } from './host/cli-process';
import { loadNode, type NodeHost } from './host/node-host';
import type { VaultMaterials } from './obsidian/material';
import { createCliRunner } from './runner';
import type { AiPrefs, RunnerPathsStore } from './settings';

/**
 * The only caller of `loadNode()` (docs/architecture.md §11.1, §11.7). Nothing reaches Node until the license says
 * yes: `create()` and `host()` ask `isEntitled()` first and return null without loading anything when it is false
 * (the free state touches neither the CLI nor Node). The license is a plain `() => boolean` here; LEV-273's
 * `Entitlement` supplies it (`state().kind === 'active'`) when the pieces are wired in `main.ts`.
 *
 * Every run it made stops on `dispose()` (the plugin's unload) and on `pagehide` (Obsidian quitting or reloading):
 * a detached CLI outlives its parent unless it is stopped.
 */

export type AiAvailability =
  /** The runner can be made. */
  | 'available'
  /** No license (or not yet checked): show nothing. */
  | 'not-entitled'
  /** Windows (§11.3: the process-group handling is POSIX), or not the desktop app: show 「未対応」. */
  | 'unsupported-platform'
  /** The desktop app without Node integration: nothing to start the CLI with. */
  | 'no-node';

export interface RunnerFactoryOptions {
  isEntitled: () => boolean;
  prefs: () => AiPrefs;
  paths: RunnerPathsStore;
  vault: VaultMaterials | null;
  language: () => PromptLanguage;
  /** Obsidian's `Platform` unless a test passes its own. */
  platform?: { isDesktopApp: boolean; isWin: boolean };
  /** `loadNode` unless a test counts the calls. */
  load?: (isDesktopApp: boolean) => NodeHost | null;
  /** Where `pagehide` is listened for (the main window). */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

export interface RunnerFactory {
  availability(): AiAvailability;
  /** The runner, or null unless `availability()` is `available`. */
  create(): AiRunner | null;
  /** The Node surface for the settings' rows and 「探す」, under the same condition. */
  host(): NodeHost | null;
  /** Whether a run is going (Mappy runs one at a time, §11.3: the UI disables the other AI buttons meanwhile). */
  isRunning(): boolean;
  onRunningChange(listener: (running: boolean) => void): () => void;
  /** Stops every run and lets go of the window. */
  dispose(): void;
}

export function createRunnerFactory(options: RunnerFactoryOptions): RunnerFactory {
  const platform = options.platform ?? Platform;
  const load = options.load ?? loadNode;
  const target = options.target ?? window;
  let loaded: NodeHost | null | undefined;
  let stopAll = new AbortController();
  let running = 0;
  const listeners = new Set<(running: boolean) => void>();
  // The page is going away: kill at once (KILL_NOW), since no timer survives to send the later SIGKILL.
  const onPageHide = (): void => { stopAll.abort(KILL_NOW); stopAll = new AbortController(); };
  let listening = false;

  const unsupported = (): boolean => platform.isWin || !platform.isDesktopApp;
  const host = (): NodeHost | null => {
    if (!options.isEntitled() || unsupported()) return null;
    if (loaded === undefined) loaded = load(platform.isDesktopApp);
    return loaded;
  };
  const setRunning = (delta: number): void => {
    const before = running > 0;
    running += delta;
    if (before !== running > 0) for (const listener of listeners) listener(running > 0);
  };

  return {
    availability() {
      if (!options.isEntitled()) return 'not-entitled';
      if (unsupported()) return 'unsupported-platform';
      return host() === null ? 'no-node' : 'available';
    },
    host,
    create() {
      const node = host();
      if (node === null) return null;
      if (!listening) { target.addEventListener('pagehide', onPageHide); listening = true; }
      const runner = createCliRunner({ host: node, prefs: options.prefs, paths: () => options.paths.current(), vault: options.vault, language: options.language });
      return {
        async run(request, onProgress, signal) {
          // The caller's signal (the view closing, the note changing, the cancel button) or the plugin going away.
          const controller = new AbortController();
          const all = stopAll.signal;
          const stopOwn = (): void => { controller.abort(signal.reason); };
          const stopAllRuns = (): void => { controller.abort(all.reason); };
          if (signal.aborted) stopOwn();
          if (all.aborted) stopAllRuns();
          signal.addEventListener('abort', stopOwn);
          all.addEventListener('abort', stopAllRuns);
          setRunning(1);
          try {
            return await runner.run(request, onProgress, controller.signal);
          } finally {
            signal.removeEventListener('abort', stopOwn);
            all.removeEventListener('abort', stopAllRuns);
            setRunning(-1);
          }
        },
      };
    },
    isRunning: () => running > 0,
    onRunningChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      stopAll.abort();
      stopAll = new AbortController();
      if (listening) { target.removeEventListener('pagehide', onPageHide); listening = false; }
      listeners.clear();
    },
  };
}
