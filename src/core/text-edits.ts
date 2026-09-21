import type { MindDocument, MindNode } from './markdown';

/**
 * The rules every text edit shares, in one place: which node an edit addresses, whether the text
 * before an insertion already ends in a blank line, and how much break an insertion needs.
 * `commands.ts`, `list-commands.ts` and `body.ts` all plan edits against the same source, so a rule
 * that lived in each of them could be corrected in one and left wrong in the others.
 */

/** The node of this id, or undefined; `'root'` is the body root, which is not in `doc.nodes`. */
export function findNode(doc: MindDocument, id: string | null): MindNode | undefined {
  return id === 'root' ? doc.root : doc.nodes.find(candidate => candidate.id === id);
}

/** The node an edit or a kept draft addresses; a re-parse after an external change may have dropped the id. */
export function getNode(doc: MindDocument, id: string): MindNode {
  const node = findNode(doc, id);
  if (!node) throw new Error('対象のノードが変更されています。再選択してください。');
  return node;
}

/** Whether `text` already ends with a blank line: the line ended, and the line before it was empty or blank. */
export function endsWithBlankLine(text: string): boolean {
  return /\n[ \t]*\r?\n$/u.test(text);
}

/**
 * What to put between `before` and a paragraph written after it so the two stand apart: nothing when
 * there is already a blank line (or nothing before at all), one break when the line has ended, two
 * otherwise.
 */
export function paragraphGap(before: string, eol: string): string {
  if (!before || endsWithBlankLine(before)) return '';
  return before.endsWith('\n') ? eol : eol + eol;
}

/** What to put between `before` and a line written after it: a break, unless the line has already ended. */
export function lineGap(before: string, eol: string): string {
  return before && !before.endsWith('\n') ? eol : '';
}
