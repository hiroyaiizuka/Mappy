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
 *   MAPPY_E2E_RUN       set by run.mjs for its cases: the pid of the run they belong to (honoured only from that parent)
 *
 * Nothing here talks to Obsidian, so it loads without a vault (case-runner.mjs reads the entry from here).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect as connectTcp, createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolingDir } from '../handoff.mjs';
import { isInside } from '../preflight.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * `path` with its symbolic links resolved as far as it exists, so one vault or profile reached through a link and
 * directly is one path (the register compares paths as text, and `harness:obsidian` writes the real one).
 */
export function canonical(path) {
  const absolute = resolve(path);
  let existing = absolute;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  try { return join(realpathSync(existing), relative(existing, absolute)); } catch { return absolute; }
}

export const PORT = process.env.MAPPY_E2E_PORT ?? '9231';
/**
 * The vault a case may drive. `MAPPY_E2E_VAULT` names another generated vault (this checkout's `test-vault-<name>` for a
 * second instance, or another checkout's own test vault); cdp.mjs refuses one without the marker `prepare-test-vault`
 * leaves (AGENTS.md: 本番 Vault をテスト対象にしない).
 */
export const VAULT = resolveVault(process.env.MAPPY_E2E_VAULT);
/**
 * `MAPPY_E2E_VAULT` as a path: a relative one from the project, as `harness:prepare` and `harness:preflight` read it
 * (scripts/preflight.mjs's `harnessVault`), wherever the case runs from; unset, the project's `test-vault`.
 */
export function resolveVault(value) {
  return canonical(value ? resolve(root, value) : join(root, 'test-vault'));
}
/** `MAPPY_E2E_PROFILE` as a path, a relative one from the project (as `MAPPY_E2E_VAULT`), or null when unset. */
export const PROFILE = process.env.MAPPY_E2E_PROFILE ? canonical(resolve(root, process.env.MAPPY_E2E_PROFILE)) : null;
/** Seconds `MAPPY_E2E_WAIT` gives (default 1800); anything but a number of seconds is refused, not waited for ever. */
export function waitSeconds(value = process.env.MAPPY_E2E_WAIT) {
  if (value === undefined) return 1800;
  const seconds = Number(value);
  if (String(value).trim() === '' || !Number.isFinite(seconds) || seconds < 0) throw new Error(`MAPPY_E2E_WAIT must be a number of seconds, not ${JSON.stringify(value)}. No action taken.`);
  return seconds;
}
/** Ports `npm run harness:obsidian -- start` picks from (and the only ones `--port` takes): away from 9231 (the default) and 9222 (Kioku's). */
export const PORT_RANGE = [9241, 9299];

/**
 * `.tooling/e2e-instances/` in the primary checkout (handoff.mjs's `toolingDir`), the same place from every worktree.
 * Without git to find it, nothing is driven: a register of this checkout's own would not see the other worktrees'.
 */
export function lockDir() {
  if (process.env.MAPPY_E2E_LOCK_DIR) return resolve(process.env.MAPPY_E2E_LOCK_DIR);
  try { return join(toolingDir(root), 'e2e-instances'); } catch (error) {
    throw new Error(`Could not find the primary checkout with git (${error.message.split('\n')[0]}), so the register shared by every worktree is out of reach; set MAPPY_E2E_LOCK_DIR to it. No action taken.`);
  }
}

/** The run.mjs this process is a case of (`MAPPY_E2E_RUN`), only when that run is this process's parent. */
export function parentRun(env = process.env, ppid = process.ppid) {
  const run = Number(env.MAPPY_E2E_RUN);
  return Number.isInteger(run) && run > 0 && run === ppid ? run : null;
}

/**
 * `ps` in one fixed locale and time zone: `lstart` is printed in the caller's, and an entry written from a shell with
 * another `LANG` or `TZ` would otherwise read as a dead process's to everyone else.
 */
const psEnv = () => ({ ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' });

/**
 * When each of `pids` started (`ps -o lstart`), as a Map without the ones that are not running. An entry keeps its
 * process's start, so a pid the system has given to a new process since does not keep a dead entry alive. One `ps` for
 * all of them; nothing is signalled.
 */
export function processStarts(pids, { run = spawnSync } = {}) {
  const starts = new Map();
  if (pids.length === 0) return starts;
  const result = run('ps', ['-p', pids.join(','), '-o', 'pid=,lstart='], { encoding: 'utf8', env: psEnv() });
  // ps that did not run says nothing about the processes: every entry would read as dead (and be removed).
  if (result.error || result.status === null) throw new Error(`Could not run ps (${result.error?.message ?? result.signal}), so who holds the register cannot be read. No action taken.`);
  if (result.status !== 0 && result.stderr) {
    // One pid ps refuses (macOS: "process id too large") makes it print none of the others: ask for each one then.
    if (pids.length > 1) {
      for (const pid of pids) for (const [found, start] of processStarts([pid], { run })) starts.set(found, start);
      return starts;
    }
    // A pid no process can have is not running; any other refusal says nothing about the process (it may be running).
    if (/process id too large|invalid process id/iu.test(result.stderr)) return starts;
    throw new Error(`Could not run ps for pid ${pids[0]} (${result.stderr.trim()}), so who holds the register cannot be read. No action taken.`);
  }
  for (const line of (result.stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(\S.*?)\s*$/u.exec(line);
    if (match) starts.set(Number(match[1]), match[2]);
  }
  return starts;
}

const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && canonical(a) === canonical(b);
/** Vaults in entries, which `claimInstance` writes with their real paths (`canonical`): compared as text, each poll. */
const sameVault = (a, b) => typeof a === 'string' && a === b;

/**
 * Whether `other` keeps `mine` from starting. Two processes on one instance (port) or one vault would drive the same
 * window or the same files. A `solo` process acts on what every instance shares (the OS clipboard, the OS focus, an
 * Obsidian coming up or going away, frame times another instance's load would show in), so it runs with nothing else,
 * and nothing starts beside it. A run (run.mjs, `kind: 'run'`) holds its instance between its cases, so another run's
 * cases do not come in between; it drives nothing itself, so it keeps only its own instance and vault, and its own cases
 * pass it (`run`).
 */
export function blocks(mine, other) {
  if (mine.run != null && other.pid === mine.run) return false;
  const shares = (mine.port !== null && String(other.port) === String(mine.port)) || sameVault(other.vault, mine.vault);
  if (mine.kind === 'run' || other.kind === 'run') return shares;
  if (mine.solo || other.solo) return true;
  return shares;
}

/**
 * Of two `solo` entries waiting together, the earlier claim goes first (then the lower pid), so they do not both step
 * back for ever; the later one steps back while the earlier keeps its entry.
 */
export function before(a, b) {
  return a.claimedAt === b.claimedAt ? a.pid < b.pid : a.claimedAt < b.claimedAt;
}

/**
 * The entries of processes still running, other than `pid`'s. An entry that cannot be read is skipped. One of a process
 * that is gone (killed, so its exit did not remove it) is removed, if the file still holds what was read (a new process
 * with the same pid writes its own entry under that name).
 */
export function liveEntries(dir, pid = process.pid, { starts = processStarts } = {}) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const entries = [];
  for (const name of names) {
    if (!/^\d+\.json$/u.test(name)) continue;
    let text;
    let entry;
    try { text = readFileSync(join(dir, name), 'utf8'); entry = JSON.parse(text); } catch { continue; }
    if (entry && entry.pid !== pid && typeof entry.pid === 'number' && typeof entry.started === 'string') entries.push({ entry, file: join(dir, name), text });
  }
  const running = starts(entries.map(({ entry }) => entry.pid));
  return entries.filter(({ entry, file, text }) => {
    if (running.get(entry.pid) === entry.started) return true;
    try { if (readFileSync(file, 'utf8') === text) unlinkSync(file); } catch { /* gone already */ }
    return false;
  }).map(({ entry }) => entry);
}

export const describeEntry = entry => `${entry.kind === 'run' ? 'the run ' : ''}${entry.what} (pid ${entry.pid}, port ${entry.port ?? '—'}, ${entry.vault ?? 'no vault'}${entry.solo ? `, alone: ${entry.solo}` : ''})`;

let held = null;

/**
 * Enters this process for `port`/`vault` and waits until nothing in the register blocks it (`blocks`), up to `wait`
 * seconds; then it throws without having touched the instance. The entry is written before the others are read: of two
 * processes that come at once, each then sees the other and steps back (and tries again a moment later), so two never
 * both go. A waiting `solo` process keeps its entry (unless an earlier one waits too), so the processes that start
 * after it wait for it instead of going round it; not while a run of its instance or vault is in its way, though: that
 * run's next case would wait for the entry and the run for that case, and the two would wait each other out. The entry is removed when the process exits; one left by a process
 * that was killed is not counted (`liveEntries`). A process enters once: a later call hands back the same entry (before
 * anything else is read), and one asking to be `solo` after entering without it throws.
 */
export async function claimInstance(options = {}) {
  if (held) {
    if (options.solo && !held.entry.solo) throw new Error(`This process entered for ${describeEntry(held.entry)} without asking to run alone; ask on its first connect().`);
    // One process, one instance: a second instance would be driven without an entry of its own. A solo process runs with
    // nothing beside it, so it may drive more than one (parallel-focus.mjs drives two).
    const port = options.port === undefined ? PORT : options.port;
    const vault = options.vault === undefined ? VAULT : options.vault;
    const otherPort = held.entry.port !== null && port !== null && String(port) !== held.entry.port;
    const otherVault = held.entry.vault !== null && vault !== null && canonical(vault) !== held.entry.vault;
    if (!held.entry.solo && (otherPort || otherVault)) {
      throw new Error(`This process entered for ${describeEntry(held.entry)}, not port ${port} and ${vault}; one process drives one instance (unless it runs alone). No action taken.`);
    }
    return held;
  }
  const { port = PORT, vault = VAULT, solo = null, kind = 'case', what = whatRuns(), wait = waitSeconds(), dir = lockDir(), log = message => console.error(message), starts = processStarts, run = parentRun() } = options;
  if (!Number.isFinite(wait) || wait < 0) throw new Error(`wait must be a number of seconds, not ${wait}. No action taken.`);
  // An entry without its start would read as a dead process's to everyone else, and nothing would wait for it.
  const own = starts([process.pid]).get(process.pid);
  if (!own) throw new Error(`Could not read this process's start with ps, so it cannot enter the register in ${dir}. No action taken.`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${process.pid}.json`);
  const entry = { pid: process.pid, started: own, kind, run, port: port === null ? null : String(port), vault: vault === null ? null : canonical(vault), solo: solo || null, what, claimedAt: new Date().toISOString() };
  const deadline = Date.now() + Math.max(0, wait) * 1000;
  let told = 0;
  // Written to a name `liveEntries` does not read and renamed into place, so a reader never sees it half-written (a
  // waiting solo process writes its entry again each round).
  const write = () => { const temporary = `${file}.${process.pid}.tmp`; writeFileSync(temporary, `${JSON.stringify(entry)}\n`); renameSync(temporary, file); };
  for (;;) {
    write();
    let others;
    try { others = liveEntries(dir, process.pid, { starts }); } catch (error) { unlinkSync(file); throw error; }
    const blocking = others.filter(other => blocks(entry, other));
    if (blocking.length === 0) break;
    const keep = entry.solo && !blocking.some(other => other.kind === 'run') && !others.some(other => other.solo && before(other, entry));
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
    process.off('exit', release);
    try {
      if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) unlinkSync(file);
    } catch { /* already gone */ }
    held = null;
  };
  process.on('exit', release);
  // `watch`: what cdp.mjs has seen of the instance's windows for this entry (its connections share it; a reload reconnects).
  held = { file, entry, release, shared: [], watch: { on: null, seen: new Set(), urls: new Map(), mains: 0, pending: [], list: null, port: null, closed: false } };
  return held;
}

/** This process's entry while it holds one (case-runner.mjs writes it into the record), else null. */
export const heldEntry = () => held?.entry ?? null;

/** Leaves the register now rather than at exit (the tests; a process that drives nothing more). */
export const releaseInstance = () => { held?.release(); };

/**
 * Notes that this process did what only a `solo` one may (cdp.mjs sees a window it opened): `finish` fails the case's
 * record, so a case that should run alone and does not say so cannot pass, whether or not another instance ran beside it.
 */
export function noteShared(what) {
  if (held && !held.entry.solo) held.shared.push(what);
}

/** What this process did that only a `solo` one may (`noteShared`). */
export const sharedUses = () => [...(held?.shared ?? [])];

/** Whether cdp.mjs watches the windows this process opens (`watched`, or `not watched: <why>`), for the record. */
export function markWindowWatch(state) {
  if (held) held.windows = state;
}

/** A main window of an instance (a vault's), which a reload keeps under its target id. */
export const isMain = target => String(target?.url ?? '').startsWith('app://obsidian.md/index.html');
/** DevTools, which someone may open on the test Obsidian while a case runs: not a window the case opened. */
export const isDevtools = target => String(target?.url ?? '').startsWith('devtools://');
const mainCount = list => list.filter(target => target.type === 'page' && isMain(target)).length;
const sleep = ms => new Promise(resolve_ => { setTimeout(resolve_, ms); });

/**
 * Whether the new page target `id` is a window the case opened, read a moment after it is created (a target has no url
 * then; DevTools neither: artifacts/lev-327/devtools-probe.json, and parallel-focus.mjs's `devtools-has-no-url-at-first`).
 * DevTools is not; a main window only when there are more of them than at the start (a reload keeps its target); one
 * gone before it said what it was is not counted (it was not there long enough to be a window that took the focus).
 */
async function checkWindow(watch, id) {
  await sleep(300);
  const now = await watch.list().catch(() => []);
  const found = now.find(item => item.id === id);
  const target = { url: found?.url || watch.urls.get(id) || '' };
  if (!found && !target.url) return;
  if (isDevtools(target) || (isMain(target) && mainCount(now) <= watch.mains)) return;
  noteShared(`opened a window (${target.url || 'about:blank'}) on port ${watch.port}`);
}

/**
 * Watches the windows the instance opens for a process that did not ask to run alone: a popout or the settings window
 * takes the OS focus from every other instance's window (parallel-focus.mjs), so a case that opens one without saying
 * so fails (`noteShared`). The state is the entry's: every connection of the process shares it (a window is counted
 * once), and the first connection's windows were there before the case. With one besides the main window there at the
 * start (a popout left in the workspace comes back after a reload under a new target id, which would read as opened by
 * the case), the watch stays off, said once and in the record. A window that came while no connection was open (a
 * reload) is in the next connection's targets.
 */
export async function watchWindows({ socket, send, targets, port, list = () => fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()) }) {
  if (!held || held.entry.solo) return;
  const watch = held.watch;
  watch.port = port;
  watch.list = list;
  const pages = targets.filter(target => target.type === 'page');
  if (watch.on === null) {
    for (const target of pages) watch.seen.add(target.id);
    watch.mains = mainCount(pages);
    const left = pages.filter(target => !isMain(target) && !isDevtools(target)).length;
    watch.on = left === 0;
    markWindowWatch(watch.on ? 'watched' : `not watched: ${left} window(s) besides the main one were open before the case`);
    if (!watch.on) console.error(`${left} window(s) besides the main one were open on port ${port} before the case; windows it opens are not watched (docs/harness.md「専用の Obsidian を並べる」).`);
  } else if (watch.on) {
    for (const target of pages) {
      if (watch.seen.has(target.id)) continue;
      watch.seen.add(target.id);
      if (target.url) watch.urls.set(target.id, target.url);
      watch.pending.push(checkWindow(watch, target.id));
    }
  }
  socket.addEventListener('message', event => {
    if (!watch.on || watch.closed || typeof event.data !== 'string') return;
    // An event names its method first (`{"method":…`); a reply (a screenshot's megabytes) is never searched through.
    const head = event.data.slice(0, 64);
    const changed = head.includes('"Target.targetInfoChanged"');
    if (!changed && !head.includes('"Target.targetCreated"')) return;
    const info = JSON.parse(event.data).params?.targetInfo;
    if (info?.type !== 'page' || !info.targetId) return;
    if (info.url) watch.urls.set(info.targetId, info.url);
    if (changed || watch.seen.has(info.targetId)) return;
    watch.seen.add(info.targetId);
    watch.pending.push(checkWindow(watch, info.targetId));
  });
  await send('Target.setDiscoverTargets', { discover: true });
}

/**
 * Waits for the window checks until no more come (one may be added while it waits), then looks at the instance's
 * targets once more for a window no event told of (one opened after the case closed its connection), and closes the
 * watch: `finish` calls it before it judges the record.
 */
export async function settleWindowChecks() {
  const watch = held?.watch;
  if (!watch || watch.closed) return;
  const drain = async () => { for (let count = -1; count !== watch.pending.length;) { count = watch.pending.length; await Promise.allSettled(watch.pending.slice()); } };
  await drain();
  if (watch.on && watch.list) {
    const now = await watch.list().catch(() => []);
    for (const target of now) {
      if (target.type !== 'page' || watch.seen.has(target.id)) continue;
      watch.seen.add(target.id);
      if (target.url) watch.urls.set(target.id, target.url);
      watch.pending.push(checkWindow(watch, target.id));
    }
    await drain();
  }
  watch.closed = true;
}

/** What `markWindowWatch` said, or null (a solo process, or one that never reached a main window). */
export const windowWatch = () => held?.windows ?? null;

/** A shell word for `value`: single-quoted, with `'` written `'\\''`, so a path with a space or `$` stays one word. */
export const shellWord = value => `'${String(value).replaceAll("'", "'\\''")}'`;

/** The line `harness:obsidian -- start` prints for the cases to run against the instance it launched. */
export const exportLine = ({ port, vault, profile }) => `export MAPPY_E2E_PORT=${shellWord(port)} MAPPY_E2E_VAULT=${shellWord(vault)} MAPPY_E2E_PROFILE=${shellWord(profile)}`;

/**
 * Why `record` (a case's JSON read back by run.mjs) is not this run's: another instance's (its `instance` names another
 * port or vault; two runs given one `--json` folder write over each other's), or null when it is.
 */
export function otherInstance(record, { port = PORT, vault = VAULT } = {}) {
  const instance = record?.instance;
  if (!instance) return null;
  if (String(instance.port) !== String(port) || canonical(instance.vault) !== canonical(vault)) return `the JSON is the case's on port ${instance.port} with ${instance.vault}, not this run's (port ${port}, ${vault})`;
  return null;
}

/** The script and its flags, as the entry names who holds it. */
export function whatRuns(argv = process.argv) {
  return [basename(argv[1] ?? 'node'), ...argv.slice(2).filter(arg => arg.startsWith('--') && arg !== '--json' && arg !== '--shot')].join(' ');
}

/** `--port` of `harness:obsidian -- start`, if given, as one of PORT_RANGE: 9231 (the default) and 9222 (Kioku's) are never launched on. */
export function portFromFlag(given) {
  if (given === undefined) return null;
  const port = Number(given);
  if (!Number.isInteger(port) || port < PORT_RANGE[0] || port > PORT_RANGE[1]) {
    throw new Error(`--port must be in ${PORT_RANGE[0]}–${PORT_RANGE[1]}, not ${given}. No action taken.`);
  }
  return String(port);
}

export const OBSIDIAN_APP = process.env.MAPPY_E2E_OBSIDIAN_APP ?? '/Applications/Obsidian.app';

/** Launches Obsidian with `profile` and the CDP `port` (macOS `open -na`); throws when `open` fails. Used by start and E59. */
export function launchObsidian({ profile, port, app = OBSIDIAN_APP }) {
  const launched = spawnSync('open', ['-na', app, '--args', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { encoding: 'utf8' });
  if (launched.status !== 0) throw new Error(`open could not launch Obsidian (${launched.status}): ${launched.stderr || launched.error}`);
}

/** Script quitting the window's Obsidian after the evaluate has answered (`app.quit()`, no signal). */
export const QUIT = "setTimeout(() => require('electron').remote.app.quit(), 0);";

/** Whether the DevTools server on `port` answers (the instance is up). */
export const portAnswers = port => fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false);

/**
 * Whether nothing listens on 127.0.0.1:`port` (Obsidian's DevTools server binds there): nothing answers a connection
 * there (a listener on every address does; binding 127.0.0.1 alone can succeed beside it on macOS), and the port binds.
 */
export async function portFree(port) {
  const answered = await new Promise(resolve_ => {
    const socket = connectTcp({ port: Number(port), host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve_(true); });
    socket.once('error', () => resolve_(false));
  });
  if (answered) return false;
  return new Promise(resolve_ => {
    const server = createServer();
    server.once('error', () => resolve_(false));
    server.listen(Number(port), '127.0.0.1', () => server.close(() => resolve_(true)));
  });
}

/**
 * The first port in `range` that nothing listens on. `harness:obsidian` asks for it while it runs alone, so no case is
 * running then, and the only instances to keep clear of are the ones listening (an instance a case has quit to launch
 * again, E59's row 9, is held by that case's solo entry until it is back).
 */
export async function freePort({ range = PORT_RANGE, free = portFree } = {}) {
  for (let port = range[0]; port <= range[1]; port += 1) {
    if (await free(port)) return String(port);
  }
  throw new Error(`No free port in ${range[0]}–${range[1]}.`);
}

/**
 * The pid holding `profile`, from the `SingletonLock` link Chromium leaves in it (`<host>-<pid>`), or null. A second
 * launch with a profile in use only hands its arguments to the running one, which keeps its own port.
 */
export function profileHolder(profile, { starts = processStarts } = {}) {
  let target;
  try { target = readlinkSync(join(profile, 'SingletonLock')); } catch { return null; }
  const pid = Number(/-(\d+)$/u.exec(target)?.[1]);
  return Number.isInteger(pid) && pid > 0 && starts([pid]).has(pid) ? pid : null;
}

/** The everyday Obsidian's profile, which the harness neither reads nor launches. */
export const EVERYDAY_PROFILE = canonical(join(homedir(), 'Library', 'Application Support', 'obsidian'));
/** Whether `path` is (inside) the everyday profile, with links resolved. */
const isEveryday = (path, everyday) => { const real = canonical(path); const daily = canonical(everyday); return real === daily || isInside(daily, real); };
/** Whether `path` is inside `artifacts`, with links resolved. */
const inArtifacts = (path, artifacts) => isInside(canonical(artifacts), canonical(path));

/** The `--user-data-dir` of every running Obsidian process, read from `ps` (the arguments only). */
export function runningProfiles() {
  const result = spawnSync('ps', ['-axo', 'args='], { encoding: 'utf8', env: psEnv() });
  // ps that did not run would read as "no Obsidian has the vault open".
  if (result.error || result.status !== 0) throw new Error(`Could not run ps (${result.error?.message ?? result.stderr?.trim() ?? result.signal}), so which Obsidian has the vault open cannot be read. No action taken.`);
  const profiles = new Set();
  for (const line of (result.stdout ?? '').split('\n')) {
    if (!/Obsidian/u.test(line)) continue;
    const found = /--user-data-dir=(.+?)(?= --|$)/u.exec(line)?.[1];
    if (found) profiles.add(canonical(found.trim()));
  }
  return [...profiles];
}

/**
 * The running profiles whose `obsidian.json` opens `vault`: another Obsidian already has it open (this checkout's, or
 * another worktree's driving it through `MAPPY_E2E_VAULT`), and a second one would watch and write the same files. The
 * everyday profile is not read: it runs without `--user-data-dir` (its helpers name it) and is skipped by its path.
 */
export function profilesWithVault(vault, { profiles = runningProfiles(), everyday = EVERYDAY_PROFILE, read = path => readFileSync(path, 'utf8') } = {}) {
  const wanted = canonical(vault);
  return profiles.filter(profile => {
    if (isEveryday(profile, everyday)) return false;
    let list;
    try { list = JSON.parse(read(join(profile, 'obsidian.json'))); } catch { return false; }
    return Object.values(list?.vaults ?? {}).some(item => item?.open && typeof item.path === 'string' && canonical(item.path) === wanted);
  });
}

/**
 * The profile a case launches Obsidian again with after quitting it (E59's row 9): the one the window runs with
 * (`app.getPath('userData')`), so a second instance comes back as itself, not as another one's profile. Only a profile
 * inside this checkout's `artifacts/` is launched again, or the one `MAPPY_E2E_PROFILE` names; with `MAPPY_E2E_PROFILE`
 * set, a window that runs with another profile is refused. Both before anything is quit (never the everyday profile).
 */
export function relaunchProfile(running, expected = PROFILE, { artifacts = join(root, 'artifacts'), everyday = EVERYDAY_PROFILE, port = PORT } = {}) {
  if (typeof running !== 'string' || running === '') throw new Error('The window did not say which profile it runs with. No action taken.');
  if (expected !== null && !samePath(expected, running)) {
    throw new Error(`The Obsidian on port ${port} runs with the profile ${running}, not ${expected} (MAPPY_E2E_PROFILE). No action taken.`);
  }
  const refuse = why => new Error(`The Obsidian on port ${port} runs with the profile ${running}, ${why}; it is not quit and launched again. No action taken.`);
  if (isEveryday(running, everyday)) throw refuse("the everyday Obsidian's, which the harness never launches or quits");
  if (expected === null && !inArtifacts(running, artifacts)) throw refuse(`not one inside ${artifacts} (or MAPPY_E2E_PROFILE)`);
  return running;
}

/**
 * `path` if it is a profile the harness may launch and quit (start, stop, E59's relaunch): inside this checkout's
 * `artifacts/` with its links resolved, and never the everyday Obsidian's. Otherwise it throws.
 */
export function testProfile(path, { artifacts = join(root, 'artifacts'), everyday = EVERYDAY_PROFILE } = {}) {
  if (isEveryday(path, everyday)) throw new Error(`The profile ${path} is the everyday Obsidian's, which the harness never launches or quits. No action taken.`);
  if (!inArtifacts(path, artifacts)) throw new Error(`The profile must be inside ${artifacts}, not ${path}. No action taken.`);
  return path;
}

/** The flags each `harness:obsidian` command takes; any other is refused, so a misspelt one does not fall back to a default. */
const LAUNCHER_FLAGS = { start: ['--vault', '--port', '--profile'], stop: ['--vault', '--port'], list: [] };
export const LAUNCHER_USAGE = 'Usage: npm run harness:obsidian -- start [--vault <v>] [--port <n>] [--profile <p>] | stop [--vault <v>] [--port <n>] | list';

/**
 * `harness:obsidian`'s arguments as `{ command, values }`. Each flag once, with a value; `--port` (and, for stop, the
 * port it falls back to) only in PORT_RANGE, which is where start launches: 9231 and Kioku's 9222 are never driven.
 */
export function launcherArgs(argv, { fallbackPort = PORT, fallbackFrom = process.env.MAPPY_E2E_PORT === undefined ? 'the default port' : 'MAPPY_E2E_PORT' } = {}) {
  const [command, ...rest] = argv;
  if (!Object.hasOwn(LAUNCHER_FLAGS, command ?? '')) throw new Error(LAUNCHER_USAGE);
  const values = {};
  for (let at = 0; at < rest.length; at += 2) {
    const flag = rest[at];
    if (!LAUNCHER_FLAGS[command].includes(flag)) throw new Error(`${command} does not take ${flag}. ${LAUNCHER_USAGE}`);
    if (Object.hasOwn(values, flag)) throw new Error(`${flag} is given twice. No action taken.`);
    const given = rest[at + 1];
    if (given === undefined || given.startsWith('--')) throw new Error(`${flag} needs a value. No action taken.`);
    values[flag] = given;
  }
  if (values['--port'] !== undefined) values['--port'] = portFromFlag(values['--port']);
  if (command === 'stop' && values['--port'] === undefined) {
    try { values['--port'] = portFromFlag(fallbackPort); } catch {
      throw new Error(`stop was given no --port, and ${fallbackFrom} ${fallbackPort} is not in ${PORT_RANGE[0]}–${PORT_RANGE[1]}, where start launches: give --port or MAPPY_E2E_PORT. No action taken.`);
    }
  }
  return { command, values };
}
