/**
 * E86 (docs/harness.md「専用の Obsidian を並べる」, LEV-327): what the register's `solo` rules rest on, on two dedicated
 * Obsidian instances at once. A is `MAPPY_E2E_PORT`/`MAPPY_E2E_VAULT`, B is `MAPPY_E2E_PEER_PORT`/`MAPPY_E2E_PEER_VAULT`.
 * First seen once with probes (2026-10-07, Obsidian 1.13.7); a case so the next Obsidian or Electron is checked again.
 *
 * Rows (A is given the OS focus before each, then B does one thing, then A's focus is read):
 * 1. popout-takes-focus: B opens a popout window → A's window has lost the OS focus (why opening one is solo).
 * 2. settings-takes-focus: B opens the settings window → the same (1.13.7's settings window is a window of its own).
 * 3. reload-keeps-focus: B reloads its window (`app:reload`) → A keeps the focus (why reloading is not solo: E51, E63,
 *    E84, exit-draft-cut).
 * 4. target-created: on a page session of B with `Target.setDiscoverTargets`, B's popout arrives as `Target.targetCreated`
 *    of a page (what instance.mjs's `watchWindows` relies on to catch a case that opens a window without saying so).
 * 5. devtools-has-no-url-at-first: B's DevTools arrives as a page whose url is empty when it is created and `devtools://`
 *    in the list afterwards (why `watchWindows` reads a new window's url a moment later before it counts it).
 *
 * It takes A's focus and opens windows on B, so it runs alone (`solo`), and as a solo process it drives both instances.
 * Not in run.mjs (that runs on one instance). Each window it opens is closed again; B is back after its reload.
 *
 * Usage: MAPPY_E2E_PEER_PORT=<B> MAPPY_E2E_PEER_VAULT=<B's vault> npm run harness:e2e:parallel-focus -- [--json <out.json>]
 */
import { connect, PORT, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required, until } from './case-runner.mjs';
import { resolveVault } from './instance.mjs';

const { value } = parseArgs();
const PEER_PORT = process.env.MAPPY_E2E_PEER_PORT;
const PEER_VAULT = process.env.MAPPY_E2E_PEER_VAULT ? resolveVault(process.env.MAPPY_E2E_PEER_VAULT) : null;
if (!PEER_PORT || !PEER_VAULT || PEER_PORT === PORT) {
  console.error('E86 needs a second instance: MAPPY_E2E_PEER_PORT and MAPPY_E2E_PEER_VAULT, another port than MAPPY_E2E_PORT. Not run.');
  process.exit(2);
}

const record = createRecord(VAULT, null);
record.peer = { port: PEER_PORT, vault: PEER_VAULT };
const step = makeStep(record);
const check = makeCheck(record);
const a = await connect({ language: null, solo: 'takes the OS focus from one instance and opens windows on the other' });
let b = await connect({ port: PEER_PORT, vault: PEER_VAULT, language: null });

/** A made the OS's focused app and window (as a person clicking it would), then its focus as A's page and window see it. */
const focusA = async () => {
  await a.evaluate("(() => { require('electron').remote.app.focus({ steal: true }); return true; })()");
  await a.evaluate("(() => { require('electron').remote.getCurrentWindow().focus(); return true; })()");
  await wait(800);
  return focused();
};
const focused = async () => ({
  page: await a.evaluate('document.hasFocus()'),
  window: await a.evaluate("require('electron').remote.getCurrentWindow().isFocused()"),
});
const windowsOfB = () => b.evaluate("require('electron').remote.BrowserWindow.getAllWindows().length");
const list = () => fetch(`http://127.0.0.1:${PEER_PORT}/json/list`).then(response => response.json());

try {
  required(record, 'two-instances', await step('two-instances', async () => {
    const [vaultA, vaultB] = [await a.evaluate('app.vault.adapter.basePath'), await b.evaluate('app.vault.adapter.basePath')];
    if (vaultA === vaultB) throw new Error(`both instances have ${vaultA} open`);
    return { a: { port: PORT, vault: vaultA, windows: await a.evaluate("require('electron').remote.BrowserWindow.getAllWindows().length") }, b: { port: PEER_PORT, vault: vaultB, windows: await windowsOfB() } };
  }));

  await step('popout-takes-focus', async () => {
    const before = await focusA();
    // Closed from a timer, so the evaluate has answered before the window goes.
    await b.evaluate('(() => { window.__mappyE2EFocusLeaf = app.workspace.openPopoutLeaf(); return true; })()');
    await wait(1500);
    const after = await focused();
    await b.evaluate('(() => { const leaf = window.__mappyE2EFocusLeaf; window.__mappyE2EFocusLeaf = null; setTimeout(() => leaf?.detach(), 0); return true; })()');
    await until(async () => (await windowsOfB()) === 1, 5000, 'the popout of B did not close');
    check(before.page && before.window, `popout-takes-focus: A did not have the focus to begin with: ${JSON.stringify(before)}`);
    check(!after.page && !after.window, `popout-takes-focus: A kept the focus while B opened a popout: ${JSON.stringify(after)}`);
    return { before, after };
  });

  await step('settings-takes-focus', async () => {
    const before = await focusA();
    await b.evaluate('(() => { app.setting.open(); return true; })()');
    await wait(1500);
    const after = await focused();
    await b.evaluate('(() => { setTimeout(() => app.setting.close(), 0); return true; })()');
    await until(async () => (await windowsOfB()) === 1, 5000, 'the settings window of B did not close');
    check(before.page && before.window, `settings-takes-focus: A did not have the focus to begin with: ${JSON.stringify(before)}`);
    check(!after.page && !after.window, `settings-takes-focus: A kept the focus while B opened its settings window: ${JSON.stringify(after)}`);
    return { before, after };
  });

  await step('reload-keeps-focus', async () => {
    const before = await focusA();
    await b.evaluate("(() => { setTimeout(() => app.commands.executeCommandById('app:reload'), 50); return true; })()");
    b.close();
    await wait(1500);
    b = await until(async () => connect({ port: PEER_PORT, vault: PEER_VAULT, language: null }).catch(() => null), 30000, 'B did not come back from its reload');
    await until(async () => b.evaluate('!!app.workspace.layoutReady').catch(() => false), 30000, 'B did not finish loading after its reload');
    const after = await focused();
    check(before.page && before.window, `reload-keeps-focus: A did not have the focus to begin with: ${JSON.stringify(before)}`);
    check(after.page && after.window, `reload-keeps-focus: A lost the focus while B reloaded: ${JSON.stringify(after)}`);
    return { before, after };
  });

  await b.send('Target.setDiscoverTargets', { discover: true });
  const known = new Set((await list()).map(target => target.id));
  /** The page targets B's session hears of while `run` goes. */
  const created = async run => {
    const heard = [];
    const listening = (async () => {
      for (const end = Date.now() + 4000; Date.now() < end;) {
        try {
          const event = await b.once('Target.targetCreated', end - Date.now());
          if (event.targetInfo.type === 'page' && !known.has(event.targetInfo.targetId)) heard.push(event.targetInfo);
        } catch { break; }
      }
    })();
    await wait(200);
    await run();
    await listening;
    return heard;
  };

  await step('target-created', async () => {
    const heard = await created(() => b.evaluate('(() => { window.__mappyE2EFocusLeaf = app.workspace.openPopoutLeaf(); return true; })()'));
    await b.evaluate('(() => { const leaf = window.__mappyE2EFocusLeaf; window.__mappyE2EFocusLeaf = null; setTimeout(() => leaf?.detach(), 0); return true; })()');
    await until(async () => (await windowsOfB()) === 1, 5000, 'the popout of B did not close');
    for (const item of heard) known.add(item.targetId);
    check(heard.length === 1, `target-created: B's session heard ${heard.length} page target(s) for one popout: ${JSON.stringify(heard)}`);
    return { heard };
  });

  await step('devtools-has-no-url-at-first', async () => {
    const heard = await created(() => b.evaluate("(() => { require('electron').remote.getCurrentWebContents().openDevTools({ mode: 'detach' }); return true; })()"));
    await wait(500);
    const listed = (await list()).filter(target => heard.some(item => item.targetId === target.id)).map(target => ({ type: target.type, url: target.url.slice(0, 40) }));
    await b.evaluate("(() => { require('electron').remote.getCurrentWebContents().closeDevTools(); return true; })()");
    for (const item of heard) known.add(item.targetId);
    check(heard.length === 1 && heard[0].url === '', `devtools-has-no-url-at-first: DevTools was heard as ${JSON.stringify(heard)}, not one page with no url`);
    check(listed.length === 1 && listed[0].type === 'page' && listed[0].url.startsWith('devtools://'), `devtools-has-no-url-at-first: the list then showed ${JSON.stringify(listed)}`);
    return { heard, listed };
  });
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`stopped: ${error}`);
} finally {
  a.close();
  b.close();
}

process.exit(await finish(record, value('--json')));
