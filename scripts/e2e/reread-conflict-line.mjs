/**
 * E76 (docs/harness.md, LEV-252): a draft confirmed while the map's re-read is reading the note, and refused as a
 * conflict, turns its error line to 「Markdown が更新されました…」 once the map has re-read, on the real Obsidian.
 *
 * Before LEV-252 the line stayed on 「マップを更新してから再編集してください」: the re-read under way when the save began
 * published the external change while the save ran (`reread` skips telling the drafts while `saving`), before the
 * refusal, and the re-read the refusal schedules found the text on screen (`changed` false), so nothing told the draft.
 * The next Enter applied all the same; only the line was stale.
 *
 * Rows are the draft: `modal` (本文・リンクを編集, confirmed with ⌘Enter) and `inline` (F2, confirmed with Enter), both on
 * 学ぶこと, under an external change to another branch (記録する → 記録する（外部）, written with `app.vault.modify`).
 * The window is the I/O time of `vault.read` (a few ms), which no hand can time a key into, so the probe holds it open:
 * this map's watcher re-read (`reread` with `scheduled`) has its `store.read` read the note and then wait; the real key
 * confirms the draft; the store's write for it (`applyOver`) lets that read answer and waits until the map has
 * published the external change before it goes on and is refused. The keys, the watcher, the store and the drafts
 * are Obsidian's and the plugin's own.
 *
 * Each row checks that the window was hit (the held read found the external text, the map showed it while the save
 * was under way, and the save was refused as a conflict — the line said CONFLICT right after), then the outcome: the
 * line says REFRESHED after the map's re-read, the draft is still open, and the next Enter applies the draft on top of
 * the external text and closes it. With the fix reverted the REFRESHED check fails in both rows.
 *
 * Usage: npm run harness:e2e:reread-conflict-line -- [--reload] [--json <out.json>] [--keep] [--only <row>[,<row>…]]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeFocusCanvas, makeMarkSeen, makeOpenStep, makePluginStep, makeSelect } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-reread-conflict-line.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 講座の構成', '',
  '- はじめに', '  - 学ぶこと', '  - 全体の流れ',
  '- 記録する', '  - 毎日のログ', '',
].join('\n');
const EXTERNAL = SOURCE.replace('- 記録する\n', '- 記録する（外部）\n');
const CONFLICT = 'Markdown が変更されています。マップを更新してから再編集してください。';
const REFRESHED = 'Markdown が更新されました。もう一度確定すると新しい内容に適用し、取り消すと閉じます。';
/** ⌘ in `Input.dispatchKeyEvent`'s modifiers. */
const META = 4;

const ROWS = [
  { id: 'modal', typed: '新しい本文', applied: EXTERNAL.replace('  - 学ぶこと\n', '  - 学ぶこと\n\n    新しい本文\n') },
  { id: 'inline', typed: '学ぶこと（編集）', applied: EXTERNAL.replace('  - 学ぶこと\n', '  - 学ぶこと（編集）\n') },
];
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
const markSeen = makeMarkSeen(evaluate);

/** Script: `draftInput()`, the open draft's input (the modal's or the inline editor's), and `line()`, its error line. */
const DRAFT = `const draftInput = () => document.querySelector('.modal .mappy-edit-input') ?? input();
  const line = () => (document.querySelector('.modal .mappy-edit-error') ?? el.querySelector('.mappy-inline-error'))?.textContent.trim() ?? '';`;

/** The note back to the case source, shown by the map with nothing left to read, and no draft open. */
const reset = () => evaluate(`${VIEW} ${DRAFT}
  if (draftInput()) throw new Error('a draft is still open');
  await app.vault.modify(view.file, ${JSON.stringify(SOURCE)});
  const started = performance.now();
  while (performance.now() - started < 3000) {
    if (view.document?.source === ${JSON.stringify(SOURCE)} && view.refreshTimer === undefined && view.refreshing === undefined) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('the map did not re-read the case source');`);

/** Opens the row's draft on 学ぶこと and types into it, through the menu (modal) or F2 (inline), with real keys. */
const openDraft = async row => {
  await select('学ぶこと', 0);
  if (row.id === 'modal') {
    await evaluate(`${VIEW} const before = app.vault.getConfig('nativeMenus'); app.vault.setConfig('nativeMenus', false);
      try {
        const node = nth('学ぶこと', 0); const rect = node.getBoundingClientRect();
        node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
        await new Promise(resolve => setTimeout(resolve, 300));
        const item = Array.from(document.querySelectorAll('.menu .menu-item')).find(entry => entry.querySelector('.menu-item-title')?.textContent === '本文・リンクを編集');
        if (!item) throw new Error('the node menu has no 本文・リンクを編集');
        item.click();
      } finally { app.vault.setConfig('nativeMenus', before); }
      return true;`);
  } else await cdp.realKey('F2');
  for (let tries = 0; tries < 20; tries += 1) {
    if (await evaluate(`${VIEW} ${DRAFT} const target = draftInput(); if (!target) return false; target.focus(); target.select(); return document.activeElement === target;`)) break;
    await wait(100);
  }
  await cdp.insertText(row.typed);
  await wait(200);
  return evaluate(`${VIEW} ${DRAFT} return draftInput()?.value ?? null;`);
};

/**
 * Installs the probe: this map's watcher re-read reads the note and waits before it answers; the store's write for the
 * draft lets it answer and goes on only once the map shows what it read (or after 2 s).
 */
const arm = () => evaluate(`${VIEW}
  const store = view.store;
  const probe = window.__mappyE2EConflict = { log: [], held: null, heldText: null, publishedWhileSaving: null, refused: null, t0: performance.now() };
  const now = () => Math.round((performance.now() - probe.t0) * 10) / 10;
  const own = {};
  const mine = {};
  let asking = null;
  let release = null;
  mine.reread = view.reread;
  view.reread = function (...args) {
    asking = args[1] ? 'scheduled' : 'other';
    try { return mine.reread.apply(this, args); } finally { asking = null; }
  };
  own.read = store.read;
  store.read = async function (...args) {
    const asked = asking;
    asking = null;
    if (asked !== 'scheduled' || args[0] !== view.file || probe.held !== null) return own.read.apply(this, args);
    const text = await own.read.apply(this, args);
    probe.held = now();
    probe.heldText = text;
    probe.log.push({ at: now(), what: 'read held', external: text === ${JSON.stringify(EXTERNAL)} });
    await new Promise(resolve => { release = resolve; });
    probe.log.push({ at: now(), what: 'read answers' });
    return text;
  };
  own.applyOver = store.applyOver;
  store.applyOver = async function (...args) {
    if (args[0] === view.file && release) {
      probe.log.push({ at: now(), what: 'applyOver', saving: view.saving });
      const go = release; release = null; go();
      const started = performance.now();
      while (view.document?.source !== probe.heldText && performance.now() - started < 2000) await new Promise(resolve => setTimeout(resolve, 5));
      probe.publishedWhileSaving = view.saving && view.document?.source === ${JSON.stringify(EXTERNAL)};
      probe.log.push({ at: now(), what: 'published', publishedWhileSaving: probe.publishedWhileSaving });
      try { return await own.applyOver.apply(this, args); } catch (error) {
        probe.refused = error?.name ?? String(error);
        probe.log.push({ at: now(), what: 'refused', error: probe.refused });
        throw error;
      }
    }
    return own.applyOver.apply(this, args);
  };
  // All were the prototype's: deleting the own properties puts them back.
  probe.release = () => {
    release?.();
    for (const key of Object.keys(own)) delete store[key];
    for (const key of Object.keys(mine)) delete view[key];
  };
  return true;`);

const until = async (script, limit = 3000) => {
  const started = Date.now();
  for (;;) {
    if (await evaluate(script)) return true;
    if (Date.now() - started > limit) return false;
    await wait(20);
  }
};

const read = () => evaluate(`${VIEW} ${DRAFT}
  return { open: !!draftInput(), value: draftInput()?.value ?? null, line: line(), text: await source(), shown: view.document?.source ?? null };`);

const run = async row => {
  const failures = [];
  const expect = (condition, message) => { if (!condition) failures.push(message); };
  await reset();
  await markSeen();
  const typed = await openDraft(row);
  if (typed !== row.typed) return { failures: [`the ${row.id} draft did not take the text: ${JSON.stringify(typed)}`] };
  await arm();
  await evaluate(`await app.vault.modify(app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}), ${JSON.stringify(EXTERNAL)}); return true;`);
  // The watcher's re-read (45 ms after the modify) has read the note and is held.
  if (!await until(`return window.__mappyE2EConflict.held !== null;`)) return { failures: ['the map never re-read the note after the external change'] };
  await cdp.realKey('Enter', row.id === 'modal' ? META : 0);
  if (!await until(`return window.__mappyE2EConflict.refused !== null || window.__mappyE2EConflict.publishedWhileSaving === false;`)) {
    failures.push('the save was neither refused nor let through');
  }
  // Right after the refusal, before the map's own re-read of it (45 ms).
  const refused = await read();
  await wait(600);
  const after = await read();
  const probe = await evaluate(`const probe = window.__mappyE2EConflict; probe.release();
    return { held: probe.held, heldExternal: probe.heldText === ${JSON.stringify(EXTERNAL)}, publishedWhileSaving: probe.publishedWhileSaving, refused: probe.refused, log: probe.log };`);
  expect(probe.heldExternal, `the held read did not find the external text (${JSON.stringify(probe)})`);
  expect(probe.publishedWhileSaving === true, `the map did not show the external change while the save was under way (${JSON.stringify(probe)}): not the window`);
  expect(probe.refused === 'ConflictError', `the save was not refused as a conflict (${probe.refused})`);
  expect(refused.line === CONFLICT, `right after the refusal the line said ${JSON.stringify(refused.line)}: not the window`);
  expect(after.shown === EXTERNAL && after.text === EXTERNAL, 'the map or the note is not the external text');
  expect(after.open && after.value === row.typed, `the draft did not stay open with its text (${JSON.stringify(after)})`);
  expect(after.line === REFRESHED, `after the map's re-read the line says ${JSON.stringify(after.line)}`);
  // The next Enter applies the draft on top of the external text.
  await evaluate(`${VIEW} ${DRAFT} draftInput()?.focus(); return true;`);
  await cdp.realKey('Enter', row.id === 'modal' ? META : 0);
  let retried = await read();
  for (let tries = 0; tries < 30 && (retried.open || retried.text !== row.applied); tries += 1) { await wait(100); retried = await read(); }
  expect(retried.text === row.applied, `the retry wrote ${JSON.stringify(retried.text)}`);
  expect(!retried.open, 'the retry did not close the draft');
  return { failures, probe, refused: refused.line, after: after.line, retried: { open: retried.open, applied: retried.text === row.applied } };
};

try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  required(record, 'open', await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE, layout: 'mindmap' })));
  const results = [];
  for (const row of rows) {
    const result = await step(row.id, async () => {
      try { return await run(row); } finally {
        await evaluate(`window.__mappyE2EConflict?.release?.(); return true;`).catch(() => undefined);
        // A draft a failed row left open: closed without writing it.
        await evaluate(`${VIEW} ${DRAFT} const modal = document.querySelector('.modal .mappy-edit-input');
          if (modal) modal.closest('.modal-container')?.querySelector('.modal-close-button')?.click();
          return true;`).catch(() => undefined);
        await wait(200);
        if (await evaluate(`${VIEW} return !!input();`).catch(() => false)) { await cdp.realKey('Escape'); await wait(300); }
        await focusCanvas().catch(() => undefined);
      }
    });
    results.push({ id: row.id, result });
    for (const failure of result?.failures ?? []) check(false, `${row.id}: ${failure}`);
  }
  record.rows = {
    total: results.length,
    failed: results.filter(({ result }) => !result || result.error || result.failures?.length).map(({ id }) => id),
    windowHit: results.filter(({ result }) => result?.probe?.publishedWhileSaving === true && result.probe.refused === 'ConflictError' && result.refused === CONFLICT).length,
  };
  check(results.length > 0, 'no row ran');
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(String(error));
} finally {
  await step('clean', () => evaluate(`window.__mappyE2EConflict?.release?.();
    const path = ${JSON.stringify(NOTE)};
    app.workspace.iterateAllLeaves(item => { const state = item.getViewState(); if (item.view?.file?.path === path || state.state?.file === path) item.detach(); });
    const file = app.vault.getAbstractFileByPath(path);
    const remove = ${JSON.stringify(!flag('--keep'))};
    if (file && remove) await app.vault.delete(file, true);
    delete window.__mappyE2E; delete window.__mappyE2EBefore; delete window.__mappyE2EConflict;
    return { removed: file && remove ? path : null };`));
  cdp.close();
}

process.exit(await finish(record, value('--json')));
