import { parseMarkdown, type MindDocument, type MindNode } from './markdown';
import { planListEdit } from './list-commands';
import { getNode, paragraphGap, trimTrailingNewlinesAtEof } from './text-edits';

export interface TextEdit { from: number; to: number; text: string }

export type EditCommand =
  | { type: 'rename'; nodeId: string; title: string }
  | { type: 'add-child' | 'add-sibling' | 'delete' | 'move-up' | 'move-down'; nodeId: string }
  | { type: 'reparent'; nodeId: string; parentId: string };

export interface EditPlan { edits: TextEdit[]; selectionOffset: number | null }

export function applyEdits(source: string, edits: TextEdit[]): string {
  const ordered = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
  let previous: TextEdit | undefined;
  for (const edit of ordered) {
    if (!Number.isInteger(edit.from) || !Number.isInteger(edit.to)
      || edit.from < 0 || edit.to < edit.from || edit.to > source.length
      || typeof edit.text !== 'string') throw new Error('編集範囲が不正です。');
    if (previous && (edit.from < previous.to || edit.from === previous.from)) {
      throw new Error('編集範囲が重複しています。');
    }
    previous = edit;
  }
  let result = source;
  for (const edit of ordered.reverse()) result = result.slice(0, edit.from) + edit.text + result.slice(edit.to);
  return result;
}

function checkedPlan(doc: MindDocument, edits: TextEdit[], selectionOffset: number | null, count: number): EditPlan {
  const source = applyEdits(doc.source, edits);
  if (parseMarkdown(source, doc.root.title, undefined, doc.format).nodes.length !== count) {
    throw new Error('見出し構造を安全に変更できません。Markdown の構文を確認してください。');
  }
  return { edits, selectionOffset };
}

function branchNodes(doc: MindDocument, node: MindNode): MindNode[] {
  return doc.nodes.filter((candidate) => candidate.from >= node.from && candidate.from < node.to);
}

function shiftHeadingBranch(doc: MindDocument, node: MindNode, level: number): string {
  const delta = level - node.level;
  const edits: TextEdit[] = [];
  for (const descendant of branchNodes(doc, node)) {
    const nextLevel = descendant.level + delta;
    if (nextLevel < 1 || nextLevel > 6) throw new Error('見出しは子孫を含めて 6 階層までです。');
    if (delta === 0) continue;
    if (descendant.kind === 'setext') {
      if (/[\r\n]/u.test(descendant.title)) throw new Error('複数行の Setext 見出しは Markdown 側で移動してください。');
      edits.push({ from: descendant.from - node.from, to: descendant.headingTo - node.from,
        text: `${'#'.repeat(nextLevel)} ${descendant.title}` });
    } else {
      const marker = /^ {0,3}#{1,6}/u.exec(doc.source.slice(descendant.from, descendant.headingTo));
      if (!marker) throw new Error('見出しの編集位置を確認できません。');
      const indent = marker[0].indexOf('#');
      edits.push({ from: descendant.from - node.from + indent,
        to: descendant.from - node.from + marker[0].length, text: '#'.repeat(nextLevel) });
    }
  }
  return applyEdits(doc.source.slice(node.from, node.to), edits);
}

function appendBoundary(text: string, eol: string): string {
  if (/\n[ \t]*\r?\n$/u.test(text)) return text;
  return text + (text.endsWith('\n') ? eol : eol + eol);
}

function rename(doc: MindDocument, node: MindNode, title: string): EditPlan {
  if (/[\r\n\u2028\u2029]/u.test(title)) {
    throw new Error('ノード名は改行を含まない文字列にしてください。');
  }
  if (node.kind === 'setext' && title.trim().length === 0) {
    throw new Error('Setext 見出しは空にできません。Markdown 側で ATX 見出しへ変更してください。');
  }
  const before = (node.kind === 'atx' || node.kind === 'list') && !/[ \t]/u.test(doc.source.charAt(node.titleFrom - 1)) ? ' ' : '';
  const after = node.kind === 'atx' && node.titleFrom === node.titleTo && doc.source.charAt(node.titleTo) === '#' ? ' ' : '';
  const edit = { from: node.titleFrom, to: node.titleTo, text: before + title + after };
  const parsed = parseMarkdown(applyEdits(doc.source, [edit]), doc.root.title, undefined, doc.format);
  const updated = parsed.nodes.find((candidate) => candidate.from === node.from);
  if (parsed.nodes.length !== doc.nodes.length || updated?.kind !== node.kind
    || updated.level !== node.level || updated.title !== title.trim()) {
    throw new Error('この名前は見出し構文を変えてしまいます。Markdown 側で編集してください。');
  }
  return { edits: [edit], selectionOffset: updated.titleFrom };
}

function add(doc: MindDocument, node: MindNode, sibling: boolean): EditPlan {
  const level = sibling ? node.level : node.level + 1;
  if (level > 6) throw new Error('見出しは 6 階層までです。');
  const offset = node.to;
  const prefix = paragraphGap(doc.source.slice(0, offset), doc.eol);
  const suffix = offset < doc.source.length ? doc.eol + doc.eol : doc.source.endsWith('\n') ? doc.eol : '';
  const text = `${prefix}${'#'.repeat(level)} ${suffix}`;
  const edits = [{ from: offset, to: offset, text }];
  const parsed = parseMarkdown(applyEdits(doc.source, edits), doc.root.title, undefined, doc.format);
  const added = parsed.nodes.find((candidate) => candidate.from === offset + prefix.length);
  if (parsed.nodes.length !== doc.nodes.length + 1 || added?.kind !== 'atx'
    || added.level !== level || added.title !== '') {
    throw new Error('見出し構造を安全に変更できません。Markdown の構文を確認してください。');
  }
  return { edits, selectionOffset: added.titleFrom };
}

function move(doc: MindDocument, node: MindNode, direction: number): EditPlan {
  const parent = getNode(doc, node.parentId ?? 'root');
  const index = parent.children.findIndex((child) => child.id === node.id);
  const neighbor = parent.children[index + direction];
  if (!neighbor) return { edits: [], selectionOffset: node.titleFrom };
  const moved = shiftHeadingBranch(doc, node, neighbor.level);
  const other = doc.source.slice(neighbor.from, neighbor.to);
  const from = Math.min(node.from, neighbor.from);
  const to = Math.max(node.to, neighbor.to);
  const first = direction < 0 ? moved : other;
  const second = direction < 0 ? other : moved;
  const boundary = appendBoundary(first, doc.eol);
  const text = trimTrailingNewlinesAtEof(doc, boundary + second, to);
  const movedFrom = direction < 0 ? from : from + boundary.length;
  const movedDoc = parseMarkdown(moved, doc.root.title, undefined, doc.format);
  return checkedPlan(doc, [{ from, to, text }], movedFrom + (movedDoc.nodes[0]?.titleFrom ?? 0), doc.nodes.length);
}

function reparent(doc: MindDocument, node: MindNode, parentId: string): EditPlan {
  const parent = getNode(doc, parentId);
  if (parent.id === node.id || (parent.kind !== 'root' && parent.from >= node.from && parent.from < node.to)) {
    throw new Error('ノードを自分自身や子孫の下へ移動できません。');
  }
  if (node.parentId === parent.id) return { edits: [], selectionOffset: node.titleFrom };
  const moved = shiftHeadingBranch(doc, node, parent.level + 1);
  const target = parent.to;
  const trailingSeparator = node.to === doc.source.length && !doc.source.endsWith('\n') && target < node.from
    ? /(?:\r?\n)+$/u.exec(doc.source.slice(0, node.from))?.[0].length ?? 0 : 0;
  const removalFrom = node.from - trailingSeparator;
  const remaining = doc.source.slice(0, removalFrom) + doc.source.slice(node.to);
  const offset = target >= node.to ? target - (node.to - removalFrom) : target;
  const prefix = paragraphGap(remaining.slice(0, offset), doc.eol);
  const body = offset < remaining.length ? appendBoundary(moved, doc.eol) : moved;
  const text = trimTrailingNewlinesAtEof(doc, prefix + body, target);
  const edits: TextEdit[] = target === node.from || target === node.to
    ? [{ from: node.from, to: node.to, text }]
    : [{ from: removalFrom, to: node.to, text: '' }, { from: target, to: target, text }];
  const movedDoc = parseMarkdown(moved, doc.root.title, undefined, doc.format);
  return checkedPlan(doc, edits, offset + prefix.length + (movedDoc.nodes[0]?.titleFrom ?? 0), doc.nodes.length);
}

export function planEdit(doc: MindDocument, command: EditCommand): EditPlan {
  const node = getNode(doc, command.nodeId);
  if (node.kind === 'root' && command.type !== 'add-child') throw new Error('ルートでは子ノードの追加だけを行えます。');
  if (command.type === 'rename') return rename(doc, node, command.title);
  if (doc.format === 'list') return planListEdit(doc, node, command);
  switch (command.type) {
    case 'add-child': return add(doc, node, false);
    case 'add-sibling': return add(doc, node, true);
    case 'delete': return checkedPlan(doc, [{ from: node.from, to: node.to, text: '' }],
      getNode(doc, node.parentId ?? 'root').titleFrom, doc.nodes.length - branchNodes(doc, node).length);
    case 'move-up': return move(doc, node, -1);
    case 'move-down': return move(doc, node, 1);
    case 'reparent': return reparent(doc, node, command.parentId);
  }
}
