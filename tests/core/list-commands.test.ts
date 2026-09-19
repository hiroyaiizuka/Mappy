import { describe, expect, it } from 'vitest';
import { applyEdits, planEdit, resolveDrop, type EditCommand } from '../../src/core/commands';
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

  describe('add-child with a title (a called map, §5 M12)', () => {
    const LINK = '![[別マップ]]';

    it('writes the item after the last child of a node with children, at that child\'s indent and marker', () => {
      const doc = parse('## Root\n* Parent\n    + Child\n        - Deep\n      note\n* Keep\n');
      const plan = planEdit(doc, { type: 'add-child', nodeId: find(doc, 'Parent').id, title: LINK });
      // One insertion at the end of the branch's last line: the same edit Tab makes, with the text filled in.
      expect(plan.edits).toEqual([{ from: find(doc, 'Parent').to, to: find(doc, 'Parent').to, text: `\n    + ${LINK}` }]);
      const result = parse(applyEdits(doc.source, plan.edits), doc);
      expect(result.source).toBe(`## Root\n* Parent\n    + Child\n        - Deep\n      note\n    + ${LINK}\n* Keep\n`);
      expect(find(result, 'Parent').children.map(node => node.title)).toEqual(['Child', LINK]);
      expect(plan.selectionOffset).toBe(find(result, LINK).titleFrom);
    });

    it('nests the item one step deeper under a leaf, keeping its continuation lines above', () => {
      const doc = parse('## Root\n- Leaf\n  detail [[kept]]\n- Next');
      expect(execute(doc, { type: 'add-child', nodeId: find(doc, 'Leaf').id, title: LINK }).source)
        .toBe(`## Root\n- Leaf\n  detail [[kept]]\n  - ${LINK}\n- Next`);
    });

    it('appends to the body root after its last item and to a childless section after a blank line', () => {
      const doc = parse('## Root\n- A\n  - a\n\n## Topic\n\nprose\n');
      expect(execute(doc, { type: 'add-child', nodeId: find(doc, 'Root').id, title: LINK }).source)
        .toBe(`## Root\n- A\n  - a\n- ${LINK}\n\n## Topic\n\nprose\n`);
      expect(execute(doc, { type: 'add-child', nodeId: find(doc, 'Topic').id, title: LINK }).source)
        .toBe(`## Root\n- A\n  - a\n\n## Topic\n\nprose\n\n- ${LINK}\n`);
    });

    it('makes an H2 section for the virtual root, as an empty add-child does', () => {
      const doc = parse('- before any heading\n');
      expect(execute(doc, { type: 'add-child', nodeId: 'root', title: LINK }).source).toBe(`- before any heading\n\n## ${LINK}\n`);
    });

    it('keeps the file ending at the very end of the note, with or without a final line break, as Tab now does too', () => {
      expect(execute(parse('## Root\n'), { type: 'add-child', nodeId: 'root', title: LINK }).source).toBe(`## Root\n\n## ${LINK}\n`);
      const withBreak = parse('## Root\n\nprose\n');
      expect(execute(withBreak, { type: 'add-child', nodeId: find(withBreak, 'Root').id, title: LINK }).source).toBe(`## Root\n\nprose\n\n- ${LINK}\n`);
      expect(execute(withBreak, { type: 'add-child', nodeId: find(withBreak, 'Root').id }).source).toBe('## Root\n\nprose\n\n- \n');
      const noBreak = parse('## Root\n\nprose');
      expect(execute(noBreak, { type: 'add-child', nodeId: find(noBreak, 'Root').id, title: LINK }).source).toBe(`## Root\n\nprose\n\n- ${LINK}`);
      // The other two ways of making a section at the very end keep the break too: a sibling of the last H2, a child of the virtual root.
      const section = parse('## Root\n- A\n');
      expect(execute(section, { type: 'add-sibling', nodeId: find(section, 'Root').id }).source).toBe('## Root\n- A\n\n## \n');
      expect(execute(section, { type: 'add-child', nodeId: 'root' }).source).toBe('## Root\n- A\n\n## \n');
      const unbroken = parse('## Root\n- A');
      expect(execute(unbroken, { type: 'add-sibling', nodeId: find(unbroken, 'Root').id }).source).toBe('## Root\n- A\n\n## ');
    });

    it('adds the same map twice as two items and leaves the rest of the note byte for byte', () => {
      const source = '---\r\nmappy: true\r\n---\r\n## Root\r\n- A\r\n\r\nOutside ![[image.png]]\r\n';
      const doc = parse(source);
      const once = execute(doc, { type: 'add-child', nodeId: find(doc, 'Root').id, title: LINK });
      const twice = execute(once, { type: 'add-child', nodeId: find(once, 'Root').id, title: LINK });
      expect(twice.source).toBe(`---\r\nmappy: true\r\n---\r\n## Root\r\n- A\r\n- ${LINK}\r\n- ${LINK}\r\n\r\nOutside ![[image.png]]\r\n`);
      expect(find(twice, 'Root').children.map(node => node.title)).toEqual(['A', LINK, LINK]);
    });

    it('trims the title, refuses a line break in it, and refuses text that is not the item it names', () => {
      const doc = parse('## Root\n- A\n');
      expect(execute(doc, { type: 'add-child', nodeId: find(doc, 'Root').id, title: `  ${LINK}  ` }).source).toBe(`## Root\n- A\n-   ${LINK}  \n`);
      expect(() => planEdit(doc, { type: 'add-child', nodeId: find(doc, 'Root').id, title: 'two\nlines' })).toThrow('改行');
      expect(() => planEdit(doc, { type: 'add-child', nodeId: find(doc, 'A').id, title: '[ ] task' })).toThrow('リスト構造');
    });
  });

  it('deletes a branch with descendants, line break included, without deleting a following outside paragraph', () => {
    const doc = parse('## Root\n- Delete\n  - Child\n    continuation\n\nOutside paragraph\n\n- Keep');
    const result = execute(doc, { type: 'delete', nodeId: find(doc, 'Delete').id });
    expect(result.source).toBe('## Root\n\nOutside paragraph\n\n- Keep');
    expect(result.nodes.map(node => node.title)).toEqual(['Root', 'Keep']);
  });

  // LEV-75: an item leaves with the line break that ends it, so no blank line is left inside the list.
  describe('delete removes the item\'s lines without leaving a blank line', () => {
    function remove(source: string, title: string): string {
      const doc = parse(source);
      return execute(doc, { type: 'delete', nodeId: find(doc, title).id }).source;
    }

    it('removes a middle item and an empty item, keeping frontmatter and the other lines byte for byte', () => {
      expect(remove('---\nmappy: true\n---\n## R\n\n- A\n  - X\n  - Y\n- B\n', 'X')).toBe('---\nmappy: true\n---\n## R\n\n- A\n  - Y\n- B\n');
      expect(remove('## R\n\n- A\n  - X\n  - \n  - Y\n- B\n', '')).toBe('## R\n\n- A\n  - X\n  - Y\n- B\n');
    });

    it('removes the last child, the last item, and the last item of a file without an EOF newline', () => {
      expect(remove('## R\n- A\n  - X\n- B\n', 'X')).toBe('## R\n- A\n- B\n');
      expect(remove('## R\n- A\n- X\n', 'X')).toBe('## R\n- A\n');
      expect(remove('## R\n- A\n- X', 'X')).toBe('## R\n- A');
      expect(remove('## R\n- A\n  - X', 'X')).toBe('## R\n- A');
    });

    it('keeps CRLF line endings', () => {
      expect(remove('## R\r\n- A\r\n  - X\r\n  - Y\r\n- B\r\n', 'X')).toBe('## R\r\n- A\r\n  - Y\r\n- B\r\n');
      expect(remove('## R\r\n- A\r\n- X\r\n', 'X')).toBe('## R\r\n- A\r\n');
      expect(remove('## R\r\n\r\n- A\r\n\r\n- X\r\n', 'X')).toBe('## R\r\n\r\n- A\r\n');
    });

    it('keeps a single blank line at the seam of a loose list, first, middle, and last', () => {
      expect(remove('## R\n\n- X\n\n- B\n', 'X')).toBe('## R\n\n- B\n');
      expect(remove('## R\n\n- A\n\n- X\n\n- B\n', 'X')).toBe('## R\n\n- A\n\n- B\n');
      expect(remove('## R\n\n- A\n\n- X\n', 'X')).toBe('## R\n\n- A\n');
      expect(remove('## R\n\n- A\n\n  - X\n\n  - Y\n\n- B\n', 'A')).toBe('## R\n\n- B\n');
    });

    it('leaves the blank line that separated the list from prose after it, and a blank line the list already had', () => {
      expect(remove('## R\n\n- X\n\nOutside\n', 'X')).toBe('## R\n\nOutside\n');
      expect(remove('## R\n- A\n  - X\n\n- B\n', 'X')).toBe('## R\n- A\n\n- B\n');
    });

    it('selects the parent and keeps its descendants count, so a following outside item is untouched', () => {
      const doc = parse('## R\n- A\n  - X\n    - deep\n  - Y\n- B\n');
      const plan = planEdit(doc, { type: 'delete', nodeId: find(doc, 'X').id });
      expect(plan.edits).toEqual([{ from: find(doc, 'X').from, to: find(doc, 'Y').from, text: '' }]);
      expect(plan.selectionOffset).toBe(find(doc, 'A').titleFrom);
      const result = parse(applyEdits(doc.source, plan.edits), doc);
      expect(result.source).toBe('## R\n- A\n  - Y\n- B\n');
      expect(result.nodes.map(node => node.title)).toEqual(['R', 'A', 'Y', 'B']);
    });
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

  it('does not leave a blank line behind when reparenting from the middle of a tight list', () => {
    const doc = parse('## Root\n- A\n- B\n- C\n');
    expect(execute(doc, { type: 'reparent', nodeId: find(doc, 'B').id, parentId: find(doc, 'A').id }).source)
      .toBe('## Root\n- A\n  - B\n- C\n');
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

describe('positioned moves for drag and drop (list format)', () => {
  it('moves a deep branch with continuation, fenced code, and image before a sibling of another parent', () => {
    const branch = '  - Move\n    Body [[link]]\n\n    ```js\n    code()\n    ```\n    - Child\n      ![image](../image.png)\n';
    const doc = parse(`## Root\n- A\n${branch}  - A2\n- B\n  - B1\n  - B2\n`);
    const plan = planEdit(doc, { type: 'move', nodeId: find(doc, 'Move').id, parentId: find(doc, 'B').id, index: 1 });
    const source = applyEdits(doc.source, plan.edits);
    expect(source).toBe(`## Root\n- A\n  - A2\n- B\n  - B1\n${branch}  - B2\n`);
    const result = parse(source);
    expect(find(result, 'B').children.map(node => node.title)).toEqual(['B1', 'Move', 'B2']);
    expect(find(result, 'Move').children.map(node => node.title)).toEqual(['Child']);
    expect(plan.selectionOffset).toBe(find(result, 'Move').titleFrom);
  });

  it('keeps a parent paragraph that follows its children when nodes move in and out (E19)', () => {
    const doc = parse('## Root\n- P\n  - C1\n\n  tail of P\n- Q\n  - Q1\n');
    const joined = execute(doc, { type: 'move', nodeId: find(doc, 'Q1').id, parentId: find(doc, 'P').id, index: 1 });
    expect(joined.source).toBe('## Root\n- P\n  - C1\n  - Q1\n\n  tail of P\n- Q\n');
    expect(find(joined, 'P').children.map(node => node.title)).toEqual(['C1', 'Q1']);
    const left = execute(joined, { type: 'move', nodeId: find(joined, 'C1').id, parentId: find(joined, 'Q').id, index: 0 });
    expect(left.source).toBe('## Root\n- P\n  - Q1\n\n  tail of P\n- Q\n  - C1\n');
    expect(find(left, 'Q').children.map(node => node.title)).toEqual(['C1']);
  });

  it('reorders non-adjacent siblings with CRLF and no EOF newline, and round-trips exactly', () => {
    const source = '## Root\r\n- A\r\n  a body\r\n- B\r\n- C\r\n- D';
    const doc = parse(source);
    const last = execute(doc, { type: 'move', nodeId: find(doc, 'A').id, parentId: find(doc, 'Root').id, index: 3 });
    expect(last.source).toBe('## Root\r\n- B\r\n- C\r\n- D\r\n- A\r\n  a body');
    expect(execute(last, { type: 'move', nodeId: find(last, 'A').id, parentId: find(last, 'Root').id, index: 0 }).source).toBe(source);
  });

  it('moves only the requested duplicate title with its body', () => {
    const doc = parse('## Root\n- Same\n  one\n- Same\n  two\n- Other\n');
    const second = doc.nodes.filter(node => node.title === 'Same')[1];
    if (!second) throw new Error('Missing duplicate item');
    expect(execute(doc, { type: 'move', nodeId: second.id, parentId: find(doc, 'Root').id, index: 0 }).source)
      .toBe('## Root\n- Same\n  two\n- Same\n  one\n- Other\n');
  });

  it('nests beyond heading depth six by continuing the indentation step', () => {
    const chain = Array.from({ length: 8 }, (_, index) => `${'  '.repeat(index)}- Depth ${index}\n`).join('');
    const doc = parse(`## Root\n${chain}- Other\n`);
    const result = execute(doc, { type: 'move', nodeId: find(doc, 'Other').id, parentId: find(doc, 'Depth 7').id, index: 0 });
    expect(result.source).toBe(`## Root\n${chain}${'  '.repeat(8)}- Other\n`);
    expect(find(result, 'Other').level).toBe(11);
  });

  it('moves a node after its former grandparent inside the same list', () => {
    const doc = parse('## Root\n- P\n  - A\n    - X\n');
    expect(execute(doc, { type: 'move', nodeId: find(doc, 'X').id, parentId: find(doc, 'P').id, index: 1 }).source)
      .toBe('## Root\n- P\n  - A\n  - X\n');
  });

  it('starts a new list under a childless H2 after its prose and keeps the following section', () => {
    const doc = parse('## A\n- X\n  x body\n\n## B\n\nprose\n\n## C\n');
    expect(execute(doc, { type: 'move', nodeId: find(doc, 'X').id, parentId: find(doc, 'B').id, index: 0 }).source)
      .toBe('## A\n\n## B\n\nprose\n\n- X\n  x body\n\n## C\n');
  });

  it('keeps one blank line when removing an item from a loose list', () => {
    const doc = parse('## Root\n- A\n\n- B\n\n- C\n');
    expect(execute(doc, { type: 'move', nodeId: find(doc, 'B').id, parentId: find(doc, 'A').id, index: 0 }).source)
      .toBe('## Root\n- A\n  - B\n\n- C\n');
    const doc2 = parse('## Root\n- A\n\n- B\n');
    expect(execute(doc2, { type: 'move', nodeId: find(doc2, 'B').id, parentId: find(doc2, 'A').id, index: 0 }).source)
      .toBe('## Root\n- A\n  - B\n');
  });

  it('reorders H2 sections among root children; the body section never goes under a node, a topic section joins it', () => {
    const doc = parse('## A\n- a\n\n## B\n- b\n\n## C\n- c\n');
    expect(execute(doc, { type: 'move', nodeId: find(doc, 'C').id, parentId: 'root', index: 0 }).source)
      .toBe('## C\n- c\n\n## A\n- a\n\n## B\n- b\n');
    expect(() => planEdit(doc, { type: 'move', nodeId: find(doc, 'A').id, parentId: find(doc, 'b').id, index: 0 })).toThrow('本体のルート');
    expect(resolveDrop(doc, find(doc, 'A').id, find(doc, 'b').id, 'inside')).toBeNull();
    expect(execute(doc, { type: 'move', nodeId: find(doc, 'C').id, parentId: find(doc, 'a').id, index: 0 }).source)
      .toBe('## A\n- a\n  - C\n    - c\n\n## B\n- b\n');
  });

  it('rejects list items under the virtual root, self, descendants, and bad positions, and no-ops the same position', () => {
    const doc = parse('## Root\n- P\n  - C\n- Q\n');
    const p = find(doc, 'P');
    const root = find(doc, 'Root');
    expect(() => planEdit(doc, { type: 'move', nodeId: p.id, parentId: 'root', index: 0 })).toThrow('H2');
    expect(() => planEdit(doc, { type: 'move', nodeId: p.id, parentId: find(doc, 'C').id, index: 0 })).toThrow();
    expect(() => planEdit(doc, { type: 'move', nodeId: p.id, parentId: p.id, index: 0 })).toThrow();
    expect(() => planEdit(doc, { type: 'move', nodeId: p.id, parentId: root.id, index: 2 })).toThrow();
    expect(planEdit(doc, { type: 'move', nodeId: p.id, parentId: root.id, index: 0 })).toEqual({ edits: [], selectionOffset: p.titleFrom });
    expect(planEdit(doc, { type: 'move', nodeId: find(doc, 'Q').id, parentId: root.id, index: 1 }).edits).toEqual([]);
    expect(resolveDrop(doc, p.id, root.id, 'before')).toBeNull();
    expect(resolveDrop(doc, root.id, p.id, 'inside')).toBeNull();
    expect(resolveDrop(doc, p.id, find(doc, 'Q').id, 'after')).toEqual({ type: 'move', nodeId: p.id, parentId: root.id, index: 1 });
  });
});
