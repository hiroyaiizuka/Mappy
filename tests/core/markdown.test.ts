import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../src/core/markdown';

describe('source-preserving Markdown projection', () => {
  it('uses H2 roots and real nested unordered lists when no other heading depths exist', () => {
    const source = '## Root\nRoot body\n\n- First\n  - Child\n    - Grandchild\n- Peer\n';
    const doc = parseMarkdown(source, 'File');
    expect(doc.format).toBe('list');
    expect(doc.nodes.map(node => [node.title, node.level, node.kind])).toEqual([
      ['Root', 2, 'atx'], ['First', 3, 'list'], ['Child', 4, 'list'], ['Grandchild', 5, 'list'], ['Peer', 3, 'list'],
    ]);
    expect(doc.root.children[0]?.children.map(node => node.title)).toEqual(['First', 'Peer']);
    expect(doc.root.children[0]?.children[0]?.children[0]?.children[0]?.title).toBe('Grandchild');
    expect(doc.source).toBe(source);
  });

  it('keeps legacy heading documents and their ordinary body lists unchanged', () => {
    const source = '## Root\n- Body list\n  - Nested body\n### Child\n- Another body\n';
    const doc = parseMarkdown(source, 'File');
    expect(doc.format).toBe('headings');
    expect(doc.nodes.map(node => [node.title, node.kind])).toEqual([['Root', 'atx'], ['Child', 'atx']]);
    expect(source.slice(doc.nodes[0]?.bodyFrom, doc.nodes[0]?.bodyTo)).toBe('- Body list\n  - Nested body\n');
  });

  it('groups lists under their nearest H2 and lists before headings under the virtual root', () => {
    const source = '- Before\n\n## One\n- A\n\n## Two\n- B\n  - C';
    const doc = parseMarkdown(source, 'File');
    expect(doc.root.children.map(node => node.title)).toEqual(['Before', 'One', 'Two']);
    expect(doc.nodes.find(node => node.title === 'One')?.children.map(node => node.title)).toEqual(['A']);
    expect(doc.nodes.find(node => node.title === 'Two')?.children[0]?.children[0]?.title).toBe('C');
    expect(doc.nodes.find(node => node.title === 'One')?.to).toBe(source.indexOf('## Two'));
    expect(doc.nodes.find(node => node.title === 'Before')?.level).toBe(1);
  });

  it.each(['  ', '    ', '\t'])('derives list nesting from CommonMark indentation %j', indent => {
    const source = `## Root\r\n- Parent\r\n${indent}+ Child\r\n${indent}${indent}* Grandchild\r\n- Peer\r\n`;
    const doc = parseMarkdown(source, 'File');
    const parent = doc.nodes.find(node => node.title === 'Parent');
    const child = doc.nodes.find(node => node.title === 'Child');
    expect(parent?.children[0]).toBe(child);
    expect(child?.children[0]?.title).toBe('Grandchild');
    expect(child?.list).toEqual({ indent, marker: '+', contentIndent: ' '.repeat(indent === '\t' ? 6 : indent.length + 2) });
    expect(child?.from).toBe(source.indexOf(`${indent}+ Child`));
    expect(doc.eol).toBe('\r\n');
    expect(source.slice(child?.from, child?.headingTo)).toBe(`${indent}+ Child`);
  });

  it('supports list depth beyond H6 and reflects indentation changes with stable unique IDs', () => {
    const source = '## Root\n' + Array.from({ length: 12 }, (_, index) => `${'  '.repeat(index)}- Node ${index}`).join('\n');
    const first = parseMarkdown(source, 'File');
    expect(first.nodes).toHaveLength(13);
    expect(first.nodes[12]?.level).toBe(14);
    const changed = parseMarkdown(source.replace('  - Node 1', '- Node 1'), 'File', first);
    expect(changed.nodes.find(node => node.title === 'Node 1')?.parentId).toBe(changed.nodes[0]?.id);
    expect(changed.nodes.find(node => node.title === 'Node 1')?.id).toBe(first.nodes[2]?.id);
  });

  it('separates first-line titles, continuation body, nested lists, and parent trailing prose', () => {
    const source = '## Root\r\n- Parent\r\n  Direct body\r\n  - Child\r\n    Child body\r\n\r\n  Parent trailing prose\r\n\r\n- Peer\r\n\r\nOutside list\r\n';
    const doc = parseMarkdown(source, 'File');
    const parent = doc.nodes.find(node => node.title === 'Parent');
    const child = doc.nodes.find(node => node.title === 'Child');
    const peer = doc.nodes.find(node => node.title === 'Peer');
    if (!parent || !child || !peer) throw new Error('Missing list nodes');
    expect(source.slice(parent.bodyFrom, parent.bodyTo)).toBe('  Direct body\r\n');
    expect(source.slice(child.bodyFrom, child.bodyTo)).toBe('    Child body');
    expect(source.slice(child.from, child.to)).toBe('  - Child\r\n    Child body');
    expect(source.slice(parent.from, parent.to)).toBe('- Parent\r\n  Direct body\r\n  - Child\r\n    Child body\r\n\r\n  Parent trailing prose');
    expect(source.slice(peer.from, peer.to)).toBe('- Peer');
    expect(source.slice(peer.to).startsWith('\r\n\r\nOutside list')).toBe(true);
  });

  it('preserves raw first-line links/images and accepts empty list items', () => {
    const source = '## Root\n- [[日本語|別名]] ![[図.png]] [web](https://example.com)\n  - \n- ';
    const doc = parseMarkdown(source, 'File');
    expect(doc.nodes.slice(1).map(node => node.title)).toEqual(['[[日本語|別名]] ![[図.png]] [web](https://example.com)', '', '']);
    const empty = doc.nodes[2];
    expect(empty?.titleFrom).toBe(empty?.titleTo);
    expect(empty?.list).toEqual({ indent: '  ', marker: '-', contentIndent: '    ' });
    expect(doc.nodes[3]?.bodyFrom).toBe(source.length);
  });

  it('excludes YAML, comments, quoted lists, fenced and indented code from list nodes', () => {
    const source = [
      '---', 'items:', '  - YAML', '---', '## Root',
      '%%', '- Hidden comment', '%%', '', '```md', '- Fence', '```', '',
      '> - Quoted', '', '    - Indented code', '', '- Visible',
      '  ```md', '  - Nested fence', '  ```', '  > - Nested quote',
      '  %%', '  - Nested comment', '  %%', '  - Visible child',
    ].join('\n');
    const doc = parseMarkdown(source, 'File');
    expect(doc.nodes.map(node => node.title)).toEqual(['Root', 'Visible', 'Visible child']);
    expect(doc.nodes[1]?.children[0]?.id).toBe(doc.nodes[2]?.id);
    expect(doc.source).toBe(source);
  });

  it('preserves ordered and task list branches as opaque source', () => {
    const source = '## Root\n- [ ] Task\n  - Task child\n- [x] Done\n1. Ordered\n   - Ordered child\n- Visible\n  1. Nested ordered\n     - Hidden\n  - Child';
    const doc = parseMarkdown(source, 'File');
    expect(doc.nodes.map(node => node.title)).toEqual(['Root', 'Visible', 'Child']);
    expect(doc.source).toBe(source);
  });

  it('keeps duplicate list IDs unique and never guesses their correspondence after a change', () => {
    const source = '## Root\n- Same\n  One\n- Same\n  Two';
    const first = parseMarkdown(source, 'File');
    expect(new Set(first.nodes.map(node => node.id)).size).toBe(3);
    expect(parseMarkdown(source, 'File', first).nodes.map(node => node.id)).toEqual(first.nodes.map(node => node.id));
    const changed = parseMarkdown(`${source}\n`, 'File', first);
    expect(changed.nodes.filter(node => node.title === 'Same').every(node => !first.nodes.some(old => old.id === node.id))).toBe(true);
    expect(changed.nodes[0]?.id).toBe(first.nodes[0]?.id);
  });

  it('supports an explicit parsing format for safe edit validation without changing automatic detection', () => {
    const source = '## Root\n- Child';
    expect(parseMarkdown(source, 'File').format).toBe('list');
    expect(parseMarkdown(source, 'File', undefined, 'headings').nodes.map(node => node.title)).toEqual(['Root']);
    expect(parseMarkdown('', 'File', undefined, 'headings').format).toBe('headings');
    expect(parseMarkdown('- Standalone', 'File').nodes[0]?.kind).toBe('list');
  });

  it('does not let commented fake fences or protected non-H2 headings select legacy mode', () => {
    const source = [
      '## Root', '%%', '```md', '# Hidden', '%%', '- Visible', '',
      '```md', '### Fenced', '- Hidden list', '```', '', '> # Quoted', '',
      '<!--', '# HTML comment', '-->', '', '%%', '# Another hidden', '%%', '- Peer',
    ].join('\n');
    const doc = parseMarkdown(source, 'File');
    expect(doc.format).toBe('list');
    expect(doc.nodes.map(node => node.title)).toEqual(['Root', 'Visible', 'Peer']);
    expect(doc.nodes.slice(1).every(node => node.parentId === doc.nodes[0]?.id)).toBe(true);
  });

  it('keeps parent prose between separate nested lists outside both child ranges', () => {
    const source = '## Root\n- Parent\n  Intro\n  - First\n\n  Parent middle\n\n  + Second\n\n  Parent ending\n\n- Peer\n\n## Next\n- Last';
    const doc = parseMarkdown(source, 'File');
    const parent = doc.nodes.find(node => node.title === 'Parent');
    const first = doc.nodes.find(node => node.title === 'First');
    const second = doc.nodes.find(node => node.title === 'Second');
    if (!parent || !first || !second) throw new Error('Missing list fixture');
    expect(parent.children.map(node => node.title)).toEqual(['First', 'Second']);
    expect(source.slice(first.from, first.to)).toBe('  - First');
    expect(source.slice(second.from, second.to)).toBe('  + Second');
    expect(source.slice(first.to, second.from)).toBe('\n\n  Parent middle\n\n');
    expect(source.slice(second.to, parent.to)).toBe('\n\n  Parent ending');
    expect(source.slice(parent.bodyFrom, parent.bodyTo)).toBe('  Intro\n');
    for (const node of doc.nodes) {
      expect(node.from).toBeLessThanOrEqual(node.titleFrom);
      expect(node.titleFrom).toBeLessThanOrEqual(node.titleTo);
      expect(node.titleTo).toBeLessThanOrEqual(node.headingTo);
      expect(node.headingTo).toBeLessThanOrEqual(node.bodyFrom);
      expect(node.bodyFrom).toBeLessThanOrEqual(node.bodyTo);
      expect(node.bodyTo).toBeLessThanOrEqual(node.to);
    }
  });

  it('reconnects retained parent identities after a unique list title edit with CRLF and emoji', () => {
    const source = '## Root\r\n- 日本語😀\r\n  - Child\r\n- Peer';
    const first = parseMarkdown(source, 'File');
    const changed = parseMarkdown(source.replace('日本語😀', '新しい日本語😀'), 'File', first);
    expect(changed.nodes.map(node => node.id)).toEqual(first.nodes.map(node => node.id));
    expect(changed.nodes[1]?.children[0]?.parentId).toBe(first.nodes[1]?.id);
    const parent = changed.nodes[1];
    expect(changed.source.slice(parent?.titleFrom, parent?.titleTo)).toBe('新しい日本語😀');
  });

  it('places an H2-first hierarchy directly under the virtual root without synthesizing an H1', () => {
    const doc = parseMarkdown('## First\n\n### Child\n\n#### Grandchild\n\n### Peer', 'File title');
    expect(doc.root.title).toBe('File title');
    expect(doc.root.children.map((node) => [node.title, node.level, node.parentId])).toEqual([['First', 2, 'root']]);
    const first = doc.root.children[0];
    expect(first?.children.map((node) => [node.title, node.level])).toEqual([['Child', 3], ['Peer', 3]]);
    expect(first?.children[0]?.children.map((node) => [node.title, node.level])).toEqual([['Grandchild', 4]]);
    expect(doc.nodes).toHaveLength(4);
  });

  it.each([2, 3, 4])('attaches a first H%i heading to the virtual root', (level) => {
    const doc = parseMarkdown(`${'#'.repeat(level)} First`, 'Note');
    expect(doc.root.children).toHaveLength(1);
    expect(doc.root.children[0]?.parentId).toBe('root');
    expect(doc.root.children[0]?.level).toBe(level);
  });

  it('recognizes only document-level headings outside YAML, fences, lists, quotes, HTML, and indented code', () => {
    const source = [
      '---', 'title: 日本語 😀', '# YAML text', '---', '', '# Real', '',
      '```md', '# In a fence', '```', '', '> # Quoted', '', '- # List heading', '',
      '    # Indented code', '', '<!--', '# Comment', '-->', '', 'Second', '======', '',
      '### Skipped depth', '', '## Last', '',
    ].join('\r\n');
    const doc = parseMarkdown(source, 'Note');
    expect(doc.nodes.map((node) => [node.title, node.level, node.kind])).toEqual([
      ['Real', 1, 'atx'], ['Second', 1, 'setext'], ['Skipped depth', 3, 'atx'], ['Last', 2, 'atx'],
    ]);
    expect(doc.source).toBe(source);
    expect(doc.eol).toBe('\r\n');
    expect(doc.root.children.map((node) => node.title)).toEqual(['Real', 'Second']);
    expect(doc.nodes[1]?.children.map((node) => node.title)).toEqual(['Skipped depth', 'Last']);
    expect(source.slice(doc.root.bodyFrom).startsWith('\r\n# Real')).toBe(true);
  });

  it('separates direct body and full subtree ranges, including indentation and CRLF boundaries', () => {
    const source = 'Preamble\r\n\r\n  # Parent ##\r\n本文\r\n\r\n### Child\r\n![[図.png]]\r\n\r\n# Peer';
    const doc = parseMarkdown(source, 'Note');
    const [parent, child, peer] = doc.nodes;
    if (!parent || !child || !peer) throw new Error('Missing fixture headings');
    expect(source.slice(parent.from, parent.headingTo)).toBe('  # Parent ##');
    expect(source.slice(parent.titleFrom, parent.titleTo)).toBe('Parent');
    expect(source.slice(parent.bodyFrom, parent.bodyTo)).toBe('本文\r\n\r\n');
    expect(parent.to).toBe(peer.from);
    expect(child.to).toBe(peer.from);
    expect(source.slice(doc.root.bodyFrom, doc.root.bodyTo)).toBe('Preamble\r\n\r\n');
    expect(peer.bodyFrom).toBe(source.length);
  });

  it('keeps multiline Setext title ranges and original underline intact', () => {
    const source = 'First line\r\nsecond line  \r\n  ======\r\nbody';
    const node = parseMarkdown(source, 'Note').nodes[0];
    if (!node) throw new Error('Missing fixture heading');
    expect(node.kind).toBe('setext');
    expect(node.title).toBe('First line\r\nsecond line');
    expect(source.slice(node.bodyFrom, node.bodyTo)).toBe('body');
  });

  it('keeps unfinished frontmatter opaque and accepts a BOM without shifting UTF-16 offsets', () => {
    expect(parseMarkdown('---\ntitle: open\n# Not a heading', 'Note').nodes).toEqual([]);
    const source = '\uFEFF---\nname: 😀\n...\n# 日本語';
    const node = parseMarkdown(source, 'Note').nodes[0];
    expect(node?.from).toBe(source.indexOf('#'));
    expect(node?.title).toBe('日本語');
  });

  it('masks Obsidian block comments without changing source offsets or comment bytes', () => {
    const source = '---\r\nname: %%literal%%\r\n---\r\n%% 日本語 😀\r\n# Hidden\r\nSetext\r\n=====\r\n%%\r\n# Visible';
    const doc = parseMarkdown(source, 'Note');
    expect(doc.nodes.map((node) => node.title)).toEqual(['Visible']);
    expect(doc.nodes[0]?.from).toBe(source.indexOf('# Visible'));
    expect(doc.source).toBe(source);
  });

  it('ignores comment delimiters inside parsed inline, fenced, indented code and HTML comments', () => {
    const source = [
      '`%%`', '', '```md', '%%', '```', '', '    %%', '', '<!-- %% -->', '',
      '# Before', '', '%% comment', '# Hidden', '%%', '', '# After',
    ].join('\n');
    expect(parseMarkdown(source, 'Note').nodes.map((node) => node.title)).toEqual(['Before', 'After']);
  });

  it('does not let code syntax inside a comment hide a later comment delimiter', () => {
    const source = '%%\n```md\n%%\n# Visible\n\n%%\n# Hidden\n%%\n# Last';
    expect(parseMarkdown(source, 'Note').nodes.map((node) => node.title)).toEqual(['Visible', 'Last']);
  });

  it('rechecks literal code after a commented-out fence that distorted the preliminary syntax tree', () => {
    const source = '%%\n```md\n%%\n# Visible\n\n`%%`\n\n~~~md\n%%\n~~~\n\n# Last';
    expect(parseMarkdown(source, 'Note').nodes.map((node) => node.title)).toEqual(['Visible', 'Last']);
  });

  it('treats an unclosed comment as opaque while leaving escaped percent signs literal', () => {
    expect(parseMarkdown('# Before\n\n%%\n# Hidden', 'Note').nodes.map((node) => node.title)).toEqual(['Before']);
    expect(parseMarkdown('\\%% literal\n\n# Visible', 'Note').nodes.map((node) => node.title)).toEqual(['Visible']);
  });

  it('preserves unique identities through body edits, insertions, moves, and a title-only rename', () => {
    const first = parseMarkdown('# First\nbody\n\n# Second\n', 'Note');
    const changed = parseMarkdown('# New\n\n# First\nnew body\n\n# Second\n', 'Note', first);
    expect(changed.nodes.find((node) => node.title === 'First')?.id).toBe(first.nodes[0]?.id);
    const moved = parseMarkdown('# Second\n\n# First\nnew body\n', 'Note', changed);
    expect(moved.nodes[0]?.id).toBe(first.nodes[1]?.id);
    const renamed = parseMarkdown('# Second renamed\n\n# First\nnew body\n', 'Note', moved);
    expect(renamed.nodes[0]?.id).toBe(moved.nodes[0]?.id);
  });

  it('keeps same-titled top-level sections whose text is unchanged, and guesses nothing from a title or a position alone', () => {
    const source = '# Same\nOne\n\n# Same\nTwo';
    const first = parseMarkdown(source, 'Note');
    const unchanged = parseMarkdown(source, 'Note', first);
    expect(unchanged.nodes.map((node) => node.id)).toEqual(first.nodes.map((node) => node.id));
    // A change elsewhere (frontmatter, a trailing newline) leaves both sections' text as it was: both keep their ids (§5 M7).
    const changed = parseMarkdown(`${source}\n`, 'Note', first);
    expect(changed.nodes.map((node) => node.id)).toEqual(first.nodes.map((node) => node.id));
    const fronted = parseMarkdown(`---\nmappy-topics:\n  Same (2): { mindmap: [1, 2] }\n---\n${source}`, 'Note', first);
    expect(fronted.nodes.map((node) => node.id)).toEqual(first.nodes.map((node) => node.id));
    // A third section appended: the two unchanged ones keep their ids, the new one gets its own.
    const grown = parseMarkdown(`${source}\n\n# Same\nThree\n`, 'Note', first);
    expect(grown.nodes.slice(0, 2).map((node) => node.id)).toEqual(first.nodes.map((node) => node.id));
    expect(first.nodes.some((old) => old.id === grown.nodes[2]?.id)).toBe(false);
    expect(new Set(grown.nodes.map((node) => node.id)).size).toBe(3);
    // The ids follow the text, not the position: sections swapped keep their own ids, the one deleted takes its id away.
    const swapped = parseMarkdown('# Same\nTwo\n\n# Same\nOne', 'Note', first);
    expect(swapped.nodes.map((node) => node.id)).toEqual([first.nodes[1]?.id, first.nodes[0]?.id]);
    const replaced = parseMarkdown('# Same\nTwo\n\n# Same\nThree', 'Note', first);
    expect(replaced.nodes[0]?.id).toBe(first.nodes[1]?.id);
    expect(first.nodes.some((old) => old.id === replaced.nodes[1]?.id)).toBe(false);
    // A section whose own text changed (a nested heading added) is not matched; the untouched one still is.
    const nested = parseMarkdown('# Same\nOne\n\n## Same\n\n# Same\nTwo\n', 'Note', first);
    expect(nested.nodes[2]?.id).toBe(first.nodes[1]?.id);
    expect(first.nodes.some((old) => old.id === nested.nodes[0]?.id || old.id === nested.nodes[1]?.id)).toBe(false);
    // List documents: the H2 sections by their text, list items sharing the text never guessed.
    const list = parseMarkdown('## Same\n- Same\n\n## Same\n- Same\n', 'Note');
    const listChanged = parseMarkdown('## Same\n- Same\n\n## Same\n- Same\n\n', 'Note', list);
    expect(listChanged.nodes.filter((node) => node.kind !== 'list').map((node) => node.id)).toEqual(list.nodes.filter((node) => node.kind !== 'list').map((node) => node.id));
    expect(listChanged.nodes.filter((node) => node.kind === 'list').every((node) => !list.nodes.some((old) => old.id === node.id))).toBe(true);
  });
});
