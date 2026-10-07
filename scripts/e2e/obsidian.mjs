/**
 * Starts and stops the dedicated Obsidian the e2e cases drive, one per port, profile and test vault, so several run side
 * by side (LEV-327, docs/harness.md「専用の Obsidian を並べる」). macOS only (`open -na`), as E59's relaunch is.
 *
 *   npm run harness:obsidian -- start [--vault <test-vault-…>] [--port <n>] [--profile <artifacts/…>]
 *   npm run harness:obsidian -- stop [--vault <test-vault-…>] [--port <n>]
 *   npm run harness:obsidian -- list
 *
 * start: the vault is `--vault`, else `MAPPY_E2E_VAULT`, else `test-vault`, and must be a generated one in this checkout
 * (`npm run harness:prepare` with the same `MAPPY_E2E_VAULT`). The port is `--port`, else the first one in 9241–9299 that
 * nothing listens on and no entry of the register names (`MAPPY_E2E_PORT` is not read: it is what the start prints, and
 * the instance it named may still be up). The profile is `--profile`, else `artifacts/obsidian-profile-<port>`, and must
 * be inside this checkout's `artifacts/`, so the everyday Obsidian's profile is never launched. A profile another
 * Obsidian still runs with is refused (a second launch would only hand that one its arguments). Its `obsidian.json` is
 * written to open the vault alone, with updates off; restricted mode is turned off in the window (the vault's own
 * `community-plugins.json` says what loads). It prints the variables the cases read.
 *
 * stop: quits (`app.quit()` over CDP, no signal) the instance on `--port`/`MAPPY_E2E_PORT` whose window has the vault and
 * whose profile is inside this checkout's `artifacts/`, and waits for its port to close.
 *
 * Both run alone (instance.mjs's `solo`): an Obsidian coming up or going away moves the OS focus, which every instance
 * shares, so they wait for the cases on the other instances to finish, and those wait for them.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGeneratedVault, harnessPaths, harnessVault } from '../preflight.mjs';
import { connect, wait } from './cdp.mjs';
import { claimInstance, describeEntry, freePort, liveEntries, lockDir, PORT, portFree, PORT_RANGE, profileHolder, VAULT } from './instance.mjs';

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const OBSIDIAN_APP = process.env.MAPPY_E2E_OBSIDIAN_APP ?? '/Applications/Obsidian.app';
const [command, ...rest] = process.argv.slice(2);
const value = name => { const at = rest.indexOf(name); return at === -1 ? undefined : rest[at + 1]; };

/** `path` resolved, if it lies inside this checkout's `artifacts/`; otherwise it throws. */
function inArtifacts(path) {
  const resolved = resolve(root, path);
  const inside = relative(join(root, 'artifacts'), resolved);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`The profile must be inside ${join(root, 'artifacts')}, not ${resolved}. No action taken.`);
  }
  return resolved;
}

/** A stable vault id for the profile's `obsidian.json`, so a relaunch keeps the vault's own local storage. */
const vaultId = vault => createHash('sha256').update(vault).digest('hex').slice(0, 16);

/** `obsidian.json` that opens `vault` alone, keeping the other keys of one already there. */
function writeVaultList(profile, vault) {
  const file = join(profile, 'obsidian.json');
  let current = {};
  if (existsSync(file)) {
    try { current = JSON.parse(readFileSync(file, 'utf8')); } catch { current = {}; }
  }
  const next = { ...current, vaults: { [vaultId(vault)]: { path: vault, ts: Date.now(), open: true } }, updateDisabled: true };
  writeFileSync(file, `${JSON.stringify(next)}\n`);
}

const portOpen = port => fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false);

async function start() {
  if (process.platform !== 'darwin') throw new Error('harness:obsidian launches with open -na, on macOS only. No action taken.');
  const vault = harnessVault(root, value('--vault') ?? process.env.MAPPY_E2E_VAULT);
  assertGeneratedVault(harnessPaths(root, vault));
  const requested = value('--port') ?? null;
  await claimInstance({ port: requested, vault, solo: 'launches an Obsidian, which comes to the front', what: 'obsidian.mjs start' });
  const others = liveEntries(lockDir());
  if (requested !== null && (!(await portFree(requested)) || others.some(entry => String(entry.port) === String(requested)))) {
    throw new Error(`Port ${requested} is in use (or a run expects its instance there). No action taken.`);
  }
  const port = requested ?? await freePort({ entries: () => others });
  const profile = inArtifacts(value('--profile') ?? join('artifacts', `obsidian-profile-${port}`));
  mkdirSync(profile, { recursive: true });
  const holder = profileHolder(profile);
  if (holder !== null) throw new Error(`The profile ${profile} is in use by pid ${holder}; stop that Obsidian first (or give another --profile). No action taken.`);
  writeVaultList(profile, vault);
  const launched = spawnSync('open', ['-na', OBSIDIAN_APP, '--args', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { encoding: 'utf8' });
  if (launched.status !== 0) throw new Error(`open could not launch Obsidian (${launched.status}): ${launched.stderr || launched.error}`);

  let cdp;
  let refused;
  for (const started = Date.now(); !cdp && Date.now() - started < 90000; await wait(500)) {
    try { cdp = await connect({ port, vault, language: null }); } catch (error) { refused = error; }
  }
  if (!cdp) throw new Error(`Obsidian did not open ${vault} on port ${port} within 90 s: ${refused}`);
  try {
    const userData = await cdp.evaluate("require('electron').remote.app.getPath('userData')");
    if (resolve(userData) !== profile) throw new Error(`The window on port ${port} runs with the profile ${userData}, not ${profile}: another Obsidian has the port.`);
    const state = await cdp.evaluate(`(async () => {
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      for (let i = 0; i < 300 && !app.workspace.layoutReady; i += 1) await sleep(100);
      // A new profile opens the vault in restricted mode and, the first time, asks whether to trust its author.
      let trusted = false;
      for (let i = 0; i < 100 && !app.plugins.plugins.mappy; i += 1) {
        const trust = [...document.querySelectorAll('.modal-container button')].find(button => /作成者を信頼|Trust author/u.test(button.textContent));
        if (trust) { trust.click(); trusted = true; } else if (i >= 20 && !app.plugins.isEnabled()) await app.plugins.setEnable(true);
        await sleep(100);
      }
      return { layoutReady: app.workspace.layoutReady, trusted, restricted: !app.plugins.isEnabled(), mappy: app.plugins.plugins.mappy?.manifest?.version ?? null,
        obsidian: require('electron').remote.app.getVersion(), language: window.moment?.locale?.() ?? null };
    })()`);
    const result = { port, vault, profile, ...state };
    console.log(JSON.stringify(result, null, 2));
    if (!state.mappy) throw new Error(`Mappy did not load in the new window (restricted mode ${state.restricted ? 'on' : 'off'}).`);
    console.log(`\nexport MAPPY_E2E_PORT=${port} MAPPY_E2E_VAULT=${vault} MAPPY_E2E_PROFILE=${profile}`);
    console.log(`Stop it with: MAPPY_E2E_PORT=${port} MAPPY_E2E_VAULT=${vault} npm run harness:obsidian -- stop`);
  } finally {
    cdp.close();
  }
}

async function stop() {
  const port = value('--port') ?? PORT;
  const vault = value('--vault') ? harnessVault(root, value('--vault')) : VAULT;
  const cdp = await connect({ port, vault, language: null, solo: 'quits an Obsidian, after which another window comes to the front' });
  const userData = await cdp.evaluate("require('electron').remote.app.getPath('userData')");
  try { inArtifacts(userData); } catch (error) { cdp.close(); throw error; }
  await cdp.evaluate("(() => { setTimeout(() => require('electron').remote.app.quit(), 0); return true; })()");
  cdp.close();
  for (const started = Date.now(); Date.now() - started < 20000; await wait(500)) {
    if (!(await portOpen(port))) {
      console.log(`Quit the Obsidian on port ${port} (profile ${userData}).`);
      return;
    }
  }
  throw new Error(`The Obsidian on port ${port} was still running 20 s after app.quit().`);
}

function list() {
  const entries = liveEntries(lockDir(), -1);
  console.log(entries.length === 0 ? `Nothing in the register (${lockDir()}).` : entries.map(describeEntry).join('\n'));
  console.log(`start picks from ports ${PORT_RANGE[0]}–${PORT_RANGE[1]}.`);
}

try {
  if (command === 'start') await start();
  else if (command === 'stop') await stop();
  else if (command === 'list') list();
  else throw new Error('Usage: npm run harness:obsidian -- start [--vault <v>] [--port <n>] [--profile <p>] | stop [--vault <v>] [--port <n>] | list');
  process.exit(0);
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exit(1);
}
