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

/** Flags for headless Chrome; `gpu: true` keeps GPU rasterisation instead of software rendering. */
export function chromeFlags(window, { gpu = false } = {}) {
  return [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', ...(gpu ? [] : ['--disable-gpu']),
    '--force-device-scale-factor=1', `--window-size=${window.width},${window.height}`,
  ];
}

export function launchChrome(chrome, profile, window, options = {}) {
  const child = spawn(chrome, [
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, ...chromeFlags(window, options), 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  // The tail of Chrome's stderr, so a crash mid-run can be explained.
  const log = { text: '' };
  child.stderr.on('data', chunk => { log.text = (log.text + String(chunk)).slice(-4000); });
  const endpoint = new Promise((resolveEndpoint, reject) => {
    const timer = setTimeout(() => { reject(new Error(`Chrome did not expose DevTools within 20s:\n${log.text}`)); }, 20000);
    child.stderr.on('data', () => {
      const match = log.text.match(/DevTools listening on (ws:\/\/\S+)/u);
      if (match) { clearTimeout(timer); resolveEndpoint(match[1]); }
    });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited with ${code}:\n${log.text}`)); });
  });
  return { child, endpoint, log };
}

/** A protocol call that gets no answer within this time means the browser is wedged; the run then fails fast. */
export const CDP_TIMEOUT_MS = 60000;

/**
 * Thrown for every call once the DevTools connection is unusable: the socket
 * closed (Chrome exited or crashed) or a call went unanswered for CDP_TIMEOUT_MS.
 * Callers treat it as "this Chrome is gone", not as one failed step.
 */
export class CdpClosedError extends Error {}

/** Minimal flat-session CDP client over the global WebSocket. */
export class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    /** Why the connection is unusable, or null while it works. */
    this.dead = null;
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result);
    });
    // Without this a crashed Chrome leaves every await hanging and Node exits with an unsettled top-level await.
    socket.addEventListener('close', () => { this.abandon('DevTools connection closed (Chrome exited or crashed)'); });
  }

  /** Mark the connection unusable and reject everything still pending. */
  abandon(reason) {
    if (this.dead) return;
    this.dead = reason;
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new CdpClosedError(`${entry.method}: ${reason}`));
    }
  }

  static connect(url) {
    return new Promise((resolveClient, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => { resolveClient(new Cdp(socket)); });
      socket.addEventListener('error', () => { reject(new Error(`Cannot connect to ${url}`)); });
    });
  }

  send(method, params = {}, sessionId) {
    if (this.dead) return Promise.reject(new CdpClosedError(`${method}: ${this.dead}`));
    const id = this.nextId++;
    // MAPPY_CAPTURE_TRACE=1 prints every protocol call, to see where a run stalls.
    if (process.env.MAPPY_CAPTURE_TRACE) console.error(`cdp ${id} ${method} ${JSON.stringify(params).slice(0, 160)}`);
    return new Promise((resolveResult, reject) => {
      // Headless Chrome has been seen to stop answering with its browser process spinning; do not wait forever.
      const timer = setTimeout(() => { this.abandon(`browser unresponsive (${method} unanswered for ${CDP_TIMEOUT_MS / 1000}s)`); }, CDP_TIMEOUT_MS);
      this.pending.set(id, { method, resolve: resolveResult, reject, timer });
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

  /** Two presses at the same point; Chrome raises the dblclick on the second release. */
  async dblclick(x, y) {
    await this.click(x, y);
    await this.mouse('mousePressed', x, y, { button: 'left', clickCount: 2 });
    await this.mouse('mouseReleased', x, y, { button: 'left', clickCount: 2 });
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
export async function withHarnessPage(chrome, { output, window, fixture, pane, gpu = false }, body) {
  const profile = await mkdtemp(join(tmpdir(), 'mappy-harness-'));
  const { child, endpoint, log } = launchChrome(chrome, profile, window, { gpu });
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
    try {
      return await body(page);
    } catch (error) {
      if (error instanceof CdpClosedError) throw new Error(`${error.message}. Chrome stderr tail:
${log.text}`);
      throw error;
    }
  } finally {
    cdp?.close();
    const exited = new Promise(resolveExit => { child.once('exit', resolveExit); });
    // A wedged browser ignores SIGTERM and would keep spinning after the run; SIGKILL leaves nothing behind.
    child.kill('SIGKILL');
    await exited;
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}
