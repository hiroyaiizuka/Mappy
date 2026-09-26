/**
 * E49 (docs/harness.md): a free tree (a topic, the body) carried by the mouse stays on the point grabbed while the
 * viewport changes under it, and the release stores what was shown (LEV-194).
 *
 * Every row presses a tree's root with the real mouse (`Input.dispatchMouseEvent`), carries it 60 × 30 px, and with
 * the button still held and the pointer still:
 * - `wheel-*`: turns the wheel over the held tree (a pan, sideways, ⌘ + wheel and Ctrl + wheel zooms) — the one hand
 *   on the mouse reaches it, which is why the ticket asks for it on the real device;
 * - `tap-*`: taps a zoom button (拡大・縮小・100%・全体表示) with a second pointer (`Input.dispatchTouchEvent`), the
 *   way a finger on a touch screen reaches one while the mouse holds the drag;
 * - `none`: nothing (a control row: the drag and the release alone, which pass with or without the fix).
 * Then it checks: the point grabbed is still under the pointer, at the new scale; what the drag does not carry moved
 * as the wheel or the button says (skipped for 全体表示, whose frame is its own choice); 30 more pixels of travel carry
 * the tree 30 pixels and nothing else; and after the release and the save's re-read every root sits where it was
 * shown at the release (both topics are stored beforehand, so every root has a stored place to be read back from).
 *
 * Usage: npm run harness:e2e:drag-viewport -- [--reload] [--json <out.json>] [--keep] [--only <row>[,<row>…]]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makePluginStep, makeOpenStep } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-drag-viewport.md';
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
/** The view each row starts from: away from the fit, at a scale none of the zooms here clamps from. */
const START = { x: 120, y: 120, scale: 0.9 };
/** Modifier bits of `Input.dispatchMouseEvent`: Ctrl=2, Meta=4. */
const CTRL = 2;
const META = 4;

const OPERATIONS = [
  { name: 'none' },
  { name: 'wheel-pan', wheel: { deltaX: 0, deltaY: 100 }, pan: { x: 0, y: -100 } },
  { name: 'wheel-pan-sideways', wheel: { deltaX: -60, deltaY: 40 }, pan: { x: 60, y: -40 } },
  { name: 'wheel-zoom-in-ctrl', wheel: { deltaX: 0, deltaY: -100, modifiers: CTRL }, zoom: 'pointer' },
  { name: 'wheel-zoom-out-meta', wheel: { deltaX: 0, deltaY: 100, modifiers: META }, zoom: 'pointer' },
  { name: 'tap-拡大', tap: '拡大', zoom: 'center' },
  { name: 'tap-縮小', tap: '縮小', zoom: 'center' },
  { name: 'tap-100%', tap: '100%', zoom: 'center' },
  { name: 'tap-全体表示', tap: '全体表示', zoom: null },
];
const TARGETS = [{ name: 'topic', title: '資料' }, { name: 'body', title: '本体' }];
const ROWS = TARGETS.flatMap(target => OPERATIONS.map(operation => ({ id: `${target.name}-${operation.name}`, target, operation })));
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

const clean = () => step('clean', () => evaluate(`
  const path = ${JSON.stringify(NOTE)};
  app.workspace.iterateAllLeaves(item => {
    const state = item.getViewState();
    if (item.view?.file?.path === path || state.state?.file === path) item.detach();
  });
  const file = app.vault.getAbstractFileByPath(path);
  const remove = ${JSON.stringify(!flag('--keep'))};
  if (file && remove) await app.vault.delete(file, true);
  delete window.__mappyE2E;
  delete window.__mappyE2EBefore;
  return { removed: file && remove ? path : null };`));

/** What is on screen: each root's top-left and the canvas in window CSS pixels, the zoom, and whether a free drag is under way. */
const read = () => evaluate(`${VIEW}
  const canvas = el.querySelector('.mappy-canvas').getBoundingClientRect();
  const roots = {};
  for (const title of ${JSON.stringify(ROOTS)}) {
    const node = nth(title, 0);
    if (!node) throw new Error('No node ' + title);
    const rect = node.getBoundingClientRect();
    roots[title] = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }
  return {
    canvas: { left: canvas.left, top: canvas.top, width: canvas.width, height: canvas.height },
    scale: view.viewport.value.scale, view: { ...view.viewport.value }, dragging: view.topicDrag != null, source: await source(), messages: messages(),
  roots };`);

const mouse = (type, point, extra = {}) => cdp.send('Input.dispatchMouseEvent', {
  type, x: point.x, y: point.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1, ...extra,
});
/** A pointer carried in small steps, as a hand moves it, with a frame between each. */
const carryTo = async (from, to, steps = 6) => {
  for (let index = 1; index <= steps; index += 1) {
    await mouse('mouseMoved', { x: from.x + (to.x - from.x) * index / steps, y: from.y + (to.y - from.y) * index / steps });
    await wait(20);
  }
};
const near = (a, b, tolerance) => Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
const fmt = point => `(${point.x.toFixed(1)}, ${point.y.toFixed(1)})`;

const runRow = async ({ id, target, operation }) => {
  const failures = [];
  const expect = (condition, message) => { if (!condition) failures.push(message); };
  // The note back as the case wrote it, and the view back at START: each row starts from the same map.
  await evaluate(`${VIEW}
    if (view.topicDrag) throw new Error('a drag is still under way');
    await app.vault.modify(view.file, ${JSON.stringify(SOURCE)});
    await new Promise(resolve => setTimeout(resolve, 700));
    await view.setState({ viewport: ${JSON.stringify(START)} }, { history: false });
    await new Promise(resolve => setTimeout(resolve, 400));
    if (await source() !== ${JSON.stringify(SOURCE)}) throw new Error('the note did not go back to the case source');`);
  const start = await read();
  const root = start.roots[target.title];
  const press = { x: root.x + 12, y: root.y + 8 };
  const reach = await evaluate(`${VIEW}
    const top = document.elementFromPoint(${press.x}, ${press.y});
    return top?.closest?.('.mappy-node') === nth(${JSON.stringify(target.title)}, 0);`);
  if (!reach) return { id, failures: [`the press at ${fmt(press)} does not reach ${target.title}`] };

  await mouse('mousePressed', press);
  const held = { x: press.x + 60, y: press.y + 30 };
  await carryTo(press, held);
  await wait(300);
  const before = await read();
  expect(before.dragging, 'the press and move did not start a free drag');
  const grab = tree => ({ x: (held.x - tree.x) / tree.scale, y: (held.y - tree.y) / tree.scale });
  const grabBefore = grab({ ...before.roots[target.title], scale: before.scale });

  let tapped = null;
  if (operation.wheel) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: held.x, y: held.y, deltaX: operation.wheel.deltaX, deltaY: operation.wheel.deltaY,
      modifiers: operation.wheel.modifiers ?? 0, button: 'none', buttons: 1,
    });
  } else if (operation.tap) {
    tapped = await evaluate(`${VIEW}
      const button = el.querySelector('button[aria-label="' + ${JSON.stringify(operation.tap)} + '"]');
      if (!button) throw new Error('No button ' + ${JSON.stringify(operation.tap)});
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tapped.x, y: tapped.y, id: 7 }] });
    await wait(40);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await wait(400);
  const after = await read();
  expect(after.dragging, 'the drag ended with the operation');
  const ratio = after.scale / before.scale;
  if (operation.zoom) expect(Math.abs(ratio - 1) > 1e-3, `the ${operation.name} did not change the zoom (${before.scale} → ${after.scale})`);
  // 全体表示 is checked against nothing below (its frame is its own choice): that it ran at all is checked here, or a tap
  // that never reached the button would pass every check after it with nothing moved.
  if (operation.tap && !operation.zoom) {
    expect(Math.abs(after.view.x - before.view.x) > 0.5 || Math.abs(after.view.y - before.view.y) > 0.5 || Math.abs(ratio - 1) > 1e-3,
      `the ${operation.name} did not change the viewport`);
  }
  // The point grabbed is still under the pointer: a pixel of rounding (rects are laid out and scaled by the zoom).
  const grabAfter = grab({ ...after.roots[target.title], scale: after.scale });
  expect(near({ x: grabAfter.x * after.scale, y: grabAfter.y * after.scale }, { x: grabBefore.x * after.scale, y: grabBefore.y * after.scale }, 1),
    `${target.title} left the pointer: grabbed at ${fmt(grabBefore)}, now ${fmt(grabAfter)} (layout px)`);
  // Everything else moved as the operation says.
  const others = ROOTS.filter(title => title !== target.title);
  const at = operation.zoom === 'pointer' ? held
    : operation.zoom === 'center' ? { x: after.canvas.left + after.canvas.width / 2, y: after.canvas.top + after.canvas.height / 2 } : null;
  for (const title of others) {
    const was = before.roots[title];
    const now = after.roots[title];
    const expected = operation.pan ? { x: was.x + operation.pan.x, y: was.y + operation.pan.y }
      : at ? { x: at.x + (was.x - at.x) * ratio, y: at.y + (was.y - at.y) * ratio }
        : operation.name === 'none' ? was : null;
    if (expected) expect(near(now, expected, 1), `${title} is at ${fmt(now)}, not ${fmt(expected)} as the ${operation.name} moves it`);
  }

  // The drag goes on: 30 px more carries the tree 30 px, and nothing else.
  const moved = { x: held.x + 30, y: held.y };
  await carryTo(held, moved, 3);
  await wait(300);
  const carried = await read();
  const shownTree = after.roots[target.title];
  expect(near(carried.roots[target.title], { x: shownTree.x + 30, y: shownTree.y }, 1),
    `30 px of travel put ${target.title} at ${fmt(carried.roots[target.title])}, not ${fmt({ x: shownTree.x + 30, y: shownTree.y })}`);
  for (const title of others) expect(near(carried.roots[title], after.roots[title], 1), `${title} moved with the pointer's travel`);

  // Released there: what the save stores is what was shown.
  await mouse('mouseReleased', moved);
  await wait(1600);
  const released = await read();
  expect(!released.dragging, 'the release did not end the drag');
  expect(released.source !== SOURCE, 'the release wrote nothing');
  expect(released.messages.length === 0, `messages after the release: ${released.messages.join(' / ')}`);
  const tolerance = Math.max(1, released.scale);
  for (const title of ROOTS) {
    expect(near(released.roots[title], carried.roots[title], tolerance),
      `after the save ${title} sits at ${fmt(released.roots[title])}, not where it was shown at the release ${fmt(carried.roots[title])}`);
  }
  const topics = released.source.match(/mappy-topics:\n((?: {2}.+\n)+)/u)?.[1] ?? '';
  return {
    id, failures, tapped, scale: { before: before.scale, after: after.scale, released: released.scale },
    grab: { before: grabBefore, after: grabAfter }, stored: topics.trim().split('\n').map(line => line.trim()),
  };
};

try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  required(record, 'open', await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE, layout: 'mindmap' })));
  const results = [];
  for (const row of rows) {
    const result = await step(row.id, async () => {
      try { return await runRow(row); } finally {
        // A row that failed part way must not leave the button held for the next one.
        await mouse('mouseReleased', { x: 1, y: 1 }).catch(() => undefined);
      }
    });
    results.push(result);
    for (const failure of result?.failures ?? []) check(false, `${row.id}: ${failure}`);
  }
  record.rows = { total: rows.length, failed: results.filter(result => !result || result.error || result.failures?.length).length };
  check(rows.length > 0, 'no row ran');
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(String(error));
} finally {
  await clean();
  cdp.close();
}

process.exit(await finish(record, value('--json')));
