/**
 * Headless Chrome over the DevTools Protocol for the browser harness scripts
 * (capture and performance). Chrome is located via an explicit path, $MAPPY_CHROME
 * or the usual install locations. No dependency is added: Node's WebSocket talks
 * to Chrome directly.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

export function findChrome(explicit) {
  const candidates = [explicit, process.env.MAPPY_CHROME, ...CHROME_CANDIDATES].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      return execFileSync('which', [name], { encoding: 'utf8' }).trim();
    } catch { /* Not on PATH. */ }
  }
  return null;
}

export function chromeVersion(chrome) {
  try {
    return execFileSync(chrome, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export function launchChrome(chrome, profile, window) {
  const child = spawn(chrome, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-gpu',
    '--force-device-scale-factor=1', `--window-size=${window.width},${window.height}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = new Promise((resolveEndpoint, reject) => {
    let output = '';
    const timer = setTimeout(() => { reject(new Error(`Chrome did not expose DevTools within 20s:\n${output}`)); }, 20000);
    child.stderr.on('data', chunk => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/u);
      if (match) { clearTimeout(timer); resolveEndpoint(match[1]); }
    });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited with ${code}:\n${output}`)); });
  });
  return { child, endpoint };
}

/** Minimal flat-session CDP client over the global WebSocket. */
export class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result);
    });
  }

  static connect(url) {
    return new Promise((resolveClient, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => { resolveClient(new Cdp(socket)); });
      socket.addEventListener('error', () => { reject(new Error(`Cannot connect to ${url}`)); });
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolveResult, reject) => {
      this.pending.set(id, { method, resolve: resolveResult, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() { this.socket.close(); }
}

export class Page {
  constructor(cdp, sessionId) { this.cdp = cdp; this.sessionId = sessionId; }
  send(method, params) { return this.cdp.send(method, params, this.sessionId); }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }

  harness(expression) { return this.evaluate(`(async () => { const h = window.__mappyHarness; return (${expression}); })()`); }

  async settle() { await this.harness('h.settle()'); }

  async screenshot(file, clip) {
    const { data } = await this.send('Page.captureScreenshot', {
      format: 'png', ...(clip ? { clip: { ...clip, scale: 2 } } : {}),
    });
    await writeFile(file, Buffer.from(data, 'base64'));
  }

  async mouse(type, x, y, extra = {}) {
    await this.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), ...extra });
  }

  async click(x, y, button = 'left') {
    await this.mouse('mouseMoved', x, y);
    await this.mouse('mousePressed', x, y, { button, clickCount: 1 });
    await this.mouse('mouseReleased', x, y, { button, clickCount: 1 });
  }

  async drag(fromX, fromY, toX, toY, steps = 8) {
    await this.mouse('mouseMoved', fromX, fromY);
    await this.mouse('mousePressed', fromX, fromY, { button: 'left', clickCount: 1 });
    for (let step = 1; step <= steps; step += 1) {
      await this.mouse('mouseMoved', fromX + (toX - fromX) * step / steps, fromY + (toY - fromY) * step / steps, { button: 'left' });
    }
    await this.mouse('mouseReleased', toX, toY, { button: 'left', clickCount: 1 });
  }

  async wheel(x, y, deltaX, deltaY, modifiers = 0) {
    await this.mouse('mouseWheel', x, y, { deltaX, deltaY, modifiers });
  }

  async key(key, code, keyCode, modifiers = 0) {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async type(text) { await this.send('Input.insertText', { text }); }
}

/**
 * Launch Chrome, open the built harness page and run `body(page)`; Chrome and its
 * temporary profile are removed afterwards whatever `body` does.
 */
export async function withHarnessPage(chrome, { output, window, fixture, pane }, body) {
  const profile = await mkdtemp(join(tmpdir(), 'mappy-harness-'));
  const { child, endpoint } = launchChrome(chrome, profile, window);
  let cdp;
  try {
    cdp = await Cdp.connect(await endpoint);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(cdp, sessionId);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { ...window, deviceScaleFactor: 1, mobile: false });
    const url = `${pathToFileURL(join(output, 'index.html')).href}?fixture=${fixture}&width=${pane.width}&height=${pane.height}`;
    await page.send('Page.navigate', { url });
    const deadline = Date.now() + 15000;
    while (!(await page.evaluate('typeof window.__mappyHarness === "object"'))) {
      if (Date.now() > deadline) throw new Error('Harness page did not initialise.');
      await new Promise(resolveWait => { setTimeout(resolveWait, 100); });
    }
    await page.harness('h.ready');
    return await body(page);
  } finally {
    cdp?.close();
    const exited = new Promise(resolveExit => { child.once('exit', resolveExit); });
    child.kill();
    await exited;
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}
