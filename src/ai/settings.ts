import type { Engine, Tool } from './core/launch';

/**
 * The runner's settings (docs/architecture.md §11.3). Two homes: the engine and the models are preferences that may
 * follow the vault to another device (`data.json`, through the plugin's `loadData`/`saveData`); the executables'
 * paths belong to this device (another device need not have them there), so they live in `window.localStorage`,
 * shared by every vault on the device like the license (§11.6).
 */

export interface AiPrefs {
  engine: Engine;
  /** Passed as `--model` / `-m`; empty leaves the CLI's default. */
  claudeModel: string;
  codexModel: string;
}

export const DEFAULT_AI_PREFS: AiPrefs = { engine: 'claude', claudeModel: '', codexModel: '' };

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Prefs from whatever `data.json` held (a missing or broken field takes its default). */
export function readAiPrefs(value: unknown): AiPrefs {
  const raw = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  return {
    engine: raw.engine === 'codex' ? 'codex' : 'claude',
    claudeModel: text(raw.claudeModel),
    codexModel: text(raw.codexModel),
  };
}

/** The plugin owns `data.json`; the AI settings only read and ask for a save (as `SettingsStore` does). */
export interface AiPrefsStore {
  current(): AiPrefs;
  save(next: AiPrefs): Promise<void>;
}

/** The absolute path of each executable on this device; empty means "look in the known places". */
export type RunnerPaths = Record<Tool, string>;

export const EMPTY_PATHS: RunnerPaths = { claude: '', codex: '', 'yt-dlp': '' };

export interface RunnerPathsStore {
  current(): RunnerPaths;
  save(next: RunnerPaths): void;
}

export const PATHS_KEY = 'mappy-ai-paths';

export function readPaths(value: string | null): RunnerPaths {
  let raw: unknown = null;
  try { raw = value === null ? null : JSON.parse(value); } catch { raw = null; }
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  return { claude: text(record.claude), codex: text(record.codex), 'yt-dlp': text(record['yt-dlp']) };
}

/** The paths in the device's `localStorage` (a storage that throws, as a locked-down one may, reads as empty). */
export function localPathsStore(storage: Pick<Storage, 'getItem' | 'setItem'>): RunnerPathsStore {
  return {
    current: () => {
      try { return readPaths(storage.getItem(PATHS_KEY)); } catch { return { ...EMPTY_PATHS }; }
    },
    save: next => { storage.setItem(PATHS_KEY, JSON.stringify(next)); },
  };
}
