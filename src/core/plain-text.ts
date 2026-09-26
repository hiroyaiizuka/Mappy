import { autolinkUrl, type LinkSyntax } from './wiki-link';
import { GFM, parser } from '@lezer/markdown';
import { displayTitle } from './title-breaks';

const inlineParser = parser.configure(GFM);

export interface PlainTitle {
  /** Visible text without Markdown markers. */
  text: string;
  /** First link target in the title, or null; an autolink carries the scheme it was written without. */
  link: string | null;
  /** How that link was written, which decides what may become of it; null when there is none. */
  linkSyntax: LinkSyntax | null;
}

const MARKER_NODES = new Set([
  'EmphasisMark', 'CodeMark', 'StrikethroughMark', 'HeaderMark', 'QuoteMark', 'ListMark', 'LinkMark', 'HardBreak',
]);

interface Replacement { from: number; to: number; text: string; link: string | null; syntax: LinkSyntax | null }

function wikiReplacement(match: RegExpMatchArray): Replacement {
  const whole = match[0];
  const inner = match[2] ?? '';
  const [target = '', alias] = inner.split('|', 2);
  const bare = target.split('#', 1)[0]?.trim() ?? '';
  const isEmbed = match[1] === '!';
  // Embeds carry sizes or alt text after `|`; show the file name instead.
  const label = isEmbed ? bare.split('/').pop() ?? bare : alias?.trim() || bare;
  return { from: match.index ?? 0, to: (match.index ?? 0) + whole.length, text: label, link: isEmbed ? null : bare, syntax: 'vault' };
}

/** Reduce a node title to plain text for renderers that cannot show Markdown; a `<br>` in it is a line break (LEV-202). */
export function plainTitle(written: string): PlainTitle {
  const title = displayTitle(written);
  const replacements: Replacement[] = [];
  for (const match of title.matchAll(/(!?)\[\[([^\]\r\n]+?)\]\]/gu)) replacements.push(wikiReplacement(match));
  const tree = inlineParser.parse(title);
  const removed: { from: number; to: number }[] = [];
  let firstLink: string | null = null;
  let firstSyntax: LinkSyntax | null = null;
  tree.iterate({
    enter(node) {
      if (replacements.some(item => item.from <= node.from && node.to <= item.to)) return false;
      if (node.name === 'Link' || node.name === 'Image') {
        const label = title.slice(node.from, node.to).match(/^!?\[([^\]]*)\]/u)?.[1] ?? '';
        const url = title.slice(node.from, node.to).match(/\]\(\s*<?([^\s>)]*)>?(?:\s+"[^"]*")?\s*\)$/u)?.[1] ?? '';
        const text = label.trim() || (node.name === 'Image' ? url.split('/').pop() ?? url : url);
        // An inline link's destination is a vault path to Obsidian (`[説明](sample-image.svg)`), not a URL.
        replacements.push({ from: node.from, to: node.to, text, link: node.name === 'Link' && url ? url : null, syntax: 'vault' });
        return false;
      }
      if (node.name === 'Autolink' || node.name === 'URL') {
        const raw = title.slice(node.from, node.to);
        const url = raw.replace(/^<|>$/gu, '');
        // The title shows what the note wrote; the link carries the scheme an autolink leaves out.
        replacements.push({ from: node.from, to: node.to, text: url, link: autolinkUrl(url), syntax: 'autolink' });
        return false;
      }
      if (MARKER_NODES.has(node.name)) removed.push({ from: node.from, to: node.to });
      return true;
    },
  });
  const edits: Replacement[] = [...replacements, ...removed.map(range => ({ ...range, text: '', link: null, syntax: null }))]
    .sort((left, right) => left.from - right.from || right.to - left.to);
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    if (edit.from < cursor) continue;
    parts.push(title.slice(cursor, edit.from), edit.text);
    if (edit.link && firstLink === null) { firstLink = edit.link; firstSyntax = edit.syntax; }
    cursor = edit.to;
  }
  parts.push(title.slice(cursor));
  const text = parts.join('').replace(/[ \t]+/gu, ' ').replace(/ ?\n ?/gu, '\n').trim();
  return { text, link: firstLink, linkSyntax: firstSyntax };
}
