// Which test files scripts/check-view-teardown.mjs (LEV-239) holds to `closeOpenViews()`, apart from the script so
// tests/tooling/view-teardown-loads.test.mjs can read the same patterns without running vitest.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { harnessObsidian } from './browser-harness.mjs';

const escape = text => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// The harness mock as a test imports it: its folder and name, without the extension (`browser-harness/obsidian`).
const harnessImport = harnessObsidian.replace(/\.ts$/, '').split('/').slice(-2).join('/');

/**
 * What builds a view in a test: the shipped map view, the shared mount, or a harness view stand-in, in a file that loads
 * the view or the harness (tests/mocks/obsidian.ts has a `MarkdownView` of its own, a plain record with no lifecycle).
 * The harness mock comes from `harnessObsidian` (scripts/browser-harness.mjs), so `LOADS` moves with the harness.
 * A file this misses is still caught when it runs: the setup file fails a test that leaves a view open.
 */
export const BUILDS = /new MindmapView\(|mountMapView\(|new MarkdownView\(/;
export const LOADS = new RegExp(`${escape(harnessImport)}|src\\/ui\\/mindmap-view|\\.\\/map-view-mount`);

export function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return /\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}
