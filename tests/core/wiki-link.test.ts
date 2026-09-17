import { describe, expect, it } from 'vitest';
import { insertWikiLink, wikiLinkContext } from '../../src/core/wiki-link';

describe('inline wikilink completion', () => {
  it('finds the active link after surrounding Japanese text', () => {
    expect(wikiLinkContext('参考は [[睡', 7)).toEqual({ from: 4, to: 7, query: '睡', suffix: '' });
  });

  it.each(['閉じた [[睡眠]]', '普通の入力', '[[睡眠#章', '[[睡眠|別名', '`[[code', '\\[[escaped'])('does not complete %s', text => {
    expect(wikiLinkContext(text, text.length)).toBeNull();
  });

  it('replaces only the active link, preserving following text and an existing alias', () => {
    const text = '前 [[no|表示名]] 後';
    const context = wikiLinkContext(text, 6);
    expect(context).not.toBeNull();
    expect(insertWikiLink(text, context!, '資料/日本 語')).toEqual({
      value: '前 [[資料/日本 語|表示名]] 後', cursor: 17,
    });
  });

  it('retains an existing fragment when completing the file part', () => {
    const text = '[[no#Heading|名前]] tail';
    const context = wikiLinkContext(text, 4);
    expect(context).not.toBeNull();
    expect(insertWikiLink(text, context!, 'Notes/note').value).toBe('[[Notes/note#Heading|名前]] tail');
  });

  it('does not duplicate closing brackets, and preserves text outside the link', () => {
    const text = 'A [[not]] B';
    const context = wikiLinkContext(text, 7);
    expect(context).not.toBeNull();
    expect(insertWikiLink(text, context!, 'note')).toEqual({ value: 'A [[note]] B', cursor: 10 });
  });

  it('uses a selected alias without rewriting unrelated text', () => {
    const text = '参考 [[ねむ trailing';
    const context = wikiLinkContext(text, 7);
    expect(context).not.toBeNull();
    expect(insertWikiLink(text, context!, '睡眠', 'ねむり').value).toBe('参考 [[睡眠|ねむり]] trailing');
  });

  it('finds only the last unclosed pair on the current line', () => {
    const text = '[[first]] text [[next';
    expect(wikiLinkContext(text, text.length)?.query).toBe('next');
    expect(wikiLinkContext('[[first\nnext', 12)).toBeNull();
  });
});
