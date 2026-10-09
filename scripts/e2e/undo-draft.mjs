/**
 * E85 (docs/harness.md, LEV-331): ⌘Z right after a node is added, with its draft still open. The person's report
 * (2026-10-09): Tab (a subtopic) or Enter (a main topic), then ⌘Z, and nothing came back; a click on the empty canvas
 * first (the draft closed) and the same ⌘Z did. The canvas takes ⌘Z for the map and leaves keys in the draft alone,
 * and the draft's textarea had nothing to undo: its provisional name was set from outside.
 *
 * Rows: the operation (real keys on a real click's selection, real ⌘Z／⌘⇧Z) × the draft (Tab's subtopic, Enter's main
 * topic, the root's Tab, Enter deeper down, Enter on a section of a headings note, a free topic from a double click on
 * the empty canvas; text typed into the draft; an F2 draft on a node that was there, which keeps ⌘Z; the draft confirmed
 * with Enter, untouched and typed over) × the layout
 * (mindmap, timeline). Each row opens the fixture afresh and compares the whole note after each key.
 *
 * A ⌘Z the page leaves alone goes on to the app menu (Electron's accelerator for an unhandled key), which stalled the
 * test Obsidian when a first probe sent it to the draft on the build before the fix. A guard in the page therefore cancels a ⌘Z
 * nothing else cancelled, and records it as unhandled: a row expecting the map to take the key fails on that record,
 * and the menu never sees it. The row that types into the draft expects the key to be left to the textarea: the guard
 * stops the menu's Undo there too, so `document.execCommand('undo')` stands in for it (the textarea's own Undo).
 *
 * ⌘Z there is Escape: the node is taken back (nothing is left to redo); when Escape would not (something else was
 * written since the addition), only the draft closes. That second branch is jsdom's only. The rows that leave ⌘Z to
 * the textarea see only that the map did not take it: what the app menu then does with the key is not observed.
 *
 * Usage: npm run harness:e2e:undo-draft -- [--reload] [--json <out.json>] [--keep]
 */
import { VAULT, connect, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required, until } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep, makeOpenStep, makeDeleteNote, makeMarkSeen } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const LIST_NOTE = 'Fixtures/E2E-undo-draft.md';
const HEADINGS_NOTE = 'Fixtures/E2E-undo-draft-headings.md';
const LIST = ['---', 'mappy: true', '---', '## 旅の計画', '', '- 温泉旅行', '  - 予約', '- 持ち物', ''].join('\n');
const HEADINGS = ['---', 'mappy: true', '---', '# 旅の計画', '', '## 温泉旅行', '', '本文', '', '## 持ち物', ''].join('\n');
const LAYOUTS = ['mindmap', 'timeline'];
// Written out, not read from src/i18n: the case reads what the map writes.
const SUB = 'サブトピック';
const MAIN = 'メイントピック';
const TOPIC = 'トピック';

/** Each shape: the note, how the node is added (a key on `target`, or a double click on the empty canvas) and the note it leaves. */
const SHAPES = [
  { id: 'tab-subtopic', note: LIST_NOTE, source: LIST, target: '持ち物', key: 'Tab', name: SUB, written: LIST.replace('- 持ち物\n', `- 持ち物\n  - ${SUB}\n`) },
  { id: 'enter-main-topic', note: LIST_NOTE, source: LIST, target: '温泉旅行', key: 'Enter', name: MAIN, written: LIST.replace('  - 予約\n', `  - 予約\n- ${MAIN}\n`) },
  { id: 'root-tab-main-topic', note: LIST_NOTE, source: LIST, target: '旅の計画', key: 'Tab', name: MAIN, written: LIST.replace('- 持ち物\n', `- 持ち物\n- ${MAIN}\n`) },
  { id: 'enter-subtopic', note: LIST_NOTE, source: LIST, target: '予約', key: 'Enter', name: SUB, written: LIST.replace('  - 予約\n', `  - 予約\n  - ${SUB}\n`) },
  { id: 'headings-enter', note: HEADINGS_NOTE, source: HEADINGS, target: '温泉旅行', key: 'Enter', name: MAIN, written: HEADINGS.replace('本文\n', `本文\n\n## ${MAIN}\n`) },
  { id: 'double-click-topic', note: LIST_NOTE, source: LIST, target: null, key: null, name: TOPIC, written: `${LIST}\n## ${TOPIC}\n` },
];

const record = createRecord(VAULT, LIST_NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const markSeen = makeMarkSeen(evaluate);
const detachMaps = () => evaluate('app.workspace.getLeavesOfType("mappy-map").forEach(leaf => leaf.detach()); await new Promise(resolve => setTimeout(resolve, 300)); return true;');

/**
 * The guard (see the header): installed once per window, it records every ⌘Z／⌘⇧Z as handled (something cancelled it)
 * or unhandled (it cancels it itself). It reads the key after the draft's own listener on the textarea, or after the
 * canvas's on the canvas (both stop the key there), or on the window for a key elsewhere. A key that never reaches that
 * listener (stopped earlier) stays `handled: null`, which no row accepts.
 */
const installGuard = () => evaluate(`
  if (!window.__mappyE2EUndoGuard) {
    window.__mappyE2EUndoGuard = { log: [] };
    window.addEventListener('keydown', event => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
      const guard = window.__mappyE2EUndoGuard;
      // A listener left by an earlier key that something stopped before it (review 1): it must not read this one.
      guard.drop?.();
      // Listeners added now run after the ones already on that element, whatever stops the key going further up.
      const target = event.target;
      const last = target instanceof HTMLTextAreaElement ? target : target?.closest?.('.mappy-canvas') ?? window;
      const entry = { handled: null, shift: event.shiftKey, target: target?.tagName ?? null };
      guard.log.push(entry);
      const settle = seen => {
        if (seen !== event) return;
        guard.drop();
        entry.handled = event.defaultPrevented;
        if (!entry.handled) event.preventDefault();
      };
      guard.drop = () => { last.removeEventListener('keydown', settle); guard.drop = null; };
      last.addEventListener('keydown', settle);
    }, true);
  }
  window.__mappyE2EUndoGuard.log = [];
  return true;`);

const guardLog = () => evaluate('return window.__mappyE2EUndoGuard.log.splice(0);');

/** What the map shows now: the draft (its value), where the keyboard is, its messages and the note. */
const look = () => evaluate(`${VIEW}
  const active = document.activeElement;
  return { draft: input()?.value ?? null, selected: nodes().filter(node => node.classList.contains('is-selected')).map(label), inCanvas: !!active && !!el.querySelector('.mappy-canvas')?.contains(active), messages: messages(), source: await source() };`);

/** The note once it is `expected` and the map has re-read it (or as it is after `timeout`, for the check to compare). */
const settled = async (expected, timeout = 3000) => {
  try {
    await until(async () => {
      const now = await evaluate(`${VIEW} const text = await source(); return text === ${JSON.stringify(expected)} && view.document?.source === text;`);
      return now || null;
    }, timeout, 'the note');
  } catch { /* the caller's comparison reports what it is */ }
  await wait(300);
  return look();
};

/** ⌘Z (or ⌘⇧Z) as the keyboard sends it, and what the guard saw of it. */
const press = async (shift = false) => {
  await cdp.realKey('z', shift ? 12 : 4);
  await wait(150);
  return guardLog();
};

/** The view's selection, folds and viewport: what Escape's take-back puts back, and so ⌘Z's (LEV-331). */
const shown = () => evaluate(`${VIEW}
  return { selected: nodes().filter(node => node.classList.contains('is-selected')).map(label), folded: nodes().filter(node => node.classList.contains('is-collapsed')).map(label), viewport: view.getState().viewport };`);

/**
 * Opens the shape's note afresh in `layout` and adds its node; the draft is then open on the provisional name. With
 * `fold`, the target is folded first (Space), so the addition opens it. Answers what the map showed just before the key.
 */
async function add(shape, layout, { fold = false } = {}) {
  await detachMaps();
  // A new file each row: the map's history is kept per note while the note reads as the map left it, and a step left to
  // redo by an earlier row would come back with Escape's take-back (it gives back the Redo steps the addition dropped).
  await makeDeleteNote(evaluate, shape.note)();
  await makeOpenStep(evaluate, { note: shape.note, source: shape.source, layout })();
  await installGuard();
  await markSeen();
  let before;
  if (shape.key) {
    await select(shape.target);
    if (fold) { await cdp.realKey(' ', 0, ' '); await wait(500); await select(shape.target); }
    before = await shown();
    await cdp.realKey(shape.key, 0, shape.key === 'Enter' ? '\r' : undefined);
  } else {
    // The empty canvas near its top-left corner, away from the fixture's nodes (as E43's double click).
    const point = await evaluate(`${VIEW} const rect = el.querySelector('.mappy-canvas').getBoundingClientRect(); return { x: rect.left + 40, y: rect.top + 40 };`);
    // The double click's first click clears the selection: nothing is selected when the topic is added.
    before = { ...await shown(), selected: [] };
    for (const clickCount of [1, 2]) {
      for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount });
    }
  }
  const opened = await settled(shape.written);
  if (opened.source !== shape.written || opened.draft !== shape.name) {
    throw new Error(`the addition left ${JSON.stringify(opened)}, not the draft 「${shape.name}」 on ${JSON.stringify(shape.written)}`);
  }
  return before;
}

const cleanList = makeDeleteNote(evaluate, LIST_NOTE);
const cleanHeadings = makeDeleteNote(evaluate, HEADINGS_NOTE);
let exitCode = 1;
try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));

  for (const layout of LAYOUTS) {
    // The report's rows: ⌘Z in the draft right after the addition takes the node back as Escape does (review 2 of
    // LEV-331): the note as before the addition, nothing left to redo, and the selection, folds and viewport as before.
    // `fold`: the target folded first, so the addition opens it and the take-back closes it again.
    for (const shape of [...SHAPES, { ...SHAPES[0], id: 'tab-subtopic-folded', target: '温泉旅行', fold: true, written: LIST.replace('  - 予約\n', `  - 予約\n  - ${SUB}\n`) }]) {
      const label = `${layout}/${shape.id}`;
      const result = await step(label, async () => {
        const before = await add(shape, layout, { fold: shape.fold });
        const undoKey = await press();
        const undone = await settled(shape.source);
        await wait(300);
        const after = await shown();
        const redoKey = await press(true);
        await wait(800);
        const redone = await look();
        return { before, undoKey, undone, after, redoKey, redone };
      });
      check(result?.undoKey?.[0]?.handled === true, `${label}: ⌘Z in the draft was not taken (${JSON.stringify(result?.undoKey)})`);
      check(result?.undone?.draft === null, `${label}: the draft is still open after ⌘Z (${JSON.stringify(result?.undone?.draft)})`);
      check(result?.undone?.source === shape.source, `${label}: ⌘Z left ${JSON.stringify(result?.undone?.source)}, not the note before the addition`);
      check(result?.undone?.inCanvas === true, `${label}: the keyboard is not on the map after ⌘Z`);
      check(JSON.stringify(result?.after?.selected) === JSON.stringify(result?.before?.selected), `${label}: ⌘Z selected ${JSON.stringify(result?.after?.selected)}, not ${JSON.stringify(result?.before?.selected)} as before the addition`);
      check(JSON.stringify(result?.after?.folded) === JSON.stringify(result?.before?.folded), `${label}: folded after ⌘Z ${JSON.stringify(result?.after?.folded)}, before ${JSON.stringify(result?.before?.folded)}`);
      check(JSON.stringify(result?.after?.viewport) === JSON.stringify(result?.before?.viewport), `${label}: viewport after ⌘Z ${JSON.stringify(result?.after?.viewport)}, before ${JSON.stringify(result?.before?.viewport)}`);
      if (shape.fold) check(result?.before?.folded?.includes(shape.target), `${label}: ${shape.target} was not folded before the addition (the row's premise)`);
      check(result?.redoKey?.[0]?.handled === true && result?.redone?.source === shape.source, `${label}: ⌘⇧Z after it brought something back (${JSON.stringify(result?.redoKey)}, ${JSON.stringify(result?.redone?.source)})`);
      check((result?.undone?.messages ?? []).length === 0 && (result?.redone?.messages ?? []).length === 0, `${label}: messages ${JSON.stringify([result?.undone?.messages, result?.redone?.messages])}`);
    }

    // Typed text is the textarea's to take back first; once it has, the next ⌘Z takes the node back.
    const typedLabel = `${layout}/typed-then-undo`;
    const typed = await step(typedLabel, async () => {
      const shape = SHAPES[0];
      await add(shape, layout);
      await cdp.insertText('水着');
      await wait(300);
      const firstKey = await press();
      const first = await look();
      // The textarea's own Undo, which the guard kept from the app menu.
      const restored = await evaluate(`${VIEW} document.execCommand('undo'); await new Promise(resolve => setTimeout(resolve, 200)); return input()?.value ?? null;`);
      const secondKey = await press();
      const second = await settled(shape.source);
      return { firstKey, first, restored, secondKey, second };
    });
    check(typed?.firstKey?.[0]?.handled === false, `${typedLabel}: ⌘Z with typed text was taken from the textarea (${JSON.stringify(typed?.firstKey)})`);
    check(typed?.first?.draft === '水着' && typed?.first?.source === SHAPES[0].written, `${typedLabel}: ⌘Z with typed text changed ${JSON.stringify(typed?.first)}`);
    check(typed?.restored === SUB, `${typedLabel}: the textarea's Undo left ${JSON.stringify(typed?.restored)}, not 「${SUB}」 (the row's premise)`);
    check(typed?.secondKey?.[0]?.handled === true && typed?.second?.draft === null && typed?.second?.source === LIST, `${typedLabel}: the next ⌘Z left ${JSON.stringify(typed?.second)} (${JSON.stringify(typed?.secondKey)})`);

    // A draft F2 opened on a node that was there is not an addition: ⌘Z stays the textarea's (review 1 of LEV-331).
    const f2Label = `${layout}/f2-untouched`;
    const f2 = await step(f2Label, async () => {
      await detachMaps();
      await makeDeleteNote(evaluate, LIST_NOTE)();
      await makeOpenStep(evaluate, { note: LIST_NOTE, source: LIST, layout })();
      await installGuard();
      await select('持ち物');
      await cdp.realKey('F2');
      await wait(400);
      const opened = await look();
      const key = await press();
      await wait(600);
      const after = await look();
      await cdp.realKey('Escape');
      await wait(300);
      return { opened, key, after };
    });
    check(f2?.opened?.draft === '持ち物', `${f2Label}: F2 opened ${JSON.stringify(f2?.opened?.draft)}`);
    check(f2?.key?.[0]?.handled === false, `${f2Label}: ⌘Z in an F2 draft was taken (${JSON.stringify(f2?.key)})`);
    check(f2?.after?.draft === '持ち物' && f2?.after?.source === LIST, `${f2Label}: ⌘Z changed ${JSON.stringify(f2?.after)}`);

    // Confirmed with Enter, the draft is closed and ⌘Z is the canvas's, as before the fix: untouched, one step takes the
    // node back; typed over, the first takes the name back to the provisional one and the second takes the node.
    for (const typedName of [null, '水着']) {
      const label = `${layout}/confirmed-${typedName ? 'typed' : 'untouched'}`;
      const result = await step(label, async () => {
        const shape = SHAPES[1];
        await add(shape, layout);
        if (typedName) { await cdp.insertText(typedName); await wait(300); }
        const named = typedName ? shape.written.replace(`- ${MAIN}\n`, `- ${typedName}\n`) : shape.written;
        await cdp.realKey('Enter', 0, '\r');
        const confirmed = await settled(named);
        const keys = [await press()];
        const steps = [await settled(typedName ? shape.written : shape.source)];
        if (typedName) { keys.push(await press()); steps.push(await settled(shape.source)); }
        return { named, confirmed, keys, steps };
      });
      check(result?.confirmed?.draft === null && result?.confirmed?.source === result?.named, `${label}: Enter left ${JSON.stringify(result?.confirmed)}`);
      check((result?.keys ?? []).every(key => key?.[0]?.handled === true), `${label}: a ⌘Z was not taken (${JSON.stringify(result?.keys)})`);
      check(result?.steps?.at(-1)?.source === LIST, `${label}: ⌘Z left ${JSON.stringify(result?.steps?.map(item => item?.source))}`);
      if (typedName) check(result?.steps?.[0]?.source === SHAPES[1].written, `${label}: the first ⌘Z left ${JSON.stringify(result?.steps?.[0]?.source)}, not the provisional name`);
    }
  }
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`unexpected: ${error}`);
} finally {
  if (!cdp.closed) {
    await detachMaps().catch(() => null);
    if (!flag('--keep')) { await step('clean', cleanList); await step('clean-headings', cleanHeadings); }
  }
  exitCode = await finish(record, value('--json'));
  cdp.close();
}
process.exit(exitCode);
