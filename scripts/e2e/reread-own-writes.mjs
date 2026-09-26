/**
 * E58 (docs/harness.md): a second write of the map's own recorded while a re-read of the text on screen is reading
 * keeps the ids it carries: the fold of the second untitled or same-titled node stays (LEV-218).
 *
 * `reread` drops the whole record of the map's own writes when it does not lead to the text read (`if (!replayed)
 * this.ownWrites = []`). Since LEV-219 the save shows what it wrote at once, so the rename's last re-read (the
 * watcher's) finds the text on screen and leads nowhere; a second write W2 recorded while it reads (its start is the
 * text on screen) would be dropped with it, and W2's re-read would match nodes by title. What keeps it is the epoch
 * check right after the read: every write the record takes is one the store has just made on this note, and the note's
 * watcher — `modify` for a note no editor holds (the store writes through `vault.process`), `editor-change` for one a
 * Markdown editor holds (`editor.transaction`) — moves the epoch before the store tells the view (`DocumentStore.tell`),
 * so the read gives up first. jsdom's vault fires `modify` inside its write by construction; this case measures that
 * order on Obsidian's own events.
 *
 * Rows are the second write × the note's form × the node folded: `button` (this map's layout button), `other-button`
 * (the layout button of a second map on the note, a split), `other-edit` (the second map moves 子2 up: an edit of its
 * own), `other-undo` (⌘Z in the second map: the shared history takes back this map's rename), `key` (this map moves
 * 子2 up), `undo` (⌘Z in this map) × `alone` (no Markdown editor on the note) and `editor` (one beside the map) ×
 * `empty` (the second untitled node) and `same` (the second 同名). The node is selected and folded by the real mouse,
 * 子1 renamed with F2, real keys and Enter. The probe answers this map's reads SLOW_MS late (read first, answered late:
 * E53's `slow`) but for the save's own re-read (`reread(true)`: slowed, the save would still be under way and this
 * map's own key refused), and, INSIDE_MS into the rename's last re-read (the first read begun after the write with no
 * refresh scheduled), makes the second write from the page — a click on the button's element, a keydown (⌥↑ on 子2,
 * ⌘Z) dispatched on the map's canvas, which the map's own key handling takes (not Obsidian's keymap) — since no hand
 * can time a click or a key into an 80 ms window; the writes, the watchers and the re-reads are Obsidian's and the
 * plugin's own. `key` and `undo` are shown and spent the moment they land (`showOwnWrite`,
 * LEV-219), so they hold without the epoch check too: they pin the user's own next key, not the check.
 *
 * Each row checks that the window was hit (the read found the text on screen, was still the newest right before W2,
 * the map recorded W2, and the read gave up), the order (the map's watcher had scheduled a re-read after W2 was made
 * and before the map recorded it, and the epoch had moved by then), and the
 * outcome: the node keeps its id and its fold, the note holds the rename and W2 (for ⌘Z, the rename taken back), both
 * maps show the note, no Notice or error line in either map. For `other-edit` the second map must have re-read the
 * rename before it moves 子2 (otherwise its edit is refused as someone else's change, a different row). A row whose
 * window was not hit fails rather than pass.
 *
 * Usage: npm run harness:e2e:reread-own-writes -- [--reload] [--json <out.json>] [--keep] [--only <row>[,<row>…]]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeFocusCanvas, makeMarkSeen, makeOpenStep, makePluginStep, makePress, makeSelect } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-reread-own-writes.md';
const SOURCE = `---
mappy: true
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
`;
const EMPTY_LABEL = '空のノード';
/** How late this map's reads answer (all but the save's own re-read): longer than the watcher's 45 ms debounce (E53's `slow`). */
const SLOW_MS = 80;
/** When, inside the rename's last re-read, the second write is made. */
const INSIDE_MS = 40;
const RENAMED = '改名後';

const KINDS = ['button', 'other-button', 'other-edit', 'other-undo', 'key', 'undo'];
const FORMS = ['alone', 'editor'];
const SHAPES = [
  { name: 'empty', label: EMPTY_LABEL, index: 1 },
  { name: 'same', label: '同名', index: 1 },
];
const ROWS = KINDS.flatMap(kind => FORMS.flatMap(form => SHAPES.map(shape => ({ id: `${kind}-${form}-${shape.name}`, kind, form, shape }))));
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
const press = makePress(cdp, evaluate);
const focusCanvas = makeFocusCanvas(cdp, evaluate);
const markSeen = makeMarkSeen(evaluate);

/** Script: `second`, the second map on the note (a split of the first), and `editors`, the Markdown leaves on it. */
const LEAVES = `const path = ${JSON.stringify(NOTE)};
  const second = window.__mappyE2ESecond ?? null;
  const editors = [];
  app.workspace.iterateAllLeaves(item => { if (item.view?.getViewType?.() === 'markdown' && item.view.file?.path === path) editors.push(item); });`;

const clean = () => step('clean', () => evaluate(`
  ${LEAVES}
  window.__mappyE2EReread?.release?.();
  app.workspace.iterateAllLeaves(item => {
    const state = item.getViewState();
    if (item.view?.file?.path === path || state.state?.file === path) item.detach();
  });
  const file = app.vault.getAbstractFileByPath(path);
  const remove = ${JSON.stringify(!flag('--keep'))};
  if (file && remove) await app.vault.delete(file, true);
  delete window.__mappyE2E;
  delete window.__mappyE2EBefore;
  delete window.__mappyE2ESecond;
  delete window.__mappyE2EReread;
  return { removed: file && remove ? path : null };`));

/** The second map, a split below the first (a split above and below keeps the first map's nodes where they were). */
const openSecond = () => step('second', () => evaluate(`${VIEW}
  const second = app.workspace.createLeafBySplit(leaf, 'horizontal');
  await second.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(NOTE)}, layout: 'mindmap' }, active: false });
  await new Promise(resolve => setTimeout(resolve, 1500));
  window.__mappyE2ESecond = second;
  app.workspace.setActiveLeaf(leaf, { focus: true });
  return { nodes: second.view.contentEl.querySelectorAll('.mappy-node').length };`));

/** A Markdown editor on the note beside the first map for `editor`, none for `alone` (as E53's `setForm`). */
const setForm = form => evaluate(`${VIEW}
  ${LEAVES}
  const changes = ${JSON.stringify(form)} === 'editor' ? editors.length === 0 : editors.length > 0;
  if (${JSON.stringify(form)} !== 'editor') { for (const item of editors) item.detach(); }
  else if (editors.length === 0) {
    // Through the plugin's router, as its own 右に Markdown を開く does: a plain markdown state of a map note is routed to a map.
    const side = app.workspace.createLeafBySplit(leaf, 'vertical');
    await view.router.openMarkdown(side, view.file, false);
  }
  if (changes) await new Promise(resolve => setTimeout(resolve, 800));
  app.workspace.setActiveLeaf(leaf, { focus: true });
  const open = [];
  app.workspace.iterateAllLeaves(item => { if (item.view?.getViewType?.() === 'markdown' && item.view.file?.path === path) open.push(item); });
  return { editors: open.length };`);

/** The note back as the case wrote it (through the editor when one is open), with both maps showing it and nothing folded. */
const reset = () => evaluate(`${VIEW}
  ${LEAVES}
  if (input()) throw new Error('a draft is still open');
  const editor = editors[0]?.view.editor ?? null;
  if (editor) editor.setValue(${JSON.stringify(SOURCE)});
  else await app.vault.modify(view.file, ${JSON.stringify(SOURCE)});
  const maps = [view, second?.view].filter(Boolean);
  // Until both maps show the case source with nothing left to read, or limit ms.
  const until = async (limit) => {
    const started = performance.now();
    while (performance.now() - started < limit) {
      if (maps.every(map => map.document?.source === ${JSON.stringify(SOURCE)} && map.refreshTimer === undefined && map.refreshing === undefined)) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  };
  if (!await until(3000)) throw new Error('a map did not re-read the case source');
  let moved = false;
  for (const map of maps) {
    // A layout button of the row before left its map on another layout: back on the regular map, so the button writes again.
    if (map.mode !== 'mindmap') { await map.setState({ layout: 'mindmap' }, { history: false }); moved = true; }
    if (map.collapsed.size > 0) { map.collapsed.clear(); map.draw(); }
  }
  // The switch back fits the map on its next frames: the nodes move until then.
  if (moved) await new Promise(resolve => setTimeout(resolve, 800));
  if (!await until(3000)) throw new Error('a map did not settle on the case source');
  if (await view.store.read(view.file) !== ${JSON.stringify(SOURCE)}) throw new Error('the note did not go back to the case source');
  // The splits (the second map below, the editor beside) left the first map's nodes where the whole pane placed them: 全体表示.
  view.viewport.fit(view.layout.bounds);
  await new Promise(resolve => setTimeout(resolve, 400));
  return true;`);

/** What the first map shows of `shape`: its node's id, the folds, the selection, the note and its messages. */
const read = shape => evaluate(`${VIEW}
  ${LEAVES}
  const node = nth(${JSON.stringify(shape.label)}, ${shape.index});
  return { id: node?.dataset.nodeId ?? null, collapsed: [...view.collapsed], selected: view.selectedId, editing: !!input(),
    text: await view.store.read(view.file), shown: view.document?.source ?? null, other: second?.view.document?.source ?? null,
    // The second map's inline error lines too (the notices are the window's, already in messages()).
    messages: [...messages(), ...Array.from(second?.view.contentEl.querySelectorAll('.mappy-inline-error') ?? [], item => item.textContent.trim()).filter(Boolean)] };`);

/**
 * Installs the probe on the first map: its reads (only those its `reread` asks for) answered SLOW_MS late; the rename's
 * write marked when the store answers; INSIDE_MS into the first read begun after it with no refresh scheduled, the
 * second write; and the epoch when the map records that write (`recordWrite`, what the store tells every map).
 */
const arm = kind => evaluate(`${VIEW}
  ${LEAVES}
  const slow = ${SLOW_MS};
  const inside = ${INSIDE_MS};
  const kind = ${JSON.stringify(kind)};
  const probe = window.__mappyE2EReread = { log: [], t0: performance.now(), landed: null, caughtUp: null, scheduled: false, found: {
    landedIn: null, gaveUp: null, newestBefore: null, movedBeforeRecord: null, recorded: null } };
  const now = () => Math.round((performance.now() - probe.t0) * 10) / 10;
  const store = view.store;
  const own = {};
  const mine = {};
  let asking = null;
  let inFlight = null;
  let fired = false;
  /** A keydown on a map's canvas, as the map's own key handling takes it. */
  const key = (map, init) => map.contentEl.querySelector('.mappy-canvas').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  const secondWrite = () => {
    if (kind === 'button') el.querySelector('.mappy-modes button[aria-label="タイムライン"]').click();
    else if (kind === 'other-button') second.view.contentEl.querySelector('.mappy-modes button[aria-label="階層図"]').click();
    else if (kind === 'other-edit') {
      const other = second.view;
      probe.caughtUp = other.document?.source === view.document?.source;
      other.select(other.document.nodes.find(item => item.title === '子2').id);
      key(other, { key: 'ArrowUp', altKey: true });
    } else if (kind === 'other-undo') key(second.view, { key: 'z', metaKey: true });
    else if (kind === 'key') {
      view.select(view.document.nodes.find(item => item.title === '子2').id);
      key(view, { key: 'ArrowUp', altKey: true });
    } else key(view, { key: 'z', metaKey: true });
  };
  mine.reread = view.reread;
  view.reread = function (...args) {
    asking = args[0] ? 'own' : 'watch';
    try { return mine.reread.apply(this, args); } finally { asking = null; }
  };
  mine.recordWrite = view.recordWrite;
  view.recordWrite = function (...args) {
    mine.recordWrite.apply(this, args);
    const found = probe.found;
    probe.log.push({ at: now(), what: 'recordWrite', epoch: view.epoch });
    if (!fired || found.recorded !== null || inFlight === null) return;
    // The epoch moved, and by a re-read this map's watcher scheduled after W2 was made: W2's own, not some other.
    found.movedBeforeRecord = view.epoch !== inFlight && probe.scheduled;
    found.recorded = view.ownWrites.some(item => item.after === args[1].after);
  };
  mine.scheduleRefresh = view.scheduleRefresh;
  view.scheduleRefresh = function (...args) {
    probe.log.push({ at: now(), what: 'schedule', epoch: view.epoch });
    if (fired && probe.found.recorded === null) probe.scheduled = true;
    return mine.scheduleRefresh.apply(this, args);
  };
  // The store is the plugin's one for every map, embed and the Excalidraw bridge: only this map's reads are slowed.
  own.read = store.read;
  store.read = async function (...args) {
    const asked = asking;
    asking = null;
    if (asked === null || args[0] !== view.file) return own.read.apply(this, args);
    // The save's own re-read answers at once: slowed, the save would still be under way when this map's key comes.
    if (asked === 'own') return own.read.apply(this, args);
    const epoch = view.epoch;
    const shown = view.document?.source;
    const carries = probe.landed !== null && inFlight === null && view.refreshTimer === undefined;
    const entry = { at: now(), what: 'read', epoch, carries };
    probe.log.push(entry);
    if (carries) {
      inFlight = epoch;
      setTimeout(() => {
        probe.found.newestBefore = view.epoch === epoch;
        fired = true;
        probe.log.push({ at: now(), what: 'second', epoch: view.epoch });
        try { secondWrite(); } catch (error) { probe.error = String(error); }
      }, inside);
    }
    // Read first, answered late: the second write lands between the read and its answer.
    const text = await own.read.apply(this, args);
    await new Promise(resolve => setTimeout(resolve, slow));
    entry.end = now(); entry.epochEnd = view.epoch; entry.unchanged = text === shown;
    if (carries) { probe.found.landedIn = text === shown; probe.found.gaveUp = view.epoch !== epoch; }
    return text;
  };
  own.applyOver = store.applyOver;
  store.applyOver = async function (...args) {
    const result = await own.applyOver.apply(this, args);
    if (args[0] === view.file && probe.landed === null) { probe.landed = now(); probe.log.push({ at: probe.landed, what: 'applyOver' }); }
    return result;
  };
  // All were the prototype's: deleting the own properties puts them back.
  probe.release = () => {
    for (const key of Object.keys(own)) delete store[key];
    for (const key of Object.keys(mine)) delete view[key];
  };
  return true;`);

/** Whether the probe's read has answered and the map has recorded the second write. */
const probed = () => evaluate(`const found = window.__mappyE2EReread?.found; return found?.gaveUp != null && found.recorded != null;`);

const collect = () => evaluate(`const probe = window.__mappyE2EReread; probe.release(); return { found: probe.found, log: probe.log, landed: probe.landed, caughtUp: probe.caughtUp, error: probe.error ?? null };`);

/** What each second write leaves in the note. */
const WROTE = {
  button: text => text.includes('mappy-layout: timeline\n'),
  'other-button': text => text.includes('mappy-layout: hierarchy\n'),
  'other-edit': text => text.includes('  - 子2\n  - 改名後\n'),
  'other-undo': text => text === SOURCE,
  key: text => text.includes('  - 子2\n  - 改名後\n'),
  undo: text => text === SOURCE,
};
const UNDOES = new Set(['other-undo', 'undo']);

const run = async ({ kind, form, shape }) => {
  const failures = [];
  const expect = (condition, message) => { if (!condition) failures.push(message); };
  const opened = await setForm(form);
  expect(opened.editors === (form === 'editor' ? 1 : 0), `${opened.editors} Markdown editors on the note`);
  await reset();
  // A Notice of the row before (it lasts seconds) is not this row's.
  await markSeen();
  // The node selected, then folded, by the real mouse.
  await select(shape.label, shape.index);
  await press(`const node = nth(${JSON.stringify(shape.label)}, ${shape.index})?.querySelector('.mappy-node-toggle');`);
  const folded = await read(shape);
  if (!folded.collapsed.includes(folded.id ?? '') || folded.selected !== folded.id) {
    return { failures: [`the map did not select and fold ${shape.label} #${shape.index}: ${JSON.stringify(folded)}`] };
  }
  // F2 on 子1, the new title typed; Enter after the probe is armed.
  await select('子1', 0);
  await cdp.realKey('F2');
  for (let tries = 0; tries < 20 && !(await read(shape)).editing; tries += 1) await wait(100);
  if (!(await read(shape)).editing) return { failures: ['F2 did not open the inline editor'] };
  await cdp.insertText(RENAMED);
  await wait(250);
  await arm(kind);
  await wait(50);
  await cdp.realKey('Enter');
  const started = Date.now();
  let after = await read(shape);
  while (Date.now() - started < 4000) {
    await wait(200);
    after = await read(shape);
    if (await probed() && WROTE[kind](after.text) && after.text === after.shown && after.other === after.text) break;
  }
  await wait(600);
  const { found, log, landed, caughtUp, error } = await collect();
  after = await read(shape);
  expect(error === null, `the second write threw: ${error}`);
  expect(landed !== null, 'the store wrote nothing for the rename');
  expect(found.landedIn === true, `the read the second write landed in did not find the text on screen (${JSON.stringify(found)})`);
  expect(found.newestBefore === true, `that read was superseded before the second write (${JSON.stringify(found)}): not the window`);
  expect(found.recorded === true, `the map did not record the second write (${JSON.stringify(found)})`);
  expect(found.movedBeforeRecord === true, `the epoch had not moved by the map's watcher of the second write when the map recorded it (${JSON.stringify(found)})`);
  expect(found.gaveUp === true, `the read did not give up (${JSON.stringify(found)})`);
  expect(UNDOES.has(kind) || after.text.includes(`  - ${RENAMED}\n`), 'the note lost the rename');
  expect(kind !== 'other-edit' || caughtUp === true, `the second map had not re-read the rename when it moved 子2 (${caughtUp})`);
  expect(WROTE[kind](after.text), `the note does not hold the second write (${kind})`);
  expect(after.text === after.shown, 'the map does not show the note');
  expect(after.other === after.text, 'the second map does not show the note');
  expect(after.id === folded.id, `the node's id changed (${folded.id} → ${after.id})`);
  expect(after.collapsed.includes(folded.id), `the fold went (${JSON.stringify(folded.collapsed)} → ${JSON.stringify(after.collapsed)})`);
  expect(after.messages.length === 0, `messages: ${after.messages.join(' / ')}`);
  return { failures, found, caughtUp, folded: { id: folded.id, collapsed: folded.collapsed }, after: { id: after.id, collapsed: after.collapsed }, landed, log };
};

try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  required(record, 'open', await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE, layout: 'mindmap' })));
  required(record, 'second', await openSecond());
  const results = [];
  for (const row of rows) {
    const result = await step(row.id, async () => {
      try { return await run(row); } finally {
        await evaluate(`window.__mappyE2EReread?.release?.(); return true;`).catch(() => undefined);
        // Back to the first map, the layout button left on the regular map for the next row.
        await evaluate(`${VIEW} if (input()) input().blur(); app.workspace.setActiveLeaf(leaf, { focus: true }); return true;`).catch(() => undefined);
        await focusCanvas().catch(() => undefined);
      }
    });
    results.push({ id: row.id, result });
    for (const failure of result?.failures ?? []) check(false, `${row.id}: ${failure}`);
  }
  record.rows = {
    total: results.length,
    failed: results.filter(({ result }) => !result || result.error || result.failures?.length).map(({ id }) => id),
    // Every flag the rows check: found the text on screen, still the newest, W2 recorded, the epoch moved first, gave up.
    windowHit: results.filter(({ result }) => result?.found && Object.values(result.found).every(flag => flag === true)).length,
  };
  check(results.length > 0, 'no row ran');
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(String(error));
} finally {
  await clean();
  cdp.close();
}

process.exit(await finish(record, value('--json')));
