import { applyEdits, type TextEdit } from './commands';
import { parseMarkdown, type MindDocument, type MindNode } from './markdown';
import { paragraphGap } from './text-edits';

function bodyNode(doc: MindDocument, nodeId: string): MindNode {
  const node = nodeId === 'root' ? doc.root : doc.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error('対象のノードが変更されています。再選択してください。');
  if (node.kind === 'root' && node.bodyFrom === doc.source.length && node.bodyFrom > 0
    && !/\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u.test(doc.source)) {
    throw new Error('先に Markdown 側で frontmatter を閉じてください。');
  }
  return node;
}

function normalizeNewlines(text: string, eol: string): string {
  return text.replace(/\r\n?|\n/gu, eol);
}

/** Remove only the list container indentation, keeping Markdown's own indentation. */
export function nodeBody(doc: MindDocument, node: MindNode): string {
  const body = doc.source.slice(node.bodyFrom, node.bodyTo);
  const columns = node.list?.contentIndent.length ?? 0;
  if (!columns) return body;
  return body.replace(/^[ \t]+/gmu, prefix => {
    let width = 0;
    let index = 0;
    while (index < prefix.length && width < columns) {
      width += prefix.charAt(index) === '\t' ? 4 - width % 4 : 1;
      index++;
    }
    return ' '.repeat(Math.max(0, width - columns)) + prefix.slice(index);
  });
}

function indentBody(node: MindNode, text: string): string {
  const indent = node.list?.contentIndent;
  return indent ? text.replace(/^(?=[^\r\n])/gmu, indent) : text;
}

function checkedBodyEdit(doc: MindDocument, edit: TextEdit): TextEdit {
  const updated = parseMarkdown(applyEdits(doc.source, [edit]), doc.root.title, undefined, doc.format);
  const byStart = new Map(updated.nodes.map((node) => [node.from, node]));
  const originalById = new Map(doc.nodes.map(node => [node.id, node]));
  const updatedById = new Map(updated.nodes.map(node => [node.id, node]));
  const delta = edit.text.length - (edit.to - edit.from);
  // New Markdown headings in the edited body are allowed, but an unfinished
  // fence/comment must not swallow or mutate an existing surrounding heading.
  for (const node of doc.nodes) {
    const from = node.from >= edit.to ? node.from + delta : node.from;
    const match = byStart.get(from);
    const parent = node.parentId ? originalById.get(node.parentId) : undefined;
    const expectedParentFrom = parent ? parent.from >= edit.to ? parent.from + delta : parent.from : undefined;
    const actualParentFrom = match?.parentId ? updatedById.get(match.parentId)?.from : undefined;
    if (!match || match.title !== node.title || match.level !== node.level || match.kind !== node.kind) {
      throw new Error('本文が既存の見出し構文に影響します。コードやコメントの閉じ忘れを確認してください。');
    }
    if (doc.format === 'list' && actualParentFrom !== expectedParentFrom) {
      throw new Error('本文が既存のリスト階層に影響します。インデントを確認してください。');
    }
  }
  return edit;
}

/** Replace only the direct body, retaining the heading and all descendants. */
export function planBodyEdit(doc: MindDocument, nodeId: string, body: string): TextEdit {
  const node = bodyNode(doc, nodeId);
  const before = doc.source.slice(0, node.bodyFrom);
  const normalized = indentBody(node, normalizeNewlines(body, doc.eol));
  const prefix = normalized && before && !before.endsWith('\n') ? doc.eol + doc.eol : '';
  let text = prefix + normalized;
  if (node.bodyTo < doc.source.length) text += paragraphGap(before + text, doc.eol);
  return checkedBodyEdit(doc, { from: node.bodyFrom, to: node.bodyTo, text });
}

/** Append raw Markdown as its own paragraph without replacing existing bytes. */
export function planAppendBody(doc: MindDocument, nodeId: string, markdown: string): TextEdit {
  const node = bodyNode(doc, nodeId);
  const offset = node.bodyTo;
  if (markdown.length === 0) return { from: offset, to: offset, text: '' };
  const before = doc.source.slice(0, offset);
  let text = paragraphGap(before, doc.eol) + indentBody(node, normalizeNewlines(markdown, doc.eol));
  if (offset < doc.source.length) text += paragraphGap(before + text, doc.eol);
  return checkedBodyEdit(doc, { from: offset, to: offset, text });
}
