// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Stat } from 'obsidian';
import { FOLD_LIMITS, readFoldFile, writeFoldFile } from '../../src/core/fold-memory';
import { FOLD_LOAD_TRIES, FOLD_WRITE_DELAY, FOLD_WRITE_MAX_DELAY, FoldStore, foldMemoryPath, type FoldAdapter } from '../../src/obsidian/fold-store';

/**
 * LEV-365: the folds kept between the openings of a note, in Mappy's own file in the plugin's folder. Read once at load;
 * a change is written once the folds rest (`FOLD_WRITE_DELAY`), at most `FOLD_WRITE_MAX_DELAY` after the first one, or at
 * once by `flush`. A write goes to `folds.next.json` first and replaces `folds.json` after, so a write cut at any step
 * leaves the last whole file; a load takes the newer of the two that read. The fake adapter refuses a rename onto a name
 * that is there, as Obsidian 1.14.4's does ("Destination file already exists!").
 */
const PATH = foldMemoryPath('cfg/plugins/mappy');
const NEXT = 'cfg/plugins/mappy/folds.next.json';
const NOTES = new Set(['a.md', 'b.md', 'Folder/c.md', 'Folder/Sub/d.md']);

type Step = 'read' | 'write' | 'remove' | 'rename' | 'exists' | 'stat';

class Disk {
  readonly files = new Map<string, string>();
  readonly calls: string[] = [];
  fault: (step: Step, path: string) => Error | null = () => null;
  private step(step: Step, path: string): void {
    this.calls.push(`${step} ${path}`);
    const error = this.fault(step, path);
    if (error) throw error;
  }
  readonly adapter: FoldAdapter = {
    read: path => this.run(() => { this.step('read', path); const text = this.files.get(path); if (text === undefined) throw new Error(`ENOENT ${path}`); return text; }),
    write: (path, data) => this.run(() => { this.step('write', path); this.files.set(path, data); }),
    remove: path => this.run(() => { this.step('remove', path); if (!this.files.delete(path)) throw new Error(`ENOENT ${path}`); }),
    rename: (from, to) => this.run(() => {
      this.step('rename', from);
      if (this.files.has(to)) throw new Error('Destination file already exists!');
      const text = this.files.get(from);
      if (text === undefined) throw new Error(`ENOENT ${from}`);
      this.files.delete(from);
      this.files.set(to, text);
    }),
    exists: path => this.run(() => { this.step('exists', path); return this.files.has(path); }),
    stat: path => this.run((): Stat | null => {
      this.step('stat', path);
      const text = this.files.get(path);
      return text === undefined ? null : { type: 'file', ctime: 0, mtime: 0, size: new TextEncoder().encode(text).length };
    }),
  };
  private run<T>(body: () => T): Promise<T> {
    try { return Promise.resolve(body()); } catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
  }
}

const file = (savedAt: number, notes: Record<string, string[][]>): string =>
  writeFoldFile(new Map(Object.entries(notes).map(([path, folds]) => [path, { at: savedAt, folds, open: [] }])), savedAt).text;
const onDisk = (disk: Disk, path = PATH) => readFoldFile(disk.files.get(path) ?? '');

let disk: Disk;
let store: FoldStore;
beforeEach(() => {
  vi.useFakeTimers();
  disk = new Disk();
  store = new FoldStore(disk.adapter, PATH, path => NOTES.has(path));
});
afterEach(() => { vi.useRealTimers(); });

describe('load', () => {
  it('reads nothing when there is no file, and the maps open with nothing kept', async () => {
    await store.load();
    expect(store.get('a.md')).toBeUndefined();
  });

  it('takes the newer of the two files that read, whichever name it has', async () => {
    disk.files.set(PATH, file(10, { 'a.md': [['old']] }));
    disk.files.set(NEXT, file(20, { 'a.md': [['new']] }));
    await store.load();
    expect(store.get('a.md')?.folds).toEqual([['new']]);
    const other = new Disk();
    other.files.set(PATH, file(30, { 'a.md': [['main']] }));
    other.files.set(NEXT, file(20, { 'a.md': [['next']] }));
    const again = new FoldStore(other.adapter, PATH, () => true);
    await again.load();
    expect(again.get('a.md')?.folds).toEqual([['main']]);
  });

  it('takes the other file when one is cut or broken, and none when neither reads', async () => {
    disk.files.set(PATH, file(10, { 'a.md': [['whole']] }));
    disk.files.set(NEXT, '');
    await store.load();
    expect(store.get('a.md')?.folds).toEqual([['whole']]);
    const broken = new Disk();
    broken.files.set(PATH, '{"version":1,"notes":{"a.md":');
    broken.files.set(NEXT, 'not json');
    const none = new FoldStore(broken.adapter, PATH, () => true);
    await none.load();
    expect(none.get('a.md')).toBeUndefined();
  });

  it('reads again when a file is moved between its stat and its read, as the write of a plugin just disabled does (code review 1)', async () => {
    disk.files.set(NEXT, file(20, { 'a.md': [['moved']] }));
    disk.files.set(PATH, file(10, { 'a.md': [['old']] }));
    // The unload's write goes on during the load: once both stats are done, the old file goes and the next takes its name.
    let moved = false;
    disk.fault = step => {
      if (step === 'read' && !moved) {
        moved = true;
        disk.files.delete(PATH);
        disk.files.set(PATH, disk.files.get(NEXT)!);
        disk.files.delete(NEXT);
        return new Error('ENOENT: moved');
      }
      return null;
    };
    const loading = store.load();
    await vi.runAllTimersAsync();
    await loading;
    expect(store.get('a.md')?.folds).toEqual([['moved']]);
  });

  it('writes nothing over a file it could not read, and keeps the folds of the session in memory', async () => {
    disk.files.set(PATH, file(10, { 'b.md': [['kept']] }));
    const before = disk.files.get(PATH);
    disk.fault = step => (step === 'read' ? new Error('EACCES') : null);
    const loading = store.load();
    await vi.runAllTimersAsync();
    await loading;
    expect(disk.calls.filter(call => call === `read ${PATH}`)).toHaveLength(FOLD_LOAD_TRIES);
    disk.fault = () => null;
    store.set('a.md', { folds: [['a']], open: [] });
    expect(store.get('a.md')?.folds).toEqual([['a']]);
    await vi.advanceTimersByTimeAsync(FOLD_WRITE_DELAY * 2);
    await store.flush();
    expect(disk.files.get(PATH)).toBe(before);
    expect(disk.calls.some(call => call.startsWith('write'))).toBe(false);
  });

  it('does not read a file larger than the limit', async () => {
    disk.files.set(PATH, JSON.stringify({ version: 1, savedAt: 10, notes: { 'a.md': { at: 10, folds: [['x'.repeat(FOLD_LIMITS.readBytes)]], open: [] } } }));
    await store.load();
    expect(store.get('a.md')).toBeUndefined();
    expect(disk.calls).not.toContain(`read ${PATH}`);
  });
});

describe('writes', () => {
  it('writes once the folds have rested, one write for a run of changes', async () => {
    await store.load();
    store.set('a.md', { folds: [['1']], open: [] });
    await vi.advanceTimersByTimeAsync(FOLD_WRITE_DELAY - 100);
    store.set('a.md', { folds: [['2']], open: [] });
    await vi.advanceTimersByTimeAsync(FOLD_WRITE_DELAY - 100);
    expect(disk.files.has(PATH)).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(onDisk(disk)?.notes.get('a.md')?.folds).toEqual([['2']]);
    expect(disk.calls.filter(call => call.startsWith('write'))).toEqual([`write ${NEXT}`]);
  });

  it('writes at the latest the longest delay after the first change while changes keep coming', async () => {
    await store.load();
    for (let at = 0; at < FOLD_WRITE_MAX_DELAY + 1000; at += 500) {
      store.set('a.md', { folds: [[String(at)]], open: [] });
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(disk.calls.filter(call => call.startsWith('write'))).toHaveLength(1);
  });

  it('writes the next file, then removes the old one and renames the new one into its place', async () => {
    disk.files.set(PATH, file(10, { 'b.md': [['b']] }));
    await store.load();
    store.set('a.md', { folds: [['a']], open: [] });
    disk.calls.length = 0;
    await store.flush();
    expect(disk.calls).toEqual([`write ${NEXT}`, `exists ${PATH}`, `remove ${PATH}`, `rename ${NEXT}`]);
    expect(disk.files.has(NEXT)).toBe(false);
    expect(onDisk(disk)?.notes).toEqual(new Map([
      ['b.md', { at: 10, folds: [['b']], open: [] }], ['a.md', expect.objectContaining({ folds: [['a']] })],
    ]));
  });

  it('leaves the last whole file when a write is cut at any step, and the next load reads the newest whole one', async () => {
    for (const cut of ['write', 'remove', 'rename'] as const) {
      const cutDisk = new Disk();
      cutDisk.files.set(PATH, file(10, { 'a.md': [['before']] }));
      const cutStore = new FoldStore(cutDisk.adapter, PATH, () => true);
      await cutStore.load();
      cutStore.set('a.md', { folds: [['after']], open: [] });
      // A cut write: the file it writes truncated and nothing after it (`fs.promises.writeFile`, LEV-230), or each later step not done.
      cutDisk.fault = (step, path) => {
        if (step !== cut) return null;
        if (cut === 'write') cutDisk.files.set(path, '');
        return new Error(`cut at ${cut}`);
      };
      await cutStore.flush();
      const reread = new FoldStore(cutDisk.adapter, PATH, () => true);
      cutDisk.fault = () => null;
      await reread.load();
      expect(reread.get('a.md')?.folds, cut).toEqual(cut === 'write' ? [['before']] : [['after']]);
    }
  });

  it('keeps a failed write for the next flush', async () => {
    await store.load();
    store.set('a.md', { folds: [['a']], open: [] });
    disk.fault = step => (step === 'write' ? new Error('disk full') : null);
    await store.flush();
    expect(disk.files.has(PATH)).toBe(false);
    disk.fault = () => null;
    await store.flush();
    expect(onDisk(disk)?.notes.get('a.md')?.folds).toEqual([['a']]);
  });

  it('flushes a change made while a write is under way once that write is done', async () => {
    await store.load();
    store.set('a.md', { folds: [['1']], open: [] });
    const first = store.flush();
    store.set('a.md', { folds: [['2']], open: [] });
    await Promise.all([first, store.flush()]);
    expect(onDisk(disk)?.notes.get('a.md')?.folds).toEqual([['2']]);
  });

  it('writes nothing for folds that are what is kept, forgets a note with none, and keeps nothing for a path with no note', async () => {
    disk.files.set(PATH, file(10, { 'a.md': [['a']] }));
    await store.load();
    store.set('a.md', { folds: [['a']], open: [] });
    store.set('gone.md', { folds: [['x']], open: [] });
    await vi.advanceTimersByTimeAsync(FOLD_WRITE_DELAY * 2);
    expect(disk.calls.some(call => call.startsWith('write'))).toBe(false);
    store.set('a.md', { folds: [], open: [] });
    await store.flush();
    expect(onDisk(disk)?.notes.size).toBe(0);
  });

  it('counts a map opening a note as a use, so the note open is not the first a write leaves out (code review 1)', async () => {
    const many = new Map(Array.from({ length: FOLD_LIMITS.notes }, (_, index) => [`n${index}.md`, { at: index + 1, folds: [['x']], open: [] }]));
    disk.files.set(PATH, writeFoldFile(many, 1).text);
    const full = new FoldStore(disk.adapter, PATH, () => true);
    await full.load();
    expect(full.open('n0.md')?.folds).toEqual([['x']]);
    full.set('new.md', { folds: [['y']], open: [] });
    await full.flush();
    expect(onDisk(disk)?.notes.has('n0.md')).toBe(true);
    expect(onDisk(disk)?.notes.has('n1.md')).toBe(false);
  });

  it('drops from memory too the notes a write leaves out past the limits', async () => {
    const many = new Map(Array.from({ length: FOLD_LIMITS.notes + 5 }, (_, index) => [`n${index}.md`, { at: index, folds: [['x']], open: [] }]));
    disk.files.set(PATH, writeFoldFile(many, 1, { notes: 1_000_000, bytes: 1e9 }).text);
    const big = new FoldStore(disk.adapter, PATH, () => true);
    await big.load();
    big.set('n0.md', { folds: [['changed']], open: [] });
    await big.flush();
    expect(onDisk(disk)?.notes.size).toBe(FOLD_LIMITS.notes);
    expect(big.get('n0.md')?.folds).toEqual([['changed']]);
    expect(big.get('n1.md')).toBeUndefined();
  });
});

describe('notes renamed and deleted', () => {
  beforeEach(async () => {
    disk.files.set(PATH, file(10, { 'a.md': [['a']], 'Folder/c.md': [['c']], 'Folder/Sub/d.md': [['d']], 'Folderish/e.md': [['e']] }));
    await store.load();
  });

  it('moves a renamed note’s folds, and a renamed folder’s notes’, and writes the move', async () => {
    store.rename('a.md', 'b.md');
    store.rename('Folder', 'Moved/Folder');
    expect(store.get('a.md')).toBeUndefined();
    expect(store.get('b.md')?.folds).toEqual([['a']]);
    expect(store.get('Moved/Folder/Sub/d.md')?.folds).toEqual([['d']]);
    expect(store.get('Folderish/e.md')?.folds).toEqual([['e']]);
    await store.flush();
    expect(Array.from(onDisk(disk)!.notes.keys()).sort()).toEqual(['Folderish/e.md', 'Moved/Folder/Sub/d.md', 'Moved/Folder/c.md', 'b.md']);
  });

  it('forgets a deleted note, a deleted folder’s notes, and on prune the notes no longer in the vault', async () => {
    store.delete('Folder');
    expect(store.get('Folder/c.md')).toBeUndefined();
    expect(store.get('a.md')).toBeDefined();
    store.prune();
    expect(store.get('Folderish/e.md')).toBeUndefined();
    expect(store.get('a.md')).toBeDefined();
    await store.flush();
    expect(Array.from(onDisk(disk)!.notes.keys())).toEqual(['a.md']);
  });
});
