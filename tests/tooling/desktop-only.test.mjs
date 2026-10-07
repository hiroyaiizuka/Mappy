import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * `isDesktopOnly` decides whether Obsidian offers and loads Mappy on iOS and Android, and the two READMEs'
 * Compatibility tables tell users the same thing in their own words. LEV-249 set it to `true` for the version
 * submitted to the community directory (mobile hadn't been tried; docs/community-submission.md §4.4 (B)), and on
 * 2026-10-02 the owner decided Mappy stays desktop only (same section). This keeps the mobile row of
 * both READMEs tied to the manifest: the row names the manifest key exactly when it is `true`. Only that token is
 * checked, not the words around it, and other passages that mention mobile (the beta banner, the synced
 * `.obsidian` note) are not pinned, so changing the value would still mean reading every mention of mobile in both READMEs. That the
 * value is a boolean is checked by scripts/validate-release.mjs.
 */
const manifest = JSON.parse(await readFile(new URL('../../manifest.json', import.meta.url), 'utf8'));
const ROWS = [
  ['README.md', '| iOS and Android |'],
  ['README.ja.md', '| iOS・Android |'],
];

describe('Mappy stays desktop only (the person\'s decision, 2026-10-02)', () => {
  // The AI feature (M9) reaches Node at run time (docs/architecture.md §11.1), and Submission requirements want
  // `isDesktopOnly: true` for that; on 2026-10-02 the person decided that all of Mappy stays desktop only, rather
  // than asking the review about mobile or splitting AI into another plugin.
  it('manifest.json keeps isDesktopOnly: true', () => {
    expect(manifest.isDesktopOnly).toBe(true);
  });
});

describe("isDesktopOnly and the READMEs' mobile row", () => {
  it.each(ROWS)("%s's mobile row matches isDesktopOnly", async (file, rowStart) => {
    const readme = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    const rows = readme.split('\n').filter((line) => line.startsWith(rowStart));
    expect(rows).toHaveLength(1);
    expect(rows[0].includes('`isDesktopOnly`')).toBe(manifest.isDesktopOnly);
  });
});
