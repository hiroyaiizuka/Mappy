import type { TextEdit } from './commands';
import type { MindDocument, MindNode } from './markdown';

/**
 * The rules every text edit shares, in one place: which node an edit addresses, where an offset lands
 * once the edits are applied, whether the text before an insertion already ends in a blank line, and how
 * much break an insertion needs. `commands.ts`, `list-commands.ts` and `body.ts` all plan edits against
 * the same source, so a rule that lived in each of them could be corrected in one and left wrong in the
 * others.
 */

/** The node of this id, or undefined; `'root'` is the body root, which is not in `doc.nodes`. */
export function findNode(doc: MindDocument, id: string | null): MindNode | undefined {
  return id === 'root' ? doc.root : doc.nodes.find(candidate => candidate.id === id);
}

/** The node beside `node` in `siblings` in source order: `step` -1 is the one above, 1 the one below. */
export function siblingOf(siblings: readonly MindNode[], node: MindNode, step: -1 | 1): MindNode | undefined {
  const index = siblings.findIndex(candidate => candidate.id === node.id);
  return index === -1 ? undefined : siblings[index + step];
}

/**
 * The node whose title starts at `offset`: what a plan's `selectionOffset` points at, and how a node
 * written by one edit set is found in the parse of the text that edit set produced. The body root has no
 * title of its own and is never the answer.
 */
export function nodeAt(doc: MindDocument, offset: number | null): MindNode | undefined {
  return offset === null ? undefined : doc.nodes.find(node => node.titleFrom === offset);
}

/**
 * Where `offset` ends up once `edits` are applied, or undefined when the answer is not a place any more:
 * an edit that starts at or before it and ends after it replaces the text the offset pointed into, so
 * nothing is carried over (a rename rewrites its own title range that way). Text inserted exactly at
 * `offset` goes before it, so the offset moves along with what it pointed at.
 */
export function offsetAfter(edits: readonly TextEdit[], offset: number): number | undefined {
  let shift = 0;
  for (const edit of edits) {
    if (edit.to <= offset) shift += edit.text.length - (edit.to - edit.from);
    else if (edit.from <= offset) return undefined;
  }
  return offset + shift;
}

/**
 * `edits`, planned on a text, carried onto that text once `applied` has changed it (each list sorted and not
 * overlapping within itself), or undefined when one of them touches what `applied` replaced or inserts into it:
 * then the two do not commute, and the edit has to be planned again. Text `applied` inserted exactly where an
 * edit starts stays before it; text inserted exactly where an edit ends stays after it. For an edit planned
 * before one of the view's own frontmatter writes landed (a layout button, LEV-196). With `insertionsAfter`, text
 * `applied` inserted exactly where an insertion of `edits` goes lands after it instead (the other order of the tie).
 */
export function rebaseEdits(edits: readonly TextEdit[], applied: readonly TextEdit[], insertionsAfter = false): TextEdit[] | undefined {
  const rebased: TextEdit[] = [];
  for (const edit of edits) {
    let shift = 0;
    for (const other of applied) {
      const tie = other.from === other.to && edit.from === edit.to && other.from === edit.from;
      if (tie && insertionsAfter) continue;
      if (other.to <= edit.from) shift += other.text.length - (other.to - other.from);
      else if (other.from < edit.to) return undefined;
    }
    rebased.push({ from: edit.from + shift, to: edit.to + shift, text: edit.text });
  }
  return rebased;
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
