import type { TextEdit } from "./commands";
import { parseMarkdown, type MindDocument } from "./markdown";

/** A write the store made on a note: what it read before, what it wrote, and the edits between (`DocumentStore.onWrite`). */
export interface RecordedWrite {
  readonly before: string;
  readonly after: string;
  readonly edits: readonly TextEdit[];
}

/** A recorded write, numbered in the order it was recorded (`WriteRecord.mark`). */
interface Recorded {
  readonly write: RecordedWrite;
  readonly serial: number;
}

/**
 * The writes the store made on a note since a reader of it last parsed it, in order, so the next parse carries every
 * node's id over with their edits: nothing else carries a node whose title repeats or is empty (LEV-146). A text they
 * do not lead to — someone else wrote (E05) — is matched by titles alone, from the last text they reached.
 *
 * A read that finds the text on screen keeps only the writes recorded while it was under way that lead on from it
 * (LEV-224, the view's rule since LEV-218). Not those recorded before it began: the read would have found them, so
 * someone put the note back (Undo in the Markdown pane, a sync), and kept they would stand at the end of the record,
 * where the next write, made on the text on screen, could not follow them.
 *
 * Used by a map embedded in another note (`MapEmbed`, LEV-217). `MindmapView` keeps its own record (`ownWrites`,
 * LEV-150) on the same rule for a read of the text on screen, but it is a separate copy and not the same in every
 * case: it tells the writes from before the read by identity rather than by number, keeps the rest whole when a read
 * reaches part of the record (dropped here since code review 1 of LEV-224; the view's is LEV-237), and skips a write
 * already at the end or one that changed nothing (it hears its own writes twice). Bringing the view here is LEV-66's.
 */
export class WriteRecord {
  private writes: Recorded[] = [];
  private serial = 0;

  /**
   * `write` kept where the record leads to its start: its end, or `shown` (the text last parsed) when it is empty. A
   * write on `shown` while the record ends elsewhere starts the record again: the store wrote it on that text, so the
   * note was put back there and the writes recorded were taken back (LEV-224). Each write is to be recorded once, as
   * the store tells it: the view, which hears its own writes twice, keeps its own record for that (`recordOwn`), and
   * a write already in the record is not told apart here from the same texts written again after a put-back.
   */
  record(write: RecordedWrite, shown: string | undefined): void {
    const last = this.writes[this.writes.length - 1];
    const recorded = { write, serial: this.serial++ };
    if (write.before === (last?.write.after ?? shown)) this.writes.push(recorded);
    else if (write.before === shown) this.writes = [recorded];
  }

  /** Taken as a read begins, for `take` and `spend` to tell the writes recorded while it was under way. */
  mark(): number {
    return this.serial;
  }

  /** How many writes wait for a read; each holds two copies of the note. */
  get size(): number {
    return this.writes.length;
  }

  clear(): void {
    this.writes = [];
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
    const { reaches, led } = this.follow(from?.source, text);
    if (from && reaches > 0) {
      const document = this.parse(from, reaches, basename);
      this.keepFrom(text, mark, reaches);
      return document;
    }
    if (from && text === from.source) {
      this.keepFrom(text, mark, 0);
      return parseMarkdown(text, basename, from);
    }
    const reached = from ? this.parse(from, led, basename) : undefined;
    this.writes = [];
    return parseMarkdown(text, basename, reached);
  }

  /**
   * For a reader that keeps what it shows, by a read begun at `mark` that found `shown`: the writes that lead from it
   * back to it (⌘Z then ⌘⇧Z) spent, and of the rest only those recorded while the read was under way that lead on
   * from it kept, as `take` does.
   */
  spend(shown: string, mark: number): void {
    this.keepFrom(shown, mark, this.follow(shown, shown).reaches);
  }

  /**
   * Of the writes past the first `spent`, only those recorded since `mark` that lead on one from the other from
   * `text`: the first that does not ends them.
   */
  private keepFrom(text: string, mark: number, spent: number): void {
    const kept: Recorded[] = [];
    let at = text;
    for (let index = spent; index < this.writes.length; index += 1) {
      const recorded = this.writes[index]!;
      if (recorded.serial < mark) continue;
      if (recorded.write.before !== at) break;
      kept.push(recorded);
      at = recorded.write.after;
    }
    this.writes = kept;
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
    for (const { write } of this.writes.slice(0, count)) document = parseMarkdown(write.after, basename, document, undefined, write.edits);
    return document;
  }
}
