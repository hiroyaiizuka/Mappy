import { describe, expect, it } from 'vitest';
import type { DataAdapter, Stat } from 'obsidian';
import { applyEdits } from '../../src/core/commands';
import {
  appliedName, backupId, backupText, makeExitBackup, preparedName, sha256Hex, utf8Bytes, type PlannedExitDraft,
} from '../../src/core/exit-backup';
import { textFingerprint } from '../../src/core/exit-drafts';
import { ExitBackupError, ExitBackupStore, exitBackupFolder, type BackupAdapter } from '../../src/obsidian/exit-backup-store';

/**
 * LEV-309: the backups' files in the plugin's folder, through the adapter alone. One backup: written to a temporary
 * file (S1), renamed to `<id>.prepared.json` and read back (S2), then renamed to `<id>.applied.json` once the note is
 * written (S4). The rows are each step × how it fails (refused, the disk full, read back changed, the name taken) and
 * the folder × what is in it (nothing, temporary, broken or unknown files, a folder, a file in its place). Nothing is
 * deleted but by `discard` (LEV-310, the last block), which moves a file to a trash: the fake adapter logs every
 * move to one, and a rename onto a name that is there is counted.
 */
const PLUGIN = 'cfg/plugins/mappy';
const FOLDER = exitBackupFolder(PLUGIN);
const SOURCE = '- 親\n  - 子ノード\n- 別のノード\n';
const edits = [{ from: SOURCE.indexOf('子ノード'), to: SOURCE.indexOf('子ノード') + 4, text: '新しい名前' }];
const AFTER = applyEdits(SOURCE, edits);
const draft: PlannedExitDraft = {
  path: 'Notes/退避.md', title: '新しい名前', at: 1_791_265_000_000, before: textFingerprint(SOURCE), after: textFingerprint(AFTER), edits, source: SOURCE,
};

type Step = 'exists' | 'stat' | 'list' | 'read' | 'write' | 'rename' | 'mkdir' | 'trashSystem' | 'trashLocal';

/** The plugin's folder on disk as the adapter shows it, with the faults a row asks for. */
class Disk {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>([PLUGIN]);
  readonly calls: string[] = [];
  /** Renames made onto a name that was there (the real adapter may overwrite it: none must be asked for). */
  overwrites = 0;
  /** A step that fails for a path (the error thrown), or null. */
  fault: (step: Step, path: string) => Error | null = () => null;
  /** What a read gives back for a path holding `text`. */
  readBack = (_path: string, text: string): string => text;
  /** The size `stat` reports for a file, or null for one it cannot measure. */
  size = (_path: string, text: string): number | null => utf8Bytes(text);
  /** Whether the system trash takes a file (`trashSystem` answers false where there is none). */
  trashWorks = true;
  /** The files moved to the system trash, and to the vault's `.trash/`, with what they held. */
  readonly trash = new Map<string, string>();
  readonly localTrash = new Map<string, string>();

  private step(step: Step, path: string, to = ''): void {
    this.calls.push(`${step} ${path}${to ? ` ${to}` : ''}`);
    const error = this.fault(step, path);
    if (error) throw error;
  }

  readonly adapter: BackupAdapter = {
    exists: (path: string) => this.run(() => { this.step('exists', path); return this.files.has(path) || this.folders.has(path); }),
    stat: (path: string) => this.run((): Stat | null => {
      this.step('stat', path);
      if (this.folders.has(path)) return { type: 'folder', ctime: 0, mtime: 0, size: 0 };
      const text = this.files.get(path);
      if (text === undefined) return null;
      const size = this.size(path, text);
      return size === null ? null : { type: 'file', ctime: 0, mtime: 0, size };
    }),
    list: (path: string) => this.run(() => {
      this.step('list', path);
      const under = (item: string) => item.startsWith(`${path}/`) && !item.slice(path.length + 1).includes('/');
      return { files: [...this.files.keys()].filter(under), folders: [...this.folders].filter(under) };
    }),
    read: (path: string) => this.run(() => {
      this.step('read', path);
      const text = this.files.get(path);
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return this.readBack(path, text);
    }),
    write: (path: string, data: string) => this.run(() => { this.step('write', path); this.files.set(path, data); }),
    rename: (from: string, to: string) => this.run(() => {
      this.step('rename', from, to);
      const text = this.files.get(from);
      if (text === undefined) throw new Error(`ENOENT: ${from}`);
      if (this.files.has(to)) this.overwrites += 1;
      this.files.delete(from);
      this.files.set(to, text);
    }),
    mkdir: (path: string) => this.run(() => { this.step('mkdir', path); this.folders.add(path); }),
    trashSystem: (path: string) => this.run(() => {
      this.step('trashSystem', path);
      const text = this.files.get(path);
      if (!this.trashWorks || text === undefined) return false;
      this.files.delete(path);
      this.trash.set(path, text);
      return true;
    }),
    trashLocal: (path: string) => this.run(() => {
      this.step('trashLocal', path);
      const text = this.files.get(path);
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      this.files.delete(path);
      this.localTrash.set(path, text);
    }),
  } satisfies Pick<DataAdapter, Step>;

  private run<T>(body: () => T): Promise<T> {
    try { return Promise.resolve(body()); } catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
  }

  names(): string[] { return [...this.files.keys()].map(path => path.slice(path.lastIndexOf('/') + 1)).sort(); }
}

const storeOn = (disk: Disk, limit?: number) => new ExitBackupStore(disk.adapter, FOLDER, '0.4.6', limit, () => 7);
const prepare = (store: ExitBackupStore) => store.prepare(draft, draft.path, SOURCE, AFTER, edits);
const failureOf = async (promise: Promise<unknown>): Promise<string> => {
  try { await promise; } catch (error) { return error instanceof ExitBackupError ? error.failure : `other: ${String(error)}`; }
  return 'none';
};
/** The JSON this draft's backup takes, as the store writes it. */
const expectedText = async () => backupText(await makeExitBackup({ draft, path: draft.path, before: SOURCE, after: AFTER, edits, mappyVersion: '0.4.6', createdAt: 7 }));

describe('making a backup (S1, S2) and marking it finished (S4)', () => {
  it('writes a temporary file, renames it to the prepared name, reads it back, then renames that to the applied name', async () => {
    const disk = new Disk();
    const store = storeOn(disk);
    const backup = await prepare(store);
    const id = await backupId(draft);
    expect(backup.id).toBe(id);
    expect(disk.names()).toEqual([preparedName(id)]);
    expect(disk.files.get(`${FOLDER}/${preparedName(id)}`)).toBe(await expectedText());
    const steps = disk.calls.map(call => call.split(' ')[0]);
    expect(steps.indexOf('write')).toBeLessThan(steps.indexOf('rename'));
    expect(steps.lastIndexOf('read')).toBeGreaterThan(steps.indexOf('rename'));
    expect(disk.calls.find(call => call.startsWith('write'))).toMatch(new RegExp(`^write ${FOLDER}/${id}\\.tmp-[0-9a-f]{12}\\.json$`, 'u'));
    await store.markApplied(id);
    expect(disk.names()).toEqual([appliedName(id)]);
    expect(disk.files.get(`${FOLDER}/${appliedName(id)}`)).toBe(await expectedText());
    expect(disk.overwrites).toBe(0);
  });

  it('makes the folder when it is not there, and refuses a file in its place', async () => {
    const disk = new Disk();
    await prepare(storeOn(disk));
    expect(disk.calls).toContain(`mkdir ${FOLDER}`);
    const blocked = new Disk();
    blocked.files.set(FOLDER, 'a file');
    expect(await failureOf(prepare(storeOn(blocked)))).toBe('unverified');
    expect([...blocked.files.keys()]).toEqual([FOLDER]);
  });

  // S1: nothing renamed, nothing read back as a backup, nothing deleted.
  it.each([
    ['the disk is full', new Error('ENOSPC: no space left on device')],
    ['writing is refused', new Error('EACCES: permission denied')],
  ])('stops when the temporary file cannot be written: %s', async (_case, error) => {
    const disk = new Disk();
    disk.fault = (step, path) => step === 'write' && path.includes('.tmp-') ? error : null;
    expect(await failureOf(prepare(storeOn(disk)))).toBe('unsaved');
    expect(disk.calls.some(call => call.startsWith('rename'))).toBe(false);
    expect(disk.files.size).toBe(0);
  });

  it('stops when the temporary file cannot be renamed, and leaves it (S2)', async () => {
    const disk = new Disk();
    disk.fault = step => step === 'rename' ? new Error('EPERM') : null;
    expect(await failureOf(prepare(storeOn(disk)))).toBe('unsaved');
    expect(disk.names()).toHaveLength(1);
    expect(disk.names()[0]).toMatch(/\.tmp-[0-9a-f]{12}\.json$/u);
  });

  it('stops when the prepared file reads back changed or cannot be read, and leaves it (S2)', async () => {
    const changed = new Disk();
    changed.readBack = (path, text) => path.endsWith('.prepared.json') ? text.replace('子ノード', '子ノーX') : text;
    expect(await failureOf(prepare(storeOn(changed)))).toBe('mismatch');
    expect(changed.names()).toEqual([preparedName(await backupId(draft))]);
    const unreadable = new Disk();
    unreadable.fault = (step, path) => step === 'read' && path.endsWith('.prepared.json') ? new Error('EIO') : null;
    expect(await failureOf(prepare(storeOn(unreadable)))).toBe('unsaved');
    expect(unreadable.names()).toEqual([preparedName(await backupId(draft))]);
  });

  it('writes nothing over a prepared or applied backup of the draft that is there', async () => {
    const id = await backupId(draft);
    for (const name of [preparedName(id), appliedName(id)]) {
      const disk = new Disk();
      disk.folders.add(FOLDER);
      disk.files.set(`${FOLDER}/${name}`, 'kept');
      expect(await failureOf(prepare(storeOn(disk)))).toBe('taken');
      expect(disk.calls.some(call => call.startsWith('write') || call.startsWith('rename'))).toBe(false);
      expect(disk.files.get(`${FOLDER}/${name}`)).toBe('kept');
    }
  });

  it('does not rename onto an applied backup that is there, nor mark one that was not prepared (S4)', async () => {
    const id = await backupId(draft);
    const disk = new Disk();
    const store = storeOn(disk);
    await prepare(store);
    disk.files.set(`${FOLDER}/${appliedName(id)}`, 'there already');
    expect(await failureOf(store.markApplied(id))).toBe('taken');
    expect(disk.files.get(`${FOLDER}/${appliedName(id)}`)).toBe('there already');
    expect(disk.files.has(`${FOLDER}/${preparedName(id)}`)).toBe(true);
    expect(await failureOf(storeOn(new Disk()).markApplied(id))).toBe('unverified');
    const refused = new Disk();
    const kept = storeOn(refused);
    await prepare(kept);
    refused.fault = step => step === 'rename' ? new Error('EPERM') : null;
    expect(await failureOf(kept.markApplied(id))).toBe('unsaved');
    expect(refused.names()).toEqual([preparedName(id)]);
    expect(disk.overwrites + refused.overwrites).toBe(0);
  });
});

describe('the size of the folder', () => {
  /** A disk holding `held` bytes in files of every kind but a backup of this draft. */
  const holding = (held: number): Disk => {
    const disk = new Disk();
    disk.folders.add(FOLDER);
    const parts = ['x'.repeat(Math.floor(held / 3)), 'y'.repeat(Math.floor(held / 3))];
    parts.push('z'.repeat(held - parts[0]!.length - parts[1]!.length));
    disk.files.set(`${FOLDER}/${'b'.repeat(64)}.tmp-0a0a0a0a0a0a.json`, parts[0]!);
    disk.files.set(`${FOLDER}/${'c'.repeat(64)}.applied.json`, parts[1]!);
    disk.files.set(`${FOLDER}/notes.txt`, parts[2]!);
    return disk;
  };

  it('counts every file in it, temporary, broken and unknown ones too: up to the limit itself, not one byte over', async () => {
    const adding = utf8Bytes(await expectedText());
    const limit = 3000 + adding;
    expect(await failureOf(prepare(storeOn(holding(3000), limit)))).toBe('none');
    expect(await failureOf(prepare(storeOn(holding(3001), limit)))).toBe('full');
  });

  it('writes nothing when it would go over, and deletes nothing to make room', async () => {
    const disk = holding(5000);
    const before = new Map(disk.files);
    expect(await failureOf(prepare(storeOn(disk, 5000)))).toBe('full');
    expect(disk.files).toEqual(before);
    expect(disk.calls.some(call => call.startsWith('write') || call.startsWith('rename'))).toBe(false);
  });

  it('counts the bytes on disk, not the characters', async () => {
    const disk = holding(0);
    disk.size = (path, text) => path.endsWith('notes.txt') ? 1000 : utf8Bytes(text);
    const adding = utf8Bytes(await expectedText());
    expect(await failureOf(prepare(storeOn(disk, 999 + adding)))).toBe('full');
  });

  it.each([
    ['the folder cannot be listed', (disk: Disk) => { disk.fault = step => step === 'list' ? new Error('EACCES') : null; }],
    ['a file in it cannot be measured', (disk: Disk) => { disk.size = path => path.endsWith('notes.txt') ? null : 1; }],
    ['it holds a folder', (disk: Disk) => { disk.folders.add(`${FOLDER}/old`); }],
  ])('stops when %s', async (_case, set) => {
    const disk = holding(30);
    set(disk);
    expect(await failureOf(prepare(storeOn(disk)))).toBe('unmeasured');
    expect(disk.calls.some(call => call.startsWith('write'))).toBe(false);
  });
});

describe('what a load finds in the folder', () => {
  it('finds nothing when the folder is not there', async () => {
    const survey = await storeOn(new Disk()).survey();
    expect(survey.records.size).toBe(0);
    expect(survey.unchecked).toEqual([]);
  });

  it('reads the prepared and applied backups by id', async () => {
    const disk = new Disk();
    const store = storeOn(disk);
    await prepare(store);
    const id = await backupId(draft);
    let survey = await store.survey();
    expect(survey.records.get(id)?.prepared?.backup.note.before).toBe(SOURCE);
    expect(survey.records.get(id)?.applied).toBeUndefined();
    await store.markApplied(id);
    survey = await store.survey();
    expect(survey.records.get(id)?.applied?.state).toBe('applied');
    expect(survey.unchecked).toEqual([]);
  });

  it('lists as unchecked a temporary file, an unknown one, one that does not read, one of another id, version or digest, and a folder', async () => {
    const disk = new Disk();
    const store = storeOn(disk);
    await prepare(store);
    const id = await backupId(draft);
    const good = disk.files.get(`${FOLDER}/${preparedName(id)}`)!;
    const other = 'd'.repeat(64);
    disk.files.set(`${FOLDER}/${other}.tmp-000000000000.json`, good);
    disk.files.set(`${FOLDER}/memo.txt`, '');
    disk.files.set(`${FOLDER}/${'e'.repeat(64)}.applied.json`, '{ broken');
    disk.files.set(`${FOLDER}/${other}.applied.json`, good);
    disk.files.set(`${FOLDER}/${'f'.repeat(64)}.applied.json`, good.replace('"version":1', '"version":2'));
    disk.files.set(`${FOLDER}/${id}.applied.json`, good.replace(await sha256Hex(SOURCE), '0'.repeat(64)));
    disk.folders.add(`${FOLDER}/nested`);
    const survey = await store.survey();
    expect(survey.unchecked.sort()).toEqual([
      `${FOLDER}/${other}.tmp-000000000000.json`, `${FOLDER}/memo.txt`, `${FOLDER}/${'e'.repeat(64)}.applied.json`,
      `${FOLDER}/${other}.applied.json`, `${FOLDER}/${'f'.repeat(64)}.applied.json`, `${FOLDER}/${id}.applied.json`, `${FOLDER}/nested`,
    ].sort());
    expect([...survey.records.keys()]).toEqual([id]);
  });

  // Review of e5745d1 (M1): a person who opened the folder in Finder or Explorer left `.DS_Store` (or `Thumbs.db`,
  // `desktop.ini`) there, and every write stopped. Those exact names are not taken for unknown files; they still take
  // room, so the size counts them. A name only like them still stops the writes.
  it('does not take the files an operating system leaves for unknown ones, and counts them in the size', async () => {
    const system = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];
    const disk = new Disk();
    disk.folders.add(FOLDER);
    for (const name of system) disk.files.set(`${FOLDER}/${name}`, 'x'.repeat(100));
    expect((await storeOn(disk).survey()).unchecked).toEqual([]);
    const adding = utf8Bytes(await expectedText());
    expect(await failureOf(prepare(storeOn(disk, 300 + adding - 1)))).toBe('full');
    expect(await failureOf(prepare(storeOn(disk, 300 + adding)))).toBe('none');
    expect((await storeOn(disk).survey()).unchecked).toEqual([]);
  });

  it('still takes a name only like those for an unknown file', async () => {
    const disk = new Disk();
    disk.folders.add(FOLDER);
    const like = ['.DS_Store.json', 'x.DS_Store', 'thumbs.db', 'Desktop.ini', '.DS_Store ', 'Thumbs.db.json'];
    for (const name of like) disk.files.set(`${FOLDER}/${name}`, '');
    expect((await storeOn(disk).survey()).unchecked.sort()).toEqual(like.map(name => `${FOLDER}/${name}`).sort());
  });

  it('lists the folder itself when a file is in its place, and fails when it cannot be listed', async () => {
    const disk = new Disk();
    disk.files.set(FOLDER, 'a file');
    expect((await storeOn(disk).survey()).unchecked).toEqual([FOLDER]);
    const refused = new Disk();
    refused.folders.add(FOLDER);
    refused.fault = step => step === 'list' ? new Error('EACCES') : null;
    await expect(storeOn(refused).survey()).rejects.toThrow('EACCES');
  });
});

describe('one chain for every step', () => {
  it('runs what is asked in order, one after another, a failure included', async () => {
    const disk = new Disk();
    const store = storeOn(disk);
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const slow = disk.adapter.write;
    disk.adapter.write = async (path: string, data: string) => { order.push('write starts'); await held; order.push('write ends'); return slow(path, data); };
    const first = prepare(store).then(() => order.push('prepare done'));
    const survey = store.survey().then(() => order.push('survey done'));
    const failing = store.markApplied('0'.repeat(64)).catch(() => order.push('mark failed'));
    const after = store.survey().then(() => order.push('second survey done'));
    await Promise.resolve();
    release();
    await Promise.all([first, survey, failing, after]);
    expect(order).toEqual(['write starts', 'write ends', 'prepare done', 'survey done', 'mark failed', 'second survey done']);
  });
});

/**
 * LEV-310: the one file the store takes away, a backup the person discarded in the rescue command (confirmed): the file
 * its record was read from, moved to the system trash or, where there is none, removed. Only while it is still that
 * file in this folder holding what was read; every other file stays.
 */
describe('discarding a backup (LEV-310)', () => {
  /** This draft's backup made on `disk`, marked applied unless `finish` is false, as the survey reads it. */
  async function madeOn(disk: Disk, finish = true) {
    const store = storeOn(disk);
    await prepare(store);
    if (finish) await store.markApplied(await backupId(draft));
    return (await store.survey()).records.get(await backupId(draft))![finish ? 'applied' : 'prepared']!;
  }
  const taking = (disk: Disk): string[] => disk.calls.filter(call => /^trash(System|Local) /u.test(call));

  it('moves only the file the record was read from to the system trash', async () => {
    const disk = new Disk();
    const record = await madeOn(disk);
    disk.files.set(`${FOLDER}/memo.txt`, 'x');
    disk.files.set(`${FOLDER}/${'a'.repeat(64)}.tmp-000000000000.json`, '{');
    const text = disk.files.get(record.path)!;
    const files = new Map(disk.files);
    files.delete(record.path);
    expect(await storeOn(disk).discard(record)).toBe('trashed');
    expect(disk.files).toEqual(files);
    expect([...disk.trash]).toEqual([[record.path, text]]);
    expect(taking(disk)).toEqual([`trashSystem ${record.path}`]);
  });

  // Review 1: where the system trash does not take it, the file went for good; it goes to the vault's own trash.
  it.each([['answers no', () => null], ['throws', (step: Step) => step === 'trashSystem' ? new Error('EPERM') : null]])(
    'moves it to the vault\'s own trash where the system trash %s, and deletes nothing', async (_case, fault) => {
      const disk = new Disk();
      disk.trashWorks = false;
      disk.fault = fault;
      const record = await madeOn(disk, false);
      const text = disk.files.get(record.path)!;
      expect(await storeOn(disk).discard(record)).toBe('localTrashed');
      expect(disk.files.has(record.path)).toBe(false);
      expect([...disk.localTrash]).toEqual([[record.path, text]]);
      expect(taking(disk)).toEqual([`trashSystem ${record.path}`, `trashLocal ${record.path}`]);
    });

  it.each([
    ['renamed since it was read', async (disk: Disk) => { await storeOn(disk).markApplied(await backupId(draft)); }],
    ['changed since it was read', async (disk: Disk) => {
      const path = `${FOLDER}/${preparedName(await backupId(draft))}`;
      disk.files.set(path, backupText(await makeExitBackup({ draft, path: draft.path, before: SOURCE, after: AFTER, edits, mappyVersion: '0.4.6', createdAt: 8 })));
    }],
    ['removed since it was read', async (disk: Disk) => { disk.files.delete(`${FOLDER}/${preparedName(await backupId(draft))}`); }],
    ['that does not read any more', async (disk: Disk) => { disk.files.set(`${FOLDER}/${preparedName(await backupId(draft))}`, '{ broken'); }],
  ])('leaves a backup %s, and every other file', async (_case, change) => {
    const disk = new Disk();
    const record = await madeOn(disk, false);
    await change(disk);
    const files = new Map(disk.files);
    expect(await storeOn(disk).discard(record)).toBe('gone');
    expect(disk.files).toEqual(files);
    expect(taking(disk)).toEqual([]);
  });

  it('takes nothing outside the folder, nor in a folder inside it', async () => {
    const disk = new Disk();
    const record = await madeOn(disk);
    const text = disk.files.get(record.path)!;
    for (const path of [`${PLUGIN}/data.json`, `${FOLDER}/inner/${appliedName(record.backup.id)}`, `${FOLDER}-other/${appliedName(record.backup.id)}`]) {
      disk.files.set(path, text);
      expect(await storeOn(disk).discard({ ...record, path })).toBe('gone');
    }
    expect(taking(disk)).toEqual([]);
  });

  it('fails with the reason, and the file stays, when neither trash takes it', async () => {
    const disk = new Disk();
    const record = await madeOn(disk);
    const files = new Map(disk.files);
    disk.fault = step => step === 'trashSystem' ? new Error('EPERM') : step === 'trashLocal' ? new Error('EBUSY') : null;
    await expect(storeOn(disk).discard(record)).rejects.toThrow('unsaved: EBUSY');
    expect(disk.files).toEqual(files);
  });

  // Review 1: a read that failed was told as the backup gone or changed, and the person did not try again.
  it('fails with the reason when the file is there but cannot be read, and takes nothing away', async () => {
    const disk = new Disk();
    const record = await madeOn(disk);
    const files = new Map(disk.files);
    disk.fault = (step, path) => step === 'read' && path === record.path ? new Error('EACCES') : null;
    await expect(storeOn(disk).discard(record)).rejects.toThrow('unsaved: EACCES');
    expect(disk.files).toEqual(files);
    expect(taking(disk)).toEqual([]);
  });

  // Review 2: a system trash that moved the file and then threw (or answered no) sent it on to the vault's trash, which
  // failed on the file gone; and a check after a move that failed told the move as a failure. Review 3: it is not said
  // to be in the system trash either, which did not say so.
  it.each([['threw', true], ['answered no', false]])('tells a file gone though the system trash %s as gone unconfirmed, and moves nothing again', async (_case, throws) => {
    const disk = new Disk();
    const record = await madeOn(disk);
    const text = disk.files.get(record.path)!;
    disk.adapter.trashSystem = (path: string) => {
      disk.calls.push(`trashSystem ${path}`);
      disk.files.delete(path);
      disk.trash.set(path, text);
      return throws ? Promise.reject(new Error('EIO after the move')) : Promise.resolve(false);
    };
    expect(await storeOn(disk).discard(record)).toBe('movedUnconfirmed');
    expect(taking(disk)).toEqual([`trashSystem ${record.path}`]);
    expect(disk.localTrash.size).toBe(0);
  });

  it('tells the move as made when the check after it fails', async () => {
    const disk = new Disk();
    const record = await madeOn(disk);
    let moved = false;
    const trash = disk.adapter.trashSystem;
    disk.adapter.trashSystem = async (path: string) => { const answer = await trash(path); moved = true; return answer; };
    disk.fault = step => step === 'exists' && moved ? new Error('EIO') : null;
    expect(await storeOn(disk).discard(record)).toBe('trashed');
    expect(disk.files.has(record.path)).toBe(false);
  });

  // Review 1: a file still there after the trash said it took it was told by its path as the reason.
  it('says the file is still there when the trash said it took it but the folder still has it', async () => {
    const disk = new Disk();
    const record = await madeOn(disk);
    disk.adapter.trashSystem = () => Promise.resolve(true);
    expect(await storeOn(disk).discard(record)).toBe('stillThere');
    expect(disk.files.has(record.path)).toBe(true);
  });

  it('runs on the chain, after what was asked before it', async () => {
    const disk = new Disk();
    const record = await madeOn(disk);
    const store = storeOn(disk);
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const read = disk.adapter.read;
    disk.adapter.read = async (path: string) => { order.push('survey reads'); await held; return read(path); };
    const survey = store.survey().then(() => order.push('survey done'));
    const discard = store.discard(record).then(outcome => order.push(`discard ${outcome}`));
    await Promise.resolve();
    release();
    await Promise.all([survey, discard]);
    expect(order.slice(0, 1)).toEqual(['survey reads']);
    expect(order.indexOf('survey done')).toBeLessThan(order.indexOf('discard trashed'));
  });
});
