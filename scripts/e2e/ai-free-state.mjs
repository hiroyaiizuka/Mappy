/**
 * docs/architecture.md §11.7 step 3 (LEV-273): on the real Obsidian, an unregistered Mappy reaches neither Node nor the
 * license server. Before the plugin loads, `window.require` is wrapped so each call that asks for `child_process`,
 * `fs`, `os` or `path` is recorded with its stack, and CDP's Network domain records the requests to the license
 * server's host. Obsidian's `requestUrl` sends from the main process (no CORS), so the renderer's Network domain may
 * never see it: the case also wraps `electron.ipcRenderer` (`send`, `sendSync`, `invoke`) and records each call whose
 * arguments name the license host, and before it reports, it sends one request of its own to that host through
 * Mappy's own license client (`entitlement.client.refresh`, which keeps no state; the host is `.invalid` and never
 * resolves), so the probe takes the very `requestUrl` Mappy's requests take (the `obsidian` module's, which the page's
 * own `require` cannot reach), and fails unless the counter saw it.
 * A counter that cannot see `requestUrl` would report 0 whatever Mappy sent. Only what comes from Mappy counts: a call whose stack has a frame of Mappy's code (Obsidian evaluates
 * a plugin's main.js under the name `plugin:mappy`, and the first stacks are kept in the record) and a request to the
 * license host. Obsidian's and other plugins' calls are recorded beside
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
 * development unlock (`npm run harness:prepare:ai-dev`), and the same steps run with the license active. Mappy takes
 * Node the first time the AI's availability is asked (the map's AI button, the settings' engine rows), within the steps
 * the free state counts: `child_process` must be among Mappy's calls counted by then, before AI is run. Then AI is run
 * once through the map with the person's real CLI (`runAiOnce` below: one run of their subscription), and the run must
 * start the engine's process through that `child_process` (the wrap hands Mappy's a watched copy that records each
 * `spawn`). A run that did not end in a draft fails the case: it never reports PASS without having run AI. The unlock
 * has no license client, so the license count and its probe are the free state's only.
 *
 * First native runs: LEV-326 (2026-10-07, Obsidian 1.13.7). A frame of Mappy's read of its license entry there was
 * `at Object.read (plugin:mappy:1:2760)`, which the pattern above matches.
 *
 * Usage: npm run harness:e2e:ai-free-state -- [--detect] [--json <out.json>] [--keep]
 */
import { readFile } from 'node:fs/promises';
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required, until } from './case-runner.mjs';
import { makeAiCard, makeDeleteNote, makeOpenStep, makePress, refuseOpenLeaves, VIEW } from './dom-helpers.mjs';

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

/** Script: wrap `window.require`, `Storage.prototype.getItem` and the IPC afresh; `window.__mappyAiFreeState` holds what they saw. */
const WRAP = `
  const modules = ${JSON.stringify(NODE_MODULES)};
  // A state left by a run that never restored it (or by an older version of this case) is taken off first, so the
  // wrap is always this one, installed once.
  const left = window.__mappyAiFreeState;
  if (left) {
    // Only what it holds: an older version kept no getItem, and putting back undefined would break localStorage.
    if (typeof left.original === 'function') window.require = left.original;
    if (typeof left.getItem === 'function') Storage.prototype.getItem = left.getItem;
    if (left.ipc) for (const [method, original] of Object.entries(left.ipc.originals)) left.ipc.ipc[method] = original;
    delete window.__mappyAiFreeState;
  }
  {
    // Mappy reads its license entry on load: those stacks show how Obsidian names Mappy's frames.
    const getItem = Storage.prototype.getItem;
    const licenseReads = [];
    Storage.prototype.getItem = function (key) {
      if (key === 'mappy-ai-license') licenseReads.push((new Error().stack ?? '').split('\\n').slice(0, 8).join('\\n'));
      return getItem.call(this, key);
    };
    const seen = { mappy: [], others: [], spawns: [] };
    const original = window.require;
    if (typeof original !== 'function') throw new Error('window.require is not a function in this window');
    window.require = function (name, ...rest) {
      if (!modules.includes(name)) return original.call(this, name, ...rest);
      // Recorded before the call: a call the original refuses (and Mappy catches) was still Mappy reaching for Node.
      const stack = new Error().stack ?? '';
      const mappy = /plugin:mappy(?![\\w-])/u.test(stack);
      (mappy ? seen.mappy : seen.others).push({ name, stack: stack.split('\\n').slice(0, 8).join('\\n') });
      const module = original.call(this, name, ...rest);
      // Mappy's child_process comes back watched (--detect ties the run to it): each spawn through it is recorded.
      if (!mappy || name !== 'child_process') return module;
      return new Proxy(module, {
        get: (target, key) => key !== 'spawn' ? Reflect.get(target, key) : (...args) => {
          // The file and the head of its arguments (the request goes on stdin, never in them).
          seen.spawns.push({ file: String(args[0]).split('/').pop(), args: Array.isArray(args[1]) ? args[1].slice(0, 4).map(String) : [], at: Date.now() });
          return target.spawn(...args);
        },
      });
    };
    window.__mappyAiFreeState = { seen, original, getItem, licenseReads };
  }
  {
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
  return true;`;

const requests = [];
cdp.onEvent('Network.requestWillBeSent', params => { requests.push(params.request.url); });

/**
 * `--detect`: AI run once through the map as a person runs it (the AI button on 話題 → the question → ⌘↵ with the
 * engine the settings choose, a real CLI on the person's login). The question is general and names nothing of the
 * person's: it goes to their CLI (§11.3: no tools, an empty working directory). However the run goes, the card is
 * ended before the case goes on: Escape on the input, else its last button (`makeAiCard`): 捨てる on the draft (the note
 * stays as the edit step left it), 閉じる on a failure, 取り消す on a run still going (one this case gave up on must not
 * keep the person's CLI busy). Ending it never hides why the run failed.
 */
const QUESTION = '良い睡眠のための習慣';
async function runAiOnce() {
  const press = makePress(cdp, evaluate);
  const ai = makeAiCard(cdp, evaluate, { press });
  const watched = () => evaluate(`const { seen } = window.__mappyAiFreeState; return { calls: seen.mappy.map(call => call.name), spawns: seen.spawns.slice() };`);
  let engine = null;
  let end = null;
  let labels = [];
  let started = Infinity;
  let ms = null;
  let failure = null;
  try {
    engine = await ai.open('話題');
    if (engine !== 'claude' && engine !== 'codex') throw new Error(`the input's engine is ${engine}, not a CLI`);
    await cdp.insertText(QUESTION);
    await wait(200);
    started = Date.now();
    await cdp.realKey('Enter', 4);
    // Off the input: running, or already ended (a CLI not found fails at once, before a frame shows running).
    await until(async () => ['running', 'draft', 'failed'].includes((await ai.card())?.phase), 5000, 'the run did not start');
    end = await until(async () => {
      const now = await ai.card();
      return now && (now.phase === 'draft' || now.phase === 'failed') ? now : null;
    }, 5 * 60_000, 'the AI run did not end');
    ms = Date.now() - started;
    labels = await ai.draft();
  } catch (error) {
    failure = error;
  }
  let closing = null;
  try {
    const shown = await ai.card();
    // Escape closes the input only from the card's own keys: the focus is put back in the request first.
    if (shown?.phase === 'input') {
      await evaluate(`${VIEW} el.querySelector('[data-ai-field="instruction"]')?.focus(); return true;`);
      await cdp.realKey('Escape');
    } else if (shown) await press(ai.last);
    if (shown) await until(async () => (await ai.card()) === null, 5000, `the ${shown.phase} card did not close`);
  } catch (error) {
    closing = String(error);
  }
  if (failure) throw new Error(closing ? `${failure} (ending its card: ${closing})` : String(failure));
  if (closing) throw new Error(closing);
  if (end.phase !== 'draft') throw new Error(`the AI run ended in ${end.phase}: ${end.text}`);
  // The draft shown on the map, read by its dotted nodes: a selector that no longer finds them would record no items
  // and pass on the card's phase alone.
  check(labels.length > 0, `--detect: the draft card was shown but no dotted node (.mappy-ai-draft) was found under 話題: ${end.text}`);
  // The run reached Node: the engine was started through the child_process Mappy took, after ⌘↵. Known by its
  // arguments, not the file's name: either CLI may be started as node with its script (§11.3, launch.ts), or by a path
  // of another name set in the settings. claude runs as `-p`, codex as `exec`.
  const after = await watched();
  const mode = engine === 'claude' ? '-p' : 'exec';
  const spawned = after.spawns.filter(item => item.at >= started && item.args.includes(mode));
  if (spawned.length === 0) throw new Error(`the run started no ${engine} process (${mode}) through the child_process Mappy took: ${JSON.stringify(after.spawns)}`);
  return { engine, question: QUESTION, ms, labels, spawned, nodeCalls: after.calls };
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
    if (!names.includes('ライセンスコード') && !names.includes('License code')) throw new Error('the settings tab with the AI section was not shown (active tab: ' + (tab?.id ?? 'none') + '): ' + JSON.stringify(names));
    return names;`)));
  if (detect) {
    // Within the steps the free state counts (reload, open, edit, settings), before AI is run: Mappy's child_process.
    const before = required(record, 'Node calls before the run', await step('Node calls before the run', () => evaluate(`return window.__mappyAiFreeState.seen.mappy.map(call => call.name);`)));
    if (!before.includes('child_process')) {
      record.failures.push(`--detect: within the free state's steps Mappy's Node calls were ${JSON.stringify(before)}, expected child_process among them (the counter or the frame match is broken)`);
      // A run would show nothing more and spend one of the person's runs: stop before it.
      record.stopped = 'the counter did not see Mappy take child_process; AI was not run';
      throw new StopCase(record.stopped);
    }
    await step('run AI once', runAiOnce);
  }
  const seen = await step('counts', () => evaluate(`
    const { seen, ipc } = window.__mappyAiFreeState;
    return { mappy: seen.mappy.length, others: seen.others.length, mappyNames: seen.mappy.map(call => call.name), spawns: seen.spawns.length,
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
  // The counter's own check (the free state's: the unlock has no license client): one request to the license host
  // through Mappy's own client must be seen.
  const probe = detect ? null : await step('counter sees requestUrl', async () => {
    const before = requests.filter(toLicense).length;
    const ipcSeen = await evaluate(`
      const { ipc } = window.__mappyAiFreeState;
      // Mappy's own client (\`createLicenseClient\`), so the probe takes the very requestUrl Mappy's requests take: the
      // obsidian module's, which the page's own require (Electron's) cannot reach. Its refresh only posts and keeps no
      // state; the .invalid host never answers, so it rejects.
      const client = app.plugins.plugins.mappy?.entitlement?.client;
      if (typeof client?.refresh !== 'function') throw new Error('Mappy\\'s license client is not reachable; the probe cannot take its requestUrl');
      const before = ipc.calls.length;
      await client.refresh('mappy-e2e-counter-probe', 'mappy-e2e-counter-probe').catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 500));
      return ipc.calls.length - before;`);
    const networkSeen = requests.filter(toLicense).length - before;
    if (ipcSeen + networkSeen < 1) throw new Error('a requestUrl to the license host was not counted by IPC nor Network: the license count would show nothing');
    return { ipcSeen, networkSeen };
  });
  if (!detect) {
    check(counted && seen.mappy === 0, `Mappy reached Node ${seen?.mappy} times in the free state`);
    check(licenseCalls === 0, `Mappy sent ${licenseCalls} requests to ${LICENSE_HOST} in the free state (IPC and Network)`);
    check(probe !== null && typeof probe === 'object' && !('error' in probe), 'the license counter could not be shown to see requestUrl; its 0 shows nothing');
  }
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
