/**
 * E45 (docs/harness.md, E10 タイムライン): a large timeline that mixes long titles, images and deep branches, on the
 * real Obsidian (LEV-20). The note is `makeMixedFixture` (scripts/performance-fixtures.mjs) at 500 and 2,000 nodes:
 * one stage per ~40 nodes cycling through a 16-level chain, long Japanese titles with images, flat siblings and a
 * mixed branch, with bare stages and an image on the third stage.
 *
 * For each count, on the settled map (images loaded, geometry unchanged for 400 ms):
 * - Nothing overlaps: no two nodes, and no fold control over another node or control (layout px, 0.5 px slack).
 *   Every stage's forest box (its descendants and their controls) is apart from every other stage's, and each forest
 *   stays on its side of the axis band.
 * - Same-side stages keep `TIMELINE_STAGE_CLEARANCE` (72 px, LEV-205): the next stem stands at least that far right of
 *   the previous forest on its side (exactly that far where the side, not the axis, decides where it goes).
 * - Nothing is lost: the DOM shows every node the note has, under its own title.
 * - ⌥↓ on a stage moves it after the next one in the note and on the axis (both orders agree), ⌥↑ restores the note
 *   byte for byte.
 * - Folding a 16-level chain at depth 8, then depth 4, then its stage (real clicks on the fold controls, after a
 *   hover shows the − mark) shows the full hidden count on each badge without overlap, and unfolding them in reverse
 *   brings every node back; the note is never written.
 * - Measured, not judged: open (setViewState → every node drawn → settled), wheel pan and ⌘-wheel zoom frame intervals
 *   at fit, and the frame after the last DOM change for each fold and move.
 *
 * Usage: npm run harness:e2e:timeline-large -- [--counts 500,2000] [--reload] [--json <out.json>] [--shot <out.png>] [--keep]
 *   --shot  a path ending in .png: the case writes <path>-<count>-<scene>.png beside it (fit, stage, folded)
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, PARSE, makePluginStep, makeSelect, makeMoveAlt, refuseOpenLeaves } from './dom-helpers.mjs';
import { makeMixedFixture } from '../performance-fixtures.mjs';

const { flag, value } = parseArgs();

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The installed plugin must be this checkout's build (`npm run harness:prepare`); the case cannot tell a stale one apart.
const CLEARANCE = Number((await readFile(resolve(root, 'src', 'layout', 'layout.ts'), 'utf8'))
  .match(/export const TIMELINE_STAGE_CLEARANCE\s*=\s*([\d_.]+)/u)?.[1]?.replaceAll('_', ''));
if (!Number.isFinite(CLEARANCE) || CLEARANCE <= 0) throw new Error('TIMELINE_STAGE_CLEARANCE is not in src/layout/layout.ts');
const COUNTS = (value('--counts') ?? '500,2000').split(',').map(Number);
if (COUNTS.some(count => !Number.isInteger(count) || count < 100)) throw new Error(`--counts needs node counts of 100 or more, not ${value('--counts')}`);
/** Node rects are integer layout sizes scaled by the zoom: what two boxes may share before they overlap. */
const SLACK = 0.5;
/** How far from the clearance a bound gap may read (E42 allows the same pixel of rounding). */
const ROUNDING = 1.5;
const shotBase = value('--shot')?.replace(/\.png$/u, '');

const record = createRecord(VAULT, COUNTS.map(count => `Fixtures/E2E-timeline-large-${count}.md`).join(', '));
record.clearance = CLEARANCE;
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const moveAlt = makeMoveAlt(cdp, evaluate);

/**
 * Script string, after VIEW and PARSE: the geometry of the map on screen in layout px (screen px over the zoom).
 * Overlaps are found by a sweep over left edges; each stage's forest is its descendants and their fold controls.
 */
const GEOMETRY = `
  const shown = nodes().filter(node => node.offsetWidth > 0);
  const scale = shown[0].getBoundingClientRect().width / shown[0].offsetWidth;
  const box = rect => ({ l: rect.left / scale, t: rect.top / scale, r: rect.right / scale, b: rect.bottom / scale });
  const items = [];
  const entries = new Map();
  for (const node of shown) {
    const id = node.dataset.nodeId;
    const entry = { id, title: label(node), rect: box(node.getBoundingClientRect()), stage: node.classList.contains('is-stage') };
    entries.set(id, entry);
    items.push({ kind: 'node', owner: id, rect: entry.rect });
    const toggle = node.querySelector(':scope > .mappy-node-toggle');
    if (toggle && !toggle.hidden && toggle.offsetWidth > 0) {
      entry.toggle = box(toggle.getBoundingClientRect());
      items.push({ kind: 'control', owner: id, rect: entry.toggle });
    }
  }
  const slack = ${SLACK};
  const hit = (a, b) => a.l < b.r - slack && b.l < a.r - slack && a.t < b.b - slack && b.t < a.b - slack;
  items.sort((a, b) => a.rect.l - b.rect.l);
  const overlaps = [];
  for (let i = 0; i < items.length; i += 1) {
    const a = items[i];
    for (let j = i + 1; j < items.length && items[j].rect.l < a.rect.r - slack; j += 1) {
      const b = items[j];
      if (a.owner !== b.owner && hit(a.rect, b.rect)) overlaps.push(a.kind + ' ' + entries.get(a.owner).title + ' × ' + b.kind + ' ' + entries.get(b.owner).title);
    }
  }
  const order = new Map(doc.nodes.map((node, index) => [node.id, index]));
  const stages = [...entries.values()].filter(entry => entry.stage).sort((a, b) => order.get(a.id) - order.get(b.id));
  const stageIds = new Set(stages.map(stage => stage.id));
  const stageOf = id => {
    for (let at = byId.get(byId.get(id)?.parentId ?? ''); at; at = byId.get(at.parentId ?? '')) if (stageIds.has(at.id)) return at.id;
    return null;
  };
  const forests = new Map();
  for (const entry of entries.values()) {
    const stage = stageOf(entry.id);
    if (!stage) continue;
    const forest = forests.get(stage) ?? { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity, nodes: [] };
    for (const rect of [entry.rect, entry.toggle].filter(Boolean)) {
      forest.l = Math.min(forest.l, rect.l); forest.t = Math.min(forest.t, rect.t);
      forest.r = Math.max(forest.r, rect.r); forest.b = Math.max(forest.b, rect.b);
    }
    forest.nodes.push(entry.rect);
    forests.set(stage, forest);
  }
  const bandTop = Math.min(...stages.map(stage => stage.rect.t));
  const bandBottom = Math.max(...stages.map(stage => stage.rect.b));
  const sides = [];
  const last = {};
  const gaps = [];
  for (const stage of stages) {
    const forest = forests.get(stage.id);
    if (!forest) continue;
    const upper = forest.b <= stage.rect.t;
    const side = upper ? 'upper' : 'lower';
    const across = forest.nodes.filter(rect => upper ? rect.b > bandTop + slack : rect.t < bandBottom - slack).length;
    if (across) sides.push(stage.title + ' (' + side + '): ' + across + ' nodes cross the axis band');
    const stem = (stage.rect.l + stage.rect.r) / 2;
    if (last[side]) gaps.push({ from: last[side].title, to: stage.title, side, gap: stem - last[side].forest.r });
    last[side] = { title: stage.title, forest };
  }
  const forestList = [...forests.entries()];
  const forestOverlaps = [];
  for (let i = 0; i < forestList.length; i += 1) {
    for (let j = i + 1; j < forestList.length; j += 1) {
      if (hit(forestList[i][1], forestList[j][1])) forestOverlaps.push(entries.get(forestList[i][0]).title + ' × ' + entries.get(forestList[j][0]).title);
    }
  }
  const geometry = {
    scale, shown: shown.length, controls: items.length - shown.length, stages: stages.length, forests: forests.size,
    overlaps: overlaps.length, overlapExamples: overlaps.slice(0, 10),
    forestOverlaps: forestOverlaps.length, forestOverlapExamples: forestOverlaps.slice(0, 10),
    acrossBand: sides.slice(0, 10),
    gaps: gaps.length, minGap: gaps.length ? Math.min(...gaps.map(item => item.gap)) : null,
    boundGaps: gaps.filter(item => Math.abs(item.gap - ${CLEARANCE}) <= ${ROUNDING}).length,
    shortGaps: gaps.filter(item => item.gap < ${CLEARANCE} - ${ROUNDING}).map(item => item.from + ' → ' + item.to + ' ' + item.gap.toFixed(1)),
    stageOrder: stages.map(stage => stage.title),
    axisOrder: [...stages].sort((a, b) => (a.rect.l + a.rect.r) - (b.rect.l + b.rect.r)).map(stage => stage.title),
  };`;

/**
 * Script string, after VIEW and PARSE: whether the DOM shows exactly the nodes the note has outside closed branches,
 * each under its own title. Nothing drawn twice, nothing missing, nothing renamed.
 */
const CONTENT = `
  const closed = new Set(Array.from(el.querySelectorAll('.mappy-node.is-collapsed'), node => node.dataset.nodeId));
  const hidden = node => { for (let at = byId.get(node.parentId ?? ''); at; at = byId.get(at.parentId ?? '')) if (closed.has(at.id)) return true; return false; };
  const expected = doc.nodes.filter(node => !hidden(node));
  const drawn = new Map();
  let duplicates = 0;
  for (const node of nodes()) { if (drawn.has(node.dataset.nodeId)) duplicates += 1; drawn.set(node.dataset.nodeId, label(node)); }
  const missing = expected.filter(node => !drawn.has(node.id)).map(node => node.title);
  const renamed = expected.filter(node => drawn.has(node.id) && drawn.get(node.id) !== node.title.trim()).map(node => node.title + ' → ' + drawn.get(node.id));
  const content = { parsed: doc.nodes.length, expected: expected.length, drawn: drawn.size, duplicates, closed: closed.size, missing: missing.slice(0, 10), missingCount: missing.length, renamed: renamed.slice(0, 10), renamedCount: renamed.length };`;

/** Every image has finished (loaded or failed), and a cheap fingerprint of every node's place, to tell a settled map. */
const SNAPSHOT = `${VIEW}
  let sum = 0;
  const all = nodes();
  for (const node of all) { const rect = node.getBoundingClientRect(); sum += rect.left * 3 + rect.top * 7 + rect.width + rect.height; }
  const images = Array.from(el.querySelectorAll('.mappy-node img'));
  return { at: performance.now(), count: all.length, sum, images: images.length, pending: images.filter(image => !image.complete).length };`;

/** Polls until images are done and two readings 400 ms apart agree; returns the page time it settled at. */
async function settle(limit = 30000) {
  const started = Date.now();
  let before = await evaluate(SNAPSHOT);
  for (;;) {
    await wait(400);
    const now = await evaluate(SNAPSHOT);
    if (now.pending === 0 && now.count === before.count && Math.abs(now.sum - before.sum) < 0.5) return { ...before, settledAt: before.at };
    if (Date.now() - started > limit) throw new Error(`the map did not settle within ${limit / 1000} s (${now.pending} images pending)`);
    before = now;
  }
}

const readGeometry = () => evaluate(`${VIEW} ${PARSE} ${GEOMETRY} ${CONTENT} return { ...geometry, content };`);

/** Records the checks every settled state has to pass, under `what`. */
function judge(what, state, { closed = 0 } = {}) {
  const { content } = state;
  check(state.overlaps === 0, `${what}: ${state.overlaps} overlaps (${state.overlapExamples.join('; ')})`);
  check(state.forestOverlaps === 0, `${what}: ${state.forestOverlaps} stage forests overlap (${state.forestOverlapExamples.join('; ')})`);
  check(state.acrossBand.length === 0, `${what}: forests cross the axis band (${state.acrossBand.join('; ')})`);
  check(state.shortGaps.length === 0, `${what}: same-side stems closer than ${CLEARANCE} px (${state.shortGaps.join('; ')})`);
  check(content.missingCount === 0 && content.renamedCount === 0 && content.duplicates === 0 && content.drawn === content.expected,
    `${what}: drawn ${content.drawn} of ${content.expected} (missing ${content.missingCount}, renamed ${content.renamedCount}, duplicated ${content.duplicates})`);
  check(content.closed === closed, `${what}: ${content.closed} closed branches, expected ${closed}`);
  check(JSON.stringify(state.stageOrder) === JSON.stringify(state.axisOrder), `${what}: the axis does not follow the note's stage order`);
}

/** Nearest-rank percentiles of frame intervals. */
function frameStats(frames) {
  // A frame the renderer catches up on hands the same timestamp to the callback queued in it: not a frame of its own.
  const intervals = frames.slice(1).map((time, index) => time - (frames[index] ?? time)).filter(interval => interval > 0).sort((a, b) => a - b);
  const rank = p => intervals[Math.min(intervals.length - 1, Math.max(0, Math.ceil(p * intervals.length) - 1))];
  const round = number => (number === undefined ? null : Math.round(number * 10) / 10);
  return { frames: intervals.length, p50: round(rank(0.5)), p95: round(rank(0.95)), max: round(intervals.at(-1)), over17: intervals.filter(v => v > 17.2).length, over33: intervals.filter(v => v > 33.4).length };
}

/** Frame timestamps while `drive` runs. */
async function recordFrames(drive) {
  await evaluate(`window.__mappyE2EFrames = []; window.__mappyE2EFramesOn = true;
    const loop = time => { if (!window.__mappyE2EFramesOn) return; window.__mappyE2EFrames.push(time); requestAnimationFrame(loop); };
    requestAnimationFrame(loop); return true;`);
  await drive();
  await wait(200);
  return frameStats(await evaluate(`window.__mappyE2EFramesOn = false; const frames = window.__mappyE2EFrames; delete window.__mappyE2EFrames; return frames;`));
}

/**
 * Times an action from just before it is sent to the first frame after the last change it made to the map's DOM:
 * nodes added or removed, or a node's place (style) or state (class) rewritten.
 */
async function timed(action) {
  // `action` calls `start` right before it sends the input, so the pan and hover that bring the target on screen are not timed.
  const start = () => evaluate(`${VIEW}
    const state = window.__mappyE2EReflect = { mark: performance.now(), last: null, frames: [], on: true };
    state.observer = new MutationObserver(() => { state.last = performance.now(); });
    state.observer.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class'] });
    const loop = time => { if (!state.on) return; state.frames.push(time); requestAnimationFrame(loop); };
    requestAnimationFrame(loop); return true;`);
  const result = await action(start);
  const settled = await settle();
  const reflect = await evaluate(`const state = window.__mappyE2EReflect; state.on = false; state.observer.disconnect(); delete window.__mappyE2EReflect;
    const frame = state.last === null ? null : state.frames.find(time => time >= state.last);
    return { lastChangeMs: state.last === null ? null : Math.round(state.last - state.mark), frameAfterMs: frame === undefined || frame === null ? null : Math.round(frame - state.mark) };`);
  return { result, reflect, settled };
}

/** The canvas's centre and the given node's centre, in window px. */
const where = title => evaluate(`${VIEW}
  const node = nth(${JSON.stringify(title)}, 0);
  if (!node) throw new Error('No node ' + ${JSON.stringify(title)});
  const canvas = el.querySelector('.mappy-canvas').getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  const toggle = node.querySelector(':scope > .mappy-node-toggle');
  const control = toggle && !toggle.hidden ? toggle.getBoundingClientRect() : null;
  return { canvas: { x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 2 }, node: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    control: control && { x: control.left + control.width / 2, y: control.top + control.height / 2 } };`);

const click = async point => {
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
};
const wheel = (point, deltaX, deltaY, modifiers = 0) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX, deltaY, modifiers });

/** Zoom to 100% with the map's own button, once per count (the fit that opened the map leaves it far smaller). */
async function actualSize() {
  const button = await evaluate(`${VIEW}
    const buttons = Array.from(el.querySelectorAll('.mappy-zoom button'));
    const target = buttons[1];
    if (!target) throw new Error('No zoom label button');
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`);
  await click(button);
  await wait(400);
}

/** Pans with the wheel (the map's own pan) until the node sits at the canvas's centre. */
async function bring(title) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const at = await where(title);
    const dx = at.node.x - at.canvas.x;
    const dy = at.node.y - at.canvas.y;
    if (Math.abs(dx) < 40 && Math.abs(dy) < 40) return at;
    await wheel(at.canvas, dx, dy);
    await wait(300);
  }
  return where(title);
}

/** Hovers the node's fold control, reads what the hover shows, then clicks it: the pointer path E13 describes. */
async function clickFold(title, start) {
  const at = await bring(title);
  if (!at.control) throw new Error(`${title} has no fold control`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.control.x, y: at.control.y });
  await wait(250);
  const hover = await evaluate(`${VIEW}
    const node = nth(${JSON.stringify(title)}, 0);
    const toggle = node.querySelector(':scope > .mappy-node-toggle');
    const mark = toggle.querySelector('.mappy-node-toggle-mark');
    const top = document.elementFromPoint(${at.control.x}, ${at.control.y});
    return { reached: toggle.contains(top), opacity: getComputedStyle(mark).opacity, minus: !!mark.querySelector('svg'), text: mark.textContent.trim() };`);
  if (!hover.reached) throw new Error(`${title}'s fold control is covered at its centre`);
  await start();
  await click(at.control);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.canvas.x, y: at.canvas.y - 200 });
  return hover;
}

/** The badge a closed node shows, and how many descendants the note gives it. */
const badge = title => evaluate(`${VIEW} ${PARSE}
  const node = nth(${JSON.stringify(title)}, 0);
  const mark = node.querySelector(':scope > .mappy-node-toggle .mappy-node-toggle-mark');
  const id = node.dataset.nodeId;
  const count = at => at.children.reduce((sum, child) => sum + 1 + count(child), 0);
  return { closed: node.classList.contains('is-collapsed'), text: mark.textContent.trim(), opacity: getComputedStyle(mark).opacity, descendants: count(byId.get(id)) };`);

const stageTitles = source => source.split('\n').filter(line => /^- /u.test(line)).map(line => line.slice(2));

async function runCount(count) {
  const note = `Fixtures/E2E-timeline-large-${count}.md`;
  const [, SOURCE] = makeMixedFixture(count);
  const name = what => `${count} ${what}`;
  const stages = stageTitles(SOURCE);
  const source = () => evaluate(`${VIEW} return await source();`);

  const clean = () => step(name('clean'), () => evaluate(`
    const path = ${JSON.stringify(note)};
    app.workspace.iterateAllLeaves(item => {
      const state = item.getViewState();
      if (item.view?.file?.path === path || state.state?.file === path) item.detach();
    });
    const file = app.vault.getAbstractFileByPath(path);
    const remove = ${JSON.stringify(!flag('--keep'))};
    if (file && remove) await app.vault.delete(file, true);
    delete window.__mappyE2E;
    return { removed: file && remove ? path : null };`));

  try {
    required(record, name('open'), await step(name('open'), async () => {
      const opened = await evaluate(`
        ${refuseOpenLeaves([note])}
        const existing = app.vault.getAbstractFileByPath(${JSON.stringify(note)});
        if (existing) await app.vault.modify(existing, ${JSON.stringify(SOURCE)});
        else await app.vault.create(${JSON.stringify(note)}, ${JSON.stringify(SOURCE)});
        await new Promise(resolve => setTimeout(resolve, 600));
        const started = performance.now();
        const leaf = app.workspace.getLeaf('tab');
        await leaf.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(note)}, layout: 'timeline' }, active: true });
        const stated = performance.now();
        app.workspace.setActiveLeaf(leaf, { focus: true });
        window.__mappyE2E = leaf;
        let drawn = null;
        while (performance.now() - started < 45000) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          if (leaf.view.contentEl.querySelectorAll('.mappy-node').length >= ${count} && leaf.view.layout) { drawn = performance.now(); break; }
        }
        return { started, setViewStateMs: Math.round(stated - started), drawnMs: drawn === null ? null : Math.round(drawn - started) };`);
      if (opened.drawnMs === null) throw new Error(`the map did not draw ${count} nodes within 45 s`);
      const settled = await settle(60000);
      return { ...opened, settledMs: Math.round(settled.settledAt - opened.started), images: settled.images, started: undefined };
    }));

    await step(name('settled'), async () => {
      const state = await readGeometry();
      check(state.content.parsed === count, `the map parsed ${state.content.parsed} nodes, not ${count}`);
      check(state.stages === stages.length, `the map shows ${state.stages} stages, not ${stages.length}`);
      check(state.boundGaps > 0, 'no same-side stem sits at the clearance: the case did not reach the rule it measures');
      judge(name('settled'), state);
      if (shotBase) state.shot = await cdp.screenshot(`${shotBase}-${count}-fit.png`);
      return state;
    });

    await step(name('frames'), async () => {
      const at = await where(stages[0]);
      // The same window with no input: what the frame clock gives when nothing is asked of it.
      const idle = await recordFrames(() => wait(1000));
      const pan = await recordFrames(async () => {
        for (let index = 0; index < 60; index += 1) { await wheel(at.canvas, index % 2 ? -24 : 24, 0); await wait(16); }
      });
      const zoom = await recordFrames(async () => {
        for (let index = 0; index < 60; index += 1) { await wheel(at.canvas, 0, index < 30 ? -8 : 8, 4); await wait(16); }
      });
      await settle();
      return { idle, pan, zoom };
    });

    await actualSize();

    await step(name('reorder'), async () => {
      const original = await source();
      check(original === SOURCE, 'the note changed before the reorder');
      const moved = stages[3];
      await bring(moved);
      await select(moved);
      const down = await timed(async start => { await start(); return moveAlt('ArrowDown'); });
      const after = stageTitles(down.result.source);
      const expected = [...stages];
      [expected[3], expected[4]] = [expected[4], expected[3]];
      check(JSON.stringify(after) === JSON.stringify(expected), `⌥↓ left the note's stages as ${after.slice(2, 6).join(' / ')}`);
      const state = await readGeometry();
      check(JSON.stringify(state.axisOrder) === JSON.stringify(after), `after ⌥↓ the axis reads ${state.axisOrder.slice(2, 6).join(' / ')}, the note ${after.slice(2, 6).join(' / ')}`);
      judge(name('after ⌥↓'), state);
      const up = await timed(async start => { await start(); return moveAlt('ArrowUp'); });
      check(up.result.source === original, '⌥↑ did not restore the note byte for byte');
      const back = await readGeometry();
      judge(name('after ⌥↑'), back);
      return { moved, downReflect: down.reflect, upReflect: up.reflect, noteAfterDown: after.slice(2, 6), axisAfterDown: state.axisOrder.slice(2, 6), restored: up.result.source === original };
    });

    await step(name('fold'), async () => {
      const original = await source();
      const [stage] = stages;
      const inner = SOURCE.match(/^ {16}- (\d+ 段 8)$/mu)?.[1];
      const middle = SOURCE.match(/^ {8}- (\d+ 段 4)$/mu)?.[1];
      if (!inner || !middle) throw new Error('The first stage has no 16-level chain');
      const targets = [inner, middle, stage];
      const closing = [];
      for (const [index, title] of targets.entries()) {
        const run = await timed(start => clickFold(title, start));
        const shown = await badge(title);
        check(run.result.opacity === '1' && run.result.minus, `hovering ${title}'s control showed ${run.result.minus ? 'the −' : 'no −'} at opacity ${run.result.opacity}`);
        check(shown.closed && shown.text === String(shown.descendants), `closed ${title} shows "${shown.text}", not its ${shown.descendants} descendants`);
        const state = await readGeometry();
        // A closed node hides the closed ones under it: one closed branch is on screen at each step.
        judge(name(`closed ${title}`), state, { closed: 1 });
        check(await source() === original, `closing ${title} wrote the note`);
        if (index === targets.length - 1 && shotBase) state.shot = await cdp.screenshot(`${shotBase}-${count}-folded.png`);
        closing.push({ title, reflect: run.reflect, badge: shown.text, descendants: shown.descendants, shown: state.content.drawn, overlaps: state.overlaps, minGap: state.minGap });
      }
      const opening = [];
      for (const [index, title] of [...targets].reverse().entries()) {
        const run = await timed(start => clickFold(title, start));
        const state = await readGeometry();
        judge(name(`opened ${title}`), state, { closed: index < targets.length - 1 ? 1 : 0 });
        opening.push({ title, reflect: run.reflect, shown: state.content.drawn, overlaps: state.overlaps, minGap: state.minGap });
      }
      const final = await readGeometry();
      check(final.content.drawn === count, `after reopening, ${final.content.drawn} of ${count} nodes are drawn`);
      const after = await source();
      check(after === original, 'folding and unfolding changed the note');
      if (shotBase) {
        await bring(stage);
        final.shot = await cdp.screenshot(`${shotBase}-${count}-stage.png`);
      }
      return { closing, opening, drawnAfter: final.content.drawn, same: after === original };
    });

    await step(name('unchanged'), async () => {
      const text = await source();
      check(text === SOURCE, `the ${count}-node note is not what the case wrote`);
      return { same: text === SOURCE, bytes: Buffer.byteLength(text) };
    });
  } finally {
    await clean();
  }
}

try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  for (const count of COUNTS) {
    try { await runCount(count); } catch (error) { if (!(error instanceof StopCase)) record.failures.push(`${count}: ${error}`); }
  }
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(String(error));
} finally {
  cdp.close();
}

process.exit(await finish(record, value('--json')));
