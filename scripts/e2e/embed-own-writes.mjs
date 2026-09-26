/**
 * E55 (docs/harness.md): a map embedded in another note keeps the reader's folds through the writes of the note's map
 * tab on the real Obsidian (LEV-217, after LEV-150).
 *
 * An embed names what is folded by node id, and a node whose title repeats or is empty has nothing but the edits of
 * the write to carry its id over the re-read (LEV-146). Before LEV-217 the embed did not hear the store's writes
 * (`DocumentStore.onWrite`), so its re-read after an edit, a layout button, ⌘Z or ⌘⇧Z in the map tab matched by title,
 * and such a node came back with a new id. Every branch below the first level starts folded in an embed and a node
 * with a new id is folded as new, so the branch the reader opened closed again.
 *
 * Rows: 通常 (親, one title) ・空題名 (the second untitled node) ・同名 (the second of two) ・トピック. The note is open
 * as a map in one pane and embedded (`![[…]]`) in the reading view of another note in a split below. In the embed
 * the reader opens 親 (so 子1 is on screen and the embed's re-read can be seen) and toggles the row's node with a real
 * click (the first three open, トピック starts open and folds). In the map tab: F2 on 子1 to a longer title (every
 * node after it moves), the timeline button, ⌘Z (the button is not a step of its own, LEV-206: the rename comes
 * back), ⌘⇧Z. After each, the embed's node keeps its id and its fold. The 通常 and トピック rows pass before the fix
 * too: a title only one node has is carried by the text either way.
 *
 * Usage (see docs/harness.md 実機検証 for the Obsidian instance):
 *   npm run harness:e2e:embed-own-writes -- [--reload] [--json <out.json>] [--keep] [--only <row name prefix>]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep, makeOpenStep, makeRename, makeAfter, refuseOpenLeaves } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-embed-own-writes.md';
const HOST = 'Fixtures/E2E-embed-own-writes-host.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 履歴', '',
  '- 親', '  - 子1', '  - 子2',
  '- ', '  - 空の子',
  '- ', '  - 空の子2',
  '- 同名', '  - 同名の子A',
  '- 同名', '  - 同名の子B',
  '', '## トピック', '',
  '- 枝', '',
].join('\n');
const HOST_SOURCE = '埋め込みの上\n\n![[E2E-embed-own-writes]]\n\n埋め込みの下\n';

/** VIEW, plus the embed in the host pane (`window.__mappyE2EHost`): its nodes, found and named as the map's are. */
const EMBED = `${VIEW}
  const frame = window.__mappyE2EHost?.view.containerEl.querySelector('.mappy-embed');
  if (!frame) throw new Error('the host pane shows no map embed');
  const embedNodes = () => Array.from(frame.querySelectorAll('.mappy-node'));
  const embedNth = (title, index) => embedNodes().filter(node => label(node) === title)[index];`;

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
  { name: 'トピック', label: 'トピック', index: 0 },
];

const detach = `for (const key of ['__mappyE2EHost', '__mappyE2E']) { window[key]?.detach(); delete window[key]; }`;

/** The note as a map in a tab, and the host note in reading view in a split below it (a real click reaches both). */
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
    await host.setViewState({ type: 'markdown', state: { file: ${JSON.stringify(HOST)}, mode: 'preview' }, active: false });
    window.__mappyE2EHost = host;
    return true;`);
  const started = Date.now();
  for (;;) {
    const shown = await evaluate(`${EMBED} return embedNodes().length;`).catch(() => 0);
    if (shown > 0) break;
    if (Date.now() - started > 5000) throw new Error('the embed never drew its map');
    await wait(100);
  }
  await wait(500);
  return opened;
};

/** A real mouse click at the centre of what `locate` (a script returning an element, after EMBED) finds. */
const clickAt = async locate => {
  const box = await evaluate(`${EMBED}
    const target = (() => { ${locate} })();
    if (!target) throw new Error('nothing to click');
    const rect = target.getBoundingClientRect();
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!target.contains(top)) throw new Error('something else is on top: ' + (top?.className ?? 'nothing'));
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
};

const toggle = shape => clickAt(`return embedNth(${JSON.stringify(shape.label)}, ${shape.index})?.querySelector('.mappy-node-toggle');`);

/** The embed's node for the row: its id and whether its branch is folded; and every label on the embed. */
const read = shape => evaluate(`${EMBED}
  const node = embedNth(${JSON.stringify(shape.label)}, ${shape.index});
  return { id: node?.dataset.nodeId ?? null, folded: node?.classList.contains('is-collapsed') ?? null, labels: embedNodes().map(label) };`);

/**
 * The embed after a write of the map tab: its labels show `label` (a title only the write's text has), or, for the
 * layout button, 親's place moved; then a moment more for its re-read to settle. The embed has no parse to poll, so
 * what it draws is the sign it has read the note.
 */
const embedShows = async ({ label, moved }) => {
  const started = Date.now();
  for (;;) {
    const state = await evaluate(`${EMBED} return { labels: embedNodes().map(label), at: embedNth('親', 0)?.style.transform ?? null };`);
    if (label ? state.labels.includes(label) : state.at !== moved) break;
    if (Date.now() - started > 3000) throw new Error(`the embed did not re-read the note: ${JSON.stringify(state)}`);
    await wait(100);
  }
  await wait(400);
};

/** ⌘Z or ⌘⇧Z with the focus in the map tab's canvas; refused when it is not (docs/harness.md). */
const history = async direction => {
  const state = await evaluate(`${VIEW} return { focused: el.querySelector('.mappy-canvas').contains(document.activeElement), editing: !!input(), source: await source() };`);
  if (!state.focused || state.editing) throw new Error(`${direction}: the focus is not on the map (${JSON.stringify(state)}); not sending the chord`);
  await cdp.realKey('z', direction === 'redo' ? 12 : 4);
  return after(state.source);
};

try {
  await step('plugin', makePluginStep(cdp, evaluate, flag));
  const withTimeline = text => text.replace('mappy: true\n', 'mappy: true\nmappy-layout: timeline\n');
  const LONG = 'ずっと長い題名に改名';
  for (const shape of SHAPES) {
    await step(shape.name, async () => {
      const opened = await reopen();
      const edited = opened.source.replace('  - 子1\n', `  - ${LONG}\n`);
      if (shape.name !== '通常') {
        await toggle(SHAPES[0]);
        await wait(400);
      }
      const initial = await read(shape);
      await toggle(shape);
      await wait(400);
      const toggled = await read(shape);
      if (toggled.id !== initial.id || toggled.folded === initial.folded || !toggled.labels.includes('子1')) {
        throw new Error(`the clicks did not open 親 and toggle ${shape.name} in the embed: ${JSON.stringify({ initial, toggled })}`);
      }
      const rows = [{ label: 'toggled', ...toggled }];
      const expectAt = async (label, result, expected) => {
        const state = await read(shape);
        rows.push({ label, id: state.id, folded: state.folded, source: result.source, messages: result.messages });
        const row = `${shape.name} ${label}`;
        check(result.messages.length === 0, `${row}: showed ${JSON.stringify(result.messages)}`);
        check(result.source === expected, `${row}:\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(result.source)}`);
        check(state.id === toggled.id, `${row}: the embed's node id changed (${toggled.id} → ${state.id})`);
        check(state.folded === toggled.folded, `${row}: the embed's fold changed (${toggled.folded} → ${state.folded})`);
      };

      await select('子1');
      const renamed = await rename(LONG);
      await embedShows({ label: LONG });
      await expectAt('改名', renamed, edited);

      const at = (await evaluate(`${EMBED} return embedNth('親', 0)?.style.transform ?? null;`));
      // A real click, by the button's name (src/core/layout-mode.ts LAYOUT_LABELS), as the user presses it.
      await clickAt(`return el.querySelector('.mappy-modes button[aria-label="タイムライン"]');`);
      const switched = await after(edited);
      await embedShows({ moved: at });
      await expectAt('ボタン', switched, withTimeline(edited));

      // A node of the map the rows do not look at, so ⌘Z goes to it with the focus in its canvas.
      await select('子2');
      const undone = await history('undo');
      await embedShows({ label: '子1' });
      await expectAt('⌘Z', undone, withTimeline(opened.source));

      const redone = await history('redo');
      await embedShows({ label: LONG });
      await expectAt('⌘⇧Z', redone, withTimeline(edited));
      return { rows };
    });
  }

  check(rowsRun > 0, `no row ran${only ? ` (--only ${only} matches none of ${SHAPES.map(shape => shape.name).join('・')})` : ''}`);

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
