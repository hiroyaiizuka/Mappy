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
 * LEV-150) with the same rules; bringing it here is LEV-66's.
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
   * `text` parsed from `from`: through the recorded writes up to the one that wrote exactly `text` (those are spent,
   * the rest kept for a later read). When they do not lead there, a parse matched by titles: from `from` for its own
   * text (the note renamed, or a read that came before a write the record already holds, which is kept), else from
   * the last text the writes reached, and the record dropped.
   */
  take(text: string, from: MindDocument | undefined, basename: string): MindDocument {
    const led = this.lead(text, from, basename);
    if ("document" in led) return led.document;
    if (from && text === from.source) return parseMarkdown(text, basename, from);
    this.writes = [];
    return parseMarkdown(text, basename, led.reached);
  }

  /** The writes that lead from `from` back to its own text (⌘Z then ⌘⇧Z) spent, for a reader that keeps `from`. */
  spend(text: string, from: MindDocument | undefined, basename: string): void {
    this.lead(text, from, basename);
  }

  /** The parse of `text` through the writes, spending them, or the last parse they reached. */
  private lead(text: string, from: MindDocument | undefined, basename: string): { document: MindDocument } | { reached: MindDocument | undefined } {
    let document = from;
    for (const [index, write] of this.writes.entries()) {
      if (!document || document.source !== write.before) break;
      document = parseMarkdown(write.after, basename, document, undefined, write.edits);
      if (write.after !== text) continue;
      this.writes = this.writes.slice(index + 1);
      return { document };
    }
    return { reached: document };
  }
}
