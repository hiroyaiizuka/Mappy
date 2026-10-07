import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * E84's clean-up of the recovery folder (scripts/e2e/exit-draft-recovery.mjs, `removeEmptyFolderScript`), run against a
 * fake `app` without Obsidian. The case file runs the case when loaded, so the builder is read from its text (as its
 * comment says), not imported. LEV-309: on Obsidian 1.13.7 the adapter's `rmdir(…, false)` is `fs.promises.rm` without
 * recursive, which refuses a folder (EISDIR, seen on the real app); the folder is removed with `fs.promises.rmdir`,
 * and the script waits for the vault to stop listing it (review 1: the next case's setup reads the vault).
 */
const text = readFileSync(new URL('../../scripts/e2e/exit-draft-recovery.mjs', import.meta.url), 'utf8');
const source = /export const removeEmptyFolderScript = (folder => `[\s\S]*?`);\n/u.exec(text)?.[1];
if (!source) throw new Error('removeEmptyFolderScript not found in exit-draft-recovery.mjs');
const removeEmptyFolderScript = new Function(`return (${source});`)();

/** A vault whose folder is there (or not) with `files` and `folders` in it, and stops being listed `listedFor` reads after it goes. */
function fake({ exists = true, files = [], folders = [], listedFor = 0 } = {}) {
  const calls = [];
  let reads = 0;
  const app = {
    vault: {
      adapter: {
        exists: async () => exists,
        list: async () => ({ files, folders }),
        getFullPath: path => `/vault/${path}`,
        rmdir: async () => { calls.push(['adapter.rmdir']); throw new Error('EISDIR: illegal operation on a directory'); },
      },
      getAbstractFileByPath: () => {
        if (!calls.some(([name]) => name === 'fs.rmdir')) return { children: [] };
        reads += 1;
        return reads > listedFor ? null : { children: [] };
      },
    },
  };
  const require = name => {
    if (name !== 'fs') throw new Error(`unexpected require(${name})`);
    return { promises: { rmdir: async path => { calls.push(['fs.rmdir', path]); } } };
  };
  const run = () => new Function('app', 'require', `return (async () => { ${removeEmptyFolderScript('Mappy Recovery')} })();`)(app, require);
  return { run, calls };
}

afterEach(() => { vi.useRealTimers(); });

describe("E84's removal of the recovery folder", () => {
  it('does nothing when the folder is gone, and leaves one that is not empty', async () => {
    expect(await fake({ exists: false }).run()).toBe('gone');
    const full = fake({ files: ['Mappy Recovery/a.md'] });
    expect(await full.run()).toEqual({ kept: 'not empty', files: ['Mappy Recovery/a.md'], folders: [] });
    expect(full.calls).toEqual([]);
  });

  it("removes an empty folder with fs.promises.rmdir (not the adapter's rmdir) and waits for the vault to drop it", async () => {
    vi.useFakeTimers();
    const vault = fake({ listedFor: 3 });
    const result = vault.run();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe('removed');
    expect(vault.calls).toEqual([['fs.rmdir', '/vault/Mappy Recovery']]);
  });

  it('fails when the vault still lists the folder 5 s after it went', async () => {
    vi.useFakeTimers();
    const result = fake({ listedFor: Infinity }).run();
    const failed = expect(result).rejects.toThrow('removed on disk, but the vault still lists it after 5 s');
    await vi.advanceTimersByTimeAsync(6000);
    await failed;
  });
});
