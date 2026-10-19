import type { DataAdapter } from "obsidian";
import {
  FOLD_LIMITS, isRemoved, readFoldFile, renamedPaths, sameFolds, writeFoldFile, type FoldEntry, type StoredFolds,
} from "../core/fold-memory";

/** The adapter's part the memory uses. */
export type FoldAdapter = Pick<DataAdapter, "read" | "write" | "remove" | "rename" | "exists" | "stat">;

/** The memory's file in the plugin's folder (`manifest.dir`). */
export const foldMemoryPath = (pluginFolder: string): string => `${pluginFolder}/folds.json`;

/** How long the folds rest unchanged before they are written (ms): a run of folds and opens is one write. */
export const FOLD_WRITE_DELAY = 1000;
/** The longest a change waits for its write while changes keep coming (ms). */
export const FOLD_WRITE_MAX_DELAY = 10_000;

/**
 * The folds of every note between its openings (LEV-365, the person's decision of 2026-10-19): Mappy's own file in the
 * plugin's folder (`folds.json`, shape and limits in `src/core/fold-memory.ts`), read once when the plugin loads and held
 * in memory, so a map opening reads no file. A change is written once the folds have rested `FOLD_WRITE_DELAY` (at most
 * `FOLD_WRITE_MAX_DELAY` after the first change not written), and at once when the plugin unloads, Obsidian quits and the
 * page goes (`flush`, from src/main.ts).
 *
 * The file is never cut open in place: a write cut off as the page goes can leave a file empty (`fs.promises.writeFile`
 * truncates first, LEV-230), so the new text goes to `folds.next.json` first, then the old file is removed and the new one
 * renamed into its place. Each text carries `savedAt`, and a load takes whichever of the two files reads and is newer: a
 * write cut anywhere leaves the last whole text. The vault's adapter runs reads and writes one at a time (Obsidian
 * 1.14.4's `FileSystemAdapter.queue`), so a read never sees half a write. A file that does not read (broken, another
 * version, too large) counts as none: the maps open with nothing remembered, and the next write replaces it.
 *
 * Read once: a change made to the file meanwhile by something else (a sync service bringing another device's) is not
 * read, and the next write puts this Obsidian's folds over it (provisional, LEV-365's PR). A failed write is kept for the
 * next change or flush, without a word: the folds are how the map looks, never the note.
 */
export class FoldStore {
  private notes = new Map<string, StoredFolds>();
  private savedAt = 0;
  private dirty = false;
  private timer: number | undefined;
  /** When the oldest change not written yet was made. */
  private pendingSince: number | undefined;
  private writing: Promise<void> | null = null;
  readonly next: string;

  constructor(
    private readonly adapter: FoldAdapter, readonly path: string,
    /** Whether the vault has a note at the path: folds are kept for notes only. */
    private readonly exists: (path: string) => boolean,
    private readonly delay = FOLD_WRITE_DELAY,
  ) {
    this.next = `${path.replace(/\.json$/u, "")}.next.json`;
  }

  /** The file read into memory: the newer of the two that read (see the class). */
  async load(): Promise<void> {
    const [current, next] = await Promise.all([this.readFile(this.path), this.readFile(this.next)]);
    const chosen = [current, next].filter(file => file !== null).sort((a, b) => b.savedAt - a.savedAt)[0];
    if (!chosen) return;
    this.notes = chosen.notes;
    this.savedAt = chosen.savedAt;
  }

  private async readFile(path: string): Promise<ReturnType<typeof readFoldFile>> {
    try {
      const stat = await this.adapter.stat(path);
      if (!stat || stat.type !== "file" || stat.size > FOLD_LIMITS.readBytes) return null;
      return readFoldFile(await this.adapter.read(path));
    } catch { return null; }
  }

  /** The folds kept for the note at `path`. */
  get(path: string): FoldEntry | undefined {
    return this.notes.get(path);
  }

  /** The note's folds as a map shows them now; none forgets the note. Nothing is written when they are what is kept. */
  set(path: string, entry: FoldEntry): void {
    const stored = this.notes.get(path);
    if (entry.folds.length === 0 && entry.open.length === 0) {
      if (stored && this.notes.delete(path)) this.changed();
      return;
    }
    if (sameFolds(stored, entry) || !this.exists(path)) return;
    this.notes.set(path, { at: Date.now(), folds: entry.folds, open: entry.open });
    this.changed();
  }

  /** A note or folder renamed or moved: its notes' folds go with it (`vault.on("rename")`). */
  rename(from: string, to: string): void {
    const moved = renamedPaths(this.notes.keys(), from, to);
    if (moved.size === 0) return;
    const entries = Array.from(moved, ([old, path]) => [path, this.notes.get(old)!] as const);
    for (const old of moved.keys()) this.notes.delete(old);
    for (const [path, stored] of entries) this.notes.set(path, stored);
    this.changed();
  }

  /** A note or folder deleted: its notes are forgotten (`vault.on("delete")`). */
  delete(path: string): void {
    let removed = false;
    for (const kept of Array.from(this.notes.keys())) if (isRemoved(kept, path)) removed = this.notes.delete(kept) || removed;
    if (removed) this.changed();
  }

  /** The notes no longer in the vault forgotten: deleted or moved while Obsidian was closed (once the layout is ready). */
  prune(): void {
    let removed = false;
    for (const path of Array.from(this.notes.keys())) if (!this.exists(path)) removed = this.notes.delete(path) || removed;
    if (removed) this.changed();
  }

  private changed(): void {
    this.dirty = true;
    const now = Date.now();
    this.pendingSince ??= now;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.delay, this.pendingSince + FOLD_WRITE_MAX_DELAY - now));
    this.timer = window.setTimeout(() => { this.timer = undefined; void this.flush(); }, wait);
  }

  /** What is not written yet, written now; resolves when the file holds it (or the write failed and waits for the next). */
  flush(): Promise<void> {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.writing) return this.writing.then(() => (this.dirty ? this.flush() : undefined));
    if (!this.dirty) return Promise.resolve();
    const task = this.write().finally(() => { if (this.writing === task) this.writing = null; });
    this.writing = task;
    return task;
  }

  private async write(): Promise<void> {
    this.dirty = false;
    this.pendingSince = undefined;
    const savedAt = Math.max(Date.now(), this.savedAt + 1);
    const { text, kept } = writeFoldFile(this.notes, savedAt);
    for (const path of Array.from(this.notes.keys())) if (!kept.has(path)) this.notes.delete(path);
    try {
      await this.adapter.write(this.next, text);
      if (await this.adapter.exists(this.path)) await this.adapter.remove(this.path);
      await this.adapter.rename(this.next, this.path);
      this.savedAt = savedAt;
    } catch {
      this.dirty = true;
    }
  }
}
