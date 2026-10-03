/**
 * The evidence gate for a PR (LEV-306, docs/harness.md「完了の受領記録と証跡の機械ゲート」). Read only and opt-in:
 * it reads the PR (`gh pr view`: head, base sha and branch, CI) before and after the rest, puts together the worker's
 * receipt and its ACK for that head (scripts/handoff.mjs) and the real-Obsidian JSONs (`harness` in each,
 * scripts/e2e/provenance.mjs), and says PASS only when all of them are there and agree. Otherwise:
 *   FAIL        something ran and failed: a CI check, `npm run check` or the review in the receipt, a case (or a row of
 *               one: `passed` with failures, a step that threw, a stopped case, a summary with a failed case)
 *   STALE       evidence of something else: another HEAD (even with the same sha256, the owner's rule of 2026-10-03),
 *               a tree with uncommitted changes, another build, other plugin bytes than this checkout's dist; a
 *               receipt or ACK of another PR number, base branch or base sha than the PR gated
 *               (and the PR itself: its head, base sha or base branch changed while the evidence was read, so the
 *               verdict would be about a PR that no longer is; LEV-306's comment of 2026-10-03)
 *   INCOMPLETE  something is missing or not finished: no CI checks, a pending or skipped one, no receipt or ACK at the
 *               head, no JSON, a JSON without HEAD / build / sha256
 * The worst of these is the verdict, and every reason is listed.
 *
 * The sha256 the JSONs must have is that of this checkout's packaged build (`--dist`, default dist/mappy), so the gate
 * runs in the checkout that built what the cases ran on (`npm run harness:prepare`), at the PR's head with no tracked
 * changes; elsewhere it says INCOMPLETE rather than compare against another build.
 *
 * CI: every check reported for the head must be SUCCESS, and each `--require-check` name (default `check`, the Quality
 * checks job) must be among them, so a head where only some workflows have reported yet does not pass. A skipped check
 * is INCOMPLETE unless its name is given with `--skippable` (opt-in per run: e.g. release.yml's `release` and `attest`,
 * which run only on a tag and are skipped on a PR by design).
 *
 * Usage: npm run harness:gate -- --pr <number> --issue <KEY-123> --e2e <case.json|summary.json>... [--build release]
 *          [--dist dist/mappy] [--require-check <name>]... [--skippable <name>]...
 * Prints the verdict and the reasons; exit 0 for PASS, 1 otherwise, 2 for a usage error.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bindingMismatches, handoffDir, readAck, readReceipt, receiptErrors, receiptName } from './handoff.mjs';
import { pluginFiles } from './preflight.mjs';

export const VERDICTS = ['PASS', 'INCOMPLETE', 'STALE', 'FAIL'];

/** What the gate reads of the PR before and after the evidence; any of them changing in between voids the verdict. */
export const PR_IDENTITY = ['headRefOid', 'baseRefOid', 'baseRefName'];
export const PR_FIELDS = ['number', ...PR_IDENTITY, 'statusCheckRollup'];

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
  if (harness.dirty === true) add('STALE', 'ran on a tree with uncommitted tracked changes');
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
  return reasons;
}

/**
 * The verdict for one PR. `pr`: `PR_FIELDS` from `gh pr view`, read before the evidence; `prAfter`: `PR_IDENTITY`
 * read again after it. `receipt`, `ack`: the handoff files at that head (or null). `e2e`: `[{ path, json }]` with
 * `json` null when unreadable. `expected`: `{ build, sha256 }`, `sha256` null when this checkout cannot vouch for a
 * build.
 */
export function evaluateGate({ issue, pr, prAfter, receipt, ack, e2e, expected, ci = {} }) {
  const { required = ['check'], skippable = [] } = ci;
  const reasons = [];
  const add = (verdict, message) => reasons.push({ verdict, message });
  const head = pr?.headRefOid;
  if (!Number.isInteger(pr?.number)) add('INCOMPLETE', "the PR's number is unknown");
  for (const field of PR_IDENTITY) {
    const before = pr?.[field];
    if (typeof before !== 'string' || before === '') { add('INCOMPLETE', `the PR's ${field} is unknown`); continue; }
    if (prAfter?.[field] !== before) add('STALE', `the PR's ${field} changed while the evidence was read: ${before} -> ${prAfter?.[field]}`);
  }

  const checks = Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : [];
  const checkName = item => item.name ?? item.context ?? '(unnamed)';
  if (checks.length === 0) add('INCOMPLETE', 'CI: no checks reported for the head');
  for (const name of required) {
    if (!checks.some(item => checkName(item) === name)) add('INCOMPLETE', `CI: the required check ${name} has not reported for the head`);
  }
  for (const item of checks) {
    const state = checkState(item);
    const name = checkName(item);
    if (state === 'pending') add('INCOMPLETE', `CI: ${name} has not finished (${item.status ?? item.state})`);
    if (state === 'skipped' && !skippable.includes(name)) add('INCOMPLETE', `CI: ${name} did not run (${item.conclusion})`);
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
    // A moved base is already reported above; the review's own base is a second cause only when the receipt's is right.
    if (receipt.baseRefOid === pr?.baseRefOid && receipt.review?.baseSha !== pr?.baseRefOid) {
      add('STALE', `receipt: the review compared against ${receipt.review?.baseSha}, not the PR's base ${pr?.baseRefOid}`);
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
      else reasons.push(...caseReasons(label, result.record, context));
    }
  }

  const verdict = reasons.reduce((worst, { verdict: next }) => (VERDICTS.indexOf(next) > VERDICTS.indexOf(worst) ? next : worst), 'PASS');
  return { verdict, head: head ?? null, reasons };
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function parseArgs(args) {
  const lists = ['--e2e', '--require-check', '--skippable'];
  const options = { e2e: [], 'require-check': [], skippable: [] };
  for (let at = 0; at < args.length; at += 2) {
    const name = args[at];
    const value = args[at + 1];
    if (![...lists, '--pr', '--issue', '--build', '--dist'].includes(name)) throw new Error(`unknown option ${name}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    if (lists.includes(name)) options[name.slice(2)].push(value); else options[name.slice(2)] = value;
  }
  if (!/^\d+$/u.test(options.pr ?? '') || !/^[A-Z]+-\d+$/u.test(options.issue ?? '')) {
    throw new Error('Usage: npm run harness:gate -- --pr <number> --issue <KEY-123> --e2e <json>... [--build release] [--dist dist/mappy]');
  }
  return options;
}

/**
 * Reads the PR (`readPr`), the evidence at its head (`collect(pr)`: `{ receipt, ack, e2e, expected, local }`), then
 * the PR again, and judges. The second read is what catches a push or a retarget while the evidence was read.
 */
export function runGate({ readPr, collect }) {
  const pr = readPr();
  const { local = [], ...evidence } = collect(pr);
  const prAfter = readPr();
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
  if (git(['status', '--porcelain', '--untracked-files=no']) !== '') local.push('this checkout has uncommitted tracked changes');
  if (local.length === 0) {
    const dist = resolve(options.dist ?? join('dist', 'mappy'));
    try { sha = Object.fromEntries(pluginFiles.map(file => [file, sha256(join(dist, file))])); } catch { local.push(`${dist} has no packaged build (npm run package)`); }
  }
  const ci = { required: options['require-check'].length > 0 ? options['require-check'] : ['check'], skippable: options.skippable };
  return { issue: options.issue, receipt, ack, e2e, expected: { build: options.build ?? 'release', sha256: sha }, ci, local };
}

function main(argv) {
  const options = parseArgs(argv);
  const readPr = () => JSON.parse(execFileSync('gh', ['pr', 'view', options.pr, '--json', PR_FIELDS.join(',')], { encoding: 'utf8' }));
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
