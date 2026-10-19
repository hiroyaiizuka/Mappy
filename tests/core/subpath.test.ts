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

  it('opens a link on a heading the map coloured since (LEV-364), Obsidian\'s match first', () => {
    const colored = SOURCE.replace('## 講座の構成', '## <mark style="background: #ADCCFFA6;">講座の構成</mark>');
    expect(locateSubpath(colored, '#講座の構成')).toBe(colored.indexOf('## <mark'));
    expect(locateSubpath(colored, '#講座の構成#補足: 用語')).toBe(colored.indexOf('### 補足: 用語'));
    // Obsidian reads `=` as punctuation, so its own rule already reaches a highlighted heading.
    const highlighted = SOURCE.replace('### 補足: 用語', '### ==補足: 用語==');
    expect(locateSubpath(highlighted, '#補足: 用語')).toBe(highlighted.indexOf('### ==補足'));
    // A plain heading Obsidian finds keeps the link, though a coloured one of the same text comes earlier.
    const both = SOURCE.replace('### 補足: 用語', '### <mark style="background: #ADCCFFA6;">補足: 用語</mark>');
    expect(locateSubpath(both, '#補足: 用語')).toBe(both.indexOf('## 補足: 用語\n\n二つ目'));
    expect(locateSubpath(both, '#講座の構成#補足: 用語')).toBe(both.indexOf('### <mark'));
    // The next `A` is tried when the first leads nowhere (code review 2).
    const later = '### <mark>A</mark>\n\n## A\n\n### <mark>B</mark>\n';
    expect(locateSubpath(later, '#A#B')).toBe(later.indexOf('### <mark>B'));
    // With no coloured heading on the way, the second reading answers as Obsidian does (code review 3).
    expect(locateSubpath('# R\n### A\n## A\n### B\n', '#A#B')).toBeNull();
  });
});
