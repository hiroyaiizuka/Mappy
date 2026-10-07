/**
 * What a case's JSON was run on (LEV-306, docs/harness.md「証跡の機械ゲート」): the checkout's git HEAD, the build the
 * vault holds (its `.mappy-harness-build`, as LEV-273 writes it; a vault without the file holds `release`), and the
 * sha256 of the plugin files Obsidian loads from the vault. `finish` (case-runner.mjs) adds it to every case's JSON
 * under `harness`, so `npm run harness:gate` can refuse a JSON from another HEAD or another build.
 *
 * Read only, and never throws: a value it cannot read is `null` (the gate refuses a JSON with one), so a case still
 * writes its record. Recorded on every run rather than behind a variable: the fields are only added, and a run that
 * left them out could not be told from one that predates them.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginFiles } from '../preflight.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Its own small git call rather than handoff.mjs's: every case imports this file, and need not load that CLI.
function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function sha256(path) {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; }
}

export function provenance(vault, { root = projectRoot } = {}) {
  const head = git(root, ['rev-parse', 'HEAD']);
  // Untracked files count too (esbuild bundles whatever is imported, committed or not); ignored ones (artifacts/,
  // test-vault/, dist/) do not.
  const status = head === null ? null : git(root, ['status', '--porcelain', '--untracked-files=normal']);
  const mark = typeof vault === 'string' ? join(vault, '.mappy-harness-build') : null;
  const installed = typeof vault === 'string' ? join(vault, '.obsidian', 'plugins', 'mappy') : null;
  let kind = null;
  let marked = false;
  if (mark !== null) {
    // No mark means release only in a vault that holds the plugin; a case run without one (memory-procedure) has no build.
    try {
      if (existsSync(mark)) { kind = readFileSync(mark, 'utf8').trim() || null; marked = true; } else if (existsSync(installed)) kind = 'release';
    } catch { kind = null; }
  }
  return {
    head,
    dirty: status === null ? null : status.length > 0,
    build: { kind, marked },
    sha256: Object.fromEntries(pluginFiles.map(file => [file, installed === null ? null : sha256(join(installed, file))])),
    recordedAt: new Date().toISOString(),
  };
}
