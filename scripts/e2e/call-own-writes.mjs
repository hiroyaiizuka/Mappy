/**
 * E67 (docs/harness.md): a map called from an item of another map (§5 M12) keeps the reader's folds through the writes
 * of the called note's own map tab on the real Obsidian (LEV-221, after LEV-217).
 *
 * The calling map names what is folded by node id (`calledNodeId`: the item's id and the called node's), and a called
 * node whose title repeats or is empty has nothing but the edits of the write to carry its id over the read (LEV-146).
 * Before LEV-221 the calling map's `CallReader` did not hear the store's writes (`DocumentStore.onWrite`), so its read
 * after an edit, a layout button, ⌘Z or ⌘⇧Z in the called tab matched by title, and such a node came back with a new
 * id. Every called branch starts folded and a node with a new id is folded as new, so the branch the reader opened
 * closed again.
 *
 * Rows: 通常 (親, one title) ・空題名 (the second untitled node) ・同名 (the second of two) ・トピック (枝, under an item
 * that calls the note's free topic `#トピック`). The note is open as a map in one pane; the calling note, whose items are
 * `![[…]]` and `![[…#トピック]]`, is open as a map in a split below. In the calling map the reader opens 親 (so 子1 is on
 * screen) and the row's node with real clicks. In the called tab: F2 on 子1 to a longer title (every node after it
 * moves), the timeline button, ⌘Z (the button is not a step of its own, LEV-206: the rename comes back), ⌘⇧Z. After each,
 * the calling map's node keeps its id and its fold. The 通常 and トピック rows pass before the fix too: a title only one
 * node has is carried by the text either way.
 *
 * Two rows more, 空題名-戻し・同名-戻し, take a write back as the Markdown pane's Undo or a sync would (LEV-224): in one
 * script the called tab's store renames 子1 and the Vault puts the note back at once, inside the calling map's 45 ms
 * debounce (no hand is that fast), an observer on the calling map telling whether it ever drew the rename (the
 * premise). Then F2 in the called tab renames the twin before the row's node. The matrix rows of the same shapes fail
 * when the calling map records nothing, so a FAIL of a 戻し row alone is the stale record.
 *
 * Usage (see docs/harness.md 実機検証 for the Obsidian instance):
 *   npm run harness:e2e:call-own-writes -- [--reload] [--json <out.json>] [--keep] [--only <row name prefix>]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep, makeOpenStep, makeRename, makeAfter, refuseOpenLeaves } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-call-own-writes.md';
const HOST = 'Fixtures/E2E-call-own-writes-host.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 履歴', '',
  '- 親', '  - 子1', '  - 子2',
  '- ', '  - 空の子',
  '- ', '  - 空の子2',
  '- 同名', '  - 同名の子A',
  '- 同名', '  - 同名の子B',
  '', '## トピック', '',
  '- 枝', '  - 枝の子', '',
].join('\n');
const HOST_SOURCE = '---\nmappy: true\n---\n## 呼び出し元\n- ![[E2E-call-own-writes]]\n- ![[E2E-call-own-writes#トピック]]\n';
const TAKEN_BACK = '取り消される改名';
const TWIN = '命名';

/** VIEW (the called tab), plus the calling map in the pane below (`window.__mappyE2EHost`): its nodes and its reads. */
const HOSTED = `${VIEW}
  const hostView = window.__mappyE2EHost?.view;
  const hostEl = hostView?.contentEl;
  if (!hostEl?.querySelector('.mappy-canvas')) throw new Error('the pane below shows no map');
  const hostNodes = () => Array.from(hostEl.querySelectorAll('.mappy-node'));
  const hostNth = (title, index) => hostNodes().filter(node => label(node) === title)[index];
  // The called notes' texts the calling map last drew (its private record of the calls; read, never changed).
  const drawn = () => Array.from(hostView.targets?.values() ?? [], target => target.document.source);`;

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const run = makeStep(record);
/** A row, unless `--only` names the rows to run by the start of their name (a partial run is recorded as such). */
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
const rename = makeRename(cdp, evaluate);
const after = makeAfter(evaluate);

const SHAPES = [
  { name: '通常', label: '親', index: 0 },
  { name: '空題名', label: '空のノード', index: 1 },
  { name: '同名', label: '同名', index: 1 },
  { name: 'トピック', label: '枝', index: 0 },
];

const detach = `for (const key of ['__mappyE2EHost', '__mappyE2E']) { window[key]?.detach(); delete window[key]; }
  window.__mappyE2EDrawn?.disconnect(); delete window.__mappyE2EDrawn;`;

/** The calling map has read the called note as it is now: every call drew the note's current text. */
const hostCaughtUp = async () => {
  const started = Date.now();
  for (;;) {
    const state = await evaluate(`${HOSTED} const text = await source(); const texts = drawn(); return { ok: texts.length === 2 && texts.every(t => t === text), count: texts.length };`).catch(error => ({ ok: false, error: String(error) }));
    if (state.ok) break;
    if (Date.now() - started > 5000) throw new Error(`the calling map did not read the called note again: ${JSON.stringify(state)}`);
    await wait(100);
  }
  await wait(400);
};

/** A real mouse click at the centre of what `locate` (a script returning an element, after HOSTED) finds. */
const clickAt = async locate => {
  const box = await evaluate(`${HOSTED}
    const target = (() => { ${locate} })();
    if (!target) throw new Error('nothing to click');
    const rect = target.getBoundingClientRect();
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!target.contains(top)) throw new Error('something else is on top: ' + (top?.className?.baseVal ?? top?.className ?? 'nothing'));
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
};

/** 全体表示 in the calling map (a real click, by the button's name), so its lower nodes are in the pane. */
const fitHost = async () => {
  await clickAt(`return hostEl.querySelector('.mappy-button[aria-label="全体表示"]');`);
  await wait(600);
};

/** The note as a map in a tab, and the calling note as a map in a split below it (a real click reaches both). */
const reopen = async () => {
  await evaluate(`${detach} return true;`);
  await wait(200);
  const opened = required(record, 'open', await makeOpenStep(evaluate, { note: NOTE, source: SOURCE })());
  await evaluate(`
    ${refuseOpenLeaves([HOST])}
    const existing = app.vault.getAbstractFileByPath(${JSON.stringify(HOST)});
    if (existing) await app.vault.modify(existing, ${JSON.stringify(HOST_SOURCE)});
    else await app.vault.create(${JSON.stringify(HOST)}, ${JSON.stringify(HOST_SOURCE)});
    await new Promise(resolve => setTimeout(resolve, 400));
    const host = app.workspace.createLeafBySplit(window.__mappyE2E, 'horizontal');
    await host.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(HOST)}, layout: 'mindmap' }, active: false });
    window.__mappyE2EHost = host;
    return true;`);
  await hostCaughtUp();
  await fitHost();
  return opened;
};

const toggle = async (title, index) => {
  await clickAt(`return hostNth(${JSON.stringify(title)}, ${index})?.querySelector('.mappy-node-toggle');`);
  await wait(400);
  await fitHost();
};

/** The calling map's `index`-th node labelled `title`: its id and whether its branch is folded; and every label on it. */
const read = (title, index) => evaluate(`${HOSTED}
  const node = hostNth(${JSON.stringify(title)}, ${index});
  return { id: node?.dataset.nodeId ?? null, folded: node?.classList.contains('is-collapsed') ?? null, labels: hostNodes().map(label) };`);

/** 親 and then the row's node opened (or, already open, folded) by the reader with real clicks; what they see then. */
const openRow = async shape => {
  if (shape.name !== '通常') await toggle('親', 0);
  const initial = await read(shape.label, shape.index);
  await toggle(shape.label, shape.index);
  const toggled = await read(shape.label, shape.index);
  if (toggled.id === null || toggled.id !== initial.id || toggled.folded === initial.folded || !toggled.labels.includes('子1')) {
    throw new Error(`the clicks did not open 親 and toggle ${shape.name} in the calling map: ${JSON.stringify({ initial, toggled })}`);
  }
  return toggled;
};

/** ⌘Z or ⌘⇧Z with the focus in the called tab's canvas; refused when it is not (docs/harness.md). */
const history = async direction => {
  const state = await evaluate(`${VIEW} return { focused: el.querySelector('.mappy-canvas').contains(document.activeElement), editing: !!input(), source: await source() };`);
  if (!state.focused || state.editing) throw new Error(`${direction}: the focus is not on the map (${JSON.stringify(state)}); not sending the chord`);
  await cdp.realKey('z', direction === 'redo' ? 12 : 4);
  return after(state.source);
};

/** 全体表示 in the called tab, so the node about to be selected is in its pane. */
const fitCalled = async () => {
  await clickAt(`return el.querySelector('.mappy-button[aria-label="全体表示"]');`);
  await wait(600);
};

try {
  // Without the plugin every row would fail on something else (a restricted vault opens no map) and hide why.
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  const withTimeline = text => text.replace('mappy: true\n', 'mappy: true\nmappy-layout: timeline\n');
  const LONG = 'ずっと長い題名に改名';
  for (const shape of SHAPES) {
    await step(shape.name, async () => {
      const opened = await reopen();
      check(opened.source === SOURCE, `${shape.name}: the note did not open as written`);
      const edited = SOURCE.replace('  - 子1\n', `  - ${LONG}\n`);
      const toggled = await openRow(shape);
      const rows = [{ label: 'toggled', ...toggled }];
      const expectAt = async (label, result, expected) => {
        await hostCaughtUp();
        const state = await read(shape.label, shape.index);
        rows.push({ label, id: state.id, folded: state.folded, messages: result.messages });
        const row = `${shape.name} ${label}`;
        check(result.messages.length === 0, `${row}: showed ${JSON.stringify(result.messages)}`);
        check(result.source === expected, `${row}:\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(result.source)}`);
        check(state.id === toggled.id, `${row}: the calling map's node id changed (${toggled.id} → ${state.id})`);
        check(state.folded === toggled.folded, `${row}: the calling map's fold changed (${toggled.folded} → ${state.folded})`);
      };

      await fitCalled();
      await select('子1');
      await expectAt('改名', await rename(LONG), edited);

      // A real click, by the button's name (src/core/layout-mode.ts layoutLabel()), as the user presses it.
      await clickAt(`return el.querySelector('.mappy-modes button[aria-label="タイムライン"]');`);
      await expectAt('ボタン', await after(edited), withTimeline(edited));

      // A node of the map the rows do not look at, so ⌘Z goes to it with the focus in its canvas.
      await fitCalled();
      await select('子2');
      await expectAt('⌘Z', await history('undo'), withTimeline(SOURCE));
      await expectAt('⌘⇧Z', await history('redo'), withTimeline(edited));
      return { rows };
    });
  }

  for (const shape of SHAPES.filter(candidate => candidate.name === '空題名' || candidate.name === '同名')) {
    const row = `${shape.name}-戻し`;
    await step(row, async () => {
      const opened = await reopen();
      check(opened.source === SOURCE, `${row}: the note did not open as written`);
      const toggled = await openRow(shape);
      // The store's rename of 子1 and the Vault's put-back, inside the calling map's 45 ms debounce; an observer on the
      // calling map tells whether it ever drew the rename (were it to, the rename would be spent and the row prove nothing).
      const takeBack = await evaluate(`${HOSTED}
        let seen = false;
        const observer = new MutationObserver(() => { if (hostNodes().some(node => label(node) === ${JSON.stringify(TAKEN_BACK)})) seen = true; });
        observer.observe(hostEl, { subtree: true, childList: true, characterData: true });
        window.__mappyE2EDrawn = observer;
        const file = view.file;
        const before = await app.vault.read(file);
        const at = before.indexOf('  - 子1\\n') + 4;
        let heard = null;
        const listener = app.vault.on('modify', changed => { if (changed === file && heard === null) heard = performance.now(); });
        await view.store.applyLatest(file, () => [{ from: at, to: at + 2, text: ${JSON.stringify(TAKEN_BACK)} }]);
        const written = await app.vault.read(file);
        await app.vault.modify(file, before);
        const putBack = heard === null ? null : performance.now() - heard;
        app.vault.offref(listener);
        await new Promise(resolve => setTimeout(resolve, 800));
        observer.disconnect();
        delete window.__mappyE2EDrawn;
        return { putBack, drawn: seen, wrote: written.includes(${JSON.stringify(TAKEN_BACK)}), source: await app.vault.read(file) };`);
      check(takeBack.wrote, `${row}: the store did not write the rename`);
      check(takeBack.source === SOURCE, `${row}: the note was not put back`);
      if (takeBack.drawn) throw new Error(`the premise did not hold: the calling map drew the rename before the put-back (${JSON.stringify(takeBack)})`);
      await hostCaughtUp();
      const back = await read(shape.label, shape.index);
      check(back.id === toggled.id && back.folded === toggled.folded, `${row}: the put-back itself moved the node (${JSON.stringify({ toggled, back })})`);

      // The twin before the row's node renamed in the called tab, with real keys.
      await fitCalled();
      await select(shape.label, 0);
      const renamed = await rename(TWIN);
      await hostCaughtUp();
      const state = await read(shape.label, 0);
      const expected = SOURCE.replace(shape.label === '同名' ? '- 同名\n' : '- \n', `- ${TWIN}\n`);
      check(renamed.messages.length === 0, `${row}: showed ${JSON.stringify(renamed.messages)}`);
      check(renamed.source === expected, `${row}:\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(renamed.source)}`);
      check(state.id === toggled.id, `${row}: the calling map's node id changed (${toggled.id} → ${state.id})`);
      check(state.folded === toggled.folded, `${row}: the branch the reader opened closed again`);
      return { toggled, takeBack: { putBack: takeBack.putBack === null ? null : Math.round(takeBack.putBack), drawn: takeBack.drawn }, after: { id: state.id, folded: state.folded } };
    });
  }

  check(rowsRun > 0, `no row ran${only ? ` (--only ${only} matches none of the rows)` : ''}`);

  if (!flag('--keep')) {
    await step('clean', () => evaluate(`
      ${detach}
      ${refuseOpenLeaves([NOTE, HOST])}
      const removed = [];
      for (const path of ${JSON.stringify([HOST, NOTE])}) {
        const file = app.vault.getAbstractFileByPath(path);
        if (file) { await app.vault.delete(file, true); removed.push(path); }
      }
      delete window.__mappyE2EBefore;
      return { removed };`));
  }
} catch (error) {
  if (!(error instanceof StopCase)) throw error;
} finally {
  cdp.close();
}

process.exit(await finish(record, value('--json')));
