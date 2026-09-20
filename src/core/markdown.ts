import { parser } from '@lezer/markdown';

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

export interface FrontmatterLayout {
  /** First YAML body line. */
  bodyFrom: number;
  /** Start of the closing delimiter line; the end of the file while unfinished. */
  closingFrom: number;
  /** Offset after the closing delimiter line. */
  end: number;
  closed: boolean;
}

/** Locate Obsidian's YAML header without parsing it. */
export function frontmatterLayout(source: string): FrontmatterLayout | null {
  const opening = /^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/u.exec(source);
  if (!opening) return null;
  const bodyFrom = opening[0].length;
  let offset = bodyFrom;
  while (offset < source.length) {
    const newline = source.indexOf('\n', offset);
    const end = newline === -1 ? source.length : newline;
    const line = source.slice(offset, end).replace(/\r$/u, '');
    if (/^(?:---|\.\.\.)[ \t]*$/u.test(line)) {
      return { bodyFrom, closingFrom: offset, end: newline === -1 ? end : end + 1, closed: true };
    }
    if (newline === -1) break;
    offset = newline + 1;
  }
  // An unfinished YAML header stays opaque until its closing delimiter exists.
  return { bodyFrom, closingFrom: source.length, end: source.length, closed: false };
}

function frontmatterEnd(source: string): number {
  return frontmatterLayout(source)?.end ?? 0;
}

function trimRange(source: string, from: number, to: number): [number, number] {
  while (from < to && /\s/u.test(source.charAt(from))) from++;
  while (to > from && /\s/u.test(source.charAt(to - 1))) to--;
  return [from, to];
}

function groupByTitle(nodes: readonly MindNode[]): Map<string, MindNode[]> {
  const byTitle = new Map<string, MindNode[]>();
  for (const node of nodes) {
    const matches = byTitle.get(node.title) ?? [];
    matches.push(node);
    byTitle.set(node.title, matches);
  }
  return byTitle;
}

/** The top-level heading sections in source order (the body root and the free topics, §5 M7): a heading no earlier heading is shallower than. */
function topLevelSections(nodes: readonly MindNode[]): MindNode[] {
  let shallowest = Number.POSITIVE_INFINITY;
  return nodes.filter((node) => {
    if (node.kind === 'list' || node.level > shallowest) return false;
    shallowest = node.level;
    return true;
  });
}

/** Top-level sections grouped by their text (heading through the end of the section, trailing blank lines aside). */
function sectionsByText(nodes: readonly MindNode[], source: string): Map<string, MindNode[]> {
  const sections = topLevelSections(nodes);
  const byText = new Map<string, MindNode[]>();
  sections.forEach((node, index) => {
    const text = source.slice(node.from, sections[index + 1]?.from ?? source.length).trimEnd();
    const matches = byText.get(text) ?? [];
    matches.push(node);
    byText.set(text, matches);
  });
  return byText;
}

function assignIds(nodes: MindNode[], previous: MindDocument | undefined, source: string): void {
  if (previous?.source === source && previous.nodes.length === nodes.length
    && nodes.every((node, index) => previous.nodes[index]?.kind === node.kind)) {
    nodes.forEach((node, index) => { node.id = previous.nodes[index]?.id ?? node.id; });
    return;
  }
  if (!previous) return;
  const oldTitles = groupByTitle(previous.nodes);
  const newTitles = groupByTitle(nodes);
  for (const node of nodes) {
    const oldMatches = oldTitles.get(node.title);
    if (oldMatches?.length === 1 && newTitles.get(node.title)?.length === 1) {
      const old = oldMatches[0];
      if (old) node.id = old.id;
    }
  }
  // Top-level sections whose whole text (heading and body) is unchanged keep their ids, same-titled ones
  // included (§5 M7: a save that moves a free topic changes only the frontmatter, so both topics of a
  // heading keep their ids and the map its selection). Identical sections correspond by order while their
  // count holds; a section whose text changed is not guessed at by title or position (docs/architecture.md).
  const oldSections = sectionsByText(previous.nodes, previous.source);
  const used = new Set(nodes.map((node) => node.id));
  for (const [text, sections] of sectionsByText(nodes, source)) {
    const olds = oldSections.get(text);
    if (!olds || olds.length !== sections.length) continue;
    sections.forEach((section, index) => {
      const old = olds[index];
      if (old && !used.has(old.id)) { section.id = old.id; used.add(old.id); }
    });
  }
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

function indentColumns(text: string): number {
  let column = 0;
  for (const char of text) column += char === '\t' ? 4 - column % 4 : 1;
  return column;
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

/** What the map shows: the body tree and the free topics placed beside it. */
export interface MapProjection {
  /**
   * Body root: the first top-level heading section. A document that starts with
   * list items before any H2 keeps the virtual root as its body, shown without
   * the topics it also parents in the parse tree.
   */
  root: MindNode;
  /** Free topics: the top-level heading sections after the body, in source order. Their positions live in frontmatter. */
  topics: MindNode[];
}

/**
 * Split the parse tree into the body and the free topics without touching a
 * single range: nodes, parents, and offsets stay those of the plain projection,
 * so editing commands keep working on `doc.root` whatever the display shows.
 */
export function projectMap(doc: MindDocument): MapProjection {
  const sections = doc.root.children;
  const first = sections.findIndex((node) => node.kind !== 'list');
  const body = sections[0];
  if (first === -1 || !body) return { root: doc.root, topics: [] };
  if (first === 0) return { root: body, topics: sections.slice(1) };
  return { root: { ...doc.root, children: sections.slice(0, first) }, topics: sections.slice(first) };
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
