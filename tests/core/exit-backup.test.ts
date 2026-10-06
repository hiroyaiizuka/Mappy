import { describe, expect, it } from 'vitest';
import { applyEdits } from '../../src/core/commands';
import {
  EXIT_BACKUP_LIMIT, appliedName, backupFileName, backupId, backupText, fitsBackupLimit, makeExitBackup, preparedName,
  readExitBackup, sameBackupGeneration, sha256Hex, temporaryName, utf8Bytes, type PlannedExitDraft,
} from '../../src/core/exit-backup';
import { draftKey, textFingerprint, withoutSources } from '../../src/core/exit-drafts';

/**
 * LEV-309 (the owner's decision of 2026-10-06): the backup every write of a kept draft leaves first. The pure part:
 * the file names and what a name in the folder is, the SHA-256 that names a draft's backup, the size rule (10 MiB,
 * every file counted), and the shape read back.
 */
const SOURCE = '- 親\n  - 子ノード\n- 別のノード\n';
const edits = [{ from: SOURCE.indexOf('子ノード'), to: SOURCE.indexOf('子ノード') + 4, text: '新しい名前' }];
const draft: PlannedExitDraft = {
  path: 'Notes/退避.md', title: '新しい名前', at: 1_791_265_000_000, before: textFingerprint(SOURCE),
  after: textFingerprint(applyEdits(SOURCE, edits)), edits, source: SOURCE,
};
const backupOf = (note = SOURCE) => makeExitBackup({ draft, path: draft.path, before: note, after: applyEdits(note, edits), edits, mappyVersion: '0.4.6', createdAt: 5 });

describe('the backup file names', () => {
  const id = 'a'.repeat(64);

  it('tells the three kinds by name, with the id', () => {
    expect(backupFileName(preparedName(id))).toEqual({ kind: 'prepared', id });
    expect(backupFileName(appliedName(id))).toEqual({ kind: 'applied', id });
    expect(backupFileName(temporaryName(id, '0a1b2c3d4e5f'))).toEqual({ kind: 'temporary', id });
  });

  it('takes anything else for unknown', () => {
    for (const name of ['data.json', `${id}.json`, `${id}.prepared.json.bak`, `${'A'.repeat(64)}.applied.json`, `${id.slice(1)}.applied.json`, '.DS_Store']) {
      expect(backupFileName(name)).toEqual({ kind: 'unknown' });
    }
  });
});

describe('the backup id and digests', () => {
  it('is the SHA-256 of the UTF-8 bytes, in hex', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it("names a draft by its draftKey's SHA-256, the same with or without its note text", async () => {
    expect(await backupId(draft)).toBe(await sha256Hex(draftKey(draft)));
    expect(await backupId(withoutSources([draft])[0]!)).toBe(await backupId(draft));
    expect(await backupId({ ...draft, title: '別の題名' })).not.toBe(await backupId(draft));
  });

  it('counts the UTF-8 bytes of the text itself', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('子')).toBe(3);
    expect(utf8Bytes('😀')).toBe(4);
  });
});

describe('the size rule', () => {
  it('is 10 MiB, the folder once written at most that: the limit itself fits, one byte more does not', () => {
    expect(EXIT_BACKUP_LIMIT).toBe(10 * 1024 * 1024);
    expect(fitsBackupLimit(EXIT_BACKUP_LIMIT - 100, 100)).toBe(true);
    expect(fitsBackupLimit(EXIT_BACKUP_LIMIT - 100, 101)).toBe(false);
    expect(fitsBackupLimit(0, EXIT_BACKUP_LIMIT)).toBe(true);
    expect(fitsBackupLimit(0, EXIT_BACKUP_LIMIT + 1)).toBe(false);
  });
});

describe('a backup as written and read back', () => {
  it('holds the draft as kept, the whole note before the write, the edit, and the digests of before and after', async () => {
    const backup = await backupOf();
    expect(backup).toMatchObject({ format: 'mappy-exit-backup', version: 1, id: await backupId(draft), mappyVersion: '0.4.6', createdAt: 5, draft, edits });
    expect(backup.note).toEqual({
      path: draft.path, before: SOURCE, beforeSha256: await sha256Hex(SOURCE), beforeLength: SOURCE.length,
      afterSha256: await sha256Hex(applyEdits(SOURCE, edits)), afterLength: applyEdits(SOURCE, edits).length,
    });
    expect(readExitBackup(backupText(backup))).toEqual(backup);
  });

  it('keeps the draft without its note text as it was kept', async () => {
    const bare = withoutSources([draft])[0] as PlannedExitDraft;
    const backup = await makeExitBackup({ draft: bare, path: bare.path, before: SOURCE, after: applyEdits(SOURCE, edits), edits, mappyVersion: '0.4.6', createdAt: 5 });
    expect(readExitBackup(backupText(backup))?.draft).toEqual(bare);
  });

  it('does not take another format, version, a missing field, a length that does not match, or a draft that is not one', async () => {
    const text = backupText(await backupOf());
    const changed = (change: (value: Record<string, unknown>) => void): string => {
      const value = JSON.parse(text) as Record<string, unknown>;
      change(value);
      return JSON.stringify(value);
    };
    expect(readExitBackup('{')).toBeNull();
    expect(readExitBackup(changed(value => { value.format = 'other'; }))).toBeNull();
    expect(readExitBackup(changed(value => { value.version = 2; }))).toBeNull();
    expect(readExitBackup(changed(value => { value.id = 'x'; }))).toBeNull();
    expect(readExitBackup(changed(value => { delete value.createdAt; }))).toBeNull();
    expect(readExitBackup(changed(value => { (value.note as Record<string, unknown>).beforeLength = 3; }))).toBeNull();
    expect(readExitBackup(changed(value => { (value.note as Record<string, unknown>).afterSha256 = 'z'; }))).toBeNull();
    expect(readExitBackup(changed(value => { value.draft = { path: 'a', title: 't', at: 1, refused: 'x' }; }))).toBeNull();
    expect(readExitBackup(changed(value => { value.edits = []; }))).toBeNull();
  });
});

describe('the generation of a backup', () => {
  it('is that of the draft when every field of it matches, its note text included', async () => {
    const backup = await backupOf();
    expect(await sameBackupGeneration(backup, draft)).toBe(true);
    // The same draft kept again without its note text: the same id, another generation.
    expect(await sameBackupGeneration(backup, withoutSources([draft])[0]!)).toBe(false);
    expect(await sameBackupGeneration(backup, { ...draft, source: `${SOURCE}x` })).toBe(false);
    expect(await sameBackupGeneration({ ...backup, id: '0'.repeat(64) }, draft)).toBe(false);
  });
});
