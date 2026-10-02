import { Platform } from 'obsidian';
import type { AiRunner } from './contract';
import type { PromptLanguage } from './core/prompt';
import { loadNode, type NodeHost } from './host/node-host';
import { sweepStaleRuns } from './host/temp';
import { createCliRunner } from './runner';
import type { AiPrefs, RunnerPathsStore } from './settings';

/**
 * The only caller of `loadNode()` (docs/architecture.md §11.1, §11.7). Nothing reaches Node until the license says
 * yes: `create()` and `host()` ask `isEntitled()` first and return null without loading anything when it is false
 * (the free state touches neither the CLI nor Node). The license is a plain `() => boolean` here; `main.ts` passes
 * LEV-273's `Entitlement` as `state().kind === 'active'`.
 *
 * Everything started through it stops on `dispose()` (the plugin's unload) and on `pagehide` (Obsidian quitting or
 * reloading), the runs and the settings' 「探す」 alike: a detached process outlives its parent unless it is stopped.
 * One run at a time (§11.3) is the input's `aiRunLock` (src/ui/ai/services.ts), shared by every view.
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
  /** Whether this app could run AI at all (not Windows, the desktop app), known without the license or Node. */
  platformSupported(): boolean;
  /** The runner, or null unless `availability()` is `available`. */
  create(): AiRunner | null;
  /** The Node surface for the settings' rows and 「探す」, under the same condition. */
  host(): NodeHost | null;
  /** Fires when everything is stopped (`dispose`, `pagehide`): for work that is not a run, such as 「探す」. */
  stopSignal(): AbortSignal;
  /** Stops everything and lets go of the window. */
  dispose(): void;
}

export function createRunnerFactory(options: RunnerFactoryOptions): RunnerFactory {
  const platform = options.platform ?? Platform;
  const load = options.load ?? loadNode;
  const target = options.target ?? window;
  let loaded: NodeHost | null | undefined;
  let stopAll = new AbortController();
  // Fired when Mappy goes away (pagehide, unload): kill at once, since no timer survives to send the later SIGKILL.
  let killNow = new AbortController();
  const stopEverything = (): void => {
    killNow.abort();
    stopAll.abort();
    killNow = new AbortController();
    stopAll = new AbortController();
  };
  let disposed = false;
  const onPageHide = (): void => { stopEverything(); };
  let listening = false;

  const unsupported = (): boolean => platform.isWin || !platform.isDesktopApp;
  const host = (): NodeHost | null => {
    if (disposed || !options.isEntitled() || unsupported()) return null;
    if (loaded === undefined) {
      loaded = load(platform.isDesktopApp);
      if (loaded !== null) {
        // From the moment Node can start anything (a run, or 「探す」 in the settings), quitting stops it.
        target.addEventListener('pagehide', onPageHide);
        listening = true;
        // Directories a run could not remove (Obsidian quit before the cleanup ran): swept once, when they are old.
        void sweepStaleRuns(loaded, Date.now()).catch(() => undefined);
      }
    }
    return loaded;
  };

  return {
    availability() {
      if (!options.isEntitled()) return 'not-entitled';
      if (unsupported()) return 'unsupported-platform';
      return host() === null ? 'no-node' : 'available';
    },
    platformSupported: () => !unsupported(),
    host,
    create() {
      const node = host();
      if (node === null) return null;
      const runner = createCliRunner({ host: node, prefs: options.prefs, paths: () => options.paths.current(), language: options.language, killNow: () => killNow.signal });
      return {
        async run(request, onProgress, signal) {
          // The license is asked again: a runner made while it was active must not start a CLI after it ended.
          // Its own kind, so the input points to the license and not to installing the CLI.
          if (!options.isEntitled()) return { kind: 'failed', reason: 'not-entitled', detail: 'license' };
          // A runner kept past the plugin's unload starts nothing: no dispose or pagehide would stop it any more.
          if (disposed) return { kind: 'cancelled' };
          // The caller's signal (the view closing, the note changing, the cancel button) or the plugin going away.
          const controller = new AbortController();
          const all = stopAll.signal;
          const stopOwn = (): void => { controller.abort(signal.reason); };
          const stopAllRuns = (): void => { controller.abort(all.reason); };
          if (signal.aborted) stopOwn();
          if (all.aborted) stopAllRuns();
          signal.addEventListener('abort', stopOwn);
          all.addEventListener('abort', stopAllRuns);
          try {
            return await runner.run(request, onProgress, controller.signal);
          } finally {
            signal.removeEventListener('abort', stopOwn);
            all.removeEventListener('abort', stopAllRuns);
          }
        },
      };
    },
    stopSignal: () => stopAll.signal,
    dispose() {
      disposed = true;
      // The plugin unloading can be the first step of Obsidian quitting or reloading: no SIGKILL timer may be left to.
      stopEverything();
      if (listening) { target.removeEventListener('pagehide', onPageHide); listening = false; }
    },
  };
}
