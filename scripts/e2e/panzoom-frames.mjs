/**
 * E75 (docs/harness.md, LEV-213): wheel pan and ⌘-wheel zoom stay at the display's frame rate on a 2,000-node map, on
 * the real Obsidian. The note is E45's `makeMixedFixture(2000)` (long Japanese titles, 232 images, deep chains). Before
 * LEV-213 every wheel event there cost one frame of p95 0.45–0.97 s (E45 and this case, 2026-09-29), with no long task:
 * the time was the renderer's, in the main thread's layerization (`PaintArtifactCompositor::Update`) that
 * `will-change: transform` on `.mappy-world` made it run over every node on each change of the world's transform
 * (artifacts/lev-213). Nothing on the map's side changes per wheel but the world's `style`.
 *
 * For each layout (timeline, normal map) × zoom (fit, 100% on the root) × input (wheel pan, ⌘-wheel zoom), 40 wheel
 * events 16 ms apart; the frame intervals (requestAnimationFrame) and the long animation frames (LoAF, which include
 * style, layout, paint and layerization, unlike long tasks) over them are recorded. Judged:
 * - p95 of the frame intervals at most `--budget` ms (default 50: three frames at 60 Hz; before LEV-213 it was 450–967);
 * - the wheel really reached the world: at least 90% of the wheel events changed its transform (a write of the same
 *   value is not counted), so a window where the input is swallowed or clamped to no-ops cannot pass on quiet frames.
 *   Behind slow frames Chromium coalesces queued wheel events too, so a slow build can fail this as well as the p95;
 * - the same window with no input runs at the display's rate (p95 under 25 ms) before and after each cell, or the case
 *   stops there without judging the rest (`stopped` in the record, exit code 1): a throttled or hidden window has no
 *   frame clock to judge by, and a slow frame there says nothing about the map.
 * A Performance trace is not the measure here: recording one (even `devtools.timeline` alone) makes layerization
 * several times slower, so it inflates the frames it would time (artifacts/lev-213/record.md).
 *
 * Usage: npm run harness:e2e:panzoom-frames -- [--count 2000] [--budget 50] [--emulate <w>x<h>x<dpr>] [--reload] [--json <out.json>] [--keep]
 *   --emulate  draws the window at that size and device pixel ratio (CDP Emulation.setDeviceMetricsOverride, cleared at
 *              the end), e.g. 1728x1080x2 for a full-screen Retina window: without the world's layer every pan repaints
 *              and rasters what is on screen, which grows with the pixels. An emulated size is not a real display.
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makePluginStep, refuseOpenLeaves, writeNote } from './dom-helpers.mjs';
import { makeFrameRecorder, summarizeFrames } from './frame-recorder.mjs';
import { makeMixedFixture } from '../performance-fixtures.mjs';

const { flag, value } = parseArgs();
const COUNT = Number(value('--count') ?? 2000);
if (!Number.isInteger(COUNT) || COUNT < 100) throw new Error(`--count needs a node count of 100 or more, not ${value('--count')}`);
const BUDGET = Number(value('--budget') ?? 50);
if (!Number.isFinite(BUDGET) || BUDGET <= 0) throw new Error(`--budget needs a positive number of ms, not ${value('--budget')}`);
const EMULATE = value('--emulate')?.match(/^(\d+)x(\d+)x(\d+(?:\.\d+)?)$/u);
if (value('--emulate') && !EMULATE) throw new Error(`--emulate needs <width>x<height>x<dpr>, not ${value('--emulate')}`);
const NOTE = `Fixtures/E2E-panzoom-${COUNT}.md`;
const [, SOURCE] = makeMixedFixture(COUNT);
const LAYOUTS = ['timeline', 'mindmap'];
const WHEELS = 40;
/** Every image the fixture embeds that exists (both forms of sample-image.svg); the missing one is no <img> at all. */
const IMAGES = (SOURCE.match(/!\[\[sample-image\.svg|\]\(sample-image\.svg\)/gu) ?? []).length;

const record = createRecord(VAULT, NOTE);
record.budget = BUDGET;
// Frame times are judged: another instance's load would show in them (LEV-327), so run alone.
const cdp = await connect({ solo: 'judges frame times' });
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
// 100 ms after the last wheel is enough for the frame it asked for; more idle frames would thin a slow one out of the p95.
const frameRecorder = makeFrameRecorder(evaluate, { watch: "window.__mappyE2E.view.contentEl.querySelector('.mappy-world')", tail: 100 });

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
      // Every embed's <img>, not just the ones there so far: the nodes are drawn before MarkdownRenderer puts the images in.
      if (el.querySelectorAll('.mappy-node').length >= ${COUNT} && leaf.view.layout && images.length >= ${IMAGES} && images.every(image => image.complete)) {
        return { nodes: el.querySelectorAll('.mappy-node').length, images: images.length, broken: images.filter(image => image.naturalWidth === 0).length, ms: Math.round(performance.now() - started) };
      }
    }
    return null;`);
  if (!opened) throw new Error(`the ${layout} map did not draw ${COUNT} nodes with its ${IMAGES} images within 60 s: is Fixtures/sample-image.svg in the vault?`);
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
    // A 100% view of empty canvas is cheap to draw: the rows are meant to time the dense part around the root.
    const at = await where();
    if (Math.abs(at.root.x - at.canvas.x) >= 40 || Math.abs(at.root.y - at.canvas.y) >= 40) throw new Error('the root did not come to the canvas\'s centre at 100%');
  }
  const label = await evaluate(`${VIEW} return el.querySelectorAll('.mappy-zoom button')[1]?.textContent.trim() ?? null;`);
  if (which === 'actual' && label !== '100%') throw new Error(`the zoom label reads ${label}, not 100%`);
  await wait(600);
  return label;
}

/**
 * Frame intervals, long animation frames and the world's transform writes while `drive` runs (frame-recorder.mjs,
 * shared with E45). `writes` counts only the writes that changed the transform.
 */
async function recordFrames(drive) {
  const raw = await frameRecorder(drive);
  return {
    ...summarizeFrames(raw.frames, [100]),
    loaf: raw.loaf.length, loafMax: round(Math.max(0, ...raw.loaf.map(entry => entry.duration))), loafRenderMax: round(Math.max(0, ...raw.loaf.map(entry => entry.render))),
    longTasks: raw.longTasks, transforms: raw.transforms, writes: raw.writes,
  };
}

/**
 * The frame clock with no input. A throttled or hidden window (behind another, a locked screen) runs it slow or not at
 * all: the case then stops without judging (`stopped`), since what it would record is the window's, not the map's.
 */
async function quiet(when) {
  const idle = await recordFrames(() => wait(1000));
  if (idle.p95 === null || idle.p95 >= 25) {
    record.stopped = `${when}: with no input the frames run at p95 ${idle.p95} ms. The window is throttled or hidden; the rest was not judged`;
    throw new StopCase(record.stopped);
  }
  return idle;
}

const drives = {
  pan: at => async () => { for (let index = 0; index < WHEELS; index += 1) { await wheel(at, index % 2 ? -24 : 24, 0); await wait(16); } },
  zoom: at => async () => { for (let index = 0; index < WHEELS; index += 1) { await wheel(at, 0, index < WHEELS / 2 ? -8 : 8, 4); await wait(16); } },
};

try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  if (EMULATE) {
    const [, width, height, dpr] = EMULATE.map(Number);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
    record.emulated = { width, height, dpr };
    await wait(800);
  }
  required(record, 'note', await step('note', () => evaluate(`${refuseOpenLeaves([NOTE])}
    window.__mappyE2EBefore = new Set(app.vault.getFiles().map(file => file.path));
    ${writeNote(NOTE, SOURCE)}
    return { obsidian: require('electron').ipcRenderer.sendSync('version'), dpr: devicePixelRatio, window: [innerWidth, innerHeight] };`)));
  for (const layout of LAYOUTS) {
    const opened = required(record, `${layout} open`, await step(`${layout} open`, () => open(layout)));
    // Without Fixtures/sample-image.svg the embeds draw no <img> at all, and the case would time a light map without them.
    check(opened.broken === 0 && opened.images === IMAGES, `${layout}: ${opened.images - opened.broken} of ${IMAGES} images loaded (${opened.broken} broken): is Fixtures/sample-image.svg in the vault?`);
    for (const zoom of ['fit', 'actual']) {
      const name = `${layout} ${zoom}`;
      await step(name, async () => {
        const label = await zoomTo(zoom);
        const at = (await where()).canvas;
        const idle = await quiet(`${name}, before the wheel`);
        const result = { label, idle };
        const verdicts = [];
        for (const [input, drive] of Object.entries(drives)) {
          const frames = await recordFrames(drive(at));
          result[input] = frames;
          verdicts.push([frames.writes >= WHEELS * 0.9, `${name} ${input}: ${frames.writes} of ${WHEELS} wheel events changed the world's transform (the input was swallowed or clamped, or the renderer coalesced wheel events behind slow frames: see the p95)`]);
          verdicts.push([frames.p95 !== null && frames.p95 <= BUDGET, `${name} ${input}: frame p95 ${frames.p95} ms over ${BUDGET} ms (max ${frames.max}, ${frames.over100} over 100 ms, longest animation frame ${frames.loafMax} ms of which rendering ${frames.loafRenderMax})`]);
          await wait(500);
        }
        // A window hidden mid-cell would pass its slow frames off as the map's: the clock is read again after the input,
        // and the cell is judged only if it still runs.
        result.idleAfter = await quiet(`${name}, after the wheel`);
        for (const [condition, failure] of verdicts) check(condition, failure);
        return result;
      });
      // `step` records what a cell throws; a stopped clock ends the case here instead of timing the next cell on it.
      if (record.stopped) throw new StopCase(record.stopped);
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
  // Guarded: a dropped socket here must not keep `finish` from writing the record.
  if (EMULATE) await cdp.send('Emulation.clearDeviceMetricsOverride').catch(error => record.failures.push(`clearing the emulated metrics: ${error}`));
  cdp.close();
}

process.exit(await finish(record, value('--json')));
