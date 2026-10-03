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
  issue: 'LEV-306', pr: 170, headSha, baseRefName: 'main', baseRefOid: BASE,
  check: { result: 'pass', at: '2026-10-03T01:00:00Z' }, review: { result: 'pass', at: '2026-10-03T01:10:00Z', range: 'origin/main...HEAD', baseSha: BASE },
  evidence: ['artifacts/lev-306/record.md'], ...overrides,
});
const caseJson = (overrides = {}) => ({
  vault: '/v', note: 'Fixtures/E2E', steps: { open: { ok: true } }, failures: [], passed: true,
  harness: { head: HEAD, dirty: false, build: { kind: 'release', marked: true }, sha256: { ...SHA }, recordedAt: '2026-10-03T02:00:00Z' },
  ...overrides,
});
const IDENTITY = { headRefOid: HEAD, baseRefOid: BASE, baseRefName: 'main' };
/** PR #170 as `gh pr view` gives it, the PR the receipts and ACKs below are written for. */
const PR = { number: 170, ...IDENTITY };
const SUCCESS = [{ __typename: 'CheckRun', name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const prWith = statusCheckRollup => ({ ...PR, statusCheckRollup });
const ackOf = (overrides = {}) => ({ issue: 'LEV-306', pr: 170, headSha: HEAD, baseRefName: 'main', baseRefOid: BASE, ...overrides });
const green = (overrides = {}) => ({
  pr: prWith(SUCCESS),
  prAfter: { ...IDENTITY },
  receipt: receiptAt(HEAD),
  ack: ackOf(),
  e2e: [{ path: 'ribbon-new-map.json', json: caseJson() }],
  expected: { build: 'release', sha256: { ...SHA } },
  ...overrides,
});
const withHarness = harness => caseJson({ harness: { ...caseJson().harness, ...harness } });

describe('completion receipt and ACK', () => {
  it('acknowledges the same (issue, head) once; the second is a duplicate and writes nothing', () => {
    const dir = tempDir();
    expect(writeReceipt(dir, receiptAt(HEAD)).status).toBe('written');
    expect(writeReceipt(dir, receiptAt(HEAD, { check: { result: 'fail', at: '2026-10-03T03:00:00Z' } })).status).toBe('exists');
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
    const result = writeReceipt(dir, receiptAt(HEAD, { review: { result: 'pass', at: '2026-10-03T01:10:00Z', range: 'origin/feature/ai...HEAD', baseSha: BASE } }));
    expect(result.status).toBe('rejected');
    expect(writeReceipt(dir, receiptAt(HEAD, { review: { result: 'pass', at: '2026-10-03T01:10:00Z', range: null, baseSha: BASE } })).status).toBe('rejected');
  });

  it("refuses a receipt whose review compared against another commit than the PR's base", () => {
    const dir = tempDir();
    const review = { result: 'pass', at: '2026-10-03T01:10:00Z', range: 'origin/main...HEAD' };
    const older = writeReceipt(dir, receiptAt(HEAD, { review: { ...review, baseSha: 'e'.repeat(40) } }));
    expect(older.status).toBe('rejected');
    expect(older.reason).toMatch(/review\.baseSha \(not baseRefOid/u);
    expect(writeReceipt(dir, receiptAt(HEAD, { review })).status).toBe('rejected');
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('evidence gate', () => {
  it('passes only when the head, CI, receipt, ACK and every JSON agree', () => {
    expect(evaluateGate(green())).toEqual({ verdict: 'PASS', head: HEAD, reasons: [] });
  });

  it('refuses a JSON from another HEAD even when its sha256 are the same', () => {
    const result = evaluateGate(green({ e2e: [{ path: 'e.json', json: withHarness({ head: OLD }) }] }));
    expect(result.verdict).toBe('STALE');
  });

  it.each([
    ['another PR with the same head (#171)', { number: 171 }],
    ['this PR retargeted to another branch', { baseRefName: 'feature/ai' }],
    ["this PR after its base's sha moved", { baseRefOid: 'd'.repeat(40) }],
  ])("refuses the receipt and the ACK written for PR #170 at main's c… when gating %s", (_, change) => {
    const pr = { ...prWith(SUCCESS), ...change };
    const prAfter = { headRefOid: pr.headRefOid, baseRefOid: pr.baseRefOid, baseRefName: pr.baseRefName };
    const result = evaluateGate(green({ pr, prAfter }));
    expect(result.verdict).toBe('STALE');
    const messages = result.reasons.map(reason => reason.message);
    expect(messages.some(message => message.startsWith('receipt: '))).toBe(true);
    expect(messages.some(message => message.startsWith('ack: '))).toBe(true);
  });

  it("refuses a receipt whose review compared against another commit than the gated PR's base", () => {
    const review = { result: 'pass', at: '2026-10-03T01:10:00Z', range: 'origin/main...HEAD', baseSha: 'e'.repeat(40) };
    expect(evaluateGate(green({ receipt: receiptAt(HEAD, { review }) })).verdict).toBe('STALE');
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
    expect(evaluateGate(green({ e2e: [{ path: 'e.json', json }] })).verdict).toBe('INCOMPLETE');
  });

  it.each([
    ['another build', withHarness({ build: { kind: 'ai-dev', marked: true } })],
    ['other plugin bytes', withHarness({ sha256: { ...SHA, 'main.js': '9'.repeat(64) } })],
    ['a tree with uncommitted changes', withHarness({ dirty: true })],
  ])('refuses a JSON run on %s', (_, json) => {
    expect(evaluateGate(green({ e2e: [{ path: 'e.json', json }] })).verdict).toBe('STALE');
  });

  it('refuses a JSON whose rows only partly passed', () => {
    const partly = caseJson({ failures: ['plain (double click): the vault gained 2 notes'] });
    expect(evaluateGate(green({ e2e: [{ path: 'e.json', json: partly }] })).verdict).toBe('FAIL');
    const threw = caseJson({ steps: { open: { ok: true }, click: { error: 'Error: timed out' } } });
    expect(evaluateGate(green({ e2e: [{ path: 'e.json', json: threw }] })).verdict).toBe('FAIL');
    const stopped = caseJson({ stopped: 'plugin failed; the remaining steps were not run' });
    expect(evaluateGate(green({ e2e: [{ path: 'e.json', json: stopped }] })).verdict).toBe('FAIL');
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
    expect(evaluateGate(green({ pr: prWith(rollup) })).verdict).toBe('INCOMPLETE');
  });

  it('fails on a failed CI check', () => {
    const failed = [{ __typename: 'CheckRun', name: 'check', status: 'COMPLETED', conclusion: 'FAILURE' }];
    expect(evaluateGate(green({ pr: prWith(failed) })).verdict).toBe('FAIL');
  });

  it('refuses a receipt whose check or review did not pass, and a run with no JSON', () => {
    expect(evaluateGate(green({ receipt: receiptAt(HEAD, { check: { result: 'fail', at: 'x' } }) })).verdict).toBe('FAIL');
    expect(evaluateGate(green({ receipt: receiptAt(HEAD, { review: { result: 'fail', at: 'x' } }) })).verdict).toBe('FAIL');
    expect(evaluateGate(green({ e2e: [] })).verdict).toBe('INCOMPLETE');
    expect(evaluateGate(green({ e2e: [{ path: 'e.json', json: null }] })).verdict).toBe('INCOMPLETE');
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
        const { receipt, ack, e2e, expected } = green();
        return { receipt, ack, e2e, expected };
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

  it('takes a vault without the mark as release, and leaves what it cannot read null', async () => {
    const vault = vaultWith(undefined);
    rmSync(join(vault, '.obsidian', 'plugins', 'mappy', 'styles.css'));
    const { written } = await run(vault);
    expect(written.harness.build).toEqual({ kind: 'release', marked: false });
    expect(written.harness.sha256['styles.css']).toBeNull();
  });
});
