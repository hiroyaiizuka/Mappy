import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { plainTitle } from '../../src/core/plain-text';
import { attachmentEntries } from '../../src/core/attachments';
import { autolinkUrl, exportedLink, urlScheme } from '../../src/core/wiki-link';

describe('xr probe', () => {
  it('prints', () => {
    const out: string[] = [];
    const bodies = [
      '見て www.example.com:8080/a',
      'www.example.com:8080/a',
      '連絡 someone@example.com',
      'メモ file@2x.png',
      '画像 図@2x.png を見る',
      'ftp.example.com/x',
      'mailto:a@b.com',
      '見て http://example.com/a',
      'javascript:alert(1)',
      'www.example.com/a?q=1&b=2',
      'WWW.EXAMPLE.COM/a',
      'see www.example.com.',
      'a@b.c',
      '<javascript:alert(1)>',
      '<www.example.com/a>',
    ];
    for (const b of bodies) {
      out.push(`BODY ${JSON.stringify(b)} => ${JSON.stringify(attachmentEntries(b))} | TITLE ${JSON.stringify(plainTitle(b))}`);
    }
    const links = [' javascript:alert(1)', '\tjavascript:alert(1)', 'java\nscript:alert(1)', 'java\tscript:alert(1)', 'JaVaScRiPt:alert(1)', '\u0000javascript:alert(1)', 'TODO:急ぎ', '//evil.example.com/x', 'C:/tmp/x', '#h', ''];
    for (const l of links) out.push(`EXPORTED ${JSON.stringify(l)} scheme=${JSON.stringify(urlScheme(l))} => ${JSON.stringify(exportedLink(l))}`);
    const autos = ['www.example.com:8080/a', 'www.example.com', 'a@b.c:25', 'name@ex.com?subject=x', 'WWW.x.com'];
    for (const a of autos) out.push(`AUTO ${JSON.stringify(a)} => ${JSON.stringify(autolinkUrl(a))}`);
    writeFileSync('/tmp/claude-501/xr-probe.txt', out.join('\n'));
    expect(true).toBe(true);
  });
});
