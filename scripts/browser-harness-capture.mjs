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

/** The harness palettes (harness.css, stand-ins laid out like app.css): what each theme should resolve to. */
const PALETTE = {
  light: { background: 'rgb(255, 255, 255)', page: 'rgb(246, 246, 246)', text: 'rgb(34, 34, 34)' },
  dark: { background: 'rgb(30, 30, 30)', page: 'rgb(38, 38, 38)', text: 'rgb(218, 218, 218)' },
};

/**
 * M14 (LEV-60): the settings' theme puts `theme-light` / `theme-dark` on the map container only,
 * and styles.css re-derives the palette there. Each combination of page theme and map theme is
 * checked by computed colour, then left as it was (page light, map following the page).
 */
async function captureThemes(recorder, page) {
  await loadFixture(page, OPERATION_FIXTURE);
  let lightLink = null;
  await recorder.run('theme-follow-light', 'ページ明色、マップ「Obsidian に従う」（既定）', 'コンテナに theme class がなく、キャンバスはページと同じ明色の配色', async () => {
    await page.harness('h.setPageTheme("light")');
    await page.harness('h.setMapTheme("follow")');
    await page.settle();
    const themes = await page.harness('h.themes()');
    expect(themes.container.length === 0, `container carries ${themes.container.join(' ')}`);
    const colors = await themeColors(page);
    expect(colors.canvas === PALETTE.light.background && colors.text === PALETTE.light.text, `canvas ${colors.canvas}, text ${colors.text}`);
    expect(colors.link, 'no internal link rendered in a node');
    lightLink = colors.link;
    return `canvas ${colors.canvas}, text ${colors.text}, link ${colors.link}, color-scheme ${colors.scheme}`;
  });

  await recorder.run('theme-dark-on-light', 'ページ明色のまま、マップ「暗色」→「閉じて開き直す」', 'コンテナだけが theme-dark。キャンバス・文字・リンクが暗色の配色になり、ページの背景は明色のまま。開き直しても保たれる', async () => {
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
    await page.harness('h.reopen()');
    await page.settle();
    themes = await page.harness('h.themes()');
    colors = await themeColors(page);
    expect(themes.container.join(' ') === 'theme-dark' && colors.canvas === PALETTE.dark.background, `after reopen: ${themes.container.join(' ')}, canvas ${colors.canvas}`);
    return `canvas ${colors.canvas}, text ${colors.text}, link ${darkLink}（明色時 ${lightLink}）, page ${colors.page}, color-scheme ${colors.scheme}, 開き直し後も theme-dark`;
  });

  await recorder.run('theme-light-on-dark', 'ページ暗色、マップ「明色」', 'コンテナだけが theme-light。キャンバス・文字が明色の配色になり、ページの背景は暗色', async () => {
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
    return `canvas ${colors.canvas}, text ${colors.text}, link ${colors.link}, page ${colors.page}, color-scheme ${colors.scheme}`;
  });

  await recorder.run('theme-follow-dark', 'ページ暗色のまま、マップ「Obsidian に従う」', 'theme class が外れ、キャンバスがページと同じ暗色に戻る', async () => {
    await page.harness('h.setMapTheme("follow")');
    await page.settle();
    const themes = await page.harness('h.themes()');
    expect(themes.container.length === 0, `container carries ${themes.container.join(' ')}`);
    const colors = await themeColors(page);
    expect(colors.canvas === PALETTE.dark.background && colors.text === PALETTE.dark.text, `canvas ${colors.canvas}, text ${colors.text}`);
    expect(colors.page === PALETTE.dark.page, `page background ${colors.page}`);
    return `canvas ${colors.canvas}, text ${colors.text}, page ${colors.page}`;
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
      for (let step = 1; step <= 12; step += 1) await page.mouse('mouseMoved', from.x + (to.x - from.x) * step / 12, from.y + (to.y - from.y) * step / 12, { button: 'left' });
      await page.settle();
      const under = await page.evaluate(`document.elementFromPoint(${Math.round(to.x)}, ${Math.round(to.y)})?.closest('[data-node-id]')?.querySelector('.mappy-node-label')?.textContent?.trim() ?? null`);
      const preview = await page.evaluate(`(() => { const host = document.querySelector('.mappy-view');
        const root = Array.from(host.querySelectorAll('.mappy-node.is-topic')).find(n => n.querySelector('.mappy-node-label')?.textContent?.trim() === '位置のないトピック');
        return { placeholder: !host.querySelector('.mappy-drop-placeholder').hidden, connector: Boolean(host.querySelector('.mappy-edges path.is-preview')), merging: root?.classList.contains('is-merging') }; })()`);
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

  await recorder.run('embed-live-dispose', 'プラグインの無効化と同じ解放（disposeEmbeds）', 'マップが消え、Obsidian の容器がそのまま（元の内容が再び見える）残る。live が 0', async () => {
    await page.harness('h.disposeEmbeds()');
    await page.settle();
    const live = await page.harness('h.liveEmbeds()');
    const frames = await page.evaluate(`document.querySelectorAll('.mappy-embed').length`);
    const claimed = await page.evaluate(`document.querySelectorAll('.mappy-embed-host').length`);
    const visible = await page.evaluate(`Array.from(document.querySelectorAll('.internal-embed > .markdown-embed-content')).filter(el => getComputedStyle(el).display !== 'none').length`);
    expect(live === 0 && frames === 0 && claimed === 0, `live ${live}, frames ${frames}, claimed ${claimed}`);
    expect(visible >= EMBED_EXPECTED.length, `${visible} embed contents visible`);
    return `live ${live}、枠 ${frames}、容器の内容が見える ${visible}`;
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
/** The frames the `embed-nodes` map draws inside its nodes, in document order: the node's text, the map, its layout and the nodes drawn. */
const EMBED_NODE_EXPECTED = [
  { title: '![[embed-timeline]]', src: 'Fixtures/embed-timeline.md', layout: 'timeline', nodes: 5 },
  { title: '![[embed-hierarchy#同じ名前]]', src: 'Fixtures/embed-hierarchy.md#同じ名前', layout: 'hierarchy', nodes: 3 },
  { title: '![[embed-2000]]', src: 'Fixtures/embed-2000.md', layout: 'mindmap', nodes: 14 },
  { title: '![[embed-timeline]]', src: 'Fixtures/embed-timeline.md', layout: 'timeline', nodes: 5 },
  { title: '![[embed-cycle]]', src: 'Fixtures/embed-cycle.md', layout: 'mindmap', nodes: 4 },
];
/** Nodes of `embed-nodes` that stay links (their rendered label) and the image node (no label). */
const EMBED_NODE_LINKS = ['embed-nodes', '文中の embed-timeline はリンク', 'heading-document', '存在しないノート', 'embed-hierarchy#^block'];
const EMBED_NODE_NOTES = ['Fixtures/embed-nodes.md', 'Fixtures/embed-cycle.md', 'Fixtures/embed-timeline.md', 'Fixtures/embed-hierarchy.md', 'Fixtures/embed-2000.md'];

/**
 * Every frame inside a node as expected: the map it names, its layout, its nodes inside the frame and the
 * frame inside the node, never magnified. Frames are matched top to bottom (the map lays the nodes out in
 * source order), since the DOM order changes once a node is redrawn.
 */
function expectNodeEmbeds(embeds, nodeCount) {
  expect(embeds.length === EMBED_NODE_EXPECTED.length, `${embeds.length} frames in nodes, expected ${EMBED_NODE_EXPECTED.length}`);
  const ordered = [...embeds].sort((left, right) => left.node.rect.y - right.node.rect.y);
  EMBED_NODE_EXPECTED.forEach((wanted, index) => {
    const { node, frame } = ordered[index];
    expect(node.title === wanted.title && node.embed, `frame ${index}: node ${node.title}`);
    expect(frame.src === wanted.src, `${node.title}: ${frame.src}, expected ${wanted.src}`);
    expect(frame.layout === wanted.layout, `${node.title}: layout ${frame.layout}, expected ${wanted.layout}`);
    expect(frame.nodes.length === wanted.nodes && !frame.message, `${node.title}: ${frame.nodes.length} nodes, message ${frame.message}`);
    expect(frame.scale !== null && frame.scale <= 1.0001, `${node.title}: scale ${frame.scale}`);
    expect(inside(frame.rect, node.rect, 1), `${node.title}: frame outside its node`);
    const outside = frame.nodes.filter(inner => !inside(inner.rect, frame.rect, 2));
    expect(outside.length === 0, `${node.title}: ${outside.length} nodes outside the frame`);
  });
  if (nodeCount !== undefined) expect(embeds.length + EMBED_NODE_LINKS.length + 1 + 5 === nodeCount, `own nodes ${nodeCount}`);
}

async function embedNodeSources(page) {
  const sources = {};
  for (const path of EMBED_NODE_NOTES) sources[path] = await page.harness(`h.noteSource(${JSON.stringify(path)})`);
  return sources;
}

/** The frame inside the node of this text (the n-th of that text) and one of the nodes drawn in it. */
async function frameNode(page, title, innerTitle, occurrence = 0) {
  const embeds = (await page.harness('h.nodeEmbeds()')).filter(embed => embed.node.title === title);
  const embed = embeds[occurrence];
  expect(embed, `frame missing in ${title} (${occurrence})`);
  const inner = embed.frame.nodes.find(candidate => candidate.title === innerTitle);
  expect(inner, `node missing in ${title}: ${innerTitle}`);
  return { embed, inner };
}

/** Zoom the outer map towards a point until its scale reaches `target`, as a user would before working inside a small frame. */
async function zoomTowards(page, point, target) {
  for (let step = 0; step < 12 && (await page.harness('h.viewport()')).scale < target; step += 1) {
    await page.wheel(point.x, point.y, 0, -200, 2);
  }
  await page.settle();
}

/** docs/harness.md E35 on this page: a map whose nodes call other maps (§5 M12). */
async function captureEmbedNodes(recorder, page) {
  for (const path of EMBED_NODE_NOTES) await page.harness(`h.putNote(${JSON.stringify(path)}, h.noteSource(${JSON.stringify(path)}))`);
  const sources = await embedNodeSources(page);
  const unchanged = async () => { const after = await embedNodeSources(page); for (const path of EMBED_NODE_NOTES) expect(after[path] === sources[path], `${path} changed`); };
  let listeners = null;

  await recorder.run('embed-node-draw', `${EMBED_NODES_FIXTURE} を読み込む（mappy: true のマップ。ノードのテキストが ![[…]] だけの項目を持つ）`,
    '5 つのノードが読み取り専用のマップの枠（タイムライン・#見出し の部分木・2,000 ノードはルート＋13・同じマップの 2 回目・循環の相手）になり、枠は Fit で拡大なし、ノードの中に収まる。自分自身・文中の埋め込み・mappy: true のないノート・存在しないノート・ブロック参照はリンク、画像は画像。どのノートも変わらない', async () => {
    const timing = await loadFixture(page, EMBED_NODES_FIXTURE);
    const own = await page.harness('h.nodes()');
    expect(own.length === timing.nodes, `DOM has ${own.length} own nodes, parser found ${timing.nodes}`);
    const embeds = await page.harness('h.nodeEmbeds()');
    expectNodeEmbeds(embeds, own.length);
    const links = own.filter(node => EMBED_NODE_LINKS.includes(node.title));
    expect(links.length === EMBED_NODE_LINKS.length && links.every(node => !node.embed && node.link), `link nodes: ${links.map(node => `${node.title}→${node.link}`).join(', ')}`);
    expect(own.filter(node => node.link).length === EMBED_NODE_LINKS.length && own.filter(node => node.image).length === 1, `links ${own.filter(node => node.link).length}, images ${own.filter(node => node.image).length}`);
    const shapes = await page.evaluate(`({
      frames: document.querySelectorAll('.mappy-embed').length,
      nested: document.querySelectorAll('.mappy-embed .mappy-embed').length,
      editable: document.querySelectorAll('.mappy-embed textarea, .mappy-embed [contenteditable]').length,
    })`);
    expect(shapes.frames === EMBED_NODE_EXPECTED.length && shapes.nested === 0, `frames ${shapes.frames}, nested ${shapes.nested}`);
    expect(shapes.editable === 0, `${shapes.editable} editable elements inside frames`);
    await unchanged();
    listeners = await page.harness('h.listeners()');
    return `ノード ${own.length}（枠 ${embeds.length}、リンク ${links.length}、画像 1）、枠内のノード ${embeds.map(embed => embed.frame.nodes.length).join(' / ')}、scale ${embeds.map(embed => embed.frame.scale.toFixed(2)).join(' / ')}、安定まで ${timing.settledMs.toFixed(0)} ms、購読 vault ${listeners.vault}／workspace ${listeners.workspace}`;
  });

  await recorder.run('embed-node-wheel', 'タイムラインの枠の上で Ctrl＋ホイール（拡大）と修飾キーなしのホイール（パン）', '外側のマップがズーム・パンし、枠の中のマップは動かない（枠内で独立にパン・ズームしない）', async () => {
    const { embed } = await frameNode(page, '![[embed-timeline]]', '講座の進行');
    const point = center(embed.frame.rect);
    const innerBefore = await page.evaluate(`document.querySelector('.mappy-node.is-embed .mappy-embed .mappy-world').style.transform`);
    const before = await page.harness('h.viewport()');
    await zoomTowards(page, point, 1);
    const zoomed = await page.harness('h.viewport()');
    expect(zoomed.scale > before.scale, `scale ${before.scale} → ${zoomed.scale}`);
    const { embed: after } = await frameNode(page, '![[embed-timeline]]', '講座の進行');
    await page.wheel(center(after.frame.rect).x, center(after.frame.rect).y, 0, 100);
    const panned = await page.harness('h.viewport()');
    expect(Math.abs(panned.y - zoomed.y + 100) < 1, `viewport y moved by ${(panned.y - zoomed.y).toFixed(1)}`);
    const innerAfter = await page.evaluate(`document.querySelector('.mappy-node.is-embed .mappy-embed .mappy-world').style.transform`);
    expect(innerAfter === innerBefore, `inner world moved: ${innerBefore} → ${innerAfter}`);
    return `scale ${before.scale.toFixed(3)} → ${zoomed.scale.toFixed(3)}、ホイールで y ${zoomed.y.toFixed(0)} → ${panned.y.toFixed(0)}、枠内の transform 不変`;
  });

  await recorder.run('embed-node-select', '枠の中のノード「講座の進行」をクリック', '枠を持つ外側のノード（![[embed-timeline]]）が選択され、枠の中では何も選択されない', async () => {
    const { embed, inner } = await frameNode(page, '![[embed-timeline]]', '講座の進行');
    await page.click(center(inner.rect).x, center(inner.rect).y);
    const own = await page.harness('h.nodes()');
    const selected = own.filter(node => node.selected);
    expect(selected.length === 1 && selected[0].id === embed.node.id, `selected: ${selected.map(node => node.title).join(', ')}`);
    const innerSelected = await page.evaluate(`document.querySelectorAll('.mappy-embed .mappy-node.is-selected').length`);
    expect(innerSelected === 0, `${innerSelected} inner nodes selected`);
    await unchanged();
  });

  await recorder.run('embed-node-fold', 'タイムラインの枠の中で「第 2 週: 回復」の開閉ボタンをクリック → もう一度クリック', '枠の中だけが一段開いて Fit し直し、枠の大きさ・外側のノード数・選択・もう一つの同じ枠は変わらない。再クリックで戻り、どのノートも変わらない', async () => {
    const first = await frameNode(page, '![[embed-timeline]]', '第 2 週: 回復', 0);
    const other = (await frameNode(page, '![[embed-timeline]]', '講座の進行', 1)).embed;
    expect(first.inner.toggle, 'fold control missing inside the frame');
    const ownBefore = (await page.harness('h.nodes()')).length;
    await page.click(center(first.inner.toggle).x, center(first.inner.toggle).y);
    await page.settle();
    const opened = (await frameNode(page, '![[embed-timeline]]', '第 2 週: 回復', 0)).embed;
    expect(opened.frame.nodes.length === first.embed.frame.nodes.length + 2, `${first.embed.frame.nodes.length} → ${opened.frame.nodes.length} nodes in the frame`);
    expect(opened.frame.nodes.every(node => inside(node.rect, opened.frame.rect, 2)), 'a node left the frame');
    expect(Math.abs(opened.frame.rect.width - first.embed.frame.rect.width) < 1 && Math.abs(opened.frame.rect.height - first.embed.frame.rect.height) < 1, 'the frame changed size');
    expect((await page.harness('h.nodes()')).length === ownBefore, 'own nodes changed');
    expect((await page.harness('h.node("![[embed-timeline]]")')).selected, 'selection changed');
    const otherAfter = (await frameNode(page, '![[embed-timeline]]', '講座の進行', 1)).embed;
    expect(otherAfter.frame.nodes.length === other.frame.nodes.length, `the other frame changed: ${other.frame.nodes.length} → ${otherAfter.frame.nodes.length}`);
    const again = (await frameNode(page, '![[embed-timeline]]', '第 2 週: 回復', 0)).inner;
    await page.click(center(again.toggle).x, center(again.toggle).y);
    await page.settle();
    const closed = (await frameNode(page, '![[embed-timeline]]', '第 2 週: 回復', 0)).embed;
    expect(closed.frame.nodes.length === first.embed.frame.nodes.length, `${closed.frame.nodes.length} nodes after closing`);
    await unchanged();
    return `枠内 ${first.embed.frame.nodes.length} → ${opened.frame.nodes.length} → ${closed.frame.nodes.length} ノード、もう一つの枠 ${other.frame.nodes.length} のまま`;
  });

  await recorder.run('embed-node-dblclick', '枠の中をダブルクリック', '呼び出したノート（embed-timeline）をマップで開く要求が、このノートを基準に出る。インライン入力は開かない', async () => {
    const { inner } = await frameNode(page, '![[embed-timeline]]', '講座の進行');
    await page.dblclick(center(inner.rect).x, center(inner.rect).y);
    const activity = await page.harness('h.activity');
    const last = activity.at(-1);
    expect(last && last.kind === 'link' && last.detail === 'Fixtures/embed-timeline.md（Fixtures/embed-nodes.md から）', `last activity: ${JSON.stringify(last)}`);
    const editing = await page.evaluate(`document.querySelector('.mappy-inline-input') !== null`);
    expect(!editing, 'the inline editor opened');
    return last.detail;
  });

  await recorder.run('embed-node-edit', 'F2 → Escape', 'インライン入力に原文（![[embed-timeline]]）がそのまま入り、取り消すと枠が同じまま戻る', async () => {
    const { embed } = await frameNode(page, '![[embed-timeline]]', '講座の進行');
    await page.click(center(embed.node.rect).x, embed.node.rect.y + 2);
    await page.key('F2', 'F2', 113);
    const value = await page.evaluate(`document.activeElement?.classList.contains('mappy-inline-input') ? document.activeElement.value : null`);
    expect(value === '![[embed-timeline]]', `inline editor holds ${JSON.stringify(value)}`);
    await page.key('Escape', 'Escape', 27);
    await page.settle();
    const embeds = await page.harness('h.nodeEmbeds()');
    expectNodeEmbeds(embeds);
    await unchanged();
    return `入力欄の値 ${value}`;
  });

  await recorder.run('embed-node-source-change', '元ノート embed-timeline を書き換える（第 1 週の名前を変える）→ 元に戻す', '2 つのタイムラインの枠が新しい名前で描き直され、このノートは変わらない。戻すと元の名前に戻る', async () => {
    const path = 'Fixtures/embed-timeline.md';
    const original = sources[path];
    await page.harness(`h.putNote(${JSON.stringify(path)}, ${JSON.stringify(original.replace('- 第 1 週: 準備', '- 第 1 週: 準備（更新）'))})`);
    await new Promise(resolveWait => { setTimeout(resolveWait, 120); });
    await page.settle();
    const changed = (await page.harness('h.nodeEmbeds()')).filter(embed => embed.frame.src === path);
    expect(changed.length === 2 && changed.every(embed => embed.frame.nodes.some(node => node.title === '第 1 週: 準備（更新）')), `titles after change: ${changed.map(embed => embed.frame.nodes.map(node => node.title).join(',')).join(' / ')}`);
    expect((await page.harness('h.noteSource("Fixtures/embed-nodes.md")')) === sources['Fixtures/embed-nodes.md'], 'the host changed');
    await page.harness(`h.putNote(${JSON.stringify(path)}, ${JSON.stringify(original)})`);
    await new Promise(resolveWait => { setTimeout(resolveWait, 120); });
    await page.settle();
    const restored = (await page.harness('h.nodeEmbeds()')).filter(embed => embed.frame.src === path);
    expect(restored.every(embed => embed.frame.nodes.some(node => node.title === '第 1 週: 準備')), 'titles after restore');
    await unchanged();
    return `変更後 ${changed.map(embed => embed.frame.nodes.length).join(' / ')} ノード、復元後 ${restored.map(embed => embed.frame.nodes.length).join(' / ')} ノード`;
  });

  await recorder.run('embed-node-recall', '存在しなかった「存在しないノート」を mappy: true のノートとして作る → 消す', 'このノートを編集しなくても、リンクだったノードが枠になり、消すとリンクに戻る（呼び出し先の cache・存在の変化で判定し直す）', async () => {
    const path = 'Fixtures/存在しないノート.md';
    const title = '存在しないノート';
    const before = await nodeInfo(page, title);
    expect(before.link === title && !before.embed, `before: ${JSON.stringify(before)}`);
    await page.harness(`h.putNote(${JSON.stringify(path)}, ${JSON.stringify('---\nmappy: true\n---\n## 後から作ったマップ\n- 一\n- 二\n')})`);
    await page.settle();
    const embeds = await page.harness('h.nodeEmbeds()');
    const made = embeds.find(embed => embed.frame.src === path);
    expect(made && made.node.title === `![[${title}]]` && made.frame.nodes.length === 3, `frames after create: ${embeds.map(embed => embed.frame.src).join(', ')}`);
    expect(embeds.length === EMBED_NODE_EXPECTED.length + 1, `${embeds.length} frames`);
    await page.harness(`h.removeNote(${JSON.stringify(path)})`);
    await page.settle();
    const after = await nodeInfo(page, title);
    expect(after.link === title && !after.embed, `after: ${JSON.stringify(after)}`);
    expectNodeEmbeds(await page.harness('h.nodeEmbeds()'));
    await unchanged();
    return `リンク → 枠（${made.frame.nodes.length} ノード）→ リンク。ホスト不変`;
  });

  await recorder.run('embed-node-resize', '枠の高さを CSS 変数（--mappy-node-embed-height）で 220 → 300px に変える → 戻す', '枠を持つノードの実測が変わり、外側の配置が追従する（下のノードが下がり、線もつながったまま）。戻すと元の位置', async () => {
    const below = '同じマップをもう一度';
    const before = await nodeInfo(page, below);
    const { scale } = await page.harness('h.viewport()');
    await page.evaluate(`document.getElementById('harness-pane').style.setProperty('--mappy-node-embed-height', '300px')`);
    await page.settle();
    const grown = (await page.harness('h.nodeEmbeds()'))[0];
    expect(Math.abs(grown.frame.rect.height - 300 * scale) < 2, `frame height ${grown.frame.rect.height.toFixed(1)}, expected ${(300 * scale).toFixed(1)}`);
    const after = await nodeInfo(page, below);
    expect(after.rect.y > before.rect.y + 20 * scale, `${below} y ${before.rect.y.toFixed(1)} → ${after.rect.y.toFixed(1)}`);
    await page.evaluate(`document.getElementById('harness-pane').style.removeProperty('--mappy-node-embed-height')`);
    await page.settle();
    const restored = await nodeInfo(page, below);
    expect(Math.abs(restored.rect.y - before.rect.y) < 1, `${below} y after restore ${restored.rect.y.toFixed(1)}, was ${before.rect.y.toFixed(1)}`);
    return `枠 ${(220 * scale).toFixed(0)} → ${grown.frame.rect.height.toFixed(0)} px、下のノード y ${before.rect.y.toFixed(0)} → ${after.rect.y.toFixed(0)} → ${restored.rect.y.toFixed(0)}`;
  });

  await recorder.run('embed-node-collapse', '「呼び出したマップ」の開閉ボタンをクリック → Space で開く', '3 つの枠がノードごと消えて購読が減り（Component の解放）、再展開で同じ枠が戻り購読数も戻る', async () => {
    const node = await nodeInfo(page, '呼び出したマップ');
    expect(node.toggle, 'fold control missing');
    await page.click(center(node.toggle).x, center(node.toggle).y);
    await page.settle();
    const folded = await page.harness('h.nodeEmbeds()');
    expect(folded.length === EMBED_NODE_EXPECTED.length - 3, `${folded.length} frames while folded`);
    const fewer = await page.harness('h.listeners()');
    expect(fewer.vault < listeners.vault && fewer.workspace < listeners.workspace, `listeners ${JSON.stringify(listeners)} → ${JSON.stringify(fewer)}`);
    await page.key(' ', 'Space', 32);
    await page.settle();
    expectNodeEmbeds(await page.harness('h.nodeEmbeds()'));
    const back = await page.harness('h.listeners()');
    expect(back.vault === listeners.vault && back.workspace === listeners.workspace, `listeners after expand ${JSON.stringify(back)}`);
    await unchanged();
    return `枠 ${EMBED_NODE_EXPECTED.length} → ${folded.length} → ${EMBED_NODE_EXPECTED.length}、購読 vault ${listeners.vault} → ${fewer.vault} → ${back.vault}`;
  });

  await recorder.run('embed-node-drag', '「全体表示」のあと、枠の中からドラッグして「リンクのまま」の中央へ離す', '枠を持つノードそのものが移動し（枠の中のノードではない）、原文の行が「リンクのまま」の子の末尾へ移る。元に戻す', async () => {
    const fit = await page.harness('h.button("全体表示")');
    await page.click(center(fit).x, center(fit).y);
    await page.settle();
    const { embed, inner } = await frameNode(page, '![[embed-timeline]]', '講座の進行');
    const target = await nodeInfo(page, 'リンクのまま');
    const from = center(inner.rect);
    const to = center(target.rect);
    // Straight to the slot: a pointer wandering over the nodes in between previews their slots and shifts the layout under itself.
    await page.mouse('mouseMoved', from.x, from.y);
    await page.mouse('mousePressed', from.x, from.y, { button: 'left', clickCount: 1 });
    await page.mouse('mouseMoved', from.x + 8, from.y + 2, { button: 'left' });
    const dragging = await page.evaluate(`JSON.stringify({ ghost: document.querySelector('.mappy-drag-ghost') !== null, source: document.querySelector('.mappy-node.is-drag-source')?.getAttribute('aria-label') ?? null, inner: document.querySelector('.mappy-embed .is-drag-source') !== null })`);
    await page.mouse('mouseMoved', to.x, to.y, { button: 'left' });
    await page.mouse('mouseMoved', to.x + 1, to.y, { button: 'left' });
    await page.mouse('mouseReleased', to.x + 1, to.y, { button: 'left', clickCount: 1 });
    await page.settle();
    const started = JSON.parse(dragging);
    expect(started.ghost && started.source === '![[embed-timeline]]' && !started.inner, `drag state: ${dragging}`);
    const after = await page.harness('h.noteSource("Fixtures/embed-nodes.md")');
    expect(after !== sources['Fixtures/embed-nodes.md'], 'nothing moved');
    expect(after.includes('  - ![[sample-image.svg]]\n  - ![[embed-timeline]]\n'), `moved line not at the end of リンクのまま:\n${after}`);
    expect((after.match(/!\[\[embed-timeline\]\]/gu) ?? []).length === (sources['Fixtures/embed-nodes.md'].match(/!\[\[embed-timeline\]\]/gu) ?? []).length, 'the embed text was duplicated or lost');
    const moved = await page.harness('h.nodeEmbeds()');
    expect(moved.length === EMBED_NODE_EXPECTED.length, `${moved.length} frames after the move`);
    expect((await page.harness('h.noteSource("Fixtures/embed-timeline.md")')) === sources['Fixtures/embed-timeline.md'], 'the called note changed');
    await page.harness(`h.putNote("Fixtures/embed-nodes.md", ${JSON.stringify(sources['Fixtures/embed-nodes.md'])})`);
    await new Promise(resolveWait => { setTimeout(resolveWait, 120); });
    await page.settle();
    await unchanged();
    return `${embed.node.title} を「リンクのまま」の子の末尾へ。原文で復元`;
  });

  await recorder.run('embed-node-cycle', `${EMBED_CYCLE_FIXTURE} を読み込み、枠の中の「循環（…）」を開く`, '互いに呼び出す 2 つのマップでも描画が止まらない: embed-nodes が枠になり、その中の ![[embed-cycle]] はリンク（枠の中に枠はない）。自分自身の ![[embed-cycle]] もリンク', async () => {
    await page.evaluate('window.scrollTo(0, 0)');
    const timing = await loadFixture(page, EMBED_CYCLE_FIXTURE);
    const embeds = await page.harness('h.nodeEmbeds()');
    expect(embeds.length === 1 && embeds[0].frame.src === 'Fixtures/embed-nodes.md', `frames: ${embeds.map(embed => embed.frame.src).join(', ')}`);
    expect(embeds[0].frame.nodes.length === 5, `${embeds[0].frame.nodes.length} nodes in the frame`);
    const self = await nodeInfo(page, 'embed-cycle');
    expect(self && !self.embed, 'the note itself is not a link');
    const { inner } = await frameNode(page, '![[embed-nodes]]', '循環（embed-cycle はこのノートを呼び出す）');
    await zoomTowards(page, center(inner.rect), 1);
    const zoomed = (await frameNode(page, '![[embed-nodes]]', '循環（embed-cycle はこのノートを呼び出す）')).inner;
    expect(zoomed.toggle, 'fold control missing inside the frame');
    await page.click(center(zoomed.toggle).x, center(zoomed.toggle).y);
    await page.settle();
    const opened = (await page.harness('h.nodeEmbeds()'))[0];
    expect(opened.frame.nodes.length === 6, `${opened.frame.nodes.length} nodes after opening`);
    const shapes = await page.evaluate(`(() => {
      const frame = document.querySelector('.mappy-node.is-embed .mappy-embed');
      const back = Array.from(frame.querySelectorAll('.mappy-node')).find(node => node.getAttribute('aria-label') === '![[embed-cycle]]');
      return { frames: document.querySelectorAll('.mappy-embed').length, nested: frame.querySelectorAll('.mappy-embed').length,
        backIsLink: Boolean(back && back.querySelector('a.internal-link') && !back.classList.contains('is-embed')) };
    })()`);
    expect(shapes.frames === 1 && shapes.nested === 0 && shapes.backIsLink, `frames ${shapes.frames}, nested ${shapes.nested}, link ${shapes.backIsLink}`);
    await unchanged();
    return `枠 1（embed-nodes、${embeds[0].frame.nodes.length} → ${opened.frame.nodes.length} ノード）、枠の中の枠 0、安定まで ${timing.settledMs.toFixed(0)} ms`;
  });

  await recorder.run('embed-node-reopen', `${EMBED_NODES_FIXTURE} に戻り「閉じて開き直す」`, '古い枠と購読が残らず、同じ 5 つの枠が再表示され、購読数が最初の表示と同じ', async () => {
    await loadFixture(page, EMBED_NODES_FIXTURE);
    await page.harness('h.reopen()');
    await page.settle();
    expectNodeEmbeds(await page.harness('h.nodeEmbeds()'));
    const frames = await page.evaluate(`document.querySelectorAll('.mappy-embed').length`);
    expect(frames === EMBED_NODE_EXPECTED.length, `${frames} frames in the document`);
    const now = await page.harness('h.listeners()');
    expect(now.vault === listeners.vault && now.workspace === listeners.workspace, `listeners ${JSON.stringify(listeners)} → ${JSON.stringify(now)}`);
    await unchanged();
    return `枠 ${frames}、購読 vault ${now.vault}／workspace ${now.workspace}（初回と同じ）`;
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
    '- マップの中の呼び出し（embed-node-*、E35 のこのページ版）: `mappy: true` のマップ `embed-nodes`／`embed-cycle` を map view で開き、`![[…]]` だけのノードが枠になることを確認する。「マップで開く」とダブルクリックはリンク解決の要求の記録だけで、実際の遷移は③。',
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
    'Obsidian 実機（③ E01〜E35）: このページは代替ではない。実機の確認は実機を使うチケットの記録に残す。',
    'トラックパッドのピンチ・二本指スクロール、ネイティブ IME、モバイル: headless の合成入力では確認できない。',
    '⌘Z／⌘⇧Z の連打: headless Chrome 153 は修飾キー付きのキー入力を CDP で繰り返すと応答しなくなるため、フリートピックの Undo／Redo は右クリックメニューで実行した。キー経由の Undo は edit-inline-memory の 1 回と jsdom のテストで確認する。',
    '性能計測（基準端末・条件・p50／p95）: `node scripts/browser-harness-perf.mjs` が `artifacts/performance/` に記録する。ここでは時刻の生値だけを残す。',
    '埋め込み（E34）の実機: Obsidian の閲覧モード・ライブプレビュー・ホバープレビューでの描画、テーマ、埋め込み内リンクの遷移、Mappy 無効化での復帰は、このページの閲覧モード相当／ライブプレビュー相当のケース（embed-*）では確認できない。',
    'マップの中の呼び出し（E35）の実機: ダブルクリック・「マップで開く」での実際の遷移（マップとして開くルーティング）、別 leaf の未保存の編集での更新、実テーマ、ホストを閉じたあとの残留（DevTools）は、このページのケース（embed-node-*）では確認できない。',
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
      await captureTopicOperations(recorder, page);
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
