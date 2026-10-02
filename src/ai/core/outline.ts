import type { AiResult, OutlineItem } from '../contract';

/**
 * Reading the model's answer leniently (docs/architecture.md §11.4): fences are stripped, lines that are not list
 * items are dropped and counted, indentation is rounded to levels by its smallest step, items deeper than `depth`
 * are lifted to the last allowed level, and each item's text is made safe to write as one node: whatever would read
 * as block syntax at the start of a line is escaped, and the comment openers that hide what follows them wherever
 * they stand (`%%`, `<!--`) are neutralized.
 */

const FENCE = /^\s*(?:```|~~~)/u;
const ITEM = /^([ \t]*)(?:[-*+]|\d+\.)(?:[ \t]+(.*))?$/u;
const REFUSAL = /^(?:取得できませんでした|Could not retrieve)\s*[:：]\s*(.*)$/iu;

/** Columns of leading whitespace, a tab advancing to the next multiple of 4 (CommonMark's tab stop). */
function columns(indent: string): number {
  let column = 0;
  for (const char of indent) column = char === '\t' ? column + 4 - (column % 4) : column + 1;
  return column;
}

/**
 * The text with what Markdown would read as block syntax at the start of a line made literal, so the item stays one
 * node with this title when it is written as a list item or a heading and parsed again.
 */
export function neutralizeItemText(text: string): string {
  let result = text
    // Anywhere on the line, these hide every node until their closing mark.
    .replace(/%%/gu, '\\%\\%')
    .replace(/<!--/gu, '&lt;!--');
  // A line of only -, * or _ (a thematic break; with = also a Setext underline): escape its first character.
  if (/^(?:[-*_][ \t]*){3,}$/u.test(result) || /^=+[ \t]*$/u.test(result)) return `\\${result}`;
  // A list marker inside the item (`- - point`, `- 1. background`): the item would become a list of its own.
  const ordered = result.match(/^(\d{1,9})([.)])(?=[ \t]|$)/u);
  if (ordered) result = `${ordered[1] ?? ''}\\${result.slice((ordered[1] ?? '').length)}`;
  else if (/^[-*+](?=[ \t]|$)/u.test(result)) result = `\\${result}`;
  // Headings, quotes, fences, math blocks, HTML, and link reference definitions (`[03:15]: intro`).
  else if (/^(?:#|>|```|~~~|\$\$|<)/u.test(result) || /^\[[^\]]*\]:/u.test(result)) result = `\\${result}`;
  // An ATX heading drops a trailing run of # after a space as its closing sequence.
  return result.replace(/([ \t])(#+)[ \t]*$/u, (_match, space: string, hashes: string) => `${space}${hashes.replace(/#/gu, '\\#')}`);
}

interface Line { indent: number; text: string }

function build(lines: readonly Line[], depth: number): OutlineItem[] {
  const positive = lines.map(line => line.indent).filter(indent => indent > 0);
  const unit = positive.length > 0 ? Math.min(...positive) : 1;
  const roots: OutlineItem[] = [];
  const stack: OutlineItem[] = [];
  for (const line of lines) {
    // Never more than one level below the item before it, never deeper than `depth`.
    const level = Math.min(Math.round(line.indent / unit), stack.length, depth - 1);
    const item: OutlineItem = { text: line.text, children: [] };
    stack.length = level;
    const parent = stack[level - 1];
    (parent ? parent.children : roots).push(item);
    stack.push(item);
  }
  return roots;
}

/** The list items of `raw` (the model's final text) and how many other non-blank lines were left out. */
export function parseOutline(raw: string, depth: number): { items: OutlineItem[]; dropped: number } {
  let dropped = 0;
  const lines: Line[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (FENCE.test(line) || line.trim() === '') continue;
    const item = line.match(ITEM);
    if (!item) { dropped++; continue; }
    const text = (item[2] ?? '').trim();
    if (!text) continue;
    lines.push({ indent: columns(item[1] ?? ''), text });
  }
  return { items: build(lines.map(line => ({ ...line, text: neutralizeItemText(line.text) })), Math.max(1, depth)), dropped };
}

/** The runner's result for a final text: an outline, a refusal (the one-line 「取得できませんでした: …」), or unparsable. */
export function outlineResult(raw: string, depth: number): AiResult {
  const { items, dropped } = parseOutline(raw, depth);
  const [only] = items;
  if (items.length === 1 && only) {
    // The refusal is matched on the text before it was escaped (neutralizing leaves this shape alone anyway).
    const refusal = only.text.match(REFUSAL);
    if (refusal) return { kind: 'refused', reason: (refusal[1] ?? '').trim(), raw };
  }
  if (items.length === 0) return { kind: 'failed', reason: 'unparsable', detail: raw };
  return { kind: 'outline', items, dropped, raw };
}
