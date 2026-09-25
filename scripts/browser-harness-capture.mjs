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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildBrowserHarness } from './browser-harness.mjs';
import { CdpClosedError, Page, chromeVersion, findChrome, withHarnessPage } from './browser-harness-cdp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WINDOW = { width: 1640, height: 1000 };
const PANE = { width: 1280, height: 800 };
const OPERATION_FIXTURE = 'uneven-branches';
const TOPIC_FIXTURE = 'free-topics';

const center = rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
const inside = (rect, outer, margin = 0) => rect.x >= outer.x - margin && rect.y >= outer.y - margin
  && rect.x + rect.width <= outer.x + outer.width + margin && rect.y + rect.height <= outer.y + outer.height + margin;
const worldPoint = (view, point, canvas) => ({
  x: (point.x - canvas.x - view.x) / view.scale,
  y: (point.y - canvas.y - view.y) / view.scale,
});

/** The pane's rect in page pixels: the clip for a screenshot of the map alone. */
const paneRect = page => page.evaluate(`JSON.parse(JSON.stringify(document.getElementById('harness-pane').getBoundingClientRect()))`);

/** Runs the scenario list, recording PASS/FAIL without stopping on the first failure. */
export class Recorder {
  constructor(page, directory) { this.page = page; this.directory = directory; this.cases = []; this.index = 0; }

  async run(id, operation, expectation, body) {
    this.index += 1;
    const file = `${String(this.index).padStart(2, '0')}-${id}.png`;
    const entry = { id, operation, expectation, file, result: 'PASS', detail: '' };
    try {
      const detail = await body();
      entry.detail = typeof detail === 'string' ? detail : '';
    } catch (error) {
      // A dead Chrome cannot record anything more; abort the run instead of failing every remaining case.
      if (error instanceof CdpClosedError) throw error;
      entry.result = 'FAIL';
      entry.detail = error instanceof Error ? error.message : String(error);
    }
    try {
      await this.page.settle();
      await this.page.screenshot(join(this.directory, file));
      // The pane alone at 2x keeps node text legible when the map is small.
      await this.page.screenshot(join(this.directory, file.replace(/\.png$/u, '-pane.png')), await paneRect(this.page));
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

/** `mode` opens the fixture in that layout without writing `mappy-layout`; omitted, the note (or the view's current mode) decides. */
async function loadFixture(page, id, mode) {
  const timing = await page.harness(`h.load(${JSON.stringify(id)}${mode ? `, ${JSON.stringify(mode)}` : ''})`);
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

/**
 * Right-click at `point` and choose the context-menu item titled `title`. Undo and redo go through the
 * canvas menu in these captures: headless Chrome 153 stops responding after repeated modifier-key input
 * (⌘Z, ⌘⇧Z) over CDP, and the menu items run the same map history as the keys.
 */
async function contextMenuAction(page, point, title) {
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
}

async function captureFixtures(recorder, page, timings) {
  const fixtures = await page.harness('h.fixtures');
  for (const id of fixtures) {
    await recorder.run(`fixture-${id}`, `fixture ${id} を読み込み、Fit 後の表示`, '全ノードが表示され、ペイン内に収まる', async () => {
      const timing = await loadFixture(page, id);
      timings.push(timing);
      const nodes = await page.harness('h.nodes()');
      const canvas = await page.harness('h.canvasRect()');
      // The note's own nodes; a map that calls other maps (§5 M12) shows their branches besides.
      const own = nodes.filter(node => !node.called || node.calledRoot).length;
      expect(own === timing.nodes, `DOM has ${own} own nodes, parser found ${timing.nodes}`);
      const outside = nodes.filter(node => !inside(node.rect, canvas, 2));
      expect(outside.length === 0, `${outside.length} nodes outside the canvas after Fit`);
      const view = await page.harness('h.viewport()');
      const called = nodes.length - own;
      return `${timing.nodes} ノード${called > 0 ? `（呼び出した枝 ${called} を含めて ${nodes.length}）` : ''}、scale ${view.scale.toFixed(4)}、setState ${timing.stateMs.toFixed(1)} ms、初回配置 ${timing.firstLayoutMs.toFixed(1)} ms、安定 ${timing.settledMs.toFixed(1)} ms`;
    });
  }
}

/**
 * Which side of the body root every node sits on in the balanced layout, from the DOM rects and the
 * snapshot's tree: each first-level child with its source index and side, deeper nodes that are not on
 * their first-level ancestor's side (`strays`), and the vertical centres of the root and of each side's extent.
 */
async function balancedSides(page) {
  return page.evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('.mappy-node'));
    const rects = new Map(nodes.map(node => [node.dataset.nodeId, node.getBoundingClientRect()]));
    const titles = new Map(nodes.map(node => [node.dataset.nodeId, node.querySelector('.mappy-node-label')?.textContent?.trim() ?? '']));
    const doc = window.__mappyHarness.view.snapshot().document;
    const parents = new Map(doc.nodes.map(node => [node.id, node.parentId]));
    const rootEl = nodes.find(node => node.classList.contains('is-root'));
    if (!rootEl) return { error: 'no .is-root node on screen' };
    const rootId = rootEl.dataset.nodeId;
    const root = rootEl.getBoundingClientRect();
    const children = new Map();
    for (const [id, parentId] of parents) { if (!children.has(parentId)) children.set(parentId, []); children.get(parentId).push(id); }
    const sideOf = rect => rect.x + rect.width / 2 < root.x + root.width / 2 ? 'left' : 'right';
    const stages = (children.get(rootId) ?? []).filter(id => rects.has(id)).map((id, index) => ({ id, index, title: titles.get(id), side: sideOf(rects.get(id)) }));
    const expected = new Map();
    const pending = stages.map(stage => ({ id: stage.id, side: stage.side }));
    while (pending.length > 0) { const next = pending.pop(); expected.set(next.id, next.side); for (const child of children.get(next.id) ?? []) pending.push({ id: child, side: next.side }); }
    const strays = []; let unmatched = 0; let rightCount = 0; let leftCount = 0;
    const columns = { right: [], left: [] };
    for (const [id, rect] of rects) {
      if (id === rootId) continue;
      const want = expected.get(id);
      if (!want) { unmatched += 1; continue; }
      const side = sideOf(rect);
      if (side !== want) strays.push(titles.get(id));
      if (side === 'right') rightCount += 1; else leftCount += 1;
      columns[side].push(rect);
    }
    // Each side is a column of subtrees centred on the root, so the extent of all its nodes is centred there too.
    const centre = column => column.length ? (Math.min(...column.map(r => r.top)) + Math.max(...column.map(r => r.bottom))) / 2 : NaN;
    return { stages, strays, unmatched, rightCount, leftCount, rootCentre: root.top + root.height / 2, rightCentre: centre(columns.right), leftCentre: centre(columns.left) };
  })()`).then(result => { expect(!result.error, result.error); return result; });
}

/** The harness's description of the node with this title (rect, toggle, flags); missing nodes fail the case. */
async function nodeInfo(page, name) {
  const node = await page.harness(`h.node(${JSON.stringify(name)})`);
  expect(node, `Node not found: ${name}`);
  return node;
}

/** Click the node with this title and press F2; the case fails unless the inline editor holds the focus. */
async function openInlineEditor(page, name) {
  const node = await nodeInfo(page, name);
  await page.click(center(node.rect).x, center(node.rect).y);
  await page.key('F2', 'F2', 113);
  const editing = await page.evaluate(`document.activeElement?.classList.contains('mappy-inline-input')`);
  expect(editing, 'inline editor did not take focus');
}

async function captureOperations(recorder, page) {
  await loadFixture(page, OPERATION_FIXTURE);
  const title = '多数の兄弟';
  const nodeRect = name => nodeInfo(page, name);

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

  await recorder.run('hierarchy', '左下の「階層図」', 'ルートが上、同じ親の子が同じ段、親の下辺から子までの隙間が深さごとに一定で、ノード数は変わらない。`mappy-layout: hierarchy` が書かれる', async () => {
    const before = (await page.harness('h.nodes()')).length;
    const button = await page.harness('h.button("階層図")');
    expect(button, 'hierarchy button missing');
    await page.click(center(button).x, center(button).y);
    await page.settle();
    const hierarchy = await page.evaluate(`document.querySelectorAll('.mappy-node.is-hierarchy').length`);
    expect(hierarchy === before, `${hierarchy} hierarchy nodes of ${before}`);
    // Same parent ⇒ same top edge, every child one gap under its own parent (the same gap for
    // every parent of a depth, whatever the parents measure), and the root above every other node.
    const rows = await page.evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll('.mappy-node'));
      const rects = new Map(nodes.map(node => [node.dataset.nodeId, node.getBoundingClientRect()]));
      const parents = new Map(window.__mappyHarness.view.snapshot().document.nodes.map(node => [node.id, node.parentId]));
      const rootEl = nodes.find(node => node.classList.contains('is-root'));
      const root = rootEl?.getBoundingClientRect();
      const below = root ? nodes.filter(node => node !== rootEl && node.getBoundingClientRect().top < root.bottom).length : null;
      const byParent = new Map();
      for (const node of nodes) {
        const parentId = parents.get(node.dataset.nodeId);
        const parent = rects.get(parentId);
        if (!parent) continue;
        const rect = node.getBoundingClientRect();
        const entry = byParent.get(parentId) ?? { level: node.getAttribute('aria-level'), tops: new Set(), gaps: [] };
        entry.tops.add(Math.round(rect.top * 10) / 10);
        entry.gaps.push(rect.top - parent.bottom);
        byParent.set(parentId, entry);
      }
      return { below, parents: [...byParent].map(([id, entry]) => ({ id, level: entry.level, rows: entry.tops.size, gaps: entry.gaps })) };
    })()`);
    expect(rows.below !== null, 'root node missing');
    expect(rows.below === 0, `${rows.below} nodes above the root's bottom edge`);
    // Every visible non-root node must have been matched to a parent rect; otherwise the checks below would pass on nothing.
    const measured = rows.parents.reduce((count, entry) => count + entry.gaps.length, 0);
    expect(measured === hierarchy - 1, `${measured} of ${hierarchy - 1} children matched to a parent (ids of the snapshot and the DOM differ?)`);
    const split = rows.parents.filter(entry => entry.rows !== 1).map(entry => entry.id);
    expect(split.length === 0, `parents whose children sit on more than one row: ${JSON.stringify(split)}`);
    // Node heights are measured as integers (offsetHeight) while the rects are fractional, so allow a pixel of rounding.
    const { scale } = await page.harness('h.viewport()');
    const gapByLevel = new Map();
    for (const entry of rows.parents) gapByLevel.set(entry.level, [...(gapByLevel.get(entry.level) ?? []), ...entry.gaps.map(gap => gap / scale)]);
    const uneven = [...gapByLevel].filter(([, gaps]) => Math.max(...gaps) - Math.min(...gaps) > 1.5).map(([level, gaps]) => `${level}: ${Math.min(...gaps).toFixed(1)}–${Math.max(...gaps).toFixed(1)}`);
    expect(uneven.length === 0, `gap under the parents differs within a depth: ${uneven.join(', ')}`);
    const activity = await page.harness('h.activity');
    expect(activity.some(entry => entry.kind === 'frontmatter' && entry.detail.includes('"mappy-layout":"hierarchy"')), 'hierarchy preference was not written through processFrontMatter');
    const gaps = [...gapByLevel].map(([level, values]) => `${level}: ${(values.reduce((sum, gap) => sum + gap, 0) / values.length).toFixed(1)}`).join(', ');
    return `${hierarchy} nodes, ${rows.parents.length} parents each with one row of children, gap by aria-level (px) ${gaps}`;
  });

  await recorder.run('hierarchy-collapse', `階層図で「${title}」の開閉ボタン`, '24 の件数がノードの下に出て、ノードが減り、再展開で戻る', async () => {
    const before = (await page.harness('h.nodes()')).length;
    const node = await nodeRect(title);
    expect(node.toggle, 'fold control missing');
    await page.click(center(node.toggle).x, center(node.toggle).y);
    await page.settle();
    try {
      const after = await nodeRect(title);
      expect(after.collapsed, 'node did not collapse');
      const badge = await page.evaluate(`document.querySelector('.mappy-node.is-collapsed .mappy-node-toggle-mark')?.textContent`);
      expect(badge === '24', `badge shows ${badge}`);
      // In the hierarchy the badge hangs under the node rather than beside it.
      expect(after.toggle.y > after.rect.y + after.rect.height - 1, 'badge is not below the node');
      const count = (await page.harness('h.nodes()')).length;
      expect(count === before - 24, `${count} nodes after collapsing 24`);
      return `badge ${badge}, ${before} → ${count} nodes`;
    } finally {
      // Re-expand even after a failed check so the later cases start from the full map.
      const current = await nodeRect(title);
      if (current.collapsed && current.toggle) {
        await page.click(center(current.toggle).x, center(current.toggle).y);
        await page.settle();
      }
      const restored = (await page.harness('h.nodes()')).length;
      expect(restored === before, `${restored} nodes after re-expanding`);
    }
  });

  await recorder.run('balanced', '左下の「左右バランス」', 'ルートが中央、第一階層が原文順に右・左・右・左、下位はその側へ伸び、ノード数は変わらない。`mappy-layout: balanced` が書かれる', async () => {
    const before = (await page.harness('h.nodes()')).length;
    const button = await page.harness('h.button("左右バランス")');
    expect(button, 'balanced button missing');
    await page.click(center(button).x, center(button).y);
    await page.settle();
    const balanced = await page.evaluate(`document.querySelectorAll('.mappy-node.is-balanced').length`);
    expect(balanced === before, `${balanced} balanced nodes of ${before}`);
    const sides = await balancedSides(page);
    expect(sides.stages.length > 1, 'the root has fewer than two children');
    // First level: even source indices right of the root, odd ones left; deeper nodes on their branch's side.
    const wrongStage = sides.stages.filter(stage => stage.side !== (stage.index % 2 === 0 ? 'right' : 'left'));
    expect(wrongStage.length === 0, `stages on the wrong side: ${JSON.stringify(wrongStage.map(stage => `${stage.index}:${stage.title}`))}`);
    expect(sides.strays.length === 0, `deeper nodes off their branch's side: ${JSON.stringify(sides.strays)}`);
    expect(sides.unmatched === 0, `${sides.unmatched} nodes without a first-level ancestor (ids of the snapshot and the DOM differ?)`);
    // The root sits between the two columns, vertically centred on each.
    expect(Math.abs(sides.rightCentre - sides.rootCentre) < 1.5 && Math.abs(sides.leftCentre - sides.rootCentre) < 1.5,
      `columns not centred on the root: root ${sides.rootCentre.toFixed(1)}, right ${sides.rightCentre.toFixed(1)}, left ${sides.leftCentre.toFixed(1)}`);
    const activity = await page.harness('h.activity');
    expect(activity.some(entry => entry.kind === 'frontmatter' && entry.detail.includes('"mappy-layout":"balanced"')), 'balanced preference was not written through processFrontMatter');
    return `${balanced} nodes, 第一階層 ${sides.stages.map(stage => `${stage.index}:${stage.side === 'right' ? '右' : '左'}`).join(' ')}、右 ${sides.rightCount} / 左 ${sides.leftCount} ノード`;
  });

  await recorder.run('balanced-collapse', `左右バランスで左側の「${title}」の開閉ボタン`, '24 の件数がノードの左に出て、ノードが減り、右側の枝は動かず、再展開で戻る', async () => {
    const before = await page.harness('h.nodes()');
    const node = await nodeRect(title);
    expect(node.toggle, 'fold control missing');
    // The fold control of a left-side parent sits on its left stem.
    expect(node.toggle.x + node.toggle.width / 2 < node.rect.x, 'fold control is not left of the node');
    const root = await nodeRect('不均等な枝');
    const rightSide = before.filter(item => item.rect.x > root.rect.x + root.rect.width).map(item => [item.id, item.rect.x, item.rect.y]);
    expect(rightSide.length > 0, 'no nodes right of the root');
    await page.click(center(node.toggle).x, center(node.toggle).y);
    await page.settle();
    try {
      const after = await nodeRect(title);
      expect(after.collapsed, 'node did not collapse');
      const badge = await page.evaluate(`document.querySelector('.mappy-node.is-collapsed .mappy-node-toggle-mark')?.textContent`);
      expect(badge === '24', `badge shows ${badge}`);
      expect(after.toggle.x + after.toggle.width < after.rect.x + 1, 'badge is not left of the node');
      const nodes = await page.harness('h.nodes()');
      expect(nodes.length === before.length - 24, `${nodes.length} nodes after collapsing 24`);
      // Folding a left branch leaves the right column where it was.
      const moved = rightSide.filter(([id, x, y]) => { const now = nodes.find(item => item.id === id); return !now || Math.abs(now.rect.x - x) > 0.5 || Math.abs(now.rect.y - y) > 0.5; });
      expect(moved.length === 0, `${moved.length} right-side nodes moved when a left branch folded`);
      return `badge ${badge} 左側、${before.length} → ${nodes.length} nodes、右側 ${rightSide.length} ノードは不動`;
    } finally {
      const current = await nodeRect(title);
      if (current.collapsed && current.toggle) {
        await page.click(center(current.toggle).x, center(current.toggle).y);
        await page.settle();
      }
      const restored = (await page.harness('h.nodes()')).length;
      expect(restored === before.length, `${restored} nodes after re-expanding`);
    }
  });

  await recorder.run('balanced-scene', '左右バランスの表示から Excalidraw 挿入のシーンを組み立てる', '各ノードのブロックがマップ上の位置（ルート基準）と一致し、左側のブロックはルートの左、線は直角の折れ線', async () => {
    const scene = await page.harness('h.scene()');
    expect(scene && scene.mode === 'balanced', `scene mode ${scene?.mode}`);
    const view = await page.harness('h.viewport()');
    const canvas = await page.harness('h.canvasRect()');
    const nodes = await page.harness('h.nodes()');
    const rootNode = nodes.find(item => item.id === scene.visualRootId);
    const rootBlock = scene.blocks.find(block => block.id === scene.visualRootId);
    expect(rootNode && rootBlock, 'root missing from the scene or the DOM');
    const rootWorld = worldPoint(view, rootNode.rect, canvas);
    let compared = 0;
    let left = 0;
    for (const block of scene.blocks) {
      const node = nodes.find(item => item.id === block.id);
      expect(node, `scene block ${block.id} has no node on screen`);
      const world = worldPoint(view, node.rect, canvas);
      const dx = (block.x - rootBlock.x) - (world.x - rootWorld.x);
      const dy = (block.y - rootBlock.y) - (world.y - rootWorld.y);
      expect(Math.abs(dx) < 1.5 && Math.abs(dy) < 1.5, `${node.title}: scene offset differs from the map by (${dx.toFixed(2)}, ${dy.toFixed(2)})`);
      compared += 1;
      if (block.x + block.width < rootBlock.x) left += 1;
    }
    expect(compared === nodes.length && compared === scene.blocks.length, `${compared} blocks compared for ${nodes.length} nodes and ${scene.blocks.length} blocks`);
    expect(left > 0, 'no block left of the root in the scene');
    expect(scene.lines.length === scene.blocks.length - 1, `${scene.lines.length} lines for ${scene.blocks.length} blocks`);
    const bent = scene.lines.filter(line => line.some((point, index) => index > 0 && point[0] !== line[index - 1][0] && point[1] !== line[index - 1][1]));
    expect(bent.length === 0, `${bent.length} lines with a diagonal segment`);
    return `${compared} ブロックの位置がマップと一致（許容 1.5px）、左側 ${left} ブロック、線 ${scene.lines.length} 本すべて直角`;
  });

  await recorder.run('timeline-back', '左下の「通常マップ」', '通常マップへ戻る。任意キー `mappy-layout` が消える', async () => {
    const button = await page.harness('h.button("通常マップ")');
    await page.click(center(button).x, center(button).y);
    await page.settle();
    const timeline = await page.evaluate(`document.querySelectorAll('.mappy-node.is-timeline, .mappy-node.is-hierarchy, .mappy-node.is-balanced').length`);
    expect(timeline === 0, `${timeline} nodes still in timeline, hierarchy or balanced`);
    const activity = await page.harness('h.activity');
    const last = [...activity].reverse().find(entry => entry.kind === 'frontmatter');
    expect(last && !last.detail.includes('mappy-layout'), `layout key still present: ${last?.detail}`);
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

  // The 操作 popover (§5 M3): the card's items as `title（description）`, a disabled one in brackets.
  const popoverEntries = () => page.evaluate(`Array.from(document.querySelectorAll('.mappy-view .mappy-popover [role="menuitem"]'), item => {
    const text = item.querySelector('.mappy-popover-title')?.textContent + '（' + item.querySelector('.mappy-popover-description')?.textContent + '）';
    return item.getAttribute('aria-disabled') === 'true' ? '[' + text + ']' : text;
  })`);
  const popoverRect = () => page.evaluate(`JSON.parse(JSON.stringify(document.querySelector('.mappy-view .mappy-popover')?.getBoundingClientRect() ?? null))`);
  const popoverCount = () => page.evaluate(`document.querySelectorAll('.mappy-popover').length`);
  const focusedTitle = () => page.evaluate(`document.activeElement?.classList.contains('mappy-canvas') ? 'canvas' : document.activeElement?.querySelector('.mappy-popover-title')?.textContent ?? document.activeElement?.tagName ?? null`);
  /** The card under the gear, its right edge on the gear's, inside the pane and at most 320px wide. */
  const expectPlaced = (card, gear, canvas) => {
    expect(card, 'no popover open');
    expect(card.y >= gear.y + gear.height, `card top ${card.y} is not under the gear's bottom ${gear.y + gear.height}`);
    expect(Math.abs(card.x + card.width - (gear.x + gear.width)) <= 1, `card right edge ${card.x + card.width} is not aligned with the gear's ${gear.x + gear.width}`);
    expect(card.width <= 320 && card.width >= 200, `card width ${card.width} is not within 200–320`);
    expect(inside(card, canvas), `card ${JSON.stringify(card)} is not inside the pane ${JSON.stringify(canvas)}`);
  };
  /**
   * Each row's left edge, width, padding and icon left edge (null without an icon), with the card's inner width
   * (clientWidth: no border, no scrollbar) and padding (LEV-84: app.css centres a button's content).
   */
  const popoverRows = () => page.evaluate(`(() => {
    const card = document.querySelector('.mappy-view .mappy-popover');
    const rows = Array.from(card?.querySelectorAll('[role="menuitem"]') ?? [], item => {
      const row = item.getBoundingClientRect();
      const icon = item.querySelector('.mappy-popover-icon')?.getBoundingClientRect() ?? null;
      return { left: row.left, width: row.width, paddingLeft: parseFloat(getComputedStyle(item).paddingLeft), iconLeft: icon ? icon.left : null };
    });
    return { rows, innerWidth: card?.clientWidth ?? 0, padding: card ? parseFloat(getComputedStyle(card).paddingLeft) : 0 };
  })()`);
  /** Three rows, each as wide as the card's inside and starting at its left edge, every icon at the row's padding. */
  const expectAligned = ({ rows, innerWidth, padding }, card) => {
    expect(rows.length === 3, `${rows.length} rows`);
    expect(rows.every(row => row.iconLeft !== null), 'a row has no icon');
    const distinct = key => [...new Set(rows.map(row => Math.round(row[key] * 10) / 10))];
    for (const key of ['left', 'width', 'iconLeft']) expect(distinct(key).length === 1, `${key} differs between the rows: ${distinct(key).join(' / ')}`);
    const [row] = rows;
    expect(row.iconLeft - row.left <= row.paddingLeft + 1, `icon left ${row.iconLeft} is not at the row's left edge ${row.left} + padding ${row.paddingLeft} (centred?)`);
    expect(Math.abs(row.left - card.x - padding) <= 2, `row left ${row.left} is not at the card's left edge ${card.x} + padding ${padding}`);
    expect(row.width >= innerWidth - 2 * padding - 1, `row width ${row.width} is narrower than the card's inside ${innerWidth} minus its padding ${padding}`);
    return `行の左 ${Math.round(row.left)}・幅 ${Math.round(row.width)}・アイコンの左 ${Math.round(row.iconLeft)} が 3 行とも同じ`;
  };

  await recorder.run('action-popover', '右上の歯車「操作」をクリック → ↓ → Escape → クリック → クリック → クリック → Escape', '右上のボタンは歯車 1 つ。歯車の直下に右辺を揃えたカード（Obsidian の .menu ではない）が開き、項目は Markdown に切り替え／マップを検索して呼び出す／書き出す の 3 つ（アイコン・項目名・1 行の説明）だけ、すべて有効。3 行の左端・幅・アイコンの左端が同じ（Obsidian の button は中身を中央寄せにするが、行は左詰め）。開いた直後は 1 項目目にフォーカス、↓ で 2 項目目、Escape で閉じてキャンバスにフォーカス。2 度目の押下で閉じ（aria-expanded=false）、3 度目で開く', async () => {
    const labels = await page.evaluate(`Array.from(document.querySelectorAll('.mappy-actions .mappy-button'), button => button.getAttribute('aria-label'))`);
    expect(labels.length === 1 && labels[0] === '操作', `top-right buttons: ${labels.join(' / ')}`);
    const gear = await page.harness('h.button("操作")');
    await page.click(center(gear).x, center(gear).y);
    const entries = await popoverEntries();
    expect(JSON.stringify(entries) === JSON.stringify(['Markdown に切り替え（同じタブで本文を開く）', 'マップを検索して呼び出す（他のマップを挿入する）', '書き出す（SVG／PNG に保存）']),
      `popover entries: ${entries.join(' / ')}`);
    expect((await page.evaluate(`document.querySelectorAll('.menu').length`)) === 0, 'an Obsidian menu opened as well');
    expect((await page.evaluate(`document.querySelector('.mappy-actions button')?.getAttribute('aria-expanded')`)) === 'true', 'aria-expanded is not true while open');
    const icons = await page.evaluate(`Array.from(document.querySelectorAll('.mappy-popover .mappy-popover-icon'), icon => icon.dataset.icon)`);
    expect(JSON.stringify(icons) === JSON.stringify(['file-text', 'search', 'image-down']), `icons: ${icons.join(' / ')}`);
    const card = await popoverRect();
    expectPlaced(card, gear, await page.harness('h.canvasRect()'));
    const aligned = expectAligned(await popoverRows(), card);
    expect((await focusedTitle()) === 'Markdown に切り替え', `focus after opening: ${await focusedTitle()}`);
    await page.screenshot(join(recorder.directory, 'action-popover-open.png'));
    await page.key('ArrowDown', 'ArrowDown', 40);
    expect((await focusedTitle()) === 'マップを検索して呼び出す', `focus after ↓: ${await focusedTitle()}`);
    await page.key('Escape', 'Escape', 27);
    expect((await popoverCount()) === 0, 'popover still open after Escape');
    expect((await focusedTitle()) === 'canvas', `focus after Escape: ${await focusedTitle()}`);
    // The gear's next press closes the card; the one after opens it again.
    await page.click(center(gear).x, center(gear).y);
    expect((await popoverCount()) === 1, 'popover did not open on the second press of the gear');
    await page.click(center(gear).x, center(gear).y);
    expect((await popoverCount()) === 0, 'popover still open after the third press of the gear');
    expect((await page.evaluate(`document.querySelector('.mappy-actions button')?.getAttribute('aria-expanded')`)) === 'false', 'aria-expanded is not false after closing');
    await page.click(center(gear).x, center(gear).y);
    expect((await popoverCount()) === 1, 'popover did not open on the fourth press of the gear');
    // A press on the map closes it and the canvas takes the focus.
    const canvas = await page.harness('h.canvasRect()');
    await page.click(canvas.x + 30, canvas.y + 30);
    expect((await popoverCount()) === 0, 'popover still open after a press on the map');
    expect((await focusedTitle()) === 'canvas', `focus after the press outside: ${await focusedTitle()}`);
    return `項目: ${entries.join(' / ')}。${aligned}`;
  });

  await recorder.run('action-popover-narrow', 'ペインを 400×700 にして歯車をクリック → Escape → 1280×800 に戻す', '幅 400px のペインでもカードの左辺がペインの左端を越えず、右辺は歯車の右辺に揃い、幅は 320px 以下。3 行の左端・幅・アイコンの左端は同じ', async () => {
    await page.harness('h.resize(400, 700)');
    await page.settle();
    const canvas = await page.harness('h.canvasRect()');
    expect(Math.abs(canvas.width - 400) <= 2, `canvas is ${canvas.width} wide`);
    const gear = await page.harness('h.button("操作")');
    await page.click(center(gear).x, center(gear).y);
    const card = await popoverRect();
    expectPlaced(card, gear, canvas);
    expect(card.x >= canvas.x + 8, `card left edge ${card.x} is too close to the pane's ${canvas.x}`);
    const aligned = expectAligned(await popoverRows(), card);
    await page.screenshot(join(recorder.directory, 'action-popover-narrow-open.png'));
    await page.key('Escape', 'Escape', 27);
    expect((await popoverCount()) === 0, 'popover still open after Escape');
    await page.harness(`h.resize(${PANE.width}, ${PANE.height})`);
    await page.settle();
    const fit = await page.harness('h.button("全体表示")');
    await page.click(center(fit).x, center(fit).y);
    await page.settle();
    return `card ${Math.round(card.width)}×${Math.round(card.height)} at x=${Math.round(card.x)} in a ${Math.round(canvas.width)}px pane。${aligned}`;
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
    await openInlineEditor(page, target);
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

  await recorder.run('fold-2000-balanced', 'performance-2000 を左右バランスで開き、左側の「第2節」へ寄って分岐点を閉じる → Space で開く', '100 の節が右・左に 50 ずつ、19 ノードが隠れ、再展開で戻る', async () => {
    const timing = await loadFixture(page, 'performance-2000', 'balanced');
    // A layout switch through the view state keeps the viewport, so start from the whole map like a fresh open.
    const fit = await page.harness('h.button("全体表示")');
    await page.click(center(fit).x, center(fit).y);
    await page.settle();
    const before = (await page.harness('h.nodes()')).length;
    expect(before === timing.nodes, `DOM has ${before} nodes, parser found ${timing.nodes}`);
    const sides = await balancedSides(page);
    expect(sides.stages.length === 100 && sides.stages.filter(stage => stage.side === 'right').length === 50, `stages: ${sides.stages.length}, right ${sides.stages.filter(stage => stage.side === 'right').length}`);
    expect(sides.strays.length === 0 && sides.unmatched === 0, `${sides.strays.length} strays, ${sides.unmatched} unmatched`);
    let node = await nodeRect('第2節');
    for (let step = 0; step < 12 && (await page.harness('h.viewport()')).scale < 0.8; step += 1) {
      const point = center(node.rect);
      await page.wheel(point.x, point.y, 0, -200, 2);
      node = await nodeRect('第2節');
    }
    expect(node.toggle, 'fold control missing on 第2節');
    expect(node.toggle.x + node.toggle.width / 2 < node.rect.x, 'fold control of the left-side 第2節 is not on its left');
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
    expect(!(await page.harness('h.source()')).includes('mappy-layout'), 'opening through the view state wrote mappy-layout');
    return `初回配置 ${timing.firstLayoutMs.toFixed(1)} ms、安定 ${timing.settledMs.toFixed(1)} ms、${before} → ${folded} → ${restored}、閉じてから安定まで約 ${foldMs} ms（settle の待ち時間込み）`;
  });
}

/**
 * M8 rows (LEV-46) on heading-document: the stages「回復する」「記録する」carry images, so
 * their children hang lower, while「はじめに」→「この講座で学ぶこと」keeps a connector as
 * long as the row gap. Before the fix every depth-2 node sat under the tallest stage.
 */
async function captureHierarchyRows(recorder, page) {
  const nodeRect = async name => (await nodeInfo(page, name)).rect;
  const gapBelow = (parent, child) => child.y - (parent.y + parent.height);
  await recorder.run('hierarchy-rows', 'heading-document を階層図にする', '兄弟は同じ上辺。画像付きの「回復する」「記録する」の子だけが下がり、「はじめに」→「この講座で学ぶこと」の隙間は画像付きの親の子と同じ長さ', async () => {
    await loadFixture(page, 'heading-document');
    const button = await page.harness('h.button("階層図")');
    expect(button, 'hierarchy button missing');
    await page.click(center(button).x, center(button).y);
    await page.settle();
    const { scale } = await page.harness('h.viewport()');
    const stages = await Promise.all(['はじめに', '回復する', '記録する', '習慣化する'].map(nodeRect));
    const tops = stages.map(rect => rect.y);
    expect(Math.max(...tops) - Math.min(...tops) < 1, `stage tops differ: ${tops.map(top => top.toFixed(1)).join(', ')}`);
    const [intro, recover, record] = stages;
    const [introChild, recoverChild, recordChild] = await Promise.all(['この講座で学ぶこと', '休息', 'ふりかえる'].map(nodeRect));
    expect(recover.height > intro.height + 40 * scale, `回復する (${recover.height.toFixed(1)}) is not taller than はじめに (${intro.height.toFixed(1)}) by an image`);
    // Gaps in layout px; node heights are measured as integers, so a pixel of rounding is allowed.
    const gaps = [gapBelow(intro, introChild), gapBelow(recover, recoverChild), gapBelow(record, recordChild)].map(gap => gap / scale);
    expect(Math.max(...gaps) - Math.min(...gaps) <= 1.5, `row gaps differ: ${gaps.map(gap => gap.toFixed(1)).join(', ')}`);
    expect(recoverChild.y > introChild.y + 40 * scale, `休息 (${recoverChild.y.toFixed(1)}) does not hang lower than この講座で学ぶこと (${introChild.y.toFixed(1)})`);
    return `段間 ${gaps.map(gap => gap.toFixed(1)).join(' / ')} px（はじめに / 回復する / 記録する の下、scale ${scale.toFixed(3)}）、休息 は この講座で学ぶこと より ${((recoverChild.y - introChild.y) / scale).toFixed(1)} px 下`;
  });

  // Runs even when the case above failed, so the fixture is left as it was loaded (as `timeline-back` does for uneven-branches).
  await recorder.run('hierarchy-rows-back', '左下の「通常マップ」', 'heading-document が通常マップへ戻り、任意キー `mappy-layout` が消える', async () => {
    const button = await page.harness('h.button("通常マップ")');
    expect(button, 'map button missing');
    await page.click(center(button).x, center(button).y);
    await page.settle();
    const remaining = await page.evaluate(`document.querySelectorAll('.mappy-node.is-hierarchy').length`);
    expect(remaining === 0, `${remaining} nodes still in the hierarchy`);
    const last = [...await page.harness('h.activity')].reverse().find(entry => entry.kind === 'frontmatter');
    expect(last && !last.detail.includes('mappy-layout'), `layout key still present: ${last?.detail}`);
  });
}

/** Computed colours that tell the two placeholder palettes apart: the page, the map canvas, one node and one link. */
async function themeColors(page) {
  return page.evaluate(`(() => {
    const color = (element, property) => element ? getComputedStyle(element)[property] : null;
    const pane = document.getElementById('harness-pane');
    const node = pane.querySelector('.mappy-node:not(.is-root)');
    return {
      page: color(document.body, 'backgroundColor'),
      canvas: color(pane.querySelector('.mappy-canvas'), 'backgroundColor'),
      text: color(node, 'color'),
      link: color(pane.querySelector('.mappy-node a.internal-link'), 'color'),
      scheme: color(pane.querySelector('.mappy-view'), 'colorScheme'),
    };
  })()`);
}

/**
 * The inline input on one node, opened with F2 (LEV-93): its computed text, caret and selection colours,
 * photographed while it is open (`<case>-inline-pane.png`), then cancelled with Escape so the node is unchanged.
 * The caret is a property app.css (and harness.css) fixes on body, so it shows whether the map container
 * re-reads it; the selection reads `--text-selection` from the input itself.
 */
async function inlineInputColors(recorder, page, id) {
  try {
    await openInlineEditor(page, '空に近い枝');
    await page.settle();
    const colors = await page.evaluate(`(() => {
      const input = document.getElementById('harness-pane').querySelector('.mappy-inline-input');
      const style = getComputedStyle(input);
      return { text: style.color, caret: style.caretColor, selection: getComputedStyle(input, '::selection').backgroundColor };
    })()`);
    await page.screenshot(join(recorder.directory, `${String(recorder.index).padStart(2, '0')}-${id}-inline-pane.png`), await paneRect(page));
    return colors;
  } finally {
    // Whatever was measured, the later cases must not find the editor open, and it must cancel rather than commit on
    // blur: Escape goes to the editor itself, which takes the focus back first if something else got it.
    if (await page.evaluate(`(() => { const input = document.getElementById('harness-pane').querySelector('.mappy-inline-input'); if (input) input.focus(); return input !== null; })()`)) {
      await page.key('Escape', 'Escape', 27);
      await page.settle();
    }
  }
}

/** The inline input's colours against one palette: caret and text the palette's text colour, selection its selection colour. */
function expectInlineInput(inline, palette, where) {
  expect(inline.caret === palette.text && inline.text === palette.text, `${where}: inline input caret ${inline.caret}, text ${inline.text}`);
  expect(inline.selection === palette.selection, `${where}: inline input selection ${inline.selection}`);
}

/** The harness palettes (harness.css, stand-ins laid out like app.css): what each theme should resolve to. */
const PALETTE = {
  light: { background: 'rgb(255, 255, 255)', page: 'rgb(246, 246, 246)', text: 'rgb(34, 34, 34)', selection: 'rgba(138, 92, 245, 0.2)' },
  dark: { background: 'rgb(30, 30, 30)', page: 'rgb(38, 38, 38)', text: 'rgb(218, 218, 218)', selection: 'rgba(138, 92, 245, 0.25)' },
};

/**
 * M14 (LEV-60): the settings' theme puts `theme-light` / `theme-dark` on the map container only,
 * and styles.css re-derives the palette there. Each combination of page theme and map theme is
 * checked by computed colour — the inline input's caret and selection too (LEV-93) — then left
 * as it was (page light, map following the page).
 */
async function captureThemes(recorder, page) {
  await loadFixture(page, OPERATION_FIXTURE);
  let lightLink = null;
  await recorder.run('theme-follow-light', 'ページ明色、マップ「Obsidian に従う」（既定）→ F2 でインライン入力 → Escape', 'コンテナに theme class がなく、キャンバスはページと同じ明色の配色。インライン入力のキャレット・選択色も明色のまま', async () => {
    await page.harness('h.setPageTheme("light")');
    await page.harness('h.setMapTheme("follow")');
    await page.settle();
    const themes = await page.harness('h.themes()');
    expect(themes.container.length === 0, `container carries ${themes.container.join(' ')}`);
    const colors = await themeColors(page);
    expect(colors.canvas === PALETTE.light.background && colors.text === PALETTE.light.text, `canvas ${colors.canvas}, text ${colors.text}`);
    expect(colors.link, 'no internal link rendered in a node');
    lightLink = colors.link;
    const inline = await inlineInputColors(recorder, page, 'theme-follow-light');
    expectInlineInput(inline, PALETTE.light, 'follow');
    return `canvas ${colors.canvas}, text ${colors.text}, link ${colors.link}, color-scheme ${colors.scheme}, インライン入力 caret ${inline.caret}・selection ${inline.selection}`;
  });

  await recorder.run('theme-dark-on-light', 'ページ明色のまま、マップ「暗色」→ F2 でインライン入力 → Escape →「閉じて開き直す」→ もう一度 F2 → Escape', 'コンテナだけが theme-dark。キャンバス・文字・リンク、インライン入力のキャレット・選択色が暗色の配色になり、ページの背景は明色のまま。開き直しても class とキャンバス、インライン入力の色が保たれる', async () => {
    await page.harness('h.setMapTheme("dark")');
    await page.settle();
    let themes = await page.harness('h.themes()');
    expect(themes.container.join(' ') === 'theme-dark' && themes.page === 'light', `container ${themes.container.join(' ')}, page ${themes.page}`);
    let colors = await themeColors(page);
    expect(colors.canvas === PALETTE.dark.background, `canvas ${colors.canvas}`);
    expect(colors.text === PALETTE.dark.text, `text ${colors.text}`);
    expect(colors.page === PALETTE.light.page, `page background ${colors.page}`);
    expect(colors.link && colors.link !== lightLink, `link ${colors.link} did not change from ${lightLink}`);
    expect(colors.scheme === 'dark', `color-scheme ${colors.scheme}`);
    const darkLink = colors.link;
    // The caret is what the page (body) fixed for its own light theme unless the container re-reads it (LEV-93).
    const inline = await inlineInputColors(recorder, page, 'theme-dark-on-light');
    expectInlineInput(inline, PALETTE.dark, 'dark map on a light page');
    await page.harness('h.reopen()');
    await page.settle();
    themes = await page.harness('h.themes()');
    colors = await themeColors(page);
    expect(themes.container.join(' ') === 'theme-dark' && colors.canvas === PALETTE.dark.background, `after reopen: ${themes.container.join(' ')}, canvas ${colors.canvas}`);
    const reopened = await inlineInputColors(recorder, page, 'theme-dark-on-light-reopened');
    expectInlineInput(reopened, PALETTE.dark, 'dark map on a light page, after reopen');
    return `canvas ${colors.canvas}, text ${colors.text}, link ${darkLink}（明色時 ${lightLink}）, page ${colors.page}, color-scheme ${colors.scheme}, インライン入力 caret ${inline.caret}・selection ${inline.selection}（ページの明色は ${PALETTE.light.text}・${PALETTE.light.selection}）, 開き直し後も theme-dark で caret ${reopened.caret}・selection ${reopened.selection}`;
  });

  await recorder.run('theme-light-on-dark', 'ページ暗色、マップ「明色」→ F2 でインライン入力 → Escape', 'コンテナだけが theme-light。キャンバス・文字、インライン入力のキャレット・選択色が明色の配色になり、ページの背景は暗色', async () => {
    await page.harness('h.setPageTheme("dark")');
    await page.harness('h.setMapTheme("light")');
    await page.settle();
    const themes = await page.harness('h.themes()');
    expect(themes.container.join(' ') === 'theme-light' && themes.page === 'dark', `container ${themes.container.join(' ')}, page ${themes.page}`);
    const colors = await themeColors(page);
    expect(colors.canvas === PALETTE.light.background, `canvas ${colors.canvas}`);
    expect(colors.text === PALETTE.light.text, `text ${colors.text}`);
    expect(colors.page === PALETTE.dark.page, `page background ${colors.page}`);
    expect(colors.link === lightLink, `link ${colors.link} differs from the light page's ${lightLink}`);
    expect(colors.scheme === 'light', `color-scheme ${colors.scheme}`);
    const inline = await inlineInputColors(recorder, page, 'theme-light-on-dark');
    expectInlineInput(inline, PALETTE.light, 'light map on a dark page');
    return `canvas ${colors.canvas}, text ${colors.text}, link ${colors.link}, page ${colors.page}, color-scheme ${colors.scheme}, インライン入力 caret ${inline.caret}・selection ${inline.selection}（ページの暗色は ${PALETTE.dark.text}・${PALETTE.dark.selection}）`;
  });

  await recorder.run('theme-follow-dark', 'ページ暗色のまま、マップ「Obsidian に従う」→ F2 でインライン入力 → Escape', 'theme class が外れ、キャンバスとインライン入力のキャレット・選択色がページと同じ暗色に戻る', async () => {
    await page.harness('h.setMapTheme("follow")');
    await page.settle();
    const themes = await page.harness('h.themes()');
    expect(themes.container.length === 0, `container carries ${themes.container.join(' ')}`);
    const colors = await themeColors(page);
    expect(colors.canvas === PALETTE.dark.background && colors.text === PALETTE.dark.text, `canvas ${colors.canvas}, text ${colors.text}`);
    expect(colors.page === PALETTE.dark.page, `page background ${colors.page}`);
    const inline = await inlineInputColors(recorder, page, 'theme-follow-dark');
    expectInlineInput(inline, PALETTE.dark, 'follow');
    return `canvas ${colors.canvas}, text ${colors.text}, page ${colors.page}, インライン入力 caret ${inline.caret}・selection ${inline.selection}`;
  });

  // Runs even when a case above failed, so the later cases see the page as they always did.
  await recorder.run('theme-back', 'ページ明色、マップ「Obsidian に従う」に戻す', '最初の状態（明色、theme class なし）に戻る', async () => {
    await page.harness('h.setPageTheme("light")');
    await page.harness('h.setMapTheme("follow")');
    await page.settle();
    const themes = await page.harness('h.themes()');
    const colors = await themeColors(page);
    expect(themes.container.length === 0 && themes.page === 'light', `container ${themes.container.join(' ')}, page ${themes.page}`);
    expect(colors.canvas === PALETTE.light.background && colors.page === PALETTE.light.page, `canvas ${colors.canvas}, page ${colors.page}`);
  });
}

/** The bar as the page reports it, in one line for the record. */
function describeButtons(buttons) {
  return buttons.map(button => `${button.label}${button.hidden ? '（hidden）' : ''}${button.active ? '＝選択中' : ''}`).join('・');
}

/**
 * M14 (LEV-76): the settings' list of visible layouts hides buttons on the bottom-left bar
 * (`hidden` plus styles.css's display rule), keeps the regular map, and keeps the button of the
 * layout on screen until another one is chosen. The list is applied through the view's
 * `setVisibleLayouts()`, as the plugin does; the settings tab itself is not on this page.
 */
async function captureVisibleLayouts(recorder, page) {
  await loadFixture(page, OPERATION_FIXTURE);
  const original = await page.harness('h.source()');

  await recorder.run('visible-layouts', '設定「左下に表示するレイアウト」を通常マップ・階層図だけにする', '左下のボタンがタイムラインと左右バランスを除く 2 つになる（hidden と display: none）。ノードと原文は変わらない', async () => {
    const before = await page.harness('h.layoutButtons()');
    const labels = await page.harness('h.layoutLabels');
    expect(before.length === labels.length && before.every(button => !button.hidden && button.displayed), `before: ${describeButtons(before)}`);
    expect(before.map(button => button.label).join() === labels.join(), `order: ${describeButtons(before)} (expected ${labels.join('・')})`);
    const nodes = (await page.harness('h.nodes()')).length;
    await page.harness('h.setVisibleLayouts(["mindmap", "hierarchy"])');
    await page.settle();
    const after = await page.harness('h.layoutButtons()');
    expect(after.map(button => button.hidden).join() === 'false,true,false,true', `hidden: ${describeButtons(after)}`);
    expect(after.map(button => button.displayed).join() === 'true,false,true,false', `displayed: ${after.map(button => button.displayed).join()}`);
    expect(after[0].active, `通常マップ is not the active button: ${describeButtons(after)}`);
    expect((await page.harness('h.nodes()')).length === nodes, 'the node count changed');
    expect((await page.harness('h.source()')) === original, 'the source changed');
    return `表示 ${after.filter(button => button.displayed).length} 個（${describeButtons(after)}）、ノード ${nodes}、原文不変`;
  });

  await recorder.run('visible-layouts-current', 'タイムラインを非表示のまま、同じノートをタイムラインで開く（view state。mappy-layout は書かない）', 'そのノートではタイムラインのボタンが出て選択状態。左右バランスは隠れたまま', async () => {
    await loadFixture(page, OPERATION_FIXTURE, 'timeline');
    const buttons = await page.harness('h.layoutButtons()');
    expect(buttons.map(button => button.hidden).join() === 'false,false,false,true', `hidden: ${describeButtons(buttons)}`);
    expect(buttons.map(button => button.displayed).join() === 'true,true,true,false', `displayed: ${buttons.map(button => button.displayed).join()}`);
    expect(buttons[1].active && !buttons[0].active, `タイムライン is not the active button: ${describeButtons(buttons)}`);
    const timeline = await page.evaluate(`document.querySelectorAll('.mappy-node.is-timeline').length`);
    expect(timeline > 0, 'no node in the timeline layout');
    expect((await page.harness('h.source()')) === original, 'the source changed');
    return `表示 ${buttons.filter(button => button.displayed).length} 個（${describeButtons(buttons)}）、原文不変`;
  });

  await recorder.run('visible-layouts-switch', '左下の「通常マップ」→「閉じて開き直す」', 'タイムラインのボタンが消えて 2 つに戻る。開き直した view も 2 つのまま。任意キー mappy-layout は書かれない（通常マップ選択はキーを削除する）', async () => {
    const button = await page.harness('h.button("通常マップ")');
    await page.click(center(button).x, center(button).y);
    await page.settle();
    let buttons = await page.harness('h.layoutButtons()');
    expect(buttons.map(button => button.displayed).join() === 'true,false,true,false', `after the switch: ${describeButtons(buttons)}`);
    expect(buttons[0].active, `通常マップ is not the active button: ${describeButtons(buttons)}`);
    const activity = await page.harness('h.activity');
    const last = [...activity].reverse().find(entry => entry.kind === 'frontmatter');
    expect(last && !last.detail.includes('mappy-layout'), `layout key still present: ${last?.detail}`);
    await page.harness('h.reopen()');
    await page.settle();
    buttons = await page.harness('h.layoutButtons()');
    expect(buttons.map(button => button.displayed).join() === 'true,false,true,false', `after reopen: ${describeButtons(buttons)}`);
    return `切替後 ${describeButtons(buttons)}、開き直し後も同じ`;
  });

  // Runs even when a case above failed, so the later cases see the bar as they always did.
  await recorder.run('visible-layouts-back', '設定を 4 つすべてに戻す', '左下のボタンが 4 つに戻り、hidden 属性がどのボタンにもない', async () => {
    await page.harness('h.setVisibleLayouts(["mindmap", "timeline", "hierarchy", "balanced"])');
    await page.settle();
    const buttons = await page.harness('h.layoutButtons()');
    expect(buttons.length === 4 && buttons.every(button => !button.hidden && button.displayed), `after restore: ${describeButtons(buttons)}`);
    const hidden = await page.evaluate(`document.querySelectorAll('.mappy-modes [hidden]').length`);
    expect(hidden === 0, `${hidden} hidden elements on the bar`);
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
  const menuAction = async title => contextMenuAction(page, await emptyCanvasPoint(page, 80), title);
  /** The slot preview as the DOM shows it: the placeholder, the blue connector, and whether the dragged topic's root looks like a plain node. */
  const snapPreview = (title = '位置のないトピック') => page.evaluate(`(() => { const host = document.querySelector('.mappy-view');
    const root = Array.from(host.querySelectorAll('.mappy-node.is-topic')).find(n => n.querySelector('.mappy-node-label')?.textContent?.trim() === ${JSON.stringify(title)});
    return { placeholder: !host.querySelector('.mappy-drop-placeholder').hidden, connector: Boolean(host.querySelector('.mappy-edges path.is-preview')), merging: root?.classList.contains('is-merging') }; })()`);
  /** The label of the node under a screen point, or null over empty canvas (a dragged tree lets hits through). */
  const labelUnder = point => page.evaluate(`document.elementFromPoint(${Math.round(point.x)}, ${Math.round(point.y)})?.closest('[data-node-id]')?.querySelector('.mappy-node-label')?.textContent?.trim() ?? null`);
  /**
   * Moves the held button from `from` to `to` in 12 steps and lets the map settle; the press and the release stay with
   * the caller. `onStep`, when given, is awaited after each step, for a case that watches the map during the approach.
   */
  const sweep = async (from, to, onStep) => {
    for (let step = 1; step <= 12; step += 1) {
      await page.mouse('mouseMoved', from.x + (to.x - from.x) * step / 12, from.y + (to.y - from.y) * step / 12, { button: 'left' });
      if (onStep) await onStep(step);
    }
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

  await recorder.run('topic-drag-layout-switch', `「${reference}」をドラッグ中に左右バランスへ切り替え`,
    '運んでいる木はポインターに付いたままで切り替え時にずれず、離した位置が balanced のキーに書かれる（LEV-129）', async () => {
      const base = await page.harness('h.source()');
      const before = await topicRect(reference);
      const from = center(before.rect);
      await page.mouse('mouseMoved', from.x, from.y);
      await page.mouse('mousePressed', from.x, from.y, { button: 'left', clickCount: 1 });
      await page.mouse('mouseMoved', from.x + 40, from.y - 30, { button: 'left' });
      await page.settle();
      const beforeSwitch = await topicRect(reference);
      // The layout switches through the view state mid-drag (a restored workspace, a pane opened on the
      // same note), the pointer staying down: `topicDrag` must be rebased to the new origin (LEV-129),
      // not left measured from the map's, which used to show up as the carried tree jumping right here.
      await page.harness(`h.load(${JSON.stringify(TOPIC_FIXTURE)}, 'balanced')`);
      await page.settle();
      const afterSwitch = await topicRect(reference);
      expect(Math.abs(afterSwitch.rect.x - beforeSwitch.rect.x) < 1.5 && Math.abs(afterSwitch.rect.y - beforeSwitch.rect.y) < 1.5,
        `the carried tree moved by ${(afterSwitch.rect.x - beforeSwitch.rect.x).toFixed(1)}, ${(afterSwitch.rect.y - beforeSwitch.rect.y).toFixed(1)} on the switch alone`);
      await page.mouse('mouseMoved', from.x + 100, from.y - 60, { button: 'left' });
      await page.settle();
      const released = await topicRect(reference);
      const view = await page.harness('h.viewport()');
      const body = await page.harness('h.node("講座の本体")');
      await page.mouse('mouseReleased', from.x + 100, from.y - 60, { button: 'left', clickCount: 1 });
      await page.settle();
      let result;
      try {
        const moved = await page.harness('h.source()');
        const offset = { x: Math.round((released.rect.x - body.rect.x) / view.scale), y: Math.round((released.rect.y - body.rect.y) / view.scale) };
        // Whatever mindmap/timeline already held (earlier cases moved and redid 参考資料's mindmap entry): only `balanced` is new here.
        const baseEntry = topicEntry(base, reference);
        expect(baseEntry, 'the reference topic has no entry to extend before the drag');
        const expected = baseEntry?.replace(/ \}$/u, `, balanced: [${offset.x}, ${offset.y}] }`);
        expect(topicEntry(moved, reference) === expected, `expected ${expected}, got ${topicEntry(moved, reference)}`);
        expect(bodyOf(moved) === bodyOf(base), 'the body changed while dragging a topic across a layout switch');
        result = `切替時のずれ 0 px、離した位置 balanced: [${offset.x}, ${offset.y}]（scale ${view.scale.toFixed(3)}）`;
      } finally {
        // Best effort even when an assertion above threw, so a broken case does not also corrupt the ones after it.
        await undo();
        await page.harness(`h.load(${JSON.stringify(TOPIC_FIXTURE)}, 'mindmap')`);
        await page.settle();
      }
      expect((await page.harness('h.source()')) === base, 'undo did not restore the previous position');
      return result;
    });

  /**
   * A layout button pressed by a second pointer (a finger) while the mouse still carries a tree (LEV-182): the mouse
   * alone cannot reach the button, the canvas holding its capture, but a touch can. The switch asks for a fit; the fit
   * must wait for the release, or the carried tree (a topic by its offsets, the body by the viewport pan) leaves the
   * pointer. The press, the switch and the release write the note (`mappy-layout` and the positions), so the note's text
   * is put back and the map reloaded in the map after each run, then fitted: a layout passed through the view state
   * does not fit, so the reload alone would keep the balanced map's fit and send the fixed-distance drags of the cases
   * after this one past the canvas edge.
   */
  /**
   * Until the view has nothing in flight: no drag, no save, no re-read scheduled or running, no layout write. A fit
   * held through a drop waits for the re-read the save's watcher schedules 45 ms later, which a settle (three still
   * frames) can return ahead of; the fields are the view's own, read as the page sees them.
   */
  const quiet = async () => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const busy = await page.harness('(async () => { const v = h.view; await v.layoutWrite.catch(() => undefined); return Boolean(v.topicDrag || v.saving || v.refreshTimer !== undefined || v.refreshing); })()');
      if (!busy) break;
      if (Date.now() > deadline) throw new Error('the view did not settle: a drag, save or re-read is still in flight');
      await page.evaluate('new Promise(done => { setTimeout(done, 10); })');
    }
    await page.settle();
  };
  const dragWithTouchSwitch = async name => {
    const base = await page.harness('h.source()');
    const button = await page.harness(`h.button(${JSON.stringify('左右バランス')})`);
    expect(button, 'no 左右バランス button');
    const from = center((await topicRect(name)).rect);
    let held = false;
    try {
      await page.mouse('mouseMoved', from.x, from.y);
      await page.mouse('mousePressed', from.x, from.y, { button: 'left', clickCount: 1 });
      held = true;
      await page.mouse('mouseMoved', from.x + 20, from.y + 10, { button: 'left' });
      await page.mouse('mouseMoved', from.x + 40, from.y + 20, { button: 'left' });
      await page.settle();
      const before = { rect: (await topicRect(name)).rect, view: await page.harness('h.viewport()') };
      const tap = center(button);
      await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tap.x, y: tap.y, id: 2 }] });
      await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.settle();
      const active = (await page.harness('h.layoutButtons()')).find(item => item.active)?.label;
      expect(active === '左右バランス', `the touch did not switch the layout mid-drag (active: ${active})`);
      const switched = { rect: (await topicRect(name)).rect, view: await page.harness('h.viewport()') };
      const jump = { x: switched.rect.x - before.rect.x, y: switched.rect.y - before.rect.y };
      expect(Math.abs(jump.x) < 1.5 && Math.abs(jump.y) < 1.5, `${name} moved by ${jump.x.toFixed(1)}, ${jump.y.toFixed(1)} on the switch alone`);
      expect(Math.abs(switched.view.scale - before.view.scale) < 1e-9, `the scale changed mid-drag (${before.view.scale.toFixed(3)} → ${switched.view.scale.toFixed(3)})`);
      await page.mouse('mouseMoved', from.x + 70, from.y + 20, { button: 'left' });
      await page.settle();
      const moved = (await topicRect(name)).rect;
      const follow = { x: moved.x - switched.rect.x, y: moved.y - switched.rect.y };
      expect(Math.abs(follow.x - 30) < 1.5 && Math.abs(follow.y) < 1.5, `${name} followed 30 px of travel by ${follow.x.toFixed(1)}, ${follow.y.toFixed(1)}`);
      await page.mouse('mouseReleased', from.x + 70, from.y + 20, { button: 'left', clickCount: 1 });
      held = false;
      await quiet();
      // The fit the switch asked for runs once the drag is over. The viewport is compared with the one「全体表示」
      // gives for the same map: a pan alone (the body's drag moves it) or a map that happens to fit already would
      // pass a looser check without any fit having run.
      const released = await page.harness('h.viewport()');
      const fit = await page.harness('h.button("全体表示")');
      await page.click(center(fit).x, center(fit).y);
      await page.settle();
      const fitted = await page.harness('h.viewport()');
      expect(Math.abs(released.x - fitted.x) < 0.5 && Math.abs(released.y - fitted.y) < 0.5 && Math.abs(released.scale - fitted.scale) < 1e-6,
        `not fitted after the release: ${JSON.stringify(released)}, a fit gives ${JSON.stringify(fitted)}`);
      return `切替時のずれ ${jump.x.toFixed(1)}, ${jump.y.toFixed(1)} px、scale ${before.view.scale.toFixed(3)} のまま、離したあと Fit（scale ${released.scale.toFixed(3)}）`;
    } finally {
      // An assertion that threw mid-drag leaves the button down and the canvas holding the capture: released first,
      // or the fit button's click below would end that drag and write its position over the text put back here.
      if (held) await page.mouse('mouseReleased', from.x + 40, from.y + 20, { button: 'left', clickCount: 1 });
      // The switch writes `mappy-layout` through its own chain (`layoutWrite`) and the release saves: both land before
      // the text is put back, or a late one would leave its change in the note the next cases compare against. A view
      // that never settles is not this block's to report: the text is put back regardless, and the case's own error
      // (if any) stays the one recorded.
      try { await quiet(); } catch { /* restored below all the same */ }
      await page.harness(`h.putNote('Fixtures/free-topics.md', ${JSON.stringify(base)})`);
      await loadFixture(page, TOPIC_FIXTURE, 'mindmap');
      const fit = await page.harness('h.button("全体表示")');
      await page.click(center(fit).x, center(fit).y);
      await page.settle();
    }
  };
  await recorder.run('topic-drag-layout-button-touch', `「${reference}」をマウスで運びながら、タッチで左下の「左右バランス」を押す → 30 px 運ぶ → 離す`,
    '切り替えで木も scale も動かず（Fit しない）、その後の移動にそのまま付いてきて、離したあとで Fit する（LEV-182）', () => dragWithTouchSwitch(reference));
  await recorder.run('body-drag-layout-button-touch', '本体「講座の本体」をマウスで運びながら、タッチで左下の「左右バランス」を押す → 30 px 運ぶ → 離す',
    '切り替えで本体も scale も動かず（Fit しない）、その後の移動にそのまま付いてきて、離したあとで Fit する（LEV-182）', () => dragWithTouchSwitch('講座の本体'));

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
    await sweep(from, to);
    const under = await labelUnder(to);
    const preview = await snapPreview();
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

  // The same snap in the other layouts, judged by their own geometry: under a leaf in the hierarchy (children hang
  // below); on the timeline, where a leaf stage's forest starts (above the axis for the third stage) and centred on the
  // axis between two stages. The layout is switched through the view state, so the note keeps no `mappy-layout`, and
  // Fit follows because a view-state switch keeps the viewport.
  const switchLayout = async mode => {
    await loadFixture(page, TOPIC_FIXTURE, mode);
    const fit = await page.harness('h.button("全体表示")');
    await page.click(center(fit).x, center(fit).y);
    await page.settle();
  };
  const snapCase = async (mode, id, name, targets, where, place, joined, outcome) => {
    await recorder.run(id, `${name}に切り替え、「位置のないトピック」を${where}（重ならない位置）へ運ぶ → 離す`, `${name}でも、ルートがその位置に来た時点でスロットとゴースト風の表示が出て、離すと${outcome}`, async () => {
      await switchLayout(mode);
      const base = await page.harness('h.source()');
      const view = await page.harness('h.viewport()');
      const topic = await topicRect('位置のないトピック');
      const goals = [];
      for (const target of targets) goals.push((await topicRect(target)).rect);
      const from = center(topic.rect);
      const to = place(topic.rect, goals, from, view.scale);
      await page.mouse('mouseMoved', from.x, from.y);
      await page.mouse('mousePressed', from.x, from.y, { button: 'left', clickCount: 1 });
      await sweep(from, to);
      const under = await labelUnder(to);
      const preview = await snapPreview();
      await page.screenshot(join(recorder.directory, `${id}-preview.png`));
      expect(under === null, `the pointer is over ${under}; the snap must come from the root's position`);
      expect(preview.placeholder && preview.connector && preview.merging, `preview state ${JSON.stringify(preview)}`);
      await page.mouse('mouseReleased', to.x, to.y, { button: 'left', clickCount: 1 });
      await page.settle();
      const source = await page.harness('h.source()');
      expect(source.includes(joined), `joined: ${JSON.stringify(source.slice(source.indexOf('- 記録する'), source.indexOf('- 記録する') + 160))}`);
      expect(!source.includes('mappy-layout'), 'switching the layout through the view state wrote mappy-layout');
      await undo();
      expect((await page.harness('h.source()')) === base, 'undo did not restore the topic');
      return `ポインター下: なし、スロット表示あり → ${outcome}（scale ${view.scale.toFixed(3)}）`;
    });
  };
  const habitJoined = '- 習慣化する\n  - 位置のないトピック\n    `mappy-topics` に項目がないので、本体の下の既定位置に置く。\n\n    - 既定位置\n';
  try {
    // Hierarchy: the root's top edge 24 px under the leaf 習慣化する, horizontally centred on it.
    await snapCase('hierarchy', 'topic-snap-hierarchy', '階層図', ['習慣化する'], '「習慣化する」の真下', (topic, [goal], from) => ({
      x: goal.x + goal.width / 2 + (from.x - (topic.x + topic.width / 2)), y: goal.y + goal.height + 24 + (from.y - topic.y),
    }), habitJoined, '習慣化する の子になる');
    // Timeline: the root's bottom edge 24 px above the leaf stage 習慣化する (the third stage, whose forest hangs above the
    // axis), its left edge where the forest would start: a stem's length (20 units) right of the stage's centre.
    await snapCase('timeline', 'topic-snap-timeline', 'タイムライン', ['習慣化する'], '「習慣化する」の真上（森の始まる位置）', (topic, [goal], from, scale) => ({
      x: goal.x + goal.width / 2 + 20 * scale + (from.x - topic.x), y: goal.y - 24 - topic.height + (from.y - topic.y),
    }), habitJoined, '習慣化する の子になる');
    // Timeline: the root centred on the axis in the gap between the stages 記録する and 習慣化する (the pointer sits on the axis line).
    await snapCase('timeline', 'topic-snap-timeline-axis', 'タイムライン', ['記録する', '習慣化する'], '軸上の「記録する」と「習慣化する」の間', (topic, [left, right], from) => ({
      x: (left.x + left.width + right.x) / 2 + (from.x - (topic.x + topic.width / 2)), y: left.y + left.height / 2 + (from.y - (topic.y + topic.height / 2)),
    }), '- 記録する\n  - ふりかえる\n- 位置のないトピック\n  `mappy-topics` に項目がないので、本体の下の既定位置に置く。\n\n  - 既定位置\n- 習慣化する\n', '記録する の後ろのステージになる');
    // Balanced: 記録する (the second child) hangs left of the root with its leaf ふりかえる on its left, so the child slot is
    // the mirror image of the map's: the root's right edge 24 px left of the leaf, level with it.
    await snapCase('balanced', 'topic-snap-balanced', '左右バランス', ['ふりかえる'], '左側の「ふりかえる」の左隣', (topic, [goal], from) => ({
      x: goal.x - 24 - topic.width + (from.x - topic.x), y: goal.y + (from.y - topic.y),
    }), '  - ふりかえる\n    - 位置のないトピック\n      `mappy-topics` に項目がないので、本体の下の既定位置に置く。\n\n      - 既定位置\n', 'ふりかえる の子になる');
  } finally {
    // Back to the map, with its own Fit, for the cases that follow.
    await switchLayout('mindmap');
  }

  // Timeline with stages of different heights (LEV-47): an image makes the first stage 回復する about 135 px tall, so the
  // band the tree keeps clear around the axis is its half-height and every forest starts 34 units past that band. The
  // leaf stage 習慣化する (the third, forest above) is a plain line of text, so its first child lands far above the stage
  // itself: past the 72 units the zone measured from the stage's own edge reached. The root is brought exactly there
  // from the right, level with the landing, so it never crosses the plain zone on the way (a slot once shown is kept
  // in a widened zone, which would hide the difference).
  const stagePath = 'Fixtures/free-topics.md';
  /**
   * Runs cases that rewrite the fixture note (each case puts its own text in), then puts the fixture's text back and
   * returns to the map with its own Fit for the cases that follow. A dead Chrome skips the restore, so its own error
   * stays the one reported.
   */
  const withFixtureRestored = async body => {
    let dead = false;
    try { await body(); } catch (error) { dead = error instanceof CdpClosedError; throw error; } finally {
      if (!dead) {
        await page.harness(`h.putNote(${JSON.stringify(stagePath)}, ${JSON.stringify(original)})`);
        await switchLayout('mindmap');
      }
    }
  };
  const tallStage = original.replace('- 回復する\n  参考: [[heading-document#回復する|回復]]\n', '- 回復する\n  参考: [[heading-document#回復する|回復]]\n  ![[sample-image.svg]]\n');
  await withFixtureRestored(async () => {
    await recorder.run('topic-snap-timeline-band', '「回復する」に画像を足してタイムラインに切り替え、「位置のないトピック」を「習慣化する」の右の空白（着地点と同じ高さ）へ運び、そこから左へ「習慣化する」の最初の子が置かれる位置（軸の帯の 34 単位上。ステージ自身の上辺からは 72 単位より離れる）へ運ぶ → 離す',
      '右の空白ではスロットが出ず、段（軸）の最も高いノードを基準にした帯の端から zone を測るので、子が実際に置かれる位置にルートが来た時点でスロットとゴースト風の表示が出て、離すと 習慣化する の子になる', async () => {
        expect(tallStage !== original, 'the tall-stage note is the original: the stage line to add the image under was not found');
        await page.harness(`h.putNote(${JSON.stringify(stagePath)}, ${JSON.stringify(tallStage)})`);
        await switchLayout('timeline');
        const base = await page.harness('h.source()');
        expect(base === tallStage, 'the tall-stage note did not load');
        const view = await page.harness('h.viewport()');
        const topic = await topicRect('位置のないトピック');
        const goal = (await topicRect('習慣化する')).rect;
        const tree = [];
        for (const name of ['講座の本体', '回復する', '記録する', '習慣化する']) tree.push({ name, rect: (await topicRect(name)).rect });
        const tallest = tree.reduce((best, item) => item.rect.height > best.rect.height ? item : best);
        expect(tallest.name === '回復する' && tallest.rect.height > goal.height + 76 * view.scale, `回復する is not the tallest by more than 76 units: ${tree.map(item => `${item.name} ${item.rect.height.toFixed(1)}`).join(', ')}`);
        const axis = goal.y + goal.height / 2;
        const band = tallest.rect.height / 2;
        const from = center(topic.rect);
        // The root's bottom edge 34 units above the band, its left edge a stem's length right of the stage's centre.
        const to = { x: goal.x + goal.width / 2 + 20 * view.scale + (from.x - topic.rect.x), y: axis - band - 34 * view.scale - topic.rect.height + (from.y - topic.rect.y) };
        const clearance = (goal.y - (to.y - (from.y - topic.rect.y) + topic.rect.height)) / view.scale;
        expect(clearance > 72, `the landing is only ${clearance.toFixed(1)} units above the stage, inside the plain zone`);
        // The way in: level with the landing, the root's left edge at least 60 units right of the stage (outside any zone).
        const canvas = await page.harness('h.canvasRect()');
        const staging = { x: Math.min(to.x + 200 * view.scale, canvas.x + canvas.width - 24 - (topic.rect.width - (from.x - topic.rect.x))), y: to.y };
        const stagingLeft = (staging.x - (from.x - topic.rect.x) - (goal.x + goal.width)) / view.scale;
        expect(stagingLeft >= 60, `the staging point's left edge is only ${stagingLeft.toFixed(1)} units right of the stage`);
        await page.mouse('mouseMoved', from.x, from.y);
        await page.mouse('mousePressed', from.x, from.y, { button: 'left', clickCount: 1 });
        await sweep(from, staging);
        const away = await snapPreview();
        expect(!away.placeholder && !away.connector, `a slot is shown right of the stage: ${JSON.stringify(away)}`);
        await sweep(staging, to);
        const under = await labelUnder(to);
        const preview = await snapPreview();
        await page.screenshot(join(recorder.directory, 'topic-snap-timeline-band-preview.png'));
        expect(under === null, `the pointer is over ${under}; the snap must come from the root's position`);
        expect(preview.placeholder && preview.connector && preview.merging, `preview state at the landing ${JSON.stringify(preview)}`);
        await page.mouse('mouseReleased', to.x, to.y, { button: 'left', clickCount: 1 });
        await page.settle();
        const source = await page.harness('h.source()');
        expect(source.includes(habitJoined), `joined: ${JSON.stringify(source.slice(source.indexOf('- 記録する'), source.indexOf('- 記録する') + 160))}`);
        expect(!source.includes('mappy-layout'), 'switching the layout through the view state wrote mappy-layout');
        await undo();
        expect((await page.harness('h.source()')) === base, 'undo did not restore the topic');
        return `ステージの高さ ${tree.map(item => `${item.name} ${(item.rect.height / view.scale).toFixed(1)}`).join(' / ')}、帯の半分 ${(band / view.scale).toFixed(1)}、右の空白（ステージの右 ${stagingLeft.toFixed(1)} 単位）ではスロットなし、ルートの下辺が 習慣化する の上辺の ${clearance.toFixed(1)} 単位上に来るとスロット表示あり、ポインター下: なし → 習慣化する の子になる（scale ${view.scale.toFixed(3)}）`;
      });
  });

  // A root with nothing under it (LEV-90): the map and the balanced map hang a root's first child a root gap (80 units)
  // past it, farther than a branch's child (56), so the zone measured as a branch's (up to 72) never reached the landing;
  // the hierarchy hangs it a root gap (48) under the root. 参考資料 loses its three items and becomes a lone heading;
  // 位置のないトピック is brought level with the landing from the right, so the root's left edge crosses nothing else on
  // the way, and released where the child lands. The joined node is then read back to show the layout put it exactly there.
  // In the balanced map and the hierarchy 参考資料 has no position there, so it sits in the stack under the body; its rect is
  // read before the drag, at the staging point and with the slot shown, and must not move (LEV-95: the placeholder that
  // widens its tree used to re-centre the stack's column and restack it clear of the dragged tree, so the parent jumped).
  const leafReference = original.replace('\n\n- [[heading-document|講座ノート]]\n- ![[sample-image.svg]]\n- [外部の資料](https://example.com)\n', '\n');
  // The hierarchy runs on a note of its own: the stack is held for the whole drag now (LEV-125), so 補足: 用語 stays
  // where it was stacked — directly under 参考資料, over the spot its first child lands on — and the pointer would come
  // down on it. Giving it a position takes it out of the stack, so the case keeps landing on plain canvas. The case
  // checks that the position it was given is clear of the map before it drags anything.
  const leafReferenceHierarchy = leafReference.replace('"補足: 用語": { mindmap: [560, -140] }', '"補足: 用語": { mindmap: [560, -140], hierarchy: [700, 380] }');
  const referenceJoined = '本文には何も書かない。\n\n- 位置のないトピック\n  `mappy-topics` に項目がないので、本体の下の既定位置に置く。\n\n  - 既定位置\n\n## 補足: 用語\n';
  /** Where a root of `topic`'s size lands as the first child of `goal` (pointer coordinates, from the grab point), and how the joined child is read back. */
  const rootGapCases = [
    ...['mindmap', 'balanced'].map(mode => ({
      mode, id: mode === 'mindmap' ? 'topic-snap-root-gap' : 'topic-snap-root-gap-balanced', name: mode === 'mindmap' ? '通常マップ' : '左右バランス',
      where: '右辺の 80 単位先。枝の zone の 72 単位より離れる', landing: 'ルートの左辺が 参考資料 の右辺の 80 単位先',
      // The root's left edge 80 units past the goal's right edge, its centre level with the goal's.
      to: (topic, goal, from, scale) => ({ x: goal.x + goal.width + 80 * scale + (from.x - topic.x), y: goal.y + goal.height / 2 + (from.y - (topic.y + topic.height / 2)) }),
      hung: (parent, child, scale) => ({ gap: (child.x - (parent.x + parent.width)) / scale, drift: ((child.y + child.height / 2) - (parent.y + parent.height / 2)) / scale, expected: 80, side: '右辺' }),
    })),
    {
      mode: 'hierarchy', id: 'topic-snap-root-gap-hierarchy', name: '階層図',
      note: leafReferenceHierarchy, variant: '「補足: 用語」に `hierarchy` の位置を与えて列から外した変種',
      where: '下辺の 48 単位下、中心を揃える', landing: 'ルートの上辺が 参考資料 の下辺の 48 単位下（中心を揃えて）',
      // The root's top edge 48 units under the goal's bottom edge, horizontally centred on it.
      to: (topic, goal, from, scale) => ({ x: goal.x + goal.width / 2 + (from.x - (topic.x + topic.width / 2)), y: goal.y + goal.height + 48 * scale + (from.y - topic.y) }),
      hung: (parent, child, scale) => ({ gap: (child.y - (parent.y + parent.height)) / scale, drift: ((child.x + child.width / 2) - (parent.x + parent.width / 2)) / scale, expected: 48, side: '下辺' }),
    },
  ];
  await withFixtureRestored(async () => {
    for (const { mode, id, name, where, landing, note = leafReference, variant, to: landingPoint, hung: hungOf } of rootGapCases) {
      await recorder.run(id, `「参考資料」の項目を消して見出しだけのトピックにし${variant ? `、${variant}を` : ''}、${name}で「位置のないトピック」を「参考資料」の右の空白（着地点と同じ高さ）へ運び、そこから左へ「参考資料」の最初の子が置かれる位置（${where}）へ運ぶ → 離す`,
        `右の空白ではスロットが出ず、子が実際に置かれる位置にルートが来た時点でスロットとゴースト風の表示が出て、その間 参考資料 の矩形は動かず（LEV-95）、離すと 参考資料 の子になり、親から最初の子の隙間（${where.split('。')[0]}）だけ離れて付く。位置未設定の親（左右バランス・階層図）は離した時点で列に積み直される（左右バランスは広がった幅で中央に揃い直すので親ごと左へ動く）`, async () => {
          expect(leafReference !== original, 'the lone-heading note is the original: the items to remove were not found');
          expect(!variant || note !== leafReference, 'the line this case rewrites was not found in the fixture');
          await page.harness(`h.putNote(${JSON.stringify(stagePath)}, ${JSON.stringify(note)})`);
          await switchLayout(mode);
          const base = await page.harness('h.source()');
          expect(base === note, 'the lone-heading note did not load');
          const view = await page.harness('h.viewport()');
          const topic = await topicRect('位置のないトピック');
          const goal = (await topicRect('参考資料')).rect;
          const from = center(topic.rect);
          const to = landingPoint(topic.rect, goal, from, view.scale);
          // The way in: level with the landing, the root's left edge 200 units right of the goal and of the landing (outside any
          // zone; at least 120 where the canvas cuts it short), so the pointer holds the root by the same point throughout.
          const grab = from.x - topic.rect.x;
          const canvas = await page.harness('h.canvasRect()');
          const staging = { x: Math.min(Math.max(to.x, goal.x + goal.width + grab) + 200 * view.scale, canvas.x + canvas.width - 24 - (topic.rect.width - grab)), y: to.y };
          const stagingLeft = (staging.x - grab - (goal.x + goal.width)) / view.scale;
          expect(stagingLeft >= 120, `the staging point's left edge is only ${stagingLeft.toFixed(1)} units right of the root`);
          // A case that moves a topic out of the stack (the hierarchy) must put it somewhere the drag never visits:
          // the whole sweep, from the grab point through the staging point to the landing, stays off that topic.
          if (variant) {
            const moved = (await topicRect('補足: 用語')).rect;
            const on = point => point.x >= moved.x && point.x <= moved.x + moved.width && point.y >= moved.y && point.y <= moved.y + moved.height;
            const hit = [from, staging, to].find(on);
            expect(!hit, `補足: 用語 was given a position the drag passes through (${JSON.stringify(moved)}); the sweep point ${JSON.stringify(hit)} is on it`);
          }
          await page.mouse('mouseMoved', from.x, from.y);
          await page.mouse('mousePressed', from.x, from.y, { button: 'left', clickCount: 1 });
          await sweep(from, staging);
          const away = await snapPreview();
          expect(!away.placeholder && !away.connector, `a slot is shown right of the root: ${JSON.stringify(away)}`);
          const parentAway = (await topicRect('参考資料')).rect;
          await sweep(staging, to);
          const under = await labelUnder(to);
          const preview = await snapPreview();
          const parentShown = (await topicRect('参考資料')).rect;
          await page.screenshot(join(recorder.directory, `${id}-preview.png`));
          expect(under === null, `the pointer is over ${under}; the snap must come from the root's position`);
          expect(preview.placeholder && preview.connector && preview.merging, `preview state at the landing ${JSON.stringify(preview)}`);
          // The parent stays put while the dragged tree approaches and while its slot is shown (in screen px; 1.5 is the rounding).
          const travel = (was, now) => ({ x: now.x - was.x, y: now.y - was.y });
          const approach = travel(goal, parentAway);
          const shown = travel(goal, parentShown);
          expect(Math.abs(approach.x) < 1.5 && Math.abs(approach.y) < 1.5, `参考資料 moved by ${approach.x.toFixed(1)}, ${approach.y.toFixed(1)} px while the topic was brought level with it`);
          expect(Math.abs(shown.x) < 1.5 && Math.abs(shown.y) < 1.5, `参考資料 moved by ${shown.x.toFixed(1)}, ${shown.y.toFixed(1)} px (${(shown.x / view.scale).toFixed(1)}, ${(shown.y / view.scale).toFixed(1)} units) when the slot was shown`);
          await page.mouse('mouseReleased', to.x, to.y, { button: 'left', clickCount: 1 });
          await page.settle();
          const source = await page.harness('h.source()');
          expect(source.includes(referenceJoined), `joined: ${JSON.stringify(source.slice(source.indexOf('## 参考資料'), source.indexOf('## 参考資料') + 200))}`);
          expect(!source.includes('mappy-layout'), 'switching the layout through the view state wrote mappy-layout');
          // The joined node hangs the layout's root gap past its parent, centred on it. That is relative: a parent with no
          // position is dealt into the stack again once the drop lands (in the balanced map its widened tree re-centres,
          // so parent and child move left together), which the record reports rather than asserts.
          const parent = (await topicRect('参考資料')).rect;
          const child = (await topicRect('位置のないトピック')).rect;
          const hung = hungOf(parent, child, view.scale);
          const settled = travel(goal, parent);
          expect(Math.abs(hung.gap - hung.expected) < 1.5 && Math.abs(hung.drift) < 1.5, `the joined node hangs ${hung.gap.toFixed(1)} units past its parent, ${hung.drift.toFixed(1)} off its centre`);
          await undo();
          expect((await page.harness('h.source()')) === base, 'undo did not restore the topic');
          return `右の空白（ルートの右 ${stagingLeft.toFixed(1)} 単位）ではスロットなし、${landing}に来るとスロット表示あり、その間の 参考資料 の移動 ${shown.x.toFixed(1)}, ${shown.y.toFixed(1)} px、ポインター下: なし → 参考資料 の子になり、その子は親の${hung.side}の ${hung.gap.toFixed(1)} 単位先・中心のずれ ${hung.drift.toFixed(1)} に付く。離した後の 参考資料 の移動 ${settled.x.toFixed(1)}, ${settled.y.toFixed(1)} px（${(settled.x / view.scale).toFixed(1)}, ${(settled.y / view.scale).toFixed(1)} 単位。scale ${view.scale.toFixed(3)}）`;
        });
    }
  });

  // LEV-117 (map, balanced) and LEV-125 (timeline, hierarchy): the child column of an unpositioned parent with children
  // of its own. 補足: 用語 is already unpositioned in every layout but the ordinary map, which holds a `mindmap` entry for
  // it, so that one half runs on a note with that line out.
  const unplacedGlossary = original.replace('  "補足: 用語": { mindmap: [560, -140] }\n', '');
  if (unplacedGlossary === original) throw new Error('the `mindmap` entry of 補足: 用語 was not found in the fixture');
  const frontmatterOf = source => source.slice(0, source.indexOf('\n---\n', 4));
  // `axis` is how the parent deals its children: a column hangs them under one another, so the trailing slot is past the
  // last child's lower half; a row lays them side by side, so it is past its far half.
  const childColumnCases = [
    { mode: 'balanced', layout: '左右バランス', note: original, child: '用語 A', column: '右の子列', variant: 'そのまま', axis: 'column' },
    { mode: 'mindmap', layout: '通常マップ', note: unplacedGlossary, child: '用語 B', column: '子列', variant: '「補足: 用語」の mindmap の位置を外した変種', axis: 'column' },
    { mode: 'timeline', layout: 'タイムライン', note: original, child: '用語 B', column: '軸の子の並び', variant: 'そのまま', axis: 'row' },
    { mode: 'hierarchy', layout: '階層図', note: original, child: '用語 B', column: '子の行', variant: 'そのまま', axis: 'row' },
  ];
  for (const { mode, layout, note, child: childTitle, column, variant, axis } of childColumnCases) {
    await withFixtureRestored(async () => {
      await recorder.run(`topic-snap-unplaced-child-column-${mode}`,
        `free-topics（${variant}）を${layout}で開き、「位置のないトピック」を位置未設定の親「補足: 用語」の子「${childTitle}」の${axis === 'row' ? '右半分' : '下半分'}（${column}の末尾）へ運ぶ → 離す → 元に戻す → やり直す`,
        `運ぶ間ずっと（12 段階のどこでも）「補足: 用語」のルートが逃げず、${column}の末尾に仮ノードと青線が出る。離すと原文順で 用語 B の後ろに合流し、frontmatter は 1 バイトも変わらず、Undo/Redo で原文と合流後を往復する`, async () => {
          await page.harness(`h.putNote(${JSON.stringify(stagePath)}, ${JSON.stringify(note)})`);
          await switchLayout(mode);
          const base = await page.harness('h.source()');
          expect(base === note, 'the child-column note did not load');
          const view = await page.harness('h.viewport()');
          const topic = await topicRect('位置のないトピック');
          const parent = (await topicRect('補足: 用語')).rect;
          const child = (await topicRect(childTitle)).rect;
          // Index 2 is dealt to the end of the column. A column is judged on the line its children share, so the moving
          // root goes on that shared left edge with its top edge on the child's middle; a row is judged on the root's
          // own centre along the row, so it goes three quarters along the last child, on the line the row shares (the
          // top edge in the hierarchy, the axis in the timeline). That is where the trailing slot resolves.
          const landing = axis === 'row'
            ? {
              x: child.x + child.width * 0.75 - topic.rect.width / 2,
              y: mode === 'hierarchy' ? child.y : child.y + (child.height - topic.rect.height) / 2,
            }
            : { x: child.x, y: child.y + child.height / 2 };
          // Held off-centre in its own root (towards the far end along the axis the children are dealt on, and clear of
          // the fold control on the edge its own child hangs from, which takes hits back), so that at the landing the
          // pointer itself is past the child, on plain canvas: what is under the pointer must not decide the slot.
          const from = axis === 'row'
            ? { x: topic.rect.x + topic.rect.width * 0.75, y: topic.rect.y + topic.rect.height * 0.85 }
            : { x: center(topic.rect).x, y: topic.rect.y + topic.rect.height * 0.75 };
          const to = { x: landing.x + (from.x - topic.rect.x), y: landing.y + (from.y - topic.rect.y) };
          const clearance = axis === 'row' ? to.x - (child.x + child.width) : to.y - (child.y + child.height);
          expect(clearance > 4, `the pointer lands ${clearance.toFixed(1)} px ${axis === 'row' ? 'right of' : 'below'} ${childTitle}: too close to its edge to tell the snap from a hit`);
          await page.mouse('mouseMoved', from.x, from.y);
          await page.mouse('mousePressed', from.x, from.y, { button: 'left', clickCount: 1 });
          // The parent must stay put through the whole approach, not only once the slot is up: the defect moved it out
          // of reach before any slot appeared, so every step of the sweep is measured.
          const worst = { x: 0, y: 0 };
          await sweep(from, to, async () => {
            const now = (await topicRect('補足: 用語')).rect;
            if (Math.abs(now.x - parent.x) > Math.abs(worst.x)) worst.x = now.x - parent.x;
            if (Math.abs(now.y - parent.y) > Math.abs(worst.y)) worst.y = now.y - parent.y;
          });
          const under = await labelUnder(to);
          const preview = await snapPreview();
          const parentShown = (await topicRect('補足: 用語')).rect;
          await page.screenshot(join(recorder.directory, `topic-snap-unplaced-child-column-${mode}-preview.png`));
          expect(under === null, `the pointer is over ${under}; the snap must come from the root's position`);
          expect(preview.placeholder && preview.connector && preview.merging, `preview state ${JSON.stringify(preview)}`);
          expect(Math.abs(worst.x) < 1.5 && Math.abs(worst.y) < 1.5,
            `補足: 用語 moved by up to ${worst.x.toFixed(1)}, ${worst.y.toFixed(1)} px while the topic was brought to its child column`);
          const travel = { x: parentShown.x - parent.x, y: parentShown.y - parent.y };
          expect(Math.abs(travel.x) < 1.5 && Math.abs(travel.y) < 1.5,
            `補足: 用語 moved by ${travel.x.toFixed(1)}, ${travel.y.toFixed(1)} px while the slot was shown`);
          await page.mouse('mouseReleased', to.x, to.y, { button: 'left', clickCount: 1 });
          await page.settle();
          const joined = await page.harness('h.source()');
          const joinedTail = '- 用語 B\n- 位置のないトピック\n  `mappy-topics` に項目がないので、本体の下の既定位置に置く。\n\n  - 既定位置\n';
          expect(joined.includes(joinedTail), `joined: ${JSON.stringify(joined.slice(joined.indexOf('## 補足: 用語'), joined.indexOf('## 補足: 用語') + 320))}`);
          expect(!joined.includes('\n## 位置のないトピック\n'), 'the joined topic section is still present');
          // The join moves a heading, not a position: every entry of the note's frontmatter survives it byte for byte.
          expect(frontmatterOf(joined) === frontmatterOf(base), `the frontmatter changed: ${JSON.stringify(frontmatterOf(joined))}`);
          await undo();
          expect((await page.harness('h.source()')) === base, 'undo did not restore the original Markdown bytes');
          await redo();
          expect((await page.harness('h.source()')) === joined, 'redo did not restore the joined Markdown bytes');
          return `運ぶ間の 補足: 用語 の移動は最大 ${worst.x.toFixed(1)}, ${worst.y.toFixed(1)} px（スロット表示中 ${travel.x.toFixed(1)}, ${travel.y.toFixed(1)} px）、${column}にスロット表示あり、ポインター下: なし、${childTitle} の後ろ（原文 index 2）へ合流、frontmatter 不変、Undo/Redo でバイト一致（scale ${view.scale.toFixed(3)}）`;
        });
    });
  }

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

/**
 * §5 M12 with nothing selected (LEV-83): a click on the empty canvas clears the selection, and the map
 * called then (the search modal's choice, `h.callMap`) becomes a free topic `## ![[map]]` at the end of
 * the note, drawn as the called root with the called tree as its branches, beside the body.
 */
async function captureCallAsTopic(recorder, page) {
  const fixturePath = 'Fixtures/free-topics.md';
  const calledPath = 'Fixtures/embed-timeline.md';
  const original = await readFile(join(root, 'tests', 'fixtures', 'free-topics.md'), 'utf8');
  const frontmatterOf = source => source.slice(0, source.indexOf('\n---\n', 4));
  const selectedTitles = async () => (await page.harness('h.nodes()')).filter(node => node.selected).map(node => node.title);
  const menuAction = (point, title) => contextMenuAction(page, point, title);

  await recorder.run('call-map-topic', 'free-topics を fixture の原文に戻して開く → 「回復する」をクリック → 空白をクリック → h.callMap("Fixtures/embed-timeline.md")（「マップを検索して呼び出す」で embed-timeline を選んだのと同じ）→ 空白を右クリック「元に戻す」',
    '空白のクリックで選択が外れる（is-selected のノードなし、フォーカスはキャンバス）。呼び出しで文末に `## ![[embed-timeline]]` の 1 区画だけが足され、frontmatter（mappy-topics）と本体は不変、位置は書かれない。呼び出し先のルート「講座の進行」が link の印付きのトピックのルート（is-topic、読み取り専用ではない）として本体のそばに現れ、その子 4 つが読み取り専用の枝として並び、重なりなし。新しいトピックが選択され、インライン入力は開かない。元に戻すで区画ごと消え、embed-timeline は変わらない', async () => {
    await page.harness(`h.putNote(${JSON.stringify(fixturePath)}, ${JSON.stringify(original)})`);
    await loadFixture(page, TOPIC_FIXTURE, 'mindmap');
    const calledBefore = await page.harness(`h.noteSource(${JSON.stringify(calledPath)})`);
    const before = await page.harness('h.nodes()');
    const recover = await page.harness('h.node("回復する")');
    expect(recover, 'node 回復する missing');
    await page.click(center(recover.rect).x, center(recover.rect).y);
    expect((await selectedTitles()).join(',') === '回復する', `selected after the node click: ${(await selectedTitles()).join(', ')}`);
    const blank = await emptyCanvasPoint(page, 80);
    await page.click(blank.x, blank.y);
    await page.settle();
    const afterBlank = await selectedTitles();
    expect(afterBlank.length === 0, `selected after the blank click: ${afterBlank.join(', ')}`);
    const focus = await page.evaluate(`document.activeElement?.className ?? null`);
    expect(typeof focus === 'string' && focus.includes('mappy-canvas'), `focus after the blank click: ${focus}`);
    await page.screenshot(join(recorder.directory, 'call-map-topic-deselected.png'));
    await page.harness(`h.callMap(${JSON.stringify(calledPath)})`);
    await page.settle();
    const after = await page.harness('h.source()');
    expect(after === `${original}\n## ![[embed-timeline]]\n`, 'the note did not gain exactly the one section at the end');
    expect(frontmatterOf(after) === frontmatterOf(original), 'the frontmatter changed');
    expect(!after.includes('"![[embed-timeline]]"'), 'a position was written for the new topic');
    const nodes = await page.harness('h.nodes()');
    const topic = nodes.find(node => node.title === '講座の進行');
    expect(topic && topic.calledRoot && topic.called && topic.source === calledPath && !topic.collapsed, `topic root: ${JSON.stringify(topic)}`);
    // A topic's root is a tree root (`is-root`, as the body's is) marked `is-topic`; the calling one is not read-only itself.
    const shape = await page.evaluate(`(() => {
      const element = document.querySelector('#harness-pane .mappy-node[data-node-id="' + CSS.escape(${JSON.stringify(topic.id)}) + '"]');
      if (!element) return null;
      return { topic: element.classList.contains('is-topic'), root: element.classList.contains('is-root'), readOnly: element.hasAttribute('aria-readonly'),
        mark: element.querySelector(':scope > .mappy-node-content > .mappy-node-call-mark svg') !== null,
        editing: document.activeElement?.classList.contains('mappy-inline-input') === true,
        readOnlyNodes: document.querySelectorAll('#harness-pane .mappy-node.is-called[aria-readonly="true"]').length };
    })()`);
    expect(shape && shape.topic && shape.root && !shape.readOnly && shape.mark && !shape.editing, `topic root: ${JSON.stringify(shape)}`);
    const stages = nodes.filter(node => node.called && !node.calledRoot);
    expect(stages.length === 4 && stages.every(node => node.source === calledPath), `${stages.length} called nodes: ${stages.map(node => node.title).join(', ')}`);
    expect(shape.readOnlyNodes === 4, `${shape.readOnlyNodes} read-only nodes`);
    expect(nodes.length === before.length + 5, `nodes ${before.length} → ${nodes.length}`);
    const pairs = overlappingPairs(nodes);
    expect(pairs.length === 0, `overlaps: ${pairs.join(', ')}`);
    const selected = nodes.filter(node => node.selected);
    expect(selected.length === 1 && selected[0].id === topic.id, `selected after the call: ${selected.map(node => node.title).join(', ')}`);
    const body = nodes.find(node => node.title === '講座の本体');
    expect(body, 'body root missing');
    const view = await page.harness('h.viewport()');
    const offset = { x: Math.round((topic.rect.x - body.rect.x) / view.scale), y: Math.round((topic.rect.y - body.rect.y) / view.scale) };
    const fit = await page.harness('h.button("全体表示")');
    expect(fit, 'fit button missing');
    await page.click(center(fit).x, center(fit).y);
    await page.settle();
    await page.screenshot(join(recorder.directory, 'call-map-topic-called.png'));
    await menuAction(await emptyCanvasPoint(page, 80), '元に戻す');
    expect((await page.harness('h.source()')) === original, 'undo did not remove the section');
    expect(!(await page.harness('h.node("講座の進行")')), 'the topic is still shown after undo');
    expect((await page.harness('h.nodes()')).length === before.length, `nodes after undo: ${(await page.harness('h.nodes()')).length}, expected ${before.length}`);
    expect((await page.harness(`h.noteSource(${JSON.stringify(calledPath)})`)) === calledBefore, 'the called note changed');
    return `空白クリック後の選択 ${afterBlank.length} 件（フォーカス ${focus}）、呼び出しで ${before.length} → ${nodes.length} ノード（トピック 1＋呼び出した枝 ${stages.length}）、トピックのルートは本体ルートから (${offset.x}, ${offset.y})、元に戻すで ${before.length}`;
  });
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(buffer) {
  expect(buffer.length > 24 && buffer.toString('latin1', 1, 4) === 'PNG', 'not a PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Parse an exported SVG inside the page and report what it holds; the counts come from the file, not from the exporter. */
async function svgFacts(page, svg) {
  return page.evaluate(`(() => {
    const parsed = new DOMParser().parseFromString(${JSON.stringify(svg)}, 'image/svg+xml');
    const error = parsed.querySelector('parsererror');
    if (error) return { error: error.textContent };
    const images = Array.from(parsed.querySelectorAll('img'));
    const root = parsed.documentElement;
    return {
      className: root.getAttribute('class'), width: Number(root.getAttribute('width')), height: Number(root.getAttribute('height')),
      viewBox: root.getAttribute('viewBox'), objects: parsed.querySelectorAll('foreignObject').length, paths: parsed.querySelectorAll('.mappy-edges path').length,
      badges: Array.from(parsed.querySelectorAll('.mappy-fold text'), text => text.textContent), images: images.length,
      dataImages: images.filter(image => (image.getAttribute('src') ?? '').startsWith('data:')).length,
      missing: parsed.querySelectorAll('.mappy-export-missing-image').length,
      labels: Array.from(parsed.querySelectorAll('.mappy-node-label'), label => label.textContent.trim()),
      background: parsed.querySelector('.mappy-export-background')?.getAttribute('fill'),
    };
  })()`);
}

/**
 * Open the written SVG in a second tab of the same Chrome and read back where its
 * nodes render: at scale 1 a foreignObject sits at its layout coordinates, so the
 * placement in the file equals the map view's (the view only pans and scales them).
 */
async function renderSvgFile(page, file, screenshot, expectedNodes) {
  const cdp = page.cdp;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  try {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Page(cdp, sessionId);
    await tab.send('Page.enable');
    await tab.send('Runtime.enable');
    await tab.send('Emulation.setDeviceMetricsOverride', { ...WINDOW, deviceScaleFactor: 1, mobile: false });
    await tab.send('Page.navigate', { url: pathToFileURL(file).href });
    const deadline = Date.now() + 15000;
    while ((await tab.evaluate(`document.readyState`)) !== 'complete') {
      if (Date.now() > deadline) throw new Error('The SVG tab did not finish loading.');
      await new Promise(resolveWait => { setTimeout(resolveWait, 100); });
    }
    // Let the data URL images decode before the screenshot.
    await new Promise(resolveWait => { setTimeout(resolveWait, 500); });
    const rendered = await tab.evaluate(`(() => {
      const svg = document.documentElement;
      const box = svg.viewBox.baseVal;
      const origin = svg.getBoundingClientRect();
      const objects = Array.from(document.querySelectorAll('foreignObject'));
      const scale = origin.width / box.width;
      return {
        tag: svg.tagName, objects: objects.length, scale,
        placed: objects.slice(0, 200).map(object => {
          const rect = object.getBoundingClientRect();
          return { id: object.getAttribute('data-node-id'), x: (rect.x - origin.x) / scale + box.x, y: (rect.y - origin.y) / scale + box.y,
            declaredX: Number(object.getAttribute('x')), declaredY: Number(object.getAttribute('y')), text: object.textContent.trim().slice(0, 40) };
        }),
        images: Array.from(document.querySelectorAll('img')).map(image => ({ complete: image.complete, natural: image.naturalWidth })),
      };
    })()`);
    expect(rendered.tag === 'svg', `document root is ${rendered.tag}`);
    expect(rendered.objects === expectedNodes, `${rendered.objects} foreignObjects rendered, expected ${expectedNodes}`);
    const drifted = rendered.placed.filter(item => Math.abs(item.x - item.declaredX) > 1 || Math.abs(item.y - item.declaredY) > 1);
    expect(drifted.length === 0, `${drifted.length} nodes render away from their declared position: ${JSON.stringify(drifted.slice(0, 3))}`);
    const empty = rendered.placed.filter(item => !item.text);
    expect(empty.length === 0, `${empty.length} rendered nodes have no text`);
    const broken = rendered.images.filter(image => !image.complete || image.natural === 0);
    expect(broken.length === 0, `${broken.length} of ${rendered.images.length} images did not decode from their data URL`);
    const { data } = await tab.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(screenshot, Buffer.from(data, 'base64'));
    return rendered;
  } finally {
    await cdp.send('Target.closeTarget', { targetId });
  }
}

/**
 * M13 (LEV-59): the SVG and PNG the export command would save, produced by the same
 * capture on this page and written next to the record. The SVG is opened in Chrome
 * to confirm foreignObject nodes and data URL images render; the PNG is checked by size.
 */
export async function captureExport(recorder, page) {
  await loadFixture(page, OPERATION_FIXTURE);
  const title = '多数の兄弟';
  const node = await nodeInfo(page, title);
  expect(node.toggle, 'fold control missing');
  await page.click(center(node.toggle).x, center(node.toggle).y);
  await page.settle();
  const shown = (await page.harness('h.nodes()')).length;
  const original = await page.harness('h.source()');
  const svgFile = join(recorder.directory, 'export-uneven-branches.svg');

  await recorder.run('export-svg', `uneven-branches で「${title}」を閉じ、h.export.svg() で SVG を書き出す`, 'foreignObject の数が表示ノード数、線の数がノード数 − 1、閉じた枝のバッジ 24、画像はすべて data URL、欠落画像のノードも残る', async () => {
    const exported = await page.harness('h.export.svg()');
    await writeFile(svgFile, exported.svg);
    const facts = await svgFacts(page, exported.svg);
    expect(!facts.error, `SVG is not well formed: ${facts.error}`);
    expect(facts.objects === shown, `${facts.objects} foreignObjects for ${shown} visible nodes`);
    expect(facts.paths === shown - 1, `${facts.paths} paths for ${shown} nodes`);
    expect(facts.badges.length === 1 && facts.badges[0] === '24', `badges: ${JSON.stringify(facts.badges)}`);
    expect(facts.images > 0 && facts.dataImages === facts.images, `${facts.dataImages} of ${facts.images} images are data URLs`);
    expect(facts.missing === 0, `${facts.missing} placeholders for unreadable images`);
    expect(facts.labels.includes('画像の欠落') && facts.labels.includes('リンクと画像'), 'nodes with a missing image or links are absent');
    expect(facts.className === 'mappy-export theme-light', `class: ${facts.className}`);
    expect(facts.width === exported.width && facts.height === exported.height, `size ${facts.width}×${facts.height}`);
    expect((await page.harness('h.source()')) === original, 'the note changed during the export');
    return `${facts.objects} ノード、線 ${facts.paths}、画像 ${facts.dataImages}/${facts.images} を data URL 化、${exported.width}×${exported.height}、${(exported.svg.length / 1024).toFixed(0)} KB、${exported.ms.toFixed(0)} ms → ${relative(root, svgFile)}`;
  });

  await recorder.run('export-svg-render', '書き出した SVG を Chrome の別タブで開く', 'foreignObject のノードが宣言した座標に描かれ、文字と data URL の画像が見える', async () => {
    const rendered = await renderSvgFile(page, svgFile, join(recorder.directory, 'export-uneven-branches-rendered.png'), shown);
    return `${rendered.objects} ノードを描画、画像 ${rendered.images.length} 枚が復号、位置のずれ 1 px 未満 → export-uneven-branches-rendered.png`;
  });

  await recorder.run('export-png', 'h.export.png() で同じ SVG をラスタ化', 'PNG の寸法が SVG のサイズ × scale に一致する', async () => {
    const exported = await page.harness('h.export.png()');
    const buffer = Buffer.from(exported.dataUrl.split(',')[1] ?? '', 'base64');
    const file = join(recorder.directory, 'export-uneven-branches.png');
    await writeFile(file, buffer);
    const size = pngSize(buffer);
    expect(size.width === exported.width && size.height === exported.height, `PNG is ${size.width}×${size.height}, expected ${exported.width}×${exported.height}`);
    expect(exported.scale === 2, `scale ${exported.scale}`);
    return `${size.width}×${size.height} px（scale ${exported.scale}）、${(buffer.length / 1024).toFixed(0)} KB、SVG ${exported.svgMs.toFixed(0)} ms + ラスタ化 ${exported.ms.toFixed(0)} ms → ${relative(root, file)}`;
  });

  // Leave the fixture as it was loaded.
  const collapsed = await nodeInfo(page, title);
  if (collapsed.collapsed && collapsed.toggle) {
    await page.click(center(collapsed.toggle).x, center(collapsed.toggle).y);
    await page.settle();
  }

  await recorder.run('export-2000', 'performance-2000-links で SVG と PNG を書き出す', '2,000 ノードで完了する。PNG はピクセル上限に収まるよう縮小される', async () => {
    await loadFixture(page, 'performance-2000-links');
    const count = (await page.harness('h.nodes()')).length;
    const svg = await page.harness('h.export.svg()');
    const facts = await svgFacts(page, svg.svg);
    expect(!facts.error, `SVG is not well formed: ${facts.error}`);
    expect(facts.objects === count && facts.paths === count - 1, `${facts.objects} objects / ${facts.paths} paths for ${count} nodes`);
    expect(facts.dataImages === facts.images && facts.images === Math.floor((count - 1) / 5), `${facts.dataImages}/${facts.images} images`);
    await writeFile(join(recorder.directory, 'export-performance-2000-links.svg'), svg.svg);
    const png = await page.harness('h.export.png()');
    const buffer = Buffer.from(png.dataUrl.split(',')[1] ?? '', 'base64');
    const size = pngSize(buffer);
    expect(size.width === png.width && size.height === png.height, `PNG is ${size.width}×${size.height}`);
    expect(size.width * size.height <= 8192 * 8192 + 1, `PNG area ${size.width * size.height} exceeds the desktop cap`);
    await writeFile(join(recorder.directory, 'export-performance-2000-links.png'), buffer);
    return `${count} ノード: SVG ${(svg.svg.length / 1024).toFixed(0)} KB を ${svg.ms.toFixed(0)} ms、PNG ${size.width}×${size.height}（scale ${png.scale.toFixed(3)}、${(buffer.length / 1024).toFixed(0)} KB）を ${png.ms.toFixed(0)} ms`;
  });
}

const EMBED_HOST = 'embed-host';
const EMBED_HOST_LIVE = 'embed-host-live';
const EMBED_HOST_LIVE_LATE = 'embed-host-live-late';
const EMBED_EXPECTED = [
  { src: 'Fixtures/uneven-branches.md', layout: 'mindmap' },
  { src: 'Fixtures/embed-timeline.md', layout: 'timeline' },
  { src: 'Fixtures/embed-hierarchy.md', layout: 'hierarchy' },
  { src: 'Fixtures/embed-hierarchy.md#同じ名前', layout: 'hierarchy' },
  { src: 'Fixtures/embed-2000.md', layout: 'mindmap' },
];
const EMBED_PLAIN = ['heading-document', '存在しないノート', 'embed-hierarchy#^block'];
const EMBED_NOTES = ['Fixtures/embed-host.md', 'Fixtures/uneven-branches.md', 'Fixtures/embed-timeline.md', 'Fixtures/embed-hierarchy.md', 'Fixtures/embed-2000.md'];

/** Every map on the host: the expected notes in order, each layout as its own frontmatter says, every node inside its frame, never magnified. */
function expectEmbeds(embeds) {
  const maps = embeds.filter(embed => embed.kind === 'map');
  const plain = embeds.filter(embed => embed.kind === 'plain');
  expect(maps.length === EMBED_EXPECTED.length, `${maps.length} maps, expected ${EMBED_EXPECTED.length}`);
  EMBED_EXPECTED.forEach((wanted, index) => {
    const embed = maps[index];
    expect(embed.src === wanted.src, `map ${index}: ${embed.src}, expected ${wanted.src}`);
    expect(embed.layout === wanted.layout, `${embed.src}: layout ${embed.layout}, expected ${wanted.layout}`);
    expect(embed.nodes.length > 0 && !embed.message, `${embed.src}: ${embed.nodes.length} nodes, message ${embed.message}`);
    expect(embed.scale !== null && embed.scale <= 1.0001, `${embed.src}: scale ${embed.scale}`);
    const outside = embed.nodes.filter(node => !inside(node.rect, embed.rect, 2));
    expect(outside.length === 0, `${embed.src}: ${outside.length} nodes outside the frame`);
  });
  expect(plain.map(embed => embed.src).join(',') === EMBED_PLAIN.join(','), `plain embeds: ${plain.map(embed => embed.src).join(', ')}`);
  return maps;
}

async function noteSources(page) {
  const sources = {};
  for (const path of EMBED_NOTES) sources[path] = await page.harness(`h.noteSource(${JSON.stringify(path)})`);
  return sources;
}

function expectUnchanged(before, after) {
  for (const path of EMBED_NOTES) expect(before[path] === after[path], `${path} changed`);
}

async function revealEmbed(page, src) {
  await page.harness(`h.revealEmbed(${JSON.stringify(src)})`);
  await page.settle();
}

async function embedNode(page, src, title) {
  const embed = (await page.harness('h.embeds()')).find(candidate => candidate.src === src);
  expect(embed, `embed missing: ${src}`);
  const node = embed.nodes.find(candidate => candidate.title === title);
  expect(node, `node missing in ${src}: ${title}`);
  return { embed, node };
}

/**
 * The tooltip Obsidian's desktop app would show on hovering each element under `scope` (LEV-199), decided as its
 * app.js (1.14.2) does: the closest `[aria-label]` at or above the element (`matchParent`, the delegate of
 * `body.on("pointerover", "[aria-label]")` and of the `pointerout` hand-over), unless that element's computed
 * `--no-tooltip` is `true`. The tooltip sits below that element, so on a node it covers the node below.
 * The browser's native tooltip (`title` at or above the element) is counted too: it shows under the pointer all the same.
 * `nodes`: the elements of the node bodies (the fold control aside) that would show one, with its text.
 * `unnamed`: fold controls and map buttons that would show none (they keep theirs).
 */
async function tooltipFacts(page, scope) {
  return page.evaluate(`(() => {
    const tip = element => {
      // The browser's own tooltip first: a title attribute at or above the element shows whatever Obsidian does.
      const titled = element.closest('[title]');
      if (titled && titled.getAttribute('title')) return 'title ' + titled.getAttribute('title');
      const owner = element.closest('[aria-label]');
      if (!owner || getComputedStyle(owner).getPropertyValue('--no-tooltip').trim() === 'true') return null;
      return owner.getAttribute('aria-label');
    };
    const scope = document.querySelector(${JSON.stringify(scope)});
    const parts = Array.from(scope.querySelectorAll('.mappy-node, .mappy-node *'))
      .filter(element => !element.closest('.mappy-node-toggle'));
    const nodes = parts.map(element => ({ element, text: tip(element) })).filter(item => item.text !== null)
      .map(item => (item.element.className || item.element.tagName) + ': ' + item.text);
    const controls = Array.from(scope.querySelectorAll('.mappy-node-toggle:not([hidden]), .mappy-button'));
    const unnamed = controls.filter(element => {
      const shown = tip(element);
      return shown !== element.getAttribute('aria-label') && shown !== 'title ' + element.getAttribute('title');
    }).map(element => element.className);
    return { parts: parts.length, nodes: Array.from(new Set(nodes)), controls: controls.length, unnamed };
  })()`);
}

/** docs/harness.md E34 on this page: a note that embeds maps, in the reading-view path and the live-preview path. */
async function captureEmbeds(recorder, page) {
  // Earlier cases wrote `mappy: true` into heading-document's in-memory frontmatter (the page never rewrites the text);
  // re-putting the notes as they are re-reads the frontmatter from the text, so the host sees the fixtures as shipped.
  for (const path of ['Fixtures/heading-document.md', ...EMBED_NOTES]) {
    await page.harness(`h.putNote(${JSON.stringify(path)}, h.noteSource(${JSON.stringify(path)}))`);
  }
  const sources = await noteSources(page);
  let timing = null;

  await recorder.run('embed-reading', `${EMBED_HOST} を読み込む（閲覧モード: ホストの区画の placeholder を差し替え）`,
    '5 つの `![[…]]` が読み取り専用のマップ（通常・タイムライン・階層図・#見出し の部分木・2,000 ノード）になり、mappy: true のないノート・存在しないノート・ブロック参照は通常の埋め込みのまま。ホストも元ノートも変わらない', async () => {
    timing = await loadFixture(page, EMBED_HOST);
    const maps = expectEmbeds(await page.harness('h.embeds()'));
    expectUnchanged(sources, await noteSources(page));
    const live = await page.harness('h.liveEmbeds()');
    expect(live === maps.length, `${live} live embeds`);
    const nodes = maps.map(embed => embed.nodes.length);
    return `マップ ${maps.length}（ノード ${nodes.join(' / ')}、scale ${maps.map(embed => embed.scale.toFixed(2)).join(' / ')}）、通常の埋め込み ${EMBED_PLAIN.length}、安定まで ${timing.settledMs.toFixed(0)} ms`;
  });

  await recorder.run('embed-node-tooltip', `${EMBED_HOST} の埋め込みのノードに乗せたときの Obsidian の吹き出しを app.js の判定で求める（LEV-199）`,
    '埋め込みのノードの本体のどの要素でも吹き出しは出ない（枠の「マインドマップ: …」も canvas の名前も出ない）。開閉ボタンと「マップで開く」は自分の aria-label を出す', async () => {
    const facts = await tooltipFacts(page, '#harness-pane');
    expect(facts.parts > 0 && facts.controls > 0, `nothing to hover: ${JSON.stringify(facts)}`);
    expect(facts.nodes.length === 0, `tooltips over embedded nodes: ${facts.nodes.slice(0, 5).join(' / ')}`);
    expect(facts.unnamed.length === 0, `controls without their tooltip: ${facts.unnamed.join(', ')}`);
    return `ノードの要素 ${facts.parts} で吹き出し 0、ボタン ${facts.controls} は自分の名前`;
  });

  await recorder.run('embed-first-level', '階層図の埋め込みまでスクロール', 'ルートと第一階層だけが見え、第一階層の各ノードに隠れた子孫の件数（回復する 4、記録する 2、習慣化する 1）。#見出し の埋め込みは最初の「同じ名前」（回復する の下）をルートにその 2 つの子を描く', async () => {
    await revealEmbed(page, 'Fixtures/embed-hierarchy.md');
    const embeds = await page.harness('h.embeds()');
    const hierarchy = embeds.find(embed => embed.src === 'Fixtures/embed-hierarchy.md');
    const titles = hierarchy.nodes.map(node => node.title).sort();
    expect(titles.join(',') === ['講座の構成', '回復する', '記録する', '習慣化する'].sort().join(','), `hierarchy shows ${titles.join(', ')}`);
    const counts = {};
    for (const node of hierarchy.nodes) if (node.collapsed) counts[node.title] = await page.evaluate(`document.querySelector('.mappy-node[data-node-id="${node.id}"] .mappy-node-toggle-mark').textContent`);
    expect(counts['回復する'] === '4' && counts['記録する'] === '2' && counts['習慣化する'] === '1', `fold counts ${JSON.stringify(counts)}`);
    const section = embeds.find(embed => embed.src === 'Fixtures/embed-hierarchy.md#同じ名前');
    const sectionTitles = section.nodes.map(node => node.title).sort();
    expect(sectionTitles.join(',') === ['同じ名前', '十分に眠る', '週に一度は休む'].sort().join(','), `section shows ${sectionTitles.join(', ')}`);
    return `階層図: ${titles.length} ノード、件数 ${JSON.stringify(counts)}。部分木: ${sectionTitles.join(' / ')}`;
  });

  await recorder.run('embed-fold-click', '階層図の埋め込みで「回復する」の開閉ボタンをクリック → もう一度クリック', '一段だけ開いて枠に収まり直し（同じ名前・休息の取り方が見え、その下は閉じたまま）、再クリックで戻る。元ノートは変わらない', async () => {
    const src = 'Fixtures/embed-hierarchy.md';
    const { node } = await embedNode(page, src, '回復する');
    expect(node.toggle, 'no toggle on 回復する');
    await page.click(center(node.toggle).x, center(node.toggle).y);
    await page.settle();
    const opened = (await page.harness('h.embeds()')).find(embed => embed.src === src);
    const titles = opened.nodes.map(item => item.title);
    expect(titles.includes('同じ名前') && titles.includes('休息の取り方') && !titles.includes('十分に眠る'), `after opening: ${titles.join(', ')}`);
    const outside = opened.nodes.filter(item => !inside(item.rect, opened.rect, 2));
    expect(outside.length === 0, `${outside.length} nodes outside the frame after opening`);
    const again = (await embedNode(page, src, '回復する')).node;
    await page.click(center(again.toggle).x, center(again.toggle).y);
    await page.settle();
    const closed = (await page.harness('h.embeds()')).find(embed => embed.src === src);
    expect(closed.nodes.length === 4, `${closed.nodes.length} nodes after closing`);
    expectUnchanged(sources, await noteSources(page));
    return `開いて ${opened.nodes.length} ノード（scale ${opened.scale.toFixed(2)}）、閉じて ${closed.nodes.length}`;
  });

  await recorder.run('embed-2000', '2,000 ノードの埋め込みまでスクロール', 'ルート＋第一階層の 13 ノードだけを描き（残りは件数バッジ）、ホストの読み込み全体が 1 秒以内に安定する', async () => {
    await revealEmbed(page, 'Fixtures/embed-2000.md');
    const embed = (await page.harness('h.embeds()')).find(candidate => candidate.src === 'Fixtures/embed-2000.md');
    expect(embed.nodes.length === 14, `${embed.nodes.length} nodes drawn for 2,000`);
    const total = await page.evaluate(`document.querySelectorAll('.mappy-node').length`);
    expect(timing && timing.settledMs < 1000, `host settled in ${timing?.settledMs} ms`);
    return `描画 ${embed.nodes.length} ノード（ページ全体 ${total}）、ホスト全体の安定まで ${timing.settledMs.toFixed(0)} ms`;
  });

  await recorder.run('embed-source-change', '元ノート embed-timeline を書き換える（第 1 週の名前を変える）→ 元に戻す', 'タイムラインの埋め込みが新しい名前で描き直され、ホストは変わらない。戻すと元の名前に戻る', async () => {
    const path = 'Fixtures/embed-timeline.md';
    await revealEmbed(page, path);
    const original = sources[path];
    await page.harness(`h.putNote(${JSON.stringify(path)}, ${JSON.stringify(original.replace('- 第 1 週: 準備', '- 第 1 週: 準備（更新）'))})`);
    await new Promise(resolveWait => { setTimeout(resolveWait, 120); });
    await page.settle();
    const changed = (await page.harness('h.embeds()')).find(embed => embed.src === path);
    expect(changed.nodes.some(node => node.title === '第 1 週: 準備（更新）'), `titles after change: ${changed.nodes.map(node => node.title).join(', ')}`);
    const after = await noteSources(page);
    expect(after['Fixtures/embed-host.md'] === sources['Fixtures/embed-host.md'], 'host changed');
    await page.harness(`h.putNote(${JSON.stringify(path)}, ${JSON.stringify(original)})`);
    await new Promise(resolveWait => { setTimeout(resolveWait, 120); });
    await page.settle();
    const restored = (await page.harness('h.embeds()')).find(embed => embed.src === path);
    expect(restored.nodes.some(node => node.title === '第 1 週: 準備'), `titles after restore: ${restored.nodes.map(node => node.title).join(', ')}`);
    expectUnchanged(sources, await noteSources(page));
    return `変更後 ${changed.nodes.length} ノード、復元後 ${restored.nodes.length} ノード`;
  });

  await recorder.run('embed-reopen', '「閉じて開き直す」', '古い埋め込みの Component が解放され（live の数が増えない）、同じ 5 つのマップが再表示される', async () => {
    await page.harness('h.reopen()');
    await page.settle();
    const maps = expectEmbeds(await page.harness('h.embeds()'));
    const live = await page.harness('h.liveEmbeds()');
    expect(live === maps.length, `${live} live embeds after reopen`);
    const stray = await page.evaluate(`document.querySelectorAll('.mappy-embed').length`);
    expect(stray === maps.length, `${stray} map frames in the document`);
    return `live ${live}、枠 ${stray}`;
  });

  await recorder.run('embed-dark', 'ページのテーマを暗色にする（body の theme-dark、harness.css の仮の配色）', '配色の導き直しだけで枠・ノード・線が見え、崩れない（Obsidian のテーマそのものではない）', async () => {
    await page.harness('h.setPageTheme("dark")');
    await page.harness('h.scrollTo(0)');
    await page.settle();
    const maps = expectEmbeds(await page.harness('h.embeds()'));
    const colors = await page.evaluate(`(() => { const node = document.querySelector('.mappy-embed .mappy-node.is-root'); const style = getComputedStyle(node); return style.color + ' on ' + style.backgroundColor; })()`);
    return `マップ ${maps.length}、ルートの色 ${colors}`;
  });

  await recorder.run('embed-dark-hierarchy', '暗色のまま階層図の埋め込みへスクロール', '線・枠・件数バッジが暗色でも読める', async () => {
    await revealEmbed(page, 'Fixtures/embed-hierarchy.md');
    const embed = (await page.harness('h.embeds()')).find(candidate => candidate.src === 'Fixtures/embed-hierarchy.md');
    expect(embed.nodes.length === 4, `${embed.nodes.length} nodes`);
    await page.harness('h.setPageTheme("light")');
  });

  await recorder.run('embed-live', `${EMBED_HOST_LIVE} を読み込む（ライブプレビュー相当: 埋め込み先を描いた後にその区画から容器を差し替え）`,
    '同じ 5 つのマップが Obsidian の .internal-embed 容器の中に描かれ、容器の元の内容は隠れる。通常の埋め込みは中身が見えたまま', async () => {
    await loadFixture(page, EMBED_HOST_LIVE);
    const maps = expectEmbeds(await page.harness('h.embeds()'));
    const hosts = await page.evaluate(`document.querySelectorAll('.internal-embed.mappy-embed-host').length`);
    expect(hosts === maps.length, `${hosts} claimed containers`);
    const hidden = await page.evaluate(`Array.from(document.querySelectorAll('.internal-embed.mappy-embed-host > .markdown-embed-content')).every(el => getComputedStyle(el).display === 'none')`);
    expect(hidden, 'Obsidian content still visible inside a claimed container');
    const plainVisible = await page.evaluate(`getComputedStyle(document.querySelector('.internal-embed[src="heading-document"] .markdown-embed-content')).display !== 'none'`);
    expect(plainVisible, 'plain embed content hidden');
    expectUnchanged(sources, await noteSources(page));
    return `容器 ${hosts}、マップ ${maps.length}（ノード ${maps.map(embed => embed.nodes.length).join(' / ')}）`;
  });

  await recorder.run('embed-live-late', `${EMBED_HOST_LIVE_LATE} を読み込む（ライブプレビュー相当で、区画が届いてから容器が document に付くまで 3 フレーム、画面の下の 2 つは 90 フレーム（約 1.5 s）空き、各埋め込みの 1 回目の描画は捨てられる。LEV-91）`,
    '5 つとも claim されてマップになる（容器 5、live 5、枠 5）。区画を渡した直後は待ちの区画があり、捨てられた描画の区画だけが待ち続け（60 s の保持の間は数に入る）、claim も live の増加もなく、待つ間にフレームを使わない', async () => {
    const lateTiming = await loadFixture(page, EMBED_HOST_LIVE_LATE);
    expect(lateTiming.waiting > 0, `${lateTiming.waiting} sections waiting right after the processor received them`);
    const maps = expectEmbeds(await page.harness('h.embeds()'));
    const hosts = await page.evaluate(`document.querySelectorAll('.internal-embed.mappy-embed-host').length`);
    expect(hosts === maps.length, `${hosts} claimed containers`);
    const live = await page.harness('h.liveEmbeds()');
    const frames = await page.evaluate(`document.querySelectorAll('.mappy-embed').length`);
    expect(live === maps.length && frames === maps.length, `live ${live}, frames ${frames}`);
    const hidden = await page.evaluate(`Array.from(document.querySelectorAll('.internal-embed.mappy-embed-host > .markdown-embed-content')).every(el => getComputedStyle(el).display === 'none')`);
    expect(hidden, 'Obsidian content still visible inside a claimed container');
    // The discarded renderings never join: only they keep waiting, through the document's watcher and without a frame of polling.
    const framesBefore = await page.harness('h.productFrames()');
    await new Promise(resolveWait => { setTimeout(resolveWait, 800); });
    const framesAfter = await page.harness('h.productFrames()');
    expect(framesAfter - framesBefore < 100, `${framesAfter - framesBefore} product frames in 800 ms while ${lateTiming.discarded} sections wait (polling would be about ${lateTiming.discarded * 48})`);
    await page.settle();
    const pending = await page.harness('h.pendingClaims()');
    expect(lateTiming.discarded > 0 && pending === lateTiming.discarded, `${pending} sections waiting, expected the ${lateTiming.discarded} discarded ones`);
    const anchors = await page.evaluate(`document.querySelectorAll('.mappy-embed-anchor').length`);
    expect(anchors === maps.length, `${anchors} anchors left in sections (one per map expected)`);
    const liveAfter = await page.harness('h.liveEmbeds()');
    expect(liveAfter === maps.length, `${liveAfter} live embeds after the wait`);
    expectUnchanged(sources, await noteSources(page));
    return `容器 ${hosts}、マップ ${maps.length}（ノード ${maps.map(embed => embed.nodes.length).join(' / ')}）、待ちの区画 ${lateTiming.waiting} → ${pending}（捨てられた描画の区画 ${lateTiming.discarded}）、800 ms のフレーム ${framesAfter - framesBefore}、anchor ${anchors}、live ${liveAfter}、安定まで ${lateTiming.settledMs.toFixed(0)} ms`;
  });

  await recorder.run('embed-live-dispose', 'プラグインの無効化と同じ解放（disposeEmbeds）', 'マップが消え、Obsidian の容器がそのまま（元の内容が再び見える）残る。live が 0', async () => {
    await page.harness('h.disposeEmbeds()');
    await page.settle();
    const live = await page.harness('h.liveEmbeds()');
    const frames = await page.evaluate(`document.querySelectorAll('.mappy-embed').length`);
    const claimed = await page.evaluate(`document.querySelectorAll('.mappy-embed-host').length`);
    const visible = await page.evaluate(`Array.from(document.querySelectorAll('.internal-embed > .markdown-embed-content')).filter(el => getComputedStyle(el).display !== 'none').length`);
    const pending = await page.harness('h.pendingClaims()');
    expect(live === 0 && frames === 0 && claimed === 0 && pending === 0, `live ${live}, frames ${frames}, claimed ${claimed}, waiting ${pending}`);
    expect(visible >= EMBED_EXPECTED.length, `${visible} embed contents visible`);
    return `live ${live}、枠 ${frames}、待ちの区画 ${pending}、容器の内容が見える ${visible}`;
  });

  await recorder.run('embed-reading-dispose', `${EMBED_HOST} を読み込み直してから解放（disposeEmbeds）`, 'placeholder の span が元の src で戻り、マップの枠と Component が残らない', async () => {
    await loadFixture(page, EMBED_HOST);
    await page.harness('h.disposeEmbeds()');
    await page.settle();
    const live = await page.harness('h.liveEmbeds()');
    const frames = await page.evaluate(`document.querySelectorAll('.mappy-embed').length`);
    const srcs = await page.evaluate(`Array.from(document.querySelectorAll('#harness-pane .internal-embed:not(.image-embed)'), el => el.getAttribute('src'))`);
    const wanted = ['uneven-branches', 'embed-timeline', 'embed-hierarchy', 'embed-hierarchy#同じ名前', 'embed-2000', ...EMBED_PLAIN];
    expect(live === 0 && frames === 0, `live ${live}, frames ${frames}`);
    expect(srcs.join(',') === wanted.join(','), `placeholders: ${srcs.join(', ')}`);
    return `placeholder ${srcs.length}`;
  });
}

const EMBED_NODES_FIXTURE = 'embed-nodes';
const EMBED_CYCLE_FIXTURE = 'embed-cycle';
/**
 * The maps the `embed-nodes` map calls, in layout order (top to bottom): the item's text as written, the called
 * root's text the item shows, the note it names, and how many of the called root's children show while the
 * levels below start folded.
 */
const EMBED_NODE_EXPECTED = [
  { text: '![[embed-timeline]]', title: '講座の進行', source: 'Fixtures/embed-timeline.md', children: 4 },
  { text: '![[embed-hierarchy#同じ名前]]', title: '同じ名前', source: 'Fixtures/embed-hierarchy.md#同じ名前', children: 2 },
  { text: '![[embed-2000]]', title: '講座（2000ノード）', source: 'Fixtures/embed-2000.md', children: 13 },
  { text: '![[embed-timeline]]', title: '講座の進行', source: 'Fixtures/embed-timeline.md', children: 4 },
  { text: '![[embed-cycle]]', title: '循環の相手', source: 'Fixtures/embed-cycle.md', children: 3 },
];
/** Nodes of `embed-nodes` that stay links (their rendered label) and the image node (no label). */
const EMBED_NODE_LINKS = ['embed-nodes', '文中の embed-timeline はリンク', 'heading-document', '存在しないノート', 'embed-hierarchy#^block'];
const EMBED_NODE_NOTES = ['Fixtures/embed-nodes.md', 'Fixtures/embed-cycle.md', 'Fixtures/embed-timeline.md', 'Fixtures/embed-hierarchy.md', 'Fixtures/embed-2000.md'];
const READ_ONLY_NOTICE = '呼び出したマップは読み取り専用です。ダブルクリックで元のマップを開けます。';

/** Two rectangles overlap when they share area beyond a rounding margin. */
function overlaps(a, b, margin = 1) {
  return a.x + a.width > b.x + margin && b.x + b.width > a.x + margin && a.y + a.height > b.y + margin && b.y + b.height > a.y + margin;
}

/** Pairs of nodes on screen whose boxes overlap; none is what every layout promises. */
function overlappingPairs(nodes) {
  const pairs = [];
  for (let index = 0; index < nodes.length; index += 1) {
    for (let other = index + 1; other < nodes.length; other += 1) {
      if (overlaps(nodes[index].rect, nodes[other].rect)) pairs.push(`${nodes[index].title}×${nodes[other].title}`);
    }
  }
  return pairs;
}

/**
 * Every called map as expected: the calling items (top to bottom) show the called roots' text, name their notes,
 * and have exactly the called roots' children under them, every one of them marked as called and read-only,
 * their own deeper levels folded. `own` is the count of the host's own nodes on screen.
 */
function expectCalledBranches(nodes) {
  // Matched as a set: the order on screen depends on the layout (stages along an axis, sides of the balanced map).
  const key = item => `${item.title}\u0000${item.source}`;
  const roots = nodes.filter(node => node.calledRoot).sort((left, right) => key(left).localeCompare(key(right)));
  const wantedRoots = [...EMBED_NODE_EXPECTED].sort((left, right) => key(left).localeCompare(key(right)));
  expect(roots.length === wantedRoots.length, `${roots.length} calling items, expected ${wantedRoots.length}`);
  wantedRoots.forEach((wanted, index) => {
    const root = roots[index];
    expect(root.title === wanted.title && root.called && root.source === wanted.source, `calling item ${index}: ${JSON.stringify({ title: root.title, source: root.source })}`);
    expect(!root.collapsed, `${wanted.title} is folded`);
  });
  const called = nodes.filter(node => node.called && !node.calledRoot);
  const wantedChildren = EMBED_NODE_EXPECTED.reduce((sum, wanted) => sum + wanted.children, 0);
  expect(called.length === wantedChildren, `${called.length} called nodes shown, expected ${wantedChildren}`);
  expect(called.every(node => node.source !== null), 'a called node does not name its note');
  const badges = called.filter(node => node.toggle !== null);
  expect(badges.every(node => node.collapsed && node.badge > 0), `called nodes with children are not all folded: ${badges.filter(node => !node.collapsed).map(node => node.title).join(', ')}`);
  expect(nodes.filter(node => node.title === '講座の進行').length === 2, 'the same map is not shown twice');
  return { roots, called };
}

async function embedNodeSources(page) {
  const sources = {};
  for (const path of EMBED_NODE_NOTES) sources[path] = await page.harness(`h.noteSource(${JSON.stringify(path)})`);
  return sources;
}

/** The n-th node of this title, as `h.node` finds it. */
async function calledNode(page, title, occurrence = 0) {
  const node = await page.harness(`h.node(${JSON.stringify(title)}, ${occurrence})`);
  expect(node, `node missing: ${title} (${occurrence})`);
  return node;
}

/** The node under the pointer must be reachable at the current zoom; zoom towards it until it is legible. */
async function zoomTowards(page, point, target) {
  for (let step = 0; step < 12 && (await page.harness('h.viewport()')).scale < target; step += 1) {
    await page.wheel(point.x, point.y, 0, -200, 2);
  }
  await page.settle();
}

/** Layout classes of every node on screen, keyed by id: which layout each was drawn in. */
async function layoutClasses(page) {
  return page.evaluate(`Object.fromEntries(Array.from(document.querySelectorAll('#harness-pane .mappy-node'), node => [node.dataset.nodeId,
    ['timeline', 'hierarchy', 'balanced'].find(mode => node.classList.contains('is-' + mode)) ?? 'mindmap']))`);
}

/** docs/harness.md E35 on this page: a map whose nodes call other maps (§5 M12), drawn as branches. */
async function captureEmbedNodes(recorder, page) {
  for (const path of EMBED_NODE_NOTES) await page.harness(`h.putNote(${JSON.stringify(path)}, h.noteSource(${JSON.stringify(path)}))`);
  const sources = await embedNodeSources(page);
  const unchanged = async () => { const after = await embedNodeSources(page); for (const path of EMBED_NODE_NOTES) expect(after[path] === sources[path], `${path} changed`); };
  const menuItems = () => page.evaluate(`Array.from(document.querySelectorAll('.menu .menu-item-title'), item => item.textContent)`);
  const closeMenu = async () => { await page.key('Escape', 'Escape', 27); await page.settle(); };
  const menuAction = (point, title) => contextMenuAction(page, point, title);
  let listeners = null;
  let firstCount = 0;

  await recorder.run('embed-node-draw', `${EMBED_NODES_FIXTURE} を読み込む（mappy: true のマップ。ノードのテキストが ![[…]] だけの項目を持つ）`,
    '5 つの項目がそれぞれ呼び出し先のルートの文（タイムライン・#見出し の部分木・2,000 ノード・同じマップの 2 回目・循環の相手）を表示し、その子が通常の枝として右に並ぶ。それより下は折りたたみ。枠はなく、呼び出したノードは控えめな文字色で読み上げの説明に元ノートのパス、項目には link の印。自分自身・文中の埋め込み・mappy: true のないノート・存在しないノート・ブロック参照はリンク、画像は画像。どのノートも変わらない', async () => {
    const timing = await loadFixture(page, EMBED_NODES_FIXTURE);
    const nodes = await page.harness('h.nodes()');
    const { roots, called } = expectCalledBranches(nodes);
    expect(nodes.length === timing.nodes + called.length, `DOM has ${nodes.length} nodes, parser found ${timing.nodes} own + ${called.length} called`);
    // The host's own link nodes; the called `embed-cycle` branch carries a link of the same text (its call back to this note).
    const links = nodes.filter(node => !node.called && EMBED_NODE_LINKS.includes(node.title));
    expect(links.length === EMBED_NODE_LINKS.length && links.every(node => node.link), `link nodes: ${links.map(node => `${node.title}→${node.link}`).join(', ')}`);
    expect(nodes.filter(node => node.link && !node.called).length === EMBED_NODE_LINKS.length && nodes.filter(node => node.image).length === 1, `links ${nodes.filter(node => node.link && !node.called).length}, images ${nodes.filter(node => node.image).length}`);
    const shapes = await page.evaluate(`({
      frames: document.querySelectorAll('.mappy-embed').length,
      marks: document.querySelectorAll('#harness-pane .mappy-node.is-called-root > .mappy-node-content > .mappy-node-call-mark svg').length,
      editable: document.querySelectorAll('#harness-pane .mappy-node textarea, #harness-pane .mappy-node [contenteditable]').length,
      readOnly: document.querySelectorAll('#harness-pane .mappy-node.is-called[aria-readonly="true"]').length,
    })`);
    expect(shapes.frames === 0, `${shapes.frames} frames`);
    expect(shapes.marks === EMBED_NODE_EXPECTED.length, `${shapes.marks} link marks`);
    expect(shapes.editable === 0, `${shapes.editable} editable elements`);
    // The calling items are the host's own, edited as any node: only the grafted nodes are read-only.
    expect(shapes.readOnly === called.length, `${shapes.readOnly} read-only nodes, expected ${called.length}`);
    const hostColor = nodes.find(node => node.title === 'リンクのまま').color;
    const calledColor = called[0].color;
    expect(hostColor !== calledColor, `called text colour ${calledColor} equals the host's ${hostColor}`);
    expect(overlappingPairs(nodes).length === 0, `overlaps: ${overlappingPairs(nodes).join(', ')}`);
    await unchanged();
    listeners = await page.harness('h.listeners()');
    firstCount = nodes.length;
    return `ノード ${nodes.length}（自分 ${timing.nodes}、呼び出し ${roots.length} 項目＋${called.length}）、リンク ${links.length}、画像 1、文字色 ${hostColor} → ${calledColor}、安定まで ${timing.settledMs.toFixed(0)} ms、購読 vault ${listeners.vault}／workspace ${listeners.workspace}`;
  });

  await recorder.run('node-tooltip', `${EMBED_NODES_FIXTURE} のノードと入力中の欄に乗せたときの Obsidian の吹き出しを app.js の判定で求める（LEV-199）`,
    '自分のノード・呼び出したノード・入力中の欄のどの要素でも吹き出しは出ない（題名も canvas の操作説明も「ノードのテキスト」も出ない）。開閉ボタンと左下・右下・右上のボタンは自分の aria-label を出す', async () => {
    const shown = await tooltipFacts(page, '#harness-pane');
    expect(shown.parts > 0 && shown.controls > 0, `nothing to hover: ${JSON.stringify(shown)}`);
    expect(shown.nodes.length === 0, `tooltips over nodes: ${shown.nodes.slice(0, 5).join(' / ')}`);
    expect(shown.unnamed.length === 0, `controls without their tooltip: ${shown.unnamed.join(', ')}`);
    await openInlineEditor(page, 'リンクのまま');
    const editing = await tooltipFacts(page, '#harness-pane');
    const input = await page.evaluate(`document.querySelectorAll('#harness-pane .mappy-node .mappy-inline-input').length`);
    await page.key('Escape', 'Escape', 27);
    await page.settle();
    expect(input === 1, `${input} inline inputs inside a node`);
    expect(editing.nodes.length === 0, `tooltips while editing: ${editing.nodes.slice(0, 5).join(' / ')}`);
    await unchanged();
    return `ノードの要素 ${shown.parts}（編集中 ${editing.parts}）で吹き出し 0、ボタン ${shown.controls} は自分の名前`;
  });

  for (const mode of ['timeline', 'hierarchy', 'balanced']) {
    await recorder.run(`embed-node-layout-${mode}`, `${EMBED_NODES_FIXTURE} を ${mode} で開く（view state。mappy-layout は書かない）`, '呼び出した木も現在のレイアウトで配置され（呼び出し先の mappy-layout は使わない）、ノードが重ならない。左右バランスでは呼び出した木も側に従う', async () => {
      await loadFixture(page, EMBED_NODES_FIXTURE, mode);
      const nodes = await page.harness('h.nodes()');
      expectCalledBranches(nodes);
      const classes = await layoutClasses(page);
      const wrong = nodes.filter(node => classes[node.id] !== mode);
      expect(wrong.length === 0, `${wrong.length} nodes not drawn in ${mode}: ${wrong.slice(0, 3).map(node => node.title).join(', ')}`);
      const pairs = overlappingPairs(nodes);
      expect(pairs.length === 0, `overlaps: ${pairs.join(', ')}`);
      if (mode === 'balanced') {
        const sides = await balancedSides(page);
        expect(!sides.error && sides.strays.length === 0, `balanced strays: ${sides.strays?.join(', ') ?? sides.error}`);
      }
      await unchanged();
      return `ノード ${nodes.length}、重なり 0`;
    });
  }
  await loadFixture(page, EMBED_NODES_FIXTURE, 'mindmap');

  await recorder.run('embed-node-select-fold', '呼び出したノード「第 2 週: 回復」をクリック → その開閉ボタンをクリック → Space', '呼び出したノードが選択され、開閉ボタンで一段開き（3 ノード）、Space で閉じる。もう一つの同じマップと原文は変わらない', async () => {
    const stage = await calledNode(page, '第 2 週: 回復', 0);
    expect(stage.called && stage.collapsed && stage.badge === 3, `stage: ${JSON.stringify({ called: stage.called, collapsed: stage.collapsed, badge: stage.badge })}`);
    await zoomTowards(page, center(stage.rect), 0.8);
    const zoomed = await calledNode(page, '第 2 週: 回復', 0);
    await page.click(center(zoomed.rect).x, center(zoomed.rect).y);
    const selected = (await page.harness('h.nodes()')).filter(node => node.selected);
    expect(selected.length === 1 && selected[0].id === stage.id, `selected: ${selected.map(node => node.title).join(', ')}`);
    const before = (await page.harness('h.nodes()')).length;
    const again = await calledNode(page, '第 2 週: 回復', 0);
    expect(again.toggle, 'fold control missing');
    await page.click(center(again.toggle).x, center(again.toggle).y);
    await page.settle();
    const opened = await page.harness('h.nodes()');
    expect(opened.length === before + 2, `${before} → ${opened.length} nodes after opening`);
    expect(!(await calledNode(page, '第 2 週: 回復', 0)).collapsed, 'still folded');
    expect((await calledNode(page, '第 2 週: 回復', 1)).collapsed, 'the other copy opened too');
    expect(opened.some(node => node.title === '睡眠' && node.called && node.collapsed && node.badge === 1), '睡眠 is not shown folded with its one child');
    await page.key(' ', 'Space', 32);
    await page.settle();
    expect((await page.harness('h.nodes()')).length === before, 'Space did not close the branch');
    await unchanged();
    return `${before} → ${opened.length} → ${before} ノード`;
  });

  await recorder.run('embed-node-readonly', '呼び出したノード「第 2 週: 回復」を選択したまま Enter／Tab／Delete／F2 → ドラッグ → 右クリック', '原文は変わらず、インライン入力は開かず、通知「読み取り専用」が出る。ドラッグはゴーストも移動も起こさない。右クリックは「元のマップを開く」「折りたたみ」と履歴だけ', async () => {
    const stage = await calledNode(page, '第 2 週: 回復', 0);
    await page.click(center(stage.rect).x, center(stage.rect).y);
    const notices = [];
    for (const [key, code, keyCode] of [['Enter', 'Enter', 13], ['Tab', 'Tab', 9], ['Delete', 'Delete', 46], ['F2', 'F2', 113]]) {
      const before = (await page.harness('h.notices')).length;
      await page.key(key, code, keyCode);
      await page.settle();
      const editing = await page.evaluate(`document.querySelector('.mappy-inline-input') !== null`);
      expect(!editing, `the inline editor opened on ${key}`);
      const log = await page.harness('h.notices');
      expect(log.length === before + 1 && log[log.length - 1] === READ_ONLY_NOTICE, `${key}: notices ${JSON.stringify(log.slice(before))}`);
      notices.push(key);
    }
    await unchanged();
    const from = center((await calledNode(page, '第 2 週: 回復', 0)).rect);
    const target = await nodeInfo(page, 'リンクのまま');
    await page.mouse('mouseMoved', from.x, from.y);
    await page.mouse('mousePressed', from.x, from.y, { button: 'left', clickCount: 1 });
    await page.mouse('mouseMoved', from.x + 8, from.y + 2, { button: 'left' });
    await page.mouse('mouseMoved', from.x + 40, from.y + 20, { button: 'left' });
    const dragging = await page.evaluate(`({ ghost: document.querySelector('.mappy-drag-ghost') !== null, source: document.querySelector('.mappy-node.is-drag-source') !== null, placeholder: !document.querySelector('.mappy-drop-placeholder')?.hidden })`);
    await page.mouse('mouseMoved', center(target.rect).x, center(target.rect).y, { button: 'left' });
    await page.mouse('mouseReleased', center(target.rect).x, center(target.rect).y, { button: 'left', clickCount: 1 });
    await page.settle();
    expect(!dragging.ghost && !dragging.source && !dragging.placeholder, `drag state: ${JSON.stringify(dragging)}`);
    await unchanged();
    const point = center((await calledNode(page, '第 2 週: 回復', 0)).rect);
    await page.mouse('mouseMoved', point.x, point.y);
    await page.mouse('mousePressed', point.x, point.y, { button: 'right', clickCount: 1 });
    await page.mouse('mouseReleased', point.x, point.y, { button: 'right', clickCount: 1 });
    const items = await menuItems();
    await page.screenshot(join(recorder.directory, 'embed-node-context-menu.png'));
    await closeMenu();
    expect(JSON.stringify(items) === JSON.stringify(['元のマップを開く', '折りたたみ', '元に戻す', 'やり直す']), `menu items: ${items.join(' / ')}`);
    return `${notices.join('・')} で通知、ドラッグなし、メニュー ${items.join('・')}`;
  });

  await recorder.run('embed-node-dblclick', '呼び出したノード「第 3 週: 記録」をダブルクリック', '呼び出したノート（embed-timeline）をマップで開く要求が、このノートを基準に出る。インライン入力は開かない', async () => {
    const stage = await calledNode(page, '第 3 週: 記録', 0);
    await page.dblclick(center(stage.rect).x, center(stage.rect).y);
    const activity = await page.harness('h.activity');
    const last = activity.at(-1);
    expect(last && last.kind === 'link' && last.detail === 'Fixtures/embed-timeline.md（Fixtures/embed-nodes.md から）', `last activity: ${JSON.stringify(last)}`);
    const editing = await page.evaluate(`document.querySelector('.mappy-inline-input') !== null`);
    expect(!editing, 'the inline editor opened');
    return last.detail;
  });

  await recorder.run('embed-node-caller-edit', '項目「講座の進行」（![[embed-timeline]]）をクリック → F2 → Escape → Delete → 右クリック「元に戻す」', 'F2 は原文 ![[embed-timeline]] をそのまま編集し、取り消すと枝が戻る。Delete で項目ごと呼び出した木が消え、元に戻すで戻る。呼び出したノートは変わらない', async () => {
    const calling = await calledNode(page, '講座の進行', 0);
    expect(calling.calledRoot, 'not the calling item');
    await page.click(center(calling.rect).x, center(calling.rect).y);
    await page.key('F2', 'F2', 113);
    const value = await page.evaluate(`document.activeElement?.classList.contains('mappy-inline-input') ? document.activeElement.value : null`);
    expect(value === '![[embed-timeline]]', `inline editor holds ${JSON.stringify(value)}`);
    await page.key('Escape', 'Escape', 27);
    await page.settle();
    const before = await page.harness('h.nodes()');
    expectCalledBranches(before);
    await page.click(center((await calledNode(page, '講座の進行', 0)).rect).x, center((await calledNode(page, '講座の進行', 0)).rect).y);
    await page.key('Delete', 'Delete', 46);
    await page.settle();
    const after = await page.harness('h.noteSource("Fixtures/embed-nodes.md")');
    // Two items and one mention in a sentence carry the text; the item goes, the other two stay.
    const mentions = text => (text.match(/!\[\[embed-timeline\]\]/gu) ?? []).length;
    expect(mentions(after) === mentions(sources['Fixtures/embed-nodes.md']) - 1, `the item was not removed (${mentions(after)} mentions)`);
    expect(!after.includes('  - ![[embed-timeline]]\n  - ![[embed-hierarchy#同じ名前]]'), 'the first item is still there');
    const fewer = await page.harness('h.nodes()');
    expect(fewer.length === before.length - 5, `${before.length} → ${fewer.length} nodes after Delete`);
    expect(fewer.filter(node => node.title === '講座の進行').length === 1, 'the other copy went too');
    expect((await page.harness('h.noteSource("Fixtures/embed-timeline.md")')) === sources['Fixtures/embed-timeline.md'], 'the called note changed');
    const blank = await emptyCanvasPoint(page, 80);
    await menuAction(blank, '元に戻す');
    expect((await page.harness('h.noteSource("Fixtures/embed-nodes.md")')) === sources['Fixtures/embed-nodes.md'], 'Undo did not restore the note');
    expectCalledBranches(await page.harness('h.nodes()'));
    await unchanged();
    return `入力欄の値 ${value}、Delete で ${before.length} → ${fewer.length} ノード、元に戻すで ${(await page.harness('h.nodes()')).length}`;
  });

  await recorder.run('embed-node-source-change', '元ノート embed-timeline を書き換える（第 1 週の名前を変える）→ 元に戻す', '2 つの呼び出しの枝が新しい名前で描き直され、このノートは変わらない。戻すと元の名前に戻る', async () => {
    const path = 'Fixtures/embed-timeline.md';
    const original = sources[path];
    await page.harness(`h.putNote(${JSON.stringify(path)}, ${JSON.stringify(original.replace('- 第 1 週: 準備', '- 第 1 週: 準備（更新）'))})`);
    await new Promise(resolveWait => { setTimeout(resolveWait, 120); });
    await page.settle();
    const changed = (await page.harness('h.nodes()')).filter(node => node.title === '第 1 週: 準備（更新）');
    expect(changed.length === 2 && changed.every(node => node.called), `nodes after change: ${changed.length}`);
    expect((await page.harness('h.noteSource("Fixtures/embed-nodes.md")')) === sources['Fixtures/embed-nodes.md'], 'the host changed');
    await page.harness(`h.putNote(${JSON.stringify(path)}, ${JSON.stringify(original)})`);
    await new Promise(resolveWait => { setTimeout(resolveWait, 120); });
    await page.settle();
    const restored = (await page.harness('h.nodes()')).filter(node => node.title === '第 1 週: 準備');
    expect(restored.length === 2, `nodes after restore: ${restored.length}`);
    await unchanged();
    return `変更後 ${changed.length}、復元後 ${restored.length} ノード`;
  });

  await recorder.run('embed-node-recall', '存在しなかった「存在しないノート」を mappy: true のノートとして作る → 消す', 'このノートを編集しなくても、リンクだったノードが呼び出し先のルート「後から作ったマップ」になり、消すとリンクに戻る（呼び出し先の cache・存在の変化で判定し直す）', async () => {
    const path = 'Fixtures/存在しないノート.md';
    const title = '存在しないノート';
    const before = await nodeInfo(page, title);
    expect(before.link === title && !before.called, `before: ${JSON.stringify(before)}`);
    await page.harness(`h.putNote(${JSON.stringify(path)}, ${JSON.stringify('---\nmappy: true\n---\n## 後から作ったマップ\n- 一\n- 二\n')})`);
    await new Promise(resolveWait => { setTimeout(resolveWait, 120); });
    await page.settle();
    const made = await page.harness('h.node("後から作ったマップ")');
    expect(made && made.calledRoot && made.source === path, `after create: ${JSON.stringify(made)}`);
    const children = (await page.harness('h.nodes()')).filter(node => node.source === path && !node.calledRoot);
    expect(children.length === 2, `${children.length} called children`);
    await page.harness(`h.removeNote(${JSON.stringify(path)})`);
    await new Promise(resolveWait => { setTimeout(resolveWait, 120); });
    await page.settle();
    const after = await nodeInfo(page, title);
    expect(after.link === title && !after.called, `after: ${JSON.stringify(after)}`);
    expectCalledBranches(await page.harness('h.nodes()'));
    await unchanged();
    return `リンク → 枝（${children.length} 子）→ リンク。ホスト不変`;
  });

  await recorder.run('embed-node-2000', '2,000 ノードのマップの項目「講座（2000ノード）」の子「ノード 1」の開閉ボタンをクリック → もう一度', 'ルートの子 13 個だけが開いた状態で始まり（それぞれ 100 以上のノードを折りたたみ）、一段開くと 13 ノード増え、閉じると戻る。操作が止まらない', async () => {
    const big = await calledNode(page, '講座（2000ノード）', 0);
    const first = await calledNode(page, 'ノード 1', 0);
    expect(big.calledRoot && first.called && first.collapsed && first.badge > 100, `ノード 1: ${JSON.stringify({ collapsed: first.collapsed, badge: first.badge })}`);
    await zoomTowards(page, center(first.rect), 0.8);
    const zoomed = await calledNode(page, 'ノード 1', 0);
    expect(zoomed.toggle, 'fold control missing');
    const before = (await page.harness('h.nodes()')).length;
    const started = Date.now();
    await page.click(center(zoomed.toggle).x, center(zoomed.toggle).y);
    await page.settle();
    const openMs = Date.now() - started;
    const opened = (await page.harness('h.nodes()')).length;
    expect(opened === before + 13, `${before} → ${opened} nodes after opening`);
    const again = await calledNode(page, 'ノード 1', 0);
    await page.click(center(again.toggle).x, center(again.toggle).y);
    await page.settle();
    expect((await page.harness('h.nodes()')).length === before, 'did not close');
    await unchanged();
    return `ノード 1 のバッジ ${first.badge}、${before} → ${opened} → ${before} ノード、開くのに ${openMs} ms（安定待ち込み）`;
  });

  await recorder.run('embed-node-export', '「全体表示」→ SVG 書き出しと Excalidraw のシーン', '呼び出した木が通常のノードとして SVG（foreignObject）とシーン（ブロック）に入る（LEV-73 の受入）', async () => {
    const fit = await page.harness('h.button("全体表示")');
    await page.click(center(fit).x, center(fit).y);
    await page.settle();
    const nodes = await page.harness('h.nodes()');
    const svg = await page.harness('h.export.svg()');
    const facts = await svgFacts(page, svg.svg);
    expect(!facts.error, `SVG is not well formed: ${facts.error}`);
    expect(facts.objects === nodes.length, `${facts.objects} objects for ${nodes.length} nodes`);
    for (const wanted of EMBED_NODE_EXPECTED) expect(facts.labels.includes(wanted.title), `label missing in the SVG: ${wanted.title}`);
    expect(facts.labels.includes('第 2 週: 回復') && facts.labels.includes('ノード 1'), 'called children missing in the SVG');
    const calledInFile = await page.evaluate(`new DOMParser().parseFromString(${JSON.stringify(svg.svg)}, 'image/svg+xml').querySelectorAll('.mappy-node.is-called').length`);
    expect(calledInFile === nodes.filter(node => node.called).length, `${calledInFile} called nodes in the file`);
    await writeFile(join(recorder.directory, 'export-embed-nodes.svg'), svg.svg);
    const scene = await page.harness('h.scene()');
    expect(scene && scene.blocks.length === nodes.length, `scene has ${scene?.blocks.length} blocks for ${nodes.length} nodes`);
    await unchanged();
    return `SVG foreignObject ${facts.objects}（呼び出し ${calledInFile}）、線 ${facts.paths}、バッジ ${facts.badges.length}、シーンのブロック ${scene.blocks.length}`;
  });

  await recorder.run('embed-node-cycle', `${EMBED_CYCLE_FIXTURE} を読み込み、呼び出した枝の「循環（…）」を開く`, '互いに呼び出す 2 つのマップでも描画が止まらない: embed-nodes がルート「呼び出しの検証」の枝になり、その中の ![[embed-cycle]] はリンク（枝の中の呼び出しは 1 段だけ）。自分自身の ![[embed-cycle]] もリンク', async () => {
    await page.evaluate('window.scrollTo(0, 0)');
    const timing = await loadFixture(page, EMBED_CYCLE_FIXTURE);
    const nodes = await page.harness('h.nodes()');
    const root = nodes.find(node => node.calledRoot);
    expect(root && root.title === '呼び出しの検証' && root.source === 'Fixtures/embed-nodes.md', `calling item: ${JSON.stringify(root)}`);
    const self = await nodeInfo(page, 'embed-cycle');
    expect(self && !self.called && self.link === 'embed-cycle', 'the note itself is not a link');
    const cycle = await calledNode(page, '循環（embed-cycle はこのノートを呼び出す）');
    expect(cycle.called && cycle.collapsed, 'the called branch is not folded');
    await zoomTowards(page, center(cycle.rect), 0.8);
    const zoomed = await calledNode(page, '循環（embed-cycle はこのノートを呼び出す）');
    await page.click(center(zoomed.toggle).x, center(zoomed.toggle).y);
    await page.settle();
    const opened = await page.harness('h.nodes()');
    expect(opened.length === nodes.length + 1, `${nodes.length} → ${opened.length} nodes after opening`);
    const back = opened.find(node => node.called && !node.calledRoot && node.link === 'embed-cycle');
    expect(back, 'the call back to this note is not a link inside the called branch');
    expect(opened.filter(node => node.calledRoot).length === 1, 'a second level of calls was grafted');
    await unchanged();
    return `呼び出し 1（embed-nodes、${nodes.length} → ${opened.length} ノード）、枝の中の呼び出しはリンク、安定まで ${timing.settledMs.toFixed(0)} ms`;
  });

  await recorder.run('embed-node-reopen', `${EMBED_NODES_FIXTURE} に戻り「閉じて開き直す」`, '古い購読が残らず、同じ 5 つの呼び出しが再表示され、購読数が最初の表示と同じ', async () => {
    await loadFixture(page, EMBED_NODES_FIXTURE);
    await page.harness('h.reopen()');
    await page.settle();
    const nodes = await page.harness('h.nodes()');
    expectCalledBranches(nodes);
    expect(nodes.length === firstCount, `${nodes.length} nodes, first draw had ${firstCount}`);
    const now = await page.harness('h.listeners()');
    expect(now.vault === listeners.vault && now.workspace === listeners.workspace, `listeners ${JSON.stringify(listeners)} → ${JSON.stringify(now)}`);
    await unchanged();
    return `ノード ${nodes.length}、購読 vault ${now.vault}／workspace ${now.workspace}（初回と同じ）`;
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
    '- 対象外: 保存、リンク解決、Obsidian の配色（テーマのケースは harness.css の仮の配色で class と変数の切り替えだけを確認）、日本語 IME。ここでの PASS は Obsidian 実機（③ E01〜E35）の PASS ではない。',
    '- 埋め込み（embed-*）: ホストノートをページが閲覧モード相当（ホストの区画を post-processor に渡す）とライブプレビュー相当（埋め込み先を Obsidian 風の容器に描いてから渡す）で描く。Obsidian の描画順序・ホバープレビュー・実テーマは含まない。',
    '- マップの中の呼び出し（embed-node-*、E35 のこのページ版）: `mappy: true` のマップ `embed-nodes`／`embed-cycle` を map view で開き、`![[…]]` だけの項目が呼び出し先のルートになってその木が枝として並ぶことを確認する。ダブルクリックはリンク解決の要求の記録だけで、実際の遷移は③。',
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

/**
 * LEV-86: two free topics with one heading (the same map called twice, a repeated heading) have keys of their
 * own in `mappy-topics` (`同じ見出し`, `同じ見出し (2)`), so dragging one leaves the other where it is, and both keep
 * their ids through the save.
 */
async function captureSameTitledTopics(recorder, page) {
  const fixturePath = 'Fixtures/free-topics.md';
  const original = await readFile(join(root, 'tests', 'fixtures', 'free-topics.md'), 'utf8');
  const duplicated = original.replace('## 位置のないトピック', '## 同じ見出し\n- a\n\n## 同じ見出し\n- b\n\n## 位置のないトピック');
  const title = '同じ見出し';

  await recorder.run('topic-same-heading-drag', 'free-topics に `## 同じ見出し` の区画を 2 つ足して開く → 2 つ目の「同じ見出し」を右下へ 120×60 px ドラッグ',
    '2 つ目だけが動き、1 つ目は画面上の位置を保つ。mappy-topics には `同じ見出し (2)` のキーだけが書かれ（`同じ見出し:` は書かれない）、保存後も 2 つの id が変わらず、動かした方が選択されたまま', async () => {
    await page.harness(`h.putNote(${JSON.stringify(fixturePath)}, ${JSON.stringify(duplicated)})`);
    await loadFixture(page, TOPIC_FIXTURE, 'mindmap');
    const base = await page.harness('h.source()');
    expect(base === duplicated, 'the duplicated note did not load');
    const first = await page.harness(`h.node(${JSON.stringify(title)}, 0)`);
    const second = await page.harness(`h.node(${JSON.stringify(title)}, 1)`);
    expect(first && second && first.id !== second.id, 'the two same-titled topics are not both shown');
    expect(second.rect.y > first.rect.y, 'the second topic does not sit below the first in the default column');
    const view = await page.harness('h.viewport()');
    const from = center(second.rect);
    await page.drag(from.x, from.y, from.x + 120, from.y + 60);
    await page.settle();
    const firstAfter = await page.harness(`h.node(${JSON.stringify(title)}, 0)`);
    const secondAfter = await page.harness(`h.node(${JSON.stringify(title)}, 1)`);
    expect(firstAfter && secondAfter, 'a same-titled topic is missing after the drag');
    const travel = (was, now) => `${(now.rect.x - was.rect.x).toFixed(1)}, ${(now.rect.y - was.rect.y).toFixed(1)}`;
    expect(Math.abs(firstAfter.rect.x - first.rect.x) < 1.5 && Math.abs(firstAfter.rect.y - first.rect.y) < 1.5, `the first topic moved on screen by ${travel(first, firstAfter)}`);
    expect(Math.abs(secondAfter.rect.x - second.rect.x - 120) < 1.5 && Math.abs(secondAfter.rect.y - second.rect.y - 60) < 1.5, `the second topic moved by ${travel(second, secondAfter)}`);
    expect(firstAfter.id === first.id && secondAfter.id === second.id, `ids changed: ${first.id}/${second.id} → ${firstAfter.id}/${secondAfter.id}`);
    expect(secondAfter.selected && !firstAfter.selected, 'the dragged topic is not the selection');
    const moved = await page.harness('h.source()');
    const entry = topicEntry(moved, `${title} (2)`);
    expect(entry && /^同じ見出し \(2\): \{ mindmap: \[-?\d+, -?\d+\] \}$/u.test(entry), `mappy-topics entry: ${entry}`);
    expect(!topicEntry(moved, title), `an entry was written for the first topic: ${topicEntry(moved, title)}`);
    expect(bodyOf(moved) === bodyOf(base), 'the body or the sections changed');
    const body = await page.harness('h.node("講座の本体")');
    const offset = { x: Math.round((secondAfter.rect.x - body.rect.x) / view.scale), y: Math.round((secondAfter.rect.y - body.rect.y) / view.scale) };
    expect(entry === `${title} (2): { mindmap: [${offset.x}, ${offset.y}] }`, `expected [${offset.x}, ${offset.y}] from the screen, got ${entry}`);
    return `${entry}、1 つ目の移動 0 px、id ${first.id}/${second.id} 不変`;
  });
  // The recorder has taken its screenshot of the moved state; the fixture goes back to its text for the cases after.
  await page.harness(`h.putNote(${JSON.stringify(fixturePath)}, ${JSON.stringify(original)})`);
  await page.settle();
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
    'Obsidian 実機（③ E01〜E35）: このページは代替ではない。実機の確認は実機を使うチケットの記録に残す。',
    'トラックパッドのピンチ・二本指スクロール、ネイティブ IME、モバイル: headless の合成入力では確認できない。',
    '⌘Z／⌘⇧Z の連打: headless Chrome 153 は修飾キー付きのキー入力を CDP で繰り返すと応答しなくなるため、フリートピックの Undo／Redo は右クリックメニューで実行した。キー経由の Undo は edit-inline-memory の 1 回と jsdom のテストで確認する。',
    '性能計測（基準端末・条件・p50／p95）: `node scripts/browser-harness-perf.mjs` が `artifacts/performance/` に記録する。ここでは時刻の生値だけを残す。',
    '埋め込み（E34）の実機: Obsidian の閲覧モード・ライブプレビュー・ホバープレビューでの描画、テーマ、埋め込み内リンクの遷移、Mappy 無効化での復帰は、このページの閲覧モード相当／ライブプレビュー相当のケース（embed-*）では確認できない。',
    'マップの中の呼び出し（E35）の実機: ダブルクリックでの実際の遷移（マップとして開くルーティング）、別 leaf の未保存の編集での更新、実テーマでの文字色と link の印、ホストを閉じたあとの残留（DevTools）は、このページのケース（embed-node-*）では確認できない。',
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
  let recorder;
  let aborted = null;
  try {
    // Chrome, its profile and the SIGKILL on a wedged browser live in withHarnessPage.
    await withHarnessPage(chrome, { output, window: WINDOW, fixture: OPERATION_FIXTURE, pane: PANE }, async page => {
      recorder = new Recorder(page, directory);
      await captureFixtures(recorder, page, timings);
      await captureOperations(recorder, page);
      await captureHierarchyRows(recorder, page);
      await captureThemes(recorder, page);
      await captureVisibleLayouts(recorder, page);
      await captureTopicOperations(recorder, page);
      await captureCallAsTopic(recorder, page);
      await captureSameTitledTopics(recorder, page);
      await captureExport(recorder, page);
      await captureEmbeds(recorder, page);
      await captureEmbedNodes(recorder, page);
      await writeFile(join(directory, 'timings.json'), `${JSON.stringify({ commit, chrome: chromeVersion(chrome), timings }, null, 2)}\n`);
    });
  } catch (error) {
    // Keep the record of what did run; the exit code still reports the abort.
    aborted = error instanceof Error ? error.message : String(error);
  }
  const cases = recorder?.cases ?? [];
  if (aborted) notExecuted.unshift(`途中で中断したため、残りのケースは未実施（${aborted}）。再実行する。`);
  const record = recordMarkdown({ startedAt: startedAt.toISOString(), chrome, version: chromeVersion(chrome), commit, cases, timings, notExecuted });
  await writeFile(join(directory, 'record.md'), record);
  const failed = cases.filter(entry => entry.result === 'FAIL').length;
  console.info(`Wrote ${relative(root, directory)} (${cases.length} cases, ${failed} failed${aborted ? ', aborted' : ''}).`);
  if (failed > 0 || aborted) process.exitCode = 1;
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsScript) await main();
