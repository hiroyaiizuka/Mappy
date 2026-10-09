import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  blocks, canonical, claimInstance, exportLine, freePort, liveEntries, lockDir, noteShared, parentRun, portFromFlag, processStarts, profileHolder,
  profilesWithVault, relaunchProfile, releaseInstance, waitSeconds,
} from '../../scripts/e2e/instance.mjs';
import * as instance from '../../scripts/e2e/instance.mjs';
import { createRecord, finish } from '../../scripts/e2e/case-runner.mjs';
import { harnessVault, vaultName } from '../../scripts/preflight.mjs';

/**
 * LEV-327: dedicated Obsidian instances run side by side. scripts/e2e/instance.mjs keeps a register of the processes
 * that drive one, so two never drive one instance (port) or one vault at once, and a case that acts on what every
 * instance shares (`solo`) runs with nothing beside it; scripts/preflight.mjs prepares a second vault; E59 relaunches
 * the profile the window ran with. Which change makes each test fail is in the PR (artifacts/lev-327/mutation.txt).
 */
const temporary = [];
const tempDir = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mappy-lev327-'))); temporary.push(dir); return dir; };
afterEach(() => {
  // A test that entered leaves the register as a process exit would.
  releaseInstance();
  while (temporary.length > 0) rmSync(temporary.pop(), { recursive: true, force: true });
});

const OTHER = 99999991;
/** `ps -o lstart` stand-in: this process and OTHER (unless `dead`) are running. */
const startedWith = ({ dead = false } = {}) => pids => new Map(pids
  .map(pid => [pid, pid === process.pid ? 'self' : pid === OTHER && !dead ? 'other' : null]).filter(([, start]) => start !== null));
const writeOther = (dir, fields) => writeFileSync(join(dir, `${OTHER}.json`), JSON.stringify({
  pid: OTHER, started: 'other', port: '9241', vault: '/a/test-vault', solo: null, what: 'other.mjs', claimedAt: '2026-10-07T00:00:00.000Z', ...fields,
}));
const claim = (dir, fields = {}) => claimInstance({ port: '9242', vault: '/b/test-vault', what: 'this.mjs', wait: 0, dir, log: () => {}, starts: startedWith(), ...fields });

describe('which entries keep a process from starting', () => {
  const mine = { port: '9241', vault: '/a/test-vault', solo: null };
  it('blocks one instance or one vault, not another instance with its own vault', () => {
    expect(blocks(mine, { port: '9241', vault: '/b/test-vault', solo: null })).toBe(true);
    expect(blocks(mine, { port: '9242', vault: '/a/test-vault', solo: null })).toBe(true);
    expect(blocks(mine, { port: '9242', vault: '/b/test-vault', solo: null })).toBe(false);
  });

  it('blocks everything beside a solo process, on either side', () => {
    expect(blocks(mine, { port: '9242', vault: '/b/test-vault', solo: 'clipboard' })).toBe(true);
    expect(blocks({ ...mine, solo: 'clipboard' }, { port: '9242', vault: '/b/test-vault', solo: null })).toBe(true);
  });

  it('keeps a run\'s instance for the run, lets its own cases pass, and keeps no other instance from a solo case', () => {
    // Review 2-7: two runs on one instance came in between each other's cases.
    const run = { pid: 500, kind: 'run', port: '9241', vault: '/a/test-vault', solo: null };
    expect(blocks({ ...mine, pid: 600, run: 400 }, run)).toBe(true);
    expect(blocks({ ...mine, pid: 600, run: 500 }, run)).toBe(false);
    expect(blocks({ ...mine, pid: 600, run: 500, solo: 'opens a popout window' }, run)).toBe(false);
    expect(blocks({ pid: 700, port: '9242', vault: '/b/test-vault', solo: 'opens a popout window', run: 800 }, run)).toBe(false);
    expect(blocks({ pid: 900, kind: 'run', port: '9241', vault: '/c/test-vault', solo: null }, run)).toBe(true);
    expect(blocks({ pid: 900, kind: 'run', port: '9242', vault: '/b/test-vault', solo: null }, { ...mine, pid: 600, solo: 'clipboard' })).toBe(false);
  });

  it('takes the run a case belongs to only from its parent', () => {
    expect(parentRun({ MAPPY_E2E_RUN: '4321' }, 4321)).toBe(4321);
    expect(parentRun({ MAPPY_E2E_RUN: '4321' }, 1)).toBe(null);
    expect(parentRun({}, 4321)).toBe(null);
  });
});

describe('the register', () => {
  it('lets a process start beside one on another instance and vault, and writes its entry', async () => {
    const dir = tempDir();
    writeOther(dir, {});
    const held = await claim(dir);
    expect(JSON.parse(readFileSync(held.file, 'utf8'))).toMatchObject({ pid: process.pid, port: '9242', vault: '/b/test-vault', solo: null });
    held.release();
    expect(existsSync(held.file)).toBe(false);
  });

  it('refuses a second process on the same instance, names the first, and leaves no entry of its own', async () => {
    const dir = tempDir();
    writeOther(dir, { port: '9242' });
    await expect(claim(dir)).rejects.toThrow(/Not run: .*other\.mjs \(pid 99999991, port 9242/u);
    expect(readdirSync(dir)).toEqual([`${OTHER}.json`]);
  });

  it('refuses a second process on the same vault through another port', async () => {
    const dir = tempDir();
    writeOther(dir, { port: '9241', vault: '/b/test-vault' });
    await expect(claim(dir)).rejects.toThrow(/Not run/u);
  });

  it('does not count the entry of a process that is gone', async () => {
    const dir = tempDir();
    writeOther(dir, { port: '9242' });
    const held = await claim(dir, { starts: startedWith({ dead: true }) });
    expect(held.entry.pid).toBe(process.pid);
  });

  it('does not count an entry whose pid now belongs to another process', async () => {
    const dir = tempDir();
    writeOther(dir, { port: '9242', started: 'an earlier process' });
    expect((await claim(dir)).entry.pid).toBe(process.pid);
  });

  it('keeps a process from starting beside a solo one on another instance', async () => {
    const dir = tempDir();
    writeOther(dir, { solo: 'puts images and text on the OS clipboard' });
    await expect(claim(dir)).rejects.toThrow(/alone: puts images and text on the OS clipboard/u);
  });

  it('keeps a solo process from starting beside any other', async () => {
    const dir = tempDir();
    writeOther(dir, {});
    await expect(claim(dir, { solo: 'takes the OS focus' })).rejects.toThrow(/Not run/u);
    expect(readdirSync(dir)).toEqual([`${OTHER}.json`]);
  });

  it('waits until the other process is gone, then starts', async () => {
    const dir = tempDir();
    writeOther(dir, { port: '9242' });
    const waited = [];
    setTimeout(() => rmSync(join(dir, `${OTHER}.json`)), 300);
    const held = await claim(dir, { wait: 10, log: message => waited.push(message) });
    expect(held.entry.pid).toBe(process.pid);
    expect(waited[0]).toMatch(/^Waiting for other\.mjs/u);
  });

  it('holds a waiting solo process\'s entry, so the processes after it wait for it', async () => {
    const dir = tempDir();
    writeOther(dir, {});
    const seen = [];
    setTimeout(() => rmSync(join(dir, `${OTHER}.json`)), 300);
    await claim(dir, { solo: 'takes the OS focus', wait: 10, log: () => seen.push(readdirSync(dir).includes(`${process.pid}.json`)) });
    expect(seen).toEqual([true]);
  });

  it('does not hold a waiting solo process\'s entry against a run on its instance, so the run\'s next case comes in', async () => {
    // Orchestrator review (Medium): a solo process (harness:obsidian stop, a standalone E59) waiting for a run on its port
    // kept its entry; the run's next case then waited for it, the run for that case, and both waited out MAPPY_E2E_WAIT.
    const dir = tempDir();
    writeOther(dir, { kind: 'run', run: null, port: '9242', vault: '/b/test-vault', what: 'run.mjs' });
    const solo = { pid: process.pid, kind: 'case', run: null, port: '9242', vault: '/b/test-vault', solo: 'quits an Obsidian' };
    // Why holding it would deadlock: the run's own next case is kept out by a solo entry.
    expect(blocks({ pid: 123, kind: 'case', run: OTHER, port: '9242', vault: '/b/test-vault', solo: null }, solo)).toBe(true);
    const seen = [];
    setTimeout(() => rmSync(join(dir, `${OTHER}.json`)), 300);
    await claim(dir, { solo: 'quits an Obsidian', wait: 10, log: () => seen.push(readdirSync(dir).includes(`${process.pid}.json`)) });
    expect(seen).toEqual([false]);
  });

  it('steps a later solo process back while an earlier one waits too, so they do not hold each other for ever', async () => {
    const dir = tempDir();
    writeOther(dir, { solo: 'takes the OS focus', claimedAt: '2000-01-01T00:00:00.000Z' });
    const seen = [];
    setTimeout(() => rmSync(join(dir, `${OTHER}.json`)), 300);
    await claim(dir, { solo: 'judges frame times', wait: 10, log: () => seen.push(readdirSync(dir).includes(`${process.pid}.json`)) });
    expect(seen).toEqual([false]);
  });

  it('hands a process its one entry again, and refuses to make it solo or point it at another instance afterwards', async () => {
    const dir = tempDir();
    const held = await claim(dir);
    expect(await claim(dir)).toBe(held);
    await expect(claim(dir, { solo: 'quits Obsidian' })).rejects.toThrow(/without asking to run alone/u);
    // Review 2-3: a second instance was driven with the first one's entry.
    await expect(claim(dir, { port: '9243' })).rejects.toThrow(/one process drives one instance/u);
    await expect(claim(dir, { vault: '/c/test-vault' })).rejects.toThrow(/one process drives one instance/u);
  });

  it('lets a solo process drive a second instance (it runs with nothing beside it), as E86 does', async () => {
    const dir = tempDir();
    const held = await claim(dir, { solo: 'takes the OS focus from one instance and opens windows on the other' });
    expect(await claim(dir, { port: '9243', vault: '/c/test-vault' })).toBe(held);
  });

  it('removes the entry of a process that is gone, but not one rewritten since it was read', () => {
    const dir = tempDir();
    writeOther(dir, { port: '9242' });
    expect(liveEntries(dir, process.pid, { starts: startedWith({ dead: true }) })).toEqual([]);
    expect(existsSync(join(dir, `${OTHER}.json`))).toBe(false);
    writeOther(dir, { port: '9242' });
    const rewrite = pids => { writeOther(dir, { port: '9243' }); return startedWith({ dead: true })(pids); };
    expect(liveEntries(dir, process.pid, { starts: rewrite })).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, `${OTHER}.json`), 'utf8')).port).toBe('9243');
  });

  it('refuses a wait that is not a number of seconds rather than waiting for ever', async () => {
    // Review 2-1: MAPPY_E2E_WAIT=30s made the deadline NaN, never reached.
    expect(waitSeconds(undefined)).toBe(1800);
    expect(waitSeconds('0')).toBe(0);
    for (const value of ['30s', '', 'abc', '-1']) expect(() => waitSeconds(value)).toThrow(/MAPPY_E2E_WAIT must be a number of seconds/u);
    await expect(claim(tempDir(), { wait: Number.NaN })).rejects.toThrow(/wait must be a number of seconds/u);
  });

  it('reads a process\'s start the same way whatever the locale and time zone of the shell reading it', () => {
    // Review 1: `lstart` is printed in the caller's TZ and locale; an entry written from one shell read as dead from another.
    const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
    try {
      Object.assign(process.env, { TZ: 'Asia/Tokyo', LC_ALL: 'ja_JP.UTF-8', LANG: 'ja_JP.UTF-8' });
      const tokyo = processStarts([process.pid]).get(process.pid);
      Object.assign(process.env, { TZ: 'America/Los_Angeles', LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' });
      const angeles = processStarts([process.pid]).get(process.pid);
      expect(tokyo).toBeTruthy();
      expect(angeles).toBe(tokyo);
    } finally {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

  it('reads the starts of several processes, and a pid ps refuses does not hide the running ones', () => {
    // macOS ps prints nothing for a list with a pid it calls too large (OTHER is one); the running entry must still count.
    const starts = processStarts([OTHER, process.pid]);
    expect([...starts.keys()]).toEqual([process.pid]);
    expect(starts.get(process.pid)).toBe(processStarts([process.pid]).get(process.pid));
  });

  it('takes its exit listener away when it releases the entry', async () => {
    const dir = tempDir();
    const before = process.listenerCount('exit');
    const held = await claim(dir);
    expect(process.listenerCount('exit')).toBe(before + 1);
    held.release();
    expect(process.listenerCount('exit')).toBe(before);
  });

  it('counts one vault reached through a link and directly as one vault', async () => {
    const dir = tempDir();
    const real = join(dir, 'checkout');
    mkdirSync(join(real, 'test-vault'), { recursive: true });
    symlinkSync(real, join(dir, 'link'));
    writeOther(dir, { port: '9241', vault: join(real, 'test-vault') });
    expect(canonical(join(dir, 'link', 'test-vault'))).toBe(join(real, 'test-vault'));
    // Through the link here, directly in the other entry: entries hold real paths, compared as text (review 3-9).
    await expect(claim(dir, { vault: join(dir, 'link', 'test-vault') })).rejects.toThrow(/Not run/u);
    // And the entry (and the record after it) names the vault by its real path, however it was reached.
    rmSync(join(dir, `${OTHER}.json`));
    const held = await claim(dir, { vault: join(dir, 'link', 'test-vault') });
    expect(JSON.parse(readFileSync(held.file, 'utf8')).vault).toBe(join(real, 'test-vault'));
  });

  it('stops, rather than reading every entry as dead, when ps cannot run', async () => {
    // Review 3-1: a ps that failed to start gave an empty list, every entry read as dead and was removed.
    const dir = tempDir();
    writeOther(dir, { port: '9242' });
    const path = process.env.PATH;
    try {
      process.env.PATH = '/nowhere';
      expect(() => processStarts([process.pid])).toThrow(/Could not run ps/u);
      expect(() => liveEntries(dir, process.pid)).toThrow(/Could not run ps/u);
    } finally {
      process.env.PATH = path;
    }
    expect(existsSync(join(dir, `${OTHER}.json`))).toBe(true);
    const failing = pids => { if (pids.includes(OTHER)) throw new Error('Could not run ps'); return startedWith()(pids); };
    await expect(claim(dir, { starts: failing })).rejects.toThrow(/Could not run ps/u);
    expect(readdirSync(dir)).toEqual([`${OTHER}.json`]);
  });

  it('stops, rather than keeping a register of its own, when git cannot find the primary checkout', () => {
    // Review 3-3: lockDir fell back to this checkout's .tooling/, where the other worktrees do not look.
    const saved = { PATH: process.env.PATH, MAPPY_E2E_LOCK_DIR: process.env.MAPPY_E2E_LOCK_DIR };
    try {
      process.env.PATH = '/nowhere';
      delete process.env.MAPPY_E2E_LOCK_DIR;
      expect(() => lockDir()).toThrow(/Could not find the primary checkout with git/u);
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.MAPPY_E2E_LOCK_DIR !== undefined) process.env.MAPPY_E2E_LOCK_DIR = saved.MAPPY_E2E_LOCK_DIR;
    }
  });

  it('stops when ps refuses one pid for a reason other than a pid it cannot hold, rather than reading it as dead', () => {
    // Review (rebased PR) finding 5: the one-pid retry read any refusal as "not running", and the entry was removed.
    const said = (stderr, status = 1) => () => ({ status, stdout: '', stderr });
    expect(() => instance.processStarts([process.pid], { run: said('ps: something went wrong\n') })).toThrow(/Could not run ps/u);
    expect([...instance.processStarts([99999991], { run: said('ps: process id too large: 99999991\n') }).keys()]).toEqual([]);
    expect([...instance.processStarts([4321], { run: said('') }).keys()]).toEqual([]);
  });

  it('writes its entry under another name first, which the others do not read, and leaves only the entry', async () => {
    // Review 3, finding 4: an entry written in place could be read half-written (and skipped) by another process.
    const dir = tempDir();
    // A whole entry of a live process, under the name an entry is written to first: not read.
    writeFileSync(join(dir, `${OTHER}.json.${OTHER}.tmp`), JSON.stringify({ pid: OTHER, started: 'other', port: '9242', vault: '/b/test-vault', solo: null, what: 'other.mjs', claimedAt: '2026-10-07T00:00:00.000Z' }));
    expect(liveEntries(dir, process.pid, { starts: startedWith() })).toEqual([]);
    const held = await claim(dir);
    expect(readdirSync(dir).sort()).toEqual([`${OTHER}.json.${OTHER}.tmp`, `${process.pid}.json`].sort());
    held.release();
  });

  it('tells a JSON of another instance from this run\'s (two runs given one --json folder)', () => {
    // Review 3, finding 2: run.mjs took a case JSON another instance's run had written over as its own.
    expect(instance.otherInstance({ instance: { port: '9241', vault: '/a/test-vault' } }, { port: '9241', vault: '/a/test-vault' })).toBe(null);
    expect(instance.otherInstance({ instance: { port: '9242', vault: '/b/test-vault' } }, { port: '9241', vault: '/a/test-vault' })).toMatch(/^the JSON is the case's on port 9242 with \/b\/test-vault, not this run's \(port 9241/u);
    expect(instance.otherInstance({ instance: { port: '9241', vault: '/b/test-vault' } }, { port: '9241', vault: '/a/test-vault' })).toMatch(/not this run's/u);
    expect(instance.otherInstance({ instance: null }, { port: '9241', vault: '/a/test-vault' })).toBe(null);
    const run = readFileSync(new URL('../../scripts/e2e/run.mjs', import.meta.url), 'utf8');
    expect(run.indexOf('const other = otherInstance(record);')).toBeLessThan(run.indexOf('const passed = results.every(result => result.passed);'));
  });

  it('skips entries it cannot read and lists only the others', () => {
    const dir = tempDir();
    writeOther(dir, {});
    writeFileSync(join(dir, '123.json'), '{ not json');
    writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, started: 'self' }));
    expect(liveEntries(dir, process.pid, { starts: startedWith() }).map(entry => entry.pid)).toEqual([OTHER]);
  });
});

describe('what uses the register', () => {
  it('writes the instance the case entered for into its record, and none for a case that never connected', async () => {
    const dir = tempDir();
    const json = join(dir, 'case.json');
    await finish(createRecord(dir, 'Fixtures/E2E'), json);
    expect(JSON.parse(readFileSync(json, 'utf8')).instance).toBe(null);
    await claim(dir, { solo: 'opens the settings window' });
    await finish(createRecord(dir, 'Fixtures/E2E'), json);
    expect(JSON.parse(readFileSync(json, 'utf8')).instance).toEqual({ port: '9242', vault: '/b/test-vault', solo: 'opens the settings window', windows: null });
  });

  it('says in the record whether the windows the case opened were watched', async () => {
    // Orchestrator review (Low 5): with windows open before the case, cdp.mjs stops watching; only a console line said so.
    const dir = tempDir();
    const json = join(dir, 'case.json');
    await claim(dir);
    instance.markWindowWatch('not watched: 1 window(s) besides the main one were open before the case');
    await finish(createRecord(dir, 'Fixtures/E2E'), json);
    expect(JSON.parse(readFileSync(json, 'utf8')).instance.windows).toBe('not watched: 1 window(s) besides the main one were open before the case');
    instance.markWindowWatch('watched');
    await finish(createRecord(dir, 'Fixtures/E2E'), json);
    expect(JSON.parse(readFileSync(json, 'utf8')).instance.windows).toBe('watched');
  });

  it('fails a case that opened a window without asking to run alone, and not one that asked', async () => {
    // Review 10: whether a case runs alone was only what it said about itself; cdp.mjs now notes the windows it opens.
    const dir = tempDir();
    const json = join(dir, 'case.json');
    const held = await claim(dir);
    noteShared('opened a window (about:blank) on port 9242');
    expect(await finish(createRecord(dir, 'Fixtures/E2E'), json)).toBe(1);
    expect(JSON.parse(readFileSync(json, 'utf8')).failures[0]).toMatch(/^opened a window \(about:blank\) on port 9242 without connect\(\{ solo \}\)/u);
    held.release();
    await claim(dir, { solo: 'opens a popout window' });
    noteShared('opened a window (about:blank) on port 9242');
    expect(await finish(createRecord(dir, 'Fixtures/E2E'), json)).toBe(0);
  });

});

describe('choosing a port', () => {
  it('reads a port held on every address as in use', async () => {
    // Review finding 4: binding 127.0.0.1 alone can succeed on macOS while another process listens on 0.0.0.0.
    const server = createServer();
    await new Promise(resolve => { server.listen(0, '0.0.0.0', resolve); });
    try {
      expect(await instance.portFree(server.address().port)).toBe(false);
    } finally {
      await new Promise(resolve => { server.close(resolve); });
    }
  });

  it('takes the first port nothing listens on', async () => {
    const listening = new Set(['9241', '9242']);
    const port = await freePort({ range: [9241, 9299], free: async candidate => !listening.has(String(candidate)) });
    expect(port).toBe('9243');
  });

  it('says so when the range is full', async () => {
    await expect(freePort({ range: [9241, 9242], free: async () => false })).rejects.toThrow('No free port in 9241–9242.');
  });
});

describe('the launcher\'s arguments', () => {
  it('refuses a flag the command does not take, a flag given twice or without a value', () => {
    // Review 2, finding 3: a misspelt --prot or --valut fell back to the defaults and launched another instance.
    expect(instance.launcherArgs(['start', '--vault', 'test-vault-b', '--port', '9245'])).toEqual({ command: 'start', values: { '--vault': 'test-vault-b', '--port': '9245' } });
    expect(() => instance.launcherArgs(['start', '--prot', '9245'])).toThrow(/^start does not take --prot/u);
    expect(() => instance.launcherArgs(['stop', '--profile', 'x'])).toThrow(/^stop does not take --profile/u);
    expect(() => instance.launcherArgs(['start', '--port', '9245', '--port', '9246'])).toThrow(/--port is given twice/u);
    expect(() => instance.launcherArgs(['start', '--vault', '--port', '9245'])).toThrow(/--vault needs a value/u);
    expect(() => instance.launcherArgs(['list', '--port', '9245'])).toThrow(/^list does not take --port/u);
    expect(() => instance.launcherArgs(['launch'])).toThrow(/^Usage/u);
  });

  it('takes stop\'s port, given or from MAPPY_E2E_PORT, only in 9241–9299, and says which it was', () => {
    expect(instance.launcherArgs(['stop'], { fallbackPort: '9242' }).values['--port']).toBe('9242');
    expect(() => instance.launcherArgs(['stop', '--port', '9222'])).toThrow(/--port must be in 9241–9299, not 9222/u);
    // Review 3 of the rebased PR, finding 5: a bare stop blamed a --port it was not given.
    expect(() => instance.launcherArgs(['stop'], { fallbackPort: '9231', fallbackFrom: 'the default port' })).toThrow(/^stop was given no --port, and the default port 9231 is not in 9241–9299/u);
    expect(() => instance.launcherArgs(['stop'], { fallbackPort: '9300', fallbackFrom: 'MAPPY_E2E_PORT' })).toThrow(/^stop was given no --port, and MAPPY_E2E_PORT 9300/u);
  });
});

describe('the line start prints', () => {
  it('keeps a path with a space, a quote or a $ as one word', () => {
    // Review 2-5: the paths were printed bare, and a space split them.
    const line = exportLine({ port: '9241', vault: "/My Projects/it's $HOME/test-vault-b", profile: '/p q/artifacts/obsidian-profile-9241' });
    const shell = spawnSync('sh', ['-c', `${line}; printf '%s|%s|%s' "$MAPPY_E2E_PORT" "$MAPPY_E2E_VAULT" "$MAPPY_E2E_PROFILE"`], { encoding: 'utf8' });
    expect(shell.stdout).toBe("9241|/My Projects/it's $HOME/test-vault-b|/p q/artifacts/obsidian-profile-9241");
  });

  it('takes a --port only in 9241–9299', () => {
    // Review 2-4: --port 9222 (Kioku's) or 9231 (the default) was taken when nothing listened there. Tested on the
    // function, not by running start (review 3-7: a unit test must not be one refactor away from launching Obsidian).
    expect(portFromFlag(undefined)).toBe(null);
    expect(portFromFlag('9241')).toBe('9241');
    expect(portFromFlag('9299')).toBe('9299');
    for (const port of ['9222', '9231', '9240', '9300', 'x', '9241.5']) expect(() => portFromFlag(port)).toThrow(`--port must be in 9241–9299, not ${port}.`);
    const text = readFileSync(new URL('../../scripts/e2e/obsidian.mjs', import.meta.url), 'utf8');
    expect(text).toContain('const { command, values } = launcherArgs(process.argv.slice(2));');
  });

});

describe('one vault, one instance', () => {
  const everyday = '/u/Library/Application Support/obsidian';
  const lists = {
    '/w/artifacts/obsidian-profile-9241/obsidian.json': { vaults: { a: { path: '/w/test-vault', open: true } } },
    '/w/artifacts/obsidian-profile-9242/obsidian.json': { vaults: { b: { path: '/w/test-vault-b', open: false } } },
    '/w2/artifacts/obsidian-profile/obsidian.json': { vaults: { c: { path: '/w/test-vault-c', open: true } } },
    [`${everyday}/obsidian.json`]: { vaults: { d: { path: '/w/test-vault-d', open: true } } },
  };
  const read = path => { if (!(path in lists)) throw new Error('ENOENT'); return JSON.stringify(lists[path]); };
  const profiles = ['/w/artifacts/obsidian-profile-9241', '/w/artifacts/obsidian-profile-9242', '/w2/artifacts/obsidian-profile', everyday];

  it('stops, rather than reading no Obsidian running, when ps cannot run', () => {
    // Orchestrator review (Low 3): a ps that failed read as "no Obsidian has the vault open".
    const path = process.env.PATH;
    try {
      process.env.PATH = '/nowhere';
      expect(() => instance.runningProfiles()).toThrow(/Could not run ps/u);
    } finally {
      process.env.PATH = path;
    }
  });

  it('finds the running profile that has the vault open, in this checkout or another worktree', () => {
    // Review 2-2: start launched a second Obsidian on a vault another one had open; review 3-5: one of another checkout too.
    expect(profilesWithVault('/w/test-vault', { profiles, everyday, read })).toEqual(['/w/artifacts/obsidian-profile-9241']);
    expect(profilesWithVault('/w/test-vault-c', { profiles, everyday, read })).toEqual(['/w2/artifacts/obsidian-profile']);
  });

  it('does not count a vault listed but not open, and never reads the everyday profile', () => {
    expect(profilesWithVault('/w/test-vault-b', { profiles, everyday, read })).toEqual([]);
    expect(profilesWithVault('/w/test-vault-d', { profiles, everyday, read })).toEqual([]);
  });
});

describe('the profile', () => {
  const where = { artifacts: '/w/artifacts', everyday: '/u/Library/Application Support/obsidian' };
  it('relaunches the profile the window ran with, and refuses one that is not MAPPY_E2E_PROFILE', () => {
    expect(relaunchProfile('/w/artifacts/obsidian-profile-9242', null, where)).toBe('/w/artifacts/obsidian-profile-9242');
    expect(relaunchProfile('/w/artifacts/obsidian-profile-9242', '/w/artifacts/obsidian-profile-9242', where)).toBe('/w/artifacts/obsidian-profile-9242');
    expect(() => relaunchProfile('/w/artifacts/obsidian-profile-9242', '/w/artifacts/obsidian-profile', where)).toThrow(/not \/w\/artifacts\/obsidian-profile \(MAPPY_E2E_PROFILE\)/u);
    expect(() => relaunchProfile('', null, where)).toThrow(/did not say/u);
  });

  it('relaunches only a profile inside artifacts/ (or the one MAPPY_E2E_PROFILE names), never the everyday one', () => {
    // Review 3-2: an instance on the everyday profile would have been quit and launched again with a CDP port.
    // The rule that refused is named (review 2 of the rebased PR, finding 7: one generic message hid which).
    expect(() => relaunchProfile(where.everyday, null, where)).toThrow(/the everyday Obsidian's/u);
    expect(() => relaunchProfile(where.everyday, where.everyday, where)).toThrow(/the everyday Obsidian's/u);
    expect(() => relaunchProfile('/elsewhere/profile', null, where)).toThrow(/not one inside \/w\/artifacts/u);
    expect(relaunchProfile('/elsewhere/profile', '/elsewhere/profile', where)).toBe('/elsewhere/profile');
  });

  it('names the port the case connected to when it refuses', () => {
    // Review finding 8: the message named the default port, not the instance's.
    expect(() => relaunchProfile('/elsewhere/profile', null, { ...where, port: '9242' })).toThrow(/^The Obsidian on port 9242 /u);
  });

  it('keeps one rule for the profiles the harness launches and quits (start, stop, E59)', () => {
    // Review finding 9: obsidian.mjs had its own copy of the artifacts/ check, without the everyday profile.
    expect(instance.testProfile?.('/w/artifacts/obsidian-profile-9241', where)).toBe('/w/artifacts/obsidian-profile-9241');
    expect(() => instance.testProfile('/elsewhere/profile', where)).toThrow(/inside \/w\/artifacts/u);
    expect(() => instance.testProfile(where.everyday, { ...where, artifacts: '/u' })).toThrow(/everyday/u);
    const text = readFileSync(new URL('../../scripts/e2e/obsidian.mjs', import.meta.url), 'utf8');
    expect(text).not.toMatch(/isInside\(join\(root, 'artifacts'\)/u);
  });

  it('takes MAPPY_E2E_PROFILE through a link as the profile the window names by its real path', () => {
    const artifacts = join(tempDir(), 'artifacts');
    mkdirSync(join(artifacts, 'obsidian-profile-9242'), { recursive: true });
    const link = join(tempDir(), 'link');
    symlinkSync(join(artifacts, 'obsidian-profile-9242'), link);
    expect(relaunchProfile(join(artifacts, 'obsidian-profile-9242'), link, { ...where, artifacts })).toBe(join(artifacts, 'obsidian-profile-9242'));
  });

  it('E59 relaunches with what the window says, not a profile of its own', () => {
    // Text, not behaviour: the case runs when loaded, and driving it needs an Obsidian that quits and comes back (row 9
    // was run on the real one, artifacts/lev-327/record.md). What it pins: the launch takes `profile`, read from the
    // window before the quit (relaunchProfile's rules are tested above).
    const text = readFileSync(new URL('../../scripts/e2e/close-draft.mjs', import.meta.url), 'utf8');
    expect(text).toContain("const profile = relaunchProfile(await evaluate(`return require('electron').remote.app.getPath('userData');`));");
    expect(text).toContain('launchObsidian({ profile, port: PORT });');
    expect(text).not.toMatch(/artifacts', 'obsidian-profile'/u);
  });

  it('finds the process holding a profile from its SingletonLock, and none when that process is gone', () => {
    const profile = tempDir();
    symlinkSync(`some-host-${OTHER}`, join(profile, 'SingletonLock'));
    expect(profileHolder(profile, { starts: startedWith() })).toBe(OTHER);
    expect(profileHolder(profile, { starts: startedWith({ dead: true }) })).toBe(null);
    expect(profileHolder(tempDir(), { starts: startedWith() })).toBe(null);
  });
});

describe('cases that act on what every instance shares run alone', () => {
  /**
   * What only a solo case may do: the OS clipboard, the OS focus (taking it, or opening a popout or the settings window,
   * which takes it from another instance's window: artifacts/lev-327/focus-probe*.json), quitting or launching Obsidian,
   * judging frame times. A reload does not move the focus (focus-probe-reload.json).
   */
  const SHARED = [
    /\bclipboard\b/u, // the OS clipboard, read or written (Electron's or navigator's)
    /remote\.app\.focus\(|steal: true|\bBrowserWindow\b|getCurrentWindow\(\)\.(?:focus|blur|show)\(|bringToFront|getCurrentWebContents\(\)\.focus\(|getFocusedWindow\(/u, // the OS focus
    /openPopoutLeaf|moveLeafToPopout|getLeaf\(\s*['"]window['"]|new-window/u, // a popout window
    /app\.setting\.open\(|app:open-settings|openTabById/u, // the settings window
    /app\.quit\(|app\.relaunch\(|'open', \['-n|\bQUIT\b|launchObsidian\(/u, // Obsidian quitting or launching (instance.mjs's helpers too)
    /--budget/u, // frame times judged
  ];
  const scripts = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts;
  const files = [...new Set(Object.entries(scripts).filter(([name]) => name.startsWith('harness:e2e:'))
    .map(([, command]) => /scripts\/e2e\/([\w-]+\.mjs)/u.exec(command)?.[1]).filter(Boolean))];

  /**
   * The code of `file` and of the local modules it imports, all the way down (review 3-6: a helper doing it counts for
   * every case that imports it), without comment lines. instance.mjs and cdp.mjs are the harness's own (they quit and
   * watch windows for the launcher and E59).
   */
  const OWN = new Set(['instance.mjs', 'cdp.mjs', 'case-runner.mjs', 'provenance.mjs']);
  const code = (file, seen = new Set()) => {
    if (seen.has(file) || OWN.has(file)) return '';
    seen.add(file);
    const text = readFileSync(new URL(`../../scripts/e2e/${file}`, import.meta.url), 'utf8');
    const imported = [...text.matchAll(/from '\.\/([\w-]+\.mjs)'/gu)].map(match => match[1]);
    const own = text.split('\n').filter(line => !/^\s*(?:\*|\/\*|\/\/)/u.test(line)).join('\n');
    return [own, ...imported.map(name => code(name, seen))].join('\n');
  };

  it('counts quitting and launching through instance.mjs\'s helpers as shared work', () => {
    // Orchestrator review (Low 2): 9eee912 moved the quit and the launch into instance.mjs (QUIT, launchObsidian()).
    const flagged = text => SHARED.some(pattern => pattern.test(text));
    expect(flagged('await evaluate(`window.__mappyE2E = null; ${QUIT} return true;`);')).toBe(true);
    expect(flagged('launchObsidian({ profile, port: PORT });')).toBe(true);
    expect(flagged('const quitting = 1;')).toBe(false);
  });

  it('reads what a case imports, and not comments', () => {
    expect(code('draft-own-write.mjs')).toMatch(/clipboard\.write\(/u);
    expect(code('dom-helpers.mjs')).not.toMatch(/OS clipboard/u);
    expect(code('main-topic.mjs')).toContain(readFileSync(new URL('../../scripts/e2e/language.mjs', import.meta.url), 'utf8').split('\n').find(line => line.includes('app:reload')));
  });

  it.each(files)('%s asks to run alone on its first connect() if it, or a helper it imports, does any of them', file => {
    const text = readFileSync(new URL(`../../scripts/e2e/${file}`, import.meta.url), 'utf8');
    const shared = SHARED.filter(pattern => pattern.test(code(file)));
    const first = /await connect\(([^)]*)\)/u.exec(text)?.[1] ?? null;
    if (shared.length > 0) expect(first, `${file}: ${shared.join(', ')}`).toMatch(/solo:/u);
  });

  it('reads the cases main added since, and leaves E84, exit-draft-cut and E85 beside other instances', () => {
    // E85 (LEV-331) sends its clicks and keys to its own page; a ⌘Z the page leaves goes to its own app's menu (and its
    // guard stops it). E84 and exit-draft-cut reload the window, which moves no other instance's focus (focus-probe-reload.json).
    expect(files).toEqual(expect.arrayContaining(['undo-draft.mjs', 'exit-draft-recovery.mjs']));
    for (const file of ['undo-draft.mjs', 'exit-draft-recovery.mjs']) {
      expect(SHARED.filter(pattern => pattern.test(code(file))), file).toEqual([]);
    }
  });

  it('finds the ten that do', () => {
    const solo = files.filter(file => /await connect\(\{ (?:language: null, )?solo:/u.test(readFileSync(new URL(`../../scripts/e2e/${file}`, import.meta.url), 'utf8')));
    expect(solo.sort()).toEqual(['close-draft.mjs', 'draft-own-write.mjs', 'english-ui.mjs', 'panzoom-frames.mjs', 'parallel-focus.mjs', 'popout.mjs', 'theme.mjs',
      'view-padding.mjs', 'visible-layouts.mjs', 'window-blur-draft.mjs']);
  });

  it('counts focus APIs besides app.focus as shared work', () => {
    // Review 2 of the rebased PR, finding 9 (the patterns named there; see docs/harness.md for what is not caught).
    const flagged = text => SHARED.some(pattern => pattern.test(text));
    expect(flagged("await cdp.send('Page.bringToFront');")).toBe(true);
    expect(flagged("require('electron').remote.getCurrentWebContents().focus();")).toBe(true);
    expect(flagged("require('electron').remote.BrowserWindow.getFocusedWindow();")).toBe(true);
  });
});

describe('a second vault in one checkout', () => {
  it('reads a relative MAPPY_E2E_VAULT from the project, as prepare and preflight do, wherever the case runs from', () => {
    // Review finding 3: the cases resolved it from the working directory, preflight from the project.
    const project = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
    expect(instance.resolveVault?.('test-vault-b')).toBe(join(project, 'test-vault-b'));
    // From another working directory, in a process of its own (the tests run from the project). MAPPY_E2E_PROFILE too
    // (review 2 of the rebased PR, finding 4).
    const elsewhere = tempDir();
    const script = `import(${JSON.stringify(new URL('../../scripts/e2e/instance.mjs', import.meta.url).href)}).then(m => process.stdout.write(m.resolveVault('test-vault-b') + '|' + m.VAULT + '|' + m.PROFILE))`;
    const read = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: elsewhere, encoding: 'utf8', env: { ...process.env, MAPPY_E2E_VAULT: 'test-vault-b', MAPPY_E2E_PROFILE: 'artifacts/obsidian-profile-9242' } });
    expect(read.stdout).toBe(`${join(project, 'test-vault-b')}|${join(project, 'test-vault-b')}|${join(project, 'artifacts', 'obsidian-profile-9242')}`);
    expect(instance.resolveVault('/elsewhere/test-vault')).toBe('/elsewhere/test-vault');
    expect(instance.resolveVault(undefined)).toBe(join(project, 'test-vault'));
  });

  const root = '/w';
  it('accepts test-vault and test-vault-<name> directly in the project', () => {
    expect(harnessVault(root, undefined)).toBe('/w/test-vault');
    expect(harnessVault(root, 'test-vault-b')).toBe('/w/test-vault-b');
    expect(harnessVault(root, '/w/test-vault-9242')).toBe('/w/test-vault-9242');
  });

  it('takes the checkout reached through a link as the same checkout', () => {
    // Review 3: a logical path through a linked checkout was refused as another project.
    const real = tempDir();
    const link = join(tempDir(), 'link');
    symlinkSync(real, link);
    expect(harnessVault(real, join(link, 'test-vault-b'))).toBe(join(real, 'test-vault-b'));
  });

  it.each(['/elsewhere/test-vault-b', 'Fixtures/test-vault-b', 'my-vault', 'test-vault-B', 'test-vault_b', '../w2/test-vault'])('refuses %s', requested => {
    expect(() => harnessVault(root, requested)).toThrow(/MAPPY_E2E_VAULT must be test-vault or test-vault-<name> directly in \/w/u);
  });

  it('names what .gitignore and eslint ignore', () => {
    expect(vaultName.test('test-vault')).toBe(true);
    expect(readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8')).toMatch(/^\/test-vault-\*\/$/mu);
    expect(readFileSync(new URL('../../eslint.config.mjs', import.meta.url), 'utf8')).toContain('"test-vault-*/**"');
  });
});
