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
      expect(selectedAfterDelete('## R\n- 同じ\n- 同じ\n- 同じ\n', '同じ', 'list', 2)).toBe('同じ');
      const doc = parseMarkdown('## R\n- 同じ\n- 同じ\n', 'Note', undefined, 'list');
      const [first, second] = doc.nodes.filter(node => node.title === '同じ');
      expect(planEdit(doc, { type: 'delete', nodeId: second?.id ?? '' }).selectionOffset).toBe(first?.titleFrom);
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

    it('selects the topic above a deleted topic root, the body above the first, and the one below when it has none', () => {
      expect(selectedAfterDelete(source, 'T2', 'list')).toBe('T1');
      expect(selectedAfterDelete(source, 'T1', 'list')).toBe('Body');
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
      // The only topic has no topic beside it and no parent on screen: nothing is selected, as before.
      expect(selectedAfterDelete('- a\n\n## T\n', 'T', 'list')).toBeNull();
    });

    it('carries the offset past the frontmatter rewrite of `mappy-topics`', () => {
      const keyed = '---\nmappy-topics:\n  T1: { mindmap: [1, 2] }\n  T2: { mindmap: [3, 4] }\n---\n## Body\n\n## T1\n\n## T2\n';
      expect(selectedAfterDelete(keyed, 'T1', 'list')).toBe('Body');
      expect(selectedAfterDelete(keyed, 'Body', 'list')).toBe('T1');
    });
  });

  describe('headings', () => {
    const source = '# Title\n\n## A\ntext\n\n### A1\n\n## B\n\n## C\n';
    it.each([
      ['last', 'C', 'B'],
      ['middle', 'B', 'A'],
      ['first', 'A', 'B'],
      ['only child', 'A1', 'A'],
    ])('selects the right node for the %s heading', (_, title, expected) => {
      expect(selectedAfterDelete(source, title, 'headings')).toBe(expected);
    });

    it('selects the section below the first one at the top of the note, and nothing once none is left', () => {
      expect(selectedAfterDelete('# One\n\n# Two\n', 'One', 'headings')).toBe('Two');
      expect(selectedAfterDelete('# Two\n\n# One', 'One', 'headings')).toBe('Two');
      expect(selectedAfterDelete('# Only\n', 'Only', 'headings')).toBeNull();
    });
  });
});
