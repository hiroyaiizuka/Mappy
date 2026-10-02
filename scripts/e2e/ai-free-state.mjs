/**
 * docs/architecture.md §11.7 step 3 (LEV-273): on the real Obsidian, an unregistered Mappy reaches neither Node nor the
 * license server. Before the plugin loads, `window.require` is wrapped so each call that asks for `child_process`,
 * `fs`, `os` or `path` is recorded with its stack, and CDP's Network domain records the requests to the license
 * server's host. Only what comes from Mappy counts: a call whose stack has a frame of Mappy's code (Obsidian evaluates
 * a plugin's main.js under the name `plugin:mappy`; NOT YET CONFIRMED on a real stack, which is why the first stacks
 * are kept in the record) and a request to the license host. Obsidian's and other plugins' calls are recorded beside
 * them and do not count; counting them would fail the case when Mappy touched nothing, and a case loosened for
 * that would miss a real leak too.
 *
 * Then the plugin is reloaded (so its `onload` runs under the wrap), a map is opened and edited, the settings tab is
 * opened on Mappy's page and closed, and both counts must be 0.
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
    window.__mappyAiFreeState = { seen, original };
  }
  window.__mappyAiFreeState.seen.mappy.length = 0;
  window.__mappyAiFreeState.seen.others.length = 0;
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
    const license = await evaluate(`return window.localStorage.getItem('mappy-ai-license');`);
    if (!detect && license !== null) throw new Error('this device has a stored license (mappy-ai-license); the free state needs none. Remove it in the test profile first.');
    return { storedLicense: license !== null };
  }));
  required(record, 'network', await step('network', async () => { await cdp.send('Network.enable', {}); return true; }));
  required(record, 'wrap', await step('wrap', () => evaluate(WRAP)));
  required(record, 'reload', await step('reload', () => evaluate(`
    if (document.querySelector('.mappy-inline-input')) throw new Error('A draft is open in this window');
    await app.plugins.disablePlugin('mappy'); await app.plugins.enablePlugin('mappy');
    await new Promise(resolve => setTimeout(resolve, 800));
    const plugin = app.plugins.plugins.mappy;
    if (!plugin) throw new Error('Mappy did not load again');
    return { version: plugin.manifest.version, license: plugin.entitlement?.state?.() ?? null };`)));
  required(record, 'open', await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE })));
  await step('edit', () => evaluate(`${VIEW}
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
    return (await source()).includes('子');`));
  await step('settings', () => evaluate(`
    app.setting.open(); app.setting.openTabById('mappy');
    await new Promise(resolve => setTimeout(resolve, 500));
    const names = Array.from(document.querySelectorAll('.vertical-tab-content .setting-item-name'), el => el.textContent);
    app.setting.close();
    return names;`));
  if (detect) await step('run AI once', runAiOnce);
  const seen = await step('counts', () => evaluate(`
    const { seen } = window.__mappyAiFreeState;
    return { mappy: seen.mappy.length, others: seen.others.length, mappyStacks: seen.mappy.slice(0, 3), otherStacks: seen.others.slice(0, 3) };`));
  const licenseRequests = requests.filter(url => { try { return new URL(url).host === LICENSE_HOST; } catch { return false; } });
  record.licenseRequests = licenseRequests;
  if (detect) {
    check(seen && !('error' in seen) && seen.mappy >= 1, `--detect: Mappy's Node calls were ${seen?.mappy}, expected 1 or more (the counter or the frame match is broken)`);
  } else {
    check(seen && !('error' in seen) && seen.mappy === 0, `Mappy reached Node ${seen?.mappy} times in the free state`);
    check(licenseRequests.length === 0, `Mappy sent ${licenseRequests.length} requests to ${LICENSE_HOST} in the free state`);
  }
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(String(error));
} finally {
  await evaluate(`
    const state = window.__mappyAiFreeState;
    if (state) { window.require = state.original; delete window.__mappyAiFreeState; }
    return true;`).catch(() => undefined);
  await cdp.send('Network.disable', {}).catch(() => undefined);
  if (!flag('--keep')) await step('cleanup', makeDeleteNote(evaluate, NOTE));
}

process.exitCode = await finish(record, value('--json'));
cdp.close();
