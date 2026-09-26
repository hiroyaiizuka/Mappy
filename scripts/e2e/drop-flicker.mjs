/**
 * E53 (docs/harness.md): a free tree (a topic, the body) dropped with the real mouse is not drawn back where it was
 * pressed on any frame between the release and the draw of the saved note (LEV-197).
 *
 * The save re-reads the note after its write (`writeOwn`), and that read gave up when the note's watcher scheduled a
 * newer re-read while it was reading (the epoch). The drop's end had already let go of the drag's overrides, so until
 * the watcher's re-read drew, frames laid out the note from before the drop. Whether the watcher lands inside that
 * read on the real device is what this case records per drop (`superseded`), besides what was on screen.
 *
 * Rows are the tree dropped (a topic, the body) × how the note is open:
 * - `alone`: in the map only — the store writes through `Vault.process`, the modify watcher reports it;
 * - `editor`: also in a Markdown editor split beside the map — the store writes through the editor's transaction,
 *   `editor-change` reports it at once and the disk (the modify watcher) follows on Obsidian's save debounce;
 * - `slow`: as `alone`, with every read of the note answered `SLOW_MS` late, as from a slow disk. Neither form above
 *   reaches the order the ticket asks about on its own: on 1.14.2 the watcher of the write lands just before the
 *   save's re-read starts, and an editor's `editor-change` re-read draws the written text while the drag still holds
 *   its overrides. A read longer than the watcher's 45 ms debounce does reach it: the watcher's re-read starts while
 *   the save's is still reading, and ends after it. The watcher, both re-reads and every frame are Obsidian's own;
 *   only the answers are late.
 * Each row repeats `--repeat` times (3 by default): whether the watcher lands inside the read is a race.
 *
 * Every drop presses a root, carries it 60 × 30 px in steps, holds still, and releases. From just before the release,
 * every root's place on screen is sampled once per painted frame (a task queued from each animation frame, so it
 * reads what that frame painted) for 1.5 s. It checks: no sample puts any root more than 1 px (or the zoom) away
 * from where it was shown at the release; the save wrote the note; no Notice or error line.
 *
 * Usage: npm run harness:e2e:drop-flicker -- [--reload] [--json <out.json>] [--keep] [--repeat <n>] [--only <row>[,<row>…]]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makePluginStep, makeOpenStep } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-drop-flicker.md';
const SOURCE = `---
mappy: true
mappy-topics:
  資料: { mindmap: [60, 260] }
  補足: { mindmap: [60, 460] }
---
## 本体

- 回復する
- 休む

## 資料

- 甲
- 乙

## 補足

- 用語
`;
const ROOTS = ['本体', '資料', '補足'];
/** The view each drop starts from: away from the fit, so a fit afterwards would show as a move too. */
const START = { x: 120, y: 120, scale: 0.9 };
const SAMPLE_MS = 1500;
/** How late the `slow` form answers each read: longer than the watcher's 45 ms debounce. */
const SLOW_MS = 80;

const TARGETS = [{ name: 'topic', title: '資料' }, { name: 'body', title: '本体' }];
const FORMS = ['alone', 'editor', 'slow'];
const ROWS = FORMS.flatMap(form => TARGETS.map(target => ({ id: `${target.name}-${form}`, target, form })));
const only = value('--only')?.split(',').map(item => item.trim()).filter(Boolean);
if (only) {
  const unknown = only.filter(id => !ROWS.some(row => row.id === id));
  if (unknown.length) throw new Error(`Unknown rows ${unknown.join(', ')}. Known: ${ROWS.map(row => row.id).join(', ')}`);
}
const rows = only ? ROWS.filter(row => only.includes(row.id)) : ROWS;
const repeat = Number(value('--repeat') ?? 3);
if (!Number.isInteger(repeat) || repeat < 1) throw new Error(`--repeat must be a positive integer, not ${value('--repeat')}`);

const record = createRecord(VAULT, NOTE);
record.partial = only ? only : null;
record.repeat = repeat;
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);

const clean = () => step('clean', () => evaluate(`
  const path = ${JSON.stringify(NOTE)};
  window.__mappyE2EDrop?.release?.();
  app.workspace.iterateAllLeaves(item => {
    const state = item.getViewState();
    if (item.view?.file?.path === path || state.state?.file === path) item.detach();
  });
  const file = app.vault.getAbstractFileByPath(path);
  const remove = ${JSON.stringify(!flag('--keep'))};
  if (file && remove) await app.vault.delete(file, true);
  delete window.__mappyE2E;
  delete window.__mappyE2EBefore;
  delete window.__mappyE2EDrop;
  return { removed: file && remove ? path : null };`));

/** Script string: every root's top-left in window CSS pixels, by title. */
const ROOT_RECTS = `(() => {
  const roots = {};
  for (const title of ${JSON.stringify(ROOTS)}) {
    const node = nth(title, 0);
    if (!node) throw new Error('No node ' + title);
    const rect = node.getBoundingClientRect();
    roots[title] = { x: rect.left, y: rect.top };
  }
  return roots;
})()`;

/** The note as the map's store reads it: through the open editor when there is one (its text reaches disk later). */
const read = () => evaluate(`${VIEW}
  return { roots: ${ROOT_RECTS}, scale: view.viewport.value.scale, dragging: view.topicDrag != null,
    text: await view.store.read(view.file), messages: messages() };`);

const mouse = (type, point, extra = {}) => cdp.send('Input.dispatchMouseEvent', {
  type, x: point.x, y: point.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1, ...extra,
});
const carryTo = async (from, to, steps = 6) => {
  for (let index = 1; index <= steps; index += 1) {
    await mouse('mouseMoved', { x: from.x + (to.x - from.x) * index / steps, y: from.y + (to.y - from.y) * index / steps });
    await wait(20);
  }
};
const fmt = point => `(${point.x.toFixed(1)}, ${point.y.toFixed(1)})`;

/** The Markdown editor beside the map for `editor`, none for `alone`. */
const setForm = form => evaluate(`${VIEW}
  const path = ${JSON.stringify(NOTE)};
  const editors = [];
  app.workspace.iterateAllLeaves(item => { if (item.view?.getViewType?.() === 'markdown' && item.view.file?.path === path) editors.push(item); });
  if (${JSON.stringify(form)} !== 'editor') { for (const item of editors) item.detach(); }
  else if (editors.length === 0) {
    // Through the plugin's router, as its own 右に Markdown を開く does: a plain markdown state of a map note is
    // routed to a map (\`src/obsidian/view-routing.ts\`).
    const side = app.workspace.createLeafBySplit(leaf, 'vertical');
    await view.router.openMarkdown(side, view.file, false);
  }
  await new Promise(resolve => setTimeout(resolve, 800));
  app.workspace.setActiveLeaf(leaf, { focus: true });
  const open = [];
  app.workspace.iterateAllLeaves(item => { if (item.view?.getViewType?.() === 'markdown' && item.view.file?.path === path) open.push(item); });
  return { editors: open.length };`);

/** The note back as the case wrote it (through the editor when one is open), and the view back at START. */
const reset = () => evaluate(`${VIEW}
  if (view.topicDrag) throw new Error('a drag is still under way');
  let editor = null;
  app.workspace.iterateAllLeaves(item => { if (item.view?.getViewType?.() === 'markdown' && item.view.file === view.file) editor = item.view.editor; });
  if (editor) editor.setValue(${JSON.stringify(SOURCE)});
  else await app.vault.modify(view.file, ${JSON.stringify(SOURCE)});
  await new Promise(resolve => setTimeout(resolve, 900));
  await view.setState({ viewport: ${JSON.stringify(START)} }, { history: false });
  await new Promise(resolve => setTimeout(resolve, 400));
  if (await view.store.read(view.file) !== ${JSON.stringify(SOURCE)}) throw new Error('the note did not go back to the case source');
  return true;`);

/**
 * Installs the probe: every root sampled once per painted frame, and the view's re-reads and the watcher's schedules
 * logged with the epoch, so a read that the watcher superseded shows as one whose epoch moved while it read.
 */
const arm = slow => evaluate(`${VIEW}
  const slow = ${JSON.stringify(slow)};
  const probe = window.__mappyE2EDrop = { frames: [], log: [], t0: performance.now(), done: false };
  const now = () => Math.round((performance.now() - probe.t0) * 10) / 10;
  const store = view.store;
  const schedule = view.scheduleRefresh;
  const storeRead = store.read;
  view.scheduleRefresh = function (...args) {
    probe.log.push({ at: now(), what: 'schedule', saving: view.saving });
    return schedule.apply(this, args);
  };
  store.read = async function (...args) {
    const entry = { at: now(), what: 'read', saving: view.saving, epoch: view.epoch };
    probe.log.push(entry);
    try {
      const text = await storeRead.apply(this, args);
      if (slow > 0) await new Promise(resolve => setTimeout(resolve, slow));
      return text;
    } finally { entry.end = now(); entry.epochEnd = view.epoch; }
  };
  // Both were the prototype's: deleting the own properties puts them back.
  probe.release = () => { delete view.scheduleRefresh; delete store.read; probe.done = true; };
  const sample = () => {
    if (probe.done) return;
    requestAnimationFrame(() => setTimeout(() => {
      if (probe.done) return;
      try { probe.frames.push({ at: now(), roots: ${ROOT_RECTS}, dragging: view.topicDrag != null }); } catch (error) { probe.frames.push({ at: now(), error: String(error) }); }
      sample();
    }, 0));
  };
  sample();
  return true;`);

const collect = () => evaluate(`const probe = window.__mappyE2EDrop; probe.release(); return { frames: probe.frames, log: probe.log };`);

const drop = async ({ target, form }) => {
  const failures = [];
  const expect = (condition, message) => { if (!condition) failures.push(message); };
  await reset();
  const start = await read();
  const root = start.roots[target.title];
  const press = { x: root.x + 12, y: root.y + 8 };
  const reach = await evaluate(`${VIEW}
    const top = document.elementFromPoint(${press.x}, ${press.y});
    return top?.closest?.('.mappy-node') === nth(${JSON.stringify(target.title)}, 0);`);
  if (!reach) return { failures: [`the press at ${fmt(press)} does not reach ${target.title}`] };

  await mouse('mousePressed', press);
  const held = { x: press.x + 60, y: press.y + 30 };
  await carryTo(press, held);
  await wait(300);
  const carried = await read();
  expect(carried.dragging, 'the press and move did not start a free drag');
  await arm(form === 'slow' ? SLOW_MS : 0);
  await wait(50);
  await mouse('mouseReleased', held);
  await wait(SAMPLE_MS);
  const { frames, log } = await collect();
  const settled = await read();
  expect(!settled.dragging, 'the release did not end the drag');
  expect(settled.text !== SOURCE, 'the release wrote nothing');
  expect(settled.messages.length === 0, `messages after the release: ${settled.messages.join(' / ')}`);
  const tolerance = Math.max(1, settled.scale);
  const off = [];
  for (const [index, sample] of frames.entries()) {
    if (sample.error) { off.push({ index, at: sample.at, error: sample.error }); continue; }
    for (const title of ROOTS) {
      const was = carried.roots[title];
      const now = sample.roots[title];
      if (Math.abs(now.x - was.x) > tolerance || Math.abs(now.y - was.y) > tolerance) {
        off.push({ index, at: sample.at, title, shown: now, released: was, dragging: sample.dragging });
      }
    }
  }
  expect(frames.length > 10, `only ${frames.length} frames were sampled (a throttled window?)`);
  expect(off.length === 0, `${off.length} root placements off the release: first ${JSON.stringify(off[0])}`);
  // The save's own re-read is the first read made while the view is saving (a watcher's re-read can start while it
  // still reads); superseded when the epoch moved while it read.
  const own = log.find(entry => entry.what === 'read' && entry.saving) ?? null;
  const superseded = own ? own.epochEnd !== own.epoch : null;
  return { failures, frames: frames.length, off: off.slice(0, 6), offCount: off.length, superseded, own, log };
};

try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  required(record, 'open', await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE, layout: 'mindmap' })));
  const results = [];
  let form = null;
  for (const row of rows) {
    if (row.form !== form) {
      const opened = required(record, `form-${row.form}`, await step(`form-${row.form}`, () => setForm(row.form)));
      check(opened.editors === (row.form === 'editor' ? 1 : 0), `${row.form}: ${opened.editors} Markdown editors on the note`);
      form = row.form;
    }
    for (let round = 1; round <= repeat; round += 1) {
      const id = `${row.id}#${round}`;
      const result = await step(id, async () => {
        try { return await drop(row); } finally {
          await mouse('mouseReleased', { x: 1, y: 1 }).catch(() => undefined);
          await evaluate(`window.__mappyE2EDrop?.release?.(); return true;`).catch(() => undefined);
        }
      });
      results.push({ id, result });
      for (const failure of result?.failures ?? []) check(false, `${id}: ${failure}`);
    }
  }
  record.rows = {
    total: results.length,
    failed: results.filter(({ result }) => !result || result.error || result.failures?.length).length,
    superseded: results.filter(({ result }) => result?.superseded === true).map(({ id }) => id),
  };
  check(results.length > 0, 'no row ran');
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(String(error));
} finally {
  await clean();
  cdp.close();
}

process.exit(await finish(record, value('--json')));
