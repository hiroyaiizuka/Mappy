/**
 * E65 (docs/harness.md): a map embedded in another note keeps the reader's folds after a write of the store was taken
 * back before the embed re-read it, on the real Obsidian (LEV-224, the embed's side of LEV-218).
 *
 * The embed records the store's writes (`WriteRecord`, LEV-217) so its re-read carries the ids of a node whose title
 * repeats or is empty. Before LEV-224, a re-read that found the text on screen kept every write recorded: when the
 * note was put back (Undo in the Markdown pane, a sync) before the embed's re-read (its 45 ms debounce), the write
 * taken back stayed at the end of the record, the next write — made on the text on screen — could not follow it and
 * was not recorded, and its re-read matched nodes by title: with the twin before it renamed, the node the reader
 * opened took the twin's id and closed again.
 *
 * Rows: 空題名 (the second untitled node) ・同名 (the second of two). The note is open as a map in one pane and
 * embedded in the reading view of another note in a split below (E55's set-up). The reader opens 親 (so 子1 is on
 * screen) and the row's node with real clicks. Then, in one script so it lands inside the embed's debounce: the map
 * tab's store renames 子1 (`applyLatest`, the write every map of the note hears), and the Vault puts the note back
 * (`vault.modify`, not through the store, as a sync does). A person cannot undo within 45 ms, so the put-back is done
 * by the script; the premise — the embed never drew the rename — is checked by an observer on the embed. Then F2 in
 * the map tab renames the twin before the row's node (a real key, the tab's own write), and the embed's node keeps its
 * id and its fold. The write made while the embed's re-read of the put-back note reads (the second half of the fix)
 * needs a read held open, and is left to the jsdom rows (`tests/ui/map-embed-own-writes.test.ts`).
 *
 * Usage (see docs/harness.md 実機検証 for the Obsidian instance):
 *   npm run harness:e2e:embed-record-takeback -- [--reload] [--json <out.json>] [--keep] [--only <row name prefix>]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep, makeOpenStep, makeRename, refuseOpenLeaves } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-embed-record-takeback.md';
const HOST = 'Fixtures/E2E-embed-record-takeback-host.md';
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
const HOST_SOURCE = '埋め込みの上\n\n![[E2E-embed-record-takeback]]\n\n埋め込みの下\n';
const TAKEN_BACK = '取り消される改名';
const TWIN = '命名';

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

const SHAPES = [
  { name: '空題名', label: '空のノード' },
  { name: '同名', label: '同名' },
];

const detach = `for (const key of ['__mappyE2EHost', '__mappyE2E']) { window[key]?.detach(); delete window[key]; }
  window.__mappyE2EDrawn?.disconnect(); delete window.__mappyE2EDrawn;`;

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
    // The host pane is the lower half: the lower nodes of the embed can be below what it shows.
    target.scrollIntoView({ block: 'center', inline: 'center' });
    await new Promise(resolve => setTimeout(resolve, 300));
    const rect = target.getBoundingClientRect();
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!target.contains(top)) throw new Error('something else is on top: ' + (top?.className ?? 'nothing'));
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
};

const toggle = (title, index) => clickAt(`return embedNth(${JSON.stringify(title)}, ${index})?.querySelector('.mappy-node-toggle');`);

/** The embed's `index`-th node labelled `title`: its id and whether its branch is folded; and every label on the embed. */
const read = (title, index) => evaluate(`${EMBED}
  const node = embedNth(${JSON.stringify(title)}, ${index});
  return { id: node?.dataset.nodeId ?? null, folded: node?.classList.contains('is-collapsed') ?? null, labels: embedNodes().map(label) };`);

/** The embed's labels show `title`, then a moment more for its re-read to settle. */
const embedShows = async title => {
  const started = Date.now();
  for (;;) {
    const labels = await evaluate(`${EMBED} return embedNodes().map(label);`);
    if (labels.includes(title)) break;
    if (Date.now() - started > 3000) throw new Error(`the embed did not re-read the note: ${JSON.stringify(labels)}`);
    await wait(100);
  }
  await wait(400);
};

try {
  // Without the plugin every row would fail on something else (a restricted vault opens no map) and hide why.
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  for (const shape of SHAPES) {
    await step(shape.name, async () => {
      const opened = await reopen();
      check(opened.source === SOURCE, `${shape.name}: the note did not open as written`);
      await toggle('親', 0);
      await wait(400);
      const initial = await read(shape.label, 1);
      await toggle(shape.label, 1);
      await wait(400);
      const toggled = await read(shape.label, 1);
      if (toggled.id !== initial.id || toggled.folded !== false || initial.folded !== true || !toggled.labels.includes('子1')) {
        throw new Error(`the clicks did not open 親 and ${shape.name} in the embed: ${JSON.stringify({ initial, toggled })}`);
      }

      // The store's rename of 子1 and the Vault's put-back, inside the embed's 45 ms debounce; an observer on the embed
      // tells whether it ever drew the rename (were it to, the rename would be spent and the row prove nothing).
      const takeBack = await evaluate(`${EMBED}
        let drawn = false;
        const observer = new MutationObserver(() => { if (embedNodes().some(node => label(node) === ${JSON.stringify(TAKEN_BACK)})) drawn = true; });
        observer.observe(frame, { subtree: true, childList: true, characterData: true });
        window.__mappyE2EDrawn = observer;
        const file = view.file;
        const before = await app.vault.read(file);
        const at = before.indexOf('  - 子1\\n') + 4;
        const started = performance.now();
        await view.store.applyLatest(file, () => [{ from: at, to: at + 2, text: ${JSON.stringify(TAKEN_BACK)} }]);
        const written = await app.vault.read(file);
        await app.vault.modify(file, before);
        const putBack = performance.now() - started;
        await new Promise(resolve => setTimeout(resolve, 800));
        observer.disconnect();
        delete window.__mappyE2EDrawn;
        return { putBack, drawn, wrote: written.includes(${JSON.stringify(TAKEN_BACK)}), source: await app.vault.read(file), labels: embedNodes().map(label) };`);
      check(takeBack.wrote, `${shape.name}: the store did not write the rename`);
      check(takeBack.source === SOURCE, `${shape.name}: the note was not put back`);
      if (takeBack.drawn || takeBack.putBack >= 45) {
        throw new Error(`the premise did not hold: the embed drew the rename before the put-back (${JSON.stringify(takeBack)})`);
      }
      const back = await read(shape.label, 1);
      check(back.id === toggled.id && back.folded === false, `${shape.name}: the put-back itself moved the node (${JSON.stringify({ toggled, back })})`);

      // The twin before the row's node renamed in the map tab, with real keys.
      await select(shape.label, 0);
      const renamed = await rename(TWIN);
      await embedShows(TWIN);
      const state = await read(shape.label, 0);
      const expected = SOURCE.replace(shape.label === '同名' ? '- 同名\n' : '- \n', `- ${TWIN}\n`);
      check(renamed.messages.length === 0, `${shape.name}: showed ${JSON.stringify(renamed.messages)}`);
      check(renamed.source === expected, `${shape.name}:\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(renamed.source)}`);
      check(state.id === toggled.id, `${shape.name}: the embed's node id changed (${toggled.id} → ${state.id})`);
      check(state.folded === false, `${shape.name}: the branch the reader opened closed again`);
      return { toggled, takeBack: { putBack: Math.round(takeBack.putBack), drawn: takeBack.drawn }, after: { id: state.id, folded: state.folded } };
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
