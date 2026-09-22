/**
 * Shared boilerplate for a single e2e case file (docs/harness.md 実機検証): argv flags, the
 * step/check/record shape E37 (`paste-image.mjs`) established, and writing the JSON + PASS/FAIL a case
 * reports. `run.mjs` registers the case files that use this; each stays runnable on its own
 * (`node scripts/e2e/<file>.mjs`), which is what `npm run harness:e2e:<name>` calls.
 */
import { writeFile } from 'node:fs/promises';

export function parseArgs(argv = process.argv) {
  const args = argv.slice(2);
  return {
    args,
    flag: name => args.includes(name),
    value: name => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; },
  };
}

export function createRecord(vault, note) {
  return { vault, note, steps: {}, failures: [] };
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

/** Writes the record (if `--json <path>` was given), prints the verdict, and returns the process exit code. */
export async function finish(record, jsonPath) {
  record.passed = record.failures.length === 0;
  if (jsonPath) await writeFile(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(record.passed ? 'PASS' : `FAIL\n- ${record.failures.join('\n- ')}`);
  return record.passed ? 0 : 1;
}
