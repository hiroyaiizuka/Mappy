import { describe, expect, it } from 'vitest';
import { applyEdits, planEdit } from '../../src/core/commands';
import { parseMarkdown, projectMap, type MindDocument } from '../../src/core/markdown';
import { nodeAt } from '../../src/core/text-edits';

/**
 * LEV-204: after a delete the selection goes to the sibling just above, else the one just below, else the
 * parent (XMind, MarkMind). Siblings are in source order, whatever the layout draws. The matrix is the key
 * the user presses (Delete and Backspace both run `delete`) × where the node sits × the shape of the note.
 */
function selectedAfterDelete(source: string, title: string, format: MindDocument['format'], occurrence = 0): string | null {
  const doc = parseMarkdown(source, 'Note', undefined, format);
  const node = doc.nodes.filter(candidate => candidate.title === title)[occurrence];
  if (!node) throw new Error(`Missing fixture node: ${title}`);
  const plan = planEdit(doc, { type: 'delete', nodeId: node.id });
  const after = parseMarkdown(applyEdits(doc.source, plan.edits), 'Note', doc, format, plan.edits);
  return nodeAt(after, plan.selectionOffset)?.title ?? null;
}

describe('selection after delete (LEV-204)', () => {
  describe('list items', () => {
    // The report: the parent had three children and the last one was deleted.
    const report = '## 注意残余の対策\n- 作業途中で、ひと言メモを残す\n- aaaaaaaa\n- aaaa\n';
    it('selects the sibling above the last child, as reported', () => {
      expect(selectedAfterDelete(report, 'aaaa', 'list')).toBe('aaaaaaaa');
    });

    const items = '## R\n- A\n  - X\n    - deep\n  - Y\n  - Z\n- B\n';
    it.each([
      ['last', 'Z', 'Y'],
      ['middle', 'Y', 'X'],
      ['first', 'X', 'Y'],
      ['a branch at the top level of the root', 'A', 'B'],
    ])('selects the right sibling of the %s child', (_, title, expected) => {
      expect(selectedAfterDelete(items, title, 'list')).toBe(expected);
    });

    // Passes with the fix reverted too: it pins the rule's parent side, which the old code always took.
    it('selects the parent of an only child', () => {
      expect(selectedAfterDelete('## R\n- A\n  - X\n- B\n', 'X', 'list')).toBe('A');
      expect(selectedAfterDelete('## R\n- X\n', 'X', 'list')).toBe('R');
    });

    it('finds the sibling below once the text shifts, in a loose list, with CRLF, and at the end of a file', () => {
      expect(selectedAfterDelete('## R\n\n- X\n\n- B\n', 'X', 'list')).toBe('B');
      expect(selectedAfterDelete('## R\r\n- X\r\n  - x\r\n- B\r\n', 'X', 'list')).toBe('B');
      expect(selectedAfterDelete('## R\n- A\n- X', 'X', 'list')).toBe('A');
      // The lines around X would join into a Setext heading: the delete keeps a blank line, the sibling is still found.
      expect(selectedAfterDelete('## R\nIntro\n- X\n---\n- B\n', 'X', 'list')).toBe('B');
    });

    it('tells same-titled siblings apart by place', () => {
      // The third goes: the second, not the first, is selected (the text before both is unchanged, so their offsets hold).
      const three = parseMarkdown('## R\n- 同じ\n- 同じ\n- 同じ\n', 'Note', undefined, 'list');
      const [, second, third] = three.nodes.filter(node => node.title === '同じ');
      expect(planEdit(three, { type: 'delete', nodeId: third?.id ?? '' }).selectionOffset).toBe(second?.titleFrom);
      const two = parseMarkdown('## R\n- 同じ\n- 同じ\n', 'Note', undefined, 'list');
      const [first, last] = two.nodes.filter(node => node.title === '同じ');
      expect(planEdit(two, { type: 'delete', nodeId: last?.id ?? '' }).selectionOffset).toBe(first?.titleFrom);
    });

    it('treats a called map (`![[…]]`) like any other item', () => {
      const source = '## R\n- A\n- ![[Other]]\n- B\n';
      expect(selectedAfterDelete(source, '![[Other]]', 'list')).toBe('A');
      expect(selectedAfterDelete(source, 'B', 'list')).toBe('![[Other]]');
    });
  });

  describe('the seam between an H2 and its items', () => {
    it('selects an H2 root\'s own items, never the neighbouring H2, and the H2 once its last item goes', () => {
      const source = '## R\n- A\n- B\n\n## T\n- C\n';
      // Passes with the fix reverted too (the parent side of the rule); the next line is the one that pins the fix.
      expect(selectedAfterDelete(source, 'C', 'list')).toBe('T');
      expect(selectedAfterDelete(source, 'A', 'list')).toBe('B');
    });
  });

  describe('free topics and the body', () => {
    const source = '## Body\n- b\n\n## T1\n- t\n\n## T2\n\n## T3\n';
    it('selects the item next to it inside a topic', () => {
      expect(selectedAfterDelete('## Body\n\n## T\n- a\n- b\n', 'b', 'list')).toBe('a');
      expect(selectedAfterDelete('## Body\n\n## T\n- a\n- b\n', 'a', 'list')).toBe('b');
    });

    // The topics are siblings of each other; the body root, drawn apart from them, stands for their parent.
    it('selects the topic above a deleted topic root, else the one below, and the body once no topic is left', () => {
      expect(selectedAfterDelete(source, 'T2', 'list')).toBe('T1');
      expect(selectedAfterDelete(source, 'T1', 'list')).toBe('T2');
      expect(selectedAfterDelete('## Body\n- b\n\n## T\n- t\n', 'T', 'list')).toBe('Body');
      expect(selectedAfterDelete(source, 'Body', 'list')).toBe('T1');
    });

    it('keeps the items of a body without an H2 apart from the topics', () => {
      // Items before the first H2 sit on the virtual root, which is the body; the H2s after them are topics.
      const loose = '- a\n- b\n\n## T1\n\n## T2\n';
      expect(projectMap(parseMarkdown(loose, 'Note', undefined, 'list')).topics.map(node => node.title)).toEqual(['T1', 'T2']);
      expect(selectedAfterDelete(loose, 'a', 'list')).toBe('b');
      expect(selectedAfterDelete(loose, 'b', 'list')).toBe('a');
      expect(selectedAfterDelete(loose, 'T1', 'list')).toBe('T2');
      expect(selectedAfterDelete(loose, 'T2', 'list')).toBe('T1');
      // The virtual root is never selected: with no node of the same kind left, the nearest one at the top level is,
      // so the focus stays in the map.
      expect(selectedAfterDelete('- a\n\n## T\n', 'T', 'list')).toBe('a');
      expect(selectedAfterDelete('- a\n\n## T\n', 'a', 'list')).toBe('T');
      // Passes with the fix reverted too: nothing is left to select.
      expect(selectedAfterDelete('- a\n', 'a', 'list')).toBeNull();
    });

    it('carries the offset past the frontmatter rewrite of `mappy-topics`', () => {
      const keyed = '---\nmappy-topics:\n  T1: { mindmap: [1, 2] }\n  T2: { mindmap: [3, 4] }\n---\n## Body\n\n## T1\n\n## T2\n';
      expect(selectedAfterDelete(keyed, 'T1', 'list')).toBe('T2');
      expect(selectedAfterDelete(keyed, 'T2', 'list')).toBe('T1');
      expect(selectedAfterDelete(keyed, 'Body', 'list')).toBe('T1');
    });
  });

  describe('headings', () => {
    const source = '# Title\n\n## A\ntext\n\n### A1\n\n## B\n\n## C\n';
    it.each([
      ['last', 'C', 'B'],
      ['middle', 'B', 'A'],
      ['first', 'A', 'B'],
      // Passes with the fix reverted too: the parent side of the rule.
      ['only child', 'A1', 'A'],
    ])('selects the right node for the %s heading', (_, title, expected) => {
      expect(selectedAfterDelete(source, title, 'headings')).toBe(expected);
    });

    it('selects the section below the first one at the top of the note, and nothing once none is left', () => {
      expect(selectedAfterDelete('# One\n\n# Two\n', 'One', 'headings')).toBe('Two');
      expect(selectedAfterDelete('# Two\n\n# One', 'One', 'headings')).toBe('Two');
      // Passes with the fix reverted too: nothing is left to select.
      expect(selectedAfterDelete('# Only\n', 'Only', 'headings')).toBeNull();
    });

    // Code review of LEV-204 (round 3): removing a section can join the paragraph above with a Setext heading below.
    // The count check alone let that through: the heading changed its title and nothing was selected.
    it('keeps a blank line where the removal would join a paragraph with a Setext heading, and selects beside it', () => {
      expect(selectedAfterDelete('# T\npara\n## A\nB\n---\n', 'A', 'headings')).toBe('B');
      expect(selectedAfterDelete('# T\n\n## A\ntext\n## B\nC\n---\n', 'B', 'headings')).toBe('A');
      const doc = parseMarkdown('# T\n\n## A\ntext\n## B\nC\n---\n', 'Note', undefined, 'headings');
      const b = doc.nodes.find(node => node.title === 'B');
      const result = applyEdits(doc.source, planEdit(doc, { type: 'delete', nodeId: b?.id ?? '' }).edits);
      expect(result).toBe('# T\n\n## A\ntext\n\nC\n---\n');
      expect(parseMarkdown(result, 'Note', undefined, 'headings').nodes.map(node => node.title)).toEqual(['T', 'A', 'C']);
    });

    // The offset is moved, not looked up again: these are the shapes where the removal reaches back over the blank
    // lines before the node or runs to the end of the file, next to a title that starts right at a line's end.
    it('finds the node at the end of a file, with CRLF, and beside an empty title', () => {
      expect(selectedAfterDelete('# T\n\n## A\n\n## B', 'B', 'headings')).toBe('A');
      expect(selectedAfterDelete('# T\r\n\r\n## A\r\ntext\r\n\r\n## B\r\n\r\n## C\r\n', 'B', 'headings')).toBe('A');
      expect(selectedAfterDelete('# T\r\n\r\n## A\r\n\r\n## B\r\n', 'A', 'headings')).toBe('B');
      expect(selectedAfterDelete('# T\n## \n## B', 'B', 'headings')).toBe('');
      expect(selectedAfterDelete('# T\n## A\n## ', '', 'headings')).toBe('A');
      expect(selectedAfterDelete('---\nmappy: true\n---\n# T\n\n## A\n\n## B\n', 'A', 'headings')).toBe('B');
      expect(selectedAfterDelete('## R\n- \n- X', 'X', 'list')).toBe('');
      expect(selectedAfterDelete('## R\n-\n- X\n', 'X', 'list')).toBe('');
    });
  });
});
