import { describe, expect, it } from 'vitest';
import { PATHS_KEY, localPathsStore, readAiPrefs, readPaths } from '../../src/ai/settings';

describe('the runner settings (architecture.md §11.3)', () => {
  it('reads prefs from whatever data.json held', () => {
    expect(readAiPrefs({ engine: 'codex', claudeModel: ' opus ', codexModel: 3 })).toEqual({ engine: 'codex', claudeModel: 'opus', codexModel: '' });
    expect(readAiPrefs(null)).toEqual({ engine: 'claude', claudeModel: '', codexModel: '' });
  });

  it('keeps the paths in the device storage under mappy-ai-paths', () => {
    const items = new Map<string, string>();
    const store = localPathsStore({ getItem: key => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value); } });
    expect(store.save({ claude: '/a/claude', codex: '', 'yt-dlp': '' })).toBe(true);
    expect(JSON.parse(items.get(PATHS_KEY) ?? '{}')).toEqual({ claude: '/a/claude', codex: '', 'yt-dlp': '' });
    expect(store.current().claude).toBe('/a/claude');
    expect(readPaths('not json')).toEqual({ claude: '', codex: '', 'yt-dlp': '' });
  });

  it('reports a write the storage refused instead of throwing (a full or locked-down storage)', () => {
    const store = localPathsStore({ getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('QuotaExceededError'); } });
    expect(store.save({ claude: '/a', codex: '', 'yt-dlp': '' })).toBe(false);
    expect(store.current()).toEqual({ claude: '', codex: '', 'yt-dlp': '' });
  });
});
