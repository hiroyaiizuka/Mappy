import { describe, expect, it } from 'vitest';
import { IMAGE_MIME_TYPES, attachmentEntries, attachmentMarkdown, imageMimeType } from '../../src/core/attachments';
import { plainTitle } from '../../src/core/plain-text';

describe('attachmentMarkdown', () => {
  it('keeps only link and image syntax, in order', () => {
    const body = '説明 [[睡眠ノート|睡眠]] と [資料](https://example.com)\n![[図.png]]\n\n本文だけの行';
    expect(attachmentMarkdown(body)).toBe('[[睡眠ノート|睡眠]]\n\n[資料](https://example.com)\n\n![[図.png]]');
  });

  it('ignores links inside code and comments', () => {
    expect(attachmentMarkdown('`[[code]]` と %%[[hidden]]%% と [[real]]')).toBe('[[real]]');
  });

  it('returns nothing for prose without links', () => {
    expect(attachmentMarkdown('ただの文章')).toBe('');
  });
});

describe('attachmentEntries', () => {
  it('classifies wiki embeds, wiki links, inline links and autolinks', () => {
    const body = '![[図.png|200]] [[睡眠ノート#見出し|睡眠]] [資料](https://example.com "t") <https://a.example> ![alt](pic.jpg)';
    expect(attachmentEntries(body)).toEqual([
      { kind: 'image', target: '図.png', label: '200', syntax: 'vault' },
      { kind: 'link', target: '睡眠ノート', label: '睡眠', syntax: 'vault' },
      { kind: 'link', target: 'https://example.com', label: '資料', syntax: 'vault' },
      { kind: 'link', target: 'https://a.example', label: 'https://a.example', syntax: 'autolink' },
      { kind: 'image', target: 'pic.jpg', label: 'alt', syntax: 'vault' },
    ]);
  });

  it('treats note and PDF transclusions as links, not images', () => {
    expect(attachmentEntries('![[資料.pdf]] ![[別ノート]]')).toEqual([
      { kind: 'link', target: '資料.pdf', label: '資料.pdf', syntax: 'vault' },
      { kind: 'link', target: '別ノート', label: '別ノート', syntax: 'vault' },
    ]);
  });

  it('finds a bare address in a body, where nothing else told the reader to look (LEV-138)', () => {
    // The early-out used to need `[`, `<`, `http(s)://` or a lower-case `www.`, so a body whose only link
    // was an address returned nothing while the same text in a title was a link.
    expect(attachmentEntries('連絡 someone@example.com')).toEqual([
      { kind: 'link', target: 'someone@example.com', label: 'someone@example.com', syntax: 'autolink' },
    ]);
    // An upper-case scheme reaches the parser now, and the parser does not call it a link — the same
    // answer a title gives, which is what matters: the two sides agree.
    expect(attachmentEntries('見て HTTP://EXAMPLE.COM/a')).toEqual([]);
    expect(plainTitle('見て HTTP://EXAMPLE.COM/a').link).toBeNull();
    // Prose that only looks like one is still prose.
    expect(attachmentEntries('ただの文章')).toEqual([]);
    expect(attachmentEntries('メモ @ 3 時')).toEqual([]);
  });

  it('skips empty wiki targets and protected ranges', () => {
    expect(attachmentEntries('[[]] `[[x]]` [[ok]]')).toEqual([{ kind: 'link', target: 'ok', label: 'ok', syntax: 'vault' }]);
  });

  it('gives a `www.` autolink the scheme it was written without, and keeps the label as written (LEV-134)', () => {
    // A body link travels into the drawing (§5 M6); `www.example.com/a` read as a vault path links to
    // a note that does not exist. The label is what the note wrote, so the node still shows the address.
    expect(attachmentEntries('見て www.example.com/a と [[www.example.com]] と [説明](www.example.com/b)')).toEqual([
      { kind: 'link', target: 'https://www.example.com/a', label: 'www.example.com/a', syntax: 'autolink' },
      { kind: 'link', target: 'www.example.com', label: 'www.example.com', syntax: 'vault' },
      { kind: 'link', target: 'www.example.com/b', label: '説明', syntax: 'vault' },
    ]);
    // A bare address stays as written: the parser reads an attachment named `file@2x.png` as one (LEV-138).
    expect(attachmentEntries('[ ] <someone@example.com> と ![[file@2x.png]]').slice(-2)).toEqual([
      { kind: 'link', target: 'someone@example.com', label: 'someone@example.com', syntax: 'autolink' },
      { kind: 'image', target: 'file@2x.png', label: 'file@2x.png', syntax: 'vault' },
    ]);
  });
});

describe('imageMimeType', () => {
  it('maps the image extensions every layer shares, in any case and with or without the dot', () => {
    expect(imageMimeType('png')).toBe('image/png');
    expect(imageMimeType('.JPG')).toBe('image/jpeg');
    expect(imageMimeType('svg')).toBe('image/svg+xml');
    expect(imageMimeType('pdf')).toBeUndefined();
    expect(imageMimeType('')).toBeUndefined();
    expect(Object.keys(IMAGE_MIME_TYPES).sort()).toEqual(['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
  });
});
