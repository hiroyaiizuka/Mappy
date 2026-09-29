/**
 * E73 (docs/harness.md): a map called from an item of another map (§5 M12) keeps the reader's folds on the real
 * Obsidian when the called note is renamed, moved (itself or with its folder), or is no map for a while and comes back
 * (LEV-246, after LEV-221).
 *
 * The calling map names what is folded by node id (`calledNodeId`: the item's id and the called node's). Before LEV-246
 * the calling map's `CallReader` held its parses by path and threw a note's parse away when a read failed or no longer
 * called it, so the next parse had no previous one: every called node took a new id, and a node with a new id is
 * folded as new, so the branch the reader opened closed again, whatever its shape. A rename also rewrites the calling
 * note's two links in one write (Obsidian's link update), which the calling map matched by titles alone; and a draw
 * between (the call failing on the old link, or on a note that is no map for the moment) let go of the folds.
 *
 * Rows: the operation × the shape of the called node the reader opened (通常 親 ・空題名 the second untitled node ・同名
 * the second of two ・トピック 枝 under the item calling `#トピック`). Operations: 改名 (`fileManager.renameFile`, links
 * updated), 移動 (to another folder), フォルダ改名 (the folder above it renamed), 非マップ-保存 (`mappy: true` taken out
 * of the saved note, then put back), 非マップ-未保存 (the same in a Markdown editor's buffer, unsaved: the store reads
 * the open editor first). The calling note, `- ![[E2E-call-rename]]` and `- ![[E2E-call-rename#トピック]]`, is open as a
 * map; the reader opens 親 and the row's node with real clicks. After the operation, the row's node keeps its id and
 * stays open.
 *
 * Usage (see docs/harness.md 実機検証 for the Obsidian instance):
 *   npm run harness:e2e:call-rename -- [--reload] [--json <out.json>] [--keep] [--only <row name prefix>]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makePluginStep, refuseOpenLeaves, writeNote } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const FOLDER = 'Fixtures/E2E-call-rename';
const NAME = 'E2E-call-rename';
const NOTE = `${FOLDER}/${NAME}.md`;
const HOST = 'Fixtures/E2E-call-rename-host.md';
/** Where each operation leaves the called note, and the folders the case may create (removed by the case only). */
const RENAMED = `${FOLDER}/${NAME}-改名後.md`;
const MOVED_FOLDER = 'Fixtures/E2E-call-rename-移動先';
const RENAMED_FOLDER = 'Fixtures/E2E-call-rename-改名したフォルダ';
const FOLDERS = [FOLDER, MOVED_FOLDER, RENAMED_FOLDER];
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
const hostSource = name => `---\nmappy: true\n---\n## 呼び出し元\n- ![[${name}]]\n- ![[${name}#トピック]]\n`;
const NOT_A_MAP = SOURCE.replace('mappy: true\n', 'mappy: tru\n');

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

const SHAPES = [
  { name: '通常', label: '親', index: 0 },
  { name: '空題名', label: '空のノード', index: 1 },
  { name: '同名', label: '同名', index: 1 },
  { name: 'トピック', label: '枝', index: 0 },
];

/** VIEW (the calling map), plus what it last drew of its calls (its private record; read, never changed). */
const HOSTED = `${VIEW}
  const drawn = () => Array.from(view.targets?.values() ?? [], target => ({ path: target.path, source: target.document.source }));`;

/** The Markdown leaf a row opened on the called note, if any, and the calling map's leaf: both closed. */
const detach = `for (const key of ['__mappyE2EEditor', '__mappyE2E']) { window[key]?.detach(); delete window[key]; }`;

/** Every folder the case may have made, with what is in it, and the calling note: gone. */
const removeAll = `
  for (const path of ${JSON.stringify([HOST, ...FOLDERS])}) {
    const file = app.vault.getAbstractFileByPath(path);
    if (file) await app.vault.delete(file, true);
  }`;

/**
 * The calling map has drawn `calls` calls of the note at `path`, each from its text now (the open editor's buffer when
 * `buffer`), and no read of it is pending; `calls` 0 is a map showing its items as links.
 */
const caughtUp = async (path, calls, buffer = false) => {
  const started = Date.now();
  let state;
  for (;;) {
    state = await evaluate(`${HOSTED}
      const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
      const text = ${buffer} ? window.__mappyE2EEditor?.view.editor.getValue() : file ? await app.vault.read(file) : null;
      const calls = drawn();
      const idle = view.recallTimer === undefined && view.refreshTimer === undefined && view.refreshing === undefined;
      return { ok: idle && calls.length === ${calls} && calls.every(call => call.path === ${JSON.stringify(path)} && call.source === text), calls: calls.map(call => call.path) };`)
      .catch(error => ({ ok: false, error: String(error) }));
    if (state.ok) break;
    if (Date.now() - started > 5000) throw new Error(`the calling map did not settle on ${calls} calls of ${path}: ${JSON.stringify(state)}`);
    await wait(100);
  }
  await wait(400);
  return state;
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

const fit = async () => {
  await clickAt(`return el.querySelector('.mappy-button[aria-label="全体表示"]');`);
  await wait(600);
};

const toggle = async (title, index) => {
  await clickAt(`return nth(${JSON.stringify(title)}, ${index})?.querySelector('.mappy-node-toggle');`);
  await wait(400);
  await fit();
};

/** The calling map's `index`-th node labelled `title`: its id and whether its branch is folded. */
const read = (title, index) => evaluate(`${HOSTED}
  const node = nth(${JSON.stringify(title)}, ${index});
  return { id: node?.dataset.nodeId ?? null, folded: node?.classList.contains('is-collapsed') ?? null, labels: nodes().map(label) };`);

/** The called note written fresh in its folder, the calling note beside it, and the calling note open as a map. */
const reopen = async () => {
  await evaluate(`${detach} return true;`);
  await wait(200);
  return evaluate(`
    ${refuseOpenLeaves([HOST, NOTE, RENAMED, `${MOVED_FOLDER}/${NAME}.md`, `${RENAMED_FOLDER}/${NAME}.md`])}
    ${removeAll}
    await app.vault.createFolder(${JSON.stringify(FOLDER)});
    { ${writeNote(NOTE, SOURCE)} }
    { ${writeNote(HOST, hostSource(NAME))} }
    const opened = app.workspace.getLeaf('tab');
    await opened.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(HOST)}, layout: 'mindmap' }, active: true });
    await new Promise(resolve => setTimeout(resolve, 1500));
    app.workspace.setActiveLeaf(opened, { focus: true });
    window.__mappyE2E = opened;
    return true;`);
};

/** 親 and then the row's node opened by the reader with real clicks (every called branch starts folded). */
const openRow = async shape => {
  await fit();
  if (shape.name !== '通常') await toggle('親', 0);
  const initial = await read(shape.label, shape.index);
  await toggle(shape.label, shape.index);
  const toggled = await read(shape.label, shape.index);
  if (toggled.id === null || toggled.id !== initial.id || initial.folded !== true || toggled.folded !== false || !toggled.labels.includes('子1')) {
    throw new Error(`the clicks did not open 親 and ${shape.name} in the calling map: ${JSON.stringify({ initial, toggled })}`);
  }
  return { id: toggled.id, folded: toggled.folded };
};

/** `from` renamed by the file manager (what the file explorer's rename calls), the vault's own rename events heard. */
const renameFile = (from, to) => evaluate(`
  const heard = [];
  const listener = app.vault.on('rename', (file, oldPath) => { heard.push([oldPath, file.path]); });
  await app.fileManager.renameFile(app.vault.getAbstractFileByPath(${JSON.stringify(from)}), ${JSON.stringify(to)});
  await new Promise(resolve => setTimeout(resolve, 300));
  app.vault.offref(listener);
  return { heard, host: await app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(HOST)})) };`);

const OPERATIONS = [
  {
    name: '改名',
    run: async () => {
      const renamed = await renameFile(NOTE, RENAMED);
      check(renamed.host === hostSource(`${NAME}-改名後`), `改名: the links in the calling note were not updated: ${JSON.stringify(renamed.host)}`);
      return { path: RENAMED, heard: renamed.heard };
    },
  },
  {
    name: '移動',
    run: async () => {
      await evaluate(`await app.vault.createFolder(${JSON.stringify(MOVED_FOLDER)}); return true;`);
      const moved = await renameFile(NOTE, `${MOVED_FOLDER}/${NAME}.md`);
      check(moved.host === hostSource(NAME), `移動: the calling note changed: ${JSON.stringify(moved.host)}`);
      return { path: `${MOVED_FOLDER}/${NAME}.md`, heard: moved.heard };
    },
  },
  {
    name: 'フォルダ改名',
    run: async () => {
      const moved = await renameFile(FOLDER, RENAMED_FOLDER);
      check(moved.host === hostSource(NAME), `フォルダ改名: the calling note changed: ${JSON.stringify(moved.host)}`);
      return { path: `${RENAMED_FOLDER}/${NAME}.md`, heard: moved.heard };
    },
  },
  {
    name: '非マップ-保存',
    run: async () => {
      await evaluate(`await app.vault.modify(app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}), ${JSON.stringify(NOT_A_MAP)}); return true;`);
      const between = await caughtUp(NOTE, 0);
      await evaluate(`await app.vault.modify(app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}), ${JSON.stringify(SOURCE)}); return true;`);
      return { path: NOTE, between };
    },
  },
  {
    name: '非マップ-未保存',
    buffer: true,
    run: async () => {
      // A Markdown editor on the called note, in a split beside the map; the header broken and mended in its buffer.
      await evaluate(`
        // The map note's Markdown, as the map's source button opens it (the router would make a plain Markdown state a map).
        const editor = app.workspace.createLeafBySplit(window.__mappyE2E, 'vertical');
        await app.plugins.plugins.mappy.router.openMarkdown(editor, app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}), false);
        // Source mode (not live preview, whose header is the Properties widget): the header is text in the buffer.
        await editor.setViewState({ type: 'markdown', state: { ...editor.getViewState().state, mode: 'source', source: true }, active: false });
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (editor.view.getViewType() !== 'markdown' || editor.view.getMode?.() !== 'source') throw new Error('no Markdown editor on the called note: ' + editor.view.getViewType());
        window.__mappyE2EEditor = editor;
        const at = editor.view.editor.getValue().indexOf('mappy: true');
        editor.view.editor.replaceRange('tru', editor.view.editor.offsetToPos(at + 7), editor.view.editor.offsetToPos(at + 11));
        if (!editor.view.editor.getValue().includes('mappy: tru\\n')) throw new Error('the buffer was not edited');
        return true;`);
      const between = await caughtUp(NOTE, 0, true);
      const disk = await evaluate(`return app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}));`);
      await evaluate(`
        const editor = window.__mappyE2EEditor.view.editor;
        const at = editor.getValue().indexOf('mappy: tru');
        editor.replaceRange('true', editor.offsetToPos(at + 7), editor.offsetToPos(at + 10));
        return true;`);
      return { path: NOTE, between, unsaved: disk === SOURCE };
    },
  },
];

try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  // The link update of a rename, without the dialog that asks for it, and links by the shortest path (the rows expect
  // `![[name]]`): the vault's settings, each put back at the end as it was (a key the vault did not have is removed).
  const settings = { alwaysUpdateLinks: true, newLinkFormat: 'shortest' };
  const saved = await evaluate(`
    const settings = ${JSON.stringify(settings)};
    const was = {};
    for (const [key, value] of Object.entries(settings)) { was[key] = key in app.vault.config ? { value: app.vault.config[key] } : null; app.vault.setConfig(key, value); }
    return was;`);
  record.settings = saved;
  try {
    for (const operation of OPERATIONS) {
      for (const shape of SHAPES) {
        const row = `${operation.name}-${shape.name}`;
        await step(row, async () => {
          await reopen();
          await caughtUp(NOTE, 2);
          const toggled = await openRow(shape);
          const done = await operation.run();
          await caughtUp(done.path, 2, operation.buffer ?? false);
          const state = await read(shape.label, shape.index);
          check(state.id === toggled.id, `${row}: the calling map's node id changed (${toggled.id} → ${state.id})`);
          check(state.folded === toggled.folded, `${row}: the branch the reader opened closed again`);
          if (operation.buffer) check(done.unsaved, `${row}: the broken header reached the disk; the row read a saved note`);
          const { path, ...rest } = done;
          return { toggled, after: { id: state.id, folded: state.folded }, path, ...rest };
        });
      }
    }
  } finally {
    await evaluate(`
      const was = ${JSON.stringify(saved)};
      for (const [key, entry] of Object.entries(was)) {
        if (entry) app.vault.setConfig(key, entry.value);
        else { delete app.vault.config[key]; app.vault.requestSaveConfig(); }
      }
      return true;`);
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
