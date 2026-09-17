import { applyEdits, type EditCommand, type EditPlan, type TextEdit } from './commands';
import { parseMarkdown, type MindDocument, type MindNode } from './markdown';
import { getNode, indentColumns, paragraphGap, trimTrailingNewlinesAtEof } from './text-edits';

type StructureCommand = Exclude<EditCommand, { type: 'rename' }>;

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
      if (step && indentColumns(candidate) >= parent.list.contentIndent.length) indent = candidate;
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

/** Shift the complete source branch; continuation text, fences, and links travel unchanged. */
function reindentListBranch(doc: MindDocument, node: MindNode, indent: string): string {
  const originalIndent = node.list?.indent ?? '';
  if (originalIndent === indent) return doc.source.slice(node.from, node.to);
  const oldWidth = indentColumns(originalIndent);
  return doc.source.slice(node.from, node.to).replace(/^[ \t]*(?=\S)/gmu, whitespace => {
    if (whitespace.startsWith(originalIndent)) return indent + whitespace.slice(originalIndent.length);
    return indent + ' '.repeat(Math.max(0, indentColumns(whitespace) - oldWidth));
  });
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
  const moved = node.kind === 'list' ? reindentListBranch(doc, node, neighbor.list?.indent ?? '') : doc.source.slice(node.from, node.to);
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
  const text = trimTrailingNewlinesAtEof(doc, first + gap + second, to);
  const selectedFrom = direction < 0 ? from : from + first.length + gap.length;
  return validate(doc, [{ from, to, text }], doc.nodes.length, selectedFrom,
    { kind: node.kind, level: neighbor.level, title: node.title });
}

function removalFrom(doc: MindDocument, node: MindNode): number {
  if (node.to !== doc.source.length || doc.source.endsWith('\n')) return node.from;
  const separator = /(?:\r?\n)+$/u.exec(doc.source.slice(0, node.from))?.[0].length ?? 0;
  return node.from - separator;
}

function reparent(doc: MindDocument, node: MindNode, parentId: string): EditPlan {
  const parent = getNode(doc, parentId);
  if (parent.id === node.id || (parent.kind !== 'root' && parent.from >= node.from && parent.from < node.to)) {
    throw new Error('ノードを自分自身や子孫の下へ移動できません。');
  }
  if (node.parentId === parent.id) return { edits: [], selectionOffset: node.titleFrom };
  if (node.kind !== 'list' || parent.kind === 'root') {
    throw new Error('リストの枝は H2 ルートか別のリスト項目の下へ移動してください。');
  }
  const target = appendOffset(parent, node.id);
  const removeFrom = removalFrom(doc, node);
  const moved = reindentListBranch(doc, node, childStyle(doc, parent, node.id).indent);
  const remaining = doc.source.slice(0, removeFrom) + doc.source.slice(node.to);
  const offset = target >= node.to ? target - (node.to - removeFrom) : target;
  const insert = insertion(remaining, offset, moved, doc.eol, parent.kind !== 'list' && parent.children.length === 0);
  const edits: TextEdit[] = target === node.from || target === node.to
    ? [{ from: removeFrom, to: node.to, text: insert.text }]
    : [{ from: removeFrom, to: node.to, text: '' }, { from: target, to: target, text: insert.text }];
  return validate(doc, edits, doc.nodes.length, offset + insert.prefix.length,
    { kind: 'list', level: parent.level + 1, title: node.title });
}

export function planListEdit(doc: MindDocument, node: MindNode, command: StructureCommand): EditPlan {
  switch (command.type) {
    case 'add-child': return add(doc, node, false);
    case 'add-sibling': return add(doc, node, true);
    case 'delete': {
      const parent = getNode(doc, node.parentId ?? 'root');
      return validate(doc, [{ from: removalFrom(doc, node), to: node.to, text: '' }],
        doc.nodes.length - branchSize(node), parent.kind === 'root' ? null : parent.from);
    }
    case 'move-up': return move(doc, node, -1);
    case 'move-down': return move(doc, node, 1);
    case 'reparent': return reparent(doc, node, command.parentId);
  }
}
