import { GFM, parser } from '@lezer/markdown';

const inlineParser = parser.configure(GFM);

/** One `<br>` tag as CommonMark reads raw HTML: `<br>`, `<br/>`, `<br />`, any case. */
const BREAK_TAG = /^<br[ \t]*\/?>$/iu;

/** Any line break a draft can hold: typed (Shift+Enter), pasted from another platform, or a Unicode separator. */
const LINE_BREAK = /[ \t]*(?:\r\n?|[\n\u2028\u2029])[ \t]*/gu;

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
      if (node.name !== 'HTMLTag' || !BREAK_TAG.test(title.slice(node.from, node.to))) return true;
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

/** A draft as a title: trimmed, with each line break (and the spaces around it) written as `<br>`. */
function encodedTitle(draft: string): string {
  return draft.trim().replace(LINE_BREAK, '<br>');
}

/** Whether a draft holds a line break (before it is written as `<br>`). */
export function hasLineBreak(draft: string): boolean {
  return /[\r\n\u2028\u2029]/u.test(draft.trim());
}

/**
 * The title to write for `draft`, the text the inline editor holds, over the node's `current` title.
 * A draft that reads as the title already does is the title itself, so confirming an untouched draft
 * rewrites nothing: `<BR/>`, `<br />` and the spaces around a tag stay as the note wrote them
 * (AGENTS.md: 無関係な内容を再シリアライズしない). Any other draft is written with `<br>` for its breaks.
 */
export function storedTitle(draft: string, current: string): string {
  const stored = encodedTitle(draft);
  return stored === encodedTitle(displayTitle(current)) ? current : stored;
}
