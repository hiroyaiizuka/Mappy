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
 * The CDP client lives in ./browser-harness-cdp.mjs, shared with the
 * performance runner.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildBrowserHarness } from './browser-harness.mjs';
import { chromeVersion, findChrome, withHarnessPage } from './browser-harness-cdp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WINDOW = { width: 1640, height: 1000 };
const PANE = { width: 1280, height: 800 };
const OPERATION_FIXTURE = 'uneven-branches';

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

async function emptyCanvasPoint(page) {
  const canvas = await page.harness('h.canvasRect()');
  const nodes = await page.harness('h.nodes()');
  for (let y = canvas.y + 24; y < canvas.y + canvas.height - 80; y += 40) {
    for (let x = canvas.x + 24; x < canvas.x + canvas.width - 220; x += 40) {
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
    '- 描画時間は「時刻の記録」の生値（1 回分）。「安定」はノード位置が 3 フレーム変わらないまでの待ち（60 fps で約 50 ms）を含む。繰り返し計測と p50／p95 は `node scripts/browser-harness-perf.mjs` の記録（`artifacts/performance/`）で扱う。',
    '',
    '## fixture と主要操作',
    '',
    '| # | Case | 操作 | 期待 | 結果 | 実測 | スクリーンショット |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...cases.map((entry, index) => `| ${index + 1} | ${entry.id} | ${entry.operation} | ${entry.expectation} | ${entry.result} | ${entry.detail.replace(/\|/gu, '／')} | ${entry.file}, ${entry.file.replace(/\.png$/u, '-pane.png')} |`),
    '',
    '## 時刻の記録（ms）',
    '',
    '| fixture | ノード | parse | setState | 計測 | 配置フレーム | layoutTree | 初回配置 | 安定 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...timings.map(timing => `| ${timing.fixture} | ${timing.nodes} | ${timing.parseMs.toFixed(1)} | ${timing.stateMs.toFixed(1)} | ${timing.measureMs.toFixed(1)} | ${timing.frameMs.toFixed(1)} | ${timing.layoutMs.toFixed(1)} | ${timing.firstLayoutMs.toFixed(1)} | ${timing.settledMs.toFixed(1)} |`),
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
    'Obsidian 実機（③ E01〜E29）: このページは代替ではない。',
    'トラックパッドのピンチ・二本指スクロール、ネイティブ IME、モバイル: headless の合成入力では確認できない。',
    '性能計測（基準端末・条件・p50／p95）: `node scripts/browser-harness-perf.mjs` が `artifacts/performance/` に記録する。ここでは時刻の生値だけを残す。',
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
  const timings = [];
  const cases = await withHarnessPage(chrome, { output, window: WINDOW, fixture: OPERATION_FIXTURE, pane: PANE }, async page => {
    const recorder = new Recorder(page, directory);
    await captureFixtures(recorder, page, timings);
    await captureOperations(recorder, page);
    await writeFile(join(directory, 'timings.json'), `${JSON.stringify({ commit, chrome: chromeVersion(chrome), timings }, null, 2)}\n`);
    return recorder.cases;
  });
  const record = recordMarkdown({ startedAt: startedAt.toISOString(), chrome, version: chromeVersion(chrome), commit, cases, timings, notExecuted });
  await writeFile(join(directory, 'record.md'), record);
  const failed = cases.filter(entry => entry.result === 'FAIL').length;
  console.info(`Wrote ${relative(root, directory)} (${cases.length} cases, ${failed} failed).`);
  if (failed > 0) process.exitCode = 1;
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsScript) await main();
