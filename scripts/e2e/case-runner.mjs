/**
 * Shared boilerplate for a single e2e case file (docs/harness.md 実機検証): argv flags, the
 * step/check/record shape E37 (`paste-image.mjs`) established, and writing the JSON + PASS/FAIL a case
 * reports. `run.mjs` registers the case files that use this; each stays runnable on its own
 * (`node scripts/e2e/<file>.mjs`), which is what `npm run harness:e2e:<name>` calls.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { heldEntry, sharedUses, windowWatch } from './instance.mjs';
import { provenance } from './provenance.mjs';

/**
 * A positive numeric `export const <name> = <number>` of src/layout/layout.ts, the value `harness:prepare` builds. For a
 * case that follows the source on purpose; a case that must catch the constant being changed back fixes its value instead.
 */
export async function layoutConstant(name) {
  const source = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'layout', 'layout.ts'), 'utf8');
  const found = source.match(new RegExp(`export const ${name}\\s*=\\s*([\\d_.]+)`, 'u'))?.[1]?.replaceAll('_', '');
  const number = Number(found);
  if (!found || !Number.isFinite(number) || number <= 0) throw new Error(`${name} is not a positive number in src/layout/layout.ts`);
  return number;
}

export function parseArgs(argv = process.argv) {
  const args = argv.slice(2);
  return {
    args,
    flag: name => args.includes(name),
    value: name => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; },
  };
}

/**
 * A case's record. The provenance at the start (provenance.mjs, LEV-306) is kept out of the record's own fields and
 * written by `finish` as `harness.start`, beside the end's, so a HEAD or build that changed during the run shows.
 */
export function createRecord(vault, note) {
  const record = { vault, note, steps: {}, failures: [] };
  Object.defineProperty(record, 'harnessAtStart', { value: provenance(vault), enumerable: false });
  return record;
}

/** Runs one named step, recording either its result or the error, and never throwing past it. */
export function makeStep(record) {
  return async (name, run) => {
    try { record.steps[name] = await run(); } catch (error) { record.steps[name] = { error: String(error) }; record.failures.push(`${name}: ${error}`); }
    // A step that returns undefined (a bug, not a case's expected shape) must not crash the logging
    // itself: JSON.stringify(undefined) is the value undefined, not a string, and undefined.slice would
    // throw here, uncaught — before `finish()` writes this case's JSON (run.mjs then has nothing of this
    // run's to read back, which is the point: never a stale file mistaken for this one).
    console.log(name, JSON.stringify(record.steps[name] ?? null).slice(0, 700));
    return record.steps[name];
  };
}

export function makeCheck(record) {
  return (condition, failure) => { if (!condition) record.failures.push(failure); };
}

/**
 * Writes the record (if `--json <path>` was given), prints the verdict, and returns the process exit code. The record
 * gets `harness`: the HEAD, build and installed plugin files (provenance.mjs, LEV-306) read here at the end, with the
 * same read at `createRecord` as `harness.start`; the gate refuses a record whose two reads differ.
 */
export async function finish(record, jsonPath) {
  // The instance the case entered for (instance.mjs, LEV-327), so records of instances run side by side tell which is
  // which; null for a case that never connected (memory-procedure). A case that opened a window without asking to run
  // alone (cdp.mjs) took the OS focus from whatever ran beside it: it fails, so its `solo` gets written.
  const entry = heldEntry();
  // `windows`: whether the windows it opened were watched (cdp.mjs stops when some were open before the case).
  record.instance = entry ? { port: entry.port, vault: entry.vault, solo: entry.solo, windows: windowWatch() } : null;
  for (const use of sharedUses()) record.failures.push(`${use} without connect({ solo }): another instance's case may have lost the OS focus (docs/harness.md「専用の Obsidian を並べる」)`);
  record.passed = record.failures.length === 0;
  record.harness = { ...provenance(record.vault), start: record.harnessAtStart ?? null };
  if (jsonPath) await writeFile(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(record.passed ? 'PASS' : `FAIL\n- ${record.failures.join('\n- ')}`);
  return record.passed ? 0 : 1;
}

/**
 * Polls `test` every 100 ms and hands back its first truthy result; after `timeout` ms it throws `what`, so a wait that
 * never came fails its step instead of letting the next one read a state that was never reached.
 */
export async function until(test, timeout, what) {
  const started = Date.now();
  for (;;) {
    const result = await test();
    if (result) return result;
    if (Date.now() - started > timeout) throw new Error(`${what} (waited ${timeout} ms)`);
    await new Promise(resolve => { setTimeout(resolve, 100); });
  }
}

/**
 * Thrown by `required` to end a case at a failed precondition: the steps after it would only drive the map
 * through a state the case was not written for and bury the one real failure under a cascade of others. The
 * case catches it around its steps, so `finish` still writes the record (with `stopped`) and reports FAIL.
 */
export class StopCase extends Error {}

/** Ends the case (see `StopCase`) if the step's result is a recorded error; otherwise hands the result back. */
export function required(record, name, result) {
  if (result && typeof result === 'object' && 'error' in result) {
    record.stopped = `${name} failed; the remaining steps were not run`;
    throw new StopCase(record.stopped);
  }
  return result;
}
