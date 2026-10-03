/**
 * A worker's completion receipt and its ACK (LEV-306, docs/harness.md「完了の受領記録と証跡の機械ゲート」). Opt-in:
 * nothing else reads or writes these files, and not running this leaves the harness as it was.
 *
 *   receipt  (the worker, in its worktree, after `npm run check` and the review) writes
 *            `<dir>/<issue>-<headSha>.json`: issue, the PR (number, base branch and `baseRefOid` as `gh pr view` gives
 *            them when the receipt is written), the base branch's tip at that moment (`baseTip`, read from the branch
 *            itself, since `baseRefOid` need not follow the branch between pushes), the HEAD and its commit time,
 *            check's and the review's results and times, the review's range and the base commit the review compared
 *            against (`--review-base-sha`: what the range's base, e.g. `origin/main`, pointed at when the review ran;
 *            it must be `baseTip`), and the evidence paths. The PR's head must be this HEAD and the tree must have no
 *            tracked changes (the HEAD must be what was checked). check must have run on this HEAD (its time not
 *            before the HEAD's commit time); the review may be older (AGENTS.md: findings fixed after it need only
 *            check again). Times are ISO 8601 with a zone and not later than the receipt itself. A receipt is never
 *            replaced: a new result needs a new commit (after a retarget or a moved base, rebase, check and review
 *            again, and write again). The review's base commit is the worker's own record: the receipt binds it to
 *            the base, it does not prove the review saw it.
 *   ack      (the orchestrator) reads the PR given with `--pr` (`gh pr view`: number, head, base branch and sha), takes
 *            the issue's receipt at that head, and records `<dir>/<issue>-<headSha>.ack.json` only when the receipt's
 *            PR and base are that PR's and its check and review passed. A second ack of the same (issue, headSha)
 *            for the same PR and base is `duplicate` and writes nothing; a failed result, a receipt (or an earlier
 *            ACK) of another PR or base, or no receipt at the PR's head, is `rejected` and writes nothing.
 *
 * Both files are written whole or not at all: to a temporary file first, then linked to the final name, which fails
 * when the name exists, and the temporary file is removed whatever happens. A reader never sees half a file.
 *
 * `<dir>` is `.tooling/handoff/` in the primary checkout (the directory holding the git common dir), so every
 * worktree of the repository writes to the same place; `MAPPY_HANDOFF_DIR` replaces it. Git ignores `/.tooling/`.
 *
 * Usage:
 *   node scripts/handoff.mjs receipt --issue LEV-306 --pr 170 --check pass --check-at <ISO time>
 *        --review pass --review-at <ISO time> --review-range origin/main...HEAD --review-base-sha <sha>
 *        [--evidence <path>]...
 *   node scripts/handoff.mjs ack --issue LEV-306 --pr 170
 * Each prints one JSON line (`status`: written / exists / acked / duplicate / rejected); exit 0 except rejected (1)
 * and usage errors (2).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ISSUE = /^[A-Z]+-\d+$/u;
const SHA = /^[0-9a-f]{40}$/u;
/** ISO 8601 with a time zone: `Date.parse` alone takes `10/3/2026` and reads it in local time. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u;
const RESULTS = ['pass', 'fail'];
/** What `gh pr view` is asked for: the PR a receipt or an ACK is bound to. */
export const PR_BINDING = ['number', 'headRefOid', 'baseRefName', 'baseRefOid'];

export const receiptName = (issue, headSha) => `${issue}-${headSha}.json`;
export const ackName = (issue, headSha) => `${issue}-${headSha}.ack.json`;

/** Whether `range` is a review of `headSha` against `baseRefName` (`origin/main...HEAD`, `main...<headSha>`, ...). */
export function rangeOnBase(range, baseRefName, headSha) {
  if (typeof range !== 'string' || typeof baseRefName !== 'string') return false;
  const [base, head, ...rest] = range.split('...');
  return rest.length === 0 && [baseRefName, `origin/${baseRefName}`].includes(base) && ['HEAD', headSha].includes(head);
}

const time = value => (typeof value === 'string' && ISO_TIME.test(value) ? Date.parse(value) : Number.NaN);

/**
 * What is wrong with a receipt; empty when it can be acknowledged. With `reviewBase: false` the review's base commit
 * is not compared with the receipt's `baseTip` (the gate compares it with the base's tip now).
 */
export function receiptErrors(receipt, { reviewBase = true } = {}) {
  const errors = [];
  if (!receipt || typeof receipt !== 'object') return ['not an object'];
  if (!ISSUE.test(receipt.issue ?? '')) errors.push('issue');
  if (!Number.isInteger(receipt.pr) || receipt.pr <= 0) errors.push('pr');
  if (!SHA.test(receipt.headSha ?? '')) errors.push('headSha');
  if (typeof receipt.baseRefName !== 'string' || receipt.baseRefName === '') errors.push('baseRefName');
  if (!SHA.test(receipt.baseRefOid ?? '')) errors.push('baseRefOid');
  if (!SHA.test(receipt.baseTip ?? '')) errors.push('baseTip');
  const committed = time(receipt.headCommittedAt);
  if (Number.isNaN(committed)) errors.push('headCommittedAt');
  const written = time(receipt.writtenAt);
  if (Number.isNaN(written)) errors.push('writtenAt');
  for (const key of ['check', 'review']) {
    if (!RESULTS.includes(receipt[key]?.result)) errors.push(`${key}.result`);
    const at = time(receipt[key]?.at);
    if (Number.isNaN(at)) errors.push(`${key}.at (not an ISO 8601 time with a zone)`);
    else if (at > written) errors.push(`${key}.at (later than the receipt itself)`);
  }
  if (time(receipt.check?.at) < committed) errors.push('check.at (before the HEAD was committed: it ran on an earlier commit)');
  if (!rangeOnBase(receipt.review?.range, receipt.baseRefName, receipt.headSha)) errors.push('review.range (not against baseRefName)');
  if (!SHA.test(receipt.review?.baseSha ?? '')) errors.push('review.baseSha');
  else if (reviewBase && receipt.review.baseSha !== receipt.baseTip) errors.push('review.baseSha (not baseTip: the review compared against another base commit)');
  if (!Array.isArray(receipt.evidence) || !receipt.evidence.every(path => typeof path === 'string')) errors.push('evidence');
  return errors;
}

/**
 * How a receipt or an ACK (`pr`, `headSha`, `baseRefName`, `baseRefOid`) differs from the PR it is checked against
 * (`gh pr view`'s `PR_BINDING`); empty when it is that PR at that head and base.
 */
export function bindingMismatches(record, pr) {
  const pairs = [['pr', 'number'], ['headSha', 'headRefOid'], ['baseRefName', 'baseRefName'], ['baseRefOid', 'baseRefOid']];
  return pairs.filter(([own, theirs]) => record?.[own] !== pr?.[theirs])
    .map(([own, theirs]) => `${own} ${JSON.stringify(record?.[own])} is not the PR's ${theirs} ${JSON.stringify(pr?.[theirs])}`);
}

/** Writes `value` as JSON to `path` whole, unless `path` exists; false when it did. */
function writeOnce(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Writes `receipt` once; an existing receipt for the same (issue, headSha) is kept as it is (`exists`). */
export function writeReceipt(dir, receipt) {
  const errors = receiptErrors(receipt);
  if (errors.length > 0) return { status: 'rejected', reason: `invalid receipt: ${errors.join(', ')}` };
  mkdirSync(dir, { recursive: true });
  const path = join(dir, receiptName(receipt.issue, receipt.headSha));
  return writeOnce(path, receipt) ? { status: 'written', path } : { status: 'exists', path };
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** The file names of the issue's receipts in `dir` (not read). */
export function receiptNames(dir, issue) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter(name => name.startsWith(`${issue}-`) && name.endsWith('.json') && !name.endsWith('.ack.json')
      && SHA.test(name.slice(issue.length + 1, -'.json'.length)))
    .sort();
}

/** The issue's receipt at `headSha`, or null (none, or unreadable). */
export function readReceipt(dir, issue, headSha) {
  return readJson(join(dir, receiptName(issue, headSha)));
}

export function readAck(dir, issue, headSha) {
  return readJson(join(dir, ackName(issue, headSha)));
}

/**
 * Acknowledges the issue's receipt for `pr` (`PR_BINDING` from `gh pr view`): the receipt at the PR's head, written
 * for this PR number, base branch and base sha, with check and review passed. Once per (issue, headSha): the link to
 * the final name is what decides, so two acks racing each other still record one, and the second reads the first's
 * whole file; an earlier ACK for another PR or base is not taken as this one's. Nothing is written for a receipt it
 * refuses, so the ACK of a later, passing receipt at another head is not blocked.
 */
export function ackReceipt(dir, { issue, pr, now = new Date() }) {
  if (!ISSUE.test(issue ?? '')) return { status: 'rejected', reason: `not an issue key: ${issue}` };
  const prHead = pr?.headRefOid;
  if (!SHA.test(prHead ?? '')) return { status: 'rejected', reason: `the PR's head is not a commit: ${prHead}` };
  const name = receiptName(issue, prHead);
  const receipt = readReceipt(dir, issue, prHead);
  if (receipt === null) {
    const receipts = receiptNames(dir, issue);
    return {
      status: 'rejected',
      reason: receipts.length === 0 ? `no receipt for ${issue}` : `no receipt for ${issue} at the PR's head ${prHead}`,
      receipts,
    };
  }
  const errors = receiptErrors(receipt);
  if (receipt.issue !== issue) errors.push('issue differs from the file name');
  if (errors.length > 0) return { status: 'rejected', reason: `invalid receipt ${name}: ${errors.join(', ')}` };
  const mismatches = bindingMismatches(receipt, pr);
  if (mismatches.length > 0) return { status: 'rejected', reason: `receipt ${name} is not for this PR: ${mismatches.join('; ')}` };
  const failed = ['check', 'review'].filter(key => receipt[key].result !== 'pass');
  if (failed.length > 0) return { status: 'rejected', reason: `receipt ${name}: ${failed.join(' and ')} did not pass` };
  const path = join(dir, ackName(issue, prHead));
  const ack = {
    issue, pr: pr.number, headSha: prHead, baseRefName: pr.baseRefName, baseRefOid: pr.baseRefOid,
    receipt: name, ackedAt: now.toISOString(),
  };
  if (writeOnce(path, ack)) return { status: 'acked', path, ack };
  const earlier = readJson(path);
  const differ = bindingMismatches(earlier, pr);
  if (differ.length > 0) return { status: 'rejected', reason: `an ACK for another PR or base is recorded at ${prHead}: ${differ.join('; ')}`, path };
  return { status: 'duplicate', path, ack: earlier };
}

/** `git <args>` in `cwd`, trimmed; throws when git fails. */
export function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** `.tooling/handoff/` beside the git common dir, i.e. in the primary checkout whatever worktree runs this. */
export function handoffDir(cwd = process.cwd()) {
  if (process.env.MAPPY_HANDOFF_DIR) return resolve(process.env.MAPPY_HANDOFF_DIR);
  const common = realpathSync(resolve(cwd, git(['rev-parse', '--git-common-dir'], cwd)));
  return join(dirname(common), '.tooling', 'handoff');
}

/** The tip of the base branch on GitHub now (not the PR's `baseRefOid`, which need not follow the branch). */
export function baseTipOf(baseRefName) {
  return execFileSync('gh', ['api', `repos/{owner}/{repo}/git/ref/heads/${baseRefName}`, '--jq', '.object.sha'],
    { encoding: 'utf8' }).trim();
}

/** The PR as a receipt or an ACK is bound to it (`gh pr view`, `fields` beside `PR_BINDING`). */
export function viewPr(pr, fields = PR_BINDING) {
  return JSON.parse(execFileSync('gh', ['pr', 'view', String(pr), '--json', fields.join(',')], { encoding: 'utf8' }));
}

function parseOptions(args, multi = []) {
  const options = Object.fromEntries(multi.map(name => [name, []]));
  for (let at = 0; at < args.length; at += 2) {
    const name = args[at];
    const value = args[at + 1];
    if (!name.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    const key = name.slice(2);
    if (multi.includes(key)) options[key].push(value); else if (key in options) throw new Error(`${name} given twice`); else options[key] = value;
  }
  return options;
}

function main(argv) {
  const [command, ...args] = argv;
  const options = parseOptions(args, ['evidence']);
  if (!['receipt', 'ack'].includes(command)) {
    throw new Error('Usage: node scripts/handoff.mjs receipt|ack --issue <KEY-123> --pr <number> ... (see the comment at the top)');
  }
  const known = command === 'receipt'
    ? ['issue', 'pr', 'check', 'check-at', 'review', 'review-at', 'review-range', 'review-base-sha', 'evidence']
    : ['issue', 'pr', 'evidence'];
  const unknown = Object.keys(options).filter(key => !known.includes(key));
  if (unknown.length > 0 || (command === 'ack' && options.evidence.length > 0)) throw new Error(`unknown option --${unknown[0] ?? 'evidence'}`);
  if (!ISSUE.test(options.issue ?? '')) throw new Error('--issue <KEY-123> is required');
  if (!/^\d+$/u.test(options.pr ?? '')) throw new Error('--pr <number> is required');
  const dir = handoffDir();
  const pr = viewPr(options.pr);
  if (command === 'ack') return ackReceipt(dir, { issue: options.issue, pr });

  if (git(['status', '--porcelain', '--untracked-files=no']) !== '') {
    return { status: 'rejected', reason: 'the tree has uncommitted tracked changes: commit them, so the HEAD is what was checked' };
  }
  const headSha = git(['rev-parse', 'HEAD']);
  if (pr.headRefOid !== headSha) {
    return { status: 'rejected', reason: `PR #${pr.number}'s head is ${pr.headRefOid}, not this HEAD ${headSha}: push first` };
  }
  const reviewBase = options['review-base-sha'] ?? '';
  try {
    git(['rev-parse', '--verify', '--quiet', `${reviewBase}^{commit}`]);
  } catch {
    return { status: 'rejected', reason: `--review-base-sha ${reviewBase} is not a commit in this repository` };
  }
  return writeReceipt(dir, {
    issue: options.issue,
    pr: pr.number,
    headSha,
    headCommittedAt: git(['show', '-s', '--format=%cI', 'HEAD']),
    baseRefName: pr.baseRefName,
    baseRefOid: pr.baseRefOid,
    baseTip: baseTipOf(pr.baseRefName),
    check: { result: options.check, at: options['check-at'] },
    review: { result: options.review, at: options['review-at'], range: options['review-range'] ?? null, baseSha: reviewBase },
    evidence: options.evidence,
    writtenAt: new Date().toISOString(),
  });
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedAsScript) {
  try {
    const result = main(process.argv.slice(2));
    console.log(JSON.stringify(result));
    process.exitCode = result.status === 'rejected' ? 1 : 0;
  } catch (error) {
    console.error(`handoff: ${error.message}`);
    process.exitCode = 2;
  }
}
