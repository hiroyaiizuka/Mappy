import { GFM, parser } from '@lezer/markdown';

/** The inline Markdown parser node titles are read with (`plainTitle` shares it). */
export const inlineParser = parser.configure(GFM);

/** One `<br>` tag as CommonMark reads raw HTML: `<br>`, `<br/>`, `<br />`, any case. */
const BREAK_TAG = /^<br[ \t]*\/?>$/iu;

/** Any line break a draft can hold: typed (Shift+Enter), pasted from another platform, or a Unicode separator. */
const LINE_BREAK = /[ \t]*(?:\r\n?|[\n\u2028\u2029])[ \t]*/gu;

/** Whether an `HTMLTag` of the inline parser is a line break (`plainTitle` reads it as one too). */
export function isBreakTag(tag: string): boolean {
  return BREAK_TAG.test(tag);
}

/**
 * The line breaks written into a node's title (LEV-202). A heading or a list item is one line of Markdown,
 * so a break inside a node is stored as a `<br>` tag in that line, which Obsidian's reading view, live
 * preview and other tools show as a break too. Only a tag the Markdown parser reads as raw HTML is one:
 * `<br>` in inline code or after a backslash is text. The spaces around a tag are not shown either side
 * of the break, so they go with it.
 */
function breakRanges(title: string): { from: number; to: number }[] {
  if (!/<br/iu.test(title)) return [];
  const ranges: { from: number; to: number }[] = [];
  inlineParser.parse(title).iterate({
    enter(node) {
      if (node.name !== 'HTMLTag' || !isBreakTag(title.slice(node.from, node.to))) return true;
      let from = node.from;
      let to = node.to;
      while (from > 0 && /[ \t]/u.test(title.charAt(from - 1))) from--;
      while (to < title.length && /[ \t]/u.test(title.charAt(to))) to++;
      ranges.push({ from, to });
      return false;
    },
  });
  return ranges;
}

/** A title as the node shows it and the inline editor edits it: each `<br>` is a line break. */
export function displayTitle(title: string): string {
  const ranges = breakRanges(title);
  if (ranges.length === 0) return title;
  let text = '';
  let cursor = 0;
  for (const range of ranges) {
    // Two tags can share the spaces between them: the second starts where the first ended.
    text += title.slice(cursor, Math.max(cursor, range.from)) + '\n';
    cursor = Math.max(cursor, range.to);
  }
  return text + title.slice(cursor);
}

/** A draft's lines: trimmed, split at each line break (the spaces around it go with the break). */
function draftLines(draft: string): string[] {
  return draft.trim().split(LINE_BREAK);
}

/** Whether a draft holds a line break (before it is written as `<br>`). */
export function hasLineBreak(draft: string): boolean {
  return draftLines(draft).length > 1;
}

/**
 * The title to write for `draft`, the text the inline editor holds, over the node's `current` title.
 *
 * A draft that reads as the title already does is the title itself, so confirming an untouched draft
 * rewrites nothing. Otherwise each break is written as a tag: while the draft has as many breaks as the
 * title has tags, each keeps the tag it came from as the note wrote it (`<BR/>`, `<br />`, the spaces
 * around), so changing one line rewrites only that line (AGENTS.md: 無関係な内容を再シリアライズしない);
 * with a break added or removed, the breaks cannot be told apart and every one is written as `<br>`.
 *
 * A break where a tag would not be read as one — right after a backslash, inside inline code, a link's
 * target — would be saved as the text `<br>`, and is refused instead (the draft stays with its reason).
 */
export function storedTitle(draft: string, current: string): string {
  const lines = draftLines(draft);
  const plain = lines.join('\n');
  if (plain === draftLines(displayTitle(current)).join('\n')) return current;
  const ranges = breakRanges(current);
  const tags = ranges.length === lines.length - 1 ? ranges.map((range) => current.slice(range.from, range.to)) : [];
  let stored = lines[0] ?? '';
  const inserted: { from: number; to: number }[] = [];
  lines.slice(1).forEach((line, index) => {
    const tag = tags[index] ?? '<br>';
    inserted.push({ from: stored.length, to: stored.length + tag.length });
    stored += tag + line;
  });
  const read = breakRanges(stored);
  if (!inserted.every((tag) => read.some((range) => range.from <= tag.from && tag.to <= range.to))) {
    throw new Error('この位置では改行できません（インラインコードの中や \\ の直後など）。改行を外すか、Markdown 側で編集してください。');
  }
  return stored;
}
