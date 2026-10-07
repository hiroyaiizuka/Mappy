/**
 * Starts and stops the dedicated Obsidian the e2e cases drive, one per port, profile and test vault, so several run side
 * by side (LEV-327, docs/harness.md「専用の Obsidian を並べる」). macOS only (`open -na`), as E59's relaunch is.
 *
 *   npm run harness:obsidian -- start [--vault <test-vault-…>] [--port <n>] [--profile <artifacts/…>]
 *   npm run harness:obsidian -- stop [--vault <test-vault-…>] [--port <n>]
 *   npm run harness:obsidian -- list
 *
 * start: the vault is `--vault`, else `MAPPY_E2E_VAULT`, else `test-vault`, and must be a generated one in this checkout
 * (`npm run harness:prepare` with the same `MAPPY_E2E_VAULT`) that no running Obsidian has open (any profile but the
 * everyday one: this checkout's, or another worktree's driving it through `MAPPY_E2E_VAULT`). The
 * port is `--port`, else the first one in 9241–9299 that nothing listens on (`MAPPY_E2E_PORT` is not read: it is what
 * the start prints, and the instance it named may still be up). The profile is `--profile`, else
 * `artifacts/obsidian-profile-<port>`, and must be inside this checkout's `artifacts/` with no link on the way, so the
 * everyday Obsidian's profile is never launched or written. A profile another Obsidian still runs with is refused (a
 * second launch would only hand that one its arguments). Its `obsidian.json` is
 * written to open the vault alone, with updates off; restricted mode is turned off in the window (the vault's own
 * `community-plugins.json` says what loads). It prints the variables the cases read.
 *
 * stop: quits (`app.quit()` over CDP, no signal) the instance on `--port`/`MAPPY_E2E_PORT` whose window has the vault and
 * whose profile is inside this checkout's `artifacts/`, and waits for its port to close.
 *
 * Both run alone (instance.mjs's `solo`): an Obsidian coming up or going away moves the OS focus, which every instance
 * shares, so they wait for the cases on the other instances to finish, and those wait for them.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGeneratedVault, assertSafePath, harnessPaths, harnessVault, isInside } from '../preflight.mjs';
import { connect, wait } from './cdp.mjs';
import {
  canonical, claimInstance, describeEntry, exportLine, freePort, launchObsidian, liveEntries, lockDir, PORT, portAnswers, portFree, portFromFlag,
  PORT_RANGE, profileHolder, profilesWithVault, QUIT, shellWord, VAULT,
} from './instance.mjs';

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const [command, ...rest] = process.argv.slice(2);
/** The value after `name`, or undefined without the flag; a flag with no value (or another flag after it) is refused. */
const value = name => {
  const at = rest.indexOf(name);
  if (at === -1) return undefined;
  const given = rest[at + 1];
  if (given === undefined || given.startsWith('--')) throw new Error(`${name} needs a value. No action taken.`);
  return given;
};

/**
 * `path` resolved, if it lies inside this checkout's `artifacts/` with its links resolved; otherwise it throws. `start`
 * also checks every component with `assertSafePath` (no link anywhere), before it writes the profile's `obsidian.json`.
 */
function inArtifacts(path) {
  const resolved = resolve(root, path);
  if (!isInside(join(root, 'artifacts'), canonical(resolved))) {
    throw new Error(`The profile must be inside ${join(root, 'artifacts')}, not ${resolved}. No action taken.`);
  }
  return resolved;
}

/** A stable vault id for the profile's `obsidian.json`, so a relaunch keeps the vault's own local storage. */
const vaultId = vault => createHash('sha256').update(vault).digest('hex').slice(0, 16);

/** `obsidian.json` that opens `vault` alone, keeping the other keys of one already there. */
function writeVaultList(profile, vault) {
  const file = join(profile, 'obsidian.json');
  assertSafePath(root, file, 'file', { optional: true });
  let current = {};
  if (existsSync(file)) {
    try { current = JSON.parse(readFileSync(file, 'utf8')); } catch { current = {}; }
  }
  const next = { ...current, vaults: { [vaultId(vault)]: { path: vault, ts: Date.now(), open: true } }, updateDisabled: true };
  writeFileSync(file, `${JSON.stringify(next)}\n`);
}

async function start() {
  const requested = portFromFlag(value('--port'));
  if (process.platform !== 'darwin') throw new Error('harness:obsidian launches with open -na, on macOS only. No action taken.');
  const vault = harnessVault(root, value('--vault') ?? process.env.MAPPY_E2E_VAULT);
  assertGeneratedVault(harnessPaths(root, vault));
  // Alone: no case runs while it does, so the ports to keep clear of are the listening ones (instance.mjs's freePort).
  await claimInstance({ port: requested, vault, solo: 'launches an Obsidian, which comes to the front', what: 'obsidian.mjs start' });
  const open = profilesWithVault(vault);
  if (open.length > 0) throw new Error(`${vault} is already open in the Obsidian with the profile ${open.join(', ')}; one vault, one instance. No action taken.`);
  if (requested !== null && !(await portFree(requested))) throw new Error(`Port ${requested} is in use. No action taken.`);
  const port = requested ?? await freePort();
  const profile = inArtifacts(value('--profile') ?? join('artifacts', `obsidian-profile-${port}`));
  assertSafePath(root, profile, 'directory', { optional: true });
  mkdirSync(profile, { recursive: true });
  assertSafePath(root, profile, 'directory');
  const holder = profileHolder(profile);
  if (holder !== null) throw new Error(`The profile ${profile} is in use by pid ${holder}; stop that Obsidian first (or give another --profile). No action taken.`);
  writeVaultList(profile, vault);
  launchObsidian({ profile, port });

  // What the launched Obsidian is left as when the start fails: quit if its window answered, else named for a hand quit
  // (nothing here signals a process).
  const leftover = () => {
    const pid = profileHolder(profile);
    return pid === null ? '' : ` The Obsidian it launched (pid ${pid}, profile ${profile}) is still running without a window this can reach: quit it from its window (⌘Q) before the next start with that profile.`;
  };
  let cdp;
  let refused;
  for (const started = Date.now(); !cdp && Date.now() - started < 90000; await wait(500)) {
    try { cdp = await connect({ port, vault, language: null }); } catch (error) { refused = error; }
  }
  if (!cdp) throw new Error(`Obsidian did not open ${vault} on port ${port} within 90 s: ${refused}.${leftover()}`);
  let ours = false;
  try {
    const userData = await cdp.evaluate("require('electron').remote.app.getPath('userData')");
    if (canonical(userData) !== canonical(profile)) throw new Error(`The window on port ${port} runs with the profile ${userData}, not ${profile}: another Obsidian has the port.${leftover()}`);
    ours = true;
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
      // Obsidian 1.13.7 once opened its settings window after the trust (LEV-327); a case finds windows by their marks,
      // and starts from the main window alone.
      app.setting?.close?.();
      await sleep(300);
      return { layoutReady: app.workspace.layoutReady, trusted, windows: require('electron').remote.BrowserWindow.getAllWindows().length, restricted: !app.plugins.isEnabled(), mappy: app.plugins.plugins.mappy?.manifest?.version ?? null,
        obsidian: require('electron').remote.app.getVersion(), language: window.moment?.locale?.() ?? null };
    })()`);
    const result = { port, vault, profile, ...state };
    console.log(JSON.stringify(result, null, 2));
    if (!state.mappy) throw new Error(`Mappy did not load in the new window (restricted mode ${state.restricted ? 'on' : 'off'}).`);
    console.log(`\n${exportLine({ port, vault, profile })}`);
    console.log(`Stop it with: MAPPY_E2E_PORT=${shellWord(port)} MAPPY_E2E_VAULT=${shellWord(vault)} npm run harness:obsidian -- stop`);
  } catch (error) {
    // The window is this start's (its profile): quit it rather than leave an instance no one will use.
    if (ours) {
      await cdp.evaluate(`(() => { ${QUIT} return true; })()`).catch(() => undefined);
      error.message += ' The Obsidian it launched was quit (app.quit()).';
    }
    throw error;
  } finally {
    cdp.close();
  }
}

async function stop() {
  const port = value('--port') ?? PORT;
  const vault = value('--vault') ? harnessVault(root, value('--vault')) : VAULT;
  const cdp = await connect({ port, vault, language: null, solo: 'quits an Obsidian, after which another window comes to the front' });
  let userData;
  try {
    userData = await cdp.evaluate("require('electron').remote.app.getPath('userData')");
    inArtifacts(userData);
    await cdp.evaluate(`(() => { ${QUIT} return true; })()`);
  } finally {
    cdp.close();
  }
  for (const started = Date.now(); Date.now() - started < 20000; await wait(500)) {
    if (!(await portAnswers(port))) {
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
