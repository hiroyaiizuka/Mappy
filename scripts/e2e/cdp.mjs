/**
 * Connect to the dedicated verification Obsidian over CDP (docs/harness.md 実機検証).
 *
 * Adapted from the probes that used to be written once per ticket and left in `artifacts/`
 * (lev-48, lev-71, lev-72, lev-142). Those could not be re-run by the next session, which is how the
 * same failure shipped twice (LEV-142 → LEV-146); this file and the cases beside it are committed so
 * every session runs the same steps.
 *
 * The instance (port, vault, profile) comes from instance.mjs, overridable to run several side by side (LEV-327):
 *   MAPPY_E2E_PORT      CDP port (default 9231)
 *   MAPPY_E2E_VAULT     absolute path of the vault the window must have open (default: this project's test-vault)
 *   MAPPY_E2E_LANGUAGE  the app language the window must run in (default ja; LEV-226)
 * `connect()` enters the process in instance.mjs's register before it touches the window, so two runs never drive one
 * instance or one vault at once, and a case that acts on what every instance shares runs alone (`solo`).
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, claimInstance, noteShared, PORT, VAULT } from './instance.mjs';

export { PORT, VAULT };
/**
 * The plugin's text follows Obsidian's language (src/i18n: Japanese for `ja`, English otherwise), and the cases find
 * buttons and read notices by their Japanese text. A window in another language is refused rather than driven, so a
 * case never fails (or passes) on the wording instead of the behaviour. The English UI gets its own case (E63, LEV-235).
 */
export const LANGUAGE = process.env.MAPPY_E2E_LANGUAGE ?? 'ja';
/**
 * The language the window runs in, as `[loaded, stored, ready]`. `loaded` is the one Obsidian settled on at startup,
 * which is what `getLanguage()` gives the plugin; Obsidian sets moment's locale to it. moment says `en` until then too,
 * so it counts only once the workspace is ready, and a stored `language` key that names another language (changed
 * without a reload) refuses the window as well. An unset key is not English: Obsidian then takes the OS's language (a
 * new profile on a Japanese Mac starts in Japanese, LEV-235).
 */
export const APP_LANGUAGE = "[window.moment?.locale?.() ?? null, window.localStorage.getItem('language'), !!window.app?.workspace?.layoutReady]";

/** modifier bits of Input.dispatchKeyEvent: Alt=1, Ctrl=2, Meta=4, Shift=8 */
const KEYS = {
  F2: { code: 'F2', keyCode: 113 }, Escape: { code: 'Escape', keyCode: 27 },
  Enter: { code: 'Enter', keyCode: 13 }, Tab: { code: 'Tab', keyCode: 9 },
  Delete: { code: 'Delete', keyCode: 46 }, Backspace: { code: 'Backspace', keyCode: 8 },
  ' ': { code: 'Space', keyCode: 32 }, ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  z: { code: 'KeyZ', keyCode: 90 },
};

/**
 * With `popout`, the connection is to a popout window of our vault instead (E50): Obsidian opens one as an
 * `about:blank` page target of its own, with the same `app`, whose `document` is the popout's. The case marks
 * the popout's body with `data-mappy-e2e-popout="<popout>"` from the main window first, and only the window
 * carrying that mark is taken, so a second popout (or one another step left open) is never driven by mistake.
 * With `appless` as well, the popout has no `app` of its own to name its vault (Obsidian 1.14's settings window,
 * E72): the mark alone identifies it, so the case makes the mark its own run's (another vault's Obsidian may share the port).
 *
 * `language`: the language the window must run in (default `MAPPY_E2E_LANGUAGE`); E63, E69 and E71, which switch it (language.mjs), pass the
 * one they switched to, and `null` to take the window in whatever language it is (to put it back).
 *
 * `solo`: why the case acts on what every instance shares (the OS clipboard, the OS focus, an Obsidian quitting or
 * launching, frame times); it then waits until no other instance runs anything and holds the others back while it runs
 * (instance.mjs's `claimInstance`). Given on the case's first `connect()`: the process enters the register once.
 *
 * `port`, `vault`: the instance, `MAPPY_E2E_PORT`/`MAPPY_E2E_VAULT` unless given (`npm run harness:obsidian` passes the
 * one it launched). Only a generated vault is driven: the marker `prepare-test-vault` leaves is required.
 */
export async function connect({ popout, appless = false, language: expected = LANGUAGE, solo = null, port = PORT, vault: ours = VAULT } = {}) {
  if (!existsSync(join(ours, '.mappy-generated'))) {
    throw new Error(`${ours} is not a generated test vault (no .mappy-generated). Run npm run harness:prepare there first.`);
  }
  const { entry } = await claimInstance({ port, vault: ours, solo });
  // Several vault windows can share the port (another project's test vault in the same profile), and the
  // vault picker (`starter.html`) is a target too: take the index.html window whose vault is ours, and
  // refuse rather than drive someone else's vault.
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
  const pages = targets.filter(target => target.type === 'page'
    && (popout === undefined ? target.url.startsWith('app://obsidian.md/index.html') : target.url === 'about:blank'));
  if (pages.length === 0) throw new Error(`No Obsidian ${popout === undefined ? 'window' : 'popout window'} on port ${port}. See docs/harness.md 実機検証.`);

  const open = async target => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      socket.addEventListener('open', res, { once: true });
      socket.addEventListener('error', rej, { once: true });
    });
    let id = 0;
    const send = (method, params) => new Promise((resolve_, reject) => {
      const callId = ++id;
      const timeout = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error(`${method} timed out`)); }, 60000);
      const receive = event => {
        const message = JSON.parse(event.data);
        if (message.id !== callId) return;
        clearTimeout(timeout);
        socket.removeEventListener('message', receive);
        if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve_(message.result);
      };
      socket.addEventListener('message', receive);
      socket.send(JSON.stringify({ id: callId, method, params }));
    });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    return { socket, send, evaluate };
  };

  for (const page of pages) {
    const connection = await open(page);
    const vault = await connection.evaluate('app.vault.adapter.basePath').catch(() => null);
    const marked = popout === undefined
      || await connection.evaluate(`document.body?.dataset.mappyE2ePopout === ${JSON.stringify(String(popout))}`).catch(() => false);
    const other = typeof vault !== 'string' || canonical(vault) !== canonical(ours);
    if ((other && !(appless && popout !== undefined)) || !marked) { connection.socket.close(); continue; }
    const { socket, send, evaluate } = connection;
    // A popout shares its app (and language) with the main window: every case connects to that window first.
    // `language`: the cases that switch the app's language (E63, E69, E71) connect in the language they switched to.
    const [loaded, stored, ready] = popout === undefined && expected !== null ? await evaluate(APP_LANGUAGE) : [expected, null, true];
    // moment writes region variants in lower case (`zh-tw` for `zh-TW`).
    if (expected !== null && !ready) {
      socket.close();
      throw new Error(`The Obsidian for ${ours} is still loading (its language is not settled yet); retry once it has opened. No action taken.`);
    }
    if (expected !== null && ((loaded ?? '').toLowerCase() !== expected.toLowerCase() || (stored !== null && stored !== expected))) {
      socket.close();
      throw new Error(`The Obsidian for ${ours} runs in "${loaded}" (stored "${stored}"), not "${expected}" (MAPPY_E2E_LANGUAGE). `
        + `Set it in Settings → General → Language, or run localStorage.setItem('language', '${expected}'), then reload the app. No action taken.`);
    }
    // A window behind another (or a locked screen) stops requestAnimationFrame, and with it the map's layout
    // frames and every screenshot; keep it running while the case does its steps (LEV-64, LEV-72).
    await evaluate(`(() => { try { require('electron').remote.getCurrentWebContents().setBackgroundThrottling(false); return true; } catch { return false; } })()`);
    // A window the instance opens (a popout, the settings window) takes the OS focus from every other instance's window
    // (artifacts/lev-327/focus-probe*.json): a process that did not ask to run alone has it noted, and its record fails.
    if (popout === undefined && !entry.solo) {
      const known = new Set(targets.map(target => target.id));
      socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.method !== 'Target.targetCreated' || message.params?.targetInfo?.type !== 'page') return;
        if (known.has(message.params.targetInfo.targetId)) return;
        known.add(message.params.targetInfo.targetId);
        noteShared(`opened a window (${message.params.targetInfo.url || 'about:blank'}) on port ${port}`);
      });
      await send('Target.setDiscoverTargets', { discover: true });
    }
    return {
      send, evaluate, vault,
      /** The next CDP event named `method` (e.g. `Input.dragIntercepted`), or a rejection after `ms`. */
      once: (method, ms = 10000) => new Promise((resolve_, reject) => {
        const timeout = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error(`${method} did not arrive`)); }, ms);
        const receive = event => {
          const message = JSON.parse(event.data);
          if (message.method !== method) return;
          clearTimeout(timeout);
          socket.removeEventListener('message', receive);
          resolve_(message.params);
        };
        socket.addEventListener('message', receive);
      }),
      /**
       * A key as the keyboard sends it, so Obsidian's own keymap sees it (a synthesized keydown does not). With
       * `text` (`'\r'` for Enter) the key also types it, so the default action runs where nothing prevents it:
       * a textarea's line break on Shift+Enter (LEV-202). Without it no text is typed. `keyCode` replaces the key's own:
       * 229 is how Chromium marks a key an IME took while it composes (E01).
       */
      realKey: async (key, modifiers = 0, text, keyCode) => {
        const spec = KEYS[key];
        if (!spec) throw new Error(`Unknown key ${key}`);
        const code = keyCode ?? spec.keyCode;
        const base = { key, code: spec.code, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers };
        await send('Input.dispatchKeyEvent', text ? { type: 'keyDown', ...base, text, unmodifiedText: text } : { type: 'rawKeyDown', ...base });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      },
      /** Text as an IME commit delivers it (the input events fire). */
      insertText: text => send('Input.insertText', { text }),
      screenshot: async path => {
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await writeFile(path, Buffer.from(shot.data, 'base64'));
        return path;
      },
      close: () => { socket.close(); },
      /** Whether the socket is gone: a send on a closed socket is dropped, and the call would only wait out its timeout. */
      get closed() { return socket.readyState !== WebSocket.OPEN; },
    };
  }
  throw new Error(`No Obsidian ${popout === undefined ? 'window' : `popout window marked ${popout}`} for ${ours} on port ${port}. No action taken.`);
}

/** The plugin build the window is actually running, so a case cannot report on a stale install. */
export async function installedVersion(cdp) {
  return cdp.evaluate('app.plugins.plugins.mappy?.manifest?.version ?? null');
}

export const wait = ms => new Promise(resolve_ => setTimeout(resolve_, ms));
