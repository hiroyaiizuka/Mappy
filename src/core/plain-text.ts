import { GFM, parser } from '@lezer/markdown';
import { autolinkUrl } from './wiki-link';

const inlineParser = parser.configure(GFM);

export interface PlainTitle {
  /** Visible text without Markdown markers. */
  text: string;
  /** First link target in the title, or null; an autolink carries the scheme it was written without. */
  link: string | null;
}

const MARKER_NODES = new Set([
  'EmphasisMark', 'CodeMark', 'StrikethroughMark', 'HeaderMark', 'QuoteMark', 'ListMark', 'LinkMark', 'HardBreak',
]);

interface Replacement { from: number; to: number; text: string; link: string | null }

function wikiReplacement(match: RegExpMatchArray): Replacement {
  const whole = match[0];
  const inner = match[2] ?? '';
  const [target = '', alias] = inner.split('|', 2);
  const bare = target.split('#', 1)[0]?.trim() ?? '';
  const isEmbed = match[1] === '!';
  // Embeds carry sizes or alt text after `|`; show the file name instead.
  const label = isEmbed ? bare.split('/').pop() ?? bare : alias?.trim() || bare;
  return { from: match.index ?? 0, to: (match.index ?? 0) + whole.length, text: label, link: isEmbed ? null : bare };
}

/** Reduce a node title to plain text for renderers that cannot show Markdown. */
export function plainTitle(title: string): PlainTitle {
  const replacements: Replacement[] = [];
  for (const match of title.matchAll(/(!?)\[\[([^\]\r\n]+?)\]\]/gu)) replacements.push(wikiReplacement(match));
  const tree = inlineParser.parse(title);
  const removed: { from: number; to: number }[] = [];
  let firstLink: string | null = null;
  tree.iterate({
    enter(node) {
      if (replacements.some(item => item.from <= node.from && node.to <= item.to)) return false;
      if (node.name === 'Link' || node.name === 'Image') {
        const label = title.slice(node.from, node.to).match(/^!?\[([^\]]*)\]/u)?.[1] ?? '';
        const url = title.slice(node.from, node.to).match(/\]\(\s*<?([^\s>)]*)>?(?:\s+"[^"]*")?\s*\)$/u)?.[1] ?? '';
        const text = label.trim() || (node.name === 'Image' ? url.split('/').pop() ?? url : url);
        replacements.push({ from: node.from, to: node.to, text, link: node.name === 'Link' && url ? url : null });
        return false;
      }
      if (node.name === 'Autolink' || node.name === 'URL') {
        const raw = title.slice(node.from, node.to);
        const url = raw.replace(/^<|>$/gu, '');
        // The title shows what the note wrote; the link carries the scheme an autolink leaves out.
        replacements.push({ from: node.from, to: node.to, text: url, link: autolinkUrl(url) });
        return false;
      }
      if (MARKER_NODES.has(node.name)) removed.push({ from: node.from, to: node.to });
      return true;
    },
  });
  const edits: Replacement[] = [...replacements, ...removed.map(range => ({ ...range, text: '', link: null }))]
    .sort((left, right) => left.from - right.from || right.to - left.to);
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    if (edit.from < cursor) continue;
    parts.push(title.slice(cursor, edit.from), edit.text);
    if (edit.link && firstLink === null) firstLink = edit.link;
    cursor = edit.to;
  }
  parts.push(title.slice(cursor));
  const text = parts.join('').replace(/[ \t]+/gu, ' ').trim();
  return { text, link: firstLink };
}
