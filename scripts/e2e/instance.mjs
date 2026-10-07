/**
 * Which dedicated Obsidian a case drives, and the register that lets several of them run side by side (LEV-327,
 * docs/harness.md「専用の Obsidian を並べる」). Until LEV-327 only one ran at a time (one Obsidian to drive); now each
 * instance has its own port, profile and test vault, and every process that drives one is entered here first.
 *
 *   MAPPY_E2E_PORT      CDP port (default 9231)
 *   MAPPY_E2E_VAULT     absolute path of the vault the window must have open (default: this checkout's test-vault)
 *   MAPPY_E2E_PROFILE   the profile (`--user-data-dir`) the instance runs with; optional, checked where a case relaunches
 *   MAPPY_E2E_WAIT      seconds a process waits for its turn before giving up (default 1800)
 *   MAPPY_E2E_LOCK_DIR  where the entries are written (default: `.tooling/e2e-instances/` in the primary checkout)
 *
 * Nothing here talks to Obsidian, so it loads without a vault (case-runner.mjs reads the port from here).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PORT = process.env.MAPPY_E2E_PORT ?? '9231';
/**
 * The vault a case may drive. `MAPPY_E2E_VAULT` names another generated vault (this checkout's `test-vault-<name>` for a
 * second instance, or another checkout's own test vault); cdp.mjs refuses one without the marker `prepare-test-vault`
 * leaves (AGENTS.md: 本番 Vault をテスト対象にしない).
 */
export const VAULT = process.env.MAPPY_E2E_VAULT ? resolve(process.env.MAPPY_E2E_VAULT) : resolve(root, 'test-vault');
export const PROFILE = process.env.MAPPY_E2E_PROFILE ? resolve(process.env.MAPPY_E2E_PROFILE) : null;
const WAIT = Number(process.env.MAPPY_E2E_WAIT ?? 1800);
/** Ports `npm run harness:obsidian -- start` picks from when none is given: away from 9231 (the default) and 9222 (Kioku's). */
export const PORT_RANGE = [9241, 9299];

/** `.tooling/e2e-instances/` beside the git common dir, the same place from every worktree (as handoff.mjs does). */
export function lockDir() {
  if (process.env.MAPPY_E2E_LOCK_DIR) return resolve(process.env.MAPPY_E2E_LOCK_DIR);
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return join(dirname(realpathSync(resolve(root, common))), '.tooling', 'e2e-instances');
  } catch {
    return join(root, '.tooling', 'e2e-instances');
  }
}

/**
 * When the process `pid` started (`ps -o lstart`), or null when there is none. An entry keeps its process's start, so a
 * pid the system has given to a new process since does not keep a dead entry alive. Read with `ps`: nothing is signalled.
 */
export function processStart(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
  const start = result.status === 0 ? result.stdout.trim() : '';
  return start || null;
}

const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && resolve(a) === resolve(b);

/**
 * Whether `other` keeps `mine` from starting. Two processes on one instance (port) or one vault would drive the same
 * window or the same files. A `solo` process acts on what every instance shares (the OS clipboard, the OS focus, an
 * Obsidian coming up or going away, frame times another instance's load would show in), so it runs with nothing else,
 * and nothing starts beside it.
 */
export function blocks(mine, other) {
  if (mine.solo || other.solo) return true;
  return (mine.port !== null && String(other.port) === String(mine.port)) || samePath(other.vault, mine.vault);
}

/**
 * Of two `solo` entries waiting together, the earlier claim goes first (then the lower pid), so they do not both step
 * back for ever; the later one steps back while the earlier keeps its entry.
 */
export function before(a, b) {
  return a.claimedAt === b.claimedAt ? a.pid < b.pid : a.claimedAt < b.claimedAt;
}

/** The entries of processes still running, other than `pid`'s. An entry that cannot be read is skipped. */
export function liveEntries(dir, pid = process.pid, { started = processStart } = {}) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const entries = [];
  for (const name of names) {
    if (!/^\d+\.json$/u.test(name)) continue;
    let entry;
    try { entry = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { continue; }
    if (!entry || entry.pid === pid || typeof entry.pid !== 'number') continue;
    if (entry.started === null || started(entry.pid) !== entry.started) continue;
    entries.push(entry);
  }
  return entries;
}

export const describeEntry = entry => `${entry.what} (pid ${entry.pid}, port ${entry.port ?? '—'}, ${entry.vault ?? 'no vault'}${entry.solo ? `, alone: ${entry.solo}` : ''})`;

let held = null;

/**
 * Enters this process for `port`/`vault` and waits until nothing in the register blocks it (`blocks`), up to `wait`
 * seconds; then it throws without having touched the instance. The entry is written before the others are read: of two
 * processes that come at once, each then sees the other and steps back (and tries again a moment later), so two never
 * both go. A waiting `solo` process keeps its entry (unless an earlier one waits too), so the processes that start
 * after it wait for it instead of going round it. The entry is removed when the process exits; one left by a process
 * that was killed is not counted (`liveEntries`). A process enters once: a later call hands back the same entry, and
 * one asking to be `solo` after entering without it throws.
 */
export async function claimInstance({ port = PORT, vault = VAULT, solo = null, what = whatRuns(), wait = WAIT, dir = lockDir(), log = message => console.error(message), started = processStart } = {}) {
  if (held) {
    if (solo && !held.entry.solo) throw new Error(`This process entered for ${describeEntry(held.entry)} without asking to run alone; ask on its first connect().`);
    return held;
  }
  // An entry without its start would read as a dead process's to everyone else, and nothing would wait for it.
  const own = started(process.pid);
  if (own === null) throw new Error(`Could not read this process's start with ps, so it cannot enter the register in ${dir}. No action taken.`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${process.pid}.json`);
  const entry = { pid: process.pid, started: own, port: port === null ? null : String(port), vault, solo: solo || null, what, claimedAt: new Date().toISOString() };
  const deadline = Date.now() + Math.max(0, wait) * 1000;
  let told = 0;
  for (;;) {
    writeFileSync(file, `${JSON.stringify(entry)}\n`);
    const others = liveEntries(dir, process.pid, { started });
    const blocking = others.filter(other => blocks(entry, other));
    if (blocking.length === 0) break;
    const keep = entry.solo && !others.some(other => other.solo && before(other, entry));
    if (!keep) unlinkSync(file);
    if (Date.now() >= deadline) {
      if (keep) unlinkSync(file);
      throw new Error(`Not run: waited ${wait} s for ${blocking.map(describeEntry).join('; ')} (MAPPY_E2E_WAIT). No action taken.`);
    }
    if (Date.now() - told >= 60000) {
      log(`Waiting for ${blocking.map(describeEntry).join('; ')} (up to ${wait} s, MAPPY_E2E_WAIT).`);
      told = Date.now();
    }
    await new Promise(resolve_ => { setTimeout(resolve_, 1000 + Math.random() * 1000); });
  }
  const release = () => {
    try {
      if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) unlinkSync(file);
    } catch { /* already gone */ }
    held = null;
  };
  process.once('exit', release);
  held = { file, entry, release };
  return held;
}

/** This process's entry while it holds one (case-runner.mjs writes it into the record), else null. */
export const heldEntry = () => held?.entry ?? null;

/** The script and its flags, as the entry names who holds it. */
export function whatRuns(argv = process.argv) {
  return [basename(argv[1] ?? 'node'), ...argv.slice(2).filter(arg => arg.startsWith('--') && arg !== '--json' && arg !== '--shot')].join(' ');
}

/** Whether nothing listens on 127.0.0.1:`port` (Obsidian's DevTools server binds there). */
export function portFree(port) {
  return new Promise(resolve_ => {
    const server = createServer();
    server.once('error', () => resolve_(false));
    server.listen(Number(port), '127.0.0.1', () => server.close(() => resolve_(true)));
  });
}

/** The first port in `range` that nothing listens on and no live entry names. */
export async function freePort({ range = PORT_RANGE, dir = lockDir(), free = portFree, entries = () => liveEntries(dir) } = {}) {
  const taken = new Set(entries().map(entry => String(entry.port)));
  for (let port = range[0]; port <= range[1]; port += 1) {
    if (!taken.has(String(port)) && await free(port)) return String(port);
  }
  throw new Error(`No free port in ${range[0]}–${range[1]}.`);
}

/**
 * The pid holding `profile`, from the `SingletonLock` link Chromium leaves in it (`<host>-<pid>`), or null. A second
 * launch with a profile in use only hands its arguments to the running one, which keeps its own port.
 */
export function profileHolder(profile, { started = processStart } = {}) {
  let target;
  try { target = execFileSync('readlink', [join(profile, 'SingletonLock')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
  const pid = Number(/-(\d+)$/u.exec(target)?.[1]);
  return Number.isInteger(pid) && pid > 0 && started(pid) !== null ? pid : null;
}

/**
 * The profile a case launches Obsidian again with after quitting it (E59's row 9): the one the window runs with
 * (`app.getPath('userData')`), so a second instance comes back as itself, not as another one's profile. With
 * `MAPPY_E2E_PROFILE` set, a window that runs with another profile is refused before anything is quit.
 */
export function relaunchProfile(running, expected = PROFILE) {
  if (typeof running !== 'string' || running === '') throw new Error('The window did not say which profile it runs with. No action taken.');
  if (expected !== null && !samePath(expected, running)) {
    throw new Error(`The Obsidian on port ${PORT} runs with the profile ${running}, not ${expected} (MAPPY_E2E_PROFILE). No action taken.`);
  }
  return running;
}
