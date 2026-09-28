#!/usr/bin/env node
// LEV-239: every test file that builds a view closes it after each test with `closeOpenViews()`
// (tests/mocks/open-views.ts), and tests/setup-view-teardown.ts fails a test that leaves one open.
// This checks both halves file by file: the file passes as it is, and fails once its `closeOpenViews()`
// calls are taken out (the teardown removed). It also lists a file that builds a view and never calls it.
// The files are edited in place for the second run and always put back.
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const CALL = /[ \t]*await closeOpenViews\(\);[ \t]*\n?/g;
/**
 * What builds a view in a test: the shipped map view, the shared mount, or a harness view stand-in, in a file that loads
 * the view or the harness (tests/mocks/obsidian.ts has a `MarkdownView` of its own, a plain record with no lifecycle).
 * A file this misses is still caught when it runs: the setup file fails a test that leaves a view open.
 */
const BUILDS = /new MindmapView\(|mountMapView\(|new MarkdownView\(/;
const LOADS = /harness\/browser\/obsidian|src\/ui\/mindmap-view|\.\/map-view-mount/;
const LEFT_OPEN = 'left open after the test';

function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return /\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

/** One vitest run of one file, without a shell: the exit status and everything it printed. */
function vitest(file) {
  return new Promise(resolve => {
    execFile('npx', ['vitest', 'run', relative(root, file)], { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout}${stderr}` });
    });
  });
}

const files = testFiles(join(root, 'tests')).sort();
const teardown = files.filter(file => readFileSync(file, 'utf8').includes('closeOpenViews'));
const missing = files.filter(file => {
  const text = readFileSync(file, 'utf8');
  return !teardown.includes(file) && BUILDS.test(text) && LOADS.test(text);
});

const originals = new Map(teardown.map(file => [file, readFileSync(file, 'utf8')]));
const restore = () => { for (const [file, text] of originals) writeFileSync(file, text); };
process.on('SIGINT', () => { restore(); process.exit(130); });

const rows = [];
try {
  for (const file of teardown) {
    const kept = await vitest(file);
    const text = originals.get(file);
    const stripped = text.replace(CALL, '');
    if (stripped === text) throw new Error(`No closeOpenViews() call to take out of ${relative(root, file)}`);
    writeFileSync(file, stripped);
    const removed = await vitest(file);
    writeFileSync(file, text);
    const caught = !removed.ok && removed.output.includes(LEFT_OPEN);
    const tests = /Tests\s+(.*)/.exec(removed.output)?.[1]?.trim() ?? '?';
    rows.push({ kept: kept.ok, caught });
    console.log(`${kept.ok ? 'PASS' : 'FAIL'} as is / ${caught ? 'FAIL' : 'PASS'} without teardown (${tests})  ${relative(root, file)}`);
  }
} finally {
  restore();
}

for (const file of missing) console.log(`MISSING closeOpenViews() in a file that builds a view: ${relative(root, file)}`);
const bad = rows.filter(row => !row.kept || !row.caught).length;
console.log(`\n${rows.length} files: ${rows.length - bad} pass as is and fail without the teardown; ${bad} do not; ${missing.length} missing.`);
process.exit(bad || missing.length ? 1 : 0);
