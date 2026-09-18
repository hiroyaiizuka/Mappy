/**
 * Drive the browser harness in headless Chrome over CDP and record evidence.
 *
 *   node scripts/browser-harness-capture.mjs [--chrome <path>] [--out artifacts/browser-harness]
 *
 * Every fixture is loaded and captured; the main map operations run on
 * uneven-branches with real mouse, wheel and key input. Screenshots, timings
 * and a record.md land in artifacts/browser-harness/<timestamp>/. Chrome is
 * located via --chrome, $MAPPY_CHROME, or the usual install locations; when
 * none exists the script writes a record marking the capture as not executed.
 * No dependency is added: Node's WebSocket talks to Chrome's DevTools protocol.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildBrowserHarness } from './browser-harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WINDOW = { width: 1640, height: 1000 };
const PANE = { width: 1280, height: 800 };
const OPERATION_FIXTURE = 'uneven-branches';
const TOPIC_FIXTURE = 'free-topics';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

function findChrome(explicit) {
  const candidates = [explicit, process.env.MAPPY_CHROME, ...CHROME_CANDIDATES].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      return execFileSync('which', [name], { encoding: 'utf8' }).trim();
    } catch { /* Not on PATH. */ }
  }
  return null;
}

function chromeVersion(chrome) {
  try {
    return execFileSync(chrome, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function launchChrome(chrome, profile) {
  const child = spawn(chrome, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-gpu',
    '--force-device-scale-factor=1', `--window-size=${WINDOW.width},${WINDOW.height}`, 'about:blank',
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

/** A protocol call that gets no answer within this time means the browser is wedged; the run then fails fast. */
const CDP_TIMEOUT_MS = 60000;

/** Minimal flat-session CDP client over the global WebSocket. */
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
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
    // MAPPY_CAPTURE_TRACE=1 prints every protocol call, to see where a run stalls.
    if (process.env.MAPPY_CAPTURE_TRACE) console.error(`cdp ${id} ${method} ${JSON.stringify(params).slice(0, 160)}`);
    return new Promise((resolveResult, reject) => {
      if (this.dead) { reject(new Error(`${method}: ${this.dead}`)); return; }
      const timer = setTimeout(() => {
        // Headless Chrome has been seen to stop answering with its browser process spinning; do not wait forever.
        this.dead = `browser unresponsive (${method} unanswered for ${CDP_TIMEOUT_MS / 1000}s)`;
        for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`${entry.method}: ${this.dead}`)); }
        this.pending.clear();
      }, CDP_TIMEOUT_MS);
      this.pending.set(id, { method, resolve: resolveResult, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() { this.socket.close(); }
}

class Page {
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

const center = rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
const inside = (rect, outer, margin = 0) => rect.x >= outer.x - margin && rect.y >= outer.y - margin
  && rect.x + rect.width <= outer.x + outer.width + margin && rect.y + rect.height <= outer.y + outer.height + margin;
const worldPoint = (view, point, canvas) => ({
  x: (point.x - canvas.x - view.x) / view.scale,
  y: (point.y - canvas.y - view.y) / view.scale,
});

/** Runs the scenario list, recording PASS/FAIL without stopping on the first failure. */
class Recorder {
  constructor(page, directory) { this.page = page; this.directory = directory; this.cases = []; this.index = 0; }

  async run(id, operation, expectation, body) {
    this.index += 1;
    const file = `${String(this.index).padStart(2, '0')}-${id}.png`;
    const entry = { id, operation, expectation, file, result: 'PASS', detail: '' };
    try {
      const detail = await body();
      entry.detail = typeof detail === 'string' ? detail : '';
    } catch (error) {
      entry.result = 'FAIL';
      entry.detail = error instanceof Error ? error.message : String(error);
    }
    try {
      await this.page.settle();
      await this.page.screenshot(join(this.directory, file));
      // The pane alone at 2x keeps node text legible when the map is small.
      const pane = await this.page.evaluate(`JSON.parse(JSON.stringify(document.getElementById('harness-pane').getBoundingClientRect()))`);
      await this.page.screenshot(join(this.directory, file.replace(/\.png$/u, '-pane.png')), pane);
    } catch (error) {
      entry.result = 'FAIL';
      entry.detail += ` screenshot: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.cases.push(entry);
    console.info(`${entry.result} ${id}${entry.detail ? ` — ${entry.detail}` : ''}`);
    return entry;
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function loadFixture(page, id) {
  const timing = await page.harness(`h.load(${JSON.stringify(id)})`);
  await page.settle();
  return timing;
}

async function emptyCanvasPoint(page, margin = 24) {
  const canvas = await page.harness('h.canvasRect()');
  const nodes = await page.harness('h.nodes()');
  for (let y = canvas.y + margin; y < canvas.y + canvas.height - 80; y += 40) {
    for (let x = canvas.x + margin; x < canvas.x + canvas.width - 220; x += 40) {
      if (!nodes.some(node => node.rect.x - 8 <= x && x <= node.rect.x + node.rect.width + 8
        && node.rect.y - 8 <= y && y <= node.rect.y + node.rect.height + 8)) return { x, y };
    }
  }
  throw new Error('No empty canvas point found for panning.');
}

async function captureFixtures(recorder, page, timings) {
  const fixtures = await page.harness('h.fixtures');
  for (const id of fixtures) {
    await recorder.run(`fixture-${id}`, `fixture ${id} を読み込み、Fit 後の表示`, '全ノードが表示され、ペイン内に収まる', async () => {
      const timing = await loadFixture(page, id);
      timings.push(timing);
      const nodes = await page.harness('h.nodes()');
      const canvas = await page.harness('h.canvasRect()');
      expect(nodes.length === timing.nodes, `DOM has ${nodes.length} nodes, parser found ${timing.nodes}`);
      const outside = nodes.filter(node => !inside(node.rect, canvas, 2));
      expect(outside.length === 0, `${outside.length} nodes outside the canvas after Fit`);
      const view = await page.harness('h.viewport()');
      return `${timing.nodes} ノード、scale ${view.scale.toFixed(4)}、setState ${timing.stateMs.toFixed(1)} ms、初回配置 ${timing.firstLayoutMs.toFixed(1)} ms、安定 ${timing.settledMs.toFixed(1)} ms`;
    });
  }
}

async function captureOperations(recorder, page) {
  await loadFixture(page, OPERATION_FIXTURE);
  const title = '多数の兄弟';
  const nodeRect = async name => {
    const node = await page.harness(`h.node(${JSON.stringify(name)})`);
    expect(node, `Node not found: ${name}`);
    return node;
  };

  await recorder.run('select-click', `ノード「${title}」をクリック`, 'そのノードだけが選択される', async () => {
    const node = await nodeRect(title);
    await page.click(center(node.rect).x, center(node.rect).y);
    const after = await nodeRect(title);
    expect(after.selected, 'clicked node is not selected');
    const selected = (await page.harness('h.nodes()')).filter(item => item.selected);
    expect(selected.length === 1, `${selected.length} nodes selected`);
  });

  await recorder.run('select-arrow', 'ArrowDown → ArrowLeft', '子「兄弟 1」へ移り、親へ戻る', async () => {
    await page.key('ArrowDown', 'ArrowDown', 40);
    let selected = (await page.harness('h.nodes()')).find(item => item.selected);
    expect(selected?.title === '兄弟 1', `ArrowDown selected ${selected?.title}`);
    await page.key('ArrowLeft', 'ArrowLeft', 37);
    selected = (await page.harness('h.nodes()')).find(item => item.selected);
    expect(selected?.title === title, `ArrowLeft selected ${selected?.title}`);
  });

  await recorder.run('fold-click', `「${title}」の分岐点の − をクリック`, '24 個の子が隠れ、件数バッジに 24', async () => {
    const before = (await page.harness('h.nodes()')).length;
    const node = await nodeRect(title);
    expect(node.toggle, 'fold control missing');
    await page.click(center(node.toggle).x, center(node.toggle).y);
    await page.settle();
    const after = await nodeRect(title);
    expect(after.collapsed, 'node is not collapsed');
    const count = (await page.harness('h.nodes()')).length;
    expect(count === before - 24, `visible nodes ${before} → ${count}`);
    const badge = await page.evaluate(`document.querySelector('.mappy-node.is-collapsed .mappy-node-toggle-mark')?.textContent`);
    expect(badge === '24', `badge shows ${badge}`);
    return `表示ノード ${before} → ${count}、バッジ ${badge}`;
  });

  await recorder.run('fold-space', 'Space キー', '同じ枝が再び展開される', async () => {
    const before = (await page.harness('h.nodes()')).length;
    await page.key(' ', 'Space', 32);
    await page.settle();
    const after = await nodeRect(title);
    expect(!after.collapsed, 'node is still collapsed');
    const count = (await page.harness('h.nodes()')).length;
    expect(count === before + 24, `visible nodes ${before} → ${count}`);
    return `表示ノード ${before} → ${count}`;
  });

  await recorder.run('pan-drag', '背景を右下へ 120×60 px ドラッグ', 'viewport が同じ量だけ移動する', async () => {
    const start = await emptyCanvasPoint(page);
    const before = await page.harness('h.viewport()');
    await page.drag(start.x, start.y, start.x + 120, start.y + 60);
    const after = await page.harness('h.viewport()');
    expect(Math.abs(after.x - before.x - 120) < 1 && Math.abs(after.y - before.y - 60) < 1,
      `viewport moved by ${(after.x - before.x).toFixed(1)}, ${(after.y - before.y).toFixed(1)}`);
    expect(Math.abs(after.scale - before.scale) < 1e-9, 'scale changed while panning');
    return `x ${before.x.toFixed(1)} → ${after.x.toFixed(1)}, y ${before.y.toFixed(1)} → ${after.y.toFixed(1)}`;
  });

  await recorder.run('pan-wheel', '修飾キーなしでホイール deltaY=100', 'viewport が上へ 100 px 移動する', async () => {
    const canvas = await page.harness('h.canvasRect()');
    const before = await page.harness('h.viewport()');
    await page.wheel(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2, 0, 100);
    const after = await page.harness('h.viewport()');
    expect(Math.abs(after.y - before.y + 100) < 1, `viewport y moved by ${(after.y - before.y).toFixed(1)}`);
    expect(Math.abs(after.scale - before.scale) < 1e-9, 'scale changed on plain wheel');
  });

  await recorder.run('zoom-wheel', `Ctrl＋ホイール deltaY=-200 を「${title}」上で`, 'ポインター直下の点を保って拡大する', async () => {
    const node = await nodeRect(title);
    // CDP takes integer coordinates; compare the world point at the pixel actually sent.
    const point = { x: Math.round(center(node.rect).x), y: Math.round(center(node.rect).y) };
    const canvas = await page.harness('h.canvasRect()');
    const before = await page.harness('h.viewport()');
    await page.wheel(point.x, point.y, 0, -200, 2);
    const after = await page.harness('h.viewport()');
    expect(after.scale > before.scale, `scale ${before.scale} → ${after.scale}`);
    const a = worldPoint(before, point, canvas);
    const b = worldPoint(after, point, canvas);
    expect(Math.hypot(a.x - b.x, a.y - b.y) < 1, `world point drifted by ${Math.hypot(a.x - b.x, a.y - b.y).toFixed(2)} px`);
    return `scale ${before.scale.toFixed(3)} → ${after.scale.toFixed(3)}、直下の点のずれ ${Math.hypot(a.x - b.x, a.y - b.y).toFixed(2)} px`;
  });

  await recorder.run('zoom-buttons', '右下の「拡大」→「全体表示」', '倍率が 1.2 倍になり、Fit で全ノードが収まる', async () => {
    const before = await page.harness('h.viewport()');
    const plus = await page.harness('h.button("拡大")');
    expect(plus, 'zoom-in button missing');
    await page.click(center(plus).x, center(plus).y);
    const zoomed = await page.harness('h.viewport()');
    expect(Math.abs(zoomed.scale / before.scale - 1.2) < 1e-6, `scale ratio ${zoomed.scale / before.scale}`);
    const fit = await page.harness('h.button("全体表示")');
    await page.click(center(fit).x, center(fit).y);
    await page.settle();
    const nodes = await page.harness('h.nodes()');
    const canvas = await page.harness('h.canvasRect()');
    const outside = nodes.filter(node => !inside(node.rect, canvas, 2));
    expect(outside.length === 0, `${outside.length} nodes outside after Fit`);
    return `scale ${before.scale.toFixed(3)} → ${zoomed.scale.toFixed(3)} → Fit ${(await page.harness('h.viewport()')).scale.toFixed(3)}`;
  });

  await recorder.run('timeline', '左下の「タイムライン」', '同じ内容が横軸レイアウトになり、ノード数は変わらない', async () => {
    const before = (await page.harness('h.nodes()')).length;
    const button = await page.harness('h.button("タイムライン")');
    expect(button, 'timeline button missing');
    await page.click(center(button).x, center(button).y);
    await page.settle();
    const timeline = await page.evaluate(`document.querySelectorAll('.mappy-node.is-timeline').length`);
    expect(timeline === before, `${timeline} timeline nodes of ${before}`);
    const activity = await page.harness('h.activity');
    expect(activity.some(entry => entry.kind === 'frontmatter' && entry.detail.includes('timeline')), 'layout preference was not written through processFrontMatter');
  });

  await recorder.run('timeline-back', '左下の「マップ」', '通常マップへ戻る', async () => {
    const button = await page.harness('h.button("マップ")');
    await page.click(center(button).x, center(button).y);
    await page.settle();
    const timeline = await page.evaluate(`document.querySelectorAll('.mappy-node.is-timeline').length`);
    expect(timeline === 0, `${timeline} nodes still in timeline`);
  });

  for (const [width, height] of [[640, 480], [390, 700]]) {
    await recorder.run(`resize-${width}x${height}`, `ペインを ${width}×${height} に変更`, 'onResize 後もノード数が変わらず、浮かせた UI が見える', async () => {
      const before = (await page.harness('h.nodes()')).length;
      await page.harness(`h.resize(${width}, ${height})`);
      await page.settle();
      const canvas = await page.harness('h.canvasRect()');
      expect(Math.abs(canvas.width - width) <= 2 && Math.abs(canvas.height - height) <= 2, `canvas is ${canvas.width}×${canvas.height}`);
      const count = (await page.harness('h.nodes()')).length;
      expect(count === before, `nodes ${before} → ${count}`);
      const fit = await page.harness('h.button("全体表示")');
      expect(fit && inside(fit, canvas), 'fit button is not inside the canvas');
      await page.click(center(fit).x, center(fit).y);
      await page.settle();
      const fitted = await page.harness('h.canvasRect()');
      const outside = (await page.harness('h.nodes()')).filter(node => !inside(node.rect, fitted, 2));
      expect(outside.length === 0, `${outside.length} nodes outside after Fit`);
    });
  }
  await page.harness(`h.resize(${PANE.width}, ${PANE.height})`);
  await page.settle();
  const fitButton = await page.harness('h.button("全体表示")');
  await page.click(center(fitButton).x, center(fitButton).y);
  await page.settle();

  await recorder.run('context-menu', `「${title}」を右クリック → Escape`, 'メニューが開き、Escape で閉じる', async () => {
    const node = await nodeRect(title);
    const point = center(node.rect);
    await page.mouse('mouseMoved', point.x, point.y);
    await page.mouse('mousePressed', point.x, point.y, { button: 'right', clickCount: 1 });
    await page.mouse('mouseReleased', point.x, point.y, { button: 'right', clickCount: 1 });
    const items = await page.evaluate(`Array.from(document.querySelectorAll('.menu .menu-item-title'), item => item.textContent)`);
    expect(items.length > 5, `menu has ${items.length} items`);
    await page.screenshot(join(recorder.directory, 'context-menu-open.png'));
    await page.key('Escape', 'Escape', 27);
    const open = await page.evaluate(`document.querySelectorAll('.menu').length`);
    expect(open === 0, 'menu still open after Escape');
    return `項目: ${items.join(' / ')}`;
  });

  await recorder.run('link-click', 'ノード内の内部リンクをクリック', '選択は変わらず、リンク解決は対象外の通知が出る', async () => {
    const selectedBefore = (await page.harness('h.nodes()')).find(item => item.selected)?.title;
    const rect = await page.evaluate(`JSON.parse(JSON.stringify(document.querySelector('.mappy-node a.internal-link')?.getBoundingClientRect() ?? null))`);
    expect(rect, 'no internal link rendered');
    await page.click(center(rect).x, center(rect).y);
    const notices = await page.harness('h.notices');
    expect(notices.some(text => text.includes('リンク解決はこのページの対象外')), 'no notice for the link click');
    const selectedAfter = (await page.harness('h.nodes()')).find(item => item.selected)?.title;
    expect(selectedAfter === selectedBefore, `selection changed ${selectedBefore} → ${selectedAfter}`);
    const activity = await page.harness('h.activity');
    return activity.filter(entry => entry.kind === 'link').map(entry => entry.detail).join('; ');
  });

  await recorder.run('edit-inline-memory', 'ノードを選び F2 → 入力 → Enter → ⌘Z', 'メモリ内の文書が改名され、Undo で戻る（保存経路の検証ではない）', async () => {
    const target = '空に近い枝';
    const node = await nodeRect(target);
    await page.click(center(node.rect).x, center(node.rect).y);
    await page.key('F2', 'F2', 113);
    const editing = await page.evaluate(`document.activeElement?.classList.contains('mappy-inline-input')`);
    expect(editing, 'inline editor did not take focus');
    await page.type('メモリ内で改名');
    await page.key('Enter', 'Enter', 13);
    await page.settle();
    expect(await page.harness('h.node("メモリ内で改名")'), 'renamed node not found');
    expect(!(await page.harness(`h.node(${JSON.stringify(target)})`)), 'old title still present');
    await page.key('z', 'KeyZ', 90, 4);
    await page.settle();
    expect(await page.harness(`h.node(${JSON.stringify(target)})`), 'undo did not restore the title');
    expect(!(await page.harness('h.node("メモリ内で改名")')), 'renamed title still present after undo');
    return 'DocumentStore → vault.process（メモリ内）→ modify → 再描画。ファイルへの書き込みなし';
  });

  await recorder.run('reopen', '「閉じて開き直す」', '古い DOM が残らず、同じノード数で再表示される', async () => {
    const before = (await page.harness('h.nodes()')).length;
    await page.harness('h.reopen()');
    await page.settle();
    const views = await page.evaluate(`document.querySelectorAll('.mappy-view').length`);
    expect(views === 1, `${views} map views in the document`);
    const count = (await page.harness('h.nodes()')).length;
    expect(count === before, `nodes ${before} → ${count}`);
    const opened = await page.harness('h.openCount');
    return `表示 ${opened} 回目、ノード ${count}`;
  });

  await recorder.run('fold-2000', 'performance-2000 で「第1節」へ Ctrl＋ホイールで寄り、分岐点を閉じる → Space で開く', '19 ノードが隠れ、再展開で戻る', async () => {
    await loadFixture(page, 'performance-2000');
    const before = (await page.harness('h.nodes()')).length;
    // Fit leaves every node a fraction of a pixel wide; zoom towards the node first, as a user would.
    let node = await nodeRect('第1節');
    for (let step = 0; step < 12 && (await page.harness('h.viewport()')).scale < 0.8; step += 1) {
      const point = center(node.rect);
      await page.wheel(point.x, point.y, 0, -200, 2);
      node = await nodeRect('第1節');
    }
    expect(node.toggle, 'fold control missing on 第1節');
    const startFold = Date.now();
    await page.click(center(node.toggle).x, center(node.toggle).y);
    await page.settle();
    const folded = (await page.harness('h.nodes()')).length;
    const foldMs = Date.now() - startFold;
    expect(folded === before - 19, `nodes ${before} → ${folded}`);
    await page.key(' ', 'Space', 32);
    await page.settle();
    const restored = (await page.harness('h.nodes()')).length;
    expect(restored === before, `nodes after expand ${restored}`);
    return `${before} → ${folded} → ${restored}、閉じてから安定まで約 ${foldMs} ms（settle の待ち時間込み）`;
  });
}

/** The note without its frontmatter: what the body and the topic sections say. */
function bodyOf(source) {
  const closing = source.indexOf('\n---\n', 4);
  return closing === -1 ? source : source.slice(closing + 5);
}

/** The `mappy-topics` line of one heading, or null. */
function topicEntry(source, title) {
  const line = source.split('\n').find(candidate => candidate.startsWith(`  ${title}: {`));
  return line ? line.trim() : null;
}

/** M7 free topics on the free-topics fixture: add by double-click, drag to a position, delete, and the map's history. */
async function captureTopicOperations(recorder, page) {
  await loadFixture(page, TOPIC_FIXTURE);
  const original = await page.harness('h.source()');
  const topicRect = async name => {
    const node = await page.harness(`h.node(${JSON.stringify(name)})`);
    expect(node, `Topic not found: ${name}`);
    return node;
  };
  // Undo and redo go through the canvas context menu: headless Chrome 153 stops responding after repeated
  // modifier-key input (⌘Z, ⌘⇧Z) over CDP, and the menu items run the same map history as the keys.
  const menuAction = async title => {
    const point = await emptyCanvasPoint(page, 80);
    await page.mouse('mouseMoved', point.x, point.y);
    await page.mouse('mousePressed', point.x, point.y, { button: 'right', clickCount: 1 });
    await page.mouse('mouseReleased', point.x, point.y, { button: 'right', clickCount: 1 });
    const item = await page.evaluate(`(() => {
      const found = Array.from(document.querySelectorAll('.menu .menu-item'))
        .find(candidate => candidate.querySelector('.menu-item-title')?.textContent === ${JSON.stringify(title)});
      if (!found) return null;
      const rect = found.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, disabled: found.classList.contains('is-disabled') };
    })()`);
    expect(item, `context menu has no item ${title}`);
    expect(!item.disabled, `menu item ${title} is disabled`);
    await page.click(center(item).x, center(item).y);
    await page.settle();
  };
  const undo = () => menuAction('元に戻す');
  const redo = () => menuAction('やり直す');
  const title = '追加した話題';
  let added = null;

  await recorder.run('topic-add-dblclick', '空白をダブルクリック → 入力 → Enter', '文書末尾に `## ` が増えてその場で入力でき、確定で見出しの文と mappy-topics の位置が保存される', async () => {
    // Away from the edges, so revealing the new node does not pan the viewport under the comparison.
    const point = await emptyCanvasPoint(page, 80);
    const canvas = await page.harness('h.canvasRect()');
    const pressed = worldPoint(await page.harness('h.viewport()'), point, canvas);
    const before = (await page.harness('h.nodes()')).length;
    await page.dblclick(point.x, point.y);
    await page.settle();
    const blank = await page.harness('h.source()');
    expect(blank === `${original}\n## \n`, 'the empty section was not appended at the end of the note');
    const editing = await page.evaluate(`document.activeElement?.classList.contains('mappy-inline-input')`);
    expect(editing, 'inline editor did not take focus on the new topic');
    const host = await page.evaluate(`document.activeElement?.closest('.mappy-node')?.classList.contains('is-topic')`);
    expect(host, 'the edited node is not a topic root');
    await page.screenshot(join(recorder.directory, 'topic-add-editing.png'));
    await page.type(title);
    await page.key('Enter', 'Enter', 13);
    await page.settle();
    added = await page.harness('h.source()');
    expect(added.endsWith(`\n## ${title}\n`), 'the title was not written to the heading');
    const entry = topicEntry(added, title);
    expect(entry && /^.+: \{ mindmap: \[-?\d+, -?\d+\] \}$/u.test(entry), `mappy-topics entry: ${entry}`);
    expect(bodyOf(added).slice(0, bodyOf(original).length) === bodyOf(original), 'the body or the other topics changed');
    const node = await topicRect(title);
    const placed = worldPoint(await page.harness('h.viewport()'), node.rect, canvas);
    expect(Math.abs(placed.x - pressed.x) < 1.5 && Math.abs(placed.y - pressed.y) < 1.5,
      `topic root at world ${placed.x.toFixed(1)},${placed.y.toFixed(1)}, pressed at ${pressed.x.toFixed(1)},${pressed.y.toFixed(1)}`);
    const count = (await page.harness('h.nodes()')).length;
    expect(count === before + 1, `nodes ${before} → ${count}`);
    return `${entry}、ノード ${before} → ${count}`;
  });

  await recorder.run('topic-add-undo', '右クリック「元に戻す」×2 → 「やり直す」×2', '1 回目で名前と位置、2 回目で区画が消え、やり直しで戻る', async () => {
    expect(added, 'the previous case did not add a topic');
    await undo();
    expect((await page.harness('h.source()')) === `${original}\n## \n`, 'first undo did not remove title and position together');
    await undo();
    expect((await page.harness('h.source()')) === original, 'second undo did not remove the section');
    expect(!(await page.harness(`h.node(${JSON.stringify(title)})`)), 'the topic is still shown after undo');
    await redo();
    await redo();
    expect((await page.harness('h.source()')) === added, 'redo did not restore the named topic');
    expect(await page.harness(`h.node(${JSON.stringify(title)})`), 'the topic is not shown after redo');
  });

  const reference = '参考資料';
  let moved = null;
  await recorder.run('topic-drag', `「${reference}」を右下へ 120×60 px ドラッグ`, 'トピックの木ごと動き、mappy-topics のその見出しの mindmap 位置だけが変わる', async () => {
    const base = await page.harness('h.source()');
    const before = await topicRect(reference);
    const child = await page.harness('h.node("講座ノート")');
    const view = await page.harness('h.viewport()');
    const from = center(before.rect);
    await page.drag(from.x, from.y, from.x + 120, from.y + 60);
    await page.settle();
    const after = await topicRect(reference);
    expect(Math.abs(after.rect.x - before.rect.x - 120) < 1.5 && Math.abs(after.rect.y - before.rect.y - 60) < 1.5,
      `topic moved by ${(after.rect.x - before.rect.x).toFixed(1)}, ${(after.rect.y - before.rect.y).toFixed(1)}`);
    const childAfter = await page.harness('h.node("講座ノート")');
    expect(child && childAfter && Math.abs(childAfter.rect.x - child.rect.x - 120) < 1.5, 'the child of the topic did not move with it');
    moved = await page.harness('h.source()');
    expect(bodyOf(moved) === bodyOf(base), 'the body changed while dragging a topic');
    const dx = Math.round(120 / view.scale);
    const dy = Math.round(60 / view.scale);
    const expected = `${reference}: { mindmap: [${-360 + dx}, ${200 + dy}], timeline: [0, 260] }`;
    expect(topicEntry(moved, reference) === expected, `expected ${expected}, got ${topicEntry(moved, reference)}`);
    expect(moved.includes('  "補足: 用語": { mindmap: [560, -140] }\n  消えた見出し: { mindmap: [0, 0] }\n'), 'other entries changed');
    expect(!(await page.evaluate(`document.querySelector('.mappy-drag-ghost')`)), 'a ghost was left behind');
    return `mindmap: [-360, 200] → [${-360 + dx}, ${200 + dy}]（scale ${view.scale.toFixed(3)}）、timeline は不変`;
  });

  await recorder.run('topic-drag-undo', '右クリック「元に戻す」→「やり直す」', '位置が戻り、やり直しで再び移動する', async () => {
    expect(moved, 'the previous case did not move a topic');
    const movedRect = (await topicRect(reference)).rect;
    await undo();
    const restored = await page.harness('h.source()');
    expect(topicEntry(restored, reference) === `${reference}: { mindmap: [-360, 200], timeline: [0, 260] }`, 'undo did not restore the previous position');
    expect(bodyOf(restored) === bodyOf(moved), 'undo changed the body');
    const back = (await topicRect(reference)).rect;
    expect(Math.abs(back.x - movedRect.x + 120) < 1.5 && Math.abs(back.y - movedRect.y + 60) < 1.5, 'the topic did not move back');
    await redo();
    expect((await page.harness('h.source()')) === moved, 'redo did not reapply the move');
  });

  await recorder.run('topic-drag-escape', `「${reference}」をドラッグ中に Escape`, '木が元の位置へ戻り、frontmatter は変わらない', async () => {
    const base = await page.harness('h.source()');
    const before = await topicRect(reference);
    const from = center(before.rect);
    await page.mouse('mouseMoved', from.x, from.y);
    await page.mouse('mousePressed', from.x, from.y, { button: 'left', clickCount: 1 });
    await page.mouse('mouseMoved', from.x + 40, from.y + 40, { button: 'left' });
    await page.mouse('mouseMoved', from.x + 80, from.y + 80, { button: 'left' });
    await page.settle();
    const during = await topicRect(reference);
    expect(Math.abs(during.rect.x - before.rect.x - 80) < 1.5, 'the topic did not follow the pointer');
    await page.key('Escape', 'Escape', 27);
    await page.mouse('mouseReleased', from.x + 80, from.y + 80, { button: 'left', clickCount: 1 });
    await page.settle();
    const after = await topicRect(reference);
    expect(Math.abs(after.rect.x - before.rect.x) < 1.5 && Math.abs(after.rect.y - before.rect.y) < 1.5, 'the topic did not return');
    expect((await page.harness('h.source()')) === base, 'the note changed on a cancelled drag');
  });

  await recorder.run('topic-unplaced-drag', '「位置のないトピック」を左下へ 60×80 px ドラッグ（他のノードから離れた空白）', '初めての移動で mappy-topics に新しいキーが書かれる', async () => {
    const name = '位置のないトピック';
    const base = await page.harness('h.source()');
    const before = await topicRect(name);
    const view = await page.harness('h.viewport()');
    const from = center(before.rect);
    await page.drag(from.x, from.y, from.x - 60, from.y + 80);
    await page.settle();
    const source = await page.harness('h.source()');
    const entry = topicEntry(source, name);
    expect(entry, 'no entry was created for the unplaced topic');
    expect(bodyOf(source) === bodyOf(base), 'the body changed');
    await undo();
    expect((await page.harness('h.source()')) === base, 'undo did not drop the new key');
    return `${entry}（scale ${view.scale.toFixed(3)}）`;
  });

  await recorder.run('topic-delete', `「${reference}」を選択 → Delete → 「元に戻す」→「やり直す」`, '区画と mappy-topics の項目が一緒に消え、Undo で両方戻り、Redo で再び消える', async () => {
    const base = await page.harness('h.source()');
    const node = await topicRect(reference);
    await page.click(center(node.rect).x, center(node.rect).y);
    const before = (await page.harness('h.nodes()')).length;
    await page.key('Delete', 'Delete', 46);
    await page.settle();
    const deleted = await page.harness('h.source()');
    expect(!deleted.includes(reference), 'the topic heading or its key is still in the note');
    expect(deleted.includes('mappy-topics:\n  "補足: 用語": { mindmap: [560, -140] }\n'), 'other entries were lost');
    const body = bodyOf(base);
    const cut = body.slice(0, body.indexOf('## 参考資料')) + body.slice(body.indexOf('## 補足: 用語'));
    expect(bodyOf(deleted) === cut, 'more than the topic section changed');
    const count = (await page.harness('h.nodes()')).length;
    expect(count === before - 4, `nodes ${before} → ${count}`);
    await undo();
    expect((await page.harness('h.source()')) === base, 'undo did not restore section and position');
    expect((await page.harness('h.nodes()')).length === before, 'nodes did not come back');
    await redo();
    expect((await page.harness('h.source()')) === deleted, 'redo did not delete again');
    await undo();
    return `ノード ${before} → ${count} → ${before}`;
  });

  await recorder.run('topic-join', `「${reference}」を「回復する」の上へドラッグ → 離す`, 'ゴーストではなく木ごと追従し、スロット（仮ノード＋青線）が出て、離すとその子の枝になる。mappy-topics の項目も消える', async () => {
    const base = await page.harness('h.source()');
    const before = (await page.harness('h.nodes()')).length;
    const root = await topicRect(reference);
    const target = await topicRect('回復する');
    const from = center(root.rect);
    const to = center(target.rect);
    await page.mouse('mouseMoved', from.x, from.y);
    await page.mouse('mousePressed', from.x, from.y, { button: 'left', clickCount: 1 });
    for (let step = 1; step <= 10; step += 1) {
      await page.mouse('mouseMoved', from.x + (to.x - from.x) * step / 10, from.y + (to.y - from.y) * step / 10, { button: 'left' });
    }
    await page.settle();
    const preview = await page.evaluate(`(() => { const host = document.querySelector('.mappy-view');
      const root = Array.from(host.querySelectorAll('.mappy-node.is-topic')).find(n => n.querySelector('.mappy-node-label')?.textContent?.trim() === ${JSON.stringify(reference)});
      return { placeholder: !host.querySelector('.mappy-drop-placeholder').hidden, connector: Boolean(host.querySelector('.mappy-edges path.is-preview')),
        ghost: Boolean(host.querySelector('.mappy-drag-ghost')), moving: root?.classList.contains('is-drag-moving'), merging: root?.classList.contains('is-merging') }; })()`);
    await page.screenshot(join(recorder.directory, 'topic-join-preview.png'));
    expect(preview.placeholder && preview.connector && !preview.ghost && preview.moving && preview.merging, `preview state ${JSON.stringify(preview)}`);
    await page.mouse('mouseReleased', to.x, to.y, { button: 'left', clickCount: 1 });
    await page.settle();
    const joined = await page.harness('h.source()');
    expect(!joined.includes('## 参考資料') && !topicEntry(joined, reference), 'the section or its entry is still there');
    expect(joined.includes('  - 睡眠\n  - 参考資料\n    位置は frontmatter の `mappy-topics` にあり、本文には何も書かない。\n\n    - [[heading-document|講座ノート]]\n'), 'the section did not become a branch under 回復する');
    const count = (await page.harness('h.nodes()')).length;
    expect(count === before, `nodes ${before} → ${count}`);
    const item = await topicRect(reference);
    const cls = await page.evaluate(`Array.from(document.querySelectorAll('.mappy-node')).find(n => n.querySelector('.mappy-node-label')?.textContent?.trim() === ${JSON.stringify(reference)})?.className`);
    expect(item && !cls.includes('is-topic') && !cls.includes('is-root') && !cls.includes('is-drag-moving') && !cls.includes('is-merging'), `joined node classes: ${cls}`);
    await undo();
    expect((await page.harness('h.source()')) === base, 'undo did not restore the topic');
    return `ノード ${count}、参考資料 → 回復する の子（${cls}）`;
  });

  await recorder.run('body-drag', '本体「講座の本体」を右下へ 100×50 px ドラッグ', '本体がポインターに付いて動き、トピックは画面上の位置を保つ。frontmatter では全トピックの位置が書き換わる', async () => {
    const base = await page.harness('h.source()');
    const body = await topicRect('講座の本体');
    const topicsBefore = await page.harness('h.nodes()');
    const view = await page.harness('h.viewport()');
    const from = center(body.rect);
    await page.drag(from.x, from.y, from.x + 100, from.y + 50);
    await page.settle();
    const after = await topicRect('講座の本体');
    expect(Math.abs(after.rect.x - body.rect.x - 100) < 1.5 && Math.abs(after.rect.y - body.rect.y - 50) < 1.5, `body moved by ${(after.rect.x - body.rect.x).toFixed(1)}, ${(after.rect.y - body.rect.y).toFixed(1)}`);
    const nowView = await page.harness('h.viewport()');
    expect(Math.abs(nowView.x - view.x - 100) < 1.5 && Math.abs(nowView.y - view.y - 50) < 1.5, 'viewport did not follow the pointer');
    for (const name of ['補足: 用語', '位置のないトピック']) {
      const was = topicsBefore.find(item => item.title === name);
      const now = await topicRect(name);
      expect(was && Math.abs(now.rect.x - was.rect.x) < 1.5 && Math.abs(now.rect.y - was.rect.y) < 1.5, `${name} moved on screen by ${(now.rect.x - (was?.rect.x ?? 0)).toFixed(1)}, ${(now.rect.y - (was?.rect.y ?? 0)).toFixed(1)}`);
    }
    const moved = await page.harness('h.source()');
    expect(bodyOf(moved) === bodyOf(base), 'the body changed');
    const dx = Math.round(100 / view.scale);
    const dy = Math.round(50 / view.scale);
    const was = /mindmap: \[(-?\d+), (-?\d+)\]/u.exec(topicEntry(base, reference) ?? '');
    expect(was, 'no mindmap entry for 参考資料 before the drag');
    const expected = `参考資料: { mindmap: [${Number(was[1]) - dx}, ${Number(was[2]) - dy}], timeline: [0, 260] }`;
    expect(topicEntry(moved, reference) === expected, `expected ${expected}, got ${topicEntry(moved, reference)}`);
    expect(topicEntry(moved, '位置のないトピック'), 'the unplaced topic got no entry');
    await undo();
    expect((await page.harness('h.source()')) === base, 'undo did not restore the entries');
    return `${expected}、位置のないトピック: ${topicEntry(moved, '位置のないトピック')}`;
  });

  await recorder.run('topic-snap', '「位置のないトピック」を「ふりかえる」の右隣（重ならない位置）へ運ぶ → 離す', 'ポインターが相手に乗らなくても、ルートが隣に来た時点でスロットとゴースト風の表示が出て、離すとその子になる', async () => {
    const base = await page.harness('h.source()');
    const topic = await topicRect('位置のないトピック');
    const target = await topicRect('ふりかえる');
    const from = center(topic.rect);
    // Bring the root's left edge 24 px right of the target, vertically level; the pointer stays off the target.
    const to = { x: target.rect.x + target.rect.width + 24 + (from.x - topic.rect.x), y: target.rect.y + target.rect.height / 2 + (from.y - (topic.rect.y + topic.rect.height / 2)) };
    await page.mouse('mouseMoved', from.x, from.y);
    await page.mouse('mousePressed', from.x, from.y, { button: 'left', clickCount: 1 });
    for (let step = 1; step <= 12; step += 1) await page.mouse('mouseMoved', from.x + (to.x - from.x) * step / 12, from.y + (to.y - from.y) * step / 12, { button: 'left' });
    await page.settle();
    const under = await page.evaluate(`document.elementFromPoint(${Math.round(to.x)}, ${Math.round(to.y)})?.closest('[data-node-id]')?.querySelector('.mappy-node-label')?.textContent?.trim() ?? null`);
    const preview = await page.evaluate(`(() => { const host = document.querySelector('.mappy-view');
      const root = Array.from(host.querySelectorAll('.mappy-node.is-topic')).find(n => n.querySelector('.mappy-node-label')?.textContent?.trim() === '位置のないトピック');
      return { placeholder: !host.querySelector('.mappy-drop-placeholder').hidden, connector: Boolean(host.querySelector('.mappy-edges path.is-preview')), merging: root?.classList.contains('is-merging') }; })()`);
    await page.screenshot(join(recorder.directory, 'topic-snap-preview.png'));
    expect(under === null, `the pointer is over ${under}; the snap must come from the root's position`);
    expect(preview.placeholder && preview.connector && preview.merging, `preview state ${JSON.stringify(preview)}`);
    await page.mouse('mouseReleased', to.x, to.y, { button: 'left', clickCount: 1 });
    await page.settle();
    const joined = await page.harness('h.source()');
    expect(joined.includes('  - ふりかえる\n    - 位置のないトピック\n      `mappy-topics` に項目がないので、本体の下の既定位置に置く。\n\n      - 既定位置\n'), `joined: ${JSON.stringify(joined.slice(joined.indexOf('- 記録する'), joined.indexOf('- 記録する') + 160))}`);
    await undo();
    expect((await page.harness('h.source()')) === base, 'undo did not restore the topic');
    return `ポインター下: なし、スロット表示あり → ふりかえる の子`;
  });

  await recorder.run('branch-detach', '本体の枝「記録する」を空白へドラッグ → 離す', '枝が新しいトピック（文末の `## 記録する`）になり、離した位置が mappy-topics に入る。Undo で枝に戻る', async () => {
    const base = await page.harness('h.source()');
    const before = (await page.harness('h.nodes()')).length;
    const branch = await topicRect('記録する');
    const from = center(branch.rect);
    const canvas = await page.harness('h.canvasRect()');
    const point = { x: canvas.x + canvas.width - 260, y: canvas.y + canvas.height - 120 };
    await page.drag(from.x, from.y, point.x, point.y, 12);
    await page.settle();
    const detached = await page.harness('h.source()');
    expect(detached.endsWith('\n## 記録する\n\n- ふりかえる\n'), `note tail: ${JSON.stringify(detached.slice(-40))}`);
    expect(!detached.includes('- 記録する\n'), 'the branch is still in the body');
    const entry = topicEntry(detached, '記録する');
    expect(entry && /^記録する: \{ mindmap: \[-?\d+, -?\d+\] \}$/u.test(entry), `entry: ${entry}`);
    expect(bodyOf(detached).startsWith(bodyOf(base).replace('- 記録する\n  - ふりかえる\n', '')), 'the rest of the body changed');
    const root = await topicRect('記録する');
    const cls = await page.evaluate(`Array.from(document.querySelectorAll('.mappy-node')).find(n => n.querySelector('.mappy-node-label')?.textContent?.trim() === '記録する')?.className`);
    expect(cls.includes('is-topic') && cls.includes('is-root'), `classes: ${cls}`);
    // The ghost's top-left becomes the new root's top-left: the release point minus the grab offset inside the node.
    const grab = { x: from.x - branch.rect.x, y: from.y - branch.rect.y };
    expect(Math.abs(root.rect.x - (point.x - grab.x)) < 2 && Math.abs(root.rect.y - (point.y - grab.y)) < 2, `root at ${root.rect.x},${root.rect.y}, expected ${point.x - grab.x},${point.y - grab.y}`);
    const count = (await page.harness('h.nodes()')).length;
    expect(count === before, `nodes ${before} → ${count}`);
    await undo();
    expect((await page.harness('h.source()')) === base, 'undo did not restore the branch');
    return `${entry}、ノード ${count}`;
  });

  await recorder.run('topic-context-menu', '空白を右クリック → Escape', '「トピックを追加」を含むメニューが開き、Escape で閉じる', async () => {
    const point = await emptyCanvasPoint(page);
    await page.mouse('mouseMoved', point.x, point.y);
    await page.mouse('mousePressed', point.x, point.y, { button: 'right', clickCount: 1 });
    await page.mouse('mouseReleased', point.x, point.y, { button: 'right', clickCount: 1 });
    const items = await page.evaluate(`Array.from(document.querySelectorAll('.menu .menu-item-title'), item => item.textContent)`);
    expect(items.includes('トピックを追加'), `menu items: ${items.join(' / ')}`);
    await page.screenshot(join(recorder.directory, 'topic-context-menu-open.png'));
    await page.key('Escape', 'Escape', 27);
    expect((await page.evaluate(`document.querySelectorAll('.menu').length`)) === 0, 'menu still open');
    return `項目: ${items.join(' / ')}`;
  });
}

function recordMarkdown({ startedAt, chrome, version, commit, cases, timings, notExecuted }) {
  const lines = [
    '# ブラウザ検証ページ（②）の記録',
    '',
    `- 日時: ${startedAt}`,
    `- OS / Node: ${process.platform} ${process.arch} / ${process.version}`,
    `- ブラウザ: ${version} (${chrome})`,
    `- build: ${commit}（\`npm run harness:browser:build\` の \`dist/harness\`）`,
    `- ウィンドウ ${WINDOW.width}×${WINDOW.height}、ペイン ${PANE.width}×${PANE.height}、devicePixelRatio 1、headless`,
    '- 対象外: 保存、リンク解決、テーマ、日本語 IME。ここでの PASS は Obsidian 実機（③ E01〜E29）の PASS ではない。',
    '- 描画時間は「時刻の記録」の生値。「安定」はノード位置が 3 フレーム変わらないまでの待ち（60 fps で約 50 ms）を含む。基準端末・条件・p95 を伴う計測は別チケット（性能計測）で扱う。',
    '',
    '## fixture と主要操作',
    '',
    '| # | Case | 操作 | 期待 | 結果 | 実測 | スクリーンショット |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...cases.map((entry, index) => `| ${index + 1} | ${entry.id} | ${entry.operation} | ${entry.expectation} | ${entry.result} | ${entry.detail.replace(/\|/gu, '／')} | ${entry.file}, ${entry.file.replace(/\.png$/u, '-pane.png')} |`),
    '',
    '## 時刻の記録（ms）',
    '',
    '| fixture | ノード | parse | setState | 初回配置 | 安定 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...timings.map(timing => `| ${timing.fixture} | ${timing.nodes} | ${timing.parseMs.toFixed(1)} | ${timing.stateMs.toFixed(1)} | ${timing.firstLayoutMs.toFixed(1)} | ${timing.settledMs.toFixed(1)} |`),
    '',
    '## 未実施',
    '',
    ...notExecuted.map(item => `- ${item}`),
    '',
  ];
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const outRoot = resolve(root, option('--out') ?? join('artifacts', 'browser-harness'));
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/gu, '-');
  const directory = join(outRoot, stamp);
  await mkdir(directory, { recursive: true });
  const notExecuted = [
    'Obsidian 実機（③ E01〜E29）: このページは代替ではない。実機の確認は実機を使うチケットの記録に残す。',
    'トラックパッドのピンチ・二本指スクロール、ネイティブ IME、モバイル: headless の合成入力では確認できない。',
    '⌘Z／⌘⇧Z の連打: headless Chrome 153 は修飾キー付きのキー入力を CDP で繰り返すと応答しなくなるため、フリートピックの Undo／Redo は右クリックメニューで実行した。キー経由の Undo は edit-inline-memory の 1 回と jsdom のテストで確認する。',
    '性能計測（基準端末・条件・p95 の記録）: LEV-13 の範囲。ここでは時刻の生値だけを残す。',
  ];
  const chrome = findChrome(option('--chrome'));
  const output = await buildBrowserHarness();
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (!chrome) {
    const record = recordMarkdown({
      startedAt: startedAt.toISOString(), chrome: 'なし', version: 'なし', commit, cases: [], timings: [],
      notExecuted: ['headless Chrome が見つからないため、スクリーンショットと操作の自動確認は未実施。'
        + ' `--chrome <path>` か MAPPY_CHROME を指定して再実行するか、docs/harness.md の手順で手動確認する。', ...notExecuted],
    });
    await writeFile(join(directory, 'record.md'), record);
    console.error(`No Chrome found. Wrote ${relative(root, join(directory, 'record.md'))} marking the capture as not executed.`);
    process.exitCode = 2;
    return;
  }
  const profile = await mkdtemp(join(tmpdir(), 'mappy-harness-'));
  const { child, endpoint } = launchChrome(chrome, profile);
  let cdp;
  let recorder;
  let aborted = null;
  const timings = [];
  try {
    cdp = await Cdp.connect(await endpoint);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(cdp, sessionId);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { ...WINDOW, deviceScaleFactor: 1, mobile: false });
    const url = `${pathToFileURL(join(output, 'index.html')).href}?fixture=${OPERATION_FIXTURE}&width=${PANE.width}&height=${PANE.height}`;
    await page.send('Page.navigate', { url });
    const deadline = Date.now() + 15000;
    while (!(await page.evaluate('typeof window.__mappyHarness === "object"'))) {
      if (Date.now() > deadline) throw new Error('Harness page did not initialise.');
      await new Promise(resolveWait => { setTimeout(resolveWait, 100); });
    }
    await page.harness('h.ready');
    recorder = new Recorder(page, directory);
    await captureFixtures(recorder, page, timings);
    await captureOperations(recorder, page);
    await captureTopicOperations(recorder, page);
    await writeFile(join(directory, 'timings.json'), `${JSON.stringify({ commit, chrome: chromeVersion(chrome), timings }, null, 2)}\n`);
  } catch (error) {
    // Keep the record of what did run; the exit code still reports the abort.
    aborted = error instanceof Error ? error.message : String(error);
  } finally {
    cdp?.close();
    const exited = new Promise(resolveExit => { child.once('exit', resolveExit); });
    // A wedged browser ignores SIGTERM and would keep spinning after the run; SIGKILL leaves nothing behind.
    child.kill('SIGKILL');
    await exited;
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  }
  const cases = recorder?.cases ?? [];
  if (cdp?.dead) notExecuted.unshift(`ブラウザが応答しなくなったため、以降のケースは未実施または FAIL（${cdp.dead}）。再実行する。`);
  if (aborted) notExecuted.unshift(`途中で中断したため、残りのケースは未実施（${aborted}）。`);
  const record = recordMarkdown({ startedAt: startedAt.toISOString(), chrome, version: chromeVersion(chrome), commit, cases, timings, notExecuted });
  await writeFile(join(directory, 'record.md'), record);
  const failed = cases.filter(entry => entry.result === 'FAIL').length;
  console.info(`Wrote ${relative(root, directory)} (${cases.length} cases, ${failed} failed${aborted ? ', aborted' : ''}).`);
  if (failed > 0 || aborted) process.exitCode = 1;
}

await main();
