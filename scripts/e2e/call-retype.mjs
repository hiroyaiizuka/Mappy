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
 * second untitled node ・同名 the second of two ・トピック 枝 under an item calling `#トピック`). Operations, in the
 * buffer of a Markdown editor (source mode) open on the calling note beside its map: `]` (the closing `]` of the item's
 * link deleted, then typed again), `!` (the `!` deleted, then typed again: a link for a while), Undo (the item's whole
 * title deleted, then the editor's Undo), 別名 (`|別名` typed into the link: the editor closes the brackets, so the item
 * calls the map throughout), 別のマップ (the link pointed at another map, then typed back), 見出し (the heading part
 * typed again: `#` added to a whole-note call, the last letter of `#トピック` deleted, then put back), 打ち直し (the
 * name deleted and typed back a letter at a time at a typist's pace, through `E2E-call` and `E2E-call-re`, two maps
 * whose names begin it); and on the map, F2 (the
 * item's `!` deleted with F2 → the title typed → Enter, then put back the same way: the map shows its own write before
 * it reads the calls again). The calling note: 1項目 (one item, calling the part the shape is in), 2項目 (`- ![[…]]` and
 * `- ![[…#トピック]]`, the item the shape is under broken: the note is still read for the other) or 2項目-別のノート
 * (the item the shape is under, and one calling another map). The reader opens 親 and the row's node with real clicks;
 * after the operation, the node keeps its id and stays open.
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
/** Maps whose names begin the called note's: the name typed back letter by letter reaches each on the way. */
const PREFIXES = ['E2E-call', 'E2E-call-re'].map(name => `${FOLDER}/${name}.md`);
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

/** The calling note's items, the broken one's title given (`title`), and how many others call a map meanwhile. */
const HOSTS = [
  { name: '1項目', items: (shape, title) => [title], others: 0 },
  {
    name: '2項目',
    items: (shape, title) => shape.link === NAME ? [title, `![[${NAME}#トピック]]`] : [`![[${NAME}]]`, title],
    others: 1,
  },
  { name: '2項目-別のノート', items: (shape, title) => [title, `![[${OTHER_NAME}]]`], others: 1 },
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

/** A real click on what `locate` finds, at its centre, or `edge` pixels in from its left edge (off the text it shows). */
const clickAt = async (locate, edge) => {
  const box = await evaluate(`${HOSTED}
    const target = (() => { ${locate} })();
    if (!target) throw new Error('nothing to click');
    const rect = target.getBoundingClientRect();
    const x = ${edge === undefined ? 'rect.left + rect.width / 2' : `rect.left + ${edge}`}; const y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    if (!target.contains(top)) throw new Error('something else is on top: ' + (top?.className?.baseVal ?? top?.className ?? 'nothing'));
    if (top.closest('a, .internal-link')) throw new Error('the click would follow a link');
    return { x, y };`);
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
    ${refuseOpenLeaves([HOST, NOTE, OTHER, ...PREFIXES])}
    ${removeAll}
    await app.vault.createFolder(${JSON.stringify(FOLDER)});
    { ${writeNote(NOTE, SOURCE)} }
    { ${writeNote(OTHER, OTHER_SOURCE)} }
    for (const path of ${JSON.stringify(PREFIXES)}) { ${writeNote('__PATH__', OTHER_SOURCE).replaceAll('"__PATH__"', 'path')} }
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
let brokenItem = 0;
const edit = (title, from, to, text) => evaluate(`${HOSTED}
  // By its place among the items (\`brokenItem\`), not its text: typed back, it passes through the other item's text.
  const lines = editor.getValue().split('\\n');
  const line = lines.indexOf('## 呼び出し元') + 1 + ${brokenItem};
  if (lines[line] !== '- ' + ${JSON.stringify(title)}) throw new Error('item ' + ${brokenItem} + ' is ' + JSON.stringify(lines[line]) + ', not ' + ${JSON.stringify(title)});
  const start = lines.slice(0, line).reduce((sum, text) => sum + text.length + 1, 0) + 2;
  editor.replaceRange(${JSON.stringify(text)}, editor.offsetToPos(start + ${from}), editor.offsetToPos(start + ${to}));
  return editor.getValue();`);

/** The calling item edited on the map: a real click on it, F2, the title typed over its own (IME-style commit), Enter. */
const retitleOnMap = async (id, title) => {
  // Near the left edge: a broken item shows its `[[…]]` as a link, and a click on it would open the called note here.
  await clickAt(`return nodes().find(node => node.dataset.nodeId === ${JSON.stringify(id)});`, 4);
  await wait(300);
  const selected = await evaluate(`${HOSTED} return { file: view.file?.path, selected: view.selectedId };`);
  if (selected.file !== HOST || selected.selected !== id) throw new Error('the click did not select the calling item: ' + JSON.stringify(selected));
  await cdp.realKey('F2');
  let editing = false;
  for (let tries = 0; tries < 20 && !editing; tries += 1) {
    editing = await evaluate(`${HOSTED} return input() !== null;`);
    if (!editing) await wait(100);
  }
  if (!editing) throw new Error('F2 did not open the inline editor on the calling item');
  await evaluate(`${HOSTED} input().select(); return true;`);
  await cdp.insertText(title);
  await wait(200);
  await cdp.realKey('Enter');
  await wait(300);
};

/** Each operation leaves the item with `final` as its title (its own again, or with an alias). */
const OPERATIONS = [
  {
    name: ']',
    run: async (title, count) => {
      await edit(title, title.length - 1, title.length, '');
      const between = await caughtUp(count.broken);
      await edit(title.slice(0, -1), title.length - 1, title.length - 1, ']');
      return { final: title, between };
    },
  },
  {
    name: '!',
    run: async (title, count) => {
      await edit(title, 0, 1, '');
      const between = await caughtUp(count.broken);
      await edit(title.slice(1), 0, 0, '!');
      return { final: title, between };
    },
  },
  {
    name: 'Undo',
    run: async (title, count) => {
      await edit(title, 0, title.length, '');
      const between = await caughtUp(count.broken);
      await evaluate(`${HOSTED} editor.undo(); return true;`);
      return { final: title, between };
    },
  },
  {
    name: '別名',
    run: async (title, count) => {
      await edit(title, title.length - 2, title.length - 2, '|');
      const between = await caughtUp(count.all);
      await edit(`${title.slice(0, -2)}|]]`, title.length - 1, title.length - 1, '別名');
      return { final: `${title.slice(0, -2)}|別名]]`, between };
    },
  },
  {
    name: '別のマップ',
    run: async (title, count) => {
      const other = `![[${OTHER_NAME}]]`;
      await edit(title, 0, title.length, other);
      const between = await caughtUp(count.all);
      await edit(other, 0, other.length, title);
      return { final: title, between };
    },
  },
  {
    name: '見出し',
    run: async (title, count) => {
      const inner = title.slice(3, -2);
      const broken = inner.includes('#') ? `![[${inner.slice(0, -1)}]]` : `![[${inner}#]]`;
      await edit(title, 0, title.length, broken);
      const between = await caughtUp(count.broken);
      await edit(broken, 0, broken.length, title);
      return { final: title, between };
    },
  },
  {
    name: '打ち直し',
    run: async (title, count) => {
      const inner = title.slice(3, -2);
      await edit(title, 3, 3 + inner.length, '');
      const between = await caughtUp(count.broken);
      // A letter at a time between the brackets the editor closed, at about 8 letters a second.
      for (let at = 0; at < inner.length; at += 1) {
        await edit(`![[${inner.slice(0, at)}]]`, 3 + at, 3 + at, inner[at]);
        await wait(120);
      }
      return { final: title, between };
    },
  },
  {
    name: 'F2',
    run: async (title, count, caller) => {
      // The `!`, not the `]`: with the caret inside an unclosed `[[…`, Enter picks the link suggestion (`LinkSuggest`).
      await retitleOnMap(caller, title.slice(1));
      const between = await caughtUp(count.broken);
      await retitleOnMap(caller, title);
      return { final: title, between };
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
          const title = `![[${shape.link}]]`;
          const items = host.items(shape, title);
          await reopen(items);
          await caughtUp(items.length);
          const toggled = await openRow(shape);
          brokenItem = items.indexOf(title);
          const done = await operation.run(title, { all: items.length, broken: host.others }, toggled.id.split('/')[0]);
          await caughtUp(items.length);
          const state = await readId(toggled.id);
          const buffer = await evaluate(`${HOSTED} return editor.getValue();`);
          const expected = hostSource(host.items(shape, done.final));
          check(buffer === expected, `${row}: the buffer is not the calling note with the item put back: ${JSON.stringify(buffer)}`);
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
