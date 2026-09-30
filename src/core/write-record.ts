import type { TextEdit } from "./commands";
import { parseMarkdown, type MindDocument } from "./markdown";

/** A write the store made on a note: what it read before, what it wrote, and the edits between (`DocumentStore.onWrite`). */
export interface RecordedWrite {
  readonly before: string;
  readonly after: string;
  readonly edits: readonly TextEdit[];
}

/**
 * Whether `a` and `b` are one write told twice (the store's word and the caller's answer): the same texts and the same
 * edits. The texts alone are not enough: deleting the first or the second of two twins writes the same text, and taken
 * for each other, a re-read would carry the ids by the other one's edits (LEV-237).
 */
export function sameWrite(a: RecordedWrite, b: RecordedWrite): boolean {
  return a.before === b.before && a.after === b.after && a.edits.length === b.edits.length
    && a.edits.every((edit, index) => edit.from === b.edits[index]?.from && edit.to === b.edits[index]?.to && edit.text === b.edits[index]?.text);
}

/** A recorded write, numbered in the order it was recorded (`WriteRecord.mark`). */
interface Recorded {
  readonly write: RecordedWrite;
  readonly serial: number;
  /**
   * `write.after` parsed from a document with its edits, kept so the parses of one write from one document agree: a
   * node the write added gets its id when parsed (`node-N`), and the map's write shown at once, the base of its open
   * drafts and its re-read must name it alike (`parseWrite`).
   */
  parsed?: { from: MindDocument; basename: string; document: MindDocument };
}

/** The parse of a text from the writes that lead to it (`WriteRecord.replay`), and how many of them it took. */
export interface Replayed {
  readonly document: MindDocument;
  readonly used: number;
}

/**
 * The writes the store made on a note since a reader of it last parsed it, in order, so the next parse carries every
 * node's id over with their edits: nothing else carries a node whose title repeats or is empty (LEV-146). A text they
 * do not lead to — someone else wrote (E05) — is matched by titles alone: after the writes, or between them, where a
 * write starts on a text the one before it did not leave (someone changed the note, and the store wrote on the change
 * before the reader read it, LEV-238). The change is matched by titles and the write carries the ids by its edits.
 *
 * A read that finds the text on screen keeps only the writes recorded while it was under way (LEV-224, the view's rule
 * since LEV-218). Not those recorded before it began: the read would have found them, so someone put the note back
 * (Undo in the Markdown pane, a sync), and kept they would be replayed over the put-back. A read replays to the last
 * write that reaches the text found (LEV-237) and drops the rest past it on the same rule.
 *
 * Kept by a map embedded in another note (`MapEmbed`, LEV-217), by the maps an item calls (`CallReader`, LEV-221) and by
 * the map tab (`MindmapView`, LEV-150; here since LEV-247). The embed and the called maps read with `take` and `spend`.
 * The view composes the same steps itself (`replay`, `keep`, `drop`): it parses a text the record does not lead to from
 * the map it shows rather than from the last text the writes reached, spends a read's writes only after the maps the
 * note calls are read (`version`), and shows its own write before the re-read does. It also hears its own writes twice,
 * the store's word (`record`) and the store's answer (`confirm`, `carry`).
 */
export class WriteRecord {
  private writes: Recorded[] = [];
  private serial = 0;
  private replaced = 0;

  /**
   * `write` as the store tells it (`DocumentStore.onWrite`, once for each write), added to the record. A write on
   * `shown` (the text last parsed) while the record ends elsewhere starts the record again: the store wrote it on that
   * text, so the note was put back there and the writes recorded were taken back (LEV-224) — even the same write as one
   * in the record, made again after the put-back (LEV-247). A write on any other text than the record's end (or
   * `shown`, when it is empty) was made on someone else's change the reader has not read yet, and is kept all the same
   * (LEV-238): the store tells a write before any read can find it (`DocumentStore.tell`), so its start is the note as
   * it was then, and the read matches the change by titles and carries the ids through the write. Left out, the
   * nodes the write renamed or moved would be matched by titles too, from a text two changes away. A write that
   * changed nothing (the store tells no such write) takes nothing back and carries no id.
   */
  record(write: RecordedWrite, shown: string | undefined): void {
    if (write.before === write.after) return;
    const last = this.writes[this.writes.length - 1];
    if (write.before !== (last?.write.after ?? shown) && write.before === shown) this.restart(write);
    else this.push(write);
  }

  /**
   * `write` as the store answered the reader that asked for it (the view's `writeOwn`, `writeLayout`), which the store's
   * word told before (`record`) unless the record was cleared since. A write already there is the last one and
   * is not added again; nor one a read has spent in between (its start is behind `shown`). Unlike the store's word, the
   * answer comes after reads may have spent the write, so one that starts elsewhere than the record's end or `shown` is
   * not added. Not matched against
   * earlier writes to be added, as `carry` does: ⌘Z, ⌘⇧Z, ⌘Z before one re-read write the same texts twice. A write
   * made on `shown` while the record ends elsewhere starts the record again, as in `record`, unless the record holds it
   * already: it was told before its caller got the answer, and others were recorded after it. "Already" is the same
   * texts and the same edits (`sameWrite`): another edit that writes the same texts is a write of its own (LEV-237).
   */
  confirm(write: RecordedWrite, shown: string | undefined): void {
    if (write.before === write.after) return;
    const last = this.writes[this.writes.length - 1];
    if (last && sameWrite(last.write, write)) return;
    // The answer carries more than the write (`CarriedWrite.carried`): only the write is kept.
    const kept = { before: write.before, after: write.after, edits: write.edits };
    if (write.before === (last?.write.after ?? shown)) { this.push(kept); return; }
    if (write.before !== shown) return;
    if (this.writes.some(recorded => sameWrite(recorded.write, write))) return;
    this.restart(kept);
  }

  /**
   * The layout writes the store carried a reader's edit over (`CarriedWrite.carried`, LEV-196), recorded where the
   * record leads to their start (those it holds already are found by `sameWrite`), and `planned` — the parse the edit
   * was planned on, when there is one — carried through those that lead on from it. Without them a read could not
   * replay from the text on screen to the edit's (LEV-150 through LEV-196's carry).
   */
  carry(carried: readonly RecordedWrite[], shown: string | undefined, planned: MindDocument | undefined, basename: string): MindDocument | undefined {
    let at = this.writes[this.writes.length - 1]?.write.after ?? shown;
    let base = planned;
    for (const write of carried) {
      let recorded = this.writes.find(item => sameWrite(item.write, write));
      if (!recorded) {
        if (write.before !== at) continue;
        // A copy: the store keeps `write` in its own list of layout writes.
        recorded = this.push({ before: write.before, after: write.after, edits: write.edits });
        at = write.after;
      }
      if (base?.source === recorded.write.before) base = this.parseWrite(recorded, base, basename);
    }
    return base;
  }

  /** Taken as a read begins, for `take`, `spend` and `keep` to tell the writes recorded while it was under way. */
  mark(): number {
    return this.serial;
  }

  /**
   * Changes whenever the record is replaced rather than added to (started again, spent, cleared), so a reader that
   * replays now and spends later can tell whether the record is still the one it replayed.
   */
  get version(): number {
    return this.replaced;
  }

  /** How many writes wait for a read; each holds two copies of the note. */
  get size(): number {
    return this.writes.length;
  }

  /** The writes waiting for a read, in order: for the tests and the probes of the real-device cases (E58, E66), a copy each time. */
  get recorded(): readonly RecordedWrite[] {
    return this.writes.map(recorded => recorded.write);
  }

  clear(): void {
    this.replace([]);
  }

  /**
   * `text` parsed from `from`, by a read begun at `mark`: through the recorded writes up to the last one that wrote
   * exactly `text` (those are spent — ⌘Z then ⌘⇧Z behind it included — and of the rest only those recorded while the
   * read was under way kept for a later read: one recorded before it was put back). When they do not lead there, a parse matched by titles: from `from` for its own text (the note renamed, or put back), keeping
   * the writes recorded while the read was under way; else from the text the writes the read passed reached, keeping
   * the rest (`passed`). The writes are parsed only once the texts show where they lead.
   */
  take(text: string, from: MindDocument | undefined, basename: string, mark: number): MindDocument {
    const replayed = this.replayed(from, this.reaches(text), basename, false);
    if (replayed) {
      this.keep(mark, replayed.used);
      return replayed.document;
    }
    if (from && text === from.source) {
      this.keep(mark, 0);
      return parseMarkdown(text, basename, from);
    }
    const passed = this.passed(text, mark);
    const reached = from ? this.parse(from, passed, basename, false) : undefined;
    this.keep(mark, passed);
    return parseMarkdown(text, basename, reached);
  }

  /**
   * For a reader that keeps what it shows, by a read begun at `mark` that found `shown`: the writes that lead from it
   * back to it (⌘Z then ⌘⇧Z) spent, and of the rest only those recorded while the read was under way kept, as `take`
   * does.
   */
  spend(shown: string, mark: number): void {
    this.keep(mark, this.reaches(shown));
  }

  /**
   * `text` parsed from `from` through the writes that lead there, up to the last one that wrote exactly `text`: a record
   * that comes back to that text (the second twin deleted, put back with ⌘Z, the first deleted) holds it twice, and only
   * the last write carries the ids to the note as it is (LEV-237). Nothing is spent, and each write's parse is kept for
   * the next replay from the same document (`parseWrite`). Undefined when they do not lead there.
   */
  replay(text: string, from: MindDocument | undefined, basename: string): Replayed | undefined {
    return this.replayed(from, this.reaches(text), basename, true);
  }

  /**
   * How many writes a read begun at `mark` that found `text` — a text no write reached, nor the one on screen — has
   * passed: up to the last write recorded while it was under way that was made on `text` (the store wrote on the text
   * the read found before the reader parsed it, LEV-238), else all of them. The writes after it are the next read's.
   */
  passed(text: string, mark: number): number {
    for (let index = this.writes.length - 1; index >= 0; index -= 1) {
      const recorded = this.writes[index]!;
      if (recorded.serial >= mark && recorded.write.before === text) return index;
    }
    return this.writes.length;
  }

  /**
   * The first `spent` writes spent, and of the rest only those recorded since `mark`, the start of a read: one recorded
   * before was there for the read to find, and it found another text, so someone put the note back over it (LEV-224).
   * Those kept need not lead on from the text found: a change in between is matched by titles (LEV-238).
   */
  keep(mark: number, spent: number): void {
    this.replace(this.writes.slice(spent).filter(recorded => recorded.serial >= mark));
  }

  /** The first `spent` writes spent and the rest kept as they are: a reader that has shown the text they led to. */
  drop(spent: number): void {
    this.replace(this.writes.slice(spent));
  }

  private push(write: RecordedWrite): Recorded {
    const recorded = { write, serial: this.serial++ };
    this.writes.push(recorded);
    return recorded;
  }

  private restart(write: RecordedWrite): void {
    this.replace([]);
    this.push(write);
  }

  private replace(writes: Recorded[]): void {
    this.writes = writes;
    this.replaced += 1;
  }

  /** How many writes lead to `text`: up to the last one that wrote it (0 when none does). */
  private reaches(text: string): number {
    for (let index = this.writes.length; index > 0; index -= 1) if (this.writes[index - 1]!.write.after === text) return index;
    return 0;
  }

  /** `from` parsed through the `reaches` first writes (`reaches`), when they lead anywhere. */
  private replayed(from: MindDocument | undefined, reaches: number, basename: string, cached: boolean): Replayed | undefined {
    return from && reaches > 0 ? { document: this.parse(from, reaches, basename, cached), used: reaches } : undefined;
  }

  /**
   * `from` carried through the first `count` writes, each parsed with its edits. `cached` for a reader that parses the
   * same write from the same document again before it spends it (the view); `take` spends what it parses at once.
   */
  private parse(from: MindDocument, count: number, basename: string, cached: boolean): MindDocument {
    let document = from;
    for (const recorded of this.writes.slice(0, count)) {
      document = cached ? this.parseWrite(recorded, document, basename) : parseOver(recorded.write, document, basename);
    }
    return document;
  }

  /** `recorded.write.after` parsed from `from` (`parseOver`), once per base document. */
  private parseWrite(recorded: Recorded, from: MindDocument, basename: string): MindDocument {
    if (recorded.parsed?.from !== from || recorded.parsed.basename !== basename) {
      recorded.parsed = { from, basename, document: parseOver(recorded.write, from, basename) };
    }
    return recorded.parsed.document;
  }
}

/**
 * `write.after` parsed from `from` with the write's edits: from the text the write was made on, matched by titles first
 * when `from` is another (a change the reader did not read came before the write, E05, LEV-238).
 */
function parseOver(write: RecordedWrite, from: MindDocument, basename: string): MindDocument {
  const base = from.source === write.before ? from : parseMarkdown(write.before, basename, from);
  return parseMarkdown(write.after, basename, base, undefined, write.edits);
}
