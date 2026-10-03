import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecord, finish } from '../../scripts/e2e/case-runner.mjs';
import { ackReceipt, readAck, writeReceipt } from '../../scripts/handoff.mjs';
import { evaluateGate, runGate } from '../../scripts/harness-gate.mjs';

/**
 * LEV-306: the completion receipt and its ACK (scripts/handoff.mjs), the HEAD / build / sha256 that `finish` adds to a
 * case's JSON (scripts/e2e/provenance.mjs), and the gate that puts them together with the PR (scripts/harness-gate.mjs).
 * Which change makes each test fail is in docs/harness.md「完了の受領記録と証跡の機械ゲート」 and the PR.
 */
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const SHA = { 'main.js': '1'.repeat(64), 'manifest.json': '2'.repeat(64), 'styles.css': '3'.repeat(64) };

const temporary = [];
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'mappy-lev306-')); temporary.push(dir); return dir; };
afterEach(() => { while (temporary.length > 0) rmSync(temporary.pop(), { recursive: true, force: true }); });

const BASE = 'c'.repeat(40);
const receiptAt = (headSha, overrides = {}) => ({
  issue: 'LEV-306', pr: 170, headSha, headCommittedAt: '2026-10-03T00:30:00Z', baseRefName: 'main', baseRefOid: BASE, baseTip: BASE,
  headContainsBase: true,
  writtenAt: '2026-10-03T02:00:00Z',
  check: { result: 'pass', at: '2026-10-03T01:00:00Z' },
  review: { result: 'pass', at: '2026-10-03T01:10:00Z', range: 'origin/main...HEAD', baseSha: BASE, head: headSha },
  evidence: ['artifacts/lev-306/record.md'], ...overrides,
});
const caseJson = (overrides = {}) => ({
  vault: '/v', note: 'Fixtures/E2E', steps: { open: { ok: true } }, failures: [], passed: true,
  harness: {
    head: HEAD, dirty: false, build: { kind: 'release', marked: true }, sha256: { ...SHA }, recordedAt: '2026-10-03T02:00:00Z',
    start: { head: HEAD, dirty: false, build: { kind: 'release', marked: true }, sha256: { ...SHA }, recordedAt: '2026-10-03T01:58:00Z' },
  },
  ...overrides,
});
const SUCCESS = [{ __typename: 'CheckRun', name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }];
/** What the gate reads again after the evidence (with the CI it read the first time). */
const IDENTITY = { state: 'OPEN', headRefOid: HEAD, baseRefOid: BASE, baseRefName: 'main', baseTip: BASE, statusCheckRollup: SUCCESS };
/** PR #170 as `gh pr view` gives it (with the base branch's tip), the PR the receipts and ACKs below are written for. */
const PR = { number: 170, headContainsBase: true, ...IDENTITY };
const prWith = statusCheckRollup => ({ ...PR, statusCheckRollup });
/** The same CI at both reads. */
const withCi = statusCheckRollup => ({ pr: prWith(statusCheckRollup), prAfter: { ...IDENTITY, statusCheckRollup } });
const ackOf = (overrides = {}) => ({
  issue: 'LEV-306', pr: 170, headSha: HEAD, baseRefName: 'main', baseRefOid: BASE, receipt: `LEV-306-${HEAD}.json`, ...overrides,
});
const green = (overrides = {}) => ({
  issue: 'LEV-306',
  pr: prWith(SUCCESS),
  prAfter: { ...IDENTITY },
  receipt: receiptAt(HEAD),
  ack: ackOf(),
  e2e: [{ path: 'ribbon-new-map.json', json: caseJson() }],
  expected: { build: 'release', sha256: { ...SHA } },
  cases: ['ribbon-new-map'],
  ...overrides,
});
const withHarness = harness => caseJson({ harness: { ...caseJson().harness, ...harness } });
/** A JSON whose whole run was on `harness` (the start's read the same), so only the rule under test can refuse it. */
const ranOn = harness => withHarness({ ...harness, start: { ...caseJson().harness.start, ...harness } });

describe('completion receipt and ACK', () => {
  it('acknowledges the same (issue, head) once; the second is a duplicate and writes nothing', () => {
    const dir = tempDir();
    expect(writeReceipt(dir, receiptAt(HEAD)).status).toBe('written');
    expect(writeReceipt(dir, receiptAt(HEAD, { writtenAt: '2026-10-03T02:30:00Z' })).status).toBe('exists');
    // Another result for the same HEAD is not taken as written: it needs a new commit.
    expect(writeReceipt(dir, receiptAt(HEAD, { check: { result: 'fail', at: '2026-10-03T01:30:00Z' } })).status).toBe('rejected');
    const first = ackReceipt(dir, { issue: 'LEV-306', pr: PR, now: new Date('2026-10-03T04:00:00Z') });
    const second = ackReceipt(dir, { issue: 'LEV-306', pr: PR, now: new Date('2026-10-03T05:00:00Z') });
    expect(first.status).toBe('acked');
    expect(second.status).toBe('duplicate');
    expect(readAck(dir, 'LEV-306', HEAD).ackedAt).toBe('2026-10-03T04:00:00.000Z');
    expect(readdirSync(dir).sort()).toEqual([`LEV-306-${HEAD}.ack.json`, `LEV-306-${HEAD}.json`]);
    expect(JSON.parse(readFileSync(join(dir, `LEV-306-${HEAD}.json`), 'utf8')).check.result).toBe('pass');
  });

  it('refuses a receipt written at an older HEAD than the PR head', () => {
    const dir = tempDir();
    writeReceipt(dir, receiptAt(OLD));
    const result = ackReceipt(dir, { issue: 'LEV-306', pr: PR });
    expect(result.status).toBe('rejected');
    expect(result.receipts).toEqual([`LEV-306-${OLD}.json`]);
    expect(readdirSync(dir)).toEqual([`LEV-306-${OLD}.json`]);
  });

  it('refuses a receipt whose contents name another head than its file', () => {
    const dir = tempDir();
    writeFileSync(join(dir, `LEV-306-${HEAD}.json`), JSON.stringify(receiptAt(OLD)));
    expect(ackReceipt(dir, { issue: 'LEV-306', pr: PR }).status).toBe('rejected');
  });

  it('refuses to acknowledge, for another PR with the same head, the receipt written for PR #170', () => {
    const dir = tempDir();
    writeReceipt(dir, receiptAt(HEAD));
    const result = ackReceipt(dir, { issue: 'LEV-306', pr: { ...PR, number: 171 } });
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/pr 170 is not the PR's number 171/u);
    expect(readdirSync(dir)).toEqual([`LEV-306-${HEAD}.json`]);
  });

  it.each([
    ['retargeted to another branch', { baseRefName: 'feature/ai' }],
    ["whose base's sha moved", { baseRefOid: 'd'.repeat(40) }],
  ])('refuses to acknowledge a receipt for the PR %s since it was written', (_, change) => {
    const dir = tempDir();
    writeReceipt(dir, receiptAt(HEAD));
    expect(ackReceipt(dir, { issue: 'LEV-306', pr: { ...PR, ...change } }).status).toBe('rejected');
    expect(readdirSync(dir)).toEqual([`LEV-306-${HEAD}.json`]);
  });

  it('does not take an ACK recorded for another PR or base as a duplicate of this one', () => {
    const dir = tempDir();
    writeReceipt(dir, receiptAt(HEAD));
    writeFileSync(join(dir, `LEV-306-${HEAD}.ack.json`), JSON.stringify(ackOf({ pr: 171 })));
    expect(ackReceipt(dir, { issue: 'LEV-306', pr: PR }).status).toBe('rejected');
  });

  it('refuses a receipt whose review range is not against its base', () => {
    const dir = tempDir();
    const result = writeReceipt(dir, receiptAt(HEAD, { review: { result: 'pass', at: '2026-10-03T01:10:00Z', range: 'origin/feature/ai...HEAD', baseSha: BASE, head: HEAD } }));
    expect(result.status).toBe('rejected');
    expect(writeReceipt(dir, receiptAt(HEAD, { review: { result: 'pass', at: '2026-10-03T01:10:00Z', range: null, baseSha: BASE, head: HEAD } })).status).toBe('rejected');
  });

  it('takes a check and a review from before the commit (the pre-commit hook runs check before it is made)', () => {
    const dir = tempDir();
    expect(writeReceipt(dir, receiptAt(HEAD, { headCommittedAt: undefined })).status).toBe('rejected');
    expect(readdirSync(dir)).toEqual([]);
    const early = '2026-10-03T00:10:00Z';
    const review = { result: 'pass', at: early, range: 'origin/main...HEAD', baseSha: BASE, head: HEAD };
    expect(writeReceipt(dir, receiptAt(HEAD, { check: { result: 'pass', at: early }, review })).status).toBe('written');
  });

  it.each([
    // On the review, which has no lower bound: on check, a local-time reading can also fall before the commit.
    ['not ISO 8601 (read in local time)', { review: { result: 'pass', at: '10/3/2026', range: 'origin/main...HEAD', baseSha: BASE, head: HEAD } }],
    ['without a time zone', { review: { result: 'pass', at: '2026-10-03T01:00:00', range: 'origin/main...HEAD', baseSha: BASE, head: HEAD } }],
    ['later than the receipt itself', { check: { result: 'pass', at: '2099-10-03T01:00:00Z' } }],
    ['a review later than the receipt', { review: { result: 'pass', at: '2099-10-03T01:00:00Z', range: 'origin/main...HEAD', baseSha: BASE, head: HEAD } }],
  ])('refuses a receipt with a time %s', (_, change) => {
    const dir = tempDir();
    expect(writeReceipt(dir, receiptAt(HEAD, change)).status).toBe('rejected');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('does not acknowledge a receipt whose review was against an earlier tip of the base branch', () => {
    const dir = tempDir();
    writeReceipt(dir, receiptAt(HEAD));
    // A merge into main since: the PR's baseRefOid need not follow, the branch's tip does.
    const result = ackReceipt(dir, { issue: 'LEV-306', pr: { ...PR, baseTip: 'd'.repeat(40) } });
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/the base moved since/u);
    expect(readdirSync(dir)).toEqual([`LEV-306-${HEAD}.json`]);
  });

  it("refuses a receipt whose HEAD does not contain the base's tip", () => {
    const dir = tempDir();
    const result = writeReceipt(dir, receiptAt(HEAD, { headContainsBase: false }));
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/headContainsBase/u);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('does not acknowledge a receipt whose review was taken on another commit than the head', () => {
    const dir = tempDir();
    writeReceipt(dir, receiptAt(HEAD, { review: { ...receiptAt(HEAD).review, head: OLD } }));
    const result = ackReceipt(dir, { issue: 'LEV-306', pr: PR });
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/the review was taken on b{40}/u);
    expect(readdirSync(dir)).toEqual([`LEV-306-${HEAD}.json`]);
  });

  it('does not acknowledge a receipt whose check or review failed, and writes nothing for it', () => {
    const dir = tempDir();
    writeReceipt(dir, receiptAt(HEAD, { check: { result: 'fail', at: '2026-10-03T01:00:00Z' } }));
    const result = ackReceipt(dir, { issue: 'LEV-306', pr: PR });
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/check did not pass/u);
    expect(readdirSync(dir)).toEqual([`LEV-306-${HEAD}.json`]);
  });

  it("refuses a receipt whose review compared against another commit than the PR's base", () => {
    const dir = tempDir();
    const review = { result: 'pass', at: '2026-10-03T01:10:00Z', range: 'origin/main...HEAD', head: HEAD };
    const older = writeReceipt(dir, receiptAt(HEAD, { review: { ...review, baseSha: 'e'.repeat(40) } }));
    expect(older.status).toBe('rejected');
    expect(older.reason).toMatch(/review\.baseSha \(not baseTip/u);
    expect(writeReceipt(dir, receiptAt(HEAD, { review })).status).toBe('rejected');
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('evidence gate', () => {
  it('passes only when the head, CI, receipt, ACK and every JSON agree', () => {
    expect(evaluateGate(green())).toEqual({ verdict: 'PASS', head: HEAD, reasons: [] });
  });

  it('refuses a JSON from another HEAD even when its sha256 are the same', () => {
    const result = evaluateGate(green({ e2e: [{ path: 'ribbon-new-map.json', json: ranOn({ head: OLD }) }] }));
    expect(result.verdict).toBe('STALE');
    expect(result.reasons.map(reason => reason.message)).toEqual([`ribbon-new-map.json: ran on ${OLD}, not the PR's head ${HEAD}`]);
  });

  it.each([
    ['another PR with the same head (#171)', { number: 171 }],
    ['this PR retargeted to another branch', { baseRefName: 'feature/ai' }],
    ["this PR after its base's sha moved", { baseRefOid: 'd'.repeat(40) }],
  ])("refuses the receipt and the ACK written for PR #170 at main's c… when gating %s", (_, change) => {
    const pr = { ...prWith(SUCCESS), ...change };
    const prAfter = { state: pr.state, headRefOid: pr.headRefOid, baseRefOid: pr.baseRefOid, baseRefName: pr.baseRefName, baseTip: pr.baseTip };
    const result = evaluateGate(green({ pr, prAfter }));
    expect(result.verdict).toBe('STALE');
    const messages = result.reasons.map(reason => reason.message);
    expect(messages.some(message => message.startsWith('receipt: '))).toBe(true);
    expect(messages.some(message => message.startsWith('ack: '))).toBe(true);
  });

  it("refuses a receipt whose review compared against another commit than the gated PR's base", () => {
    const review = { result: 'pass', at: '2026-10-03T01:10:00Z', range: 'origin/main...HEAD', baseSha: 'e'.repeat(40), head: HEAD };
    expect(evaluateGate(green({ receipt: receiptAt(HEAD, { review }) })).verdict).toBe('STALE');
  });

  it('refuses a review taken before a commit was merged into the base branch, though the PR was not pushed since', () => {
    const moved = { ...prWith(SUCCESS), baseTip: 'd'.repeat(40) };
    const result = evaluateGate(green({ pr: moved, prAfter: { ...IDENTITY, baseTip: moved.baseTip } }));
    expect(result.verdict).toBe('STALE');
    expect(result.reasons.map(reason => reason.message).join('\n')).toMatch(/not the base's tip d{40}/u);
  });

  it('never passes a review taken on another commit than the head (fixes since it may need it again)', () => {
    const review = { ...receiptAt(HEAD).review, head: OLD };
    const result = evaluateGate(green({ receipt: receiptAt(HEAD, { review }) }));
    expect(result.verdict).toBe('INCOMPLETE');
    expect(result.reasons.map(reason => reason.message)).toEqual([
      `receipt: the review was taken on ${OLD}, not the head ${HEAD}; the review is taken again on the final head (the orchestrator's step)`,
    ]);
  });

  it('refuses to write a receipt that does not name the commit the review was taken on', () => {
    const dir = tempDir();
    const review = { ...receiptAt(HEAD).review };
    delete review.head;
    expect(writeReceipt(dir, receiptAt(HEAD, { review })).status).toBe('rejected');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a PR that is no longer open', () => {
    // Merged before the gate's first read, so both reads agree and only the open-state rule can refuse it.
    const result = evaluateGate(green({ pr: { ...prWith(SUCCESS), state: 'MERGED' }, prAfter: { ...IDENTITY, state: 'MERGED' } }));
    expect(result.verdict).toBe('STALE');
    expect(result.reasons.map(reason => reason.message)).toEqual(['the PR is MERGED, not open']);
  });

  it('refuses a JSON whose case started on a tree with uncommitted changes, though it ended clean', () => {
    const json = withHarness({ start: { ...caseJson().harness.start, dirty: true } });
    const result = evaluateGate(green({ e2e: [{ path: 'ribbon-new-map.json', json }] }));
    expect(result.verdict).toBe('STALE');
    expect(result.reasons.map(reason => reason.message)).toEqual(['ribbon-new-map.json: started on a tree with uncommitted changes']);
    const unknown = withHarness({ start: { ...caseJson().harness.start, dirty: null } });
    const unrecorded = evaluateGate(green({ e2e: [{ path: 'ribbon-new-map.json', json: unknown }] }));
    expect(unrecorded.verdict).toBe('INCOMPLETE');
    expect(unrecorded.reasons.map(reason => reason.message)).toEqual(['ribbon-new-map.json: whether the tree was clean at the start is not recorded']);
  });

  it('refuses a JSON whose HEAD or installed build changed between the start and the end of the case', () => {
    const changed = { ...caseJson().harness.start, sha256: { ...SHA, 'main.js': '9'.repeat(64) } };
    expect(evaluateGate(green({ e2e: [{ path: 'ribbon-new-map.json', json: withHarness({ start: changed }) }] })).verdict).toBe('STALE');
    const earlier = { ...caseJson().harness.start, head: OLD };
    expect(evaluateGate(green({ e2e: [{ path: 'ribbon-new-map.json', json: withHarness({ start: earlier }) }] })).verdict).toBe('STALE');
    expect(evaluateGate(green({ e2e: [{ path: 'ribbon-new-map.json', json: withHarness({ start: undefined }) }] })).verdict).toBe('INCOMPLETE');
  });

  it('refuses a receipt or an ACK of another issue than the gated one', () => {
    expect(evaluateGate(green({ receipt: receiptAt(HEAD, { issue: 'LEV-999' }) })).verdict).toBe('STALE');
    expect(evaluateGate(green({ ack: ackOf({ issue: 'LEV-999' }) })).verdict).toBe('STALE');
    expect(evaluateGate(green({ ack: ackOf({ receipt: `LEV-306-${OLD}.json` }) })).verdict).toBe('STALE');
  });

  it('refuses an ACK alone that names another PR or base than the gated one', () => {
    expect(evaluateGate(green({ ack: ackOf({ pr: 171 }) })).verdict).toBe('STALE');
    expect(evaluateGate(green({ ack: ackOf({ baseRefName: 'feature/ai' }) })).verdict).toBe('STALE');
    expect(evaluateGate(green({ ack: ackOf({ baseRefOid: 'd'.repeat(40) }) })).verdict).toBe('STALE');
  });

  it('does not pass a receipt without its PR and base (written before the binding)', () => {
    const unbound = { ...receiptAt(HEAD), baseRef: 'origin/main' };
    delete unbound.baseRefName;
    delete unbound.baseRefOid;
    const result = evaluateGate(green({ receipt: unbound }));
    expect(result.verdict).not.toBe('PASS');
    expect(result.reasons).toContainEqual({ verdict: 'INCOMPLETE', message: 'receipt: baseRefName' });
  });

  it('refuses a receipt or an ACK from another HEAD', () => {
    expect(evaluateGate(green({ receipt: receiptAt(OLD) })).verdict).toBe('STALE');
    expect(evaluateGate(green({ ack: ackOf({ headSha: OLD }) })).verdict).toBe('STALE');
    expect(evaluateGate(green({ receipt: null })).verdict).toBe('INCOMPLETE');
    expect(evaluateGate(green({ ack: null })).verdict).toBe('INCOMPLETE');
  });

  it.each([
    ['no harness at all', caseJson({ harness: undefined })],
    ['no HEAD', withHarness({ head: null })],
    ['no build kind', withHarness({ build: { kind: null, marked: false } })],
    ['no sha256 of a file', withHarness({ sha256: { ...SHA, 'styles.css': null } })],
  ])('refuses a JSON with %s', (_, json) => {
    expect(evaluateGate(green({ e2e: [{ path: 'ribbon-new-map.json', json }] })).verdict).toBe('INCOMPLETE');
  });

  it.each([
    ['another build', ranOn({ build: { kind: 'ai-dev', marked: true } })],
    ['other plugin bytes', ranOn({ sha256: { ...SHA, 'main.js': '9'.repeat(64) } })],
    ['a tree with uncommitted changes', ranOn({ dirty: true })],
  ])('refuses a JSON run on %s', (_, json) => {
    expect(evaluateGate(green({ e2e: [{ path: 'ribbon-new-map.json', json }] })).verdict).toBe('STALE');
  });

  it('refuses a JSON whose rows only partly passed', () => {
    const partly = caseJson({ failures: ['plain (double click): the vault gained 2 notes'] });
    expect(evaluateGate(green({ e2e: [{ path: 'ribbon-new-map.json', json: partly }] })).verdict).toBe('FAIL');
    const threw = caseJson({ steps: { open: { ok: true }, click: { error: 'Error: timed out' } } });
    expect(evaluateGate(green({ e2e: [{ path: 'ribbon-new-map.json', json: threw }] })).verdict).toBe('FAIL');
    const stopped = caseJson({ stopped: 'plugin failed; the remaining steps were not run' });
    expect(evaluateGate(green({ e2e: [{ path: 'ribbon-new-map.json', json: stopped }] })).verdict).toBe('FAIL');
    const summary = { passed: false, results: [
      { name: 'a', passed: true, exitCode: 0, record: caseJson() },
      { name: 'b', passed: false, exitCode: 1, record: caseJson({ passed: false, failures: ['x'] }) },
    ] };
    expect(evaluateGate(green({ e2e: [{ path: 'summary.json', json: summary }] })).verdict).toBe('FAIL');
  });

  it.each([
    ['pending', [...SUCCESS, { __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: '' }]],
    ['a pending status', [{ __typename: 'StatusContext', context: 'ci', state: 'PENDING' }]],
    ['skipped', [...SUCCESS, { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SKIPPED' }]],
    ['neutral', [{ __typename: 'CheckRun', name: 'check', status: 'COMPLETED', conclusion: 'NEUTRAL' }]],
    ['none (no checks)', []],
  ])('does not pass while CI is %s', (_, rollup) => {
    expect(evaluateGate(green(withCi(rollup))).verdict).toBe('INCOMPLETE');
  });

  it('does not pass while a required check has not reported, though every reported one is SUCCESS', () => {
    const others = [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }];
    expect(evaluateGate(green(withCi(others))).verdict).toBe('INCOMPLETE');
    expect(evaluateGate(green({ ci: { required: ['check', 'build'] } })).verdict).toBe('INCOMPLETE');
  });

  it('passes a skipped check only when it is named skippable for the run', () => {
    const release = [...SUCCESS, { __typename: 'CheckRun', name: 'release', status: 'COMPLETED', conclusion: 'SKIPPED' }];
    expect(evaluateGate(green(withCi(release))).verdict).toBe('INCOMPLETE');
    expect(evaluateGate(green({ ...withCi(release), ci: { skippable: ['release'] } })).verdict).toBe('PASS');
    expect(evaluateGate(green({ ...withCi(release), ci: { skippable: ['attest'] } })).verdict).toBe('INCOMPLETE');
  });

  it('fails on a failed CI check', () => {
    const failed = [{ __typename: 'CheckRun', name: 'check', status: 'COMPLETED', conclusion: 'FAILURE' }];
    expect(evaluateGate(green(withCi(failed))).verdict).toBe('FAIL');
  });

  it('keeps check required when --require-check adds another, and never lets a required check be skipped', () => {
    const build = { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' };
    expect(evaluateGate(green({ ...withCi([...SUCCESS, build]), ci: { required: ['build'] } })).verdict).toBe('PASS');
    const onlyBuild = evaluateGate(green({ ...withCi([build]), ci: { required: ['build'] } }));
    expect(onlyBuild.verdict).toBe('INCOMPLETE');
    expect(onlyBuild.reasons.map(reason => reason.message)).toEqual(['CI: the required check check has not passed for the head']);
    const skipped = [{ __typename: 'CheckRun', name: 'check', status: 'COMPLETED', conclusion: 'SKIPPED' }];
    const notSkipped = evaluateGate(green({ ...withCi(skipped), ci: { skippable: ['check'] } }));
    expect(notSkipped.verdict).toBe('INCOMPLETE');
    // Both rules are named: the required check did not pass, and its skip is not taken as allowed.
    expect(notSkipped.reasons.map(reason => reason.message)).toEqual([
      'CI: the required check check has not passed for the head', 'CI: check did not run (SKIPPED)',
    ]);
  });

  it('voids the verdict when CI changes between the two reads', () => {
    const later = [...SUCCESS, { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }];
    const result = evaluateGate(green({ prAfter: { ...IDENTITY, statusCheckRollup: later } }));
    expect(result.verdict).toBe('STALE');
    expect(result.reasons.map(reason => reason.message)).toEqual(['CI: the checks changed while the evidence was read']);
  });

  it("refuses a head that does not contain the base's tip (a review against a newer tip without the rebase)", () => {
    const result = evaluateGate(green({ pr: { ...prWith(SUCCESS), headContainsBase: false } }));
    expect(result.verdict).toBe('STALE');
    expect(result.reasons.map(reason => reason.message)).toEqual([`the head does not contain the base's tip ${BASE}: rebase onto it`]);
    expect(evaluateGate(green({ pr: { ...prWith(SUCCESS), headContainsBase: undefined } })).verdict).toBe('INCOMPLETE');
  });

  it('does not pass without the cases the PR needs, and not on an unrelated JSON', () => {
    expect(evaluateGate(green({ cases: [] })).verdict).toBe('INCOMPLETE');
    const unrelated = evaluateGate(green({ e2e: [{ path: 'theme.json', json: caseJson() }] }));
    expect(unrelated.verdict).toBe('INCOMPLETE');
    expect(unrelated.reasons.map(reason => reason.message)).toEqual(['e2e: the required case ribbon-new-map is not among the JSONs']);
    const summary = { passed: true, results: [{ name: 'ribbon-new-map', passed: true, exitCode: 0, record: caseJson() }] };
    expect(evaluateGate(green({ e2e: [{ path: 'summary.json', json: summary }] })).verdict).toBe('PASS');
  });

  it.each([
    ['a case whose passed alone is false', { path: 'ribbon-new-map.json', json: caseJson({ passed: false }) }, 'ribbon-new-map.json: passed is false'],
    ["a summary whose run's passed alone is false",
      { path: 'summary.json', json: { passed: false, results: [{ name: 'ribbon-new-map', passed: true, exitCode: 0, record: caseJson() }] } },
      "summary.json: the run's passed is false"],
    ["a summary whose case's passed alone is false",
      { path: 'summary.json', json: { passed: true, results: [{ name: 'ribbon-new-map', passed: false, exitCode: 1, record: caseJson() }] } },
      'summary.json › ribbon-new-map: exit code 1'],
  ])('fails %s', (_, entry, message) => {
    const result = evaluateGate(green({ e2e: [entry] }));
    expect(result.verdict).toBe('FAIL');
    expect(result.reasons.map(reason => reason.message)).toEqual([message]);
  });

  it('refuses a receipt whose check or review did not pass, and a run with no JSON', () => {
    expect(evaluateGate(green({ receipt: receiptAt(HEAD, { check: { result: 'fail', at: 'x' } }) })).verdict).toBe('FAIL');
    expect(evaluateGate(green({ receipt: receiptAt(HEAD, { review: { result: 'fail', at: 'x' } }) })).verdict).toBe('FAIL');
    expect(evaluateGate(green({ e2e: [] })).verdict).toBe('INCOMPLETE');
    expect(evaluateGate(green({ e2e: [{ path: 'ribbon-new-map.json', json: null }] })).verdict).toBe('INCOMPLETE');
  });
});

describe('the PR read before and after the evidence', () => {
  /** `runGate` with the PR read as `before` and then `after`, and evidence that passes at `before`'s head. */
  const gateAcross = (before, after) => {
    const reads = [before, after];
    const collected = [];
    const result = runGate({
      readPr: () => { expect(reads.length).toBeGreaterThan(0); return reads.shift(); },
      collect: pr => {
        collected.push(pr.headRefOid);
        const { issue, receipt, ack, e2e, expected, cases } = green();
        return { issue, receipt, ack, e2e, expected, cases };
      },
    });
    expect(reads).toEqual([]);
    expect(collected).toEqual([before.headRefOid]);
    return result;
  };

  it('passes when the head, base sha and base branch are the same after the evidence', () => {
    expect(gateAcross(prWith(SUCCESS), prWith(SUCCESS)).verdict).toBe('PASS');
  });

  it.each([
    ['the head is pushed', { headRefOid: OLD }],
    ["the base's sha moves", { baseRefOid: 'd'.repeat(40) }],
    ['the base is retargeted', { baseRefName: 'feature/ai' }],
    ['a commit is merged into the base branch', { baseTip: 'd'.repeat(40) }],
    ['the PR is merged', { state: 'MERGED' }],
  ])('voids the verdict (STALE) when %s while the evidence is read', (_, change) => {
    const result = gateAcross(prWith(SUCCESS), { ...prWith(SUCCESS), ...change });
    expect(result.verdict).toBe('STALE');
    expect(result.reasons.map(reason => reason.message).join('\n')).toMatch(Object.keys(change)[0]);
  });

  it('does not pass without the base read', () => {
    // The receipt and the ACK then name a base this read does not have either (STALE beside the INCOMPLETE).
    const result = evaluateGate(green({ pr: { ...prWith(SUCCESS), baseRefName: undefined } }));
    expect(result.verdict).not.toBe('PASS');
    expect(result.reasons).toContainEqual({ verdict: 'INCOMPLETE', message: "the PR's baseRefName is unknown" });
  });
});

describe("finish's harness fields", () => {
  const vaultWith = mark => {
    const vault = tempDir();
    const plugin = join(vault, '.obsidian', 'plugins', 'mappy');
    mkdirSync(plugin, { recursive: true });
    for (const file of ['main.js', 'manifest.json', 'styles.css']) writeFileSync(join(plugin, file), `${file} bytes`);
    if (mark !== undefined) writeFileSync(join(vault, '.mappy-harness-build'), mark);
    return vault;
  };
  const run = async vault => {
    const record = createRecord(vault, 'Fixtures/E2E');
    record.steps.open = { ok: true };
    const json = join(tempDir(), 'case.json');
    const code = await finish(record, json);
    return { code, written: JSON.parse(readFileSync(json, 'utf8')) };
  };

  it('records the provenance at the start too, so a rebuild during the run shows', async () => {
    const vault = vaultWith(undefined);
    const record = createRecord(vault, 'Fixtures/E2E');
    writeFileSync(join(vault, '.obsidian', 'plugins', 'mappy', 'main.js'), 'rebuilt bytes');
    const json = join(tempDir(), 'case.json');
    await finish(record, json);
    const { harness } = JSON.parse(readFileSync(json, 'utf8'));
    expect(harness.start.sha256['main.js']).toBe(createHash('sha256').update('main.js bytes').digest('hex'));
    expect(harness.sha256['main.js']).toBe(createHash('sha256').update('rebuilt bytes').digest('hex'));
    expect(Object.keys(JSON.parse(readFileSync(json, 'utf8')))).not.toContain('harnessAtStart');
  });

  it('records the HEAD, the build kind and the installed sha256, and keeps the existing fields', async () => {
    const vault = vaultWith('ai-dev\n');
    const { code, written } = await run(vault);
    expect(code).toBe(0);
    expect(written).toMatchObject({ vault, note: 'Fixtures/E2E', steps: { open: { ok: true } }, failures: [], passed: true });
    expect(written.harness.head).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
    expect(typeof written.harness.dirty).toBe('boolean');
    expect(written.harness.build).toEqual({ kind: 'ai-dev', marked: true });
    expect(written.harness.sha256['main.js']).toBe(createHash('sha256').update('main.js bytes').digest('hex'));
    expect(written.harness.sha256['styles.css']).toBe(createHash('sha256').update('styles.css bytes').digest('hex'));
  });

  it('records no build kind for a directory that holds no plugin (a case run without a vault)', async () => {
    const { written } = await run(tempDir());
    expect(written.harness.build).toEqual({ kind: null, marked: false });
    expect(written.harness.sha256['main.js']).toBeNull();
  });

  it('takes a vault without the mark as release, and leaves what it cannot read null', async () => {
    const vault = vaultWith(undefined);
    rmSync(join(vault, '.obsidian', 'plugins', 'mappy', 'styles.css'));
    const { written } = await run(vault);
    expect(written.harness.build).toEqual({ kind: 'release', marked: false });
    expect(written.harness.sha256['styles.css']).toBeNull();
  });
});
