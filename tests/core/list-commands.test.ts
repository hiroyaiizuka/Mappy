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

    // Code review of PR #39: the blank after a tight first item was its seam to the next sibling, not the parent's.
    it('takes the seam to the next sibling with a tight first item, and leaves a blank that belongs to the parent', () => {
      expect(remove('## R\n- A\n  - X\n\n  - Y\n- B\n', 'X')).toBe('## R\n- A\n  - Y\n- B\n');
      expect(remove('## R\n- A\n- X\n\n- B\n- C\n', 'X')).toBe('## R\n- A\n- B\n- C\n');
      const kept = parse('## R\n- A\n  - X\n\n  text of A\n');
      const result = execute(kept, { type: 'delete', nodeId: find(kept, 'X').id });
      expect(result.source).toBe('## R\n- A\n\n  text of A\n');
      expect(find(result, 'A').children).toEqual([]);
      const detached = parse('## R\n- A\n  - X\n\n  - Y\n- B\n');
      expect(execute(detached, { type: 'detach', nodeId: find(detached, 'X').id }).source).toBe('## R\n- A\n  - Y\n- B\n\n## X\n');
    });

    it('treats a whitespace-only line as blank and an unclosed fence at EOF as the item\'s end', () => {
      expect(remove('## R\n\n- A\n  \n- X', 'X')).toBe('## R\n\n- A');
      expect(remove('## R\n\n- A\n\n- X\n  ```\n  code\n', 'X')).toBe('## R\n\n- A\n');
    });

    it('keeps the break as a blank line when the lines around the item would join into another block', () => {
      // `Intro` + `---` would be a Setext heading; the delete still succeeds, as it did before the line break was taken.
      const doc = parse('## R\nIntro\n- X\n---\n');
      const result = execute(doc, { type: 'delete', nodeId: find(doc, 'X').id });
      expect(result.source).toBe('## R\nIntro\n\n---\n');
      expect(result.nodes.map(node => node.title)).toEqual(['R']);
    });

    // LEV-204: the sibling below is selected when there is none above (tests/core/delete-selection.test.ts has the whole rule).
    it('selects the sibling below and keeps its descendants count, so a following outside item is untouched', () => {
      const doc = parse('## R\n- A\n  - X\n    - deep\n  - Y\n- B\n');
      const plan = planEdit(doc, { type: 'delete', nodeId: find(doc, 'X').id });
      expect(plan.edits).toEqual([{ from: find(doc, 'X').from, to: find(doc, 'Y').from, text: '' }]);
      const result = parse(applyEdits(doc.source, plan.edits), doc);
      expect(plan.selectionOffset).toBe(find(result, 'Y').titleFrom);
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

  describe('swapping H2 sections with ⌥↑／⌥↓ keeps the blank lines between sections and the file ending (LEV-87)', () => {
    it('keeps the one blank line between the swapped sections when the moved section ended the file', () => {
      const doc = parse('## Root\n- Child\n\n## A\n- First\n\n## B\n- Second\n');
      const swapped = '## Root\n- Child\n\n## B\n- Second\n\n## A\n- First\n';
      expect(execute(doc, { type: 'move-up', nodeId: find(doc, 'B').id }).source).toBe(swapped);
      expect(execute(doc, { type: 'move-down', nodeId: find(doc, 'A').id }).source).toBe(swapped);
    });

    it('keeps the blank line before the section that follows the swapped pair', () => {
      const doc = parse('## Root\n- Child\n\n## A\n- First\n\n## B\n- Second\n\n## C\n- Third\n');
      expect(execute(doc, { type: 'move-up', nodeId: find(doc, 'B').id }).source)
        .toBe('## Root\n- Child\n\n## B\n- Second\n\n## A\n- First\n\n## C\n- Third\n');
    });

    it('selects the moved section after either move', () => {
      const doc = parse('## Root\n- Child\n\n## A\n- First\n\n## B\n- Second\n\n## C\n- Third\n');
      for (const command of [{ type: 'move-down', nodeId: find(doc, 'A').id }, { type: 'move-up', nodeId: find(doc, 'B').id }] as const) {
        const plan = planEdit(doc, command);
        const result = parse(applyEdits(doc.source, plan.edits), doc);
        expect(result.root.children.map(node => node.title)).toEqual(['Root', 'B', 'A', 'C']);
        expect(plan.selectionOffset).toBe(find(result, command.type === 'move-down' ? 'A' : 'B').titleFrom);
      }
    });

    it('round-trips ⌥↑ then ⌥↓ byte for byte: no EOF newline, CRLF, prose in the bodies, wider or narrower seams', () => {
      const sources = [
        '## Root\n- Child\n\n## A\n- First\n\n## B\n- Second\n',
        '## Root\n- Child\n\n## A\n- First\n\n## B\n- Second',
        '## Root\r\n- Child\r\n\r\n## A\r\n- First\r\n\r\n## B\r\n- Second\r\n',
        '## Root\n- Child\n\n## A\n- First\n  detail [[one]]\n\nProse about A.\n\n## B\n- Second\n\nProse about B.\n![[image.png]]\n\n## C\n- Third\n',
        '## Root\n- Child\n\n## A\n- First\n\n\n## B\n- Second\n\n',
        '## Root\n- Child\n\n## A\n- First\n  \n## B\n- Second\n',
        '## Root\n- Child\n\n## A\n- First\n## B\n- Second\n',
      ];
      for (const source of sources) {
        const doc = parse(source);
        const up = execute(doc, { type: 'move-up', nodeId: find(doc, 'B').id });
        expect(up.root.children.map(node => node.title).slice(0, 3), source).toEqual(['Root', 'B', 'A']);
        expect(up.source.endsWith('\n'), source).toBe(source.endsWith('\n'));
        expect(execute(up, { type: 'move-down', nodeId: find(up, 'B').id }).source, source).toBe(source);
      }
    });

    it('moves only the seam and the two sections: the swap is one edit over their range', () => {
      const doc = parse('## Root\n- Child\n\n## A\n- First\n\n## B\n- Second\n\n## C\n- Third\n');
      const plan = planEdit(doc, { type: 'move-up', nodeId: find(doc, 'B').id });
      expect(plan.edits).toEqual([{ from: find(doc, 'A').from, to: find(doc, 'B').to, text: '## B\n- Second\n\n## A\n- First\n\n' }]);
    });

    it('writes the same bytes as dragging the section to that position when the seams are one blank line', () => {
      const doc = parse('## Root\n- Child\n\n## A\n- First\n\nProse.\n\n## B\n- Second\n\n## C\n- Third\n');
      expect(execute(doc, { type: 'move-up', nodeId: find(doc, 'B').id }).source)
        .toBe(execute(doc, { type: 'move', nodeId: find(doc, 'B').id, parentId: 'root', index: 1 }).source);
      expect(execute(doc, { type: 'move-down', nodeId: find(doc, 'B').id }).source)
        .toBe(execute(doc, { type: 'move', nodeId: find(doc, 'B').id, parentId: 'root', index: 3 }).source);
    });

    it('adds a blank line where the lines brought together would join into another block, such as a paragraph before a Setext underline (LEV-88)', () => {
      const doc = parse('## Root\n- Child\n\n## A\n- First\n\nProse about A.\n\n## B\n```\ncode\n```\nC\n---\n- Third\n');
      expect(doc.root.children.map(node => node.title)).toEqual(['Root', 'A', 'B', 'C']);
      const mended = '## Root\n- Child\n\n## B\n```\ncode\n```\n\n## A\n- First\n\nProse about A.\n\nC\n---\n- Third\n';
      expect(execute(doc, { type: 'move-up', nodeId: find(doc, 'B').id }).source).toBe(mended);
      expect(execute(doc, { type: 'move-down', nodeId: find(doc, 'A').id }).source).toBe(mended);
    });

    it('still refuses a swap that blank lines cannot mend: an H2 section over the top-level items before it', () => {
      const doc = parse('- item\n\n## A\n- First\n');
      expect(doc.root.children.map(node => node.title)).toEqual(['item', 'A']);
      expect(() => planEdit(doc, { type: 'move-up', nodeId: find(doc, 'A').id })).toThrow('リスト構造を安全に変更できません');
    });
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
    // A break in a name is written as `<br>` in the item's one line (LEV-202): it cannot start another item.
    const renamed = applyEdits(doc.source, planEdit(doc, { type: 'rename', nodeId: child.id, title: 'Break\n- injected' }).edits);
    expect(renamed).toBe('## Root\n- Parent\n  - Break<br>- injected');
    expect(parse(renamed).nodes.map(node => node.title)).toEqual(['Root', 'Parent', 'Break<br>- injected']);
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

// LEV-195: README's known limitations tell users to indent their lists with spaces or with tabs, because then no
// map operation writes a tab into a space-indented list (the tab side, and notes that use both, are LEV-225's
// block below). One step of each structure command (add a child or sibling, move
// up or down, delete, detach, reparent, move to a position) on every node of a note whose lists are all
// space-indented; adding a topic, renaming and body edits are not covered (tabs typed into a body are the
// user's text). A refusal (a plain `Error` with the message the map shows) is skipped; anything else throws.
describe('notes indented with spaces only stay free of tabs', () => {
  const source = '## R\n- A\n  - A1\n    - A1a\n      body\n  - A2\n- B\n    - B1\n    - B2\n- C\n\n## S\n- D\n  - D1\n';

  function commands(doc: MindDocument): EditCommand[] {
    return doc.nodes.flatMap((node): EditCommand[] => [
      ...(['add-child', 'add-sibling', 'move-up', 'move-down', 'delete', 'detach'] as const).map(type => ({ type, nodeId: node.id })),
      ...doc.nodes.flatMap((parent): EditCommand[] => [
        { type: 'reparent', nodeId: node.id, parentId: parent.id },
        ...[0, 1, 2].map((index): EditCommand => ({ type: 'move', nodeId: node.id, parentId: parent.id, index })),
      ]),
    ]);
  }

  it('writes no tab at the start of any line', () => {
    const doc = parse(source);
    const counts = { applied: 0, unchanged: 0, refused: 0 };
    for (const command of commands(doc)) {
      let edits;
      try {
        edits = planEdit(doc, command).edits;
      } catch (error) {
        if (!(error instanceof Error) || error.constructor !== Error) throw error;
        counts.refused++;
        continue;
      }
      if (edits.length === 0) { counts.unchanged++; continue; }
      counts.applied++;
      const result = applyEdits(source, edits);
      const tabbed = result.split('\n').filter(line => /^[ \t]*\t/u.test(line));
      expect(tabbed, `${JSON.stringify(command)} → ${JSON.stringify(result)}`).toEqual([]);
    }
    // A floor, not an exact count, so that allowing or refusing some other move does not fail a test about tabs.
    expect(counts.applied).toBeGreaterThan(300);
  });
});

// LEV-225 (decision 2026-09-28): the indentation Mappy writes into a list (a first child's default, a moved branch's
// new indent) follows the unit the list is already indented with, tabs or spaces, so that no line and no list mixes
// the two. A list with no indentation follows the rest of the note; a mixed list or note gets spaces. Rows are the
// user's operation × the shape of the list it lands in.
describe('new indentation follows the unit of the list (LEV-225)', () => {
  const tabs = '## R\n- A\n\t- A1\n\t\t- A1a\n- B\n';

  it.each([
    ['tab list, first child of a first-level item', tabs, 'add-child', 'B', undefined, '## R\n- A\n\t- A1\n\t\t- A1a\n- B\n\t- B1\n'],
    ['tab list, first child of a deep item', tabs, 'add-child', 'A1a', undefined, '## R\n- A\n\t- A1\n\t\t- A1a\n\t\t\t- B1\n- B\n'],
    ['space list, first child of a first-level item', '## R\n- A\n  - A1\n- B\n', 'add-child', 'B', undefined, '## R\n- A\n  - A1\n- B\n  - B1\n'],
    ['unindented list in a tab note', '## R\n- A\n- B\n\n## S\n- D\n\t- D1\n', 'add-child', 'B', undefined, '## R\n- A\n- B\n\t- B1\n\n## S\n- D\n\t- D1\n'],
    ['unindented list in a mixed note', '## R\n- A\n\n## S\n- D\n\t- D1\n\n## T\n- E\n  - E1\n', 'add-child', 'A', undefined, '## R\n- A\n  - B1\n\n## S\n- D\n\t- D1\n\n## T\n- E\n  - E1\n'],
    ['tab branch under the new first child of a tab list', '## R\n- A\n\t- A1\n\t\t- A1a\n- B\n\t- B1\n', 'reparent', 'A1', 'B1', '## R\n- A\n- B\n\t- B1\n\t\t- A1\n\t\t\t- A1a\n'],
    ['tab branch from another topic under a space list', '## R\n- A\n  - A1\n\n## S\n- D\n\t- D1\n', 'reparent', 'D', 'A', '## R\n- A\n  - A1\n  - D\n    - D1\n\n## S\n'],
    ['space branch from another topic under a tab list', '## R\n- A\n\t- A1\n\n## S\n- D\n  - D1\n', 'reparent', 'D', 'A', '## R\n- A\n\t- A1\n\t- D\n\t\t- D1\n\n## S\n'],
    ['tab branch from another topic to the first level of a space list', '## R\n- A\n  - A1\n\n## S\n- D\n\t- D1\n', 'reparent', 'D', 'R', '## R\n- A\n  - A1\n- D\n  - D1\n\n## S\n'],
    ['tab topic joining a space list', '## R\n- A\n  - A1\n\n## S\n- D\n\t- D1\n', 'reparent', 'S', 'A', '## R\n- A\n  - A1\n  - S\n    - D\n      - D1\n'],
    ['space topic joining a tab list', '## R\n- A\n\t- A1\n\n## S\n- D\n  - D1\n', 'reparent', 'S', 'A', '## R\n- A\n\t- A1\n\t- S\n\t\t- D\n\t\t\t- D1\n'],
    ['tab sibling moved past a same-width space sibling', '## R\n- P\n\t- X\n\t\t- X1\n    - Z\n', 'move-down', 'X', undefined, '## R\n- P\n    - Z\n    - X\n      - X1\n'],
    ['space sibling moved past a same-width tab sibling', '## R\n- P\n\t- X\n    - Z\n        - Z1\n', 'move-up', 'Z', undefined, '## R\n- P\n    - Z\n        - Z1\n\t- X\n'],
    // Review 1: items the map does not draw (tasks, ordered items) are list lines too, for the unit and for the rewrite.
    ['space branch with a task under a tab list', '## R\n- A\n\t- A1\n\n## S\n- D\n  - [ ] T\n    - T1\n', 'reparent', 'D', 'A', '## R\n- A\n\t- A1\n\t- D\n\t\t- [ ] T\n\t\t\t- T1\n\n## S\n'],
    ['space branch with an ordered item under a tab list', '## R\n- A\n\t- A1\n\n## S\n- D\n  1. O\n     - O1\n', 'reparent', 'D', 'A', '## R\n- A\n\t- A1\n\t- D\n\t\t1. O\n\t\t\t- O1\n\n## S\n'],
    ['list indented only by a task', '## R\n- A\n\t- [ ] t\n- B\n\n## S\n- C\n  - C1\n', 'add-child', 'B', undefined, '## R\n- A\n\t- [ ] t\n- B\n\t- B1\n\n## S\n- C\n  - C1\n'],
    // Review 1: a line whose column does not change keeps its bytes, even if another unit's.
    ['move among siblings keeps an unshifted continuation', '## R\n- A\n- B\n      six-space continuation\n\t- B1\n', 'move-up', 'B', undefined, '## R\n- B\n      six-space continuation\n\t- B1\n- A\n'],
    // Review 1: code keeps its bytes behind the new indentation; its empty lines stay empty; HTML blocks too.
    ['fence with an empty line joining a tab list', '## R\n- A\n\t- A1\n\n## S\n- D\n\n```\na\n\nb\n```\n', 'reparent', 'S', 'A', '## R\n- A\n\t- A1\n\t- S\n\t\t- D\n\n\t  ```\n\t  a\n\n\t  b\n\t  ```\n'],
    ['HTML block joining a tab list', '## R\n- A\n\t- A1\n\n## S\n<pre>\n      x\n</pre>\n', 'reparent', 'S', 'A', '## R\n- A\n\t- A1\n\t- S\n\t  <pre>\n\t        x\n\t  </pre>\n'],
    // Review 2: the list before the first H2 is its own list; frontmatter and comments are not lists; a rule is not an item.
    ['tab list before the first H2', '- A\n\t- A1\n- B\n\n## S\n- D\n  - D1\n', 'add-child', 'B', undefined, '- A\n\t- A1\n- B\n\t- B1\n\n## S\n- D\n  - D1\n'],
    ['unindented list in a tab note with a YAML list in its frontmatter', '---\ntags:\n  - x\n---\n## R\n- A\n\n## S\n- D\n\t- D1\n', 'add-child', 'A', undefined, '---\ntags:\n  - x\n---\n## R\n- A\n\t- B1\n\n## S\n- D\n\t- D1\n'],
    ['tab list with a fence inside a comment', '## R\n- A\n\t%%\n\t```\n\t%%\n\t- A1\n- B\n\n## S\n- C\n  - C1\n', 'add-child', 'B', undefined, '## R\n- A\n\t%%\n\t```\n\t%%\n\t- A1\n- B\n\t- B1\n\n## S\n- C\n  - C1\n'],
    ['tab list with an indented rule', '## R\n- A\n\t- A1\n\n  * * *\n- B\n', 'add-child', 'B', undefined, '## R\n- A\n\t- A1\n\n  * * *\n- B\n\t- B1\n'],
    // Review 2: adding in a mixed list writes spaces, as moving does.
    ['mixed list, child after existing children', '## R\n- P\n\t- X\n    - Z\n', 'add-child', 'P', undefined, '## R\n- P\n\t- X\n    - Z\n    - B1\n'],
    ['mixed list, sibling of a tab item', '## R\n- P\n\t- X\n    - Z\n', 'add-sibling', 'X', undefined, '## R\n- P\n\t- X\n    - B1\n    - Z\n'],
    // Review 3: body text past the item's content column keeps its bytes; comments are not items; CRLF and lazy
    // `2024.` lines are read as the map reads them; the items the map draws decide the unit before tasks do.
    ['body tab past the content column', '## R\n- A\n- B\n  \tfoo\n', 'reparent', 'B', 'A', '## R\n- A\n  - B\n    \tfoo\n'],
    ['list-like line in a comment, moved at the same indent', '## R\n- A\n\t- B\n\t\t%%\n\t\t  - note\n\t\t%%\n\t\tmore\n\t- C\n', 'move-down', 'B', undefined, '## R\n- A\n\t- C\n\t- B\n\t\t%%\n\t\t  - note\n\t\t%%\n\t\tmore\n'],
    ['CRLF tab list with an indented rule', '## R\r\n- A\r\n\t- A1\r\n\r\n  * * *\r\n- B\r\n', 'add-child', 'B', undefined, '## R\r\n- A\r\n\t- A1\r\n\r\n  * * *\r\n- B\r\n\t- B1\r\n'],
    ['tab list with a lazy line starting like an ordered item', '## R\n- A\n\t- A1\n  2024. was a year\n- B\n', 'add-child', 'B', undefined, '## R\n- A\n\t- A1\n  2024. was a year\n- B\n\t- B1\n'],
    ['tab items with a space-indented task in the topic', '## R\n- a\n\t- b\n  - [ ] t\n      - sub\n', 'add-child', 'b', undefined, '## R\n- a\n\t- b\n\t\t- B1\n  - [ ] t\n      - sub\n'],
  ])('%s', (_name, source, type, title, target, expected) => {
    const doc = parse(source);
    const nodeId = find(doc, title).id;
    const command = type === 'reparent' ? { type, nodeId, parentId: find(doc, target ?? '').id } as const
      : type === 'add-child' || type === 'add-sibling' ? { type, nodeId, title: 'B1' } as const
      : { type: type as 'move-up' | 'move-down', nodeId };
    expect(applyEdits(source, planEdit(doc, command).edits)).toBe(expected);
  });

  it('keeps the bytes of code inside a converted branch and moves only its container indentation', () => {
    const source = '## R\n- A\n  - A1\n\n## S\n- D\n\t- D1\n\n\t  ```\n\t  \tcode\n\t  ```\n';
    const doc = parse(source);
    const result = applyEdits(source, planEdit(doc, { type: 'reparent', nodeId: find(doc, 'D').id, parentId: find(doc, 'A').id }).edits);
    expect(result).toBe('## R\n- A\n  - A1\n  - D\n    - D1\n\n      ```\n      \tcode\n      ```\n\n## S\n');
  });

  // Review 2: a paragraph after a blank line ends the nested items to its right; a tab after the marker is measured where it lands.
  it.each([
    ['a topic whose nested item is ended by a paragraph', '## R\n- A\n\t- A1\n\n## S\n- a\n  - b\n\n  para\n    - c\n', 'S', 'A', ['R', 'A', 'A1', 'S', 'a', 'b', 'c'], 'c', 'a'],
    ['a branch whose own marker is followed by a tab (review 3)', '## R\n- A\n  - A1\n\n## S\n-\tB\n       - B1\n', 'B', 'A', ['R', 'A', 'A1', 'B', 'B1', 'S'], 'B1', 'B'],
    ['a branch with a tab after an item marker', '## R\n- A\n   - A1\n\n## S\n- D\n  -\tD1\n    - x\n', 'D', 'A', ['R', 'A', 'A1', 'D', 'D1', 'x', 'S'], 'x', 'D1'],
  ])('keeps the tree when moving %s', (_name, source, title, target, titles, child, parent) => {
    const doc = parse(source);
    const result = parse(applyEdits(source, planEdit(doc, { type: 'reparent', nodeId: find(doc, title).id, parentId: find(doc, target).id }).edits));
    expect(result.nodes.map(node => node.title)).toEqual(titles);
    expect(find(result, child).parentId).toBe(find(result, parent).id);
  });

  it('writes the indentation in front of a fence in the list\'s unit (review 1)', () => {
    const source = '## R\n- A\n  - A1\n\n## S\n- D\n\t```\n\t\tx\n\t```\n';
    const doc = parse(source);
    const result = applyEdits(source, planEdit(doc, { type: 'reparent', nodeId: find(doc, 'D').id, parentId: find(doc, 'A').id }).edits);
    const fences = result.split('\n').filter(line => line.trim() === '```');
    expect(fences).toEqual(['      ```', '      ```']);
    expect(parse(result).nodes.map(node => node.title)).toEqual(['R', 'A', 'A1', 'D', 'S']);
  });

  // Every structure command on every node of notes whose topics are each indented one way: afterwards each topic's
  // list items are still indented one way (the unit of the list they are in, or of the note).
  it.each([
    ['tabs only', '## R\n- A\n\t- A1\n\t\t- A1a\n\t- A2\n- B\n- C\n\t- C1\n\n## S\n- D\n\t- D1\n'],
    ['spaces and tabs by topic', '## R\n- A\n  - A1\n    - A1a\n- B\n\n## S\n- D\n\t- D1\n\t\t- D1a\n- E\n\n## T\n- F\n- G\n'],
    ['tasks, ordered items, fences and HTML by topic', '## R\n- A\n  - [ ] A1\n    - A1a\n  1. A2\n     - A2a\n- B\n  ```\n  \tcode\n  ```\n\n## S\n- D\n\t- [x] D1\n\t\t- D1a\n\t- D2\n\n\t  <div>\n\t    x\n\t  </div>\n- E\n\n## T\n- F\n- G\n'],
  ])('keeps each topic of a note indented with %s to one unit', (_name, source) => {
    const doc = parse(source);
    let applied = 0;
    for (const command of doc.nodes.flatMap((node): EditCommand[] => [
      ...(['add-child', 'add-sibling', 'move-up', 'move-down', 'delete', 'detach'] as const).map(type => ({ type, nodeId: node.id })),
      ...doc.nodes.flatMap((parent): EditCommand[] => [
        { type: 'reparent', nodeId: node.id, parentId: parent.id },
        ...[0, 1, 2].map((index): EditCommand => ({ type: 'move', nodeId: node.id, parentId: parent.id, index })),
      ]),
    ])) {
      let edits;
      try {
        edits = planEdit(doc, command).edits;
      } catch (error) {
        if (!(error instanceof Error) || error.constructor !== Error) throw error;
        continue;
      }
      if (edits.length === 0) continue;
      applied++;
      const result = applyEdits(source, edits);
      for (const topic of result.split(/^(?=## )/mu)) {
        const units = new Set(topic.split('\n').map(line => /^([ \t]+)(?:[-+*]|\d+[.)]) /u.exec(line)?.[1])
          .filter((indent): indent is string => indent !== undefined).map(indent => indent.replace(/(.)\1*/gu, '$1')));
        expect([...units].every(unit => unit.length === 1) && units.size <= 1, `${JSON.stringify(command)} → ${JSON.stringify(result)}`).toBe(true);
      }
    }
    expect(applied).toBeGreaterThan(200);
  });
});
