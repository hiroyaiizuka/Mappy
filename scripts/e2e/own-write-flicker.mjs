/**
 * E54 (docs/harness.md): after a write of the map's own — F2 rename, Tab, ⌥↓／⌥↑, ⌘Z, ⌘⇧Z, a topic dropped on a
 * node's slot, a branch detached onto the canvas — no frame draws the note from before the write, with every read of
 * the note answered late (LEV-219).
 *
 * The save re-reads the note after its write (`writeOwn`, and `history` for ⌘Z／⌘⇧Z), and that read gives up when the
 * note's watcher schedules a newer re-read while it is reading (the epoch). Until the fix, the map then showed the
 * note from before the write until the watcher's re-read drew. As in E53's `slow` (the same probe), every read of the
 * note is answered `SLOW_MS` late, longer than the watcher's 45 ms debounce: on 1.14.2 the watcher of the write lands
 * just before the save's re-read starts, and only a slow read lets the watcher's re-read start while the save's still
 * reads (E53's `alone`／`editor` controls). The watcher, both re-reads and every frame are Obsidian's own; only the
 * answers are late.
 *
 * Rows are the operation × the node it is done to: `normal` (子1), `empty` (the second untitled node), `same` (the
 * second 同名), `topic` (the free topic トピック; rename, Tab, ⌘Z, ⌘⇧Z only). Keys go through Obsidian's keymap
 * (`Input.dispatchKeyEvent`), the drags are the real mouse. ⌘Z／⌘⇧Z take back／redo an F2 rename made first (not
 * slowed). From just before the operation's last input, the probe marks when the store's write for this note resolves
 * (`applyOver`, `undo`, `redo`), and from then samples, once per painted frame, whether the note the map shows is the
 * one from before the write, and whether what is painted (every node's label and transform) is what was painted
 * before it, for 1.5 s. It checks: no sample after the write shows the note from before it or paints what was painted
 * before it, and the last one paints something else (each operation renames, adds or moves a node); the note
 * was written; the save's re-read (the first read begun after the write) was superseded (otherwise the row did not
 * reach the race, and fails rather than pass); no Notice or error line.
 *
 * Usage: npm run harness:e2e:own-write-flicker -- [--reload] [--json <out.json>] [--keep] [--only <row>[,<row>…]]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeFocusCanvas, makeOpenStep, makePluginStep, makeSelect } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-own-write-flicker.md';
const SOURCE = `---
mappy: true
mappy-topics:
  トピック: { mindmap: [60, 420] }
---
## 本体

- 親
  - 子1
  - 子2
-
  - 空の子
-
  - 空の子2
- 同名
  - 同名の子A
- 同名
  - 同名の子B

## トピック

- 枝
`;
const EMPTY_LABEL = '空のノード';
const SAMPLE_MS = 1500;
/** How late every read of the note answers: longer than the watcher's 45 ms debounce (E53's `slow`). */
const SLOW_MS = 80;
const RENAMED = '改名後';

const SHAPES = [
  { name: 'normal', label: '子1', index: 0 },
  { name: 'empty', label: EMPTY_LABEL, index: 1 },
  { name: 'same', label: '同名', index: 1 },
  { name: 'topic', label: 'トピック', index: 0 },
];
const OPS = ['rename', 'tab', 'undo', 'redo', 'move', 'detach', 'slot'];
const TOPIC_OPS = new Set(['rename', 'tab', 'undo', 'redo']);
const ROWS = OPS.flatMap(op => SHAPES.filter(shape => shape.name !== 'topic' || TOPIC_OPS.has(op)).map(shape => ({ id: `${op}-${shape.name}`, op, shape })));
const only = value('--only')?.split(',').map(item => item.trim()).filter(Boolean);
if (only) {
  const unknown = only.filter(id => !ROWS.some(row => row.id === id));
  if (unknown.length) throw new Error(`Unknown rows ${unknown.join(', ')}. Known: ${ROWS.map(row => row.id).join(', ')}`);
}
const rows = only ? ROWS.filter(row => only.includes(row.id)) : ROWS;

const record = createRecord(VAULT, NOTE);
record.partial = only ? only : null;
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const focusCanvas = makeFocusCanvas(cdp, evaluate);

const clean = () => step('clean', () => evaluate(`
  const path = ${JSON.stringify(NOTE)};
  window.__mappyE2EOwn?.release?.();
  app.workspace.iterateAllLeaves(item => {
    const state = item.getViewState();
    if (item.view?.file?.path === path || state.state?.file === path) item.detach();
  });
  const file = app.vault.getAbstractFileByPath(path);
  const remove = ${JSON.stringify(!flag('--keep'))};
  if (file && remove) await app.vault.delete(file, true);
  delete window.__mappyE2E;
  delete window.__mappyE2EBefore;
  delete window.__mappyE2EOwn;
  return { removed: file && remove ? path : null };`));

const read = () => evaluate(`${VIEW}
  return { text: await view.store.read(view.file), shown: view.document?.source ?? null, editing: !!input(), messages: messages(),
    dragging: view.topicDrag != null, preview: view.dropPreview, labels: nodes().map(label) };`);

const mouse = (type, point) => cdp.send('Input.dispatchMouseEvent', {
  type, x: point.x, y: point.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1,
});
const carryTo = async (from, to, steps = 8) => {
  for (let index = 1; index <= steps; index += 1) {
    await mouse('mouseMoved', { x: from.x + (to.x - from.x) * index / steps, y: from.y + (to.y - from.y) * index / steps });
    await wait(25);
  }
};
/** The window rectangle of the `index`-th node labelled `title`, and of the canvas. */
const rects = (title, index) => evaluate(`${VIEW}
  const node = nth(${JSON.stringify(title)}, ${index});
  if (!node) throw new Error('No node ' + ${JSON.stringify(title)} + ' #' + ${index});
  const box = item => { const rect = item.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }; };
  return { node: box(node), canvas: box(el.querySelector('.mappy-canvas')), id: node.dataset.nodeId };`);

let home = null;
/** The note back as the case wrote it, no draft open, and the view back where it was after opening. */
const reset = () => evaluate(`${VIEW}
  if (view.topicDrag) throw new Error('a drag is still under way');
  if (input()) throw new Error('a draft is still open');
  await app.vault.modify(view.file, ${JSON.stringify(SOURCE)});
  await new Promise(resolve => setTimeout(resolve, 900));
  await view.setState({ viewport: ${JSON.stringify(home)} }, { history: false });
  await new Promise(resolve => setTimeout(resolve, 400));
  if (await view.store.read(view.file) !== ${JSON.stringify(SOURCE)}) throw new Error('the note did not go back to the case source');
  if (view.document?.source !== ${JSON.stringify(SOURCE)}) throw new Error('the map did not re-read the case source');
  return true;`);

/**
 * Installs the probe: every read of the note answered `SLOW_MS` late and logged with the epoch; the store's writes
 * for the note marked when they resolve; and, once one has, a sample per painted frame of whether the map shows the
 * note from before it (`before`, the text when the probe is armed).
 */
const arm = () => evaluate(`${VIEW}
  const slow = ${SLOW_MS};
  const probe = window.__mappyE2EOwn = { frames: [], log: [], t0: performance.now(), done: false, landed: null };
  const now = () => Math.round((performance.now() - probe.t0) * 10) / 10;
  const before = view.document?.source;
  // What is painted: every node's label and place (the map positions each node with a transform).
  const paint = () => nodes().map(node => label(node) + '@' + node.style.transform).join('\\n');
  const painted = paint();
  const store = view.store;
  const own = {};
  // The store is the plugin's one for every map, embed and the Excalidraw bridge: only this note's calls are slowed or marked.
  own.read = store.read;
  store.read = async function (...args) {
    if (args[0] !== view.file) return own.read.apply(this, args);
    const entry = { at: now(), what: 'read', afterWrite: probe.landed !== null, saving: view.saving, epoch: view.epoch };
    probe.log.push(entry);
    try {
      const text = await own.read.apply(this, args);
      await new Promise(resolve => setTimeout(resolve, slow));
      return text;
    } finally { entry.end = now(); entry.epochEnd = view.epoch; }
  };
  for (const method of ['applyOver', 'undo', 'redo']) {
    own[method] = store[method];
    store[method] = async function (...args) {
      const result = await own[method].apply(this, args);
      if (args[0] === view.file && probe.landed === null) { probe.landed = now(); probe.log.push({ at: probe.landed, what: method }); }
      return result;
    };
  }
  // All were the prototype's: deleting the own properties puts them back.
  probe.release = () => { for (const key of Object.keys(own)) delete store[key]; probe.done = true; };
  const sample = () => {
    if (probe.done) return;
    requestAnimationFrame(() => setTimeout(() => {
      if (probe.done) return;
      if (probe.landed !== null) {
        const now_ = paint();
        probe.frames.push({ at: now(), stale: view.document?.source === before, old: now_ === painted, nodes: nodes().length });
      }
      sample();
    }, 0));
  };
  sample();
  return { before: before?.length ?? null };`);

const collect = () => evaluate(`const probe = window.__mappyE2EOwn; probe.release(); return { frames: probe.frames, log: probe.log, landed: probe.landed };`);

/** Select, F2, the title typed over the old one; Enter is the caller's. */
const draft = async shape => {
  await select(shape.label, shape.index);
  await cdp.realKey('F2');
  for (let tries = 0; tries < 20 && !(await read()).editing; tries += 1) await wait(100);
  if (!(await read()).editing) throw new Error('F2 did not open the inline editor');
  await cdp.insertText(RENAMED);
  await wait(250);
};

/** A branch or topic carried by the real mouse from its centre to `to(box)`, released there once `ready(state)` holds (or at the last point). */
const drag = async (shape, points, ready) => {
  const { node } = await rects(shape.label, shape.index);
  const press = { x: node.left + Math.min(16, node.width / 2), y: node.top + node.height / 2 };
  await mouse('mouseMoved', press);
  await mouse('mousePressed', press);
  let at = press;
  let reached = null;
  const seen = [];
  for (const point of points) {
    await carryTo(at, point);
    at = point;
    await wait(250);
    const state = await read();
    seen.push({ x: Math.round(point.x), y: Math.round(point.y), preview: state.preview });
    if (ready(state)) { reached = state; break; }
  }
  return { at, reached, seen };
};

/** Runs `op` on `shape` with the probe armed just before its last input; returns what the probe saw. */
const run = async ({ op, shape }) => {
  const failures = [];
  const expect = (condition, message) => { if (!condition) failures.push(message); };
  await reset();
  let release = null;
  if (op === 'rename') {
    await draft(shape);
    release = () => cdp.realKey('Enter');
  } else if (op === 'tab') {
    await select(shape.label, shape.index);
    release = () => cdp.realKey('Tab');
  } else if (op === 'move') {
    await select(shape.label, shape.index);
    // The second 同名 is the body's last item: ⌥↓ would write nothing.
    release = () => cdp.realKey(shape.name === 'same' ? 'ArrowUp' : 'ArrowDown', 1);
  } else if (op === 'undo' || op === 'redo') {
    await draft(shape);
    await cdp.realKey('Enter');
    await wait(1200);
    await focusCanvas();
    if (op === 'redo') { await cdp.realKey('z', 4); await wait(1200); await focusCanvas(); }
    const state = await read();
    expect(!state.editing && state.text === state.shown, `before ${op}: the map is not settled on the note`);
    release = () => cdp.realKey('z', op === 'redo' ? 12 : 4);
  } else if (op === 'detach') {
    const { canvas } = await rects(shape.label, shape.index);
    const target = { x: canvas.right - 90, y: canvas.bottom - 70 };
    const free = await evaluate(`${VIEW} return !document.elementFromPoint(${target.x}, ${target.y})?.closest?.('.mappy-node');`);
    if (!free) return { failures: ['the empty canvas point for the detach is covered by a node'] };
    const { at } = await drag(shape, [target], () => false);
    release = () => mouse('mouseReleased', at);
  } else if (op === 'slot') {
    const topic = SHAPES.find(item => item.name === 'topic');
    const { node, id } = await rects(shape.label, shape.index);
    const y = node.top + node.height / 2;
    // The carried tree hangs from the point pressed on its root (16 px into it): the slot is judged by where the tree is.
    const points = [0, 0.5, 1].flatMap(row => [20, 60, 100, 140, 180].map(dx => ({ x: node.right + dx, y: y + (row - 0.5) * node.height })));
    const { at, reached, seen } = await drag(topic, points, state => state.preview?.parentId === id);
    if (!reached) {
      await mouse('mouseMoved', { x: 5, y: 5 });
      await cdp.realKey('Escape');
      await mouse('mouseReleased', { x: 5, y: 5 });
      await wait(600);
      return { failures: [`no slot under ${shape.label} #${shape.index} was offered on the way: ${JSON.stringify(seen)}`] };
    }
    release = () => mouse('mouseReleased', at);
  }
  const armed = await arm();
  expect(armed.before !== null, 'the map had no note when the probe was armed');
  await wait(50);
  await release();
  await wait(SAMPLE_MS);
  const { frames, log, landed } = await collect();
  const after = await read();
  // Tab leaves the new node's draft open under its provisional name: Escape takes it back (LEV-203), after sampling.
  if (after.editing) { await cdp.realKey('Escape'); await wait(800); }
  expect(landed !== null, 'the store wrote nothing for the note');
  expect(after.text !== SOURCE || op === 'undo', 'the note is the case source after the operation');
  expect(after.text === after.shown, 'the map does not show the note after the operation');
  expect(after.messages.length === 0, `messages after the operation: ${after.messages.join(' / ')}`);
  expect(frames.length > 10, `only ${frames.length} frames were sampled after the write (a throttled window?)`);
  const stale = frames.filter(frame => frame.stale);
  expect(stale.length === 0, `${stale.length} frames after the write showed the note from before it: first at ${stale[0]?.at} ms (write at ${landed} ms)`);
  // What was painted: the last frame differs from before the write (each operation moves or renames something), and no
  // frame after the write painted what was on screen before it.
  const old = frames.filter(frame => frame.old);
  expect(frames.length > 0 && !frames[frames.length - 1].old, 'the last frame paints what was on screen before the write');
  expect(old.length === 0, `${old.length} frames after the write painted what was on screen before it: first at ${old[0]?.at} ms`);
  const own = log.find(entry => entry.what === 'read' && entry.afterWrite) ?? null;
  const superseded = own ? own.epochEnd !== own.epoch : null;
  expect(superseded === true, `the re-read after the write was not superseded (${JSON.stringify(own)}): the race was not reached`);
  return { failures, frames: frames.length, stale: stale.length, old: old.length, firstStale: stale[0] ?? null, landed, superseded, own, log };
};

try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  required(record, 'open', await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE, layout: 'mindmap' })));
  home = required(record, 'home', await step('home', () => evaluate(`${VIEW} return { ...view.viewport.value };`)));
  const results = [];
  for (const row of rows) {
    const result = await step(row.id, async () => {
      try { return await run(row); } finally {
        await mouse('mouseReleased', { x: 1, y: 1 }).catch(() => undefined);
        await evaluate(`window.__mappyE2EOwn?.release?.(); return true;`).catch(() => undefined);
      }
    });
    results.push({ id: row.id, result });
    for (const failure of result?.failures ?? []) check(false, `${row.id}: ${failure}`);
  }
  record.rows = {
    total: results.length,
    failed: results.filter(({ result }) => !result || result.error || result.failures?.length).map(({ id }) => id),
    superseded: results.filter(({ result }) => result?.superseded === true).length,
    staleFrames: Object.fromEntries(results.map(({ id, result }) => [id, result?.stale ?? null])),
  };
  check(results.length > 0, 'no row ran');
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(String(error));
} finally {
  await clean();
  cdp.close();
}

process.exit(await finish(record, value('--json')));
