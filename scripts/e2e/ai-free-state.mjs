/**
 * docs/architecture.md §11.7 step 3 (LEV-273): on the real Obsidian, an unregistered Mappy reaches neither Node nor the
 * license server. Before the plugin loads, `window.require` is wrapped so each call that asks for `child_process`,
 * `fs`, `os` or `path` is recorded with its stack, and CDP's Network domain records the requests to the license
 * server's host. Obsidian's `requestUrl` sends from the main process (no CORS), so the renderer's Network domain may
 * never see it: the case also wraps `electron.ipcRenderer` (`send`, `sendSync`, `invoke`) and records each call whose
 * arguments name the license host, and before it reports, it sends one request of its own to that host through
 * `window.requestUrl` (the function Obsidian's `obsidian` module gives plugins; the host is `.invalid` and never
 * resolves) and fails unless the counter saw it.
 * A counter that cannot see `requestUrl` would report 0 whatever Mappy sent. Only what comes from Mappy counts: a call whose stack has a frame of Mappy's code (Obsidian evaluates
 * a plugin's main.js under the name `plugin:mappy`; seen on the real stack in LEV-326's first runs, and the first stacks
 * are kept in the record) and a request to the license host. Obsidian's and other plugins' calls are recorded beside
 * them and do not count; counting them would fail the case when Mappy touched nothing, and a case loosened for
 * that would miss a real leak too.
 *
 * Then the plugin is reloaded (so its `onload` runs under the wrap), a map is opened and edited, the settings tab is
 * opened on Mappy's page and closed, and both counts must be 0. A 0 only counts once the counters are shown to work
 * in this window: Mappy's own read of `mappy-ai-license` during the reload (wrapped `Storage.prototype.getItem`)
 * must carry a frame the Mappy pattern matches, so the frame name is checked on Mappy's real stack; a probe call to
 * `window.require` from a script named like Mappy's (a CDP evaluation with a `sourceURL`) must be counted; and the
 * license probe below must be seen. The Node count covers `window.require`, the one way §11.1 lets Mappy reach Node
 * (`loadNode()`); any other way is for the lint LEV-270 adds (`no-restricted-syntax` on `require`, §11.1) and the import test
 * (tests/tooling/ai-boundaries.test.mjs), not by this case.
 *
 * `--detect` (the check that the counting works; a 0 from a broken counter shows nothing): the vault must hold the
 * development unlock (`npm run harness:prepare:ai-dev`), AI is run once through the map with the person's real CLI
 * (`runAiOnce` below: one run of their subscription), and Mappy's Node calls must include `child_process`. A run that
 * did not end in a draft fails the case: it never reports PASS without having run AI.
 *
 * First native runs: LEV-326 (2026-10-07, Obsidian 1.13.7, artifacts/lev-326/). The frames of Mappy's own stack read
 * `plugin:mappy:<line>:<column>` there, as the pattern above expects.
 *
 * Usage: npm run harness:e2e:ai-free-state -- [--detect] [--json <out.json>] [--keep]
 */
import { readFile } from 'node:fs/promises';
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required, until } from './case-runner.mjs';
import { makeDeleteNote, makeOpenStep, makePress, makeSelect, refuseOpenLeaves, VIEW } from './dom-helpers.mjs';

const { flag, value } = parseArgs();
const detect = flag('--detect');

const NOTE = 'Fixtures/E2E-ai-free-state.md';
// `mappy: true` is what makes a note a map (src/core/embed.ts `readMapFromSource`); without it Mappy hands the leaf back
// to the Markdown view and the map has no node to edit (LEV-326: the first native run failed so, with `mappy-layout` alone).
const SOURCE = ['---', 'mappy: true', '---', '# 無料状態', '', '## 話題', '', '- 枝', ''].join('\n');
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
        (/plugin:mappy(?![\\w-])/u.test(stack) ? seen.mappy : seen.others).push({ name, stack: stack.split('\\n').slice(0, 8).join('\\n') });
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

/**
 * `--detect`: AI run once through the map as a person runs it (the AI button on 話題 → the question → ⌘↵ with the
 * engine the settings choose, a real CLI on the person's login), then 捨てる, so the note stays as the edit step left
 * it. The question is general and names nothing of the person's: it goes to their CLI (§11.3: no tools, an empty
 * working directory). Mappy's Node calls are read before and after the run; the check below is on the count after.
 */
const QUESTION = '良い睡眠のための習慣';
async function runAiOnce() {
  const select = makeSelect(cdp, evaluate);
  const press = makePress(cdp, evaluate);
  const card = () => evaluate(`${VIEW}
    const card = el.querySelector('.mappy-ai-card');
    return card && !card.hidden ? { phase: card.dataset.phase, text: card.textContent } : null;`);
  const nodeCalls = () => evaluate(`return window.__mappyAiFreeState.seen.mappy.map(call => call.name);`);
  const before = await nodeCalls();
  await select('話題');
  await press(`const node = el.querySelector('.mappy-ai-button:not([hidden])');`);
  await until(async () => (await card())?.phase === 'input', 3000, 'the AI input did not open');
  const engine = await evaluate(`${VIEW}
    el.querySelector('[data-ai-field="instruction"]').focus();
    return el.querySelector('[data-ai-field="engine"]')?.value ?? null;`);
  if (engine !== 'claude' && engine !== 'codex') throw new Error(`the input's engine is ${engine}, not a CLI`);
  await cdp.insertText(QUESTION);
  await wait(200);
  const started = Date.now();
  await cdp.realKey('Enter', 4);
  // Off the input: running, or already ended (a CLI not found fails at once, before a frame shows running).
  await until(async () => ['running', 'draft', 'failed'].includes((await card())?.phase), 5000, 'the run did not start');
  const end = await until(async () => {
    const now = await card();
    return now && (now.phase === 'draft' || now.phase === 'failed') ? now : null;
  }, 5 * 60_000, 'the AI run did not end');
  const ms = Date.now() - started;
  const labels = await evaluate(`${VIEW} return Array.from(el.querySelectorAll('.mappy-ai-draft'), item => item.textContent);`);
  if (end.phase === 'draft') {
    await press(`const node = Array.from(el.querySelectorAll('.mappy-ai-card button')).find(item => item.textContent === '捨てる');`);
    await until(async () => (await card()) === null, 3000, '捨てる did not close the card');
  }
  const after = await nodeCalls();
  if (end.phase !== 'draft') throw new Error(`the AI run ended in ${end.phase}: ${end.text}`);
  return { engine, question: QUESTION, ms, labels, nodeCallsBefore: before, nodeCallsAfter: after };
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
  // The frame pattern, checked on Mappy's own stack: its read of the license entry while it loaded. The development
  // unlock reads no store, so --detect shows the pattern on the Node calls it counts instead.
  if (!detect) required(record, 'frames', await step('frames', () => evaluate(`
    const reads = window.__mappyAiFreeState.licenseReads.slice();
    if (reads.length === 0) throw new Error('Mappy did not read mappy-ai-license while it loaded; the frames cannot be checked');
    const unmatched = reads.filter(stack => !/plugin:mappy(?![\\w-])/u.test(stack));
    if (unmatched.length > 0) throw new Error('frames of Mappy that do not match plugin:mappy: ' + unmatched[0]);
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
    // Read from the tab's own element: Obsidian 1.13.7 opens the settings in a window of their own (another document,
    // \`app.setting.win\`), where the main window's \`document\` finds nothing (LEV-326's first native run).
    const tab = app.setting.activeTab;
    const names = tab?.id === 'mappy' ? Array.from(tab.containerEl.querySelectorAll('.setting-item-name'), el => el.textContent) : [];
    app.setting.close();
    if (!names.includes('ライセンスコード') && !names.includes('License code')) throw new Error('the settings tab with the AI section was not shown: ' + JSON.stringify(names));
    return names;`)));
  if (detect) await step('run AI once', runAiOnce);
  const seen = await step('counts', () => evaluate(`
    const { seen, ipc } = window.__mappyAiFreeState;
    return { mappy: seen.mappy.length, others: seen.others.length, mappyNames: seen.mappy.map(call => call.name),
      mappyStacks: seen.mappy.slice(0, 3), otherStacks: seen.others.slice(0, 3),
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
    await cdp.evaluate("window.require('os'); 0\n//# sourceURL=plugin:mappy");
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
      // The page's own require (Electron's) has no 'obsidian': Obsidian hands that module to plugins only. It puts the
      // same function on the window: in 1.13.7's app.js the module's \`requestUrl\` and \`window.requestUrl\` are one (LEV-326).
      await window.requestUrl({ url: 'https://${LICENSE_HOST}/mappy-e2e-counter-probe', throw: false }).catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 500));
      return ipc.calls.length - before;`);
    const networkSeen = requests.filter(toLicense).length - before;
    if (ipcSeen + networkSeen < 1) throw new Error('a requestUrl to the license host was not counted by IPC nor Network: the license count would show nothing');
    return { ipcSeen, networkSeen };
  });
  if (detect) {
    // §11.7: what is shown is Mappy's taking of child_process, the module that starts the CLI.
    check(counted && seen.mappyNames.includes('child_process'), `--detect: Mappy's Node calls were ${JSON.stringify(seen?.mappyNames)}, expected child_process among them (the counter or the frame match is broken)`);
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
