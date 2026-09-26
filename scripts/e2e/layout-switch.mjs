/**
 * E39 (docs/harness.md): the bottom-left layout buttons, and what the user does at the same moment, on the real
 * Obsidian (LEV-196, and the layout-switch half of LEV-150).
 *
 * A button writes the note's `mappy-layout`. Before LEV-196 that write went through `processFrontMatter`, beside
 * the map's own save path: the map's `document.source` stayed on the text before it until the watcher's re-read
 * (≈60 ms on this machine: 45 ms debounce + the read), and an edit planned in between was refused as if someone else
 * had changed the note (「Markdown が変更されています」). The re-read also had no edits to carry ids across, so a
 * folded or selected node whose title repeats or is empty lost its fold and selection (LEV-150).
 *
 * The rows are the user's action × the node's shape:
 *   draft   F2, type, then click a layout button: the draft's blur saves it while the button writes the layout.
 *           A human does this at human speed — the one row of LEV-196 reached with a mouse and a keyboard.
 *   key     a layout button, then Enter／Tab／Delete／F2 and confirm, sent at machine speed (the canvas is focused
 *           by script: the click leaves the focus on the button, and a human cannot click a node and press a key
 *           inside the ≈60 ms window). This pins the race itself, not a path a person takes with a mouse.
 *   fold    fold and select a node, then a layout button: the fold and the selection stay (LEV-150).
 * × 通常 (a unique title) ・空題名 (an item with no text) ・トピック (a top-level heading besides the body).
 *
 * E44 (LEV-206): the history across a layout button. Before LEV-206 the button's write dropped every Undo and Redo
 * step, as a change from outside does (E05), so ⌘Z after it did nothing. The rows are the user's order × the shape:
 *   undo    F2 rename, a layout button, ⌘Z, ⌘⇧Z: the rename goes and comes back, the layout stays in the note and
 *           on screen (the switch is no step of its own).
 *   redo    F2 rename, ⌘Z, a layout button, ⌘⇧Z, ⌘Z: the Redo step waiting before the button is still there.
 * × 通常・空題名・同名 (the second of two)・トピック.
 *
 * The drop of a topic, and the drag of the body, while a second finger taps a button (LEV-182's touch) are not
 * here: one mouse cannot reach the button during a drag (lessons 12), and CDP's touch input on desktop Obsidian does
 * not start the map's pointer drag at all, so it would only prove the harness. `tests/ui/mindmap-view-layout-write.test.ts`
 * holds those rows in jsdom.
 *
 * Usage (see docs/harness.md 実機検証 for the Obsidian instance):
 *   npm run harness:e2e:layout-switch -- [--reload] [--json <out.json>] [--keep]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep, makeOpenStep, makePaste, makeRename, makeHistory, refuseOpenLeaves } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-layout-switch.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 切替', '',
  '- 親', '  - 子1',
  '- ', '  - 空の子',
  '- ', '  - 空の子2',
  '- 同名', '  - 同名の子A',
  '- 同名', '  - 同名の子B',
  '', '## トピック', '',
  '- 枝', '',
].join('\n');

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const paste = makePaste(evaluate);
const rename = makeRename(cdp, evaluate);
const history = makeHistory(cdp, evaluate);

/** The shapes: the name the node is found by on screen (an untitled node is named 空のノード) and its index among equals. */
const SHAPES = [
  { name: '通常', title: '子1', index: 0 },
  { name: '空題名', title: '空のノード', index: 0 },
  { name: 'トピック', title: 'トピック', index: 0 },
];

/** A fresh map on the fixture: the leaf of the previous row is closed first, so every row starts from the same note. */
const reopen = async () => {
  await evaluate(`const leaf = window.__mappyE2E; if (leaf) leaf.detach(); delete window.__mappyE2E; return true;`);
  await wait(200);
  return required(record, 'open', await makeOpenStep(evaluate, { note: NOTE, source: SOURCE })());
};

/** A real mouse click on the `index`-th layout button, in the order the view creates them (`LAYOUT_MODES`: mindmap, timeline, hierarchy, balanced). */
const clickLayout = async index => {
  const box = await evaluate(`${VIEW}
    const button = el.querySelectorAll('.mappy-modes button')[${index}];
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
};

/**
 * Waits until the note holds what the row's action must leave in it (`reached`) and the map has re-read it, then a
 * little more for a late Notice or write, and reads it all. The map is current right after the click too, before
 * any write has run, so waiting for that alone would read the map from before. A row whose note never gets there
 * fails here: every check after it would read a map from before.
 */
const settle = async reached => {
  const started = Date.now();
  for (;;) {
    const current = await evaluate(`${VIEW} const text = await source(); return { text, mapCurrent: view.document?.source === text };`);
    if (reached(current.text) && current.mapCurrent) break;
    if (Date.now() - started > 3000) throw new Error(`the note did not reach what the row expects, or the map did not re-read it, within 3 s:\n${current.text}`);
    await wait(100);
  }
  await wait(600);
  return evaluate(`${VIEW}
    return { messages: messages(), editing: !!input(), labels: nodes().map(label), source: await source() };`);
};

/** The note asks for `mode`. */
const asks = mode => text => text.includes(`mappy-layout: ${mode}\n`);

const expectLayout = (result, mode, row) => {
  const line = `mappy-layout: ${mode}`;
  check(mode === 'mindmap' ? !result.source.includes('mappy-layout:') : result.source.includes(line), `${row}: the note does not hold ${line}:\n${result.source}`);
};

try {
  await step('plugin', makePluginStep(cdp, evaluate, flag));
  // What the vault held before the rows: `clean` removes the images the paste rows add, and nothing else.
  await evaluate(`window.__mappyLayoutBefore = new Set(app.vault.getFiles().map(file => file.path)); return true;`);

  // 1. draft × shape: the blur of the click on the button saves the draft while the button writes the layout.
  for (const shape of SHAPES) {
    await step(`draft-${shape.name}`, async () => {
      await reopen();
      await select(shape.title, shape.index);
      await cdp.realKey('F2');
      await wait(300);
      if (!await evaluate(`${VIEW} return !!input();`)) throw new Error('F2 did not open the inline editor');
      const title = `${shape.name}を改名`;
      // The editor selects the old title, so the text replaces it.
      await cdp.insertText(title);
      await wait(200);
      await clickLayout(2);
      const result = await settle(text => asks('hierarchy')(text) && text.includes(title));
      check(result.messages.length === 0, `draft-${shape.name}: the save showed ${JSON.stringify(result.messages)}`);
      check(!result.editing, `draft-${shape.name}: the draft is still open`);
      check(result.labels.includes(title), `draft-${shape.name}: the map does not show ${title}`);
      check(result.source.includes(title), `draft-${shape.name}: the note does not hold ${title}`);
      expectLayout(result, 'hierarchy', `draft-${shape.name}`);
      return result;
    });
  }

  // 2. key × shape, at machine speed: a layout button, then the key on the node still selected.
  for (const key of ['Enter', 'Tab', 'Delete', 'F2']) {
    for (const shape of SHAPES) {
      await step(`key-${key}-${shape.name}`, async () => {
        const opened = await reopen();
        await select(shape.title, shape.index);
        await clickLayout(1);
        await evaluate(`${VIEW} el.querySelector('.mappy-canvas').focus({ preventScroll: true }); return true;`);
        await cdp.realKey(key);
        if (key === 'F2') {
          await cdp.insertText(`${shape.name}F2`);
          await cdp.realKey('Enter');
        }
        const layoutOnly = opened.source.replace('mappy: true\n', 'mappy: true\nmappy-layout: timeline\n');
        const result = await settle(text => asks('timeline')(text) && text !== layoutOnly);
        const written = result.source !== layoutOnly;
        check(result.messages.length === 0, `key-${key}-${shape.name}: showed ${JSON.stringify(result.messages)}`);
        check(written, `key-${key}-${shape.name}: ${key} changed nothing but the layout`);
        expectLayout(result, 'timeline', `key-${key}-${shape.name}`);
        return result;
      });
    }
  }

  // 2b. an image pasted onto the selected node right after the button (the view's own check before the attachment
  // used to refuse the button's write as someone else's change), at machine speed like the keys.
  for (const shape of SHAPES) {
    await step(`paste-${shape.name}`, async () => {
      await reopen();
      await select(shape.title, shape.index);
      await clickLayout(1);
      await evaluate(`${VIEW} el.querySelector('.mappy-canvas').focus({ preventScroll: true }); return true;`);
      await paste(`layout-${SHAPES.indexOf(shape)}.png`);
      const result = await settle(text => asks('timeline')(text) && text.includes(`layout-${SHAPES.indexOf(shape)}.png`));
      check(result.messages.length === 0, `paste-${shape.name}: showed ${JSON.stringify(result.messages)}`);
      check(result.source.includes(`layout-${SHAPES.indexOf(shape)}.png`), `paste-${shape.name}: the image is not linked in the note`);
      expectLayout(result, 'timeline', `paste-${shape.name}`);
      return result;
    });
  }

  // 3. fold × shape (LEV-150): the second of two 同名, or of two untitled nodes, folded and selected, then a button.
  // The first of each would do too, but not one alone: a title only one node has is carried by the text either way.
  for (const shape of [{ name: '同名', title: '同名', index: 1 }, { name: '空題名', title: '空のノード', index: 1 }]) {
    await step(`fold-${shape.name}`, async () => {
      await reopen();
      await select(shape.title, shape.index);
      // The fold toggle beside the node, pressed with the mouse.
      const toggle = await evaluate(`${VIEW}
        const node = nth(${JSON.stringify(shape.title)}, ${shape.index});
        const button = node?.querySelector('.mappy-node-toggle');
        if (!button) throw new Error('no toggle');
        const rect = button.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: toggle.x, y: toggle.y, button: 'left', clickCount: 1 });
      }
      await wait(400);
      // The node is named by its place in the note (the map's own parse), not on screen: the renderer keeps elements
      // in the order it made them, which a layout switch does not reorder, so the n-th on screen is not a fixed node.
      const read = () => evaluate(`${VIEW}
        const title = ${JSON.stringify(shape.title === '空のノード' ? '' : shape.title)};
        const node = view.document.nodes.filter(item => item.title === title)[${shape.index}];
        return { collapsed: [...view.collapsed], selected: view.selectedId, id: node?.id ?? null, labels: nodes().map(label).sort() };`);
      const before = await read();
      if (!before.collapsed.includes(before.id) || before.selected !== before.id) throw new Error(`the click and the toggle did not select and fold ${shape.name}: ${JSON.stringify(before)}`);
      await clickLayout(3);
      const result = await settle(asks('balanced'));
      const after = await read();
      check(result.messages.length === 0, `fold-${shape.name}: showed ${JSON.stringify(result.messages)}`);
      check(after.id !== null, `fold-${shape.name}: the node is gone from the map's parse (${JSON.stringify(after)})`);
      check(after.collapsed.includes(after.id ?? ''), `fold-${shape.name}: the fold was lost (${JSON.stringify(before)} → ${JSON.stringify(after)})`);
      check(after.id !== null && after.selected === after.id, `fold-${shape.name}: the selection moved (${JSON.stringify(before)} → ${JSON.stringify(after)})`);
      // The nodes on screen, not their order (see `read`).
      check(JSON.stringify(after.labels) === JSON.stringify(before.labels), `fold-${shape.name}: the map shows other nodes: ${JSON.stringify(after.labels)}`);
      expectLayout(result, 'balanced', `fold-${shape.name}`);
      return { before, after, source: result.source };
    });
  }

  // 4. E44 (LEV-206): the history across a button × shape. The texts expected are computed from the note the row
  // opened, not from what the map reports: a rename that also changed something else fails here.
  const HISTORY_SHAPES = [
    { name: '通常', title: '子1', index: 0, line: '  - 子1\n', renamed: title => `  - ${title}\n` },
    { name: '空題名', title: '空のノード', index: 0, line: '- \n  - 空の子\n', renamed: title => `- ${title}\n  - 空の子\n` },
    { name: '同名', title: '同名', index: 1, line: '- 同名\n  - 同名の子B\n', renamed: title => `- ${title}\n  - 同名の子B\n` },
    { name: 'トピック', title: 'トピック', index: 0, line: '## トピック\n', renamed: title => `## ${title}\n` },
  ];
  const withTimeline = text => text.replace('mappy: true\n', 'mappy: true\nmappy-layout: timeline\n');
  const mode = () => evaluate(`${VIEW} return view.mode;`);
  for (const order of ['undo', 'redo']) {
    for (const shape of HISTORY_SHAPES) {
      await step(`${order}-${shape.name}`, async () => {
        const opened = await reopen();
        if (!opened.source.includes(shape.line)) throw new Error(`the fixture has no ${JSON.stringify(shape.line)}`);
        const title = `${shape.name}履歴`;
        const edited = opened.source.replace(shape.line, shape.renamed(title));
        await select(shape.title, shape.index);
        const renamed = await rename(title);
        if (renamed.source !== edited) throw new Error(`the rename wrote something else:\n${renamed.source}`);
        const rows = [];
        const expectAt = (result, label, expected) => {
          rows.push({ label, source: result.source, messages: result.messages });
          check(result.messages.length === 0, `${order}-${shape.name} ${label}: showed ${JSON.stringify(result.messages)}`);
          check(result.source === expected, `${order}-${shape.name} ${label}:\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(result.source)}`);
        };
        if (order === 'redo') expectAt(await history('undo'), '⌘Z before the button', opened.source);
        await clickLayout(1);
        const switched = await settle(asks('timeline'));
        expectAt(switched, 'the button', withTimeline(order === 'undo' ? edited : opened.source));
        if (order === 'undo') {
          expectAt(await history('undo'), '⌘Z', withTimeline(opened.source));
          expectAt(await history('redo'), '⌘⇧Z', withTimeline(edited));
        } else {
          expectAt(await history('redo'), '⌘⇧Z', withTimeline(edited));
          expectAt(await history('undo'), '⌘Z', withTimeline(opened.source));
        }
        const shown = await mode();
        check(shown === 'timeline', `${order}-${shape.name}: the map left the layout of the button (${shown})`);
        return { rows, mode: shown };
      });
    }
  }

  if (!flag('--keep')) {
    await step('clean', () => evaluate(`${VIEW}
      const file = view.file;
      leaf.detach();
      ${refuseOpenLeaves([NOTE])}
      if (file) await app.vault.delete(file, true);
      const added = app.vault.getFiles().filter(item => !window.__mappyLayoutBefore.has(item.path));
      for (const item of added) await app.vault.delete(item, true);
      delete window.__mappyE2E;
      delete window.__mappyE2EBefore;
      delete window.__mappyLayoutBefore;
      return { removed: [file?.path ?? null, ...added.map(item => item.path)] };`));
  }
} catch (error) {
  if (!(error instanceof StopCase)) throw error;
} finally {
  cdp.close();
}

process.exit(await finish(record, value('--json')));
