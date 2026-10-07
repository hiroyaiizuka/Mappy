/**
 * The evidence gate for a PR (LEV-306, docs/harness.md「完了の受領記録と証跡の機械ゲート」). Read only and opt-in:
 * it reads the PR (`gh pr view`: state, head, base sha and branch, CI; the base branch's tip and whether the head
 * contains it, from GitHub) before and after the rest, puts together the worker's receipt and its ACK for that head
 * (scripts/handoff.mjs) and the real-Obsidian JSONs (`harness` in each, scripts/e2e/provenance.mjs), and says PASS only
 * when all of them are there and agree. Otherwise:
 *   FAIL        something ran and failed: a CI check, `npm run check` or the review in the receipt, a case (or a row of
 *               one: `passed` with failures, a step that threw, a stopped case, a summary with a failed case)
 *   STALE       evidence of something else: another HEAD (even with the same sha256, the owner's rule of 2026-10-03),
 *               a tree with uncommitted changes, another build, other plugin bytes than this checkout's dist, a HEAD or
 *               build that changed between the start and the end of the case; a receipt or ACK of another issue, PR
 *               number, base branch or base sha than the PR gated, a review against another commit than the base
 *               branch's tip now (the base moved since); a head that does not contain the base's tip; a PR that is no
 *               longer open (and the PR itself: its state, head, base or CI changed while the evidence was read, so
 *               the verdict would be about a PR that no longer is; LEV-306's comment of 2026-10-03)
 *   INCOMPLETE  something is missing or not finished: no CI checks, a pending or skipped one, a required check not
 *               passed, no receipt or ACK at the head, a review of another commit than the head, no JSON, no
 *               `--require-case` or a required case not among the JSONs, a JSON without HEAD / build / sha256
 * The worst of these is the verdict, and every reason is listed.
 *
 * The sha256 the JSONs must have is that of this checkout's packaged release build, read with preflight.mjs's
 * `readHarnessBuild` (which also refuses a dist/mappy that differs from the root build), so the gate runs in the
 * checkout that built what the cases ran on (`npm run harness:prepare`), at the PR's head with no changes;
 * elsewhere, or for another `--build`, it says INCOMPLETE rather than compare against another build.
 *
 * CI: every check reported for the head must be SUCCESS. `check` (the Quality checks job) is always required and must
 * have passed; `--require-check` adds more. A skipped check is INCOMPLETE unless its name is given with `--skippable`
 * (opt-in per run: e.g. release.yml's `release` and `attest`, which run only on a tag), and a required check cannot be
 * made skippable. Cases: each `--require-case` (a summary's case name, or the case a case JSON names itself, `case`,
 * else its file name without `.json`) must be among the JSONs. A script behind two cases (E84 and its `--cut`) names the
 * one it ran, so a run of the other saved under this one's name does not stand for it (LEV-309).
 *
 * Usage: npm run harness:gate -- --pr <number> --issue <KEY-123> --e2e <case.json|summary.json>...
 *          --require-case <name>... [--build release] [--require-check <name>]... [--skippable <name>]...
 * Prints the verdict and the reasons; exit 0 for PASS, 1 otherwise, 2 for a usage error.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ISSUE, baseTipOf, bindingMismatches, containsBaseOf, git, handoffDir, parseOptions, readAck, readReceipt, receiptErrors,
  receiptName, viewPr,
} from './handoff.mjs';
import { getHarnessPaths, pluginFiles, readHarnessBuild } from './preflight.mjs';

export const VERDICTS = ['PASS', 'INCOMPLETE', 'STALE', 'FAIL'];
const SHA_OF = value => typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);

/**
 * What the gate reads of the PR before and after the evidence; any of them changing in between voids the verdict.
 * `baseTip` is the base branch's tip read from GitHub beside `gh pr view` (`baseRefOid` need not follow the branch).
 */
export const PR_IDENTITY = ['state', 'headRefOid', 'baseRefOid', 'baseRefName', 'baseTip'];
/**
 * `gh pr view`'s fields for the first read, and for the second (the identity and CI: a check that finished or was
 * re-run in between voids the verdict too).
 */
export const PR_FIELDS = ['number', 'state', 'headRefOid', 'baseRefOid', 'baseRefName', 'statusCheckRollup'];
export const PR_FIELDS_AFTER = [...PR_IDENTITY.filter(field => field !== 'baseTip'), 'statusCheckRollup'];
/** The Quality checks job: always required, whatever `--require-check` adds. */
export const ALWAYS_REQUIRED = ['check'];

const checkName = item => item.name ?? item.context ?? '(unnamed)';
/** A rollup as comparable text: each check's name and state, in a fixed order. */
const rollupText = rollup => JSON.stringify((Array.isArray(rollup) ? rollup : [])
  .map(item => [checkName(item), item.status ?? '', item.conclusion ?? '', item.state ?? '']).sort());

/**
 * The case names a JSON stands for: a summary's case names, or the case a case JSON names itself (`case`), else its
 * file name without `.json`.
 */
export function caseNames({ path, json }) {
  if (Array.isArray(json?.results)) return json.results.map(result => result?.name).filter(name => typeof name === 'string');
  if (typeof json?.case === 'string') return [json.case];
  return [basename(path).replace(/\.json$/u, '')];
}

/**
 * One check of `statusCheckRollup` (a CheckRun or a StatusContext) as `pass`, `pending`, `skipped` or `fail`. Only
 * SUCCESS passes: a skipped or neutral check did not show the head works, so it is `skipped` (INCOMPLETE), like a
 * pending one.
 */
export function checkState(item) {
  if ('state' in item && !('status' in item)) {
    if (item.state === 'SUCCESS') return 'pass';
    return ['PENDING', 'EXPECTED'].includes(item.state) ? 'pending' : 'fail';
  }
  if (item.status !== 'COMPLETED') return 'pending';
  if (item.conclusion === 'SUCCESS') return 'pass';
  return ['SKIPPED', 'NEUTRAL'].includes(item.conclusion) ? 'skipped' : 'fail';
}

/** A JSON written by `finish` (case-runner.mjs) checked against the PR's head and the expected build. */
function caseReasons(label, record, { head, build, sha256 }) {
  const reasons = [];
  const add = (verdict, message) => reasons.push({ verdict, message: `${label}: ${message}` });
  if (!record || typeof record !== 'object') { add('INCOMPLETE', 'not a case record'); return reasons; }
  const failures = Array.isArray(record.failures) ? record.failures : null;
  if (failures === null) add('INCOMPLETE', 'no failures list');
  else if (failures.length > 0) add('FAIL', `${failures.length} failure(s): ${failures.slice(0, 3).join(' / ')}`);
  if (record.passed !== true) add('FAIL', `passed is ${JSON.stringify(record.passed)}`);
  if (record.stopped) add('FAIL', `stopped: ${record.stopped}`);
  // makeStep records a step that threw as `{ error }` alone (and lists it in failures, which a hand-edited file may not).
  const thrown = Object.entries(record.steps ?? {})
    .filter(([, value]) => value && typeof value === 'object' && Object.keys(value).length === 1 && 'error' in value);
  if (thrown.length > 0) add('FAIL', `step(s) threw: ${thrown.map(([name]) => name).join(', ')}`);

  const harness = record.harness;
  if (!harness || typeof harness !== 'object') { add('INCOMPLETE', 'no harness (HEAD, build, sha256): a run before LEV-306'); return reasons; }
  if (typeof harness.head !== 'string' || harness.head === '') add('INCOMPLETE', 'no HEAD');
  else if (harness.head !== head) add('STALE', `ran on ${harness.head}, not the PR's head ${head}`);
  if (harness.dirty === true) add('STALE', 'ran on a tree with uncommitted changes (tracked, or untracked and not ignored)');
  else if (harness.dirty !== false) add('INCOMPLETE', 'whether the tree was clean is not recorded');
  const kind = harness.build?.kind;
  if (typeof kind !== 'string' || kind === '') add('INCOMPLETE', 'no build kind');
  else if (kind !== build) add('STALE', `ran on the ${kind} build, not ${build}`);
  for (const file of pluginFiles) {
    const actual = harness.sha256?.[file];
    if (typeof actual !== 'string' || actual === '') add('INCOMPLETE', `no sha256 of ${file}`);
    else if (sha256 === null) add('INCOMPLETE', `no ${file} of this checkout's build to compare with`);
    else if (actual !== sha256[file]) add('STALE', `${file} was ${actual.slice(0, 12)}…, not this build's ${sha256[file]?.slice(0, 12)}…`);
  }
  // `finish` reads the provenance at the end; `createRecord` read it at the start. A rebuild or a commit in between
  // means the end's values may not be what the window ran.
  const start = harness.start;
  if (!start || typeof start !== 'object') add('INCOMPLETE', 'no provenance from the start of the run');
  else {
    // Only values read at both ends are compared: one missing at the end is already INCOMPLETE above.
    const differs = (before, after) => typeof after === 'string' && after !== '' && before !== after;
    const moved = [];
    if (differs(start.head, harness.head)) moved.push(`HEAD ${start.head} -> ${harness.head}`);
    if (differs(start.build?.kind, kind)) moved.push(`build ${start.build?.kind} -> ${kind}`);
    for (const file of pluginFiles) if (differs(start.sha256?.[file], harness.sha256?.[file])) moved.push(`${file}`);
    if (moved.length > 0) add('STALE', `changed during the run: ${moved.join(', ')}`);
    if (start.dirty === true) add('STALE', 'started on a tree with uncommitted changes');
    else if (start.dirty !== false) add('INCOMPLETE', 'whether the tree was clean at the start is not recorded');
  }
  return reasons;
}

/**
 * The verdict for one PR. `pr`: `PR_FIELDS` from `gh pr view`, `baseTip`, and `headContainsBase` (whether the head has
 * the base's tip in its history), read before the evidence; `prAfter`: `PR_FIELDS_AFTER` and `baseTip` read again
 * after it. `cases`: the case names (`--require-case`) the PR needs, each among the JSONs. `receipt`, `ack`: the handoff files at that head (or null). `e2e`: `[{ path, json }]` with
 * `json` null when unreadable. `expected`: `{ build, sha256 }`, `sha256` null when this checkout cannot vouch for a
 * build.
 */
export function evaluateGate({ issue, pr, prAfter, receipt, ack, e2e, expected, cases = [], ci = {} }) {
  const required = [...new Set([...ALWAYS_REQUIRED, ...(ci.required ?? [])])];
  const skippable = ci.skippable ?? [];
  const reasons = [];
  const add = (verdict, message) => reasons.push({ verdict, message });
  const head = pr?.headRefOid;
  if (!Number.isInteger(pr?.number)) add('INCOMPLETE', "the PR's number is unknown");
  if (pr?.state !== 'OPEN') add('STALE', `the PR is ${pr?.state ?? 'of unknown state'}, not open`);
  for (const field of PR_IDENTITY) {
    const before = pr?.[field];
    if (typeof before !== 'string' || before === '') { add('INCOMPLETE', `the PR's ${field} is unknown`); continue; }
    if (prAfter?.[field] !== before) add('STALE', `the PR's ${field} changed while the evidence was read: ${before} -> ${prAfter?.[field]}`);
  }
  // The head must hold the base's tip (rebased onto it); a review against a newer tip is not enough.
  if (pr?.headContainsBase === false) add('STALE', `the head does not contain the base's tip ${pr?.baseTip}: rebase onto it`);
  else if (pr?.headContainsBase !== true) add('INCOMPLETE', "whether the head contains the base's tip is unknown");

  const checks = Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : [];
  if (checks.length === 0) add('INCOMPLETE', 'CI: no checks reported for the head');
  if (rollupText(checks) !== rollupText(prAfter?.statusCheckRollup)) add('STALE', 'CI: the checks changed while the evidence was read');
  for (const name of required) {
    if (!checks.some(item => checkName(item) === name && checkState(item) === 'pass')) {
      add('INCOMPLETE', `CI: the required check ${name} has not passed for the head`);
    }
  }
  for (const item of checks) {
    const state = checkState(item);
    const name = checkName(item);
    if (state === 'pending') add('INCOMPLETE', `CI: ${name} has not finished (${item.status ?? item.state})`);
    // A required check cannot be skipped away.
    if (state === 'skipped' && (required.includes(name) || !skippable.includes(name))) add('INCOMPLETE', `CI: ${name} did not run (${item.conclusion})`);
    if (state === 'fail') add('FAIL', `CI: ${name} is ${item.conclusion ?? item.state}`);
  }

  // The receipt and the ACK count only for this PR at this head and base: another PR with the same head, or this PR
  // before a retarget or a moved base, does not lend its check, review or ACK.
  if (!receipt) add('INCOMPLETE', 'receipt: none at the head (scripts/handoff.mjs receipt)');
  else {
    for (const error of receiptErrors(receipt, { reviewBase: false })) add('INCOMPLETE', `receipt: ${error}`);
    if (receipt.issue !== issue) add('STALE', `receipt: written for ${receipt.issue}, not ${issue}`);
    const mismatches = bindingMismatches(receipt, pr);
    for (const mismatch of mismatches) add('STALE', `receipt: ${mismatch}`);
    // The review counts only against the base branch as it is now: a merge into the base since makes it stale.
    if (receipt.review?.baseSha !== pr?.baseTip) {
      add('STALE', `receipt: the review compared against ${receipt.review?.baseSha}, not the base's tip ${pr?.baseTip}`);
    }
    // A review of an earlier commit may or may not cover the fixes since (only Low ones may skip it): never PASS.
    if (typeof head === 'string' && SHA_OF(receipt.review?.head) && receipt.review.head !== head) {
      add('INCOMPLETE', `receipt: the review was taken on ${receipt.review.head}, not the head ${head}; the review is taken again on the final head (the orchestrator's step)`);
    }
    for (const key of ['check', 'review']) {
      const result = receipt[key]?.result;
      if (result === undefined) add('INCOMPLETE', `receipt: no ${key} result`);
      else if (result !== 'pass') add('FAIL', `receipt: ${key} is ${result}`);
    }
  }
  if (!ack) add('INCOMPLETE', 'ack: the receipt at the head is not acknowledged (scripts/handoff.mjs ack)');
  else {
    if (ack.issue !== issue) add('STALE', `ack: for ${ack.issue}, not ${issue}`);
    if (typeof head === 'string' && ack.receipt !== receiptName(issue, head)) add('STALE', `ack: of ${ack.receipt}, not ${receiptName(issue, head)}`);
    for (const mismatch of bindingMismatches(ack, pr)) add('STALE', `ack: ${mismatch}`);
  }

  if (!Array.isArray(e2e) || e2e.length === 0) add('INCOMPLETE', 'e2e: no JSON given');
  // Which cases the PR needs is named, so an unrelated JSON cannot stand in for them.
  if (cases.length === 0) add('INCOMPLETE', 'e2e: no case required (--require-case)');
  const given = new Set((e2e ?? []).filter(({ json }) => json && typeof json === 'object').flatMap(caseNames));
  for (const name of cases) if (!given.has(name)) add('INCOMPLETE', `e2e: the required case ${name} is not among the JSONs`);
  for (const { path, json } of e2e ?? []) {
    if (json === null || typeof json !== 'object') { add('INCOMPLETE', `${path}: unreadable`); continue; }
    const context = { head, build: expected.build, sha256: expected.sha256 };
    if (!Array.isArray(json.results)) { reasons.push(...caseReasons(path, json, context)); continue; }
    // A summary.json of `npm run harness:e2e`: every case, each with its own record.
    if (json.passed !== true) add('FAIL', `${path}: the run's passed is ${JSON.stringify(json.passed)}`);
    if (json.results.length === 0) add('INCOMPLETE', `${path}: no cases`);
    for (const result of json.results) {
      const label = `${path} › ${result?.name}`;
      if (result?.passed !== true) add('FAIL', `${label}: exit code ${result?.exitCode}`);
      if (!result?.record) add('INCOMPLETE', `${label}: no record`);
      else {
        // run.mjs runs a case's file with its args: a record of the other case of the same file is not this one.
        if (typeof result.record.case === 'string' && result.record.case !== result.name) add('FAIL', `${label}: the record is of the case ${result.record.case}`);
        reasons.push(...caseReasons(label, result.record, context));
      }
    }
  }

  const verdict = reasons.reduce((worst, { verdict: next }) => (VERDICTS.indexOf(next) > VERDICTS.indexOf(worst) ? next : worst), 'PASS');
  return { verdict, head: head ?? null, reasons };
}


function parseArgs(args) {
  const options = parseOptions(args, ['e2e', 'require-case', 'require-check', 'skippable']);
  const unknown = Object.keys(options).filter(key => !['e2e', 'require-case', 'require-check', 'skippable', 'pr', 'issue', 'build'].includes(key));
  if (unknown.length > 0) throw new Error(`unknown option --${unknown[0]}`);
  if (!/^\d+$/u.test(options.pr ?? '') || !ISSUE.test(options.issue ?? '')) {
    throw new Error('Usage: npm run harness:gate -- --pr <number> --issue <KEY-123> --e2e <json>... --require-case <name>... [--build release] [--require-check <name>]... [--skippable <name>]...');
  }
  return options;
}

/**
 * Reads the PR (`readPr(PR_FIELDS)`), the evidence at its head (`collect(pr)`: `{ issue, receipt, ack, e2e, expected,
 * ci, local }`), then the PR again (`readPr(PR_FIELDS_AFTER)`), and judges. The second read is what catches a push, a
 * retarget or a merge into the base while the evidence was read.
 */
export function runGate({ readPr, collect }) {
  const pr = readPr(PR_FIELDS);
  const { local = [], ...evidence } = collect(pr);
  const prAfter = readPr(PR_FIELDS_AFTER);
  const result = evaluateGate({ pr, prAfter, ...evidence });
  for (const message of local) result.reasons.push({ verdict: 'INCOMPLETE', message: `build: ${message}` });
  if (local.length > 0 && result.verdict === 'PASS') result.verdict = 'INCOMPLETE';
  return result;
}

function collect(options, pr) {
  const head = pr.headRefOid;
  const dir = handoffDir();
  const receipt = readReceipt(dir, options.issue, head);
  const ack = readAck(dir, options.issue, head);
  const e2e = options.e2e.map(path => {
    try { return { path, json: JSON.parse(readFileSync(path, 'utf8')) }; } catch { return { path, json: null }; }
  });
  // Only this checkout's build at the PR's head, with nothing uncommitted, is what the JSONs are compared with.
  let sha = null;
  const local = [];
  const checkout = git(['rev-parse', 'HEAD']);
  if (checkout !== head) local.push(`this checkout is at ${checkout}, not the PR's head ${head}`);
  if (git(['status', '--porcelain', '--untracked-files=normal']) !== '') local.push('this checkout has uncommitted changes (tracked, or untracked and not ignored)');
  const build = options.build ?? 'release';
  if (build !== 'release') local.push(`only the release build (dist/mappy) is compared here, not ${build}`);
  if (local.length === 0) {
    try {
      // The build only: the vault MAPPY_E2E_VAULT names (perhaps another checkout's) is not this gate's to check.
      const { files } = readHarnessBuild(getHarnessPaths({ env: {} }));
      sha = Object.fromEntries(pluginFiles.map(file => [file, createHash('sha256').update(files.get(file)).digest('hex')]));
    } catch (error) { local.push(`no packaged build to compare with: ${error.message}`); }
  }
  const ci = { required: options['require-check'], skippable: options.skippable };
  return { issue: options.issue, receipt, ack, e2e, expected: { build, sha256: sha }, cases: options['require-case'], ci, local };
}

function main(argv) {
  const options = parseArgs(argv);
  const readPr = fields => {
    const pr = viewPr(options.pr, fields);
    const baseTip = baseTipOf(pr.baseRefName);
    return { ...pr, baseTip, headContainsBase: containsBaseOf(baseTip, pr.headRefOid) };
  };
  return runGate({ readPr, collect: pr => collect(options, pr) });
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedAsScript) {
  try {
    const result = main(process.argv.slice(2));
    console.log(`${result.verdict} (head ${result.head})`);
    for (const { verdict, message } of result.reasons) console.log(`- [${verdict}] ${message}`);
    process.exitCode = result.verdict === 'PASS' ? 0 : 1;
  } catch (error) {
    console.error(`harness-gate: ${error.message}`);
    process.exitCode = 2;
  }
}
