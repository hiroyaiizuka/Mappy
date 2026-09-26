import { GFM, parser } from '@lezer/markdown';

/** The inline Markdown parser node titles are read with (`plainTitle` shares it). */
export const inlineParser = parser.configure(GFM);

/** One `<br>` tag as CommonMark reads raw HTML: `<br>`, `<br/>`, `<br />`, any case, with attributes (`<br class="x">`). */
const BREAK_TAG = /^<br(?:[ \t][^>]*)?\/?>$/iu;

/** Any line break a draft can hold: typed (Shift+Enter), pasted from another platform, or a Unicode separator. */
const LINE_BREAK = /[ \t]*(?:\r\n?|[\n\u2028\u2029])[ \t]*/gu;

/**
 * What a title is read inside: the inline content of a heading or a list item, never a block of its own. A
 * title parsed alone would start an HTML block (`<div>…`), a fence or a link reference definition and lose
 * its inline syntax; after this lead it is a paragraph's text. Offsets are the title's plus its length.
 */
const INLINE_LEAD = 'x ';

/**
 * Obsidian's own inline syntax the Markdown parser does not know: a wiki link or embed (`[[…]]`,
 * `![[…]]`), a comment (`%%…%%`, hidden) and inline math (`$…$`). Nothing inside is Markdown, so a `<br>`
 * there is not a break on screen.
 */
const OBSIDIAN_SPANS = /%%.*?%%|!?\[\[[^\]\r\n]*?\]\]|\$(?=\S)[^$\r\n]*?\S\$|\$[^\s$]\$/gu;

/**
 * The line breaks written into a node's title (LEV-202). A heading or a list item is one line of Markdown,
 * so a break inside a node is stored as a `<br>` tag in that line, which Obsidian's reading view, live
 * preview and other tools show as a break too. Only a tag the Markdown parser reads as raw HTML is one:
 * `<br>` in inline code, after a backslash, in a wiki link or in math is text. The spaces around a tag are
 * not shown either side of the break, so they go with it; two tags share none (the first takes them).
 */
export function breakRanges(title: string): { from: number; to: number }[] {
  if (!/<br/iu.test(title)) return [];
  const spans = Array.from(title.matchAll(OBSIDIAN_SPANS), (match) => ({ from: match.index, to: match.index + match[0].length }));
  const tags: { from: number; to: number }[] = [];
  inlineParser.parse(INLINE_LEAD + title).iterate({
    enter(node) {
      const from = node.from - INLINE_LEAD.length;
      const to = node.to - INLINE_LEAD.length;
      if (node.name !== 'HTMLTag' || from < 0 || !BREAK_TAG.test(title.slice(from, to))) return true;
      if (!spans.some((span) => span.from <= from && to <= span.to)) tags.push({ from, to });
      return false;
    },
  });
  const ranges: { from: number; to: number }[] = [];
  tags.forEach((tag, index) => {
    let { from, to } = tag;
    const floor = ranges[ranges.length - 1]?.to ?? 0;
    const ceiling = tags[index + 1]?.from ?? title.length;
    while (from > floor && /[ \t]/u.test(title.charAt(from - 1))) from--;
    while (to < ceiling && /[ \t]/u.test(title.charAt(to))) to++;
    ranges.push({ from, to });
  });
  return ranges;
}

/**
 * Every break of `title` as written: its `<br>` tags (`breakRanges`) and, in a multi-line Setext heading (the only
 * title that spans lines), its own line breaks with the spaces around them (the next line's indent included).
 */
function titleBreaks(title: string): { from: number; to: number }[] {
  const tags = breakRanges(title);
  if (!/[\r\n]/u.test(title)) return tags;
  const lines = Array.from(title.matchAll(/[ \t]*\r?\n[ \t]*/gu), (match) => ({ from: match.index, to: match.index + match[0].length }));
  // A tag at the end of a line has taken the spaces before the line break already.
  const merged = [...tags, ...lines].sort((left, right) => left.from - right.from);
  const ranges: { from: number; to: number }[] = [];
  for (const range of merged) {
    const previous = ranges[ranges.length - 1];
    ranges.push(previous && range.from < previous.to ? { from: previous.to, to: Math.max(previous.to, range.to) } : range);
  }
  return ranges;
}

/** A title as the node shows it and the inline editor edits it: each `<br>` (and each line of a Setext heading) is a line break. */
export function displayTitle(title: string): string {
  return displayed(title, titleBreaks(title));
}

function displayed(title: string, ranges: readonly { from: number; to: number }[]): string {
  if (ranges.length === 0) return title;
  let text = '';
  let cursor = 0;
  for (const range of ranges) {
    text += title.slice(cursor, range.from) + '\n';
    cursor = range.to;
  }
  return text + title.slice(cursor);
}

/**
 * A draft's lines, split at each line break (the spaces around it go with the break). The spaces at either end
 * are trimmed, as a title's are; so are the breaks, a pasted line's last one included, unless the title as it
 * reads already starts (`keep.lead`) or ends (`keep.trail`) with one: a `<br>` the note wrote there stays.
 */
function draftLines(draft: string, keep = { lead: false, trail: false }): string[] {
  let text = draft.replace(/^[ \t]+|[ \t]+$/gu, '');
  if (!keep.lead) text = text.replace(/^\s+/u, '');
  if (!keep.trail) text = text.replace(/\s+$/u, '');
  return text.split(LINE_BREAK);
}

/**
 * The title to write for `draft`, the text the inline editor holds, over the node's `current` title.
 *
 * A draft that reads as the title already does is the title itself, so confirming an untouched draft
 * rewrites nothing. Otherwise each break is written again: while the draft has as many breaks as the title,
 * each keeps the break it came from as the note wrote it (`<BR/>`, `<br />`, the spaces around, a Setext
 * heading's own line and its indent), so changing one line rewrites only that line (AGENTS.md: 無関係な内容を
 * 再シリアライズしない); with a break added or removed, the breaks cannot be told apart and every one is written
 * as `<br>`. A multi-line Setext heading's own lines become `<br>` too, so it is written as one line (rename in
 * `commands.ts` says why).
 *
 * A `<br>` where a tag would not be read as one — right after a backslash, inside inline code, a link's
 * target, a wiki link or math — would be saved as the text `<br>`, and is refused instead (the draft stays
 * with its reason).
 */
export function storedTitle(draft: string, current: string): string {
  const ranges = titleBreaks(current);
  const shown = displayed(current, ranges);
  const keep = { lead: /^[ \t]*\n/u.test(shown), trail: /\n[ \t]*$/u.test(shown) };
  const lines = draftLines(draft, keep);
  if (lines.join('\n') === draftLines(shown, keep).join('\n')) return current;
  const kept = ranges.length === lines.length - 1 ? ranges.map((range) => current.slice(range.from, range.to)) : [];
  let stored = lines[0] ?? '';
  const inserted: { from: number; to: number }[] = [];
  lines.slice(1).forEach((line, index) => {
    const own = kept[index];
    const separator = own !== undefined && !/[\r\n]/u.test(own) ? own : '<br>';
    inserted.push({ from: stored.length, to: stored.length + separator.length });
    stored += separator + line;
  });
  const read = breakRanges(stored);
  if (!inserted.every((tag) => read.some((range) => range.from <= tag.from && tag.to <= range.to))) {
    throw new Error('この位置では改行できません（インラインコード・リンク・数式の中や \\ の直後など）。改行を外すか、Markdown 側で編集してください。');
  }
  return stored;
}
