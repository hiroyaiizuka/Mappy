/**
 * E66 (docs/harness.md): the map view keeps the fold of the second of two twins after a re-read reached part of its
 * record and the writes past it had been taken back, on the real Obsidian (LEV-237, the view's side of LEV-224).
 *
 * The view records the store's writes (`ownWrites`) so its re-read carries the ids of a node whose title repeats or is
 * empty. Before LEV-237, a re-read that found the text a write of the record wrote kept every write past it: when the
 * store renamed 子1 (A) and deleted the second twin (B) inside the view's debounce (45 ms) and B alone was put back
 * (Undo in the Markdown pane, a sync), the re-read spent A and B stayed in the record. The user's Delete on the first
 * twin then writes the same text as B, which the view took for B (`recordOwn` did not add a write whose texts were
 * already in the record), and showed it by B's edits: the survivor — the second twin, folded — got the first one's id
 * and unfolded. LEV-237 drops B at the re-read and tells writes apart by their edits too (`sameWrite`); either alone
 * keeps the fold, so the row also checks that the re-read left nothing of the record (the drop).
 *
 * Rows: 空題名 (two untitled twins) ・同名 (two twins titled 同名), each after its 対照 (A alone, nothing put back). The
 * note is open as a map in a tab; the second twin is folded with real clicks. Then, in one script so it lands inside
 * the view's debounce: the view's store renames 子1 and (not in 対照) deletes the second twin (`applyLatest`, the
 * writes every map of the note hears), and the Vault puts B back (`vault.modify` to A's text, not through the store, as
 * a sync does). A person cannot do that within 45 ms, so the script does; the premise — the view recorded both writes
 * and never drew B, and its re-read replayed A alone out of that record — is checked (the record's length, the answers
 * of `replayOwnWrites` watched from the page, an observer on the view). Then a real click selects the first
 * twin and a real Delete deletes it (the view's own write), and the twin left keeps the folded one's id and its fold.
 * 対照 fails too if the Delete or the fold check itself is broken, so a FAIL of the put-back row alone is the stale write.
 *
 * Usage (see docs/harness.md 実機検証 for the Obsidian instance):
 *   npm run harness:e2e:view-reread-takeback -- [--reload] [--json <out.json>] [--keep] [--only <row name prefix>]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep, makeOpenStep, makePress, makeAfter, refuseOpenLeaves } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-view-reread-takeback.md';
const HEAD = ['---', 'mappy: true', '---', '## 履歴', '', '- 親', '  - 子1', ''].join('\n');
const RENAMED = '改名1';

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const run = makeStep(record);
const only = value('--only');
if (only) record.only = only;
/** The rows `--only` let through; none means the run checked nothing, and that is not a PASS. */
let rowsRun = 0;
const step = (name, body) => {
  if (only && name !== 'plugin' && name !== 'clean' && !name.startsWith(only)) return undefined;
  if (name !== 'plugin' && name !== 'clean') rowsRun += 1;
  return run(name, body);
};
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const press = makePress(cdp, evaluate);
const after = makeAfter(evaluate);

const SHAPES = [
  { name: '空題名', label: '空のノード', twin: '- \n  - 同じ子\n' },
  { name: '同名', label: '同名', twin: '- 同名\n  - 同じ子\n' },
];

/** The `index`-th node labelled `title`: its id and whether its branch is folded. */
const read = (title, index) => evaluate(`${VIEW}
  const node = nth(${JSON.stringify(title)}, ${index});
  return { id: node?.dataset.nodeId ?? null, folded: node?.classList.contains('is-collapsed') ?? null, count: nodes().filter(item => label(item) === ${JSON.stringify(title)}).length };`);

try {
  // Without the plugin every row would fail on something else (a restricted vault opens no map) and hide why.
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  for (const shape of SHAPES) for (const takesBack of [false, true]) {
    const row = takesBack ? shape.name : `${shape.name}-対照`;
    const source = HEAD + shape.twin + shape.twin;
    await step(row, async () => {
      await evaluate(`window.__mappyE2E?.detach(); delete window.__mappyE2E; return true;`);
      await wait(200);
      const opened = required(record, 'open', await makeOpenStep(evaluate, { note: NOTE, source })());
      check(opened.source === source, `${row}: the note did not open as written`);
      await wait(400);
      const initial = await read(shape.label, 1);
      await press(`const node = nth(${JSON.stringify(shape.label)}, 1)?.querySelector('.mappy-node-toggle');`);
      await wait(400);
      const folded = await read(shape.label, 1);
      if (folded.id !== initial.id || initial.folded !== false || folded.folded !== true || folded.count !== 2) {
        throw new Error(`the click did not fold the second ${shape.name}: ${JSON.stringify({ initial, folded })}`);
      }

      // A (子1 renamed) and, but for 対照, B (the second twin deleted) by the store, and B put back by the Vault: inside
      // the view's 45 ms debounce, timed from A's own modify event (what starts it). An observer on the view tells
      // whether it ever drew B (were it to, B would be spent and the row prove nothing).
      const writes = await evaluate(`${VIEW}
        const twins = () => nodes().filter(node => label(node) === ${JSON.stringify(shape.label)}).length;
        let drawn = false;
        const observer = new MutationObserver(() => { if (twins() < 2) drawn = true; });
        const file = view.file;
        let heard = null;
        const listener = app.vault.on('modify', changed => { if (changed === file && heard === null) heard = performance.now(); });
        // What the view's replays of its record answer (\`replayOwnWrites\`, watched from the page, not changed): the
        // re-read of the note must reach A and no further, out of a record of 2 (of 1 in 対照): the path of LEV-237.
        const replay = view.replayOwnWrites;
        const replays = [];
        view.replayOwnWrites = function (text, ...rest) {
          const result = replay.call(this, text, ...rest);
          replays.push({ recorded: this.ownWrites.length, used: result?.used ?? null, text });
          return result;
        };
        try {
          observer.observe(el, { subtree: true, childList: true, characterData: true });
          const text = await app.vault.read(file);
          const child = text.indexOf('  - 子1\\n') + 4;
          const reached = (await view.store.applyLatest(file, () => [{ from: child, to: child + 2, text: ${JSON.stringify(RENAMED)} }])).after;
          let recorded = view.ownWrites.length;
          let putBack = null;
          if (${takesBack}) {
            await view.store.applyLatest(file, current => {
              const first = current.indexOf(${JSON.stringify(shape.twin)});
              const from = current.indexOf(${JSON.stringify(shape.twin)}, first + ${shape.twin.length});
              return [{ from, to: from + ${shape.twin.length}, text: '' }];
            });
            recorded = view.ownWrites.length;
            await app.vault.modify(file, reached);
            putBack = heard === null ? Infinity : performance.now() - heard;
          }
          await new Promise(resolve => setTimeout(resolve, 800));
          const reachedA = replays.some(item => item.text === reached && item.used === 1 && item.recorded === recorded);
          return { reached, recorded, putBack, drawn, reachedA, left: view.ownWrites.length, source: await app.vault.read(file), shown: view.document?.source === reached };
        } finally {
          delete view.replayOwnWrites;
          app.vault.offref(listener);
          observer.disconnect();
        }`);
      check(writes.reached === source.replace('  - 子1\n', `  - ${RENAMED}\n`), `${row}: the store did not rename 子1`);
      check(writes.source === writes.reached && writes.shown, `${row}: the view does not show the renamed note (${JSON.stringify({ source: writes.source, shown: writes.shown })})`);
      if (writes.recorded !== (takesBack ? 2 : 1) || !writes.reachedA || writes.drawn || (takesBack && writes.putBack >= 45)) {
        throw new Error(`the premise did not hold: ${JSON.stringify(writes)}`);
      }
      // The re-read left nothing of the record: A spent, B (recorded before it began, put back) dropped (LEV-237's drop;
      // the Delete below holds on `sameWrite` alone, so without this the row would not see the drop go).
      check(writes.left === 0, `${row}: the record still holds ${writes.left} write(s) after the re-read`);
      const back = await read(shape.label, 1);
      check(back.id === folded.id && back.folded === true && back.count === 2, `${row}: the re-read itself moved the node (${JSON.stringify({ folded, back })})`);

      // The first twin deleted with a real click and a real Delete: the view's own write, of B's text in the put-back row.
      await select(shape.label, 0);
      await cdp.realKey('Delete');
      const deleted = await after(writes.reached);
      const expected = writes.reached.replace(shape.twin, '');
      const state = await read(shape.label, 0);
      check(deleted.messages.length === 0, `${row}: showed ${JSON.stringify(deleted.messages)}`);
      check(deleted.source === expected, `${row}:\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(deleted.source)}`);
      check(state.count === 1, `${row}: ${state.count} twins left`);
      check(state.id === folded.id, `${row}: the twin left changed its id (${folded.id} → ${state.id})`);
      check(state.folded === true, `${row}: the twin left unfolded`);
      return { folded, writes: { recorded: writes.recorded, reachedA: writes.reachedA, left: writes.left, putBack: writes.putBack === null ? null : Math.round(writes.putBack), drawn: writes.drawn }, after: state };
    });
  }

  check(rowsRun > 0, `no row ran${only ? ` (--only ${only} matches none of ${SHAPES.map(shape => shape.name).join('・')})` : ''}`);

  if (!flag('--keep')) {
    await step('clean', () => evaluate(`
      window.__mappyE2E?.detach(); delete window.__mappyE2E;
      ${refuseOpenLeaves([NOTE])}
      const removed = [];
      const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
      if (file) { await app.vault.delete(file, true); removed.push(${JSON.stringify(NOTE)}); }
      delete window.__mappyE2EBefore;
      return { removed };`));
  }
} catch (error) {
  if (!(error instanceof StopCase)) throw error;
} finally {
  cdp.close();
}

process.exit(await finish(record, value('--json')));
