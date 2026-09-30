/**
 * E78 (docs/harness.md): a map embedded in another note, and the note's map tab, keep the reader's folds and the ids
 * of a node the tab renames on a change neither of them has re-read yet, on the real Obsidian (LEV-238).
 *
 * The embed and the tab record the store's writes (`WriteRecord`, LEV-217, LEV-150) so a re-read carries the ids over
 * with their edits. Before LEV-238 a write was recorded only where the record led to its start: the text the reader
 * last parsed, or the end of the record. When someone changed the note (a sync, the Markdown pane) and the map wrote
 * on the change before the reader's re-read (its 45 ms debounce), the write was left out, and the re-read matched the
 * nodes by titles from the text on screen — where the renamed node's new title is not, and two changes are no single
 * title edit either: the node got a new id, and the branch the reader had folded or opened came back as new.
 *
 * Rows: 通常 (親, a list item) ・トピック (the topic heading), each after its 対照 (no change before the rename). The note
 * is open as a map in one pane and embedded in the reading view of another note in a split below (E55's set-up). The
 * reader toggles the row's node in the embed with a real click. Then, in one script so it lands inside the debounces:
 * the Vault changes the note in the other section (`vault.modify`, not through the store, as a sync does), and the map
 * tab's store renames the row's node on that change (`applyLatest`, the write every map of the note hears). A person
 * cannot rename within 45 ms of a sync, so the script does both; the premise — neither the embed nor the tab drew the
 * change before the rename — is checked by observers on both. The 対照 rows tell a build whose embed records nothing
 * (it fails there too) from one without LEV-238 (only the rows with the change fail). The read that finds the change
 * while the write lands needs a read held open, and is left to the jsdom rows (`tests/core/write-record.test.ts`).
 * Untitled and same-titled twins are not rows: titles cannot tell them apart, so a change the reader did not see
 * renumbers them whatever the write does (E05).
 *
 * Usage (see docs/harness.md 実機検証 for the Obsidian instance):
 *   npm run harness:e2e:embed-unread-write -- [--reload] [--json <out.json>] [--keep] [--only <row name prefix>]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makePluginStep, makeOpenStep, refuseOpenLeaves } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-embed-unread-write.md';
const HOST = 'Fixtures/E2E-embed-unread-write-host.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 履歴', '',
  '- 親', '  - 子1', '  - 子2',
  '- ', '  - 空の子',
  '- ', '  - 空の子2',
  '', '## トピック', '',
  '- 枝', '',
].join('\n');
const HOST_SOURCE = '埋め込みの上\n\n![[E2E-embed-unread-write]]\n\n埋め込みの下\n';
const RENAMED = '命名';
const CHANGED = '外から';

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

/**
 * Each row's node, where its title is written (`at`, `offset` into it), and a change in the other section, on a node the
 * embed shows before any click (a second-level one: deeper branches start folded, and a change the embed does not draw
 * would leave its observer blind — code review 1).
 */
const SHAPES = [
  { name: '通常', label: '親', at: '- 親\n', offset: 2, elsewhere: ['- 枝\n', `- ${CHANGED}\n`] },
  { name: 'トピック', label: 'トピック', at: '## トピック\n', offset: 3, elsewhere: ['- 親\n', `- ${CHANGED}\n`] },
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

/** The embed's and the tab's first node labelled `title`: ids, and whether the embed's branch is folded. */
const read = title => evaluate(`${EMBED}
  const node = embedNth(${JSON.stringify(title)}, 0);
  return { id: node?.dataset.nodeId ?? null, folded: node?.classList.contains('is-collapsed') ?? null,
    tab: nth(${JSON.stringify(title)}, 0)?.dataset.nodeId ?? null, labels: embedNodes().map(label) };`);

try {
  // Without the plugin every row would fail on something else (a restricted vault opens no map) and hide why.
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  // Each shape twice: 対照 without the change first. The page cannot see whether the embed recorded the store's write;
  // were it not to (its `onWrite` lost), the rename would be matched by titles and 対照 fails too, so a FAIL of the row
  // with the change alone is the write left out, not a record never kept.
  for (const shape of SHAPES) for (const changes of [false, true]) {
    const row = changes ? shape.name : `${shape.name}-対照`;
    await step(row, async () => {
      const opened = await reopen();
      check(opened.source === SOURCE, `${row}: the note did not open as written`);
      const initial = await read(shape.label);
      await clickAt(`return embedNth(${JSON.stringify(shape.label)}, 0)?.querySelector('.mappy-node-toggle');`);
      await wait(400);
      const toggled = await read(shape.label);
      if (!initial.id || toggled.id !== initial.id || toggled.folded === initial.folded || !toggled.tab) {
        throw new Error(`the click did not toggle ${shape.label} in the embed: ${JSON.stringify({ initial, toggled })}`);
      }

      // The change (for the row that has one) and the store's rename on it, inside the 45 ms debounces; observers on the
      // embed and the tab tell whether either drew the change before the rename (were it to, the row proves nothing).
      const landed = await evaluate(`${EMBED}
        const drew = { embed: false, tab: false };
        const changeOnly = labels => labels.includes(${JSON.stringify(CHANGED)}) && !labels.includes(${JSON.stringify(RENAMED)});
        const watch = (root, key, all) => {
          const observer = new MutationObserver(() => { if (changeOnly(all().map(label))) drew[key] = true; });
          observer.observe(root, { subtree: true, childList: true, characterData: true });
          return observer;
        };
        const observers = [watch(frame, 'embed', embedNodes), watch(el, 'tab', nodes)];
        const file = view.file;
        const before = await app.vault.read(file);
        let heard = null;
        const listener = app.vault.on('modify', changed => { if (changed === file && heard === null) heard = performance.now(); });
        ${changes ? `await app.vault.modify(file, before.replace(${JSON.stringify(shape.elsewhere[0])}, ${JSON.stringify(shape.elsewhere[1])}));` : ''}
        const unread = { tab: view.document?.source === before };
        await view.store.applyLatest(file, current => {
          const from = current.indexOf(${JSON.stringify(shape.at)}) + ${shape.offset};
          return [{ from, to: from + ${shape.label.length}, text: ${JSON.stringify(RENAMED)} }];
        });
        const wrote = heard === null ? Infinity : performance.now() - heard;
        app.vault.offref(listener);
        await new Promise(resolve => setTimeout(resolve, 1200));
        for (const observer of observers) observer.disconnect();
        return { wrote, drew, unread, source: await app.vault.read(file), messages: messages(),
          shows: { embed: embedNodes().map(label).includes(${JSON.stringify(CHANGED)}), tab: nodes().map(label).includes(${JSON.stringify(CHANGED)}) } };`);
      let expected = SOURCE.replace(shape.at, shape.at.slice(0, shape.offset) + RENAMED + shape.at.slice(shape.offset + shape.label.length));
      if (changes) {
        expected = expected.replace(shape.elsewhere[0], shape.elsewhere[1]);
        // Both views draw the change in the end: had either not, its observer could not have seen it drawn early.
        if (landed.drew.embed || landed.drew.tab || !landed.unread.tab || landed.wrote >= 45 || !landed.shows.embed || !landed.shows.tab) {
          throw new Error(`the premise did not hold: a re-read drew the change before the rename (${JSON.stringify(landed)})`);
        }
      }
      const state = await read(RENAMED);
      check(landed.messages.length === 0, `${row}: showed ${JSON.stringify(landed.messages)}`);
      check(landed.source === expected, `${row}:\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(landed.source)}`);
      check(state.id === toggled.id, `${row}: the embed's node id changed (${toggled.id} → ${state.id})`);
      check(state.folded === toggled.folded, `${row}: the branch the reader toggled came back as new (folded: ${state.folded})`);
      check(state.tab === toggled.tab, `${row}: the tab's node id changed (${toggled.tab} → ${state.tab})`);
      return { toggled, landed: { wrote: Math.round(landed.wrote), drew: landed.drew }, after: { id: state.id, folded: state.folded, tab: state.tab } };
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
