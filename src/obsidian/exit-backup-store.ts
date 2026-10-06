import type { DataAdapter } from "obsidian";
import type { TextEdit } from "../core/commands";
import {
  EXIT_BACKUP_LIMIT, appliedName, backupFileName, backupText, fitsBackupLimit, makeExitBackup, preparedName, readExitBackup,
  sha256Hex, temporaryName, utf8Bytes, type ExitBackup, type PlannedExitDraft,
} from "../core/exit-backup";

/**
 * The backups kept drafts leave before they are written (LEV-309, `src/core/exit-backup.ts`), as files in the plugin's
 * own folder (`<plugin folder>/exit-backups/`), through the vault's adapter alone: not `localStorage`, whose room the
 * drafts not written yet need. One backup is made in three steps, each a step of the write (`src/ui/exit-drafts.ts`):
 * written whole to a temporary file (S1), renamed to `<id>.prepared.json` and read back, the same text and SHA-256
 * (S2), then, once the note is written (S3), renamed to `<id>.applied.json` (S4). A rename is never made onto a name
 * that is there. Nothing here deletes a file: what is left by a step that did not finish stays for the person to see
 * (the rescue command lists it) and stops the writes, as does anything else in the folder that is not a backup of
 * this format (but the files an operating system leaves there, `SYSTEM_FILES`, which are only counted in its size). Every step runs after the one before it, in one chain, so a rescue reading the folder and a load
 * writing to it never interleave.
 */

/** The adapter's part the backups use. */
export type BackupAdapter = Pick<DataAdapter, "exists" | "stat" | "list" | "read" | "write" | "rename" | "mkdir">;

/** The backup folder in the plugin's folder (`manifest.dir`). */
export const exitBackupFolder = (pluginFolder: string): string => `${pluginFolder}/exit-backups`;

/**
 * Why a backup was not made or finished: the folder would hold more than the limit (`full`), its size could not be
 * measured (`unmeasured`), a file could not be written or renamed (`unsaved`, with the adapter's message), the backup
 * read back was not what was written (`mismatch`), a name it needed was taken (`taken`), or the folder is not one
 * (`unverified`). The note is not written for any of them.
 */
export type ExitBackupFailure = "full" | "unmeasured" | "unsaved" | "mismatch" | "taken" | "unverified";

export class ExitBackupError extends Error {
  constructor(readonly failure: ExitBackupFailure, readonly detail = "") { super(detail === "" ? failure : `${failure}: ${detail}`); }
}

/** A backup file read and checked: whether its write finished (`applied`) or not known to (`prepared`). */
export interface BackupRecord { state: "prepared" | "applied"; path: string; backup: ExitBackup; bytes: number }

/**
 * The folder as a load or the rescue finds it: the records by draft id, and every path there that is not one
 * (`unchecked`: a temporary file, one that does not read as a backup of this format or whose content does not match
 * its name, a folder, or the backup folder itself when it is a file), the operating system's files (`SYSTEM_FILES`) left
 * out of both.
 */
export interface BackupSurvey {
  records: Map<string, { prepared?: BackupRecord; applied?: BackupRecord }>;
  unchecked: string[];
}

const message = (error: unknown): string => error instanceof Error && error.message ? error.message : String(error);

/**
 * Files an operating system leaves in a folder it shows (macOS's Finder, Windows' Explorer), by their exact names: not
 * backups and not taken for unknown ones (a person who opened the folder would otherwise stop every write), but on disk
 * all the same, so the folder's size counts them. A name like them is not one of them (`.DS_Store.json`, `x.DS_Store`).
 */
const SYSTEM_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

export class ExitBackupStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly adapter: BackupAdapter, readonly folder: string, private readonly mappyVersion: string,
    readonly limit = EXIT_BACKUP_LIMIT, private readonly now: () => number = () => Date.now(),
  ) {}

  /** What the folder holds now; throws when it cannot be listed or read (the caller writes nothing then). */
  survey(): Promise<BackupSurvey> { return this.queue(() => this.read()); }

  /**
   * S1 and S2: the backup of writing `edits` into the note at `path`, whose text is `before` and becomes `after`, made
   * and read back; the backup, or an `ExitBackupError` (the note is not to be written).
   */
  prepare(draft: PlannedExitDraft, path: string, before: string, after: string, edits: readonly TextEdit[]): Promise<ExitBackup> {
    return this.queue(async () => {
      const backup = await makeExitBackup({ draft, path, before, after, edits, mappyVersion: this.mappyVersion, createdAt: this.now() });
      const text = backupText(backup);
      await this.ensureFolder();
      const held = await this.measure();
      if (!fitsBackupLimit(held, utf8Bytes(text), this.limit)) throw new ExitBackupError("full");
      const prepared = `${this.folder}/${preparedName(backup.id)}`;
      const temporary = `${this.folder}/${temporaryName(backup.id, nonce())}`;
      for (const taken of [prepared, `${this.folder}/${appliedName(backup.id)}`, temporary]) {
        if (await this.exists(taken)) throw new ExitBackupError("taken", taken);
      }
      try { await this.adapter.write(temporary, text); } catch (error) { throw new ExitBackupError("unsaved", message(error)); }
      try { await this.adapter.rename(temporary, prepared); } catch (error) { throw new ExitBackupError("unsaved", message(error)); }
      let read: string;
      try { read = await this.adapter.read(prepared); } catch (error) { throw new ExitBackupError("unsaved", message(error)); }
      if (read !== text || await sha256Hex(read) !== await sha256Hex(text)) throw new ExitBackupError("mismatch");
      return backup;
    });
  }

  /** S4: the prepared backup of draft `id` renamed to the applied one, never onto one that is there. */
  markApplied(id: string): Promise<void> {
    return this.queue(async () => {
      const prepared = `${this.folder}/${preparedName(id)}`;
      const applied = `${this.folder}/${appliedName(id)}`;
      if (await this.exists(applied)) throw new ExitBackupError("taken", applied);
      if (!await this.exists(prepared)) throw new ExitBackupError("unverified", prepared);
      try { await this.adapter.rename(prepared, applied); } catch (error) { throw new ExitBackupError("unsaved", message(error)); }
    });
  }

  /** Runs `task` once every task queued before it has settled, whatever their outcome. */
  private queue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async exists(path: string): Promise<boolean> {
    try { return await this.adapter.exists(path); } catch (error) { throw new ExitBackupError("unmeasured", message(error)); }
  }

  /** The folder made when it is not there; one in its place that is not a folder refuses. */
  private async ensureFolder(): Promise<void> {
    if (await this.exists(this.folder)) {
      const stat = await this.adapter.stat(this.folder).catch(() => null);
      if (stat?.type !== "folder") throw new ExitBackupError("unverified", this.folder);
      return;
    }
    try { await this.adapter.mkdir(this.folder); } catch (error) { throw new ExitBackupError("unsaved", message(error)); }
  }

  /**
   * The bytes every file in the folder takes, by its size on disk: the temporary, broken and unknown ones too. A file
   * or the folder that cannot be measured, or a folder inside it (not counted here), refuses.
   */
  private async measure(): Promise<number> {
    let listed: { files: string[]; folders: string[] };
    try { listed = await this.adapter.list(this.folder); } catch (error) { throw new ExitBackupError("unmeasured", message(error)); }
    if (listed.folders.length > 0) throw new ExitBackupError("unmeasured", listed.folders[0]);
    let held = 0;
    for (const path of listed.files) {
      const stat = await this.adapter.stat(path).catch(() => null);
      if (!stat || stat.type !== "file" || !Number.isFinite(stat.size) || stat.size < 0) throw new ExitBackupError("unmeasured", path);
      held += stat.size;
    }
    return held;
  }

  private async read(): Promise<BackupSurvey> {
    const survey: BackupSurvey = { records: new Map(), unchecked: [] };
    if (!await this.adapter.exists(this.folder)) return survey;
    const stat = await this.adapter.stat(this.folder);
    if (stat?.type !== "folder") { survey.unchecked.push(this.folder); return survey; }
    const listed = await this.adapter.list(this.folder);
    survey.unchecked.push(...listed.folders);
    for (const path of listed.files) {
      if (SYSTEM_FILES.has(path.slice(path.lastIndexOf("/") + 1))) continue;
      const name = backupFileName(path.slice(path.lastIndexOf("/") + 1));
      if (name.kind === "unknown" || name.kind === "temporary") { survey.unchecked.push(path); continue; }
      let text: string | null = null;
      try { text = await this.adapter.read(path); } catch { /* Unreadable: not a record. */ }
      const backup = text === null ? null : readExitBackup(text);
      if (!backup || backup.id !== name.id || await sha256Hex(backup.note.before) !== backup.note.beforeSha256) {
        survey.unchecked.push(path);
        continue;
      }
      const entry = survey.records.get(name.id) ?? {};
      entry[name.kind] = { state: name.kind, path, backup, bytes: utf8Bytes(text!) };
      survey.records.set(name.id, entry);
    }
    return survey;
  }
}

/** Twelve hex digits for a temporary file's name. */
function nonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), byte => byte.toString(16).padStart(2, "0")).join("");
}
