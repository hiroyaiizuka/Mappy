import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../src/core/markdown';
import { applyEdits } from '../../src/core/commands';
import { endsWithBlankLine, findNode, getNode, lineGap, nodeAt, offsetAfter, paragraphGap, rebaseEdits } from '../../src/core/text-edits';

const DOC = parseMarkdown('# 講座\n\n本文。\n\n## はじめに\n\n- 学ぶこと\n', '講座');

describe('the rules the edit planners share', () => {
  it('finds a node by id, and the body root by the name every planner calls it', () => {
    const heading = DOC.nodes.find(node => node.title === 'はじめに');
    expect(heading).toBeDefined();
    expect(findNode(DOC, 'root')).toBe(DOC.root);
    expect(findNode(DOC, heading?.id ?? '')).toBe(heading);
    expect(findNode(DOC, 'no-such-id')).toBeUndefined();
    expect(findNode(DOC, null)).toBeUndefined();
  });

  it('throws the message the editor shows when the id is gone: an external change may have dropped it', () => {
    expect(getNode(DOC, 'root')).toBe(DOC.root);
    expect(() => getNode(DOC, 'no-such-id')).toThrow('対象のノードが変更されています。再選択してください。');
  });

  it('finds the node whose title starts at an offset, which is what a plan points at', () => {
    const heading = DOC.nodes.find(node => node.title === 'はじめに');
    expect(heading).toBeDefined();
    expect(nodeAt(DOC, heading?.titleFrom ?? -1)).toBe(heading);
    expect(nodeAt(DOC, null)).toBeUndefined();
    // A title's own text, or a node's marker, is not where its title starts.
    expect(nodeAt(DOC, (heading?.titleFrom ?? 0) + 1)).toBeUndefined();
    expect(nodeAt(DOC, heading?.from ?? -1)).toBeUndefined();
    // The body root is the file, not a title written in it.
    expect(nodeAt(DOC, 0)).toBeUndefined();
  });

  it('moves an offset over the edits, and gives up where an edit rewrites what it pointed into', () => {
    const insert = { from: 10, to: 10, text: 'あいう' };
    // Before the edit: untouched. Exactly at it: the text goes in front, so the offset follows what it marked.
    expect(offsetAfter([insert], 9)).toBe(9);
    expect(offsetAfter([insert], 10)).toBe(13);
    expect(offsetAfter([insert], 20)).toBe(23);
    const remove = { from: 4, to: 8, text: '' };
    expect(offsetAfter([remove], 20)).toBe(16);
    expect(offsetAfter([remove, insert], 20)).toBe(19);
    // A rename replaces its own title range: an offset inside it is no longer a place.
    expect(offsetAfter([{ from: 4, to: 8, text: '別の名前' }], 6)).toBeUndefined();
    expect(offsetAfter([], 6)).toBe(6);
  });

  it.each([
    ['一\n\n', true],
    ['一\n \t\n', true],
    ['一\r\n\r\n', true],
    ['一\n', false],
    ['一', false],
    ['', false],
  ])('reads %j as ending with a blank line: %s', (text, blank) => {
    expect(endsWithBlankLine(text)).toBe(blank);
  });

  it.each([
    // Nothing before, or a blank line already there: nothing to add.
    ['', ''],
    ['一\n\n', ''],
    ['一\n \t\n', ''],
    // The line ended: one break makes the blank line.
    ['一\n', '\n'],
    // Mid-line: end the line, then the blank one.
    ['一', '\n\n'],
  ])('separates a paragraph written after %j with %j', (before, gap) => {
    expect(paragraphGap(before, '\n')).toBe(gap);
  });

  it.each([
    ['', ''],
    ['一\n', ''],
    ['一\n\n', ''],
    ['一', '\n'],
  ])('separates a line written after %j with %j', (before, gap) => {
    expect(lineGap(before, '\n')).toBe(gap);
  });

  it('writes the line breaks the document uses, not always LF', () => {
    expect(paragraphGap('一', '\r\n')).toBe('\r\n\r\n');
    expect(paragraphGap('一\r\n', '\r\n')).toBe('\r\n');
    expect(lineGap('一', '\r\n')).toBe('\r\n');
  });
});

describe('rebaseEdits: an edit planned before one of the view\'s own frontmatter writes (LEV-196)', () => {
  const before = '---\nmappy: true\n---\n## Map\n\n- A\n';
  const layout = [{ from: 16, to: 16, text: 'mappy-layout: timeline\n' }];
  const after = applyEdits(before, layout);

  it('moves an edit past the text written before it: applied there, it is the edit and then the write', () => {
    const edit = [{ from: before.indexOf('A'), to: before.indexOf('A') + 1, text: 'B' }];
    const rebased = rebaseEdits(edit, layout);
    expect(rebased).toEqual([{ from: after.indexOf('A'), to: after.indexOf('A') + 1, text: 'B' }]);
    expect(applyEdits(after, rebased ?? [])).toBe(applyEdits(applyEdits(before, edit), layout));
  });

  it('keeps an insertion at the same place after the written text, and a range that ends there before it', () => {
    expect(rebaseEdits([{ from: 16, to: 16, text: 'mappy-topics: x\n' }], layout)).toEqual([{ from: 39, to: 39, text: 'mappy-topics: x\n' }]);
    expect(rebaseEdits([{ from: 4, to: 16, text: '' }], layout)).toEqual([{ from: 4, to: 16, text: '' }]);
  });

  it('gives up on an edit that overlaps what the write replaced, or that the write inserted into', () => {
    const replaced = [{ from: 4, to: 16, text: 'mappy: true\nmappy-layout: timeline\n' }];
    expect(rebaseEdits([{ from: 10, to: 12, text: 'x' }], replaced)).toBeUndefined();
    expect(rebaseEdits([{ from: 0, to: before.length, text: '' }], layout)).toBeUndefined();
  });
});
