import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  blocks, claimInstance, freePort, heldEntry, liveEntries, profileHolder, relaunchProfile,
} from '../../scripts/e2e/instance.mjs';
import { harnessVault, vaultName } from '../../scripts/preflight.mjs';

/**
 * LEV-327: dedicated Obsidian instances run side by side. scripts/e2e/instance.mjs keeps a register of the processes
 * that drive one, so two never drive one instance (port) or one vault at once, and a case that acts on what every
 * instance shares (`solo`) runs with nothing beside it; scripts/preflight.mjs prepares a second vault; E59 relaunches
 * the profile the window ran with. Which change makes each test fail is in the PR (artifacts/lev-327/mutation.txt).
 */
const temporary = [];
const tempDir = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mappy-lev327-'))); temporary.push(dir); return dir; };
afterEach(async () => {
  // A test that entered leaves the register as a process exit would.
  if (heldEntry()) (await claimInstance()).release();
  while (temporary.length > 0) rmSync(temporary.pop(), { recursive: true, force: true });
});

const OTHER = 99999991;
/** `ps -o lstart` stand-in: this process and OTHER (unless `dead`) are running. */
const startedWith = ({ dead = false } = {}) => pid => (pid === process.pid ? 'self' : pid === OTHER && !dead ? 'other' : null);
const writeOther = (dir, fields) => writeFileSync(join(dir, `${OTHER}.json`), JSON.stringify({
  pid: OTHER, started: 'other', port: '9241', vault: '/a/test-vault', solo: null, what: 'other.mjs', claimedAt: '2026-10-07T00:00:00.000Z', ...fields,
}));
const claim = (dir, fields = {}) => claimInstance({ port: '9242', vault: '/b/test-vault', what: 'this.mjs', wait: 0, dir, log: () => {}, started: startedWith(), ...fields });

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
    const held = await claim(dir, { started: startedWith({ dead: true }) });
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

  it('hands a process its one entry again, and refuses to make it solo afterwards', async () => {
    const dir = tempDir();
    const held = await claim(dir);
    expect(await claim(dir, { port: '9243' })).toBe(held);
    await expect(claim(dir, { solo: 'quits Obsidian' })).rejects.toThrow(/without asking to run alone/u);
  });

  it('skips entries it cannot read and lists only the others', () => {
    const dir = tempDir();
    writeOther(dir, {});
    writeFileSync(join(dir, '123.json'), '{ not json');
    writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, started: 'self' }));
    expect(liveEntries(dir, process.pid, { started: startedWith() }).map(entry => entry.pid)).toEqual([OTHER]);
  });
});

describe('choosing a port', () => {
  it('takes the first port nothing listens on and no entry names', async () => {
    const listening = new Set(['9241']);
    const port = await freePort({ range: [9241, 9299], free: async candidate => !listening.has(String(candidate)), entries: () => [{ port: '9242' }] });
    expect(port).toBe('9243');
  });

  it('says so when the range is full', async () => {
    await expect(freePort({ range: [9241, 9242], free: async () => false, entries: () => [] })).rejects.toThrow('No free port in 9241–9242.');
  });
});

describe('the profile', () => {
  it('relaunches the profile the window ran with, and refuses one that is not MAPPY_E2E_PROFILE', () => {
    expect(relaunchProfile('/w/artifacts/obsidian-profile-9242', null)).toBe('/w/artifacts/obsidian-profile-9242');
    expect(relaunchProfile('/w/artifacts/obsidian-profile-9242', '/w/artifacts/obsidian-profile-9242')).toBe('/w/artifacts/obsidian-profile-9242');
    expect(() => relaunchProfile('/w/artifacts/obsidian-profile-9242', '/w/artifacts/obsidian-profile')).toThrow(/not \/w\/artifacts\/obsidian-profile \(MAPPY_E2E_PROFILE\)/u);
    expect(() => relaunchProfile('', null)).toThrow(/did not say/u);
  });

  it('E59 relaunches with what the window says, not a profile of its own', () => {
    // Text, as the case runs when loaded: the launch takes `profile`, read from the window before the quit.
    const text = readFileSync(new URL('../../scripts/e2e/close-draft.mjs', import.meta.url), 'utf8');
    expect(text).toContain("const profile = relaunchProfile(await evaluate(`return require('electron').remote.app.getPath('userData');`));");
    expect(text).toContain('`--user-data-dir=${profile}`');
    expect(text).not.toMatch(/artifacts', 'obsidian-profile'/u);
  });

  it('finds the process holding a profile from its SingletonLock, and none when that process is gone', () => {
    const profile = tempDir();
    symlinkSync(`some-host-${OTHER}`, join(profile, 'SingletonLock'));
    expect(profileHolder(profile, { started: startedWith() })).toBe(OTHER);
    expect(profileHolder(profile, { started: startedWith({ dead: true }) })).toBe(null);
    expect(profileHolder(tempDir(), { started: startedWith() })).toBe(null);
  });
});

describe('cases that act on what every instance shares run alone', () => {
  /**
   * What only a solo case may do: the OS clipboard, the OS focus (taking it, or opening a popout or the settings window,
   * which takes it from another instance's window: artifacts/lev-327/focus-probe*.json), quitting or launching Obsidian,
   * judging frame times. A reload does not move the focus (focus-probe-reload.json).
   */
  const SHARED = [/clipboard\.(?:write|clear)\(/u, /remote\.app\.focus\(/u, /steal: true/u, /openPopoutLeaf|moveLeafToPopout/u,
    /app\.setting\.open\(/u, /app\.quit\(\)/u, /'open', \['-na'/u, /--budget/u];
  const scripts = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts;
  const files = [...new Set(Object.entries(scripts).filter(([name]) => name.startsWith('harness:e2e:'))
    .map(([, command]) => /scripts\/e2e\/([\w-]+\.mjs)/u.exec(command)?.[1]).filter(Boolean))];

  it.each(files)('%s asks to run alone on its first connect() if it does any of them', file => {
    const text = readFileSync(new URL(`../../scripts/e2e/${file}`, import.meta.url), 'utf8');
    const shared = SHARED.filter(pattern => pattern.test(text));
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

  it.each(['/elsewhere/test-vault-b', 'Fixtures/test-vault-b', 'my-vault', 'test-vault-B', 'test-vault_b', '../w2/test-vault'])('refuses %s', requested => {
    expect(() => harnessVault(root, requested)).toThrow(/MAPPY_E2E_VAULT must be test-vault or test-vault-<name> directly in \/w/u);
  });

  it('names what .gitignore and eslint ignore', () => {
    expect(vaultName.test('test-vault')).toBe(true);
    expect(readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8')).toMatch(/^\/test-vault-\*\/$/mu);
    expect(readFileSync(new URL('../../eslint.config.mjs', import.meta.url), 'utf8')).toContain('"test-vault-*/**"');
  });
});
