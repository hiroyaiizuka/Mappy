import { describe, expect, it } from 'vitest';
import { parseMarkdown, type MindDocument } from '../../src/core/markdown';

const memoFence = (id: string, text: string, eol = '\n'): string => `\`\`\`mappy-memo ${id}${eol}${text}${eol}\`\`\``;

/** Every byte a node owns, plus its identity, so memo presence can be compared exactly. */
function projection(doc: MindDocument): unknown[] {
  return [doc.root, ...doc.nodes].map((node) => [
    node.title, node.kind, node.level,
    node.parentId === null ? null : doc.nodes.findIndex((candidate) => candidate.id === node.parentId),
    doc.source.slice(node.from, node.to), doc.source.slice(node.bodyFrom, node.bodyTo), doc.source.slice(node.from, node.headingTo),
  ]);
}

describe('trailing memo fences in the projection', () => {
  it.each([
    ['list', '---\nmappy: true\n---\n## Root\nRoot body\n\n- First\n  Body\n  - Child\n- Peer\n  Trailing prose\n'],
    ['headings', '---\nmappy: true\n---\n# Root\nRoot body\n\n## Child\nChild body\n\n### Grandchild\nLast body\n'],
  ])('%s format: memos are neither nodes nor body and every node range stays byte-identical', (format, plain) => {
    const withMemos = `${plain}\n${memoFence('m1', '最初のメモ\n二行目')}\n\n${memoFence('m2', '')}\n`;
    const bare = parseMarkdown(plain, 'File');
    const doc = parseMarkdown(withMemos, 'File');
    expect(bare.format).toBe(format);
    expect(doc.format).toBe(format);
    expect(doc.memoBlocks.map((memo) => [memo.id, doc.source.slice(memo.textFrom, memo.textTo), memo.closed])).toEqual([
      ['m1', '最初のメモ\n二行目', true], ['m2', '', true],
    ]);
    expect(doc.memoRegion).toEqual({ from: plain.length, to: withMemos.length });
    expect(projection(doc)).toEqual(projection(bare));
    expect(doc.source).toBe(withMemos);
    expect(bare.memoBlocks).toEqual([]);
    expect(bare.memoRegion).toBeNull();
  });

  it('gives both document formats the same memos for the same trailing fences', () => {
    const memos = `\n${memoFence('a', 'one')}\n\n${memoFence('b', 'two\nlines')}\n`;
    const list = parseMarkdown(`## Root\n- Child\n${memos}`, 'File');
    const headings = parseMarkdown(`# Root\n## Child\n${memos}`, 'File');
    const read = (doc: MindDocument) => doc.memoBlocks.map((memo) => [memo.id, doc.source.slice(memo.textFrom, memo.textTo)]);
    expect(list.format).toBe('list');
    expect(headings.format).toBe('headings');
    expect(read(list)).toEqual([['a', 'one'], ['b', 'two\nlines']]);
    expect(read(headings)).toEqual(read(list));
    expect(list.nodes.map((node) => node.title)).toEqual(['Root', 'Child']);
    expect(headings.nodes.map((node) => node.title)).toEqual(['Root', 'Child']);
  });

  it('owns the separator line so both trailing-newline styles stay exact', () => {
    for (const plain of ['## Root\n- A\n', '## Root\n- A', '## Root\n- A\n\n\n', '## Root\n- A\n  ']) {
      const source = `${plain}\n${memoFence('m1', 'x')}`;
      const doc = parseMarkdown(source, 'File');
      expect(doc.memoRegion?.from).toBe(plain.length);
      expect(projection(doc)).toEqual(projection(parseMarkdown(plain, 'File')));
    }
  });

  it('handles CRLF, tilde fences, longer fences, and an unfinished last fence', () => {
    const source = '## Root\r\n- A\r\n\r\n~~~mappy-memo m1\r\n```\r\ninner\r\n~~~\r\n\r\n````mappy-memo m2  \r\n```\r\n````\r\n\r\n```mappy-memo m3\r\nunfinished';
    const doc = parseMarkdown(source, 'File');
    expect(doc.memoBlocks.map((memo) => [memo.id, source.slice(memo.textFrom, memo.textTo), memo.fence, memo.closed])).toEqual([
      ['m1', '```\r\ninner', '~~~', true], ['m2', '```', '````', true], ['m3', 'unfinished', '```', false],
    ]);
    expect(doc.memoRegion?.from).toBe('## Root\r\n- A\r\n'.length);
    expect(source.slice(doc.root.from, doc.root.to)).toBe('## Root\r\n- A\r\n');
    expect(doc.nodes.map((node) => node.title)).toEqual(['Root', 'A']);
  });

  it('does not mistake lookalikes inside code, comments, lists, quotes, or before other content for memos', () => {
    const lookalikes = [
      '## Root', '- A', '  ```mappy-memo nested', '  in list', '  ```', '', '> ```mappy-memo quoted', '> ```', '',
      '````md', '```mappy-memo fenced', '```', '````', '', '%%', '```mappy-memo commented', '```', '%%', '',
      '```mappy-memo early', 'followed by content', '```', '', '- B', '',
    ].join('\n');
    const doc = parseMarkdown(lookalikes, 'File');
    expect(doc.memoBlocks).toEqual([]);
    expect(doc.memoRegion).toBeNull();
    expect(doc.nodes.map((node) => node.title)).toEqual(['Root', 'A', 'B']);
    const trailing = parseMarkdown(`${lookalikes}\n${memoFence('m1', 'real')}\n`, 'File');
    expect(trailing.memoBlocks.map((memo) => memo.id)).toEqual(['m1']);
    expect(trailing.nodes.map((node) => node.title)).toEqual(['Root', 'A', 'B']);
    expect(trailing.memoRegion?.from).toBe(lookalikes.length);
  });

  it('keeps only the final run of memo fences and treats other languages as ordinary blocks', () => {
    const source = `## Root\n- A\n\n${memoFence('m1', 'orphaned by the code below')}\n\n\`\`\`js\ncode\n\`\`\`\n\n${memoFence('m2', 'last')}\n`;
    const doc = parseMarkdown(source, 'File');
    expect(doc.memoBlocks.map((memo) => memo.id)).toEqual(['m2']);
    expect(source.slice(doc.root.from, doc.root.to)).toContain('```js');
    expect(parseMarkdown('## Root\n\n```mappy-memos m1\nplural\n```\n', 'File').memoBlocks).toEqual([]);
  });

  it('blanks invalid, missing, and duplicate IDs without dropping the fences', () => {
    const source = ['## Root', '', '```mappy-memo', 'no id', '```', '', '```mappy-memo 1st', 'bad', '```', '',
      '```mappy-memo dup', 'first', '```', '', '```mappy-memo dup', 'second', '```', ''].join('\n');
    const doc = parseMarkdown(source, 'File');
    expect(doc.memoBlocks.map((memo) => [memo.id, source.slice(memo.textFrom, memo.textTo)])).toEqual([
      ['', 'no id'], ['', 'bad'], ['dup', 'first'], ['', 'second'],
    ]);
  });

  it('accepts memos directly after the YAML header or at the very start of a note', () => {
    const afterYaml = `---\nmappy: true\n---\n${memoFence('m1', 'x')}\n`;
    const doc = parseMarkdown(afterYaml, 'File');
    expect(doc.memoRegion?.from).toBe('---\nmappy: true\n---\n'.length);
    expect(doc.root.bodyFrom).toBe(doc.root.bodyTo);
    const only = parseMarkdown(memoFence('m1', 'x'), 'File');
    expect(only.memoRegion).toEqual({ from: 0, to: only.source.length });
    expect(only.root.to).toBe(0);
    expect(parseMarkdown('---\nunfinished: yes\n```mappy-memo m1\n```', 'File').memoBlocks).toEqual([]);
  });

  it('clips a heading whose memo follows without a blank line and keeps range invariants', () => {
    const source = `## Root\n${memoFence('m1', 'x')}`;
    const doc = parseMarkdown(source, 'File');
    const root = doc.nodes[0];
    expect(root && [root.headingTo, root.bodyFrom, root.bodyTo, root.to]).toEqual([7, 7, 7, 7]);
    expect(doc.memoRegion?.from).toBe(7);
  });

  it('keeps node identities stable when only the memo region changes', () => {
    const first = parseMarkdown('## Root\n- A\n', 'File');
    const withMemo = parseMarkdown(`## Root\n- A\n\n${memoFence('m1', 'x')}\n`, 'File', first);
    expect(withMemo.nodes.map((node) => node.id)).toEqual(first.nodes.map((node) => node.id));
  });
});
