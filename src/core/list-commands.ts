import {
  applyEdits, assertSingleLine, checkedAddition, checkedMove, moveHeadingSection, moveTarget, sectionRemovalFrom, selectionAfterDelete,
  swapSections, type EditCommand, type EditPlan, type TextEdit,
} from './commands';
import {
  indentColumns, itemContentColumn, parseMarkdown, parseableSource, projectMap, type MindDocument, type MindNode, verbatimBlockRanges,
} from './markdown';
import { endsWithBlankLine, getNode, lineGap, paragraphGap, siblingOf } from './text-edits';
import { writtenBranches, type NewBranch } from './new-branches';
import { t } from '../i18n';

type StructureCommand = Exclude<EditCommand, { type: 'rename' | 'add-topic' }>;

function branchSize(node: MindNode): number {
  const pending = [node];
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    count++;
    for (const child of current.children) pending.push(child);
  }
  return count;
}

function validate(
  doc: MindDocument,
  edits: TextEdit[],
  count: number,
  selectedFrom: number | null,
  expected?: { kind: MindNode['kind']; level: number; title: string },
): EditPlan {
  const parsed = parseMarkdown(applyEdits(doc.source, edits), doc.root.title, undefined, 'list');
  const selected = selectedFrom === null ? undefined : parsed.nodes.find(node => node.from === selectedFrom);
  if (parsed.nodes.length !== count || (expected && (!selected || selected.kind !== expected.kind
    || selected.level !== expected.level || selected.title !== expected.title))) {
    throw new Error(t().listUnsafe);
  }
  return { edits, selectionOffset: selected?.titleFrom ?? null };
}

/** Text placed at `offset`, separated from what surrounds it; at the very end of a file that ends with a line break, the break is kept. */
function insertion(source: string, offset: number, body: string, eol: string, paragraph: boolean): { text: string; prefix: string } {
  const before = source.slice(0, offset);
  const after = source.slice(offset);
  const prefix = paragraph ? paragraphGap(before, eol) : lineGap(before, eol);
  const suffix = after ? (/^[\r\n]/u.test(after) ? '' : paragraph ? eol + eol : eol) : before.endsWith('\n') ? eol : '';
  return { text: prefix + body + suffix, prefix };
}

type IndentUnit = 'tab' | 'space';
type Ranges = { from: number; to: number }[];

interface SourceLine { from: number; text: string }

function sourceLines(source: string, from: number, to: number): SourceLine[] {
  let start = from;
  return source.slice(from, to).split('\n').map(text => {
    const line = { from: start, text };
    start += text.length + 1;
    return line;
  });
}

function leadingWhitespace(text: string): string {
  return /^[ \t]*/u.exec(text)?.[0] ?? '';
}

const readableSources = new WeakMap<MindDocument, string>();
const verbatimRanges = new WeakMap<MindDocument, Ranges>();

/** The note as the map's parse reads it (`parseableSource`: frontmatter blanked, `%%…%%` comments masked, offsets kept). */
function readable(doc: MindDocument): string {
  let text = readableSources.get(doc);
  if (text === undefined) readableSources.set(doc, text = parseableSource(doc.source));
  return text;
}

/** The note's code and HTML blocks, parsed once per document and only when asked for. */
function verbatimBlocks(doc: MindDocument): Ranges {
  let ranges = verbatimRanges.get(doc);
  if (!ranges) verbatimRanges.set(doc, ranges = verbatimBlockRanges(readable(doc)));
  return ranges;
}

function inBlock(blocks: Ranges, line: SourceLine): boolean {
  return blocks.some(range => range.from < line.from + line.text.length && range.to > line.from);
}

/**
 * Where a list item line's marker and content start, in columns (`itemContentColumn`, as the map reads items); `null`
 * for another line, a thematic break (`* * *`) included. Tasks and ordered items count, though the map does not draw
 * them. After a line of text (`lazy`), an ordered marker other than `1.` continues that text (CommonMark).
 */
function itemColumns(line: string, lazy = false): { indent: number; content: number } | null {
  const text = line.replace(/\r$/u, '');
  if (/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/u.test(text)) return null;
  const match = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]*)/u.exec(text);
  if (!match) return null;
  const [whole, lead = '', marker = '', gap = ''] = match;
  if (lazy && /^\d/u.test(marker) && !/^0*1[.)]$/u.test(marker)) return null;
  const empty = whole.length === text.length;
  if (!gap && !empty) return null;
  const markerColumn = indentColumns(lead + marker);
  return { indent: indentColumns(lead), content: itemContentColumn(markerColumn, empty ? markerColumn : indentColumns(whole)) };
}

/** The heading section (or the root, for a list before the first heading) a node's list belongs to. */
function topicOf(doc: MindDocument, node: MindNode): MindNode {
  let topic = node;
  while (topic.kind === 'list' && topic.parentId) topic = getNode(doc, topic.parentId);
  return topic;
}

/** A topic's own list: from its first list item to the end of its last, so neither frontmatter nor another heading's list is in it. */
function listRange(topic: MindNode): { from: number; to: number } | null {
  const items = topic.children.filter(child => child.kind === 'list');
  const first = items[0];
  const last = items[items.length - 1];
  return first && last ? { from: first.from, to: last.to } : null;
}

/**
 * The unit the indented list item lines in `ranges` use: `mixed` if both, `undefined` if none is indented. The items
 * the map draws decide it; tasks and ordered items only when none of those is indented. Code and HTML blocks are
 * parsed out only when the lines disagree.
 */
function unitOf(doc: MindDocument, ranges: ({ from: number; to: number } | null)[]): IndentUnit | 'mixed' | undefined {
  const text = readable(doc);
  const nodes = new Set(doc.nodes.map(node => node.from));
  const items = ranges.flatMap(range => {
    if (!range) return [];
    let lazy = false;
    return sourceLines(text, range.from, range.to).filter(line => {
      const found = leadingWhitespace(line.text) !== '' && itemColumns(line.text, lazy) !== null;
      lazy = line.text.trim() !== '';
      return found;
    });
  });
  const decide = (blocks: Ranges): IndentUnit | 'mixed' | undefined => {
    const kept = items.filter(line => !inBlock(blocks, line));
    const drawn = kept.filter(line => nodes.has(line.from));
    return unitOfLeads(drawn.length > 0 ? drawn : kept);
  };
  const unit = decide([]);
  return unit === 'mixed' ? decide(verbatimBlocks(doc)) : unit;
}

function unitOfLeads(lines: SourceLine[]): IndentUnit | 'mixed' | undefined {
  let unit: IndentUnit | undefined;
  for (const line of lines) {
    const lead = leadingWhitespace(line.text);
    const own = /^\t+$/u.test(lead) ? 'tab' : /^ +$/u.test(lead) ? 'space' : 'mixed';
    if (own === 'mixed' || (unit && unit !== own)) return 'mixed';
    unit = own;
  }
  return unit;
}

/**
 * The unit new indentation under `parent` is written in (LEV-225): the one the list items of its topic are indented
 * with, tasks and ordered items included; a list with no indentation takes the note's, and a list or note that
 * mixes tabs and spaces takes spaces, as a note with no indentation at all does.
 */
function indentUnit(doc: MindDocument, parent: MindNode): IndentUnit {
  const local = unitOf(doc, [listRange(topicOf(doc, parent))]);
  const unit = local ?? unitOf(doc, [doc.root, ...doc.nodes.filter(node => node.kind !== 'list')].map(listRange));
  return unit === 'tab' ? 'tab' : 'space';
}

/** Whether a line's leading whitespace is written in `unit`; in a tab list, a line other than an item may end with the up to 3 columns before the next tab stop. */
function fits(lead: string, unit: IndentUnit, item: boolean): boolean {
  if (unit === 'space') return !lead.includes('\t');
  return item ? /^\t*$/u.test(lead) : /^\t* {0,3}$/u.test(lead);
}

/** `width` columns of leading whitespace in `unit`. An item in a tab list goes to the next tab stop, under 4 columns on, so it stays inside its parent's content. */
function whitespace(width: number, unit: IndentUnit, item: boolean): string {
  if (unit === 'space') return ' '.repeat(width);
  return item ? '\t'.repeat(Math.ceil(width / 4)) : '\t'.repeat(Math.floor(width / 4)) + ' '.repeat(width % 4);
}

function itemIndent(indent: string, unit: IndentUnit): string {
  return fits(indent, unit, true) ? indent : whitespace(indentColumns(indent), unit, true);
}

function childStyle(doc: MindDocument, parent: MindNode, omittedId?: string): { indent: string; marker: string } {
  const existing = parent.children.find(child => child.kind === 'list' && child.id !== omittedId)?.list;
  if (existing) return { indent: itemIndent(existing.indent, indentUnit(doc, parent)), marker: existing.marker };
  let indent = parent.kind === 'list' ? parent.list?.contentIndent ?? `${parent.list?.indent ?? ''}  ` : '';
  if (parent.list && parent.parentId) {
    const ancestor = getNode(doc, parent.parentId).list;
    if (ancestor && parent.list.indent.startsWith(ancestor.indent)) {
      const step = parent.list.indent.slice(ancestor.indent.length);
      const candidate = parent.list.indent + step;
      if (step && indentColumns(candidate) >= parent.list.contentIndent.length) indent = candidate;
    }
  }
  return {
    indent: itemIndent(indent, indentUnit(doc, parent)),
    marker: parent.list?.marker ?? '-',
  };
}

function appendOffset(parent: MindNode, omittedId?: string): number {
  if (parent.kind === 'list') return parent.to;
  const children = parent.children.filter(child => child.id !== omittedId);
  return children[children.length - 1]?.to ?? parent.to;
}

/** A new item after the node's last child (or after the node's branch, for a sibling); `title` is its text, empty for the inline editor. */
function add(doc: MindDocument, node: MindNode, sibling: boolean, title = ''): EditPlan {
  assertSingleLine(title);
  const heading = node.kind === 'root' || (sibling && node.kind !== 'list');
  const parent = sibling ? getNode(doc, node.parentId ?? 'root') : node;
  const offset = sibling || heading ? node.to : appendOffset(node);
  const style = heading ? null : sibling && node.list ? { indent: itemIndent(node.list.indent, indentUnit(doc, parent)), marker: node.list.marker } : childStyle(doc, parent);
  const body = `${style ? `${style.indent}${style.marker} ` : '## '}${title}`;
  const insert = insertion(doc.source, offset, body, doc.eol, heading || (node.kind !== 'list' && node.children.length === 0));
  return validate(doc, [{ from: offset, to: offset, text: insert.text }], doc.nodes.length + 1,
    offset + insert.prefix.length, { kind: heading ? 'atx' : 'list', level: heading ? 2 : parent.level + 1, title: title.trim() });
}

/**
 * The branches as list items after the node's last child, as `add` writes one child (§11.5): the top level at the
 * children's indent and marker (`childStyle`), each nested level at its parent item's content column in the list's
 * unit (LEV-225). One edit, checked to read back as exactly these branches (`checkedAddition`).
 */
function addBranches(doc: MindDocument, node: MindNode, items: readonly NewBranch[]): EditPlan {
  const written = writtenBranches(items, 'item');
  if (written.length === 0) throw new Error(t().nothingToAdd);
  for (const item of written) assertSingleLine(item.title);
  const style = childStyle(doc, node);
  const unit = indentUnit(doc, node);
  // The indent of each depth: the top level's, then each one at the content column of an item of the depth above.
  const indents = [style.indent];
  const indentAt = (depth: number): string => {
    while (indents.length < depth) {
      const above = indents[indents.length - 1] ?? '';
      indents.push(whitespace(indentColumns(above) + style.marker.length + 1, unit, true));
    }
    return indents[depth - 1] ?? '';
  };
  const body = written.map(item => `${indentAt(item.depth)}${style.marker} ${item.title}`).join(doc.eol);
  const offset = appendOffset(node);
  const insert = insertion(doc.source, offset, body, doc.eol, node.kind !== 'list' && node.children.length === 0);
  return checkedAddition(doc, [{ from: offset, to: offset, text: insert.text }], node, written, offset + insert.prefix.length);
}

interface Column { old: number; new: number }

/**
 * The lines of a branch below its first line, for a first line whose content column moves from `root.old` to
 * `root.new`, with new indentation in `unit` (LEV-225). A list item sits at its parent's new content column (the
 * next tab stop in a tab list; its own offset from it too in a space list, when it was written in spaces). Any other
 * line changes only the indentation in front of the content of the item it is in, so body text, code and HTML keep
 * their bytes past it; a line left of that content moves with it. A line whose column does not change and, for an
 * item, whose indentation is already in `unit` keeps its bytes, unless `rewrite` (the branch's own indentation is
 * rewritten, or it moves into another list): then the indentation in front of every line is written in `unit`.
 * Empty lines and the lines of a `%%…%%` comment (blank in `readableText`, as the map reads them) stay as they are.
 */
function reindented(
  lines: SourceLine[], readableText: string, root: Column, unit: IndentUnit, blocks: Ranges, rewrite: boolean,
): string[] {
  const open: Column[] = [root];
  let blank = true;
  // A line left of an item's content ends that item, but a paragraph's next line can be lazy (CommonMark): only code, or a line after a blank one, does.
  const close = (width: number) => { while (open.length > 1 && (open[open.length - 1]?.old ?? 0) > width) open.pop(); };
  return lines.map(line => {
    const body = line.text.replace(/\r$/u, '');
    const end = line.text.slice(body.length);
    const read = readableText.slice(line.from, line.from + body.length);
    const verbatim = inBlock(blocks, line);
    const wasBlank = blank;
    blank = !read.trim();
    if (!body || (!verbatim && !read.trim())) return line.text;
    const lead = leadingWhitespace(body);
    const rest = body.slice(lead.length);
    const width = indentColumns(lead);
    const item = verbatim ? null : itemColumns(read, !wasBlank);
    if (item) {
      close(width);
      const parent = open[open.length - 1] ?? root;
      const kept = fits(lead, unit, true);
      const indent = kept && parent.new === parent.old ? lead
        : unit === 'tab' ? whitespace(parent.new, unit, true) : ' '.repeat(parent.new + (kept ? Math.max(0, width - parent.old) : 0));
      // Measured on the written line: a tab after the marker spans a different width at another column.
      open.push({ old: item.content, new: itemColumns(indent + rest)?.content ?? item.content });
      return indent + rest + end;
    }
    if (verbatim || wasBlank) close(width);
    const at = [...open].reverse().find(candidate => candidate.old <= width) ?? root;
    if (at.new === at.old && !rewrite) return line.text;
    if (width < at.old) return whitespace(Math.max(0, width + at.new - at.old), unit, false) + rest + end;
    const inside = dedented(body, at.old);
    return whitespace(at.new, unit, false) + ' '.repeat(inside.overshoot) + inside.rest + end;
  });
}

/**
 * Shift the complete source branch to `targetIndent` under `parent`, written in `unit`, the list's own (LEV-225);
 * continuation text, fences, and links travel with it (`reindented`). A branch that stays in its list at the same
 * indentation, with no item indented another way, comes back as it is.
 */
function shiftedBranch(doc: MindDocument, node: MindNode, parent: MindNode, targetIndent: string, unit: IndentUnit): string {
  const indent = itemIndent(targetIndent, unit);
  const originalIndent = node.list?.indent ?? '';
  const topic = topicOf(doc, node);
  const rewrite = indent !== originalIndent || topicOf(doc, parent).id !== topic.id;
  const text = readable(doc);
  const [first, ...rest] = sourceLines(doc.source, node.from, node.to);
  const own = (line: SourceLine) => text.slice(line.from, line.from + line.text.length);
  if (!rewrite && rest.every(line => !itemColumns(own(line)) || fits(leadingWhitespace(line.text), unit, true))) {
    return doc.source.slice(node.from, node.to);
  }
  const head = indent + (first?.text ?? '').slice(originalIndent.length);
  const old = indentColumns(node.list?.contentIndent ?? '');
  // Measured on the written line, as for the items below it: a tab after the marker spans a different width at another column.
  const root = { old, new: itemColumns(head)?.content ?? old };
  return [head, ...reindented(rest, text, root, unit, verbatimBlocks(doc), rewrite)].join('\n');
}

function withoutEndNewline(doc: MindDocument, text: string, to: number): string {
  return to === doc.source.length && !doc.source.endsWith('\n') ? text.replace(/(?:\r?\n)+$/u, '') : text;
}

/** Swap the node with its neighbour; H2 sections swap as heading sections do (`swapSections`), items with the gap between them. */
function move(doc: MindDocument, node: MindNode, direction: number): EditPlan {
  const parent = getNode(doc, node.parentId ?? 'root');
  const index = parent.children.findIndex(child => child.id === node.id);
  const neighbor = parent.children[index + direction];
  if (!neighbor) return { edits: [], selectionOffset: node.titleFrom };
  if (node.kind !== 'list') return swapSections(doc, node, neighbor, direction, doc.source.slice(node.from, node.to));
  const earlier = direction < 0 ? neighbor : node;
  const later = direction < 0 ? node : neighbor;
  const from = earlier.from;
  const to = later.to;
  const moved = shiftedBranch(doc, node, parent, neighbor.list?.indent ?? '', indentUnit(doc, parent));
  const other = doc.source.slice(neighbor.from, neighbor.to);
  // In output order: `first` is the later item's text, `second` the earlier one's.
  const first = direction < 0 ? moved : other;
  const second = direction < 0 ? other : moved;
  let gap = doc.source.slice(earlier.to, later.from);
  if (!gap && !first.endsWith('\n')) gap = doc.eol;
  const text = withoutEndNewline(doc, first + gap + second, to);
  const selectedFrom = direction < 0 ? from : from + first.length + gap.length;
  return checkedMove(doc, [{ from, to, text }], node, parent, index + direction, selectedFrom);
}

/** End of the nearest non-blank line before `offset` (a line start), without its line break. */
function lineEndBefore(source: string, offset: number): number {
  let end = offset;
  while (end > 0) {
    let lineEnd = end;
    if (source.charAt(lineEnd - 1) === '\n') lineEnd--;
    if (source.charAt(lineEnd - 1) === '\r') lineEnd--;
    const lineStart = source.lastIndexOf('\n', lineEnd - 1) + 1;
    if (/\S/u.test(source.slice(lineStart, lineEnd))) return lineEnd;
    end = lineStart;
  }
  return 0;
}

/**
 * The item's own lines, including the line break that ends them. A blank line after the item goes
 * with it when it was the seam to the next sibling, or when a blank precedes the item too, so a loose
 * list keeps a single blank at each seam. An item at EOF takes the preceding break instead, so the
 * file ending is unchanged: one break when the file ends with one, every break (blank lines included)
 * when it does not.
 */
function removalRange(doc: MindDocument, node: MindNode): { from: number; to: number } {
  const source = doc.source;
  const before = source.slice(0, node.from);
  if (node.to >= source.length && !source.endsWith('\n')) {
    return { from: node.from - (/(?:[ \t]*\r?\n)+$/u.exec(before)?.[0].length ?? 0), to: node.to };
  }
  let from = node.from;
  let to = Math.min(source.length, node.to + (source.startsWith('\r\n', node.to) ? 2 : source.charAt(node.to) === '\n' ? 1 : 0));
  const blankBefore = from === 0 || endsWithBlankLine(before);
  const blankAfter = /^[ \t]*\r?\n/u.exec(source.slice(to));
  if (blankAfter && (blankBefore || siblingOf(getNode(doc, node.parentId ?? 'root').children, node, 1)?.from === to + blankAfter[0].length)) to += blankAfter[0].length;
  else if (blankBefore && to === source.length && from > 0) from -= /[ \t]*\r?\n$/u.exec(before)?.[0].length ?? 0;
  return { from, to };
}

/**
 * A free topic's section as one list item (§5 M7 合流): the heading text becomes the item's first
 * line and everything after the heading line moves under the item's content indent, so prose,
 * images, fences and the nested lists keep their bytes apart from that indent. Blank lines that
 * open the body are dropped so the item does not start loose; the rest stays as written.
 */
function sectionAsBranch(doc: MindDocument, node: MindNode, style: { indent: string; marker: string }, unit: IndentUnit): string {
  const lead = `${itemIndent(style.indent, unit)}${style.marker} `;
  const from = node.bodyFrom + (/^(?:[ \t]*\r?\n)+/u.exec(doc.source.slice(node.bodyFrom, node.to))?.[0].length ?? 0);
  const body = doc.source.slice(from, node.to).replace(/(?:\r?\n)+$/u, '');
  // Everything moves under the item's content column, in the list's unit (LEV-225); empty lines stay empty.
  const lines = body ? reindented(sourceLines(doc.source, from, from + body.length), readable(doc), { old: 0, new: indentColumns(lead) }, unit,
    verbatimBlocks(doc), true).map(line => line.replace(/\r$/u, '')) : [];
  return [`${lead}${node.title}`, ...lines].join(doc.eol);
}

/** Drop up to `width` columns of leading whitespace; `overshoot` is how far a tab dropped last went past `width`. */
function dedented(line: string, width: number): { rest: string; overshoot: number } {
  let column = 0;
  let index = 0;
  while (index < line.length && column < width) {
    const char = line.charAt(index);
    if (char === ' ') column += 1;
    else if (char === '\t') column += 4 - column % 4;
    else break;
    index += 1;
  }
  return { rest: line.slice(index), overshoot: Math.max(0, column - width) };
}

/** Drop up to `width` columns of leading whitespace: the item's content indent, or less on a lazy line. */
function dedent(line: string, width: number): string {
  return dedented(line, width).rest;
}

/**
 * A list branch as its own H2 section (§5 M7 切り離し): the item's first line becomes the heading,
 * the rest loses the item's content indent, so its prose, images, fences and nested lists keep
 * their bytes and the nested items become the section's own list.
 */
function branchAsSection(doc: MindDocument, node: MindNode): string {
  const width = indentColumns(node.list?.contentIndent ?? '');
  const body = doc.source.slice(node.bodyFrom, node.to).replace(/^(?:[ \t]*\r?\n)+/u, '').replace(/(?:\r?\n)+$/u, '');
  const lines = body ? body.split(/\r?\n/u).map(line => dedent(line, width)) : [];
  return [`## ${node.title}`, ...(lines.length > 0 ? ['', ...lines] : [])].join(doc.eol);
}

/** Detach a list branch into a new section at the end of the document: a free topic with the branch as its tree. */
function detach(doc: MindDocument, node: MindNode): EditPlan {
  if (node.kind !== 'list') throw new Error(t().detachListOnly);
  const removal = removalRange(doc, node);
  const remaining = doc.source.slice(0, removal.from) + doc.source.slice(removal.to);
  const prefix = paragraphGap(remaining, doc.eol);
  const text = `${prefix}${branchAsSection(doc, node)}${remaining.endsWith('\n') ? doc.eol : ''}`;
  const edits: TextEdit[] = [{ from: removal.from, to: removal.to, text: '' }, { from: doc.source.length, to: doc.source.length, text }];
  const index = doc.root.children.filter(child => child.id !== node.id).length;
  return checkedMove(doc, edits, node, doc.root, index, remaining.length + prefix.length);
}

/** Move a list branch to a position among a parent's items; H2 sections move as heading sections or, for a free topic dropped on a node, join that node as a branch. */
function moveTo(doc: MindDocument, node: MindNode, parentId: string, index: number): EditPlan {
  const { parent, siblings, unchanged } = moveTarget(doc, node, parentId, index);
  const joining = node.kind !== 'list' && parent.kind !== 'root';
  if (joining && !projectMap(doc).topics.some(topic => topic.id === node.id)) throw new Error(t().mainRootMove);
  if (node.kind !== 'list' && !joining) return moveHeadingSection(doc, node, parentId, index);
  if (parent.kind === 'root') throw new Error(t().listBranchTarget);
  if (unchanged) return { edits: [], selectionOffset: node.titleFrom };
  const before = siblings[index];
  const after = siblings[index - 1];
  const style = (before ?? after)?.list ?? childStyle(doc, parent, node.id);
  const unit = indentUnit(doc, parent);
  const moved = joining ? sectionAsBranch(doc, node, style, unit) : shiftedBranch(doc, node, parent, style.indent, unit);
  const target = before?.from ?? after?.to ?? (parent.kind === 'list' ? parent.to : lineEndBefore(doc.source, parent.to));
  const removal = joining ? { from: sectionRemovalFrom(doc, node), to: node.to } : removalRange(doc, node);
  const remaining = doc.source.slice(0, removal.from) + doc.source.slice(removal.to);
  // A former ancestor that ended with this branch now ends at the line before it.
  const offset = target > removal.from && target <= removal.to ? lineEndBefore(doc.source, node.from)
    : target >= removal.to ? target - (removal.to - removal.from) : target;
  const insert = insertion(remaining, offset, moved, doc.eol, parent.kind !== 'list' && siblings.length === 0);
  const insertAt = offset < removal.from ? offset : target;
  const edits: TextEdit[] = offset === removal.from
    ? [{ from: removal.from, to: removal.to, text: insert.text }]
    : [{ from: removal.from, to: removal.to, text: '' }, { from: insertAt, to: insertAt, text: insert.text }];
  return checkedMove(doc, edits, node, parent, index, offset + insert.prefix.length);
}

export function planListEdit(doc: MindDocument, node: MindNode, command: StructureCommand): EditPlan {
  switch (command.type) {
    case 'add-child': return add(doc, node, false, command.title);
    case 'add-sibling': return add(doc, node, true, command.title);
    case 'add-children': return addBranches(doc, node, command.items);
    case 'delete': {
      const count = doc.nodes.length - branchSize(node);
      const remove = (edits: TextEdit[]): EditPlan =>
        validate(doc, edits, count, selectionAfterDelete(doc, node, edits));
      if (node.kind !== 'list') {
        try {
          return remove([{ from: sectionRemovalFrom(doc, node), to: node.to, text: '' }]);
        } catch {
          // The paragraph above would join the Setext heading below (`intro` + `C\n---` is a paragraph and a rule since
          // LEV-208, C gone): keep the break, as a blank line, as the headings format does (`deleteHeadingBranch`).
          return remove([{ from: node.from, to: node.to, text: doc.eol }]);
        }
      }
      try {
        // An item leaves with its line break, as it does when moved.
        return remove([{ ...removalRange(doc, node), text: '' }]);
      } catch {
        // The lines around the item would join into another block (`Intro` + `---` is a Setext heading): keep the break, as a blank line.
        return remove([{ from: node.from, to: node.to, text: '' }]);
      }
    }
    case 'move-up': return move(doc, node, -1);
    case 'move-down': return move(doc, node, 1);
    case 'reparent': return moveTo(doc, node, command.parentId,
      getNode(doc, command.parentId).children.filter(child => child.id !== node.id).length);
    case 'move': return moveTo(doc, node, command.parentId, command.index);
    case 'detach': return detach(doc, node);
  }
}
