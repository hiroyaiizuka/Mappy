// Which test files scripts/check-view-teardown.mjs (LEV-239) holds to `closeOpenViews()`, apart from the script so
// tests/tooling/view-teardown-loads.test.mjs can read the same patterns without running vitest.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What builds a view in a test: the shipped map view, the shared mount, or a harness view stand-in, in a file that loads
 * the view or the harness (tests/mocks/obsidian.ts has a `MarkdownView` of its own, a plain record with no lifecycle).
 * The harness mock is named by its path (`harnessObsidian` in scripts/browser-harness.mjs), so `LOADS` moves with it.
 * A file this misses is still caught when it runs: the setup file fails a test that leaves a view open.
 */
export const BUILDS = /new MindmapView\(|mountMapView\(|new MarkdownView\(/;
export const LOADS = /browser-harness\/obsidian|src\/ui\/mindmap-view|\.\/map-view-mount/;

export function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return /\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}
