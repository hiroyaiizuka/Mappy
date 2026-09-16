import { describe, expect, it } from 'vitest';
import { plainTitle } from '../../src/core/plain-text';

describe('plainTitle', () => {
  it('returns plain text unchanged', () => {
    expect(plainTitle('回復する')).toEqual({ text: '回復する', link: null });
  });

  it('strips emphasis, code and strikethrough markers', () => {
    expect(plainTitle('**太字** と _斜体_ と `code` と ~~消し~~').text).toBe('太字 と 斜体 と code と 消し');
  });

  it('uses the alias of a wiki link and records the first link target', () => {
    expect(plainTitle('参考: [[睡眠ノート#見出し|睡眠]] と [[別ノート]]')).toEqual({ text: '参考: 睡眠 と 別ノート', link: '睡眠ノート' });
  });

  it('uses the label of an inline link and its URL as link', () => {
    expect(plainTitle('[資料](https://example.com "title") を読む')).toEqual({ text: '資料 を読む', link: 'https://example.com' });
  });

  it('shows the file name for image embeds without treating them as links', () => {
    expect(plainTitle('図 ![[folder/図.png|200]] と ![alt](a/b.jpg)')).toEqual({ text: '図 図.png と alt', link: null });
  });

  it('keeps autolinks and bare URLs as text and link', () => {
    expect(plainTitle('<https://a.example>')).toEqual({ text: 'https://a.example', link: 'https://a.example' });
    expect(plainTitle('see https://b.example now').link).toBe('https://b.example');
  });

  it('collapses whitespace and returns empty text for empty titles', () => {
    expect(plainTitle('   ')).toEqual({ text: '', link: null });
    expect(plainTitle('a   b').text).toBe('a b');
  });
});
