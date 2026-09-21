import { GFM, parser } from '@lezer/markdown';
import { autolinkUrl } from './wiki-link';

const attachmentParser = parser.configure(GFM);

/** Image files the map previews and the exports embed, by extension; the single list every layer reads. */
export const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  avif: 'image/avif', bmp: 'image/bmp', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp',
};

/** The media type of an image extension (any case, with or without the dot), or undefined for anything else. */
export function imageMimeType(extension: string): string | undefined {
  return IMAGE_MIME_TYPES[extension.replace(/^\./u, '').toLowerCase()];
}

const IMAGE_EXTENSION_ALTERNATIVES = Object.keys(IMAGE_MIME_TYPES).join('|');
const IMAGE_EXTENSION = new RegExp(`\\.(?:${IMAGE_EXTENSION_ALTERNATIVES})$`, 'iu');
/** `![[figure.png]]`, `![[figure.png|120]]`, `![[figure.png#anchor]]`: an embed whose target (before any alias or heading) is an image file. */
const IMAGE_EMBED = new RegExp(`^!\\[\\[[^\\]|#\\r\\n]*\\.(?:${IMAGE_EXTENSION_ALTERNATIVES})(?:[|#][^\\]\\r\\n]*)?\\]\\]$`, 'iu');

/**
 * Note and PDF transclusions become plain links; only image embeds stay embeds,
 * and inline code keeps its text. Titles and body attachments share this rule, so
 * a node never renders another note inside itself and an embedded map cannot
 * recurse through its own nodes.
 */
export function transclusionsAsLinks(markdown: string): string {
  return markdown.replace(/(`+)[^`]*\1|!\[\[[^\]\r\n]+\]\]/gu, (match) =>
    (match.startsWith('`') || IMAGE_EMBED.test(match) ? match : match.slice(1)));
}

export interface AttachmentEntry {
  kind: 'image' | 'link';
  /** Link target as written, without alias, size or heading suffix; an autolink carries the scheme it left out. */
  target: string;
  /** Visible label when the syntax provides one. */
  label: string;
}

interface AttachmentSnippets {
  snippets: string[];
  references: string[];
}

/** Collect only link/image syntax from a body; never body code blocks or prose. */
function attachmentSnippets(body: string): AttachmentSnippets {
  if (!body.includes('[') && !body.includes('<') && !/(?:https?:\/\/|www\.)/u.test(body)) {
    return { snippets: [], references: [] };
  }
  const protectedRanges: { from: number; to: number }[] = [];
  const attachments: { from: number; to: number }[] = [];
  const references: string[] = [];
  const literalNodes = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'HTMLBlock', 'HTMLTag', 'CommentBlock', 'Escape']);
  attachmentParser.parse(body).iterate({
    enter(node) {
      if (literalNodes.has(node.name) || node.name === 'LinkReference') {
        protectedRanges.push({ from: node.from, to: node.to });
        if (node.name === 'LinkReference') references.push(body.slice(node.from, node.to));
        return false;
      }
      if (['Link', 'Image', 'Autolink', 'URL'].includes(node.name)) {
        attachments.push({ from: node.from, to: node.to });
        return false;
      }
      return true;
    },
  });
  for (let position = 0; position < body.length;) {
    const from = body.indexOf('%%', position);
    if (from === -1) break;
    const literal = protectedRanges.find(range => range.from <= from && from < range.to);
    if (literal) { position = literal.to; continue; }
    const close = body.indexOf('%%', from + 2);
    const to = close === -1 ? body.length : close + 2;
    protectedRanges.push({ from, to });
    position = to;
  }
  for (const match of body.matchAll(/!?\[\[[^\r\n]+?\]\]/gu)) {
    attachments.push({ from: match.index, to: match.index + match[0].length });
  }
  const snippets: string[] = [];
  let lastEnd = -1;
  for (const range of attachments.sort((left, right) => left.from - right.from || right.to - left.to)) {
    if (range.from < lastEnd || protectedRanges.some(literal => range.from < literal.to && range.to > literal.from)) continue;
    // Note/PDF transclusions stay links; only image embeds become previews.
    snippets.push(transclusionsAsLinks(body.slice(range.from, range.to)));
    lastEnd = range.to;
  }
  return { snippets, references };
}

/** Markdown containing only the body's links and images, for MarkdownRenderer. */
export function attachmentMarkdown(body: string): string {
  const { snippets, references } = attachmentSnippets(body);
  return snippets.length > 0 ? [...snippets, ...references].join('\n\n') : '';
}

function wikiTarget(inner: string): { target: string; label: string } {
  const [target = '', alias] = inner.split('|', 2);
  const bare = target.split('#', 1)[0]?.trim() ?? '';
  return { target: bare, label: alias?.trim() || bare };
}

/** Structured links and images of a body, in source order; export paths never render Markdown. */
export function attachmentEntries(body: string): AttachmentEntry[] {
  const entries: AttachmentEntry[] = [];
  for (const snippet of attachmentSnippets(body).snippets) {
    const wiki = snippet.match(/^(!?)\[\[([^\]]+)\]\]$/u);
    if (wiki) {
      const { target, label } = wikiTarget(wiki[2] ?? '');
      if (!target) continue;
      entries.push({ kind: wiki[1] ? 'image' : 'link', target, label });
      continue;
    }
    const inline = snippet.match(/^(!?)\[([^\]]*)\]\(\s*<?([^\s>)]+)>?(?:\s+"[^"]*")?\s*\)$/u);
    if (inline) {
      const target = inline[3] ?? '';
      const label = inline[2]?.trim() ?? '';
      const isImage = Boolean(inline[1]) && IMAGE_EXTENSION.test(target.split(/[?#]/u, 1)[0] ?? '');
      entries.push({ kind: isImage ? 'image' : 'link', target, label: label || target });
      continue;
    }
    const auto = snippet.match(/^<([^>]+)>$/u);
    const target = auto ? auto[1] ?? '' : snippet;
    // Remaining snippets are autolinks or bare URLs; bracket syntax that failed above is not a target.
    // The label stays what the note wrote; only the target gains the scheme an autolink leaves out.
    if (target && !/[\s[\]<>]/u.test(target)) entries.push({ kind: 'link', target: autolinkUrl(target), label: target });
  }
  return entries;
}
