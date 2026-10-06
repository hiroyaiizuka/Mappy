import type { TextEdit } from './commands';
import { draftKey, isEdit, readExitDrafts, type ExitDraft } from './exit-drafts';

/**
 * The backup a kept draft's write leaves before it writes (LEV-309, the owner's decision of 2026-10-06): one JSON file
 * per draft, holding the draft as it was kept (the note text it was planned on too, when it has it), the whole note
 * just before the write, and the edit written. Every write of a kept draft goes through one, whichever way its edit
 * was planned, so a cut the guards cannot tell (`rebaseExitEdits`) still leaves the text it would have lost. This
 * module is the pure part: the shape, the file names, the size rule and the reading back. The files themselves, in
 * the plugin's folder through the vault's adapter, are `src/obsidian/exit-backup-store.ts`'s.
 */
export const EXIT_BACKUP_FORMAT = 'mappy-exit-backup';
export const EXIT_BACKUP_VERSION = 1;
/** The most the backup folder may hold on disk, every file in it counted (10 MiB). */
export const EXIT_BACKUP_LIMIT = 10 * 1024 * 1024;

/** A kept draft with a planned edit: the only kind written, so the only kind backed up. */
export type PlannedExitDraft = Exclude<ExitDraft, { refused: string }>;

export interface ExitBackup {
  format: typeof EXIT_BACKUP_FORMAT;
  version: typeof EXIT_BACKUP_VERSION;
  /** The SHA-256 (hex) of the draft's `draftKey`: names its files. */
  id: string;
  mappyVersion: string;
  /** When the backup was made (epoch ms). */
  createdAt: number;
  draft: PlannedExitDraft;
  /** The note just before the write: its path, its whole text, and the SHA-256 and length of it and of what the write leaves. */
  note: { path: string; before: string; beforeSha256: string; beforeLength: number; afterSha256: string; afterLength: number };
  edits: TextEdit[];
}

/** What a file in the backup folder is by its name; anything else (`unknown`) stops every write of the load. */
export type BackupFileName = { kind: 'temporary' | 'prepared' | 'applied'; id: string } | { kind: 'unknown' };

const HEX64 = /^[0-9a-f]{64}$/u;

/** Written in full before the write, read back and checked (S1, S2). */
export const preparedName = (id: string): string => `${id}.prepared.json`;
/** The prepared file renamed once the note is written (S4): the backup of a write that finished. */
export const appliedName = (id: string): string => `${id}.applied.json`;
/** Where the backup is written first (S1), renamed to `preparedName` once whole. */
export const temporaryName = (id: string, nonce: string): string => `${id}.tmp-${nonce}.json`;

/** A file name in the backup folder as one of the three kinds, or `unknown`. */
export function backupFileName(name: string): BackupFileName {
  const match = /^([0-9a-f]{64})\.(prepared|applied|tmp-[0-9a-z]+)\.json$/u.exec(name);
  if (!match) return { kind: 'unknown' };
  const kind = match[2] === 'prepared' ? 'prepared' : match[2] === 'applied' ? 'applied' : 'temporary';
  return { kind, id: match[1]! };
}

/** The SHA-256 of `text` (its UTF-8 bytes) in hex, by WebCrypto. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The id of a kept draft's backup: the SHA-256 of its `draftKey` (its note text left out, as there). */
export const backupId = (draft: ExitDraft): Promise<string> => sha256Hex(draftKey(draft));

/** How many bytes `text` takes as UTF-8: what a backup's JSON adds to the folder. */
export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/**
 * Whether a file of `adding` bytes fits beside the `held` ones: the folder holds at most `limit` once it is written. A
 * rename makes no copy, so the most the folder holds while a backup is made is what was there and the one file.
 */
export const fitsBackupLimit = (held: number, adding: number, limit = EXIT_BACKUP_LIMIT): boolean => held + adding <= limit;

/** The backup of writing `edits` into the note at `path`, whose text is `before` and becomes `after`. */
export async function makeExitBackup(input: {
  draft: PlannedExitDraft; path: string; before: string; after: string; edits: readonly TextEdit[]; mappyVersion: string; createdAt: number;
}): Promise<ExitBackup> {
  const { draft, path, before, after, edits, mappyVersion, createdAt } = input;
  return {
    format: EXIT_BACKUP_FORMAT, version: EXIT_BACKUP_VERSION, id: await backupId(draft), mappyVersion, createdAt, draft,
    note: { path, before, beforeSha256: await sha256Hex(before), beforeLength: before.length, afterSha256: await sha256Hex(after), afterLength: after.length },
    edits: edits.map(edit => ({ from: edit.from, to: edit.to, text: edit.text })),
  };
}

/** The file's text: the JSON as written, read back and compared character for character. */
export const backupText = (backup: ExitBackup): string => JSON.stringify(backup);

const isLength = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/**
 * A backup file's text as a backup of this format and version, or null: anything else (another format or version, a
 * field missing or of another type, a draft that is not one, a length that does not match its text) is not taken as
 * one. Whether its SHA-256 match its text is the caller's to check (it is async).
 */
export function readExitBackup(text: string): ExitBackup | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.format !== EXIT_BACKUP_FORMAT || raw.version !== EXIT_BACKUP_VERSION) return null;
  const { id, mappyVersion, createdAt, note, edits } = raw;
  if (typeof id !== 'string' || !HEX64.test(id) || typeof mappyVersion !== 'string') return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  const [draft] = readExitDrafts([raw.draft]);
  if (!draft || 'refused' in draft) return null;
  if (!note || typeof note !== 'object') return null;
  const kept = note as Record<string, unknown>;
  const { path, before, beforeSha256, beforeLength, afterSha256, afterLength } = kept;
  if (typeof path !== 'string' || typeof before !== 'string' || !isLength(beforeLength) || before.length !== beforeLength) return null;
  if (typeof beforeSha256 !== 'string' || !HEX64.test(beforeSha256) || typeof afterSha256 !== 'string' || !HEX64.test(afterSha256)) return null;
  if (!isLength(afterLength) || !Array.isArray(edits) || edits.length === 0 || !edits.every(isEdit)) return null;
  return {
    format: EXIT_BACKUP_FORMAT, version: EXIT_BACKUP_VERSION, id, mappyVersion, createdAt, draft,
    note: { path, before, beforeSha256, beforeLength, afterSha256, afterLength },
    edits: edits.map(edit => ({ from: edit.from, to: edit.to, text: edit.text })),
  };
}

/**
 * Whether `backup` is of this very draft: its format and version, the draft's id, and every field of the draft, its
 * note text included (a draft kept again without it is another generation: its backup is not taken for this one).
 */
export async function sameBackupGeneration(backup: ExitBackup, draft: ExitDraft): Promise<boolean> {
  if (backup.format !== EXIT_BACKUP_FORMAT || backup.version !== EXIT_BACKUP_VERSION) return false;
  if (backup.id !== await backupId(draft)) return false;
  const [read] = readExitDrafts([draft]);
  return read !== undefined && JSON.stringify(read) === JSON.stringify(backup.draft);
}
