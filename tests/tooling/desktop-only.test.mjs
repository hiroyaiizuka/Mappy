import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * `isDesktopOnly` decides whether Obsidian offers and loads Mappy on iOS and Android, and the two READMEs'
 * Compatibility tables tell users the same thing in their own words. LEV-249 set it to `true` for the version
 * submitted to the community directory (mobile hasn't been tried; docs/community-submission.md §4.4 (B)), and
 * turning it back to `false` after checking mobile is meant to be one version bump. This keeps the mobile row of
 * both READMEs saying the same as the manifest, so neither can flip without the other: the row names the
 * manifest key exactly when it is `true` (the words around it are each README's own). That the value is a
 * boolean is checked by scripts/validate-release.mjs. Other passages that mention mobile are not pinned.
 */
const manifest = JSON.parse(await readFile(new URL('../../manifest.json', import.meta.url), 'utf8'));
const ROWS = [
  ['README.md', '| iOS and Android |'],
  ['README.ja.md', '| iOS・Android |'],
];

describe("isDesktopOnly and the READMEs' mobile row", () => {
  it.each(ROWS)("%s's mobile row matches isDesktopOnly", async (file, rowStart) => {
    const readme = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    const rows = readme.split('\n').filter((line) => line.startsWith(rowStart));
    expect(rows).toHaveLength(1);
    expect(rows[0].includes('`isDesktopOnly`')).toBe(manifest.isDesktopOnly);
  });
});
