import { describe, expect, it } from 'vitest';
import { nodeBody, planAppendBody, planBodyEdit } from '../../src/core/body';
import { applyEdits } from '../../src/core/commands';
import { parseMarkdown, type MindDocument } from '../../src/core/markdown';

function firstId(doc: MindDocument): string {
  const id = doc.nodes[0]?.id;
  if (!id) throw new Error('Missing fixture heading');
  return id;
}

describe('direct body replacement', () => {
  it('does not concatenate a body onto a heading without an EOF newline', () => {
    const doc = parseMarkdown('# Heading', 'Note');
    const edit = planBodyEdit(doc, firstId(doc), '日本語の本文');
    expect(edit).toEqual({ from: doc.source.length, to: doc.source.length, text: '\n\n日本語の本文' });
    expect(applyEdits(doc.source, [edit])).toBe('# Heading\n\n日本語の本文');
  });

  it('replaces only the body range and keeps subsequent child headings separated', () => {
    const doc = parseMarkdown('---\nkey: value\n---\n# Parent\nold body\n## Child\nchild body', 'Note');
    const node = doc.nodes[0];
    if (!node) throw new Error('Missing fixture heading');
    const edit = planBodyEdit(doc, node.id, 'New [[link]]');
    expect(edit.from).toBe(node.bodyFrom);
    expect(edit.to).toBe(node.bodyTo);
    expect(edit.text).toBe('New [[link]]\n\n');
    expect(applyEdits(doc.source, [edit])).toBe('---\nkey: value\n---\n# Parent\nNew [[link]]\n\n## Child\nchild body');
  });

  it('normalizes only input newlines to CRLF and preserves surrounding source bytes', () => {
    const doc = parseMarkdown('# Parent\r\nold\r\n\r\n## Child\r\nkeep', 'Note');
    const edit = planBodyEdit(doc, firstId(doc), 'one\ntwo\rthree\r\nfour');
    expect(edit.text).toBe('one\r\ntwo\r\nthree\r\nfour\r\n\r\n');
    expect(applyEdits(doc.source, [edit])).toBe('# Parent\r\none\r\ntwo\r\nthree\r\nfour\r\n\r\n## Child\r\nkeep');
  });

  it('supports a root preamble and preserves YAML metadata', () => {
    const doc = parseMarkdown('---\nname: note\n---\nold preamble\n# Heading', 'Note');
    expect(applyEdits(doc.source, [planBodyEdit(doc, 'root', 'New preamble')]))
      .toBe('---\nname: note\n---\nNew preamble\n\n# Heading');
  });

  it.each(['---\nname: note\n---', '---\r\nname: note\r\n...'])('appends preamble after closed YAML without an EOF newline %j', (source) => {
    const doc = parseMarkdown(source, 'Note');
    expect(applyEdits(source, [planBodyEdit(doc, 'root', 'Preamble')])).toBe(`${source}${doc.eol}${doc.eol}Preamble`);
  });

  it('handles empty root documents, clearing a body, and empty EOF edits', () => {
    const empty = parseMarkdown('', 'Note');
    expect(applyEdits('', [planBodyEdit(empty, 'root', '本文')])).toBe('本文');
    const doc = parseMarkdown('# Parent\nold\n## Child', 'Note');
    expect(applyEdits(doc.source, [planBodyEdit(doc, firstId(doc), '')])).toBe('# Parent\n\n## Child');
    const eof = parseMarkdown('# Heading', 'Note');
    expect(applyEdits(eof.source, [planBodyEdit(eof, firstId(eof), '')])).toBe('# Heading');
  });

  it('retains user whitespace, Markdown markup, and the chosen EOF newline', () => {
    const doc = parseMarkdown('# Heading\nold', 'Note');
    const body = '  **bold**  \n![[図.png]]\n';
    expect(applyEdits(doc.source, [planBodyEdit(doc, firstId(doc), body)])).toBe(`# Heading\n${body}`);
  });

  it.each(['```md\nunclosed', '%%\nunclosed'])('rejects input that would swallow a following child heading: %j', (body) => {
    const doc = parseMarkdown('# Parent\nbody\n\n## Child\nkeep', 'Note');
    expect(() => planBodyEdit(doc, firstId(doc), body)).toThrow('既存の見出し');
  });

  it('allows deliberately added body headings while preserving existing headings', () => {
    const doc = parseMarkdown('# Parent\nold\n\n# Peer', 'Note');
    const result = applyEdits(doc.source, [planBodyEdit(doc, firstId(doc), '## New child\nbody')]);
    expect(parseMarkdown(result, 'Note').nodes.map((node) => node.title)).toEqual(['Parent', 'New child', 'Peer']);
  });

  it('rejects stale IDs and unfinished metadata instead of writing body text inside YAML', () => {
    const doc = parseMarkdown('# Heading', 'Note');
    expect(() => planBodyEdit(doc, 'missing', 'body')).toThrow();
    const unclosed = parseMarkdown('---\nname: unfinished', 'Note');
    expect(() => planBodyEdit(unclosed, 'root', 'body')).toThrow('frontmatter');
    expect(() => planAppendBody(unclosed, 'root', '![[image.png]]')).toThrow('frontmatter');
  });
});

describe('raw Markdown append', () => {
  it('appends an image embed without escaping it or concatenating onto an EOF heading', () => {
    const doc = parseMarkdown('# Heading', 'Note');
    const edit = planAppendBody(doc, firstId(doc), '![[日本語の画像.png]]');
    expect(edit).toEqual({ from: doc.source.length, to: doc.source.length, text: '\n\n![[日本語の画像.png]]' });
    expect(applyEdits(doc.source, [edit])).toBe('# Heading\n\n![[日本語の画像.png]]');
  });

  it('inserts after existing body bytes and before child headings with blank line boundaries', () => {
    const doc = parseMarkdown('# Parent\r\nexisting\r\n## Child\r\nkeep', 'Note');
    const node = doc.nodes[0];
    if (!node) throw new Error('Missing fixture heading');
    const edit = planAppendBody(doc, node.id, '![alt](image.png)\ncaption');
    expect(edit.from).toBe(node.bodyTo);
    expect(edit.to).toBe(node.bodyTo);
    expect(applyEdits(doc.source, [edit])).toBe('# Parent\r\nexisting\r\n\r\n![alt](image.png)\r\ncaption\r\n\r\n## Child\r\nkeep');
  });

  it('keeps existing mixed line endings and Markdown unchanged during append', () => {
    const source = '# Heading\r\nExisting\n[[link]]\r\n\r\n';
    const doc = parseMarkdown(source, 'Note');
    expect(applyEdits(source, [planAppendBody(doc, firstId(doc), '![[image.png]]')])).toBe(`${source}![[image.png]]`);
  });

  it('can append a root preamble before the first heading without altering that heading', () => {
    const doc = parseMarkdown('# Heading\nbody', 'Note');
    expect(applyEdits(doc.source, [planAppendBody(doc, 'root', '![[image.png]]')]))
      .toBe('![[image.png]]\n\n# Heading\nbody');
  });

  it('does not add whitespace for an empty append', () => {
    const doc = parseMarkdown('# Heading', 'Note');
    expect(applyEdits(doc.source, [planAppendBody(doc, firstId(doc), '')])).toBe(doc.source);
  });
});

describe('bodies in front of trailing memos', () => {
  const memos = '\n```mappy-memo m1\n付箋\n```\n';

  it('keeps the note\'s separator style before the memos and leaves their bytes alone in both formats', () => {
    const cases: [string, string][] = [
      [`## Root\nold\n${memos}`, `## Root\nnew\n${memos}`],
      [`## Root\n${memos}`, `## Root\nnew\n${memos}`],
      [`## Root${memos}`, `## Root\n\nnew${memos}`],
      [`# Root\n## Child\nold\n${memos}`, `# Root\n## Child\nnew\n${memos}`],
      [`## Root\n- A\n  old\n${memos}`, `## Root\n- A\n  new\n${memos}`],
      [`## Root\n- A\n  old${memos}`, `## Root\n- A\n  new${memos}`],
    ];
    for (const [source, expected] of cases) {
      const doc = parseMarkdown(source, 'Note');
      const node = doc.nodes[doc.nodes.length - 1];
      if (!node) throw new Error('Missing fixture node');
      const result = applyEdits(source, [planBodyEdit(doc, node.id, 'new')]);
      expect(result).toBe(expected);
      const updated = parseMarkdown(result, 'Note');
      expect(result.slice(updated.memoRegion?.from)).toBe(memos);
      expect(nodeBody(updated, updated.nodes[updated.nodes.length - 1] ?? updated.root).trim()).toBe('new');
    }
    const cleared = parseMarkdown(`## Root\nold\n${memos}`, 'Note');
    expect(applyEdits(cleared.source, [planBodyEdit(cleared, firstId(cleared), '')])).toBe(`## Root\n${memos}`);
  });

  it('appends before the memos with a single separating blank line', () => {
    const doc = parseMarkdown(`## Root\nbody\n${memos}`, 'Note');
    expect(applyEdits(doc.source, [planAppendBody(doc, firstId(doc), '![[image.png]]')])).toBe(`## Root\nbody\n\n![[image.png]]\n${memos}`);
    const leaf = parseMarkdown(`## Root\n- A\n${memos}`, 'Note');
    const child = leaf.nodes[1];
    if (!child) throw new Error('Missing fixture node');
    expect(applyEdits(leaf.source, [planAppendBody(leaf, child.id, '![[image.png]]')])).toBe(`## Root\n- A\n\n  ![[image.png]]\n${memos}`);
  });

  it('does not pile blank lines onto a leaf list body that is already followed by its own line break', () => {
    const cases: [string, string][] = [
      ['## Root\n- A\n  old\n- B', '## Root\n- A\n  new\n- B'],
      ['## Root\n- A\n  old\n\n- B', '## Root\n- A\n  new\n\n- B'],
      ['## Root\n- A\n  old\n', '## Root\n- A\n  new\n'],
    ];
    for (const [source, expected] of cases) {
      const doc = parseMarkdown(source, 'Note');
      const node = doc.nodes[1];
      if (!node) throw new Error('Missing fixture node');
      expect(applyEdits(source, [planBodyEdit(doc, node.id, 'new')])).toBe(expected);
    }
  });

  it.each(['```md\nunclosed', '~~~\nunclosed', '%%\nunclosed'])('rejects a body that would swallow the memos: %j', (body) => {
    const doc = parseMarkdown(`## Root\nold\n${memos}`, 'Note');
    expect(() => planBodyEdit(doc, firstId(doc), body)).toThrow('付箋メモ');
  });
});
