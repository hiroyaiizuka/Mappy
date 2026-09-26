/**
 * E47 (docs/harness.md): the fold and the selection through ⌘Z／⌘⇧Z on the real Obsidian (LEV-150, the Undo／Redo half).
 *
 * The map names what is folded and selected by node id, and a node whose title repeats or is empty has nothing but the
 * edits of the write to carry its id over the re-read (LEV-146). Before LEV-150 the store's Undo／Redo returned only
 * the text, so the re-read after ⌘Z／⌘⇧Z matched by title, and such a node came back with a new id: its branch opened
 * and the selection left it.
 *
 * The rows are what the user did before ⌘Z × the shape of the folded, selected node:
 *   edit    F2 rename of 子1, then fold and select the node, ⌘Z, ⌘⇧Z.
 *   switch  F2 rename of 子1, a layout button (timeline), then fold and select the node, ⌘Z, ⌘⇧Z (LEV-206 carries the
 *           history over the button).
 * × 通常 (親, one title) ・空題名 (the second untitled node) ・同名 (the second of two) ・トピック.
 * The 通常 and トピック rows pass before the fix too: a title only one node has is carried by the text either way.
 * They pin that the carried ids do not move such a node.
 *
 * ⌘Z is sent with the focus left where the click on the fold toggle put it (inside the canvas): a blank click on the
 * canvas, which `makeHistory` uses to focus it, clears the selection this case is about. A row whose focus is not in
 * the canvas stops before the key, since a chord the page does not take reaches the macOS menu (docs/harness.md).
 *
 * Usage (see docs/harness.md 実機検証 for the Obsidian instance):
 *   npm run harness:e2e:undo-ids -- [--reload] [--json <out.json>] [--keep]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep, makeOpenStep, makeRename, makeAfter, refuseOpenLeaves } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-undo-ids.md';
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

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const rename = makeRename(cdp, evaluate);
const after = makeAfter(evaluate);

/** The shapes: the name on screen (an untitled node is named 空のノード), its index among equals, and its title in the note. */
const SHAPES = [
  { name: '通常', label: '親', index: 0, title: '親' },
  { name: '空題名', label: '空のノード', index: 1, title: '' },
  { name: '同名', label: '同名', index: 1, title: '同名' },
  { name: 'トピック', label: 'トピック', index: 0, title: 'トピック' },
];

const reopen = async () => {
  await evaluate(`const leaf = window.__mappyE2E; if (leaf) leaf.detach(); delete window.__mappyE2E; return true;`);
  await wait(200);
  return required(record, 'open', await makeOpenStep(evaluate, { note: NOTE, source: SOURCE })());
};

/** A real mouse click at the centre of what `locate` (a script returning an element) finds. */
const clickAt = async locate => {
  const box = await evaluate(`${VIEW}
    const target = (() => { ${locate} })();
    if (!target) throw new Error('nothing to click');
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
};

/** The node by its place in the map's own parse (the n-th on screen is not a fixed node after a re-render), the folds and the selection. */
const read = shape => evaluate(`${VIEW}
  const node = view.document.nodes.filter(item => item.title === ${JSON.stringify(shape.title)})[${shape.index}];
  return { collapsed: [...view.collapsed], selected: view.selectedId, id: node?.id ?? null, focused: el.querySelector('.mappy-canvas').contains(document.activeElement) };`);

/** ⌘Z or ⌘⇧Z with the focus where the fold toggle left it; refused when it is not in the canvas (see the header). */
const history = async direction => {
  const state = await evaluate(`${VIEW} return { focused: el.querySelector('.mappy-canvas').contains(document.activeElement), editing: !!input(), source: await source() };`);
  if (!state.focused || state.editing) throw new Error(`${direction}: the focus is not on the map (${JSON.stringify(state)}); not sending the chord`);
  await cdp.realKey('z', direction === 'redo' ? 12 : 4);
  return after(state.source);
};

try {
  await step('plugin', makePluginStep(cdp, evaluate, flag));
  const withTimeline = text => text.replace('mappy: true\n', 'mappy: true\nmappy-layout: timeline\n');
  for (const before of ['edit', 'switch']) {
    for (const shape of SHAPES) {
      await step(`${before}-${shape.name}`, async () => {
        const opened = await reopen();
        const edited = opened.source.replace('  - 子1\n', '  - 改名\n');
        await select('子1');
        const renamed = await rename('改名');
        if (renamed.source !== edited) throw new Error(`the rename wrote something else:\n${renamed.source}`);
        let base = { opened: opened.source, edited };
        if (before === 'switch') {
          // The second layout button (LAYOUT_MODES: mindmap, timeline, …).
          await clickAt(`return el.querySelectorAll('.mappy-modes button')[1];`);
          const switched = await after(edited);
          if (switched.source !== withTimeline(edited)) throw new Error(`the button wrote something else:\n${switched.source}`);
          base = { opened: withTimeline(opened.source), edited: withTimeline(edited) };
        }
        await select(shape.label, shape.index);
        await clickAt(`return nth(${JSON.stringify(shape.label)}, ${shape.index})?.querySelector('.mappy-node-toggle');`);
        await wait(400);
        const folded = await read(shape);
        if (!folded.collapsed.includes(folded.id) || folded.selected !== folded.id) throw new Error(`the click and the toggle did not select and fold ${shape.name}: ${JSON.stringify(folded)}`);
        const rows = [{ label: 'folded', ...folded }];
        const expectAt = async (label, result, expected) => {
          const state = await read(shape);
          rows.push({ label, ...state, source: result.source, messages: result.messages });
          const row = `${before}-${shape.name} ${label}`;
          check(result.messages.length === 0, `${row}: showed ${JSON.stringify(result.messages)}`);
          check(result.source === expected, `${row}:\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(result.source)}`);
          check(state.id === folded.id, `${row}: the node's id changed (${folded.id} → ${state.id})`);
          check(state.collapsed.includes(state.id ?? ''), `${row}: the fold was lost (${JSON.stringify(folded)} → ${JSON.stringify(state)})`);
          check(state.id !== null && state.selected === state.id, `${row}: the selection moved (${JSON.stringify(folded)} → ${JSON.stringify(state)})`);
        };
        await expectAt('⌘Z', await history('undo'), base.opened);
        await expectAt('⌘⇧Z', await history('redo'), base.edited);
        return { rows };
      });
    }
  }

  if (!flag('--keep')) {
    await step('clean', () => evaluate(`${VIEW}
      const file = view.file;
      leaf.detach();
      ${refuseOpenLeaves([NOTE])}
      if (file) await app.vault.delete(file, true);
      delete window.__mappyE2E;
      delete window.__mappyE2EBefore;
      return { removed: file?.path ?? null };`));
  }
} catch (error) {
  if (!(error instanceof StopCase)) throw error;
} finally {
  cdp.close();
}

process.exit(await finish(record, value('--json')));
