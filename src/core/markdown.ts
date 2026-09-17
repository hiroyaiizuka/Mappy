import { parser } from '@lezer/markdown';
import { indentColumns } from './text-edits';

export interface MindNode {
  id: string;
  title: string;
  level: number;
  from: number;
  headingTo: number;
  titleFrom: number;
  titleTo: number;
  bodyFrom: number;
  bodyTo: number;
  to: number;
  parentId: string | null;
  children: MindNode[];
  kind: 'atx' | 'setext' | 'root' | 'list';
  list?: { indent: string; marker: string; contentIndent: string };
}

export interface MindDocument {
  source: string;
  root: MindNode;
  nodes: MindNode[];
  eol: string;
  format: 'headings' | 'list';
}

let nextId = 1;

function whitespaceMask(text: string): string {
  return text.replace(/[^\r\n]/gu, (value) => ' '.repeat(value.length));
}

function literalRanges(source: string): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  const literalNodes = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'HTMLBlock', 'HTMLTag', 'Comment', 'CommentBlock', 'Escape']);
  parser.parse(source).iterate({
    enter(node) {
      if (!literalNodes.has(node.name)) return true;
      ranges.push({ from: node.from, to: node.to });
      return false;
    },
  });
  return ranges;
}

function maskComments(source: string): string {
  if (!source.includes('%%')) return source;
  let protectedRanges = literalRanges(source);
  const parts: string[] = [];
  let searchFrom = 0;
  let copiedTo = 0;
  let protectedIndex = 0;
  while (searchFrom < source.length) {
    const opening = source.indexOf('%%', searchFrom);
    if (opening === -1) break;
    while (protectedIndex < protectedRanges.length && (protectedRanges[protectedIndex]?.to ?? 0) <= opening) protectedIndex++;
    const literal = protectedRanges[protectedIndex];
    if (literal && literal.from <= opening && opening < literal.to) {
      searchFrom = literal.to;
      continue;
    }
    const closing = source.indexOf('%%', opening + 2);
    const to = closing === -1 ? source.length : closing + 2;
    parts.push(source.slice(copiedTo, opening), whitespaceMask(source.slice(opening, to)));
    copiedTo = to;
    searchFrom = to;
    // A literal block starting inside the comment may have swallowed later
    // Markdown in the preliminary tree. Reparse only when removing that block
    // changes the syntax context, so later real code still protects its %%.
    if ((protectedRanges[protectedIndex]?.from ?? source.length) < to) {
      protectedRanges = literalRanges(parts.join('') + source.slice(copiedTo));
      protectedIndex = 0;
    }
  }
  return parts.length === 0 ? source : parts.join('') + source.slice(copiedTo);
}

function frontmatterEnd(source: string): number {
  const opening = /^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/u.exec(source);
  if (!opening) return 0;
  let offset = opening[0].length;
  while (offset < source.length) {
    const newline = source.indexOf('\n', offset);
    const end = newline === -1 ? source.length : newline;
    const line = source.slice(offset, end).replace(/\r$/u, '');
    if (/^(?:---|\.\.\.)[ \t]*$/u.test(line)) return newline === -1 ? end : end + 1;
    if (newline === -1) break;
    offset = newline + 1;
  }
  // An unfinished YAML header stays opaque until its closing delimiter exists.
  return source.length;
}

function trimRange(source: string, from: number, to: number): [number, number] {
  while (from < to && /\s/u.test(source.charAt(from))) from++;
  while (to > from && /\s/u.test(source.charAt(to - 1))) to--;
  return [from, to];
}

function assignIds(nodes: MindNode[], previous: MindDocument | undefined, source: string): void {
  if (previous?.source === source && previous.nodes.length === nodes.length
    && nodes.every((node, index) => previous.nodes[index]?.kind === node.kind)) {
    nodes.forEach((node, index) => { node.id = previous.nodes[index]?.id ?? node.id; });
    return;
  }
  if (!previous) return;
  const oldTitles = new Map<string, MindNode[]>();
  const newTitles = new Map<string, MindNode[]>();
  for (const [collection, byTitle] of [[previous.nodes, oldTitles], [nodes, newTitles]] as const) {
    for (const node of collection) {
      const matches = byTitle.get(node.title) ?? [];
      matches.push(node);
      byTitle.set(node.title, matches);
    }
  }
  for (const node of nodes) {
    const oldMatches = oldTitles.get(node.title);
    if (oldMatches?.length === 1 && newTitles.get(node.title)?.length === 1) {
      const old = oldMatches[0];
      if (old) node.id = old.id;
    }
  }
  // Do not guess identities for duplicate titles after an external change.
  // A single title-only edit can be matched by its unchanged source surrounds.
  let prefix = 0;
  while (prefix < source.length && prefix < previous.source.length && source[prefix] === previous.source[prefix]) prefix++;
  let suffix = 0;
  while (suffix < source.length - prefix && suffix < previous.source.length - prefix
    && source[source.length - suffix - 1] === previous.source[previous.source.length - suffix - 1]) suffix++;
  const old = previous.nodes.find((node) => node.titleFrom <= prefix && node.titleTo >= previous.source.length - suffix);
  const current = nodes.find((node) => node.titleFrom <= prefix && node.titleTo >= source.length - suffix);
  if (old && current && old.title !== current.title && old.from === current.from
    && old.kind === current.kind && old.level === current.level
    && oldTitles.get(old.title)?.length === 1 && newTitles.get(current.title)?.length === 1
    && !nodes.some((node) => node.id === old.id)) current.id = old.id;
}

type SyntaxNode = ReturnType<typeof parser.parse>['topNode'];

function afterLine(source: string, end: number): number {
  let offset = end;
  if (source.charAt(offset) === '\r') offset++;
  if (source.charAt(offset) === '\n') offset++;
  return offset;
}

function headingNode(source: string, heading: SyntaxNode): MindNode | undefined {
  const match = /^(ATX|Setext)Heading([1-6])$/u.exec(heading.name);
  if (!match) return undefined;
  const kind = match[1] === 'ATX' ? 'atx' : 'setext';
  const marks = heading.getChildren('HeaderMark');
  const firstMark = marks[0];
  if (!firstMark) return undefined;
  const from = source.lastIndexOf('\n', heading.from - 1) + 1;
  const headingTo = source.charAt(heading.to - 1) === '\r' ? heading.to - 1 : heading.to;
  const closingMark = kind === 'atx' ? marks[1] : undefined;
  const rawTitleFrom = kind === 'atx' ? firstMark.to : heading.from;
  const rawTitleTo = kind === 'atx' ? (closingMark?.from ?? headingTo) : source.lastIndexOf('\n', firstMark.from - 1);
  const [titleFrom, titleTo] = trimRange(source, rawTitleFrom, Math.max(rawTitleFrom, rawTitleTo));
  return {
    id: `node-${nextId++}`, title: source.slice(titleFrom, titleTo), level: Number(match[2]),
    from, headingTo, titleFrom, titleTo, bodyFrom: afterLine(source, headingTo), bodyTo: source.length, to: source.length,
    parentId: null, children: [], kind,
  };
}

function headingHierarchy(source: string, root: MindNode, nodes: MindNode[]): void {
  const stack: MindNode[] = [root];
  nodes.forEach((node, index) => {
    node.bodyTo = nodes[index + 1]?.from ?? source.length;
    while (stack.length > 1 && (stack[stack.length - 1]?.level ?? 0) >= node.level) {
      const finished = stack.pop();
      if (finished) finished.to = node.from;
    }
    const parent = stack[stack.length - 1] ?? root;
    node.parentId = parent.id;
    parent.children.push(node);
    stack.push(node);
  });
}

function listNode(source: string, item: SyntaxNode, parent: MindNode): MindNode | undefined {
  const mark = item.getChild('ListMark');
  if (!mark) return undefined;
  const marker = source.slice(mark.from, mark.to);
  if (!/^[-+*]$/u.test(marker)) return undefined;
  const from = source.lastIndexOf('\n', mark.from - 1) + 1;
  const indent = source.slice(from, mark.from);
  if (!/^[ \t]*$/u.test(indent)) return undefined;
  const newline = source.indexOf('\n', mark.to);
  const lineEnd = newline === -1 ? source.length : newline;
  const headingTo = source.charAt(lineEnd - 1) === '\r' ? lineEnd - 1 : lineEnd;
  const [titleFrom, titleTo] = trimRange(source, mark.to, headingTo);
  const title = source.slice(titleFrom, titleTo);
  // Tasks and ordered branches remain opaque source; their editing semantics
  // are not plain topic labels. Do not project their nested lists either.
  if (/^\[[ xX]\](?:[ \t]|$)/u.test(title)) return undefined;
  const markerColumn = indentColumns(source.slice(from, mark.to));
  const contentColumn = indentColumns(source.slice(from, titleFrom));
  const spacing = contentColumn - markerColumn;
  const continuationColumn = markerColumn + (spacing > 0 && spacing <= 4 ? spacing : 1);
  const to = source.charAt(item.to - 1) === '\r' ? item.to - 1 : item.to;
  return {
    id: `node-${nextId++}`, title, level: parent.level + 1,
    from, headingTo, titleFrom, titleTo, bodyFrom: Math.min(afterLine(source, headingTo), to), bodyTo: to, to,
    parentId: null, children: [], kind: 'list',
    list: { indent, marker, contentIndent: ' '.repeat(continuationColumn) },
  };
}

function appendList(source: string, list: SyntaxNode, parent: MindNode, nodes: MindNode[]): void {
  const pending: { list: SyntaxNode; parent: MindNode }[] = [{ list, parent }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const entries: { list: SyntaxNode; parent: MindNode }[] = [];
    for (const item of current.list.getChildren('ListItem')) {
      const node = listNode(source, item, current.parent);
      if (!node) continue;
      current.parent.children.push(node);
      nodes.push(node);
      for (const childList of item.getChildren('BulletList')) entries.push({ list: childList, parent: node });
    }
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry) pending.push(entry);
    }
  }
}

function listHierarchy(source: string, root: MindNode, tree: SyntaxNode, headings: MindNode[]): MindNode[] {
  const byOffset = new Map(headings.filter(node => node.level === 2).map(node => [node.from, node]));
  const nodes: MindNode[] = [];
  let section = root;
  for (let block = tree.firstChild; block; block = block.nextSibling) {
    const from = source.lastIndexOf('\n', block.from - 1) + 1;
    const heading = byOffset.get(from);
    if (heading) {
      if (section !== root) section.to = heading.from;
      root.children.push(heading);
      nodes.push(heading);
      section = heading;
    } else if (block.name === 'BulletList') appendList(source, block, section, nodes);
  }
  nodes.sort((left, right) => left.from - right.from);
  for (const node of [root, ...nodes]) {
    node.bodyTo = node.children[0]?.from ?? node.to;
    for (const child of node.children) child.parentId = node.id;
  }
  return nodes;
}

/** Project headings or H2 + real unordered lists, preserving original source ranges. */
export function parseMarkdown(
  source: string, title: string, previous?: MindDocument, formatOverride?: MindDocument['format'],
): MindDocument {
  const yamlEnd = frontmatterEnd(source);
  const masked = maskComments(whitespaceMask(source.slice(0, yamlEnd)) + source.slice(yamlEnd));
  const tree = parser.parse(masked);
  const headings: MindNode[] = [];
  for (let block = tree.topNode.firstChild; block; block = block.nextSibling) {
    const heading = headingNode(source, block);
    if (heading) headings.push(heading);
  }
  const format = formatOverride ?? (headings.some(node => node.level !== 2) ? 'headings' : 'list');
  const root: MindNode = {
    id: 'root', title, level: 0, from: 0, headingTo: 0, titleFrom: 0, titleTo: 0,
    bodyFrom: yamlEnd, bodyTo: headings[0]?.from ?? source.length, to: source.length,
    parentId: null, children: [], kind: 'root',
  };
  const nodes = format === 'list' ? listHierarchy(source, root, tree.topNode, headings) : headings;
  assignIds(nodes, previous, source);
  if (format === 'headings') headingHierarchy(source, root, nodes);
  else {
    // Identity matching happens after projection; reconnect using the final IDs.
    for (const node of [root, ...nodes]) for (const child of node.children) child.parentId = node.id;
  }
  return { source, root, nodes, format, eol: source.includes('\r\n') ? '\r\n' : '\n' };
}
