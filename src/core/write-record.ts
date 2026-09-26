import type { TextEdit } from "./commands";
import { parseMarkdown, type MindDocument } from "./markdown";

/** A write the store made on a note: what it read before, what it wrote, and the edits between (`DocumentStore.onWrite`). */
export interface RecordedWrite {
  readonly before: string;
  readonly after: string;
  readonly edits: readonly TextEdit[];
}

/** A recorded write and its `after` parsed from a document with its edits, kept so a later read does not parse it again. */
interface Entry {
  readonly write: RecordedWrite;
  parsed?: { from: MindDocument; basename: string; document: MindDocument };
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
  private entries: Entry[] = [];

  /** `write` kept where the record leads to its start: its end, or `shown` (the text last parsed) when it is empty. */
  record(write: RecordedWrite, shown: string | undefined): void {
    const last = this.entries[this.entries.length - 1];
    if (write.before !== (last?.write.after ?? shown)) return;
    this.entries.push({ write });
  }

  /** How many writes wait for a read; each holds two copies of the note. */
  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }

  /**
   * `text` parsed from `from`: through the recorded writes up to the one that wrote exactly `text` (those are spent,
   * the rest kept for a later read). When they do not lead there, a parse matched by titles: from `from` for its own
   * text (the note renamed, or a read that came before a write the record already holds, which is kept), else from
   * the last text the writes reached, and the record dropped.
   */
  take(text: string, from: MindDocument | undefined, basename: string): MindDocument {
    let document = from;
    for (const [index, entry] of this.entries.entries()) {
      if (!document || document.source !== entry.write.before) break;
      document = this.parse(entry, document, basename);
      if (entry.write.after !== text) continue;
      this.entries = this.entries.slice(index + 1);
      return document;
    }
    if (from && text === from.source) return parseMarkdown(text, basename, from);
    this.entries = [];
    return parseMarkdown(text, basename, document);
  }

  /**
   * The writes that lead from `shown` back to it (⌘Z then ⌘⇧Z) spent, for a reader that keeps what it shows. Only the
   * texts are followed; nothing is parsed.
   */
  spend(shown: string): void {
    let at = shown;
    let spent = 0;
    for (const [index, entry] of this.entries.entries()) {
      if (entry.write.before !== at) break;
      at = entry.write.after;
      if (at === shown) spent = index + 1;
    }
    this.entries = this.entries.slice(spent);
  }

  /** `entry`'s text parsed from `from` with its edits, once per base document. */
  private parse(entry: Entry, from: MindDocument, basename: string): MindDocument {
    if (entry.parsed?.from !== from || entry.parsed.basename !== basename) {
      entry.parsed = { from, basename, document: parseMarkdown(entry.write.after, basename, from, undefined, entry.write.edits) };
    }
    return entry.parsed.document;
  }
}
