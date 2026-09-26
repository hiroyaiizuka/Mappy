import {
  applyEdits, assertSingleLine, checkedMove, moveHeadingSection, moveTarget, sectionRemovalFrom, selectionAfterDelete,
  swapSections, type EditCommand, type EditPlan, type TextEdit,
} from './commands';
import { parseMarkdown, projectMap, type MindDocument, type MindNode } from './markdown';
import { endsWithBlankLine, getNode, lineGap, paragraphGap } from './text-edits';

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
    throw new Error('リスト構造を安全に変更できません。Markdown の構文を確認してください。');
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

function childStyle(doc: MindDocument, parent: MindNode, omittedId?: string): { indent: string; marker: string } {
  const existing = parent.children.find(child => child.kind === 'list' && child.id !== omittedId)?.list;
  if (existing) return { indent: existing.indent, marker: existing.marker };
  let indent = parent.kind === 'list' ? parent.list?.contentIndent ?? `${parent.list?.indent ?? ''}  ` : '';
  if (parent.list && parent.parentId) {
    const ancestor = getNode(doc, parent.parentId).list;
    if (ancestor && parent.list.indent.startsWith(ancestor.indent)) {
      const step = parent.list.indent.slice(ancestor.indent.length);
      const candidate = parent.list.indent + step;
      if (step && indentationWidth(candidate) >= parent.list.contentIndent.length) indent = candidate;
    }
  }
  return {
    indent,
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
  const style = sibling && node.list ? node.list : childStyle(doc, parent);
  const offset = sibling || heading ? node.to : appendOffset(node);
  const body = `${heading ? '## ' : `${style.indent}${style.marker} `}${title}`;
  const insert = insertion(doc.source, offset, body, doc.eol, heading || (node.kind !== 'list' && node.children.length === 0));
  return validate(doc, [{ from: offset, to: offset, text: insert.text }], doc.nodes.length + 1,
    offset + insert.prefix.length, { kind: heading ? 'atx' : 'list', level: heading ? 2 : parent.level + 1, title: title.trim() });
}

function indentationWidth(indent: string): number {
  let width = 0;
  for (const character of indent) width += character === '\t' ? 4 - width % 4 : 1;
  return width;
}

/** Shift the complete source branch; continuation text, fences, and links travel unchanged. */
function shiftedBranch(doc: MindDocument, node: MindNode, indent: string): string {
  const originalIndent = node.list?.indent ?? '';
  if (originalIndent === indent) return doc.source.slice(node.from, node.to);
  const oldWidth = indentationWidth(originalIndent);
  return doc.source.slice(node.from, node.to).replace(/^[ \t]*(?=\S)/gmu, whitespace => {
    if (whitespace.startsWith(originalIndent)) return indent + whitespace.slice(originalIndent.length);
    return indent + ' '.repeat(Math.max(0, indentationWidth(whitespace) - oldWidth));
  });
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
  const moved = shiftedBranch(doc, node, neighbor.list?.indent ?? '');
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

/** The child of the node's parent that follows it in source order. */
function nextSibling(doc: MindDocument, node: MindNode): MindNode | undefined {
  const siblings = getNode(doc, node.parentId ?? 'root').children;
  return siblings[siblings.findIndex(child => child.id === node.id) + 1];
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
  if (blankAfter && (blankBefore || nextSibling(doc, node)?.from === to + blankAfter[0].length)) to += blankAfter[0].length;
  else if (blankBefore && to === source.length && from > 0) from -= /[ \t]*\r?\n$/u.exec(before)?.[0].length ?? 0;
  return { from, to };
}

/**
 * A free topic's section as one list item (§5 M7 合流): the heading text becomes the item's first
 * line and everything after the heading line moves under the item's content indent, so prose,
 * images, fences and the nested lists keep their bytes apart from that indent. Blank lines that
 * open the body are dropped so the item does not start loose; the rest stays as written.
 */
function sectionAsBranch(doc: MindDocument, node: MindNode, style: { indent: string; marker: string }): string {
  const lead = `${style.indent}${style.marker} `;
  const contentIndent = ' '.repeat(indentationWidth(lead));
  const body = doc.source.slice(node.bodyFrom, node.to).replace(/^(?:[ \t]*\r?\n)+/u, '').replace(/(?:\r?\n)+$/u, '');
  // Empty lines stay empty; every other line, whitespace-only ones included (their bytes matter inside a fence), moves under the indent.
  const lines = body ? body.split(/\r?\n/u).map(line => line === '' ? '' : contentIndent + line) : [];
  return [`${lead}${node.title}`, ...lines].join(doc.eol);
}

/** Drop up to `width` columns of leading whitespace: the item's content indent, or less on a lazy line. */
function dedent(line: string, width: number): string {
  let column = 0;
  let index = 0;
  while (index < line.length && column < width) {
    const char = line.charAt(index);
    if (char === ' ') column += 1;
    else if (char === '\t') column += 4 - column % 4;
    else break;
    index += 1;
  }
  return line.slice(index);
}

/**
 * A list branch as its own H2 section (§5 M7 切り離し): the item's first line becomes the heading,
 * the rest loses the item's content indent, so its prose, images, fences and nested lists keep
 * their bytes and the nested items become the section's own list.
 */
function branchAsSection(doc: MindDocument, node: MindNode): string {
  const width = indentationWidth(node.list?.contentIndent ?? '');
  const body = doc.source.slice(node.bodyFrom, node.to).replace(/^(?:[ \t]*\r?\n)+/u, '').replace(/(?:\r?\n)+$/u, '');
  const lines = body ? body.split(/\r?\n/u).map(line => dedent(line, width)) : [];
  return [`## ${node.title}`, ...(lines.length > 0 ? ['', ...lines] : [])].join(doc.eol);
}

/** Detach a list branch into a new section at the end of the document: a free topic with the branch as its tree. */
function detach(doc: MindDocument, node: MindNode): EditPlan {
  if (node.kind !== 'list') throw new Error('切り離せるのはリストの枝だけです。');
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
  if (joining && !projectMap(doc).topics.some(topic => topic.id === node.id)) throw new Error('本体のルートは他のノードの下へ移動できません。');
  if (node.kind !== 'list' && !joining) return moveHeadingSection(doc, node, parentId, index);
  if (parent.kind === 'root') throw new Error('リストの枝は H2 ルートか別のリスト項目の下へ移動してください。');
  if (unchanged) return { edits: [], selectionOffset: node.titleFrom };
  const before = siblings[index];
  const after = siblings[index - 1];
  const style = (before ?? after)?.list ?? childStyle(doc, parent, node.id);
  const moved = joining ? sectionAsBranch(doc, node, style) : shiftedBranch(doc, node, style.indent);
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
    case 'add-sibling': return add(doc, node, true);
    case 'delete': {
      const count = doc.nodes.length - branchSize(node);
      const remove = (edits: TextEdit[]): EditPlan =>
        validate(doc, edits, count, selectionAfterDelete(doc, node, edits, selected => selected.from));
      if (node.kind !== 'list') return remove([{ from: sectionRemovalFrom(doc, node), to: node.to, text: '' }]);
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
