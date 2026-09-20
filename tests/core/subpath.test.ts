import { describe, expect, it } from 'vitest';
import { locateSubpath } from '../../src/core/subpath';

const SOURCE = [
  '---', 'mappy: true', '---',
  '## 講座の構成',
  '',
  '- はじめに ^intro',
  '  - 学ぶこと',
  '- 記録する',
  '',
  '### 補足: 用語',
  '',
  '本文の段落 ^Para-1',
  '',
  '```',
  '## コードの見出し',
  'コードの行 ^code',
  '```',
  '',
  '## 補足: 用語',
  '',
  '二つ目の同名見出し',
  '',
  'Setext の見出し',
  '---',
  '',
].join('\n');

const at = (text: string): number => SOURCE.indexOf(text);

/** LEV-74 / E06: the `#…` of a link, as Obsidian 1.14.2's `resolveSubpath` reads it, on the source. */
describe('locateSubpath', () => {
  it('finds a heading by its text, ignoring case, punctuation and runs of spaces', () => {
    expect(locateSubpath(SOURCE, '#講座の構成')).toBe(at('## 講座の構成'));
    expect(locateSubpath(SOURCE, '#補足 用語')).toBe(at('### 補足: 用語'));
    expect(locateSubpath(SOURCE, '#補足:  用語')).toBe(at('### 補足: 用語'));
    expect(locateSubpath(SOURCE, '#setext の見出し')).toBe(at('Setext の見出し'));
  });

  it('walks nested segments: each one is a deeper heading after the last match', () => {
    // The H2 first, then the H3 under it; the later H2 of the same name is not deeper than the H2.
    expect(locateSubpath(SOURCE, '#講座の構成#補足: 用語')).toBe(at('### 補足: 用語'));
    expect(locateSubpath(SOURCE, '#補足: 用語#講座の構成')).toBeNull();
    expect(locateSubpath(SOURCE, '#講座の構成#ない見出し')).toBeNull();
  });

  it('finds a block by the id at the end of its line, ignoring case; not inside code', () => {
    expect(locateSubpath(SOURCE, '#^intro')).toBe(at('- はじめに ^intro'));
    expect(locateSubpath(SOURCE, '#^para-1')).toBe(at('本文の段落 ^Para-1'));
    expect(locateSubpath(SOURCE, '#^code')).toBeNull();
    expect(locateSubpath(SOURCE, '#^')).toBeNull();
  });

  it('does not read headings inside code, and answers null for footnotes, nothing and an empty subpath', () => {
    expect(locateSubpath(SOURCE, '#コードの見出し')).toBeNull();
    expect(locateSubpath(SOURCE, '#[^1]')).toBeNull();
    expect(locateSubpath(SOURCE, '#')).toBeNull();
    expect(locateSubpath(SOURCE, '')).toBeNull();
    expect(locateSubpath(SOURCE, '#ない')).toBeNull();
  });

  it('keeps the first of two headings with the same text and reads CRLF sources', () => {
    expect(locateSubpath(SOURCE, '#補足: 用語')).toBe(at('### 補足: 用語'));
    const crlf = SOURCE.replace(/\n/gu, '\r\n');
    expect(locateSubpath(crlf, '#記録する')).toBeNull();
    expect(locateSubpath(crlf, '#補足: 用語')).toBe(crlf.indexOf('### 補足: 用語'));
    expect(locateSubpath(crlf, '#^intro')).toBe(crlf.indexOf('- はじめに ^intro'));
  });
});
