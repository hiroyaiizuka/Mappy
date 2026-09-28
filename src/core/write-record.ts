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
 * do not lead to — someone else wrote (E05) — is matched by titles alone.
 *
 * A read that finds the text on screen keeps only the writes recorded while it was under way that lead on from it
 * (LEV-224, the view's rule since LEV-218). Not those recorded before it began: the read would have found them, so
 * someone put the note back (Undo in the Markdown pane, a sync), and kept they would stand at the end of the record,
 * where the next write, made on the text on screen, could not follow them. A read replays to the last write that
 * reaches the text found (LEV-237) and drops the rest past it on the same rule.
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
   * `write` as the store tells it (`DocumentStore.onWrite`, once for each write), kept where the record leads to its
   * start: its end, or `shown` (the text last parsed) when it is empty. A write on `shown` while the record ends
   * elsewhere starts the record again: the store wrote it on that text, so the note was put back there and the writes
   * recorded were taken back (LEV-224) — even the same write as one in the record, made again after the put-back
   * (LEV-247). A write that changed nothing (the store tells no such write) takes nothing back and carries no id.
   */
  record(write: RecordedWrite, shown: string | undefined): void {
    if (write.before === write.after) return;
    const last = this.writes[this.writes.length - 1];
    if (write.before === (last?.write.after ?? shown)) this.push(write);
    else if (write.before === shown) this.restart(write);
  }

  /**
   * `write` as the store answered the reader that asked for it (the view's `writeOwn`, `writeLayout`), which the store's
   * word told before (`record`) unless the record did not lead to it then. A write already there is the last one and
   * is not added again; nor one a read has spent in between (its start is behind `shown`). Not matched against
   * earlier writes to be added, as `carry` does: ⌘Z, ⌘⇧Z, ⌘Z before one re-read write the same texts twice. A write
   * made on `shown` while the record ends elsewhere starts the record again, as in `record`, unless the record holds it
   * already: it was told before its caller got the answer, and others were recorded after it. "Already" is the same
   * texts and the same edits (`sameWrite`): another edit that writes the same texts is a write of its own (LEV-237).
   */
  confirm(write: RecordedWrite, shown: string | undefined): void {
    if (write.before === write.after) return;
    const last = this.writes[this.writes.length - 1];
    if (last && sameWrite(last.write, write)) return;
    if (write.before === (last?.write.after ?? shown)) { this.push(write); return; }
    if (write.before !== shown) return;
    if (this.writes.some(recorded => sameWrite(recorded.write, write))) return;
    this.restart(write);
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
        recorded = this.push(write);
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

  /** The writes waiting for a read, in order. */
  get recorded(): readonly RecordedWrite[] {
    return this.writes.map(recorded => recorded.write);
  }

  clear(): void {
    this.replace([]);
  }

  /**
   * `text` parsed from `from`, by a read begun at `mark`: through the recorded writes up to the last one that wrote
   * exactly `text` (those are spent — ⌘Z then ⌘⇧Z behind it included — and of the rest only those recorded while the
   * read was under way that lead on from `text` kept for a later read: one recorded before it was put back). When they do
   * not lead there, a parse matched by titles: from `from` for its own text (the note renamed, or put back), keeping
   * the writes recorded while the read was under way that lead on from it; else from the last text the writes
   * reached, and the record dropped. The writes are parsed only once the texts show where they lead.
   */
  take(text: string, from: MindDocument | undefined, basename: string, mark: number): MindDocument {
    const replayed = this.replay(text, from, basename);
    if (replayed) {
      this.keep(text, mark, replayed.used);
      return replayed.document;
    }
    if (from && text === from.source) {
      this.keep(text, mark, 0);
      return parseMarkdown(text, basename, from);
    }
    const reached = from ? this.parse(from, this.follow(from.source, text).led, basename) : undefined;
    this.clear();
    return parseMarkdown(text, basename, reached);
  }

  /**
   * For a reader that keeps what it shows, by a read begun at `mark` that found `shown`: the writes that lead from it
   * back to it (⌘Z then ⌘⇧Z) spent, and of the rest only those recorded while the read was under way that lead on
   * from it kept, as `take` does.
   */
  spend(shown: string, mark: number): void {
    this.keep(shown, mark, this.follow(shown, shown).reaches);
  }

  /**
   * `text` parsed from `from` through the writes that lead there, up to the last one that wrote exactly `text`: a record
   * that comes back to that text (the second twin deleted, put back with ⌘Z, the first deleted) holds it twice, and only
   * the last write carries the ids to the note as it is (LEV-237). Nothing is spent. Undefined when they do not lead
   * there.
   */
  replay(text: string, from: MindDocument | undefined, basename: string): Replayed | undefined {
    const { reaches } = this.follow(from?.source, text);
    if (!from || reaches === 0) return undefined;
    return { document: this.parse(from, reaches, basename), used: reaches };
  }

  /**
   * The first `spent` writes spent, and of the rest only those recorded since `mark` that lead on one from the other
   * from `text`: the first that does not ends them.
   */
  keep(text: string, mark: number, spent: number): void {
    const kept: Recorded[] = [];
    let at = text;
    for (let index = spent; index < this.writes.length; index += 1) {
      const recorded = this.writes[index]!;
      if (recorded.serial < mark) continue;
      if (recorded.write.before !== at) break;
      kept.push(recorded);
      at = recorded.write.after;
    }
    this.replace(kept);
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

  /**
   * How far the writes lead from `start`, by their texts alone: `led` writes follow one another from it, and the
   * `reaches` first of them end on `text` (0 when none does).
   */
  private follow(start: string | undefined, text: string): { reaches: number; led: number } {
    let at = start;
    let reaches = 0;
    let led = 0;
    for (const { write } of this.writes) {
      if (at === undefined || write.before !== at) break;
      at = write.after;
      led += 1;
      if (at === text) reaches = led;
    }
    return { reaches, led };
  }

  /** `from` carried through the first `count` writes, each parsed with its edits. */
  private parse(from: MindDocument, count: number, basename: string): MindDocument {
    let document = from;
    for (const recorded of this.writes.slice(0, count)) document = this.parseWrite(recorded, document, basename);
    return document;
  }

  /** `recorded.write.after` parsed from `from` with its edits, once per base document. */
  private parseWrite(recorded: Recorded, from: MindDocument, basename: string): MindDocument {
    if (recorded.parsed?.from !== from || recorded.parsed.basename !== basename) {
      recorded.parsed = { from, basename, document: parseMarkdown(recorded.write.after, basename, from, undefined, recorded.write.edits) };
    }
    return recorded.parsed.document;
  }
}
