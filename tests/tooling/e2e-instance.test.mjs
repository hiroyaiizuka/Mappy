import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  blocks, canonical, claimInstance, exportLine, freePort, liveEntries, lockDir, noteShared, parentRun, portFromFlag, processStarts, profileHolder,
  profilesWithVault, relaunchProfile, releaseInstance, waitSeconds,
} from '../../scripts/e2e/instance.mjs';
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

  it('skips entries it cannot read and lists only the others', () => {
    const dir = tempDir();
    writeOther(dir, {});
    writeFileSync(join(dir, '123.json'), '{ not json');
    writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, started: 'self' }));
    expect(liveEntries(dir, process.pid, { starts: startedWith() }).map(entry => entry.pid)).toEqual([OTHER]);
  });
});

describe('what uses the register', () => {
  it('connect() enters the register before it reaches the instance', () => {
    const text = readFileSync(new URL('../../scripts/e2e/cdp.mjs', import.meta.url), 'utf8');
    const body = text.slice(text.indexOf('export async function connect('));
    expect(body.indexOf('await claimInstance({ port, vault: ours, solo });')).toBeGreaterThan(-1);
    expect(body).toContain("await send('Target.setDiscoverTargets', { discover: true });");
    expect(body.indexOf('await claimInstance(')).toBeLessThan(body.indexOf('fetch('));
  });

  it('writes the instance the case entered for into its record, and none for a case that never connected', async () => {
    const dir = tempDir();
    const json = join(dir, 'case.json');
    await finish(createRecord(dir, 'Fixtures/E2E'), json);
    expect(JSON.parse(readFileSync(json, 'utf8')).instance).toBe(null);
    await claim(dir, { solo: 'opens the settings window' });
    await finish(createRecord(dir, 'Fixtures/E2E'), json);
    expect(JSON.parse(readFileSync(json, 'utf8')).instance).toEqual({ port: '9242', vault: '/b/test-vault', solo: 'opens the settings window' });
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

  it('the gate reads the build without the vault MAPPY_E2E_VAULT names', () => {
    // Review 3: the gate went through the vault check and refused a build that was fine when the variable named another vault.
    expect(readFileSync(new URL('../../scripts/harness-gate.mjs', import.meta.url), 'utf8')).toContain('readHarnessBuild(getHarnessPaths({ env: {} }))');
  });
});

describe('choosing a port', () => {
  it('takes the first port nothing listens on', async () => {
    const listening = new Set(['9241', '9242']);
    const port = await freePort({ range: [9241, 9299], free: async candidate => !listening.has(String(candidate)) });
    expect(port).toBe('9243');
  });

  it('says so when the range is full', async () => {
    await expect(freePort({ range: [9241, 9242], free: async () => false })).rejects.toThrow('No free port in 9241–9242.');
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
    expect(text).toContain("const requested = portFromFlag(value('--port'));");
  });

  it('run.mjs enters the register for the run and tells its cases which run they belong to', () => {
    const text = readFileSync(new URL('../../scripts/e2e/run.mjs', import.meta.url), 'utf8');
    expect(text).toContain("await claimInstance({ kind: 'run',");
    expect(text).toContain('MAPPY_E2E_RUN: String(process.pid)');
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
    expect(() => relaunchProfile(where.everyday, null, where)).toThrow(/not one inside \/w\/artifacts/u);
    expect(() => relaunchProfile(where.everyday, where.everyday, where)).toThrow(/not one inside/u);
    expect(() => relaunchProfile('/elsewhere/profile', null, where)).toThrow(/not one inside/u);
    expect(relaunchProfile('/elsewhere/profile', '/elsewhere/profile', where)).toBe('/elsewhere/profile');
  });

  it('takes MAPPY_E2E_PROFILE through a link as the profile the window names by its real path', () => {
    const artifacts = join(tempDir(), 'artifacts');
    mkdirSync(join(artifacts, 'obsidian-profile-9242'), { recursive: true });
    const link = join(tempDir(), 'link');
    symlinkSync(join(artifacts, 'obsidian-profile-9242'), link);
    expect(relaunchProfile(join(artifacts, 'obsidian-profile-9242'), link, { ...where, artifacts })).toBe(join(artifacts, 'obsidian-profile-9242'));
  });

  it('E59 relaunches with what the window says, not a profile of its own', () => {
    // Text, as the case runs when loaded: the launch takes `profile`, read from the window before the quit.
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
    /remote\.app\.focus\(|steal: true|\bBrowserWindow\b|getCurrentWindow\(\)\.(?:focus|blur|show)\(/u, // the OS focus
    /openPopoutLeaf|moveLeafToPopout|getLeaf\(\s*['"]window['"]|new-window/u, // a popout window
    /app\.setting\.open\(|app:open-settings|openTabById/u, // the settings window
    /app\.quit\(|app\.relaunch\(|'open', \['-n/u, // Obsidian quitting or launching
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

  it('finds the nine that do', () => {
    const solo = files.filter(file => /await connect\(\{ solo:/u.test(readFileSync(new URL(`../../scripts/e2e/${file}`, import.meta.url), 'utf8')));
    expect(solo.sort()).toEqual(['close-draft.mjs', 'draft-own-write.mjs', 'english-ui.mjs', 'panzoom-frames.mjs', 'popout.mjs', 'theme.mjs',
      'view-padding.mjs', 'visible-layouts.mjs', 'window-blur-draft.mjs']);
  });
});

describe('a second vault in one checkout', () => {
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
