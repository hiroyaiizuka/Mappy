/**
 * E79 (docs/harness.md): a map called from an item of another map (§5 M12) keeps the reader's folds on the real
 * Obsidian when the calling item's own link is broken for a while in the Markdown pane and put back (LEV-260, after
 * LEV-246).
 *
 * The calling map names what is folded by node id (`calledNodeId`: the item's id and the called node's). Before LEV-260
 * the calling map let go of the called note's parse the moment no item called a map (`CallReader.clear`), and dropped
 * the folds of an item that no longer read `![[…]]` (the reader counted as waiting only the items that still did): the
 * link typed back parsed the note anew, every called node took a new id, and the branch the reader opened closed again.
 *
 * Rows: the operation × the calling note's shape × the shape of the called node the reader opened (通常 親 ・空題名 the
 * second untitled node ・同名 the second of two ・トピック 枝 under an item calling `#トピック`). Operations, each in the
 * buffer of a Markdown editor (source mode) open on the calling note beside its map: `]` (the closing `]` of the item's
 * link deleted, then typed again), Undo (the item's whole title deleted, then the editor's Undo), 別のマップ (the link
 * pointed at another map, then typed back). The calling note: 1項目 (one item, calling the part the shape is in) or
 * 2項目 (`- ![[E2E-call-retype]]` and `- ![[E2E-call-retype#トピック]]`, the item the shape is under broken). The
 * reader opens 親 and the row's node with real clicks; after the operation, the node keeps its id and stays open.
 *
 * Usage (see docs/harness.md 実機検証 for the Obsidian instance):
 *   npm run harness:e2e:call-retype -- [--reload] [--json <out.json>] [--keep] [--only <row name prefix>]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makePluginStep, refuseOpenLeaves, writeNote } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const FOLDER = 'Fixtures/E2E-call-retype';
const NAME = 'E2E-call-retype';
const NOTE = `${FOLDER}/${NAME}.md`;
const OTHER_NAME = `${NAME}-別`;
const OTHER = `${FOLDER}/${OTHER_NAME}.md`;
const HOST = 'Fixtures/E2E-call-retype-host.md';
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
const OTHER_SOURCE = ['---', 'mappy: true', '---', '## 別のマップ', '', '- 別の枝', '  - 別の子', ''].join('\n');
const hostSource = items => `---\nmappy: true\n---\n## 呼び出し元\n${items.map(item => `- ${item}\n`).join('')}`;

const record = createRecord(VAULT, HOST);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const run = makeStep(record);
const only = value('--only');
if (only) record.only = only;
let rowsRun = 0;
const step = (name, body) => {
  if (only && name !== 'plugin' && name !== 'clean' && !name.startsWith(only)) return undefined;
  if (name !== 'plugin' && name !== 'clean') rowsRun += 1;
  return run(name, body);
};
const check = makeCheck(record);

/** `link` is what the broken item calls: the part of the note the shape is drawn in. */
const SHAPES = [
  { name: '通常', label: '親', index: 0, link: NAME },
  { name: '空題名', label: '空のノード', index: 1, link: NAME },
  { name: '同名', label: '同名', index: 1, link: NAME },
  { name: 'トピック', label: '枝', index: 0, link: `${NAME}#トピック` },
];

/** The calling note's items, and how many of them call a map while the broken one does not. */
const HOSTS = [
  { name: '1項目', items: shape => [`![[${shape.link}]]`], others: 0 },
  { name: '2項目', items: () => [`![[${NAME}]]`, `![[${NAME}#トピック]]`], others: 1 },
];

/** VIEW (the calling map), plus the Markdown editor on the calling note. */
const HOSTED = `${VIEW}
  const editor = window.__mappyE2EEditor?.view.editor;`;

/** The Markdown leaf on the calling note and the calling map's leaf: both closed. */
const detach = `for (const key of ['__mappyE2EEditor', '__mappyE2E']) { window[key]?.detach(); delete window[key]; }`;

const removeAll = `
  for (const path of ${JSON.stringify([HOST, FOLDER])}) {
    const file = app.vault.getAbstractFileByPath(path);
    if (file) await app.vault.delete(file, true);
  }`;

/**
 * The calling map shows the editor's buffer, draws `calls` calls, and no read of it is pending; `calls` counts the items
 * drawn as a called map (the broken one is drawn as its text).
 */
const caughtUp = async calls => {
  const started = Date.now();
  let state;
  for (;;) {
    state = await evaluate(`${HOSTED}
      const idle = view.recallTimer === undefined && view.refreshTimer === undefined && view.refreshing === undefined;
      const shown = view.document?.source === editor.getValue();
      return { ok: idle && shown && view.targets.size === ${calls}, idle, shown, calls: view.targets.size };`)
      .catch(error => ({ ok: false, error: String(error) }));
    if (state.ok) break;
    if (Date.now() - started > 5000) throw new Error(`the calling map did not settle on ${calls} calls: ${JSON.stringify(state)}`);
    await wait(100);
  }
  await wait(400);
  return state;
};

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

const fit = async () => {
  await clickAt(`return el.querySelector('.mappy-button[aria-label="全体表示"]');`);
  await wait(600);
};

const toggle = async (title, index) => {
  await clickAt(`return nth(${JSON.stringify(title)}, ${index})?.querySelector('.mappy-node-toggle');`);
  await wait(400);
  await fit();
};

const read = (title, index) => evaluate(`${HOSTED}
  const node = nth(${JSON.stringify(title)}, ${index});
  return { id: node?.dataset.nodeId ?? null, folded: node?.classList.contains('is-collapsed') ?? null, labels: nodes().map(label) };`);

/** The node drawn under `id` (a redraw may change the order of the nodes): its label and whether it is folded. */
const readId = id => evaluate(`${HOSTED}
  const node = nodes().find(item => item.dataset.nodeId === ${JSON.stringify(id)});
  return { id: node?.dataset.nodeId ?? null, label: node ? label(node) : null, folded: node?.classList.contains('is-collapsed') ?? null };`);

/** The notes written fresh, the calling note open as a map, and a Markdown editor (source mode) on it in a split beside. */
const reopen = async items => {
  await evaluate(`${detach} return true;`);
  await wait(200);
  return evaluate(`
    ${refuseOpenLeaves([HOST, NOTE, OTHER])}
    ${removeAll}
    await app.vault.createFolder(${JSON.stringify(FOLDER)});
    { ${writeNote(NOTE, SOURCE)} }
    { ${writeNote(OTHER, OTHER_SOURCE)} }
    { ${writeNote(HOST, hostSource(items))} }
    const opened = app.workspace.getLeaf('tab');
    await opened.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(HOST)}, layout: 'mindmap' }, active: true });
    await new Promise(resolve => setTimeout(resolve, 1500));
    window.__mappyE2E = opened;
    // The map note's Markdown, as the map's source button opens it (the router would make a plain Markdown state a map).
    const editor = app.workspace.createLeafBySplit(opened, 'vertical');
    await app.plugins.plugins.mappy.router.openMarkdown(editor, app.vault.getAbstractFileByPath(${JSON.stringify(HOST)}), false);
    await editor.setViewState({ type: 'markdown', state: { ...editor.getViewState().state, mode: 'source', source: true }, active: false });
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (editor.view.getViewType() !== 'markdown' || editor.view.getMode?.() !== 'source') throw new Error('no Markdown editor on the calling note: ' + editor.view.getViewType());
    window.__mappyE2EEditor = editor;
    app.workspace.setActiveLeaf(opened, { focus: true });
    return true;`);
};

const openRow = async shape => {
  await fit();
  if (shape.name !== '通常' && shape.name !== 'トピック') await toggle('親', 0);
  const initial = await read(shape.label, shape.index);
  await toggle(shape.label, shape.index);
  const toggled = await read(shape.label, shape.index);
  if (toggled.id === null || toggled.id !== initial.id || initial.folded !== true || toggled.folded !== false) {
    throw new Error(`the clicks did not open ${shape.name} in the calling map: ${JSON.stringify({ initial, toggled })}`);
  }
  return { id: toggled.id, folded: toggled.folded };
};

/**
 * In the editor's buffer, the text `from`..`to` characters into the broken item's title replaced by `text`, as a key
 * press would (`replaceRange`, one transaction the editor's Undo takes back); the item is found by its `- ` line.
 */
const edit = (title, from, to, text) => evaluate(`${HOSTED}
  const value = editor.getValue();
  const at = value.indexOf('\\n- ' + ${JSON.stringify(title)} + '\\n');
  if (at < 0) throw new Error('no item ' + ${JSON.stringify(title)} + ' in the buffer');
  const start = at + 3;
  editor.replaceRange(${JSON.stringify(text)}, editor.offsetToPos(start + ${from}), editor.offsetToPos(start + ${to}));
  return editor.getValue();`);

const OPERATIONS = [
  {
    name: ']',
    run: async (title, host) => {
      const broken = await edit(title, title.length - 1, title.length, '');
      const between = await caughtUp(host.others);
      await edit(title.slice(0, -1), title.length - 1, title.length - 1, ']');
      return { broken: broken.includes(`- ${title.slice(0, -1)}\n`), between };
    },
  },
  {
    name: 'Undo',
    run: async (title, host) => {
      await edit(title, 0, title.length, '');
      const between = await caughtUp(host.others);
      const undone = await evaluate(`${HOSTED} editor.undo(); return editor.getValue();`);
      return { between, undone: undone.includes(`- ${title}\n`) };
    },
  },
  {
    name: '別のマップ',
    run: async (title, host) => {
      const other = `![[${OTHER_NAME}]]`;
      await edit(title, 0, title.length, other);
      const between = await caughtUp(host.others + 1);
      await edit(other, 0, other.length, title);
      return { between };
    },
  },
];

try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  for (const operation of OPERATIONS) {
    for (const host of HOSTS) {
      for (const shape of SHAPES) {
        const row = `${operation.name}-${host.name}-${shape.name}`;
        await step(row, async () => {
          const items = host.items(shape);
          await reopen(items);
          await caughtUp(items.length);
          const toggled = await openRow(shape);
          const title = `![[${shape.link}]]`;
          const done = await operation.run(title, host);
          await caughtUp(items.length);
          const state = await readId(toggled.id);
          const buffer = await evaluate(`${HOSTED} return editor.getValue();`);
          check(buffer === hostSource(items), `${row}: the buffer did not come back to the calling note: ${JSON.stringify(buffer)}`);
          check(state.id === toggled.id, `${row}: no node ${toggled.id} in the calling map after the link came back (a new id)`);
          check(state.label === shape.label, `${row}: node ${toggled.id} is ${JSON.stringify(state.label)}, not ${shape.label}`);
          check(state.folded === false, `${row}: the branch the reader opened closed again`);
          return { toggled, after: state, ...done };
        });
      }
    }
  }

  check(rowsRun > 0, `no row ran${only ? ` (--only ${only} matches none of the rows)` : ''}`);

  if (!flag('--keep')) {
    await step('clean', () => evaluate(`${detach} ${removeAll} return true;`));
  }
} catch (error) {
  if (!(error instanceof StopCase)) throw error;
} finally {
  cdp.close();
}

process.exit(await finish(record, value('--json')));
