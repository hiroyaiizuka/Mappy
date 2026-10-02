/**
 * docs/architecture.md §11.7 step 3 (LEV-273): on the real Obsidian, an unregistered Mappy reaches neither Node nor the
 * license server. Before the plugin loads, `window.require` is wrapped so each call that asks for `child_process`,
 * `fs`, `os` or `path` is recorded with its stack, and CDP's Network domain records the requests to the license
 * server's host. Obsidian's `requestUrl` sends from the main process (no CORS), so the renderer's Network domain may
 * never see it: the case also wraps `electron.ipcRenderer` (`send`, `sendSync`, `invoke`) and records each call whose
 * arguments name the license host, and before it reports, it sends one request of its own to that host through
 * `require('obsidian').requestUrl` (the host is `.invalid` and never resolves) and fails unless the counter saw it.
 * A counter that cannot see `requestUrl` would report 0 whatever Mappy sent. Only what comes from Mappy counts: a call whose stack has a frame of Mappy's code (Obsidian evaluates
 * a plugin's main.js under the name `plugin:mappy`; NOT YET CONFIRMED on a real stack, which is why the first stacks
 * are kept in the record) and a request to the license host. Obsidian's and other plugins' calls are recorded beside
 * them and do not count; counting them would fail the case when Mappy touched nothing, and a case loosened for
 * that would miss a real leak too.
 *
 * Then the plugin is reloaded (so its `onload` runs under the wrap), a map is opened and edited, the settings tab is
 * opened on Mappy's page and closed, and both counts must be 0. A 0 only counts once the counters are shown to work
 * in this window: Mappy's own read of `mappy-ai-license` during the reload (wrapped `Storage.prototype.getItem`)
 * must carry a frame the Mappy pattern matches, so the frame name is checked on Mappy's real stack; a probe call to
 * `window.require` from a script named like Mappy's (a CDP evaluation with a `sourceURL`) must be counted; and the
 * license probe below must be seen.
 *
 * `--detect` (the check that the counting works; a 0 from a broken counter shows nothing): the vault must hold the
 * development unlock (`npm run harness:prepare:ai-dev`), AI is run once, and the Node count must be 1 or more. Running
 * AI needs LEV-270's runner and LEV-271's button, which are not on this branch yet: until whichever of the three
 * merges last wires them (§11.8) and fills in `runAiOnce` below, `--detect` stops with FAIL and says so. It never
 * reports PASS without having run AI.
 *
 * NOT RUN YET (2026-10-02): the real Obsidian is kept for LEV-270's first check (§11.8). Record the first run in
 * artifacts/ with the stacks it kept.
 *
 * Usage: npm run harness:e2e:ai-free-state -- [--detect] [--json <out.json>] [--keep]
 */
import { readFile } from 'node:fs/promises';
import { connect, VAULT } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { makeDeleteNote, makeOpenStep, refuseOpenLeaves, VIEW } from './dom-helpers.mjs';

const { flag, value } = parseArgs();
const detect = flag('--detect');

const NOTE = 'Fixtures/E2E-ai-free-state.md';
const SOURCE = ['---', 'mappy-layout: mindmap', '---', '# 無料状態', '', '## 話題', '', '- 枝', ''].join('\n');
const NODE_MODULES = ['child_process', 'fs', 'os', 'path'];

/** The license server's host, read from the client the build was made from, so the case follows the contract. */
const client = await readFile(new URL('../../src/ai/license/client.ts', import.meta.url), 'utf8');
const server = client.match(/export const LICENSE_SERVER = '([^']+)'/u)?.[1];
if (!server) throw new Error('LICENSE_SERVER was not found in src/ai/license/client.ts');
const LICENSE_HOST = new URL(server).host;

const record = createRecord(VAULT, NOTE);
record.mode = detect ? 'detect (ai-dev build, AI run once)' : 'free (release build, unregistered)';
record.licenseHost = LICENSE_HOST;
const cdp = await connect({ build: detect ? 'ai-dev' : 'release' });
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);

/** Script: wrap `window.require` once per page; `window.__mappyAiFreeState` holds what it saw. */
const WRAP = `
  const modules = ${JSON.stringify(NODE_MODULES)};
  if (!window.__mappyAiFreeState) {
    // Mappy reads its license entry on load: those stacks show how Obsidian names Mappy's frames.
    const getItem = Storage.prototype.getItem;
    const licenseReads = [];
    Storage.prototype.getItem = function (key) {
      if (key === 'mappy-ai-license') licenseReads.push((new Error().stack ?? '').split('\\n').slice(0, 8).join('\\n'));
      return getItem.call(this, key);
    };
    const seen = { mappy: [], others: [] };
    const original = window.require;
    if (typeof original !== 'function') throw new Error('window.require is not a function in this window');
    window.require = function (name, ...rest) {
      if (modules.includes(name)) {
        const stack = new Error().stack ?? '';
        (/plugin:mappy/u.test(stack) ? seen.mappy : seen.others).push({ name, stack: stack.split('\\n').slice(0, 8).join('\\n') });
      }
      return original.call(this, name, ...rest);
    };
    window.__mappyAiFreeState = { seen, original, getItem, licenseReads };
  }
  if (!window.__mappyAiFreeState.ipc) {
    const ipc = require('electron').ipcRenderer;
    const calls = [];
    const originals = {};
    for (const method of ['send', 'sendSync', 'invoke']) {
      originals[method] = ipc[method];
      ipc[method] = function (...args) {
        let text = '';
        try { text = JSON.stringify(args); } catch { text = String(args); }
        if (text.includes(${JSON.stringify(LICENSE_HOST)})) calls.push({ method, at: Date.now(), text: text.slice(0, 300) });
        return originals[method].apply(this, args);
      };
    }
    window.__mappyAiFreeState.ipc = { ipc, calls, originals };
  }
  window.__mappyAiFreeState.seen.mappy.length = 0;
  window.__mappyAiFreeState.seen.others.length = 0;
  window.__mappyAiFreeState.ipc.calls.length = 0;
  window.__mappyAiFreeState.licenseReads.length = 0;
  return true;`;

const requests = [];
cdp.onEvent('Network.requestWillBeSent', params => { requests.push(params.request.url); });

/** Fills in once LEV-270 and LEV-271 are wired (§11.8): run AI once on the selected node and wait for its end. */
async function runAiOnce() {
  throw new Error('AI cannot be run on this branch yet: LEV-270 (runner) and LEV-271 (AI button) are not wired (§11.8)');
}

try {
  required(record, 'preconditions', await step('preconditions', async () => {
    await evaluate(`${refuseOpenLeaves([NOTE])} return true;`);
    const text = await evaluate(`return window.localStorage.getItem('mappy-ai-license');`);
    let stored = null;
    try { stored = text === null ? null : JSON.parse(text); } catch { stored = null; }
    // A device ID alone (a registration that never got an answer) is still the free state; a refresh secret is not.
    const registered = Boolean(stored && (stored.refreshSecret || stored.rejected));
    if (!detect && registered) throw new Error('this device has a registered license (mappy-ai-license); the free state needs none. Remove it in the test profile first.');
    return { stored: stored ? Object.keys(stored) : null };
  }));
  required(record, 'network', await step('network', async () => { await cdp.send('Network.enable', {}); return true; }));
  required(record, 'wrap', await step('wrap', () => evaluate(WRAP)));
  required(record, 'reload', await step('reload', () => evaluate(`
    if (document.querySelector('.mappy-inline-input')) throw new Error('A draft is open in this window');
    await app.plugins.disablePlugin('mappy'); await app.plugins.enablePlugin('mappy');
    await new Promise(resolve => setTimeout(resolve, 800));
    const plugin = app.plugins.plugins.mappy;
    if (!plugin) throw new Error('Mappy did not load again');
    // The stored token is verified asynchronously after onload (checking → unregistered).
    for (let waited = 0; plugin.entitlement?.state?.().kind === 'checking' && waited < 5000; waited += 100) await new Promise(resolve => setTimeout(resolve, 100));
    const license = plugin.entitlement?.state?.() ?? null;
    if (${JSON.stringify(!detect)} && license?.kind !== 'unregistered') throw new Error('Mappy is not in the free state: ' + JSON.stringify(license));
    return { version: plugin.manifest.version, license };`)));
  // The frame pattern, checked on Mappy's own stack: its read of the license entry while it loaded.
  required(record, 'frames', await step('frames', () => evaluate(`
    const reads = window.__mappyAiFreeState.licenseReads.slice();
    if (reads.length === 0) throw new Error('Mappy did not read mappy-ai-license while it loaded; the frames cannot be checked');
    const unmatched = reads.filter(stack => !/plugin:mappy/u.test(stack));
    if (unmatched.length > 0) throw new Error('frames of Mappy that do not match /plugin:mappy/: ' + unmatched[0]);
    return { reads: reads.length, sample: reads[0] };`)));
  required(record, 'open', await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE })));
  required(record, 'edit', await step('edit', () => evaluate(`${VIEW}
    const node = nth('話題', 0);
    if (!node) throw new Error('no node 話題');
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 300));
    const editor = input();
    if (!editor) throw new Error('Tab opened no title editor');
    editor.value = '子'; editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 500));
    if (!(await source()).includes('子')) throw new Error('the new child did not reach the note');
    return true;`)));
  required(record, 'settings', await step('settings', () => evaluate(`
    app.setting.open(); app.setting.openTabById('mappy');
    await new Promise(resolve => setTimeout(resolve, 500));
    const names = Array.from(document.querySelectorAll('.vertical-tab-content .setting-item-name'), el => el.textContent);
    app.setting.close();
    if (!names.includes('ライセンスコード')) throw new Error('the settings tab with the AI section was not shown: ' + JSON.stringify(names));
    return names;`)));
  if (detect) await step('run AI once', runAiOnce);
  const seen = await step('counts', () => evaluate(`
    const { seen, ipc } = window.__mappyAiFreeState;
    return { mappy: seen.mappy.length, others: seen.others.length, mappyStacks: seen.mappy.slice(0, 3), otherStacks: seen.others.slice(0, 3),
      licenseIpc: ipc.calls.slice() };`));
  const toLicense = url => { try { return new URL(url).host === LICENSE_HOST; } catch { return false; } };
  const licenseRequests = requests.filter(toLicense);
  record.licenseRequests = licenseRequests;
  /** A step's own result, not its recorded error. */
  const counted = seen !== null && typeof seen === 'object' && !('error' in seen);
  const licenseCalls = (counted ? seen.licenseIpc.length : NaN) + licenseRequests.length;
  // The Node counter's own check: a window.require call from a script named like Mappy's must be counted.
  const nodeProbe = await step('counter sees window.require', async () => {
    const before = await evaluate(`return window.__mappyAiFreeState.seen.mappy.length;`);
    await cdp.evaluate("window.require('os'); 0\n//# sourceURL=plugin:mappy-e2e-counter-probe");
    const after = await evaluate(`return window.__mappyAiFreeState.seen.mappy.length;`);
    if (after - before !== 1) throw new Error('a window.require call from a Mappy-named script was not counted');
    return true;
  });
  // The counter's own check: one request to the license host through Obsidian's requestUrl must be seen.
  const probe = await step('counter sees requestUrl', async () => {
    const before = requests.filter(toLicense).length;
    const ipcSeen = await evaluate(`
      const { ipc } = window.__mappyAiFreeState;
      const before = ipc.calls.length;
      await require('obsidian').requestUrl({ url: 'https://${LICENSE_HOST}/mappy-e2e-counter-probe', throw: false }).catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 500));
      return ipc.calls.length - before;`);
    const networkSeen = requests.filter(toLicense).length - before;
    if (ipcSeen + networkSeen < 1) throw new Error('a requestUrl to the license host was not counted by IPC nor Network: the license count would show nothing');
    return { ipcSeen, networkSeen };
  });
  if (detect) {
    check(counted && seen.mappy >= 1, `--detect: Mappy's Node calls were ${seen?.mappy}, expected 1 or more (the counter or the frame match is broken)`);
  } else {
    check(counted && seen.mappy === 0, `Mappy reached Node ${seen?.mappy} times in the free state`);
    check(licenseCalls === 0, `Mappy sent ${licenseCalls} requests to ${LICENSE_HOST} in the free state (IPC and Network)`);
  }
  check(probe !== null && typeof probe === 'object' && !('error' in probe), 'the license counter could not be shown to see requestUrl; its 0 shows nothing');
  check(nodeProbe === true, 'the Node counter could not be shown to count Mappy-named calls; its 0 shows nothing');
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(String(error));
} finally {
  await evaluate(`
    const state = window.__mappyAiFreeState;
    if (state) {
      window.require = state.original;
      Storage.prototype.getItem = state.getItem;
      if (state.ipc) for (const [method, original] of Object.entries(state.ipc.originals)) state.ipc.ipc[method] = original;
      delete window.__mappyAiFreeState;
    }
    return true;`).catch(() => undefined);
  await cdp.send('Network.disable', {}).catch(() => undefined);
  if (!flag('--keep')) await step('cleanup', makeDeleteNote(evaluate, NOTE));
}

process.exitCode = await finish(record, value('--json'));
cdp.close();
