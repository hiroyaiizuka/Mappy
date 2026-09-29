import { parseLinktext, TFile, type App } from 'obsidian';
import type { CallTarget, CallTargets } from '../core/calls';
import { embedOnlyTitle, isBlockReference, readMapFromSource } from '../core/embed';
import { parseMarkdown, type MindDocument } from '../core/markdown';
import { WriteRecord } from '../core/write-record';
import type { DocumentStore } from './document-store';
import { resolveEmbedTarget } from './embed-target';

/**
 * The maps a note's items call (§5 M12), read from the vault. An item whose title is one
 * `![[…]]` is resolved as a note embed is (`resolveEmbedTarget`: a Markdown note with
 * `mappy: true` in the cache, not a block reference), the note itself is refused, and the
 * note is read through the store (an open editor's buffer first) and must still be a map
 * by its own text (an unsaved edit that dropped `mappy: true` makes the item a link).
 * Each note is parsed once per read, whatever the number of items calling it, with the
 * previous parse as the identity reference, so the ids and with them the folds of a
 * called map survive an edit of that note; a note whose text did not change keeps the
 * very same document, so the caller can tell an unchanged result by reference. A note
 * that cannot be read makes its items links. The previous parse outlives such a read, and
 * a read that no longer finds the note while an item waits for a map, as an embed's last map
 * does (`MapEmbed`). Everything is kept by the note's `TFile`, which Obsidian keeps through a
 * rename and a move, so the ids come back with the note; a note deleted and made again is
 * another file, and starts anew (LEV-246).
 *
 * A reader that `listen`s also records the store's writes on the notes it read (an edit, a layout button, ⌘Z／⌘⇧Z in a
 * map tab of the called note) and carries the ids over with their edits, as an embed does (`WriteRecord`, LEV-217):
 * nothing else keeps the folds on a called node whose title repeats or is empty (LEV-221). An external change (E05) is
 * matched by titles alone. The reader has no lifecycle of its own: whoever calls `listen` ends it (`MindmapView`).
 */
export class CallReader {
  /** The notes the last read parsed (`reads`). */
  private readonly parsed = new Set<TFile>();
  /**
   * The last parse of each note read here, the identity reference of its next parse: kept when a read fails or finds
   * no map, and past a read that did not reach the note while one of its items waited for a map (the note renamed
   * before the link to it, no map by its saved header); let go of with the rest (`clear`).
   */
  private readonly last = new Map<TFile, { source: string; document: MindDocument }>();
  /**
   * The store's writes on a note since it was last parsed here, while someone listens (`listen`): kept exactly as long
   * as it is read, and let go with every other parse once the host calls nothing (`clear`).
   */
  private readonly writes = new Map<TFile, WriteRecord>();
  /** The items the last read found waiting for a map (`waiting`). */
  private waitingIds: ReadonlySet<string> = new Set();
  /** The subscription writes are recorded for (`listen`); the view that holds the reader listens once for its life. */
  private listening: object | null = null;
  /** Reads run one after another, so two overlapping reads cannot parse the same note twice under different ids. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly app: App, private readonly store: DocumentStore) {}

  /**
   * Records the store's writes on the notes read here from now on, until the returned function runs (once is enough; a
   * second call does nothing). A later `listen` takes over from an earlier one, whose stop then only ends its own
   * subscription: one record per note, whoever listens.
   */
  listen(): () => void {
    const token = {};
    this.listening = token;
    const stop = this.store.onWrite((file, write) => {
      if (this.listening === token) this.writes.get(file)?.record(write, this.last.get(file)?.source);
    });
    // A deleted note never comes back as the same file: its last parse and record are of no use (code review 2 of
    // LEV-246). That it was read stays until the next read: the host asks `reads` to know that read is due.
    const deleted = this.app.vault.on('delete', file => {
      if (this.listening !== token || !(file instanceof TFile)) return;
      this.last.delete(file);
      this.writes.delete(file);
    });
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      stop();
      this.app.vault.offref(deleted);
      if (this.listening !== token) return;
      this.listening = null;
      this.writes.clear();
    };
  }

  /** True while any note's parse or record is kept here, so `clear` has something to let go of. */
  get holding(): boolean {
    return this.parsed.size > 0 || this.last.size > 0 || this.writes.size > 0;
  }

  /**
   * Lets go of every note read here: the host no longer calls any (its items changed, it left the note). Without it the
   * record of a note no read comes back for would take every write on that note for as long as the host is open. Queued
   * behind the reads, as a read that finds no call does it: a read under way would put back what was let go of. Nothing
   * is let go of when `current` no longer holds by then (the host moved on, and its own reads decide).
   */
  clear(current: () => boolean = () => true): Promise<void> {
    const result = this.queue.then(() => {
      if (!current()) return;
      this.parsed.clear();
      this.last.clear();
      this.writes.clear();
      this.waitingIds = new Set();
    });
    this.queue = result;
    return result;
  }

  /**
   * The maps `document`'s items call, for a host at `hostPath`. `current` tells whether the host still shows `document`:
   * a read whose host moved on (a newer read, another note) reads nothing and lets go of nothing, when it starts and
   * when it would let go of the notes `document` does not call — those may be the ones the host calls now.
   */
  read(document: MindDocument, hostPath: string, current: () => boolean = () => true): Promise<CallTargets> {
    const result = this.queue.then(() => this.readNow(document, hostPath, current));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readNow(document: MindDocument, hostPath: string, current: () => boolean): Promise<CallTargets> {
    if (!current()) return new Map();
    const wanted = new Map<TFile, { id: string; subpath: string }[]>();
    const waiting = new Set<string>();
    for (const node of document.nodes) {
      const linktext = embedOnlyTitle(node.title);
      if (!linktext) continue;
      const target = resolveEmbedTarget(this.app, linktext, hostPath);
      if (!target) {
        if (this.mayBecomeMap(linktext, hostPath)) waiting.add(node.id);
        continue;
      }
      if (target.file.path === hostPath) continue;
      const callers = wanted.get(target.file) ?? [];
      callers.push({ id: node.id, subpath: target.subpath });
      wanted.set(target.file, callers);
    }
    const targets = new Map<string, CallTarget>();
    for (const [file, callers] of wanted) {
      const parsed = await this.parse(file);
      if (!parsed) {
        for (const caller of callers) waiting.add(caller.id);
        continue;
      }
      // The path as it is now: a rename while the note was read moved the same file.
      for (const caller of callers) targets.set(caller.id, { path: file.path, subpath: caller.subpath, document: parsed });
    }
    if (current()) {
      this.waitingIds = waiting;
      for (const file of Array.from(this.parsed)) if (!wanted.has(file)) this.forget(file);
      // A note not reached keeps its last parse only while an item waits for a map, and only while it is in the vault.
      for (const file of Array.from(this.last.keys())) {
        if (!wanted.has(file) && (waiting.size === 0 || this.app.vault.getAbstractFileByPath(file.path) !== file)) this.last.delete(file);
      }
    }
    return targets;
  }

  /**
   * The items the last read found waiting for a map: one whose link finds no note (the note renamed before the link to
   * it), or a Markdown note that is no map for now (by the cache or by its text) or could not be read. Not an image, a
   * block reference or the host itself: those never call a map. The host keeps the folds of their branches (LEV-246).
   */
  get waiting(): ReadonlySet<string> {
    return this.waitingIds;
  }

  private mayBecomeMap(linktext: string, hostPath: string): boolean {
    const { path, subpath } = parseLinktext(linktext);
    if (isBlockReference(subpath)) return false;
    const file = this.app.metadataCache.getFirstLinkpathDest(path, hostPath);
    return !file || (file.extension === 'md' && file.path !== hostPath);
  }

  /** True when the last read parsed the note now at `path`: a change of it can alter what the host shows. */
  reads(path: string): boolean {
    for (const file of this.parsed) if (file.path === path) return true;
    return false;
  }

  private async parse(file: TFile): Promise<MindDocument | null> {
    let writes = this.writes.get(file);
    // The writes recorded before the read begins, which it will find if nobody else takes them back (LEV-224).
    const mark = writes?.mark() ?? 0;
    let text: string;
    try {
      text = await this.store.read(file);
    } catch {
      this.forget(file);
      return null;
    }
    if (readMapFromSource(text) === null) {
      this.forget(file);
      return null;
    }
    // Made with the note's first parse, before the continuation of this read yields: a write the store queued after the
    // read is told only once this has run (`DocumentStore.enqueue`), so it finds the record.
    if (!writes && this.listening) {
      writes = new WriteRecord();
      this.writes.set(file, writes);
    }
    const previous = this.last.get(file);
    this.parsed.add(file);
    if (previous && previous.source === text && previous.document.root.title === file.basename) {
      // Writes that came back to the text parsed (⌘Z then ⌘⇧Z) are spent here, not carried to the next read.
      writes?.spend(text, mark);
      return previous.document;
    }
    const parsed = writes
      ? writes.take(text, previous?.document, file.basename, mark)
      : parseMarkdown(text, file.basename, previous?.document);
    this.last.set(file, { source: text, document: parsed });
    return parsed;
  }

  /**
   * A note no longer read here: that it was read, and the writes that would have led on from its parse (nothing reads it
   * to spend them). The last parse stays the reference for identity, should the note come back (LEV-246).
   */
  private forget(file: TFile): void {
    this.parsed.delete(file);
    this.writes.delete(file);
  }
}

/** True when two reads resolved the same items to the same documents and headings, so nothing on the map changes. */
export function sameTargets(left: CallTargets, right: CallTargets): boolean {
  if (left.size !== right.size) return false;
  for (const [id, target] of left) {
    const other = right.get(id);
    if (!other || other.document !== target.document || other.subpath !== target.subpath || other.path !== target.path) return false;
  }
  return true;
}
