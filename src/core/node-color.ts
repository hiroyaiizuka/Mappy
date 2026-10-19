import { displayTitle, inlineTags, storedTitle } from './title-breaks';
import { t } from '../i18n';

/**
 * A node's colour (LEV-364, the person's decision of 2026-10-19, 「ノードの色の判断: 1=A」): the node's text wrapped
 * whole in a `<mark>` whose inline style names the background, as the Highlightr plugin writes it
 * (`<mark style="background: #FFF3A3A6;">…</mark>`), so the note shows the same colour as a highlighter in Markdown
 * too. Nothing else is stored: the colour is in the text of the heading or the item, and goes wherever the text goes.
 */

/** The six colours the map offers, in the menu's order; their values are Highlightr's defaults. */
export const NODE_COLORS = ['yellow', 'orange', 'red', 'green', 'blue', 'purple'] as const;
export type NodeColor = (typeof NODE_COLORS)[number];

/** What a colour is written as (`colorMark`). The map draws the dark theme with colours of its own (styles.css). */
export const NODE_COLOR_VALUES: Readonly<Record<NodeColor, string>> = {
  yellow: '#FFF3A3A6',
  orange: '#FFB86CA6',
  red: '#FF5582A6',
  green: '#BBFABBA6',
  blue: '#ADCCFFA6',
  purple: '#D2B3FFA6',
};

/** The text key of each colour's name; the Record type turns a new colour into a compile error until it is named. */
const COLOR_LABEL_KEYS: Record<NodeColor, `color${Capitalize<NodeColor>}`> = {
  yellow: 'colorYellow', orange: 'colorOrange', red: 'colorRed', green: 'colorGreen', blue: 'colorBlue', purple: 'colorPurple',
};

/** The name a colour goes by in the menu and the commands, in the app's language (read when shown, as `layoutLabel` is). */
export function colorLabel(color: NodeColor | null): string {
  return color === null ? t().colorNone : t()[COLOR_LABEL_KEYS[color]];
}

/** The colour a title shows its node in, and how the title writes it: `open + inner + close + suffix` is the title. */
export interface TitleColor {
  /**
   * One of the six (Obsidian's own highlight, `==…==` or a `<mark>` naming no background, reads as yellow), or `custom`
   * for any other background the mark names: none of the menu's colours is the node's, and choosing one writes it.
   */
  color: NodeColor | 'custom';
  /**
   * The background to draw: the colour's own value, a custom one as written when it is a colour the map may hand to the
   * style, else Obsidian's highlight yellow.
   */
  value: string;
  /** The text before and after the node's text, as written: the opening and closing tags (`==` and `==` for Obsidian's highlight). */
  open: string;
  close: string;
  /** The node's own text between them. */
  inner: string;
  /** A block id ending the line (` ^id`), which stays outside the colour so links to the block keep reaching it; '' when none. */
  suffix: string;
}

/** A `<mark>` tag, opening or closing, as the Markdown parser reads raw HTML (`plainTitle` drops the same tags). */
export const MARK_TAG = /^<\/?mark(?:[\s/][^>]*)?>$/iu;
const OPEN_MARK = /^<mark(?:[\s/][^>]*)?>$/iu;

/**
 * Obsidian's block id at the end of a line (` ^id`, as `locateSubpath` reads it): kept after the colour, never inside
 * it, or `[[note#^id]]` would no longer find the line's end.
 */
const BLOCK_ID = /\s+\^[A-Za-z0-9-]+$/u;

/**
 * Obsidian's highlight over the whole text (`==text==`): the text neither starts nor ends with a space or `=`, holds no
 * `==` of its own (`==a== b ==c==` is two highlights) and does not end in an odd run of backslashes (`==a\==` escapes
 * its closing `=` and is no highlight).
 */
const HIGHLIGHT = /^==([^\s=](?:(?:(?!==).)*[^\s=])?)==$/u;

/**
 * A colour as a background may be written and the map may draw it: a hex colour, or `rgb()`／`hsl()` of numbers. Anything
 * else (a word, `url(…)`, `var(…)`) is not handed to the style: a note's text must not make the map fetch an address
 * or read the theme's variables, and a value the browser would refuse would leave the box with no fill at all.
 */
const ALPHA = String.raw`(?:\s*[,/]\s*(?:\d*\.?\d+%?))?`;
const COLOR_VALUE = new RegExp([
  String.raw`^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$`,
  String.raw`^rgba?\(\s*\d{1,3}%?(?:\s*,\s*|\s+)\d{1,3}%?(?:\s*,\s*|\s+)\d{1,3}%?${ALPHA}\s*\)$`,
  String.raw`^hsla?\(\s*\d*\.?\d+(?:deg)?(?:\s*,\s*|\s+)\d*\.?\d+%(?:\s*,\s*|\s+)\d*\.?\d+%${ALPHA}\s*\)$`,
].join('|'), 'iu');

/** The background an opening `<mark>` tag's inline style names, or null. */
function markBackground(open: string): string | null {
  const style = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu.exec(open);
  const declarations = (style?.[1] ?? style?.[2] ?? style?.[3] ?? '').split(';');
  let background: string | null = null;
  for (const declaration of declarations) {
    const match = /^\s*background(?:-color)?\s*:\s*(.*?)\s*(?:!\s*important\s*)?$/iu.exec(declaration);
    if (match?.[1]) background = match[1];
  }
  return background;
}

/** Which of the six a background is, its alpha aside (`#FFF3A3` reads as yellow), else undefined. */
function paletteColor(value: string): NodeColor | undefined {
  const hex = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/iu.exec(value)?.[1]?.toUpperCase();
  return hex === undefined ? undefined : NODE_COLORS.find((color) => NODE_COLOR_VALUES[color].slice(1, 7) === hex);
}

/**
 * The colour a `<mark>` shows: the six by their value; Obsidian's highlight (yellow) when the style names no background;
 * any other background `custom`, drawn as written when the map may hand it to the style and as the highlight's yellow
 * when not (a word, `var(…)`, `url(…)`: code review 2 — the menu then marks none of its colours, so choosing one,
 * yellow included, writes the map's own mark).
 */
function markColor(open: string): Pick<TitleColor, 'color' | 'value'> {
  const background = markBackground(open);
  if (background === null) return { color: 'yellow', value: NODE_COLOR_VALUES.yellow };
  const palette = paletteColor(background);
  if (palette) return { color: palette, value: NODE_COLOR_VALUES[palette] };
  return { color: 'custom', value: COLOR_VALUE.test(background) ? background : NODE_COLOR_VALUES.yellow };
}

/** `title` without a block id ending it (`body`), and that id with the space before it (`suffix`, '' when none). */
function splitBlockId(title: string): { body: string; suffix: string } {
  const suffix = BLOCK_ID.exec(title)?.[0] ?? '';
  return { body: title.slice(0, title.length - suffix.length), suffix };
}

/** The colour of a title with no block id: one `<mark>` from its first character to its last, or `==…==` over all of it. */
function bodyColor(body: string): Omit<TitleColor, 'suffix'> | null {
  if (body.startsWith('==')) {
    const highlight = HIGHLIGHT.exec(body);
    const inner = highlight?.[1];
    if (inner === undefined || (/\\+$/u.exec(inner)?.[0].length ?? 0) % 2 === 1) return null;
    return { color: 'yellow', value: NODE_COLOR_VALUES.yellow, open: '==', close: '==', inner };
  }
  if (!/^<mark/iu.test(body) || !/<\/mark\s*>$/iu.test(body)) return null;
  const tags = inlineTags(body, MARK_TAG);
  const first = tags[0];
  if (first?.from !== 0 || !OPEN_MARK.test(body.slice(first.from, first.to))) return null;
  let depth = 0;
  for (const tag of tags) {
    depth += OPEN_MARK.test(body.slice(tag.from, tag.to)) ? 1 : -1;
    if (depth > 0) continue;
    // The first mark closes here: the whole text only if this is its end.
    if (tag.to !== body.length) return null;
    const open = body.slice(0, first.to);
    return { ...markColor(open), open, close: body.slice(tag.from), inner: body.slice(first.to, tag.from) };
  }
  return null;
}

/**
 * The colour of a node whose text is `title`, or null when it has none: the title is one `<mark>` from its first
 * character to its last (its own tags, as the Markdown parser reads them — not in code, a link or a comment), or
 * Obsidian's `==highlight==` over all of it (read as yellow; the map writes `<mark>` only), a block id after it aside.
 * A mark over part of the text (`前半 <mark>後半</mark>`) colours that part as Obsidian does, inside the node's text,
 * and not the node.
 */
export function titleColor(title: string): TitleColor | null {
  const { body, suffix } = splitBlockId(title);
  const color = bodyColor(body);
  return color ? { ...color, suffix } : null;
}

/**
 * The node's text without the colour around it, a block id after the colour kept as an uncoloured title has it: what the
 * map shows and the inline editor holds, and what a link to a heading names (`#見出し`).
 */
export function uncoloredTitle(title: string): string {
  const color = titleColor(title);
  return color ? color.inner + color.suffix : title;
}

/** The opening tag the map writes for a background, as Highlightr's inline style writes it. */
function markOpen(value: string): string {
  return `<mark style="background: ${value};">`;
}

/** The opening tag the map writes for a colour. */
export function colorMark(color: NodeColor): string {
  return markOpen(NODE_COLOR_VALUES[color]);
}

/**
 * `title` in `color`, or without a colour for null: the colour around it replaced by the map's own `<mark>` (an
 * `==highlight==` and a mark in another colour included), the text inside kept byte for byte and a block id ending the
 * line left after it. A title already showing that colour is returned as it is, so choosing the colour a node has
 * writes nothing.
 */
export function recoloredTitle(title: string, color: NodeColor | null): string {
  const current = titleColor(title);
  if ((current?.color ?? null) === color) return title;
  const { body, suffix } = current ? { body: current.inner, suffix: current.suffix } : splitBlockId(title);
  return color === null ? body + suffix : `${colorMark(color)}${body}</mark>${suffix}`;
}

/**
 * `text` wrapped in the colour `from` shows, written as `from` writes it when that reads back, else as the map's own
 * `<mark>` for that colour, else as `text` alone. `text` holds no colour of its own here.
 */
function wrapped(text: string, from: TitleColor): string | null {
  for (const [open, close] of [[from.open, from.close], [markOpen(from.value), '</mark>']] as const) {
    const title = `${open}${text}${close}`;
    const read = titleColor(title);
    if (read?.inner === text && read.suffix === '') return title;
  }
  return null;
}

/**
 * The called root's text the calling item shows (§5 M12), in the item's colour: the item is the host's own node, so it
 * shows the colour it has and the menu can change, and none when it has none (the called map's colour of its root stays
 * in that map).
 */
export function withColorOf(title: string, from: string): string {
  const text = titleColor(title)?.inner ?? title;
  const color = titleColor(from);
  return (color && wrapped(text, color)) ?? text;
}

/**
 * The text the inline editor holds for a node: its text without the colour (a block id after it shown, as on an
 * uncoloured node), each `<br>` a line break (`displayTitle`).
 */
export function editableTitle(title: string): string {
  return displayTitle(uncoloredTitle(title));
}

/**
 * The title to write for `draft`, the inline editor's text, over the node's `current` title (`storedTitle`), its colour
 * kept: the tags around the text stay as written, and a block id the draft ends with goes after them, so renaming a
 * coloured node neither drops the colour nor wraps it twice. A highlight the draft cannot be written inside (emptied,
 * ending in `=`, holding `==`) is written as the map's own yellow `<mark>` instead. A draft that would close the
 * colour's `<mark>` early or leave one of its own open is refused: the node would lose its colour, or show it on part
 * of its text only.
 */
export function storedColoredTitle(draft: string, current: string): string {
  const color = titleColor(current);
  if (!color) return storedTitle(draft, current);
  const shown = color.inner + color.suffix;
  const written = storedTitle(draft, shown);
  // The draft as the node already reads: nothing to write, wherever a block id-like ending stands now.
  if (written === shown) return current;
  const { body, suffix } = splitBlockId(written);
  const stored = wrapped(body, color);
  if (stored === null) throw new Error(t().colorMarkInText);
  return stored + suffix;
}

/** `hex` (`#RRGGBB` or `#RRGGBBAA`) laid over white, as an opaque `#rrggbb`: the colour as a highlight shows on a white page. */
export function opaqueOverWhite(hex: string): string {
  const digits = /^#([0-9a-f]{6})([0-9a-f]{2})?$/iu.exec(hex);
  if (!digits?.[1]) return hex;
  const alpha = digits[2] === undefined ? 1 : parseInt(digits[2], 16) / 255;
  const channels = [0, 2, 4].map((at) => parseInt(digits[1]!.slice(at, at + 2), 16));
  return `#${channels.map((channel) => Math.round(channel * alpha + 255 * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`;
}
