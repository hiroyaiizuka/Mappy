#!/usr/bin/env node
// LEV-239: every test file that builds a view closes it after each test with `closeOpenViews()`
// (tests/mocks/open-views.ts), and tests/setup-view-teardown.ts fails a test that leaves one open.
// This checks both halves file by file, with two runs of the whole suite: as it is, every file passes; with
// MAPPY_SKIP_VIEW_CLOSE set, which turns every `closeOpenViews()` into nothing (the teardown taken out), every
// file that calls it fails, and for a view left open. It also lists a file that builds a view and never calls it.
// No file is edited.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// The switch `closeOpenViews` reads (tests/mocks/open-views.ts `SKIP_CLOSE_ENV`); checked below against that file.
const SKIP_CLOSE_ENV = 'MAPPY_SKIP_VIEW_CLOSE';
/**
 * What builds a view in a test: the shipped map view, the shared mount, or a harness view stand-in, in a file that loads
 * the view or the harness (tests/mocks/obsidian.ts has a `MarkdownView` of its own, a plain record with no lifecycle).
 * A file this misses is still caught when it runs: the setup file fails a test that leaves a view open.
 */
const BUILDS = /new MindmapView\(|mountMapView\(|new MarkdownView\(/;
const LOADS = /browser-harness\/obsidian|src\/ui\/mindmap-view|\.\/map-view-mount/;
const LEFT_OPEN = /view\(s\) left open/;

function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return /\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

/**
 * One vitest run of the files, without a shell: its JSON report, one entry per file keyed by real path (vitest reports
 * absolute paths, which a symlinked checkout would not match otherwise). A run that wrote no report is thrown, with
 * what it printed.
 */
function vitest(files, env) {
  const dir = mkdtempSync(join(tmpdir(), 'mappy-view-teardown-'));
  const report = join(dir, 'report.json');
  return new Promise((resolve, reject) => {
    const args = ['vitest', 'run', '--reporter=json', `--outputFile=${report}`, ...files.map(file => relative(root, file))];
    execFile('npx', args, { cwd: root, env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      try {
        if (!existsSync(report)) throw new Error(`vitest wrote no report (${error?.message ?? 'no error'}):\n${stdout}${stderr}`);
        const results = new Map();
        for (const result of JSON.parse(readFileSync(report, 'utf8')).testResults) {
          const failures = result.assertionResults.filter(test => test.status === 'failed');
          const messages = [result.message ?? '', ...failures.flatMap(test => test.failureMessages)].join('\n');
          results.set(realpathSync(result.name), { passed: result.status === 'passed', failed: failures.length, total: result.assertionResults.length, leftOpen: LEFT_OPEN.test(messages) });
        }
        resolve(results);
      } catch (failure) {
        reject(failure);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

const files = testFiles(join(root, 'tests')).sort();
// A file with the teardown calls it (a mention in a comment does not count).
const CALLS = /^\s*(?:afterEach\(async \(\) => \{ )?await closeOpenViews\(\);/m;
const teardown = files.filter(file => CALLS.test(readFileSync(file, 'utf8')));
const missing = files.filter(file => {
  const text = readFileSync(file, 'utf8');
  return !teardown.includes(file) && BUILDS.test(text) && LOADS.test(text);
});

if (teardown.length === 0) throw new Error('No test file calls closeOpenViews(): nothing to check');
if (!readFileSync(join(root, 'tests/mocks/open-views.ts'), 'utf8').includes(`SKIP_CLOSE_ENV = '${SKIP_CLOSE_ENV}'`)) {
  throw new Error(`tests/mocks/open-views.ts no longer reads ${SKIP_CLOSE_ENV}: the second run would keep the teardown`);
}
// The run as it is must not inherit the switch from the shell.
const asIs = { ...process.env };
delete asIs[SKIP_CLOSE_ENV];
const kept = await vitest(teardown, asIs);
const removed = await vitest(teardown, { ...process.env, [SKIP_CLOSE_ENV]: '1' });
let bad = 0;
for (const file of teardown) {
  const as = kept.get(realpathSync(file));
  const without = removed.get(realpathSync(file));
  const good = !!as?.passed && !!without && !without.passed && without.leftOpen;
  if (!good) bad += 1;
  const tests = without ? `${without.failed} of ${without.total} tests failed` : 'no report';
  console.log(`${as?.passed ? 'PASS' : 'FAIL'} as is / ${without && !without.passed ? 'FAIL' : 'PASS'} without teardown${without?.leftOpen ? ', left open' : ''} (${tests})  ${relative(root, file)}`);
}
for (const file of missing) console.log(`MISSING closeOpenViews() in a file that builds a view: ${relative(root, file)}`);
console.log(`\n${teardown.length} files: ${teardown.length - bad} pass as is and fail without the teardown; ${bad} do not; ${missing.length} missing.`);
process.exit(bad || missing.length ? 1 : 0);
