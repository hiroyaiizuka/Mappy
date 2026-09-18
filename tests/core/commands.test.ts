import { describe, expect, it } from 'vitest';
import { applyEdits, planEdit, resolveDrop, type EditCommand, type TextEdit } from '../../src/core/commands';
import { parseMarkdown as parseDocument, type MindDocument, type MindNode } from '../../src/core/markdown';

// Keep the legacy heading-mode contract explicit as new notes default to lists.
function parseMarkdown(source: string, title: string, previous?: MindDocument): MindDocument {
  return parseDocument(source, title, previous, 'headings');
}

function find(doc: MindDocument, title: string): MindNode {
  const node = doc.nodes.find((candidate) => candidate.title === title);
  if (!node) throw new Error(`Missing fixture heading: ${title}`);
  return node;
}

function execute(doc: MindDocument, command: EditCommand): MindDocument {
  const plan = planEdit(doc, command);
  return parseMarkdown(applyEdits(doc.source, plan.edits), doc.root.title, doc);
}

describe('partial Markdown edits', () => {
  it('renames only the ATX title while preserving frontmatter, markers, links, image, CRLF, and EOF', () => {
    const source = '---\r\nname: note\r\n---\r\n\r\n  ## Old ###  \r\n[[ノート|リンク]]\r\n![[図.png]]';
    const doc = parseMarkdown(source, 'Note');
    const node = find(doc, 'Old');
    const plan = planEdit(doc, { type: 'rename', nodeId: node.id, title: '日本語 😀' });
    expect(plan.edits).toEqual([{ from: node.titleFrom, to: node.titleTo, text: '日本語 😀' }]);
    expect(applyEdits(source, plan.edits)).toBe(source.replace('Old', '日本語 😀'));
  });

  it.each(['#', '# ###'])('safely names an empty ATX heading %j', (source) => {
    const doc = parseMarkdown(source, 'Note');
    const node = doc.nodes[0];
    if (!node) throw new Error('Missing fixture heading');
    expect(execute(doc, { type: 'rename', nodeId: node.id, title: '名前' }).nodes[0]?.title).toBe('名前');
  });

  it('renames a multiline Setext title without changing the underline or body', () => {
    const source = 'Old\r\nmultiline\r\n======\r\nbody';
    const doc = parseMarkdown(source, 'Note');
    const node = doc.nodes[0];
    if (!node) throw new Error('Missing fixture heading');
    expect(execute(doc, { type: 'rename', nodeId: node.id, title: '新しい見出し' }).source)
      .toBe('新しい見出し\r\n======\r\nbody');
  });

  it.each(['改行\n禁止', '改行\r禁止', '改行\u2028禁止'])('rejects malformed titles %j', (title) => {
    const doc = parseMarkdown('# Old', 'Note');
    expect(() => planEdit(doc, { type: 'rename', nodeId: find(doc, 'Old').id, title })).toThrow();
  });

  it('rejects a Setext rename that would change Markdown structure', () => {
    const doc = parseMarkdown('Old\n===\nbody', 'Note');
    expect(() => planEdit(doc, { type: 'rename', nodeId: find(doc, 'Old').id, title: '# Hijack' })).toThrow();
    expect(() => planEdit(doc, { type: 'rename', nodeId: find(doc, 'Old').id, title: '' })).toThrow('Setext');
  });

  it.each(['# Named', '## Named ###\r\nbody', '#', '# #', '# ###'])('allows an empty ATX name and returns its parsed title position: %j', (source) => {
    const doc = parseMarkdown(source, 'Note');
    const node = doc.nodes[0];
    if (!node) throw new Error('Missing fixture heading');
    const plan = planEdit(doc, { type: 'rename', nodeId: node.id, title: '' });
    const result = parseMarkdown(applyEdits(source, plan.edits), 'Note');
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.title).toBe('');
    expect(result.nodes[0]?.level).toBe(node.level);
    expect(plan.selectionOffset).toBe(result.nodes[0]?.titleFrom);
  });

  it('adds children and peers at subtree boundaries and selects the inserted title', () => {
    const doc = parseMarkdown('# Parent\r\nbody\r\n\r\n## Child\r\nchild body\r\n\r\n# Peer', 'Note');
    const parent = find(doc, 'Parent');
    const plan = planEdit(doc, { type: 'add-child', nodeId: parent.id });
    const result = applyEdits(doc.source, plan.edits);
    const parsed = parseMarkdown(result, 'Note');
    expect(plan.selectionOffset).toBe(find(parsed, '').titleFrom);
    expect(find(parsed, 'Parent').children.map((node) => node.title)).toEqual(['Child', '']);
    expect(result.replace(/\r\n/gu, '')).not.toContain('\n');
    const sibling = execute(doc, { type: 'add-sibling', nodeId: parent.id });
    expect(sibling.root.children.map((node) => node.title)).toEqual(['Parent', '', 'Peer']);
  });

  it('adds a root child after frontmatter and preamble without requiring an existing heading', () => {
    const doc = parseMarkdown('---\nauthor: person\n---\nPreamble', 'Note');
    const result = execute(doc, { type: 'add-child', nodeId: 'root' });
    expect(result.source).toBe(`${doc.source}\n\n# `);
    expect(result.nodes[0]?.parentId).toBe('root');
  });

  it.each(['', '---\r\nname: note\r\n---'])('adds a root child to an empty or YAML-only document without an EOF newline %j', (source) => {
    const doc = parseMarkdown(source, 'Note');
    const result = execute(doc, { type: 'add-child', nodeId: 'root' });
    expect(result.source.startsWith(source)).toBe(true);
    expect(result.nodes.map((node) => [node.title, node.parentId])).toEqual([['', 'root']]);
    expect(result.source.endsWith('\n')).toBe(false);
  });

  it.each(['', '---\r\nname: note\r\n---', '# Parent', '# Parent\n', '## Parent\r\n### Child\r\n'])('returns the parsed empty title offset for root additions: %j', (source) => {
    const doc = parseMarkdown(source, 'Note');
    const plan = planEdit(doc, { type: 'add-child', nodeId: 'root' });
    const parsed = parseMarkdown(applyEdits(source, plan.edits), 'Note');
    const added = parsed.nodes[parsed.nodes.length - 1];
    expect(added?.title).toBe('');
    expect(added?.kind).toBe('atx');
    expect(added?.parentId).toBe('root');
    expect(plan.selectionOffset).toBe(added?.titleFrom);
  });

  it('selects the inserted empty sibling by offset among other empty nodes', () => {
    const doc = parseMarkdown('# \n\n# ', 'Note');
    const first = doc.nodes[0];
    if (!first) throw new Error('Missing fixture heading');
    const plan = planEdit(doc, { type: 'add-sibling', nodeId: first.id });
    const parsed = parseMarkdown(applyEdits(doc.source, plan.edits), 'Note', doc);
    expect(parsed.nodes.map((node) => node.title)).toEqual(['', '', '']);
    expect(plan.selectionOffset).toBe(parsed.nodes[1]?.titleFrom);
    expect(plan.selectionOffset).not.toBe(parsed.nodes[0]?.titleFrom);
    expect(plan.selectionOffset).not.toBe(parsed.nodes[2]?.titleFrom);
  });

  it('refuses to add headings inside unfinished YAML or a code fence', () => {
    for (const source of ['---\nname: unfinished', '# Parent\n\n```md\nopen']) {
      const doc = parseMarkdown(source, 'Note');
      expect(() => planEdit(doc, { type: 'add-child', nodeId: 'root' })).toThrow();
    }
  });

  it('deletes a complete subtree and preserves adjacent bytes', () => {
    const prefix = '---\nkey: value\n---\nPreamble\n\n';
    const branch = '# Delete\nbody\n\n## Child\n[[link]]\n\n';
    const suffix = '# Keep\n![[image.png]]';
    const doc = parseMarkdown(prefix + branch + suffix, 'Note');
    expect(execute(doc, { type: 'delete', nodeId: find(doc, 'Delete').id }).source).toBe(prefix + suffix);
  });

  it('moves siblings with their bodies and descendants without merging an EOF heading', () => {
    const doc = parseMarkdown('# First\nfirst body\n\n## Child\n[[link]]\n\n# Last\nlast body', 'Note');
    const moved = execute(doc, { type: 'move-up', nodeId: find(doc, 'Last').id });
    expect(moved.root.children.map((node) => node.title)).toEqual(['Last', 'First']);
    expect(find(moved, 'First').children.map((node) => node.title)).toEqual(['Child']);
    expect(moved.source).toContain('last body\n\n# First');
    expect(moved.source).toContain('## Child\n[[link]]');
    expect(moved.source.endsWith('\n')).toBe(false);
  });

  it('round-trips sibling moves with frontmatter, duplicate headings, and CRLF without an EOF newline', () => {
    const source = '---\r\nname: note\r\n---\r\n\r\n# Same\r\nfirst body\r\n\r\n# Same\r\nlast body';
    const doc = parseMarkdown(source, 'Note');
    const last = doc.nodes[1];
    if (!last) throw new Error('Missing fixture heading');
    const up = execute(doc, { type: 'move-up', nodeId: last.id });
    expect(up.source).toContain('last body\r\n\r\n# Same');
    expect(up.nodes.every((node) => !doc.nodes.some((old) => old.id === node.id))).toBe(true);
    const first = up.nodes[0];
    if (!first) throw new Error('Missing moved heading');
    expect(execute(up, { type: 'move-down', nodeId: first.id }).source).toBe(source);
  });

  it('maintains sibling relationships when original Markdown skips heading depths', () => {
    const doc = parseMarkdown('# Parent\n\n### Deep\n\n## Shallow\n', 'Note');
    const moved = execute(doc, { type: 'move-up', nodeId: find(doc, 'Shallow').id });
    expect(find(moved, 'Parent').children.map((node) => [node.title, node.level])).toEqual([
      ['Shallow', 3], ['Deep', 3],
    ]);
    const boundary = planEdit(moved, { type: 'move-up', nodeId: find(moved, 'Shallow').id });
    expect(boundary.edits).toEqual([]);
  });

  it('reparents a branch and adjusts all descendant levels while preserving body content', () => {
    const doc = parseMarkdown('# Move\nBody [[link]]\n\n## Child\n![[image.png]]\n\n# Destination\nTail', 'Note');
    const plan = planEdit(doc, { type: 'reparent', nodeId: find(doc, 'Move').id, parentId: find(doc, 'Destination').id });
    const result = applyEdits(doc.source, plan.edits);
    const moved = parseMarkdown(result, 'Note');
    expect(moved.root.children.map((node) => node.title)).toEqual(['Destination']);
    expect(find(moved, 'Move').level).toBe(2);
    expect(find(moved, 'Child').level).toBe(3);
    expect(result).toContain('Body [[link]]');
    expect(result).toContain('![[image.png]]');
    expect(result.slice(plan.selectionOffset ?? 0).startsWith('Move')).toBe(true);
  });

  it('handles reparenting to an earlier adjacent branch and back to the root', () => {
    const doc = parseMarkdown('# Destination\ntext\n\n# Move\nbody', 'Note');
    const nested = execute(doc, { type: 'reparent', nodeId: find(doc, 'Move').id, parentId: find(doc, 'Destination').id });
    expect(find(nested, 'Destination').children.map((node) => node.title)).toEqual(['Move']);
    const promoted = execute(nested, { type: 'reparent', nodeId: find(nested, 'Move').id, parentId: 'root' });
    expect(promoted.root.children.map((node) => node.title)).toEqual(['Destination', 'Move']);
  });

  it('preserves the absence of an EOF newline when reparenting the final branch into an earlier non-adjacent parent', () => {
    const doc = parseMarkdown('---\r\nname: note\r\n---\r\n# Destination\r\nbody\r\n\r\n# Retained\r\nkeep\r\n\r\n# Move\r\nlast', 'Note');
    const moved = execute(doc, { type: 'reparent', nodeId: find(doc, 'Move').id, parentId: find(doc, 'Destination').id });
    expect(moved.source.startsWith('---\r\nname: note\r\n---\r\n')).toBe(true);
    expect(find(moved, 'Destination').children.map((node) => node.title)).toEqual(['Move']);
    expect(moved.source.endsWith('# Retained\r\nkeep')).toBe(true);
  });

  it('preserves hidden comment headings through moves and refuses insertion into an unclosed comment', () => {
    const doc = parseMarkdown('# Move\n%%\n## Hidden\n%%\n\n# Destination', 'Note');
    const moved = execute(doc, { type: 'reparent', nodeId: find(doc, 'Move').id, parentId: find(doc, 'Destination').id });
    expect(moved.nodes.map((node) => node.title)).toEqual(['Destination', 'Move']);
    expect(moved.source).toContain('%%\n## Hidden\n%%');
    const unfinished = parseMarkdown('%%\ncomment', 'Note');
    expect(() => planEdit(unfinished, { type: 'add-child', nodeId: 'root' })).toThrow();
  });

  it('converts only moved Setext headings when their depth changes', () => {
    const doc = parseMarkdown('Move\n====\nbody\n\nDestination\n===========\n', 'Note');
    const moved = execute(doc, { type: 'reparent', nodeId: find(doc, 'Move').id, parentId: find(doc, 'Destination').id });
    expect(find(moved, 'Move').kind).toBe('atx');
    expect(find(moved, 'Move').level).toBe(2);
    expect(find(moved, 'Destination').kind).toBe('setext');
    expect(moved.source).toContain('Destination\n===========');
  });

  it('rejects cycles, root changes, unknown IDs, and depth overflow including descendants', () => {
    const doc = parseMarkdown('# Parent\n\n## Child\n\n###### Deep\n\n# Target\n', 'Note');
    expect(() => planEdit(doc, { type: 'reparent', nodeId: find(doc, 'Parent').id, parentId: find(doc, 'Child').id })).toThrow();
    expect(() => planEdit(doc, { type: 'reparent', nodeId: find(doc, 'Parent').id, parentId: find(doc, 'Parent').id })).toThrow();
    expect(() => planEdit(doc, { type: 'reparent', nodeId: find(doc, 'Parent').id, parentId: find(doc, 'Target').id })).toThrow();
    expect(() => planEdit(doc, { type: 'add-child', nodeId: find(doc, 'Deep').id })).toThrow();
    expect(() => planEdit(doc, { type: 'delete', nodeId: 'root' })).toThrow();
    expect(() => planEdit(doc, { type: 'rename', nodeId: 'gone', title: 'New' })).toThrow();
  });

  it('targets the requested duplicate node without changing its namesake', () => {
    const doc = parseMarkdown('# Same\none\n\n# Same\ntwo', 'Note');
    const second = doc.nodes[1];
    if (!second) throw new Error('Missing fixture heading');
    expect(execute(doc, { type: 'rename', nodeId: second.id, title: 'Changed' }).source)
      .toBe('# Same\none\n\n# Changed\ntwo');
  });
});

describe('positioned moves for drag and drop (heading format)', () => {
  it('moves a branch with its body and descendants before a sibling under another parent', () => {
    const doc = parseMarkdown('# A\n\n## A1\na1 body [[link]]\n\n### A1a\n![[image.png]]\n\n## A2\n\n# B\n\n## B1\n\n## B2\n', 'Note');
    const plan = planEdit(doc, { type: 'move', nodeId: find(doc, 'A1').id, parentId: find(doc, 'B').id, index: 1 });
    const source = applyEdits(doc.source, plan.edits);
    expect(source).toBe('# A\n\n## A2\n\n# B\n\n## B1\n\n## A1\na1 body [[link]]\n\n### A1a\n![[image.png]]\n\n## B2\n');
    const result = parseMarkdown(source, 'Note');
    expect(find(result, 'B').children.map((node) => node.title)).toEqual(['B1', 'A1', 'B2']);
    expect(find(result, 'A1').children.map((node) => node.title)).toEqual(['A1a']);
    expect(plan.selectionOffset).toBe(find(result, 'A1').titleFrom);
  });

  it('appends after the last root sibling, adopts its depth, and keeps the missing EOF newline', () => {
    const doc = parseMarkdown('# First\nbody\n\n### Deep\n\n# Last\nlast', 'Note');
    const result = execute(doc, { type: 'move', nodeId: find(doc, 'First').id, parentId: 'root', index: 1 });
    expect(result.source).toBe('# Last\nlast\n\n# First\nbody\n\n### Deep');
    expect(find(result, 'First').children.map((node) => node.title)).toEqual(['Deep']);
  });

  it('keeps a single EOF newline when the moved section lands at the end of the document', () => {
    const doc = parseMarkdown('# A\n\n# B\n\n# C\n', 'Note');
    expect(execute(doc, { type: 'move', nodeId: find(doc, 'A').id, parentId: 'root', index: 2 }).source)
      .toBe('# B\n\n# C\n\n# A\n');
  });

  it('reorders non-adjacent siblings and moves only the requested duplicate title', () => {
    const doc = parseMarkdown('# Same\none\n\n## Child\n\n# Same\ntwo\n\n# Other\n', 'Note');
    const second = doc.nodes.filter((node) => node.title === 'Same')[1];
    if (!second) throw new Error('Missing duplicate heading');
    const result = execute(doc, { type: 'move', nodeId: second.id, parentId: 'root', index: 0 });
    expect(result.source).toBe('# Same\ntwo\n\n# Same\none\n\n## Child\n\n# Other\n');
    expect(result.root.children.map((node) => node.children.map((child) => child.title))).toEqual([[], ['Child'], []]);
  });

  it('inserts before a deeper sibling using that sibling depth so the structure is unchanged', () => {
    const doc = parseMarkdown('# P\n\n### Deep\n\n## Shallow\n\n# Q\n\n## X\n', 'Note');
    const result = execute(doc, { type: 'move', nodeId: find(doc, 'X').id, parentId: find(doc, 'P').id, index: 0 });
    expect(result.source).toBe('# P\n\n### X\n\n### Deep\n\n## Shallow\n\n# Q\n');
    expect(find(result, 'P').children.map((node) => [node.title, node.level])).toEqual([['X', 3], ['Deep', 3], ['Shallow', 2]]);
    expect(find(result, 'Q').children).toEqual([]);
  });

  it('moves a branch under a collapsed-depth parent and refuses moves past heading level six', () => {
    const doc = parseMarkdown('# P\n\n## C\n\n###### Deep\n\n# T\n\n## T1\n', 'Note');
    expect(() => planEdit(doc, { type: 'move', nodeId: find(doc, 'C').id, parentId: find(doc, 'T1').id, index: 0 })).toThrow('6 階層');
    const result = execute(doc, { type: 'move', nodeId: find(doc, 'C').id, parentId: find(doc, 'T').id, index: 1 });
    expect(result.source).toBe('# P\n\n# T\n\n## T1\n\n## C\n\n###### Deep\n');
  });

  it('rejects self, descendants, the root, and out-of-range positions, and returns no edits for the same position', () => {
    const doc = parseMarkdown('# P\n\n## Child\n\n# Q\n', 'Note');
    const parent = find(doc, 'P');
    expect(() => planEdit(doc, { type: 'move', nodeId: parent.id, parentId: parent.id, index: 0 })).toThrow();
    expect(() => planEdit(doc, { type: 'move', nodeId: parent.id, parentId: find(doc, 'Child').id, index: 0 })).toThrow();
    expect(() => planEdit(doc, { type: 'move', nodeId: 'root', parentId: parent.id, index: 0 })).toThrow();
    expect(() => planEdit(doc, { type: 'move', nodeId: parent.id, parentId: 'root', index: -1 })).toThrow();
    expect(() => planEdit(doc, { type: 'move', nodeId: parent.id, parentId: 'root', index: 2 })).toThrow();
    expect(() => planEdit(doc, { type: 'move', nodeId: parent.id, parentId: 'root', index: 0.5 })).toThrow();
    expect(planEdit(doc, { type: 'move', nodeId: parent.id, parentId: 'root', index: 0 }))
      .toEqual({ edits: [], selectionOffset: parent.titleFrom });
    expect(planEdit(doc, { type: 'move', nodeId: find(doc, 'Q').id, parentId: 'root', index: 1 }).edits).toEqual([]);
  });
});

describe('drop resolution', () => {
  it('maps before, after, and inside positions to parent and index without the dragged node', () => {
    const doc = parseMarkdown('# A\n\n## A1\n\n## A2\n\n## A3\n\n# B\n', 'Note');
    const a1 = find(doc, 'A1');
    const a3 = find(doc, 'A3');
    const a = find(doc, 'A');
    expect(resolveDrop(doc, a3.id, a1.id, 'before')).toEqual({ type: 'move', nodeId: a3.id, parentId: a.id, index: 0 });
    expect(resolveDrop(doc, a3.id, a1.id, 'after')).toEqual({ type: 'move', nodeId: a3.id, parentId: a.id, index: 1 });
    expect(resolveDrop(doc, a1.id, a3.id, 'after')).toEqual({ type: 'move', nodeId: a1.id, parentId: a.id, index: 2 });
    expect(resolveDrop(doc, a1.id, find(doc, 'B').id, 'inside')).toEqual({ type: 'move', nodeId: a1.id, parentId: find(doc, 'B').id, index: 0 });
    expect(resolveDrop(doc, find(doc, 'B').id, a.id, 'inside')).toEqual({ type: 'move', nodeId: find(doc, 'B').id, parentId: a.id, index: 3 });
    expect(resolveDrop(doc, find(doc, 'B').id, a.id, 'before')).toEqual({ type: 'move', nodeId: find(doc, 'B').id, parentId: 'root', index: 0 });
  });

  it('refuses the dragged node itself, its descendants, the root, unknown ids, and depth overflow', () => {
    const doc = parseMarkdown('# P\n\n## C\n\n###### Deep\n\n# T\n\n## T1\n', 'Note');
    const p = find(doc, 'P');
    const c = find(doc, 'C');
    expect(resolveDrop(doc, p.id, p.id, 'inside')).toBeNull();
    expect(resolveDrop(doc, p.id, p.id, 'before')).toBeNull();
    expect(resolveDrop(doc, p.id, c.id, 'before')).toBeNull();
    expect(resolveDrop(doc, p.id, find(doc, 'Deep').id, 'inside')).toBeNull();
    expect(resolveDrop(doc, 'root', p.id, 'inside')).toBeNull();
    expect(resolveDrop(doc, p.id, 'missing', 'inside')).toBeNull();
    expect(resolveDrop(doc, c.id, find(doc, 'T1').id, 'inside')).toBeNull();
    expect(resolveDrop(doc, c.id, find(doc, 'T1').id, 'after')).toEqual({ type: 'move', nodeId: c.id, parentId: find(doc, 'T').id, index: 1 });
  });
});

describe('text edit validation', () => {
  it('applies original-coordinate edits regardless of input ordering', () => {
    expect(applyEdits('abcdef', [{ from: 4, to: 6, text: '!' }, { from: 0, to: 1, text: 'A' }])).toBe('Abcd!');
  });

  it.each<TextEdit[]>([
    [{ from: -1, to: 0, text: '' }], [{ from: 0, to: 7, text: '' }],
    [{ from: 2, to: 1, text: '' }], [{ from: 0.5, to: 1, text: '' }],
    [{ from: 0, to: 3, text: '' }, { from: 2, to: 4, text: '' }],
    [{ from: 1, to: 1, text: 'A' }, { from: 1, to: 1, text: 'B' }],
  ])('rejects invalid or overlapping ranges %j', (...edits) => {
    expect(() => applyEdits('abcdef', edits)).toThrow();
  });
});
