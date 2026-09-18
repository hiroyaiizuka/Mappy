import { describe, expect, it } from 'vitest';
import { frontmatterLayout } from '../../src/core/markdown';
import { locateFrontmatterKey, parseYamlValue } from '../../src/core/yaml-lite';

function locate(source: string, key = 'mappy-topics') {
  const layout = frontmatterLayout(source);
  if (!layout) throw new Error('Missing frontmatter fixture');
  return locateFrontmatterKey(source, layout, key);
}

describe('frontmatterLayout', () => {
  it('locates the YAML body, the closing delimiter, and the first body offset without parsing', () => {
    expect(frontmatterLayout('---\nmappy: true\n---\n## Root\n')).toEqual({ bodyFrom: 4, closingFrom: 16, end: 20, closed: true });
    expect(frontmatterLayout('﻿---\r\na: 1\r\n...\r\n')).toEqual({ bodyFrom: 6, closingFrom: 12, end: 17, closed: true });
    expect(frontmatterLayout('---\nunfinished: 1\n## Root')).toEqual({ bodyFrom: 4, closingFrom: 25, end: 25, closed: false });
    expect(frontmatterLayout('## Root\n---\n')).toBeNull();
    expect(frontmatterLayout('')).toBeNull();
  });
});

describe('parseYamlValue', () => {
  it('reads the flow style Mappy writes', () => {
    expect(parseYamlValue('', ['  回復する: { mindmap: [120, -40], timeline: [10, 20] }', '  "補足: 用語": {mindmap:[0,0]}'])).toEqual({
      '回復する': { mindmap: [120, -40], timeline: [10, 20] }, '補足: 用語': { mindmap: [0, 0] },
    });
  });

  it('reads the block style Obsidian rewrites properties into', () => {
    const lines = ['  回復する:', '    mindmap:', '      - 120', '      - -40', '    timeline:', '      - 10', '      - 20', "  '補足: 用語':", '    mindmap: [1, 2]'];
    expect(parseYamlValue('', lines)).toEqual({ '回復する': { mindmap: [120, -40], timeline: [10, 20] }, '補足: 用語': { mindmap: [1, 2] } });
  });

  it('handles inline values, quoting, comments, blank lines, and same-indent sequences', () => {
    expect(parseYamlValue('{ "m1": { \'mindmap\': [1.5, 2e1] } }', ['  ignored: 1'])).toEqual({ m1: { mindmap: [1.5, 20] } });
    expect(parseYamlValue('', ['  # comment', '  "m 1": { a: 1 } # trailing', '', '  m2:', '  - 1', '  - 2'])).toEqual({ 'm 1': { a: 1 }, m2: [1, 2] });
    expect(parseYamlValue('', ['  a: true', '  b: false', '  c: null', '  d: ~', '  e:', '  f: "it\'s"', '  g: \'say \'\'hi\'\'\'', '  h: "a\\"b\\\\c"'])).toEqual({
      a: true, b: false, c: null, d: null, e: null, f: "it's", g: "say 'hi'", h: 'a"b\\c',
    });
  });

  it('degrades unknown syntax to strings or null instead of throwing', () => {
    expect(parseYamlValue('', ['  - key: value', '  - plain'])).toEqual(['key: value', 'plain']);
    expect(parseYamlValue('{ unterminated: [1, 2', [])).toEqual({ unterminated: [1, 2] });
    expect(parseYamlValue('', ['  |', '    block scalar'])).toBe('|');
    expect(parseYamlValue('', [])).toBeNull();
    expect(parseYamlValue('plain text', [])).toBe('plain text');
  });
});

describe('locateFrontmatterKey', () => {
  it('finds the key line and its indented value without touching other keys', () => {
    const source = '---\ntags:\n  - a\nmappy-topics:\n  A: { mindmap: [1, 2] }\n\n  B: { mindmap: [3, 4] }\n\nmappy: true\n---\nbody';
    const block = locate(source);
    expect(block && source.slice(block.from, block.to)).toBe('mappy-topics:\n  A: { mindmap: [1, 2] }\n\n  B: { mindmap: [3, 4] }\n');
    expect(block?.inline).toBe('');
    expect(block?.nested).toEqual(['  A: { mindmap: [1, 2] }', '', '  B: { mindmap: [3, 4] }']);
    expect(locate(source, 'tags')?.nested).toEqual(['  - a']);
    expect(locate(source, 'mappy')?.inline).toBe('true');
    expect(locate(source, 'missing')).toBeNull();
  });

  it('accepts quoted keys, inline values, CRLF, column-zero sequences, and the last key before the delimiter', () => {
    const inline = '---\r\n"mappy-topics": { A: { mindmap: [1, 2] } }\r\nother: 1\r\n---\r\n';
    const block = locate(inline);
    expect(block && inline.slice(block.from, block.to)).toBe('"mappy-topics": { A: { mindmap: [1, 2] } }\r\n');
    expect(block?.inline).toBe('{ A: { mindmap: [1, 2] } }');
    const sequence = '---\nother: 1\ntags:\n- a\n- b\n---';
    const tags = locate(sequence, 'tags');
    expect(tags && sequence.slice(tags.from, tags.to)).toBe('tags:\n- a\n- b\n');
    expect(locate('---\nmappy-topicsx: 1\nmappy-topics:x\n---\n')).toBeNull();
  });
});
