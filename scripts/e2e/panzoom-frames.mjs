/**
 * E75 (docs/harness.md, LEV-213): wheel pan and ⌘-wheel zoom stay at the display's frame rate on a 2,000-node map, on
 * the real Obsidian. The note is E45's `makeMixedFixture(2000)` (long Japanese titles, 232 images, deep chains). Before
 * LEV-213 every wheel event there cost one 0.65–0.95 s frame, with no long task: the time was the renderer's, in the
 * main thread's layerization (`PaintArtifactCompositor::Update`) that `will-change: transform` on `.mappy-world` made it
 * run over every node on each change of the world's transform (artifacts/lev-213). Nothing on the map's side changes
 * per wheel but the world's `style`.
 *
 * For each layout (timeline, normal map) × zoom (fit, 100% on the root) × input (wheel pan, ⌘-wheel zoom), 40 wheel
 * events 16 ms apart; the frame intervals (requestAnimationFrame) and the long animation frames (LoAF, which include
 * style, layout, paint and layerization, unlike long tasks) over them are recorded. Judged:
 * - p95 of the frame intervals at most `--budget` ms (default 50: three frames at 60 Hz; before LEV-213 it was 650–950);
 * - the wheel really moved the world (more than one distinct transform over the run), so a quiet window cannot pass;
 * - the same window with no input runs at the display's rate (p95 under 25 ms), or the run is refused: a throttled or
 *   hidden window has no frame clock to judge by.
 * A Performance trace is not the measure here: recording one (even `devtools.timeline` alone) makes layerization
 * several times slower, so it inflates the frames it would time (artifacts/lev-213/record.md).
 *
 * Usage: npm run harness:e2e:panzoom-frames -- [--count 2000] [--budget 50] [--reload] [--json <out.json>] [--keep]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makePluginStep, refuseOpenLeaves, writeNote } from './dom-helpers.mjs';
import { makeMixedFixture } from '../performance-fixtures.mjs';
import { summarize } from '../perf-stats.mjs';

const { flag, value } = parseArgs();
const COUNT = Number(value('--count') ?? 2000);
if (!Number.isInteger(COUNT) || COUNT < 100) throw new Error(`--count needs a node count of 100 or more, not ${value('--count')}`);
const BUDGET = Number(value('--budget') ?? 50);
if (!Number.isFinite(BUDGET) || BUDGET <= 0) throw new Error(`--budget needs a positive number of ms, not ${value('--budget')}`);
const NOTE = `Fixtures/E2E-panzoom-${COUNT}.md`;
const [, SOURCE] = makeMixedFixture(COUNT);
const LAYOUTS = ['timeline', 'mindmap'];
const WHEELS = 40;

const record = createRecord(VAULT, NOTE);
record.budget = BUDGET;
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);

const wheel = (point, deltaX, deltaY, modifiers = 0) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX, deltaY, modifiers });
const click = async point => {
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
};
const round = number => (Number.isFinite(number) ? Math.round(number * 10) / 10 : null);

/** The canvas's centre and the root's centre, in window px. */
const where = () => evaluate(`${VIEW}
  const canvas = el.querySelector('.mappy-canvas').getBoundingClientRect();
  const root = el.querySelector('.mappy-node.is-root').getBoundingClientRect();
  return { canvas: { x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 2 }, root: { x: root.left + root.width / 2, y: root.top + root.height / 2 } };`);

/** Opens the note as a map in `layout` in a new tab and waits until every node is drawn and every image has finished. */
async function open(layout) {
  const opened = await evaluate(`${refuseOpenLeaves([NOTE])}
    const leaf = app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(NOTE)}, layout: ${JSON.stringify(layout)} }, active: true });
    app.workspace.setActiveLeaf(leaf, { focus: true });
    window.__mappyE2E = leaf;
    const started = performance.now();
    while (performance.now() - started < 60000) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const el = leaf.view.contentEl;
      const images = Array.from(el.querySelectorAll('.mappy-node img'));
      if (el.querySelectorAll('.mappy-node').length >= ${COUNT} && leaf.view.layout && images.every(image => image.complete)) {
        return { nodes: el.querySelectorAll('.mappy-node').length, images: images.length, broken: images.filter(image => image.naturalWidth === 0).length, ms: Math.round(performance.now() - started) };
      }
    }
    return null;`);
  if (!opened) throw new Error(`the ${layout} map did not draw ${COUNT} nodes with every image within 60 s`);
  // The map re-fits once its images have sized the nodes; the frames are measured on the view it settles to.
  await wait(1500);
  return opened;
}

/** The map's own "Fit" button, or its zoom label (100%) followed by wheel pans that bring the root to the centre. */
async function zoomTo(which) {
  const buttons = await evaluate(`${VIEW}
    return Array.from(el.querySelectorAll('.mappy-zoom button'), button => { const rect = button.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; });`);
  if (buttons.length !== 4) throw new Error(`the zoom control has ${buttons.length} buttons, not 4`);
  await click(which === 'fit' ? buttons[3] : buttons[1]);
  await wait(600);
  if (which === 'actual') {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const at = await where();
      const dx = at.root.x - at.canvas.x;
      const dy = at.root.y - at.canvas.y;
      if (Math.abs(dx) < 40 && Math.abs(dy) < 40) break;
      await wheel(at.canvas, dx, dy);
      await wait(600);
    }
  }
  const label = await evaluate(`${VIEW} return el.querySelectorAll('.mappy-zoom button')[1]?.textContent.trim() ?? null;`);
  if (which === 'actual' && label !== '100%') throw new Error(`the zoom label reads ${label}, not 100%`);
  await wait(600);
  return label;
}

/** Frame intervals, long animation frames and the distinct world transforms while `drive` runs. */
async function recordFrames(drive) {
  await evaluate(`${VIEW}
    const world = el.querySelector('.mappy-world');
    const state = window.__mappyE2EFrames = { frames: [], loaf: [], transforms: new Set(), on: true };
    state.long = new PerformanceObserver(list => { for (const entry of list.getEntries()) state.loaf.push({ duration: entry.duration, render: entry.renderStart ? entry.startTime + entry.duration - entry.renderStart : 0 }); });
    state.long.observe({ type: 'long-animation-frame' });
    state.watch = new MutationObserver(() => state.transforms.add(world.style.transform));
    state.watch.observe(world, { attributes: true, attributeFilter: ['style'] });
    const loop = time => { if (!state.on) return; state.frames.push(time); requestAnimationFrame(loop); };
    requestAnimationFrame(loop); return true;`);
  let raw;
  try {
    await drive();
    await wait(300);
  } finally {
    // Stopped whatever happens: a recorder left running would share every later frame the case measures.
    raw = await evaluate(`const state = window.__mappyE2EFrames; if (!state) return null;
      state.on = false; state.long.disconnect(); state.watch.disconnect(); delete window.__mappyE2EFrames;
      return { frames: state.frames, loaf: state.loaf, transforms: state.transforms.size };`);
  }
  // A frame the renderer catches up on hands the same timestamp to the callback queued in it: not a frame of its own.
  const intervals = raw.frames.slice(1).map((time, index) => time - raw.frames[index]).filter(interval => interval > 0);
  const { n, p50, p95, max } = summarize(intervals);
  return {
    frames: n, p50: round(p50), p95: round(p95), max: round(max), over100: intervals.filter(interval => interval > 100).length,
    loaf: raw.loaf.length, loafMax: round(Math.max(0, ...raw.loaf.map(entry => entry.duration))), loafRenderMax: round(Math.max(0, ...raw.loaf.map(entry => entry.render))),
    transforms: raw.transforms,
  };
}

const drives = {
  pan: at => async () => { for (let index = 0; index < WHEELS; index += 1) { await wheel(at, index % 2 ? -24 : 24, 0); await wait(16); } },
  zoom: at => async () => { for (let index = 0; index < WHEELS; index += 1) { await wheel(at, 0, index < WHEELS / 2 ? -8 : 8, 4); await wait(16); } },
};

try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  required(record, 'note', await step('note', () => evaluate(`${refuseOpenLeaves([NOTE])}
    window.__mappyE2EBefore = new Set(app.vault.getFiles().map(file => file.path));
    ${writeNote(NOTE, SOURCE)}
    return { obsidian: require('electron').ipcRenderer.sendSync('version'), dpr: devicePixelRatio, window: [innerWidth, innerHeight] };`)));
  for (const layout of LAYOUTS) {
    const opened = required(record, `${layout} open`, await step(`${layout} open`, () => open(layout)));
    check(opened.broken === 0, `${layout}: ${opened.broken} images are broken (is Fixtures/sample-image.svg in the vault?)`);
    for (const zoom of ['fit', 'actual']) {
      const name = `${layout} ${zoom}`;
      await step(name, async () => {
        const label = await zoomTo(zoom);
        const at = (await where()).canvas;
        const idle = await recordFrames(() => wait(1000));
        if (idle.p95 === null || idle.p95 >= 25) throw new Error(`with no input the frames run at p95 ${idle.p95} ms: the window is throttled or hidden, nothing to judge by`);
        const result = { label, idle };
        for (const [input, drive] of Object.entries(drives)) {
          const frames = await recordFrames(drive(at));
          result[input] = frames;
          check(frames.transforms > 1, `${name} ${input}: the wheel did not move the world (${frames.transforms} distinct transforms)`);
          check(frames.p95 !== null && frames.p95 <= BUDGET, `${name} ${input}: frame p95 ${frames.p95} ms over ${BUDGET} ms (max ${frames.max}, ${frames.over100} over 100 ms, longest animation frame ${frames.loafMax} ms of which rendering ${frames.loafRenderMax})`);
          await wait(500);
        }
        return result;
      });
    }
    await step(`${layout} close`, () => evaluate(`window.__mappyE2E?.detach(); delete window.__mappyE2E; return true;`));
  }
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(String(error));
} finally {
  await step('clean', () => evaluate(`
    app.workspace.iterateAllLeaves(item => { if (item.view?.file?.path === ${JSON.stringify(NOTE)} || item.getViewState().state?.file === ${JSON.stringify(NOTE)}) item.detach(); });
    const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
    // Only a note this run created: one already in the vault (kept by --keep, or edited by hand) was only overwritten.
    const remove = ${JSON.stringify(!flag('--keep'))} && !(window.__mappyE2EBefore?.has(${JSON.stringify(NOTE)}) ?? true);
    if (file && remove) await app.vault.delete(file, true);
    delete window.__mappyE2EBefore;
    return { removed: file && remove ? ${JSON.stringify(NOTE)} : null };`));
  cdp.close();
}

process.exit(await finish(record, value('--json')));
