/**
 * Runs the real-Obsidian e2e cases (docs/harness.md 実機検証) registered below, one Obsidian
 * connection at a time (only one instance to drive: AGENTS.md「実機を使うチケットは同時に1本にする」).
 *
 * Each case stays a standalone script (`node scripts/e2e/<file>.mjs`, wired to its own
 * `npm run harness:e2e:<name>`); this file only sequences them and points `--json`/`--shot` at
 * per-case paths so a full run does not have every case overwrite the same file.
 *
 * Usage: npm run harness:e2e -- [--case <name>] [--reload] [--json <dir>] [--shot <dir>] [--keep]
 *   --case   run only the named case (see CASES below) instead of all of them
 *   --json   directory to write <case>.json into (and, for a full run, a summary.json)
 *   --shot   directory to write <case>.png into, for cases that take one
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const CASES = [
  { name: 'add-delete', file: 'add-delete.mjs', description: 'E02 兄弟・子の追加と削除', shot: false },
  { name: 'undo-redo', file: 'undo-redo.mjs', description: 'E03 Undo/Redo と表裏切替', shot: false },
  { name: 'move-parent-text', file: 'move-parent-text.mjs', description: 'E19 親本文を挟む移動', shot: false },
  { name: 'paste', file: 'paste-image.mjs', description: 'E37 画像の貼り付け', shot: true },
];

const args = process.argv.slice(2);
let caseName; let jsonDir; let shotDir;
const passthrough = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--case') { caseName = args[i += 1]; continue; }
  if (args[i] === '--json') { jsonDir = args[i += 1]; continue; }
  if (args[i] === '--shot') { shotDir = args[i += 1]; continue; }
  passthrough.push(args[i]);
}

const targets = caseName ? CASES.filter(item => item.name === caseName) : CASES;
if (caseName && targets.length === 0) {
  console.error(`Unknown case "${caseName}". Known: ${CASES.map(item => item.name).join(', ')}`);
  process.exit(2);
}

if (jsonDir) await mkdir(jsonDir, { recursive: true });
if (shotDir) await mkdir(shotDir, { recursive: true });

const run = testCase => new Promise(resolve => {
  const caseArgs = [...passthrough];
  if (jsonDir) caseArgs.push('--json', join(jsonDir, `${testCase.name}.json`));
  if (shotDir && testCase.shot) caseArgs.push('--shot', join(shotDir, `${testCase.name}.png`));
  console.log(`\n=== ${testCase.name}: ${testCase.description} ===`);
  const child = spawn(process.execPath, [join(here, testCase.file), ...caseArgs], { stdio: 'inherit' });
  child.on('exit', code => resolve(code ?? 1));
  child.on('error', error => { console.error(error); resolve(1); });
});

const results = [];
for (const testCase of targets) {
  // Cases share the one Obsidian window (AGENTS.md「実機を使うチケットは同時に1本にする」) and must not overlap.
  const exitCode = await run(testCase);
  results.push({ name: testCase.name, description: testCase.description, exitCode, passed: exitCode === 0 });
}

const passed = results.every(result => result.passed);
if (jsonDir) {
  const summary = { startedAt: new Date().toISOString(), passed, results };
  // Fold in each case's own record (steps/failures) when it wrote one, so the summary is self-contained.
  for (const result of summary.results) {
    try {
      result.record = JSON.parse(await readFile(join(jsonDir, `${result.name}.json`), 'utf8'));
    } catch {
      // The case did not write its own JSON (e.g. it failed before `finish()`); the exit code still stands.
    }
  }
  await writeFile(join(jsonDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

console.log(`\n${passed ? 'PASS' : 'FAIL'}: ${results.map(result => `${result.name}=${result.passed ? 'PASS' : 'FAIL'}`).join(' ')}`);
process.exit(passed ? 0 : 1);
