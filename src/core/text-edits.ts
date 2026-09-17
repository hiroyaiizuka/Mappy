import type { MindDocument, MindNode } from './markdown';

export function getNode(doc: MindDocument, id: string): MindNode {
  const node = id === 'root' ? doc.root : doc.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error('対象のノードが変更されています。再選択してください。');
  return node;
}

export function paragraphGap(before: string, eol: string): string {
  if (!before || /\n[ \t]*\r?\n$/u.test(before)) return '';
  return before.endsWith('\n') ? eol : eol + eol;
}

export function trimTrailingNewlinesAtEof(doc: MindDocument, text: string, to: number): string {
  return to === doc.source.length && !doc.source.endsWith('\n') ? text.replace(/(?:\r?\n)+$/u, '') : text;
}

export function indentColumns(text: string): number {
  let column = 0;
  for (const char of text) column += char === '\t' ? 4 - column % 4 : 1;
  return column;
}
