import { describe, expect, it } from 'vitest';
import { plainTitle } from '../../src/core/plain-text';

describe('plainTitle', () => {
  it('returns plain text unchanged', () => {
    expect(plainTitle('回復する')).toEqual({ text: '回復する', link: null, linkSyntax: null });
  });

  it('strips emphasis, code and strikethrough markers', () => {
    expect(plainTitle('**太字** と _斜体_ と `code` と ~~消し~~').text).toBe('太字 と 斜体 と code と 消し');
  });

  it('uses the alias of a wiki link and records the first link target', () => {
    expect(plainTitle('参考: [[睡眠ノート#見出し|睡眠]] と [[別ノート]]')).toEqual({ text: '参考: 睡眠 と 別ノート', link: '睡眠ノート', linkSyntax: 'vault' });
  });

  it('uses the label of an inline link and its URL as link', () => {
    expect(plainTitle('[資料](https://example.com "title") を読む')).toEqual({ text: '資料 を読む', link: 'https://example.com', linkSyntax: 'vault' });
  });

  it('shows the file name for image embeds without treating them as links', () => {
    expect(plainTitle('図 ![[folder/図.png|200]] と ![alt](a/b.jpg)')).toEqual({ text: '図 図.png と alt', link: null, linkSyntax: null });
  });

  it('gives a `www.` autolink the scheme it opens with, and leaves the text as written', () => {
    // GFM reads `www.…` as a link; read as written it is a vault path, and the drawing it is copied into
    // gets a link to a note that does not exist (LEV-134).
    expect(plainTitle('見て www.example.com/a')).toEqual({ text: '見て www.example.com/a', link: 'https://www.example.com/a', linkSyntax: 'autolink' });
  });

  it('leaves a bare address as written and says it was an autolink: only the vault can tell the two apart', () => {
    // `file@2x.png` is an email autolink to GFM and a picture in the vault to Obsidian, so the scheme is
    // not decided here; the syntax is what lets the bridge ask the vault first (LEV-138).
    expect(plainTitle('図 file@2x.png')).toEqual({ text: '図 file@2x.png', link: 'file@2x.png', linkSyntax: 'autolink' });
    expect(plainTitle('連絡 someone@example.com')).toEqual({
      text: '連絡 someone@example.com', link: 'someone@example.com', linkSyntax: 'autolink',
    });
    // Written as a vault link, the same text keeps naming a note.
    expect(plainTitle('[[file@2x.png]]').linkSyntax).toBe('vault');
  });

  it('never sees an uppercase `WWW.` address: the parser does not call it a link at all', () => {
    expect(plainTitle('WWW.EXAMPLE.COM/a').link).toBeNull();
  });

  it('leaves the syntaxes Obsidian reads as vault paths alone, even when they look like an address', () => {
    // Only an autolink means the web. A wiki link names a note, and an inline link's destination is a
    // vault path in Obsidian (`[説明](sample-image.svg)`), so neither may gain a scheme here.
    expect(plainTitle('[[www.example.com]]')).toEqual({ text: 'www.example.com', link: 'www.example.com', linkSyntax: 'vault' });
    expect(plainTitle('[見て](www.example.com/a)')).toEqual({ text: '見て', link: 'www.example.com/a', linkSyntax: 'vault' });
    expect(plainTitle('[図](Attachments/図.png)').link).toBe('Attachments/図.png');
  });

  it('keeps autolinks and bare URLs as text and link', () => {
    expect(plainTitle('<https://a.example>')).toEqual({ text: 'https://a.example', link: 'https://a.example', linkSyntax: 'autolink' });
    expect(plainTitle('see https://b.example now').link).toBe('https://b.example');
  });

  it('collapses whitespace and returns empty text for empty titles', () => {
    expect(plainTitle('   ')).toEqual({ text: '', link: null, linkSyntax: null });
    expect(plainTitle('a   b').text).toBe('a b');
  });
});
