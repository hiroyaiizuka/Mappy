import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { plainTitle } from '../../src/core/plain-text';
import { attachmentEntries, attachmentMarkdown } from '../../src/core/attachments';
import { exportedLink, autolinkUrl, urlScheme } from '../../src/core/wiki-link';

const LINES: string[] = [];
describe('review probe', () => {
  it('prints', () => {
    const bodies = [
      '連絡 someone@example.com',
      '見て someone@example.com です',
      '<someone@example.com>',
      '連絡 <someone@example.com>',
      'WWW.EXAMPLE.COM/a',
      '見て WWW.EXAMPLE.COM/a です',
      '見て www.example.com/a',
      'http://example.com/a',
      'HTTP://EXAMPLE.COM/a',
    ];
    for (const b of bodies) {
      LINES.push(['BODY', JSON.stringify(b), '=> entries', JSON.stringify(attachmentEntries(b)), '| md', JSON.stringify(attachmentMarkdown(b))].join(' '));
    }
    const titles = ['連絡 someone@example.com', 'WWW.EXAMPLE.COM/a', 'メモ file@2x.png', 'a@b.c', '見て ftp.example.com/x'];
    for (const t of titles) LINES.push(['TITLE', JSON.stringify(t), '=>', JSON.stringify(plainTitle(t))].join(' '));
    const links = [' javascript:alert(1)', '\tjavascript:alert(1)', 'java\nscript:alert(1)', 'JaVaScRiPt:alert(1)', 'TODO:急ぎ', '会議: メモ', '#見出し', '//evil.example.com/x', 'C:/tmp/x', 'note:2024', ''];
    for (const l of links) LINES.push(['EXPORTED', JSON.stringify(l), '=> scheme', JSON.stringify(urlScheme(l)), '=>', JSON.stringify(exportedLink(l))].join(' '));
    LINES.push(['AUTO', JSON.stringify(autolinkUrl('www')), JSON.stringify(autolinkUrl('図/メモ@2x.png'))].join(' '));
    writeFileSync('/tmp/claude-501/review-probe.txt', LINES.join('\n'));
    expect(true).toBe(true);
  });
});
