import { parser } from '@lezer/markdown';

/** Blocks the parser reads as literal text: nothing inside them is a heading or carries a block id. */
const LITERAL = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'Comment', 'CommentBlock']);

/**
 * Obsidian's normalisation of a heading before it is compared with a link's segment (app.js 1.14.2,
 * `resolveSubpath`): punctuation becomes a space, runs of whitespace collapse, the comparison ignores case.
 */
function normalizeHeading(text: string): string {
  return text.replace(/[!"#$%&()*+,.:;<=>?@^`{|}~/[\]\\\r\n]/gu, ' ').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function lineStart(source: string, offset: number): number {
  return source.lastIndexOf('\n', offset - 1) + 1;
}

/**
 * Where a link's `#…` part points in a note, by the rules of Obsidian 1.14.2's `resolveSubpath` (app.js) read
 * off the source instead of the metadata cache, so the map — and the browser harness, which has no cache — can
 * follow a link handed to the view as its `subpath` (LEV-74, E06). `#A#B` walks the headings in order: each
 * segment takes the next heading deeper than the last match whose normalised text equals it; the offset is the
 * start of the last matched heading's line. `#^id` is the block whose line ends with ` ^id` (case-insensitive);
 * the offset is the start of that line, which is inside the block. Headings and ids inside code, HTML and
 * comments do not count. Footnotes (`#[^…]`) and a subpath nothing matches are null.
 */
export function locateSubpath(source: string, subpath: string): number | null {
  const segments = subpath.split('#').filter(Boolean);
  const first = segments[0];
  if (first === undefined) return null;
  if (segments.length === 1 && first.startsWith('[^')) return null;
  const literals: { from: number; to: number }[] = [];
  const headings: { level: number; text: string; from: number }[] = [];
  parser.parse(source).iterate({
    enter(node) {
      if (LITERAL.has(node.name)) { literals.push({ from: node.from, to: node.to }); return false; }
      const match = node.name.match(/^(ATX|Setext)Heading([1-6])$/u);
      if (!match) return true;
      const marks = node.node.getChildren('HeaderMark');
      const mark = marks[0];
      if (!mark) return false;
      const text = match[1] === 'ATX'
        ? source.slice(mark.to, marks[1]?.from ?? node.to)
        : source.slice(node.from, lineStart(source, mark.from));
      headings.push({ level: Number(match[2]), text, from: lineStart(source, node.from) });
      return false;
    },
  });
  if (segments.length === 1 && first.startsWith('^')) {
    const wanted = first.slice(1).toLowerCase();
    if (!wanted) return null;
    let offset = 0;
    for (const line of source.split('\n')) {
      const id = line.match(/(?:^|\s)\^([A-Za-z0-9-]+)[ \t]*\r?$/u)?.[1];
      const inLiteral = literals.some(range => range.from <= offset && offset < range.to);
      if (id !== undefined && id.toLowerCase() === wanted && !inLiteral) return offset;
      offset += line.length + 1;
    }
    return null;
  }
  let index = 0;
  let level = 0;
  for (const heading of headings) {
    if (heading.level <= level) continue;
    if (normalizeHeading(heading.text) !== normalizeHeading(segments[index] ?? '')) continue;
    index += 1;
    level = heading.level;
    if (index === segments.length) return heading.from;
  }
  return null;
}
