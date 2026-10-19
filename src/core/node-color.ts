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

/** The colour a title shows its node in, and how the title writes it. */
export interface TitleColor {
  /** One of the six, or `custom` for a background outside them (`value` holds it). */
  color: NodeColor | 'custom';
  /** The background to draw: the colour's own value, or the custom one as written (a colour, nothing else). */
  value: string;
  /** The text before and after the node's text, as written: the opening and closing tags (`==` and `==` for Obsidian's highlight). */
  open: string;
  close: string;
  /** The node's own text between them. */
  inner: string;
}

const MARK_TAG = /^<\/?mark(?:[\s/][^>]*)?>$/iu;
const OPEN_MARK = /^<mark(?:[\s/][^>]*)?>$/iu;

/**
 * Obsidian's highlight over the whole title (`==text==`): the text neither starts nor ends with a space and holds no
 * `==` of its own, so `==a== b ==c==` is two highlights and no colour of the node.
 */
const HIGHLIGHT = /^==([^\s=](?:(?:(?!==).)*[^\s=])?)==$/u;

/**
 * A colour as a background may be written and the map may draw it: a hex colour, `rgb()`／`hsl()` of numbers, or a
 * colour name. Anything else (`url(…)`, `var(…)`, a keyword that is no colour) is not handed to the style: a note's
 * text must not make the map fetch an address or read the theme's variables.
 */
const COLOR_VALUE = /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|hsl)a?\([\d\s.,%/+-]*(?:deg)?[\d\s.,%/+-]*\)|[a-z]+)$/iu;
const NOT_COLORS = new Set(['inherit', 'initial', 'unset', 'revert', 'none', 'currentcolor', 'auto']);

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

/** The colour a `<mark>` shows: the six by their value, another colour as written, and Obsidian's highlight (yellow) when the style names none the map can draw. */
function markColor(open: string): Pick<TitleColor, 'color' | 'value'> {
  const background = markBackground(open);
  const palette = background === null ? undefined : paletteColor(background);
  if (palette) return { color: palette, value: NODE_COLOR_VALUES[palette] };
  if (background !== null && COLOR_VALUE.test(background) && !NOT_COLORS.has(background.toLowerCase())) return { color: 'custom', value: background };
  return { color: 'yellow', value: NODE_COLOR_VALUES.yellow };
}

/**
 * The colour of a node whose text is `title`, or null when it has none: the title is one `<mark>` from its first
 * character to its last (its own tags, as the Markdown parser reads them — not in code, a link or a comment), or
 * Obsidian's `==highlight==` over all of it (read as yellow; the map writes `<mark>` only). A mark over part of the
 * text (`前半 <mark>後半</mark>`) colours that part as Obsidian does, inside the node's text, and not the node.
 */
export function titleColor(title: string): TitleColor | null {
  if (title.startsWith('==')) {
    const highlight = HIGHLIGHT.exec(title);
    if (highlight) return { color: 'yellow', value: NODE_COLOR_VALUES.yellow, open: '==', close: '==', inner: highlight[1] ?? '' };
    return null;
  }
  if (!/^<mark/iu.test(title) || !/<\/mark\s*>$/iu.test(title)) return null;
  const tags = inlineTags(title, MARK_TAG);
  const first = tags[0];
  if (first?.from !== 0 || !OPEN_MARK.test(title.slice(first.from, first.to))) return null;
  let depth = 0;
  for (const tag of tags) {
    depth += OPEN_MARK.test(title.slice(tag.from, tag.to)) ? 1 : -1;
    if (depth > 0) continue;
    // The first mark closes here: the whole title only if this is its end.
    if (tag.to !== title.length) return null;
    const open = title.slice(0, first.to);
    return { ...markColor(open), open, close: title.slice(tag.from), inner: title.slice(first.to, tag.from) };
  }
  return null;
}

/** The node's text without the colour around it: what the map shows and what a link to a heading names (`#見出し`). */
export function uncoloredTitle(title: string): string {
  return titleColor(title)?.inner ?? title;
}

/** The opening tag the map writes for a colour, as Highlightr's inline style writes it. */
export function colorMark(color: NodeColor): string {
  return `<mark style="background: ${NODE_COLOR_VALUES[color]};">`;
}

/**
 * `title` in `color`, or without a colour for null: the colour around it replaced by the map's own `<mark>` (an
 * `==highlight==` and a mark in another colour included), the text inside kept byte for byte. A title already showing
 * that colour is returned as it is, so choosing the colour a node has writes nothing.
 */
export function recoloredTitle(title: string, color: NodeColor | null): string {
  const current = titleColor(title);
  if ((current?.color ?? null) === color) return title;
  const inner = current?.inner ?? title;
  return color === null ? inner : `${colorMark(color)}${inner}</mark>`;
}

/** `title` with the colour `from` shows its node in, if any: the calling item's colour over the called root's text it shows (§5 M12). */
export function withColorOf(title: string, from: string): string {
  const color = titleColor(from);
  return color ? `${color.open}${uncoloredTitle(title)}${color.close}` : title;
}

/** The text the inline editor holds for a node: its text without the colour, each `<br>` a line break (`displayTitle`). */
export function editableTitle(title: string): string {
  return displayTitle(uncoloredTitle(title));
}

/**
 * The title to write for `draft`, the inline editor's text, over the node's `current` title (`storedTitle`), its colour
 * kept: the tags around the text stay as written, so renaming a coloured node neither drops the colour nor wraps it
 * twice. A draft that would close the colour's mark early or open another `==` over it (it holds `</mark>`, `==`) is
 * refused: the node would lose its colour, or show it on part of its text only.
 */
export function storedColoredTitle(draft: string, current: string): string {
  const color = titleColor(current);
  if (!color) return storedTitle(draft, current);
  const inner = storedTitle(draft, color.inner);
  const stored = `${color.open}${inner}${color.close}`;
  const read = titleColor(stored);
  if (read?.open !== color.open || read.inner !== inner) throw new Error(t().colorMarkInText);
  return stored;
}

/** `hex` (`#RRGGBB` or `#RRGGBBAA`) laid over white, as an opaque `#rrggbb`: the colour as a highlight shows on a white page. */
export function opaqueOverWhite(hex: string): string {
  const digits = /^#([0-9a-f]{6})([0-9a-f]{2})?$/iu.exec(hex);
  if (!digits?.[1]) return hex;
  const alpha = digits[2] === undefined ? 1 : parseInt(digits[2], 16) / 255;
  const channels = [0, 2, 4].map((at) => parseInt(digits[1]!.slice(at, at + 2), 16));
  return `#${channels.map((channel) => Math.round(channel * alpha + 255 * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`;
}
