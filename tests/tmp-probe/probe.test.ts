import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { plainTitle } from '../../src/core/plain-text';
import { attachmentEntries } from '../../src/core/attachments';

describe('probe', () => {
  it('shows what the parser makes of scheme-less links', () => {
    const cases = [
      '見て www.example.com/a',
      '見て <www.example.com/a>',
      '連絡 someone@example.com',
      '連絡 <someone@example.com>',
      '[見て](www.example.com/a)',
      '[[www.example.com]]',
      '見て https://example.com/a',
      'WWW.EXAMPLE.COM',
      'ftp.example.com/x',
      '見て www.example.com/a です',
      'www.example.com/a',
    ];
    const lines = cases.map(value =>
      `${JSON.stringify(value)} -> title ${JSON.stringify(plainTitle(value))} | body ${JSON.stringify(attachmentEntries(value))}`);
    writeFileSync('/tmp/probe-out.txt', lines.join('\n'));
    expect(true).toBe(true);
  });
});
