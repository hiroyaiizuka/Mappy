/**
 * Connect to the dedicated verification Obsidian over CDP (docs/harness.md 実機検証).
 *
 * Adapted from the probes that used to be written once per ticket and left in `artifacts/`
 * (lev-48, lev-71, lev-72, lev-142). Those could not be re-run by the next session, which is how the
 * same failure shipped twice (LEV-142 → LEV-146); this file and the cases beside it are committed so
 * every session runs the same steps.
 *
 * The port and the vault are the ones the harness document names, overridable for a second instance:
 *   MAPPY_E2E_PORT   CDP port (default 9231)
 *   MAPPY_E2E_VAULT  absolute path of the vault the window must have open (default: this project's test-vault)
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PORT = process.env.MAPPY_E2E_PORT ?? '9231';
/**
 * The vault a case may drive. `MAPPY_E2E_VAULT` is for a second checkout's own test vault, not for a vault
 * with anything in it: the marker `prepare-test-vault` leaves is required, so a case that writes and deletes
 * notes can only reach a generated one (AGENTS.md: 本番 Vault をテスト対象にしない).
 */
export const VAULT = process.env.MAPPY_E2E_VAULT ?? resolve(root, 'test-vault');
if (!existsSync(join(VAULT, '.mappy-generated'))) {
  throw new Error(`${VAULT} is not a generated test vault (no .mappy-generated). Run npm run harness:prepare there first.`);
}

/** modifier bits of Input.dispatchKeyEvent: Alt=1, Ctrl=2, Meta=4, Shift=8 */
const KEYS = {
  F2: { code: 'F2', keyCode: 113 }, Escape: { code: 'Escape', keyCode: 27 },
  Enter: { code: 'Enter', keyCode: 13 }, Tab: { code: 'Tab', keyCode: 9 },
  Delete: { code: 'Delete', keyCode: 46 }, Backspace: { code: 'Backspace', keyCode: 8 },
  ' ': { code: 'Space', keyCode: 32 }, ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  z: { code: 'KeyZ', keyCode: 90 },
};

export async function connect() {
  // Several vault windows can share the port (another project's test vault in the same profile), and the
  // vault picker (`starter.html`) is a target too: take the index.html window whose vault is ours, and
  // refuse rather than drive someone else's vault.
  const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(response => response.json());
  const pages = targets.filter(target => target.type === 'page' && target.url.startsWith('app://obsidian.md/index.html'));
  if (pages.length === 0) throw new Error(`No Obsidian window on port ${PORT}. See docs/harness.md 実機検証.`);

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
    if (vault !== VAULT) { connection.socket.close(); continue; }
    const { socket, send, evaluate } = connection;
    // A window behind another (or a locked screen) stops requestAnimationFrame, and with it the map's layout
    // frames and every screenshot; keep it running while the case does its steps (LEV-64, LEV-72).
    await evaluate(`(() => { try { require('electron').remote.getCurrentWebContents().setBackgroundThrottling(false); return true; } catch { return false; } })()`);
    return {
      send, evaluate, vault,
      /** A key as the keyboard sends it, so Obsidian's own keymap sees it (a synthesized keydown does not). */
      realKey: async (key, modifiers = 0) => {
        const spec = KEYS[key];
        if (!spec) throw new Error(`Unknown key ${key}`);
        const base = { key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode, modifiers };
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
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
    };
  }
  throw new Error(`No Obsidian window for ${VAULT} on port ${PORT}. No action taken.`);
}

/** The plugin build the window is actually running, so a case cannot report on a stale install. */
export async function installedVersion(cdp) {
  return cdp.evaluate('app.plugins.plugins.mappy?.manifest?.version ?? null');
}

export const wait = ms => new Promise(resolve_ => setTimeout(resolve_, ms));
