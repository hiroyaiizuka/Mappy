import { describe, expect, it } from 'vitest';
import { nodeBody, planAppendBody, planBodyEdit } from '../../src/core/body';
import { applyEdits } from '../../src/core/commands';
import { parseMarkdown, type MindDocument } from '../../src/core/markdown';

function find(doc: MindDocument, title: string) {
  const node = doc.nodes.find(candidate => candidate.title === title);
  if (!node) throw new Error(`Missing ${title}`);
  return node;
}

describe('body edits inside outline lists', () => {
  it('reads list bodies for rendering and editing without turning attachments into indented code', () => {
    const doc = parseMarkdown('## Root\n\n- Parent\n  - Child\n\n    ![[図.svg]]\n\n        code\n- Peer', 'Note');
    expect(nodeBody(doc, find(doc, 'Child'))).toContain('![[図.svg]]\n\n    code');
    expect(nodeBody(doc, find(doc, 'Child'))).not.toContain('    ![[図.svg]]');
  });
  it('appends an image to an EOF list item with its continuation indentation', () => {
    const source = '## Root\n\n- Parent\n  - Child';
    const doc = parseMarkdown(source, 'Note');
    const result = applyEdits(source, [planAppendBody(doc, find(doc, 'Child').id, '![[図.svg]]')]);
    expect(result).toBe(`${source}\n\n    ![[図.svg]]`);
    expect(parseMarkdown(result, 'Note').nodes.map(node => node.title)).toEqual(['Root', 'Parent', 'Child']);
  });

  it('replaces a direct body while keeping descendants, siblings and external prose intact', () => {
    const source = '## Root\r\n\r\n- Parent\r\n\r\n  old\r\n\r\n  - Child\r\n- Peer\r\n\r\nOutside';
    const doc = parseMarkdown(source, 'Note');
    const result = applyEdits(source, [planBodyEdit(doc, find(doc, 'Parent').id, 'New [[link]]\n![[図.png]]')]);
    expect(result).toContain('- Parent\r\n  New [[link]]\r\n  ![[図.png]]\r\n\r\n  - Child');
    expect(result.endsWith('  - Child\r\n- Peer\r\n\r\nOutside')).toBe(true);
    const parsed = parseMarkdown(result, 'Note');
    expect(find(parsed, 'Parent').children.map(node => node.title)).toEqual(['Child']);
    expect(find(parsed, 'Peer').children).toEqual([]);
  });

  it('adds an image without swallowing the following sibling or unindented paragraph', () => {
    const source = '## Root\n\n- Parent\n  - Child\n- Peer\n\nOutside';
    const doc = parseMarkdown(source, 'Note');
    const result = applyEdits(source, [planAppendBody(doc, find(doc, 'Child').id, '![[image.png]]')]);
    expect(result).toContain('  - Child\n\n    ![[image.png]]');
    expect(result.endsWith('- Peer\n\nOutside')).toBe(true);
    expect(parseMarkdown(result, 'Note').nodes.map(node => node.title)).toEqual(['Root', 'Parent', 'Child', 'Peer']);
  });

  it('keeps nested fenced content opaque when replacing a list body', () => {
    const source = '## Root\n\n- Parent\n\n  old\n\n  - Child\n- Peer';
    const doc = parseMarkdown(source, 'Note');
    const result = applyEdits(source, [planBodyEdit(doc, find(doc, 'Parent').id, '```md\n- Not a node\n```')]);
    expect(result).toContain('  ```md\n  - Not a node\n  ```');
    expect(parseMarkdown(result, 'Note').nodes.map(node => node.title)).toEqual(['Root', 'Parent', 'Child', 'Peer']);
  });

  it('refuses an unclosed fence that would absorb existing children', () => {
    const source = '## Root\n\n- Parent\n\n  old\n\n  - Child\n- Peer';
    const doc = parseMarkdown(source, 'Note');
    const parent = find(doc, 'Parent');
    expect(() => planBodyEdit(doc, parent.id, '```md\nopen')).toThrow();
  });
});
