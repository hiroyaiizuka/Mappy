import type { App, TFile } from 'obsidian';
import type { CallTarget, CallTargets } from '../core/calls';
import { embedOnlyTitle, readMapFromSource } from '../core/embed';
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
 * that cannot be read makes its items links.
 *
 * A reader that `listen`s also records the store's writes on the notes it read (an edit, a layout button, ⌘Z／⌘⇧Z in a
 * map tab of the called note) and carries the ids over with their edits, as an embed does (`WriteRecord`, LEV-217):
 * nothing else keeps the folds on a called node whose title repeats or is empty (LEV-221). An external change (E05) is
 * matched by titles alone. The reader has no lifecycle of its own: whoever calls `listen` ends it (`MindmapView`).
 */
export class CallReader {
  private readonly parsed = new Map<string, { source: string; document: MindDocument }>();
  /**
   * By path, the store's writes on a note since it was last parsed here, while someone listens (`listen`): kept exactly
   * as long as its parse, and let go with every other parse once the host calls nothing (`clear`).
   */
  private readonly writes = new Map<string, WriteRecord>();
  private listening = 0;
  /** Reads run one after another, so two overlapping reads cannot parse the same note twice under different ids. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly app: App, private readonly store: DocumentStore) {}

  /** Records the store's writes on the notes read here from now on; the returned function stops it. */
  listen(): () => void {
    this.listening += 1;
    const stop = this.store.onWrite((file, write) => {
      this.writes.get(file.path)?.record(write, this.parsed.get(file.path)?.source);
    });
    return () => {
      stop();
      this.listening -= 1;
      if (this.listening === 0) this.writes.clear();
    };
  }

  /**
   * Lets go of every note read here: the host no longer calls any (its items changed, it left the note). Without it the
   * record of a note no read comes back for would take every write on that note for as long as the host is open.
   */
  clear(): void {
    this.parsed.clear();
    this.writes.clear();
  }

  read(document: MindDocument, hostPath: string): Promise<CallTargets> {
    const result = this.queue.then(() => this.readNow(document, hostPath));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readNow(document: MindDocument, hostPath: string): Promise<CallTargets> {
    const wanted = new Map<string, { file: TFile; callers: { id: string; subpath: string }[] }>();
    for (const node of document.nodes) {
      const linktext = embedOnlyTitle(node.title);
      if (!linktext) continue;
      const target = resolveEmbedTarget(this.app, linktext, hostPath);
      if (!target || target.file.path === hostPath) continue;
      const entry = wanted.get(target.file.path) ?? { file: target.file, callers: [] };
      entry.callers.push({ id: node.id, subpath: target.subpath });
      wanted.set(target.file.path, entry);
    }
    const targets = new Map<string, CallTarget>();
    for (const [path, { file, callers }] of wanted) {
      const parsed = await this.parse(file);
      if (!parsed) continue;
      for (const caller of callers) targets.set(caller.id, { path, subpath: caller.subpath, document: parsed });
    }
    for (const path of Array.from(this.parsed.keys())) if (!wanted.has(path)) this.forget(path);
    return targets;
  }

  /** True when the last read parsed this note: a change of it can alter what the host shows. */
  reads(path: string): boolean {
    return this.parsed.has(path);
  }

  private async parse(file: TFile): Promise<MindDocument | null> {
    let writes = this.writes.get(file.path);
    // The writes recorded before the read begins, which it will find if nobody else takes them back (LEV-224).
    const mark = writes?.mark() ?? 0;
    let text: string;
    try {
      text = await this.store.read(file);
    } catch {
      this.forget(file.path);
      return null;
    }
    if (readMapFromSource(text) === null) {
      this.forget(file.path);
      return null;
    }
    // Made with the note's first parse, before the continuation of this read yields: a write the store queued after the
    // read is told only once this has run (`DocumentStore.enqueue`), so it finds the record.
    if (!writes && this.listening > 0) {
      writes = new WriteRecord();
      this.writes.set(file.path, writes);
    }
    const previous = this.parsed.get(file.path);
    if (previous && previous.source === text && previous.document.root.title === file.basename) {
      // Writes that came back to the text parsed (⌘Z then ⌘⇧Z) are spent here, not carried to the next read.
      writes?.spend(text, mark);
      return previous.document;
    }
    const parsed = writes
      ? writes.take(text, previous?.document, file.basename, mark)
      : parseMarkdown(text, file.basename, previous?.document);
    this.parsed.set(file.path, { source: text, document: parsed });
    return parsed;
  }

  /** A note no longer read here: its parse, and the writes that would have led on from it. */
  private forget(path: string): void {
    this.parsed.delete(path);
    this.writes.delete(path);
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
