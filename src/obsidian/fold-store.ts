import type { DataAdapter } from "obsidian";
import type { FoldKey } from "../core/fold-keys";
import type { FoldMoves } from "../core/fold-state";
import {
  FOLD_LIMITS, isRemoved, readFoldFile, relinkedKey, renamedPaths, sameFolds, sortedKeys, writeFoldFile, type FoldEntry, type StoredFolds,
} from "../core/fold-memory";

/** The adapter's part the memory uses. */
export type FoldAdapter = Pick<DataAdapter, "read" | "write" | "remove" | "rename" | "exists" | "stat">;

/** The memory's file in the plugin's folder (`manifest.dir`). */
export const foldMemoryPath = (pluginFolder: string): string => `${pluginFolder}/folds.json`;

/** How long the folds rest unchanged before they are written (ms): a run of folds and opens is one write. */
export const FOLD_WRITE_DELAY = 1000;
/** The longest a change waits for its write while changes keep coming (ms). */
export const FOLD_WRITE_MAX_DELAY = 10_000;
/** How many times a load reads the two files when a read fails, and the wait before each next try (ms, times the try). */
export const FOLD_LOAD_TRIES = 5;
export const FOLD_LOAD_RETRY = 50;
/** The longest wait before a failed write is tried again (ms): it doubles from twice `FOLD_WRITE_DELAY` up to this. */
export const FOLD_WRITE_RETRY_MAX = 60_000;

/** What one of the two files gave a load: a file, none (missing, or not a file of this shape), or a read that failed. */
type Probe = { state: "file"; file: NonNullable<ReturnType<typeof readFoldFile>> } | { state: "none" } | { state: "failed" };

/**
 * The folds of every note between its openings (LEV-365, the person's decision of 2026-10-19): Mappy's own file in the
 * plugin's folder (`folds.json`, shape and limits in `src/core/fold-memory.ts`), read once when the plugin loads and held
 * in memory, so a map opening reads no file. The read goes on beside the plugin's load (`load`, not awaited there): a map
 * opening before it is done waits for it (`ready`), and a rename or deletion meanwhile is applied once it is (code review
 * 2 of LEV-365). A change is written once the folds have rested `FOLD_WRITE_DELAY` (at most
 * `FOLD_WRITE_MAX_DELAY` after the first change not written), and at once when the plugin unloads, Obsidian quits and the
 * page goes (`flush`, from src/main.ts).
 *
 * The file is never cut open in place: a write cut off as the page goes can leave a file empty (`fs.promises.writeFile`
 * truncates first, LEV-230), so the new text goes to `folds.next.json` first, then the old file is removed and the new one
 * renamed into its place. Each text carries `savedAt`, and a load takes whichever of the two files reads and is newer: a
 * write cut anywhere leaves the last whole text. The vault's adapter runs reads and writes one at a time (Obsidian
 * 1.14.4's `FileSystemAdapter.queue`), so a read never sees half a write; it does not keep a write's three steps together,
 * though, so the load of a plugin enabled again right after its disable can find a file gone between its `stat` and its
 * `read` (the unload's write moving it, code review 1 of LEV-365): a read that fails is tried again (`FOLD_LOAD_TRIES`).
 * A file that is missing or not of this shape (broken, another version, too large) counts as none: the maps open with
 * nothing remembered, and the next write replaces it. When a read keeps failing (no access, a sync service holding it),
 * the other file is taken if it read; when neither did, what the file holds is not known: the folds of this session are
 * kept in memory and nothing is written, so the file stays (code reviews 1 and 3 of LEV-365).
 *
 * Read once: a change made to the file meanwhile by something else (a sync service bringing another device's) is not
 * read, and the next write puts this Obsidian's folds over it (LEV-365's question 3, decided A). A failed write is tried
 * again, after twice `FOLD_WRITE_DELAY` and then twice as long each time up to `FOLD_WRITE_RETRY_MAX`, or at the next
 * change or flush, without a word: the folds are how the map looks, never the note.
 */
export class FoldStore {
  private notes = new Map<string, StoredFolds>();
  private savedAt = 0;
  private dirty = false;
  private timer: number | undefined;
  /** When the oldest change not written yet was made. */
  private pendingSince: number | undefined;
  private writing: Promise<void> | null = null;
  /** Set when a load could not read a file that is there: this session writes nothing over it. */
  private unread = false;
  private loading: Promise<void> | undefined;
  private loaded = false;
  /** The wait before a failed write is tried again; 0 after a write that went through. */
  private retry = 0;
  /** Set as the plugin unloads (`close`): nothing changes or is written after its last write. */
  private closed = false;
  private closing: Promise<void> | undefined;
  readonly next: string;

  constructor(
    private readonly adapter: FoldAdapter, readonly path: string,
    /** Whether the vault has a note at the path: folds are kept for notes only. */
    private readonly exists: (path: string) => boolean,
    private readonly delay = FOLD_WRITE_DELAY,
  ) {
    this.next = `${path.replace(/\.json$/u, "")}.next.json`;
  }

  /** The file read into memory, once: the newer of the two that read (see the class). */
  load(): Promise<void> {
    this.loading ??= this.read().finally(() => { this.loaded = true; });
    return this.loading;
  }

  /** Resolves once the file is read (at once when no load was started: the memory is then empty and usable). */
  get ready(): Promise<void> {
    return this.loading ?? Promise.resolve();
  }

  /** False while the file is being read: what changes the notes kept then waits for it (`later`). */
  private get settled(): boolean {
    return this.loading === undefined || this.loaded;
  }

  /**
   * `change` applied once the file is read, so the read does not put the notes back from before it; true when it is put
   * off, or when the memory is closed and the change is dropped.
   */
  private later(change: () => void): boolean {
    if (this.closed) return true;
    if (this.settled) return false;
    void this.ready.then(change);
    return true;
  }

  private async read(): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      const probes = await Promise.all([this.probe(this.path), this.probe(this.next)]);
      const failed = probes.some(probe => probe.state === "failed");
      const chosen = probes.flatMap(probe => (probe.state === "file" ? [probe.file] : [])).sort((a, b) => b.savedAt - a.savedAt)[0];
      if (!failed || (chosen && attempt >= FOLD_LOAD_TRIES)) {
        if (!chosen) return;
        this.notes = chosen.notes;
        this.savedAt = chosen.savedAt;
        return;
      }
      if (attempt >= FOLD_LOAD_TRIES) { this.unread = true; return; }
      await new Promise<void>(resolve => { window.setTimeout(resolve, FOLD_LOAD_RETRY * attempt); });
    }
  }

  private async probe(path: string): Promise<Probe> {
    let stat: Awaited<ReturnType<FoldAdapter["stat"]>>;
    try { stat = await this.adapter.stat(path); } catch { return { state: "failed" }; }
    if (!stat) return { state: "none" };
    if (stat.type !== "file" || stat.size > FOLD_LIMITS.readBytes) return { state: "none" };
    let text: string;
    try { text = await this.adapter.read(path); } catch { return { state: "failed" }; }
    const file = readFoldFile(text);
    return file ? { state: "file", file } : { state: "none" };
  }

  /** The folds kept for the note at `path`. */
  get(path: string): FoldEntry | undefined {
    return this.notes.get(path);
  }

  /**
   * The folds kept for the note at `path`, for a map opening it. The opening counts as a use for the limits: a note open
   * on a map is not the first left out (`at`), though nothing is written for it (code review 1 of LEV-365).
   */
  open(path: string): FoldEntry | undefined {
    const stored = this.notes.get(path);
    if (stored) stored.at = Math.max(stored.at, Date.now());
    return stored;
  }

  /** The note's folds as a map shows them now; none forgets the note. Nothing is written when they are what is kept. */
  set(path: string, entry: FoldEntry): void {
    if (this.later(() => { this.set(path, entry); })) return;
    const stored = this.notes.get(path);
    if (entry.folds.length === 0 && entry.open.length === 0) {
      if (stored && this.notes.delete(path)) this.changed();
      return;
    }
    if (sameFolds(stored, entry) || !this.exists(path)) return;
    this.notes.set(path, { at: Date.now(), folds: entry.folds, open: entry.open });
    this.changed();
  }

  /**
   * A re-parse on a map moved, dropped or brought back keys of the note's nodes (`moves`, src/core/fold-state.ts): the kept
   * folds follow them, whichever map changed the folds last, and nothing else of them changes (code reviews 2 and 3 of
   * LEV-365: a map not touched does not put its own folds over another's).
   */
  move(path: string, change: FoldMoves): void {
    if (this.later(() => { this.move(path, change); })) return;
    const { moved, dropped, added } = change;
    if (moved.size === 0 && dropped.size === 0 && added.length === 0) return;
    const stored = this.notes.get(path);
    if (!stored && (added.length === 0 || !this.exists(path))) return;
    let touched = false;
    const follow = (keys: readonly FoldKey[], opened: boolean): FoldKey[] => {
      const next = keys.flatMap(key => {
        const text = JSON.stringify(key);
        if (dropped.has(text)) { touched = true; return []; }
        const to = moved.get(text);
        if (!to) return [key];
        touched = true;
        return [to];
      });
      const held = new Set(next.map(key => JSON.stringify(key)));
      for (const item of added) {
        if (item.open !== opened || held.has(JSON.stringify(item.key))) continue;
        next.push(item.key);
        touched = true;
      }
      return sortedKeys(next);
    };
    const folds = follow(stored?.folds ?? [], false);
    const open = follow(stored?.open ?? [], true);
    if (!touched) return;
    if (folds.length === 0 && open.length === 0) this.notes.delete(path);
    else this.notes.set(path, { at: stored?.at ?? Date.now(), folds, open });
    this.changed();
  }

  /**
   * A note or folder renamed or moved (`vault.on("rename")`): its notes' folds go with it, and the keys of every note whose
   * calling items link to it follow the link Obsidian rewrites in that note (`relinkedKey`, code review 3 of LEV-365).
   */
  rename(from: string, to: string): void {
    if (this.later(() => { this.rename(from, to); })) return;
    let touched = false;
    const moved = renamedPaths(this.notes.keys(), from, to);
    if (moved.size > 0) {
      const entries = Array.from(moved, ([old, path]) => [path, this.notes.get(old)!] as const);
      for (const old of moved.keys()) this.notes.delete(old);
      for (const [path, stored] of entries) this.notes.set(path, stored);
      touched = true;
    }
    for (const [path, stored] of this.notes) {
      let relinked = false;
      const follow = (keys: readonly FoldKey[]): FoldKey[] => keys.map(key => {
        const next = relinkedKey(key, from, to);
        if (next) relinked = true;
        return next ?? key;
      });
      const folds = follow(stored.folds);
      const open = follow(stored.open);
      if (!relinked) continue;
      this.notes.set(path, { at: stored.at, folds: sortedKeys(folds), open: sortedKeys(open) });
      touched = true;
    }
    if (touched) this.changed();
  }

  /** A note or folder deleted: its notes are forgotten (`vault.on("delete")`). */
  delete(path: string): void {
    if (this.later(() => { this.delete(path); })) return;
    let removed = false;
    for (const kept of Array.from(this.notes.keys())) if (isRemoved(kept, path)) removed = this.notes.delete(kept) || removed;
    if (removed) this.changed();
  }

  /** The notes no longer in the vault forgotten: deleted or moved while Obsidian was closed (once the layout is ready). */
  prune(): void {
    if (this.later(() => { this.prune(); })) return;
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

  /**
   * The plugin unloads: what is not written yet is written now, once, and nothing after it — a retry or a change from a
   * view torn down later would otherwise write this memory over the one the plugin enabled again holds (code review 3).
   */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    this.closing = this.lastWrite();
    return this.closing;
  }

  /** The write under way, if any, then one more for what is left (`close`). */
  private async lastWrite(): Promise<void> {
    if (this.writing) await this.writing;
    if (this.dirty && !this.unread) await this.write();
  }

  /** What is not written yet, written now; resolves when the file holds it (or the write failed and waits for the next). */
  flush(): Promise<void> {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.unread || this.closed) return this.closing ?? this.writing ?? Promise.resolve();
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
      this.retry = 0;
    } catch {
      this.dirty = true;
      if (this.closed) return;
      // Tried again later, unless a change or a flush comes first; the wait doubles while the writes keep failing.
      this.retry = Math.min(FOLD_WRITE_RETRY_MAX, this.retry === 0 ? this.delay * 2 : this.retry * 2);
      if (this.timer !== undefined) window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => { this.timer = undefined; void this.flush(); }, this.retry);
    }
  }
}
