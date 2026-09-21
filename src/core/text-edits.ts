import type { MindDocument, MindNode } from './markdown';

/**
 * The pieces every text edit shares, in one place: which node an edit addresses, and how much
 * blank line an insertion needs. `commands.ts`, `list-commands.ts` and `body.ts` all plan edits
 * against the same source, so a rule that lived in each of them could be corrected in one and
 * left wrong in the others.
 */

/** The node an edit or a kept draft addresses; a re-parse after an external change may have dropped the id. */
export function getNode(doc: MindDocument, id: string): MindNode {
  const node = id === 'root' ? doc.root : doc.nodes.find(candidate => candidate.id === id);
  if (!node) throw new Error('対象のノードが変更されています。再選択してください。');
  return node;
}

/**
 * What to put between `before` and the text written after it so the two stand apart: nothing when
 * there is already a blank line (or nothing before at all), one break when the line has ended, two
 * otherwise.
 */
export function paragraphGap(before: string, eol: string): string {
  if (!before || /\n[ \t]*\r?\n$/u.test(before)) return '';
  return before.endsWith('\n') ? eol : eol + eol;
}

/** The same gap, for an insertion at `offset` of `source`. */
export function insertionPrefix(source: string, offset: number, eol: string): string {
  return paragraphGap(source.slice(0, offset), eol);
}
