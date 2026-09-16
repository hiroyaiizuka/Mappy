import { describe, expect, it } from 'vitest';
import { applyEdits, planEdit, type EditCommand } from '../../src/core/commands';
import { parseMarkdown, type MindDocument, type MindNode } from '../../src/core/markdown';

function parse(source: string, previous?: MindDocument): MindDocument {
  return parseMarkdown(source, 'Note', previous, 'list');
}

function find(doc: MindDocument, title: string): MindNode {
  const node = doc.nodes.find(candidate => candidate.title === title);
  if (!node) throw new Error(`Missing list fixture node: ${title}`);
  return node;
}

function execute(doc: MindDocument, command: EditCommand): MindDocument {
  return parse(applyEdits(doc.source, planEdit(doc, command).edits), doc);
}

describe('source-preserving list commands', () => {
  it('creates an H2 root in an empty list document', () => {
    const result = execute(parse(''), { type: 'add-child', nodeId: 'root' });
    expect(result.source).toBe('## ');
    expect(result.nodes[0]?.level).toBe(2);
  });

  it('adds a blank bullet beneath H2 and a separate H2 sibling', () => {
    const doc = parse('## Root');
    const root = find(doc, 'Root');
    expect(execute(doc, { type: 'add-child', nodeId: root.id }).source).toBe('## Root\n\n- ');
    expect(execute(doc, { type: 'add-sibling', nodeId: root.id }).source).toBe('## Root\n\n## ');
  });

  it('renames only a requested duplicate list title and preserves links, images, CRLF, and EOF', () => {
    const source = '---\r\nkey: value\r\n---\r\n## Root\r\n- Same\r\n  [[Folder/Link|alias]]\r\n- Same\r\n  ![image](../assets/image.png)';
    const doc = parse(source);
    const second = doc.nodes.filter(node => node.title === 'Same')[1];
    if (!second) throw new Error('Duplicate fixture missing');
    const result = execute(doc, { type: 'rename', nodeId: second.id, title: 'Changed' });
    expect(result.source).toBe(source.replace('- Same\r\n  !', '- Changed\r\n  !'));
  });

  it('adds siblings after the whole branch and preserves existing four-space indentation and marker style', () => {
    const doc = parse('## Root\n* Parent\n    + Child\n        - Deep\n* Keep\n');
    const child = find(doc, 'Child');
    const result = execute(doc, { type: 'add-sibling', nodeId: child.id });
    expect(result.source).toBe('## Root\n* Parent\n    + Child\n        - Deep\n    + \n* Keep\n');
    expect(find(result, 'Parent').children.map(node => node.title)).toEqual(['Child', '']);
  });

  it('continues a four-space nesting style when adding a grandchild', () => {
    const doc = parse('## Root\n- Parent\n    - Child');
    expect(execute(doc, { type: 'add-child', nodeId: find(doc, 'Child').id }).source)
      .toBe('## Root\n- Parent\n    - Child\n        - ');
  });

  it('appends root children to the existing list without inserting an extra blank paragraph', () => {
    const doc = parse('## Root\n- Child\n\nOutside prose');
    expect(execute(doc, { type: 'add-child', nodeId: find(doc, 'Root').id }).source)
      .toBe('## Root\n- Child\n- \n\nOutside prose');
  });

  it('adds children beyond heading depth six and selects the actual new title', () => {
    const source = ['## Root', ...Array.from({ length: 12 }, (_, index) => `${'  '.repeat(index)}- Depth ${index}`)].join('\n');
    const doc = parse(source);
    const last = find(doc, 'Depth 11');
    const plan = planEdit(doc, { type: 'add-child', nodeId: last.id });
    const result = parse(applyEdits(source, plan.edits));
    const added = result.nodes[result.nodes.length - 1];
    expect(added?.kind).toBe('list');
    expect(added?.level).toBe(last.level + 1);
    expect(find(result, 'Depth 11').children[0]?.title).toBe('');
    expect(plan.selectionOffset).toBe(added?.titleFrom);
  });

  it('inserts a child before following outside paragraphs without consuming them', () => {
    const doc = parse('## Root\n- Parent\n  detail\n\nOutside paragraph [[kept]]\n\n## Next\n');
    const result = execute(doc, { type: 'add-child', nodeId: find(doc, 'Parent').id });
    expect(result.source).toBe('## Root\n- Parent\n  detail\n  - \n\nOutside paragraph [[kept]]\n\n## Next\n');
  });

  it('deletes a branch with descendants without deleting a following outside paragraph', () => {
    const source = '## Root\n- Delete\n  - Child\n    continuation\n\nOutside paragraph\n\n- Keep';
    const doc = parse(source);
    const deleted = find(doc, 'Delete');
    const result = execute(doc, { type: 'delete', nodeId: deleted.id });
    expect(result.source).toBe(source.slice(0, deleted.from) + source.slice(deleted.to));
    expect(result.nodes.map(node => node.title)).toEqual(['Root', 'Keep']);
  });

  it('round-trips sibling moves with duplicate names, CRLF, continuation bodies, and no EOF newline', () => {
    const source = '## Root\r\n- Same\r\n  first [[one]]\r\n- Same\r\n  last ![[image.png]]';
    const doc = parse(source);
    const last = doc.nodes.filter(node => node.kind === 'list')[1];
    if (!last) throw new Error('Missing last');
    const up = execute(doc, { type: 'move-up', nodeId: last.id });
    expect(up.source).toBe('## Root\r\n- Same\r\n  last ![[image.png]]\r\n- Same\r\n  first [[one]]');
    const first = up.nodes.find(node => node.kind === 'list');
    if (!first) throw new Error('Missing first');
    expect(execute(up, { type: 'move-down', nodeId: first.id }).source).toBe(source);
  });

  it('moves only the target branches while retaining prose between separate lists', () => {
    const doc = parse('## Root\n- First\n\nOutside prose\n\n- Second\n');
    expect(execute(doc, { type: 'move-up', nodeId: find(doc, 'Second').id }).source)
      .toBe('## Root\n- Second\n\nOutside prose\n\n- First\n');
  });

  it('reparents all source lines, including fenced code and images, under another item', () => {
    const doc = parse('## Root\n- Move\n  Body [[link]]\n\n  ```js\n  code()\n  ```\n  - Child\n    ![image](../image.png)\n- Target');
    const result = execute(doc, { type: 'reparent', nodeId: find(doc, 'Move').id, parentId: find(doc, 'Target').id });
    expect(find(result, 'Target').children.map(node => node.title)).toEqual(['Move']);
    expect(find(result, 'Move').children.map(node => node.title)).toEqual(['Child']);
    expect(result.source).toContain('  - Move\n    Body [[link]]\n\n    ```js\n    code()\n    ```\n    - Child\n      ![image](../image.png)');
    expect(result.source.endsWith('\n')).toBe(false);
  });

  it('promotes a list branch to the H2 root while preserving following outside prose', () => {
    const doc = parse('## Root\n- Parent\n  - Move\n    detail\n\nOutside prose');
    const result = execute(doc, { type: 'reparent', nodeId: find(doc, 'Move').id, parentId: find(doc, 'Root').id });
    expect(find(result, 'Root').children.map(node => node.title)).toEqual(['Parent', 'Move']);
    expect(result.source).toContain('- Move\n  detail');
    expect(result.source.endsWith('\n\nOutside prose')).toBe(true);
  });

  it('moves the final branch into an earlier parent without introducing an EOF newline', () => {
    const doc = parse('## Root\r\n- Target\r\n- Keep\r\n- Move');
    const result = execute(doc, { type: 'reparent', nodeId: find(doc, 'Move').id, parentId: find(doc, 'Target').id });
    expect(result.source).toBe('## Root\r\n- Target\r\n  - Move\r\n- Keep');
  });

  it('renames a blank bullet without changing list syntax', () => {
    const doc = parse('## Root\n- ');
    const blank = find(doc, '');
    expect(execute(doc, { type: 'rename', nodeId: blank.id, title: 'New [[link]]' }).source).toBe('## Root\n- New [[link]]');
  });

  it('rejects self and descendant moves, multiline names, and structural corruption', () => {
    const doc = parse('## Root\n- Parent\n  - Child');
    const parent = find(doc, 'Parent');
    const child = find(doc, 'Child');
    expect(() => planEdit(doc, { type: 'reparent', nodeId: parent.id, parentId: child.id })).toThrow();
    expect(() => planEdit(doc, { type: 'reparent', nodeId: parent.id, parentId: parent.id })).toThrow();
    expect(() => planEdit(doc, { type: 'rename', nodeId: child.id, title: 'Break\n- injected' })).toThrow();
  });
});
