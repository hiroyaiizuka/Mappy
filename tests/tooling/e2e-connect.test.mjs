import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, wait } from '../../scripts/e2e/cdp.mjs';
import { createRecord, finish } from '../../scripts/e2e/case-runner.mjs';
import { processStarts, releaseInstance } from '../../scripts/e2e/instance.mjs';
import { fakeCdp } from './fake-cdp.mjs';

/**
 * LEV-327: what `connect()` (scripts/e2e/cdp.mjs) does with the register and with the windows the instance opens, and
 * what run.mjs does with the register, against a stand-in for Obsidian's DevTools server (fake-cdp.mjs). Before these,
 * the same rules were pinned by matching the scripts' text (review of the rebased PR, finding 10), which a rename
 * breaks and a call whose result is ignored passes.
 */
const temporary = [];
const tempDir = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mappy-lev327-connect-'))); temporary.push(dir); return dir; };
const saved = {};
let vault;
let lock;
let fake;

beforeEach(() => {
  for (const key of ['MAPPY_E2E_LOCK_DIR', 'MAPPY_E2E_WAIT']) saved[key] = process.env[key];
  vault = tempDir();
  writeFileSync(join(vault, '.mappy-generated'), 'Mappy generated test vault v1\n');
  lock = tempDir();
  process.env.MAPPY_E2E_LOCK_DIR = lock;
});

afterEach(async () => {
  releaseInstance();
  await fake?.close();
  fake = null;
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  while (temporary.length > 0) rmSync(temporary.pop(), { recursive: true, force: true });
});

/** A process of our own that ends when its stdin closes (no signal), standing for another case holding the register. */
function holder() {
  const child = spawn(process.execPath, ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"], { stdio: ['pipe', 'ignore', 'ignore'] });
  return { child, end: () => new Promise(resolve => { child.once('exit', resolve); child.stdin.end(); }) };
}

const enter = (pid, fields) => writeFileSync(join(lock, `${pid}.json`), JSON.stringify({
  pid, started: processStarts([pid]).get(pid), kind: 'case', run: null, port: fake.port, vault, solo: null, what: 'other.mjs', claimedAt: new Date().toISOString(), ...fields,
}));

/** The record `finish` writes for this process now. */
async function recordNow() {
  const json = join(tempDir(), 'case.json');
  const code = await finish(createRecord(vault, 'Fixtures/E2E'), json);
  return { code, record: JSON.parse(readFileSync(json, 'utf8')) };
}

const created = (id, url = '') => fake.emit('Target.targetCreated', { targetInfo: { targetId: id, type: 'page', url } });

describe('connect() and the register', () => {
  it('does not reach the instance while the register keeps it out, and enters before it does', async () => {
    fake = await fakeCdp({ vault });
    const other = holder();
    try {
      await wait(200);
      enter(other.child.pid, {});
      process.env.MAPPY_E2E_WAIT = '0';
      await expect(connect({ port: fake.port, vault })).rejects.toThrow(/Not run: waited 0 s for other\.mjs/u);
      expect(fake.state.requests).toEqual([]);
    } finally {
      await other.end();
    }
    const cdp = await connect({ port: fake.port, vault });
    expect(fake.state.requests).toEqual(['/json/list']);
    expect(readdirSync(lock)).toContain(`${process.pid}.json`);
    cdp.close();
  });

  it('does not watch for windows in a solo process', async () => {
    fake = await fakeCdp({ vault });
    const cdp = await connect({ port: fake.port, vault, solo: 'opens a popout window' });
    expect(fake.state.calls).not.toContain('Target.setDiscoverTargets');
    cdp.close();
  });
});

describe('the windows a case opens', () => {
  it('fails the record of a case that opened a window, and says the windows were watched', async () => {
    fake = await fakeCdp({ vault });
    const cdp = await connect({ port: fake.port, vault });
    expect(fake.state.calls).toContain('Target.setDiscoverTargets');
    fake.state.targets.push({ id: 'popout', type: 'page', url: 'about:blank' });
    created('popout');
    await wait(100);
    const { code, record } = await recordNow();
    expect(code).toBe(1);
    expect(record.failures).toEqual([expect.stringMatching(/^opened a window \(about:blank\) on port \d+ without connect\(\{ solo \}\)/u)]);
    expect(record.instance.windows).toBe('watched');
    cdp.close();
  });

  it('does not count DevTools, which is a page target with no url when it is created', async () => {
    // Review finding 2, seen on the real Obsidian 1.13.7 (artifacts/lev-327/devtools-probe.json).
    fake = await fakeCdp({ vault });
    const cdp = await connect({ port: fake.port, vault });
    fake.state.targets.push({ id: 'devtools', type: 'page', url: 'devtools://devtools/bundled/devtools_app.html' });
    created('devtools');
    await wait(100);
    const { code, record } = await recordNow();
    expect(record.failures).toEqual([]);
    expect(code).toBe(0);
    cdp.close();
  });

  it('counts a window once, however many connections hear of it', async () => {
    fake = await fakeCdp({ vault });
    const first = await connect({ port: fake.port, vault });
    const second = await connect({ port: fake.port, vault });
    fake.state.targets.push({ id: 'popout', type: 'page', url: 'about:blank' });
    created('popout');
    await wait(100);
    const { record } = await recordNow();
    expect(record.failures).toHaveLength(1);
    first.close();
    second.close();
  });

  it('counts a window that opened while no connection was open, on the next one', async () => {
    fake = await fakeCdp({ vault });
    (await connect({ port: fake.port, vault })).close();
    fake.state.targets.push({ id: 'popout', type: 'page', url: 'about:blank' });
    const cdp = await connect({ port: fake.port, vault });
    const { record } = await recordNow();
    expect(record.failures).toEqual([expect.stringMatching(/^opened a window \(about:blank\)/u)]);
    cdp.close();
  });

  it('stops watching, and says so in the record, when a window was open before the case', async () => {
    fake = await fakeCdp({ vault, targets: [{ id: 'main', type: 'page', url: 'app://obsidian.md/index.html' }, { id: 'left', type: 'page', url: 'about:blank' }] });
    const cdp = await connect({ port: fake.port, vault });
    fake.state.targets.push({ id: 'popout', type: 'page', url: 'about:blank' });
    created('popout');
    await wait(100);
    const { code, record } = await recordNow();
    expect(code).toBe(0);
    expect(record.instance.windows).toBe('not watched: 1 window(s) besides the main one were open before the case');
    cdp.close();
  });

  it('counts a second main window, and not the main window coming back from a reload', async () => {
    // Review finding 7: every index.html target was left out, so another vault window went unseen.
    fake = await fakeCdp({ vault });
    const cdp = await connect({ port: fake.port, vault });
    created('main', 'app://obsidian.md/index.html');
    await wait(100);
    expect((await recordNow()).record.failures).toEqual([]);
    fake.state.targets.push({ id: 'second', type: 'page', url: 'app://obsidian.md/index.html' });
    created('second');
    await wait(100);
    expect((await recordNow()).record.failures).toEqual([expect.stringMatching(/^opened a window \(app:\/\/obsidian\.md\/index\.html\)/u)]);
    cdp.close();
  });
});

describe('run.mjs and the register', () => {
  const run = fileURLToPath(new URL('../../scripts/e2e/run.mjs', import.meta.url));
  // Not spawnSync: the stand-in answers from this process, which spawnSync would hold still.
  const runCase = () => new Promise(resolve => {
    const child = spawn(process.execPath, [run, '--case', 'add-delete'], {
      env: { ...process.env, MAPPY_E2E_PORT: fake.port, MAPPY_E2E_VAULT: vault, MAPPY_E2E_LOCK_DIR: lock, MAPPY_E2E_WAIT: '0' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', status => resolve({ status, stdout, stderr }));
  });

  it('lets its own case past the run\'s entry (the case then finds no window on the stand-in)', async () => {
    fake = await fakeCdp({ vault, targets: [] });
    const result = await runCase();
    expect(result.stdout + result.stderr).toContain(`No Obsidian window on port ${fake.port}`);
    expect(result.stdout + result.stderr).not.toContain('Not run');
  });

  it('does not start while another process holds the instance', async () => {
    fake = await fakeCdp({ vault, targets: [] });
    const other = holder();
    try {
      await wait(200);
      enter(other.child.pid, { kind: 'run', what: 'run.mjs' });
      const result = await runCase();
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Not run: waited 0 s for the run run.mjs');
      expect(fake.state.requests).toEqual([]);
    } finally {
      await other.end();
    }
  });
});

describe('the gate', () => {
  it('reads the build without the vault MAPPY_E2E_VAULT names', async () => {
    // Review 3 (first cycle): the gate went through the vault check and refused a build that was fine.
    const { packagedBuild } = await import('../../scripts/harness-gate.mjs');
    const before = process.env.MAPPY_E2E_VAULT;
    process.env.MAPPY_E2E_VAULT = '/elsewhere/test-vault-z';
    try {
      let error = null;
      try { packagedBuild?.(); } catch (caught) { error = caught; }
      expect(typeof packagedBuild).toBe('function');
      expect(String(error?.message ?? '')).not.toMatch(/MAPPY_E2E_VAULT/u);
    } finally {
      if (before === undefined) delete process.env.MAPPY_E2E_VAULT; else process.env.MAPPY_E2E_VAULT = before;
    }
  });
});
