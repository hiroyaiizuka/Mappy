import { GFM, parser } from '@lezer/markdown';

const attachmentParser = parser.configure(GFM);

const IMAGE_EXTENSION = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/iu;

export interface AttachmentEntry {
  kind: 'image' | 'link';
  /** Link target as written, without alias, size or heading suffix. */
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
    let snippet = body.slice(range.from, range.to);
    // Note/PDF transclusions stay links; only image embeds become previews.
    if (snippet.startsWith('![[') && !/\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:[|#][^\]]*)?\]\]$/iu.test(snippet)) {
      snippet = snippet.slice(1);
    }
    snippets.push(snippet);
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
    if (target && !/[\s[\]<>]/u.test(target)) entries.push({ kind: 'link', target, label: target });
  }
  return entries;
}
