import type { TextEdit } from "./commands";
import { parseMarkdown, type MindDocument } from "./markdown";

/** A write the store made on a note: what it read before, what it wrote, and the edits between (`DocumentStore.onWrite`). */
export interface RecordedWrite {
  readonly before: string;
  readonly after: string;
  readonly edits: readonly TextEdit[];
}

/**
 * The writes the store made on a note since a reader of it last parsed it, in order, so the next parse carries every
 * node's id over with their edits: nothing else carries a node whose title repeats or is empty (LEV-146). A text they
 * do not lead to — someone else wrote (E05) — is matched by titles alone, from the last text they reached.
 *
 * Used by a map embedded in another note (`MapEmbed`, LEV-217). `MindmapView` keeps its own record (`ownWrites`,
 * LEV-150) on the same idea, but not the same rules: it skips a write already at the end (it records its own writes
 * twice), and drops the record on any read the writes do not lead to, a read of the text on screen included. Bringing
 * the view here is LEV-66's.
 */
export class WriteRecord {
  private writes: RecordedWrite[] = [];

  /** `write` kept where the record leads to its start: its end, or `shown` (the text last parsed) when it is empty. */
  record(write: RecordedWrite, shown: string | undefined): void {
    const last = this.writes[this.writes.length - 1];
    if (write.before !== (last?.after ?? shown)) return;
    this.writes.push(write);
  }

  /** How many writes wait for a read; each holds two copies of the note. */
  get size(): number {
    return this.writes.length;
  }

  clear(): void {
    this.writes = [];
  }

  /**
   * `text` parsed from `from`: through the recorded writes up to the last one that wrote exactly `text` (those are
   * spent — ⌘Z then ⌘⇧Z behind it included — the rest kept for a later read). When they do not lead there, a parse
   * matched by titles: from `from` for its own text (the note renamed, or a read that came before a write the record
   * already holds, which is kept), else from the last text the writes reached, and the record dropped. The writes are
   * parsed only once the texts show where they lead.
   */
  take(text: string, from: MindDocument | undefined, basename: string): MindDocument {
    const { reaches, led } = this.follow(from?.source, text);
    if (from && reaches > 0) {
      const document = this.parse(from, reaches, basename);
      this.writes = this.writes.slice(reaches);
      return document;
    }
    if (from && text === from.source) return parseMarkdown(text, basename, from);
    const reached = from ? this.parse(from, led, basename) : undefined;
    this.writes = [];
    return parseMarkdown(text, basename, reached);
  }

  /** The writes that lead from `shown` back to it (⌘Z then ⌘⇧Z) spent, for a reader that keeps what it shows. */
  spend(shown: string): void {
    this.writes = this.writes.slice(this.follow(shown, shown).reaches);
  }

  /**
   * How far the writes lead from `start`, by their texts alone: `led` writes follow one another from it, and the
   * `reaches` first of them end on `text` (0 when none does).
   */
  private follow(start: string | undefined, text: string): { reaches: number; led: number } {
    let at = start;
    let reaches = 0;
    let led = 0;
    for (const write of this.writes) {
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
    for (const write of this.writes.slice(0, count)) document = parseMarkdown(write.after, basename, document, undefined, write.edits);
    return document;
  }
}
