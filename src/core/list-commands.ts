import {
  applyEdits, checkedMove, moveHeadingSection, moveTarget, sectionRemovalFrom, type EditCommand, type EditPlan, type TextEdit,
} from './commands';
import { parseMarkdown, type MindDocument, type MindNode } from './markdown';

type StructureCommand = Exclude<EditCommand, { type: 'rename' | 'add-topic' }>;

function getNode(doc: MindDocument, id: string): MindNode {
  const node = id === 'root' ? doc.root : doc.nodes.find(candidate => candidate.id === id);
  if (!node) throw new Error('対象のノードが変更されています。再選択してください。');
  return node;
}

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

function paragraphGap(before: string, eol: string): string {
  if (!before || /\n[ \t]*\r?\n$/u.test(before)) return '';
  return before.endsWith('\n') ? eol : eol + eol;
}

function insertion(source: string, offset: number, body: string, eol: string, paragraph: boolean): { text: string; prefix: string } {
  const before = source.slice(0, offset);
  const after = source.slice(offset);
  const prefix = paragraph ? paragraphGap(before, eol) : before && !before.endsWith('\n') ? eol : '';
  const suffix = after && !/^[\r\n]/u.test(after) ? (paragraph ? eol + eol : eol) : '';
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

function add(doc: MindDocument, node: MindNode, sibling: boolean): EditPlan {
  const heading = node.kind === 'root' || (sibling && node.kind !== 'list');
  const parent = sibling ? getNode(doc, node.parentId ?? 'root') : node;
  const style = sibling && node.list ? node.list : childStyle(doc, parent);
  const offset = sibling || heading ? node.to : appendOffset(node);
  const body = heading ? '## ' : `${style.indent}${style.marker} `;
  const insert = insertion(doc.source, offset, body, doc.eol, heading || (node.kind !== 'list' && node.children.length === 0));
  return validate(doc, [{ from: offset, to: offset, text: insert.text }], doc.nodes.length + 1,
    offset + insert.prefix.length, { kind: heading ? 'atx' : 'list', level: heading ? 2 : parent.level + 1, title: '' });
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

function move(doc: MindDocument, node: MindNode, direction: number): EditPlan {
  const parent = getNode(doc, node.parentId ?? 'root');
  const index = parent.children.findIndex(child => child.id === node.id);
  const neighbor = parent.children[index + direction];
  if (!neighbor) return { edits: [], selectionOffset: node.titleFrom };
  const earlier = direction < 0 ? neighbor : node;
  const later = direction < 0 ? node : neighbor;
  const from = earlier.from;
  const to = later.to;
  const moved = node.kind === 'list' ? shiftedBranch(doc, node, neighbor.list?.indent ?? '') : doc.source.slice(node.from, node.to);
  const other = doc.source.slice(neighbor.from, neighbor.to);
  let first = direction < 0 ? moved : other;
  let second = direction < 0 ? other : moved;
  let gap = doc.source.slice(earlier.to, later.from);
  if (node.kind !== 'list') {
    const trailing = /(?:\r?\n)+$/u.exec(first)?.[0] ?? '';
    first = first.slice(0, first.length - trailing.length);
    second = second.replace(/(?:\r?\n)+$/u, '');
    gap = gap || trailing || doc.eol + doc.eol;
    if (doc.source.slice(from, to).endsWith('\n')) second += doc.eol;
  }
  if (!gap && !first.endsWith('\n')) gap = doc.eol;
  const text = withoutEndNewline(doc, first + gap + second, to);
  const selectedFrom = direction < 0 ? from : from + first.length + gap.length;
  return validate(doc, [{ from, to, text }], doc.nodes.length, selectedFrom,
    { kind: node.kind, level: neighbor.level, title: node.title });
}

function removalFrom(doc: MindDocument, node: MindNode): number {
  if (node.to !== doc.source.length || doc.source.endsWith('\n')) return node.from;
  const separator = /(?:\r?\n)+$/u.exec(doc.source.slice(0, node.from))?.[0].length ?? 0;
  return node.from - separator;
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
 * The item's own lines, including the line break that ends them. A loose list keeps a single
 * blank line at the seam, and an item at EOF takes the preceding break instead so the file ending is unchanged.
 */
function removalRange(doc: MindDocument, node: MindNode): { from: number; to: number } {
  const source = doc.source;
  if (node.to >= source.length) return { from: removalFrom(doc, node), to: node.to };
  let from = node.from;
  let to = node.to + (source.startsWith('\r\n', node.to) ? 2 : source.charAt(node.to) === '\n' ? 1 : 0);
  const before = source.slice(0, from);
  const blankBefore = from === 0 || /\n[ \t]*\r?\n$/u.test(before);
  const blankAfter = source.slice(to).match(/^[ \t]*\r?\n/u);
  if (blankBefore && blankAfter) to += blankAfter[0].length;
  else if (blankBefore && to === source.length && from > 0) from -= before.match(/[ \t]*\r?\n$/u)?.[0].length ?? 0;
  return { from, to };
}

/** Move a list branch to a position among a parent's items; H2 sections move as heading sections. */
function moveTo(doc: MindDocument, node: MindNode, parentId: string, index: number): EditPlan {
  const { parent, siblings, unchanged } = moveTarget(doc, node, parentId, index);
  if (node.kind !== 'list') {
    if (parent.kind !== 'root') throw new Error('H2 のルートは他のノードの下へ移動できません。');
    return moveHeadingSection(doc, node, parentId, index);
  }
  if (parent.kind === 'root') throw new Error('リストの枝は H2 ルートか別のリスト項目の下へ移動してください。');
  if (unchanged) return { edits: [], selectionOffset: node.titleFrom };
  const before = siblings[index];
  const after = siblings[index - 1];
  const indent = (before ?? after)?.list?.indent ?? childStyle(doc, parent, node.id).indent;
  const moved = shiftedBranch(doc, node, indent);
  const target = before?.from ?? after?.to ?? (parent.kind === 'list' ? parent.to : lineEndBefore(doc.source, parent.to));
  const removal = removalRange(doc, node);
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
    case 'add-child': return add(doc, node, false);
    case 'add-sibling': return add(doc, node, true);
    case 'delete': {
      const parent = getNode(doc, node.parentId ?? 'root');
      const from = node.kind === 'list' ? removalFrom(doc, node) : sectionRemovalFrom(doc, node);
      return validate(doc, [{ from, to: node.to, text: '' }], doc.nodes.length - branchSize(node), parent.kind === 'root' ? null : parent.from);
    }
    case 'move-up': return move(doc, node, -1);
    case 'move-down': return move(doc, node, 1);
    case 'reparent': return moveTo(doc, node, command.parentId,
      getNode(doc, command.parentId).children.filter(child => child.id !== node.id).length);
    case 'move': return moveTo(doc, node, command.parentId, command.index);
  }
}
