import { describe, expect, it } from 'vitest';
import { planAppendBody, planBodyEdit } from '../../src/core/body';
import { applyEdits } from '../../src/core/commands';
import { parseMarkdown, type MindDocument } from '../../src/core/markdown';

function firstId(doc: MindDocument): string {
  const id = doc.nodes[0]?.id;
  if (!id) throw new Error('Missing fixture heading');
  return id;
}

function idOf(doc: MindDocument, title: string): string {
  const id = doc.nodes.find((node) => node.title === title)?.id;
  if (!id) throw new Error(`Missing fixture node ${title}`);
  return id;
}

function replaceBody(source: string, title: string, body: string): string {
  const doc = parseMarkdown(source, 'Note');
  return applyEdits(source, [planBodyEdit(doc, idOf(doc, title), body)]);
}

/** Replace the same body twice so whitespace that accumulates per edit shows up. */
function replaceBodyTwice(source: string, title: string, body: string): string {
  const once = replaceBody(source, title, body);
  expect(replaceBody(once, title, body)).toBe(once);
  return once;
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

  it.each([
    ['## Root\n- A\n  old\n- B', '## Root\n- A\n  new\n- B'],
    ['## Root\n- A\n  old\n\n- B', '## Root\n- A\n  new\n\n- B'],
    ['## Root\n- A\n  old\n', '## Root\n- A\n  new\n'],
    ['## Root\n- A\n  old\n\nOutside', '## Root\n- A\n  new\n\nOutside'],
    ['## Root\n- A\n  old\n\n## Other', '## Root\n- A\n  new\n\n## Other'],
    ['## Root\r\n- A\r\n  old\r\n- B', '## Root\r\n- A\r\n  new\r\n- B'],
    ['## Root\r\n- A\r\n  old\r\n', '## Root\r\n- A\r\n  new\r\n'],
  ])('does not pile blank lines onto a leaf list body that already ends at a line break: %j', (source, expected) => {
    expect(replaceBodyTwice(source, 'A', 'new')).toBe(expected);
  });

  it('keeps the paragraph gap before a child list, the next heading, and at EOF', () => {
    expect(replaceBodyTwice('## Root\n- A\n  old\n  - C\n- B', 'A', 'new')).toBe('## Root\n- A\n  new\n\n  - C\n- B');
    expect(replaceBodyTwice('## Root\n- A\n  old\n\n  - C\n- B', 'A', 'new')).toBe('## Root\n- A\n  new\n\n  - C\n- B');
    expect(replaceBodyTwice('## Root\n- A\n  old', 'A', 'new')).toBe('## Root\n- A\n  new');
    expect(replaceBodyTwice('# Parent\nold\n## Child', 'Parent', 'new')).toBe('# Parent\nnew\n\n## Child');
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

  it.each([
    ['## Root\n- A\n  old\n- B', '## Root\n- A\n  old\n\n  ![[図.png]]\n- B'],
    ['## Root\n- A\n  old\n', '## Root\n- A\n  old\n\n  ![[図.png]]\n'],
    ['## Root\r\n- A\r\n  old\r\n- B', '## Root\r\n- A\r\n  old\r\n\r\n  ![[図.png]]\r\n- B'],
    ['## Root\n- A\n  old\n  - C\n- B', '## Root\n- A\n  old\n\n  ![[図.png]]\n\n  - C\n- B'],
  ])('appends to a list body without piling blank lines before the next line: %j', (source, expected) => {
    const doc = parseMarkdown(source, 'Note');
    expect(applyEdits(source, [planAppendBody(doc, idOf(doc, 'A'), '![[図.png]]')])).toBe(expected);
  });

  it('does not add whitespace for an empty append', () => {
    const doc = parseMarkdown('# Heading', 'Note');
    expect(applyEdits(doc.source, [planAppendBody(doc, firstId(doc), '')])).toBe(doc.source);
  });
});
