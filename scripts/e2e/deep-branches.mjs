/**
 * E17 (docs/harness.md): a list-format branch eight levels deep — past the six a heading-format map can hold
 * (`src/core/commands.ts`: 「見出しは 6 階層までです」) — added to, moved and re-indented through the real
 * keyboard and pointer, with the note's Markdown compared after every step.
 *
 * - Tab／Enter on the deepest item add a child (level 9) and a sibling there, written with the indentation
 *   the neighbouring items already use (`src/core/list-commands.ts`'s `childStyle`).
 * - ⌥↓／⌥↑ swap two level-8 siblings, carrying the moved item's own children, and come back byte for byte.
 * - A drag of a level-7 subtree onto a level-2 item re-indents every line of it (`shiftedBranch`), and one of
 *   a level-2 item onto a level-8 item deepens it; ⌘Z restores the document byte for byte each time.
 * - Tab／Shift+Tab typed into the Markdown editor beside the map (Obsidian's own list indent, whatever it
 *   inserts) re-parent the item on the map on its next refresh, and the note on disk ends up as the editor
 *   has it (Obsidian's save).
 *
 * Usage: npm run harness:e2e:deep-branches -- [--reload] [--json <out.json>] [--keep]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish } from './case-runner.mjs';
import { VIEW, makeSelect, makeState, makeFocusCanvas, makePluginStep, makeOpenStep } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-deep-branches.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 深い枝の確認', '',
  '- 階層1',
  '  - 階層2',
  '    - 階層3',
  '      - 階層4',
  '        - 階層5',
  '          - 階層6',
  '            - 階層7',
  '              - 階層8',
  '              - 階層8の兄弟',
  '- 別の枝',
  '  - 移動先', '',
].join('\n');

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const focusCanvas = makeFocusCanvas(cdp, evaluate);
const state = makeState(evaluate);

/**
 * The hierarchy the map itself parsed (not the DOM's drawing): each node's title, depth below the root and
 * parent's title. Read from the view's current document, which a refresh after an editor change replaces.
 */
const tree = () => evaluate(`${VIEW}
  const doc = view.document;
  const byId = new Map(doc.nodes.map(node => [node.id, node]));
  const depth = node => { let d = 0; for (let at = node; at?.parentId && byId.has(at.parentId); at = byId.get(at.parentId)) d += 1; return d; };
  return Object.fromEntries(doc.nodes.map(node => [node.title, { depth: depth(node), parent: byId.get(node.parentId ?? '')?.title ?? doc.root.title }]));`);

/** Enter or Tab on the selected node, answered by the inline editor opening on the new empty node, then a title and Enter to confirm it. */
const addNamed = async (key, title) => {
  await cdp.realKey(key);
  await wait(1000);
  const editing = await evaluate(`${VIEW} return !!input();`);
  if (!editing) throw new Error(`${key} did not open the inline editor on a new node`);
  await cdp.insertText(title);
  await wait(300);
  await cdp.realKey('Enter');
  await wait(1000);
  return state();
};

/** ⌥↑ or ⌥↓ on the selected node: modifiers bit 1 = Alt (scripts/e2e/cdp.mjs). Only sent with no draft open (docs/harness.md 実機検証). */
const moveAlt = async key => {
  const before = await state();
  if (before.editing) throw new Error(`${key} sent while a draft was open`);
  await cdp.realKey(key, 1);
  await wait(800);
  return state();
};

/** ⌘Z on the canvas (modifiers 4 = Meta), after a blank click puts focus back there (undo-redo.mjs explains why). */
const undo = async () => {
  await focusCanvas();
  const before = await state();
  if (before.editing) throw new Error('⌘Z sent while a draft was open');
  await cdp.realKey('z', 4);
  await wait(1000);
  return state();
};

/** Centre of the n-th node titled `title`, in the window's CSS pixels. */
const centre = title => evaluate(`${VIEW}
  const node = nth(${JSON.stringify(title)}, 0);
  if (!node) throw new Error('No node ' + ${JSON.stringify(title)});
  const rect = node.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`);

/**
 * A real pointer drag (Input.dispatchMouseEvent, as LEV-61 drove it) from the centre of `from` to the centre
 * of `to` — the middle of a node is its "last child" zone (`src/ui/node-drag.ts`'s EDGE_ZONE) — in small
 * steps with a rest over the target so the preview settles before the release.
 */
const drag = async (from, to) => {
  const start = await centre(from);
  const end = await centre(to);
  const mouse = (type, point, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', ...extra });
  await mouse('mouseMoved', start, { buttons: 0 });
  await mouse('mousePressed', start, { buttons: 1, clickCount: 1 });
  const steps = 16;
  for (let index = 1; index <= steps; index += 1) {
    const point = { x: start.x + (end.x - start.x) * index / steps, y: start.y + (end.y - start.y) * index / steps };
    await mouse('mouseMoved', point, { buttons: 1 });
    await wait(40);
  }
  await wait(400);
  await mouse('mouseMoved', { x: end.x + 1, y: end.y }, { buttons: 1 });
  await wait(400);
  await mouse('mouseReleased', { x: end.x + 1, y: end.y }, { buttons: 0, clickCount: 1 });
  await wait(1200);
  return state();
};

/** The lines of `branch` (a run of list lines) with `delta` spaces added (positive) or removed (negative) at the front of each. */
const shift = (branch, delta) => branch.split('\n').map(line => (line === '' ? line
  : delta >= 0 ? ' '.repeat(delta) + line : line.slice(-delta))).join('\n');

try {
  await step('plugin', makePluginStep(cdp, evaluate, flag));
  // Another leaf already on the note (a previous run's `--keep`) turns this map's edits into Editor edits,
  // saved to disk only on Obsidian's debounce — every source read below would see the document before them.
  await step('no-other-leaf', () => evaluate(`
    const open = [];
    app.workspace.iterateAllLeaves(item => { if (item.view.file?.path === ${JSON.stringify(NOTE)}) open.push(item.view.getViewType()); });
    if (open.length) throw new Error('Close the leaves already on ${NOTE} first: ' + open.join(', '));
    return true;`));
  const opened = await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE }));
  const initial = opened.source;

  // 0. The map shows all eight levels as the list nests them: 階層8 is eight below the root.
  await step('depth', async () => {
    const nodes = await tree();
    check(nodes['階層8']?.depth === 8 && nodes['階層8']?.parent === '階層7', `階層8 should sit at depth 8 under 階層7: ${JSON.stringify(nodes['階層8'])}`);
    check(nodes['階層8の兄弟']?.depth === 8, `階層8の兄弟 should sit at depth 8: ${JSON.stringify(nodes['階層8の兄弟'])}`);
    check(opened.labels.includes('階層8') && opened.labels.includes('階層8の兄弟'), 'the map does not draw the level-8 items');
    return nodes;
  });

  // 1. Tab on 階層8: a ninth level, indented two more spaces than 階層8 (the step every level here uses).
  const afterChild = await step('add-child', async () => {
    await select('階層8');
    const result = await addNamed('Tab', '階層9');
    check(result.messages.length === 0, `Tab showed ${JSON.stringify(result.messages)}`);
    check(!result.editing, 'the inline editor should have closed on Enter');
    const expected = initial.replace('              - 階層8\n', '              - 階層8\n                - 階層9\n');
    check(result.source === expected, `unexpected diff adding the level-9 child:\nbefore: ${JSON.stringify(initial)}\nafter:  ${JSON.stringify(result.source)}`);
    const nodes = await tree();
    check(nodes['階層9']?.depth === 9 && nodes['階層9']?.parent === '階層8', `階層9 should sit at depth 9 under 階層8: ${JSON.stringify(nodes['階層9'])}`);
    return result;
  });

  // 2. Enter on 階層9: a sibling at the same ninth level, right after it.
  const afterSibling = await step('add-sibling', async () => {
    await select('階層9');
    const result = await addNamed('Enter', '階層9の兄弟');
    check(result.messages.length === 0, `Enter showed ${JSON.stringify(result.messages)}`);
    const expected = afterChild.source.replace('                - 階層9\n', '                - 階層9\n                - 階層9の兄弟\n');
    check(result.source === expected, `unexpected diff adding the level-9 sibling:\nbefore: ${JSON.stringify(afterChild.source)}\nafter:  ${JSON.stringify(result.source)}`);
    const nodes = await tree();
    check(nodes['階層9の兄弟']?.depth === 9 && nodes['階層9の兄弟']?.parent === '階層8', `階層9の兄弟 should sit at depth 9 under 階層8: ${JSON.stringify(nodes['階層9の兄弟'])}`);
    return result;
  });

  // 3. ⌥↓ on 階層8: it swaps with 階層8の兄弟 and takes its two level-9 children with it.
  const branch8 = '              - 階層8\n                - 階層9\n                - 階層9の兄弟\n';
  const sibling8 = '              - 階層8の兄弟\n';
  await step('move-down', async () => {
    await select('階層8');
    const result = await moveAlt('ArrowDown');
    check(result.messages.length === 0, `⌥↓ showed ${JSON.stringify(result.messages)}`);
    const expected = afterSibling.source.replace(branch8 + sibling8, sibling8 + branch8);
    check(result.source === expected, `unexpected diff moving the level-8 branch down:\nbefore: ${JSON.stringify(afterSibling.source)}\nafter:  ${JSON.stringify(result.source)}`);
    const nodes = await tree();
    check(nodes['階層9']?.parent === '階層8' && nodes['階層9の兄弟']?.parent === '階層8', 'the level-9 children did not move with 階層8');
    return result;
  });

  // 4. ⌥↑ back: the document as it was before the move, byte for byte.
  await step('move-up', async () => {
    await select('階層8');
    const result = await moveAlt('ArrowUp');
    check(result.messages.length === 0, `⌥↑ showed ${JSON.stringify(result.messages)}`);
    check(result.source === afterSibling.source, `⌥↓ then ⌥↑ did not return the document:\nexpected: ${JSON.stringify(afterSibling.source)}\nactual:   ${JSON.stringify(result.source)}`);
    return result;
  });

  // 5. Drag 階層7 (levels 7–9, five lines) onto 移動先 (level 2): it becomes 移動先's child at level 3, every
  // line of the subtree 8 spaces shallower, and 階層6 is left without children.
  const branch7 = `            - 階層7\n${branch8}${sibling8}`;
  await step('drag-shallower', async () => {
    const result = await drag('階層7', '移動先');
    check(result.messages.length === 0, `the drag showed ${JSON.stringify(result.messages)}`);
    const expected = afterSibling.source.replace(branch7, '').replace('  - 移動先\n', `  - 移動先\n${shift(branch7, -8)}`);
    check(result.source === expected, `unexpected diff dragging 階層7 under 移動先:\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(result.source)}`);
    const nodes = await tree();
    check(nodes['階層7']?.parent === '移動先' && nodes['階層7']?.depth === 3, `階層7 should sit at depth 3 under 移動先: ${JSON.stringify(nodes['階層7'])}`);
    check(nodes['階層9']?.depth === 5, `階層9 should follow at depth 5: ${JSON.stringify(nodes['階層9'])}`);
    return result;
  });

  await step('drag-shallower-undo', async () => {
    const result = await undo();
    check(result.messages.length === 0, `⌘Z showed ${JSON.stringify(result.messages)}`);
    check(result.source === afterSibling.source, `⌘Z did not restore the document:\nexpected: ${JSON.stringify(afterSibling.source)}\nactual:   ${JSON.stringify(result.source)}`);
    return result;
  });

  // 6. Drag 移動先 (level 2) onto 階層8: it becomes 階層8's last child at level 9, after its two children.
  await step('drag-deeper', async () => {
    const result = await drag('移動先', '階層8');
    check(result.messages.length === 0, `the drag showed ${JSON.stringify(result.messages)}`);
    const expected = afterSibling.source.replace('  - 移動先\n', '').replace(branch8, `${branch8}                - 移動先\n`);
    check(result.source === expected, `unexpected diff dragging 移動先 under 階層8:\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(result.source)}`);
    const nodes = await tree();
    check(nodes['移動先']?.parent === '階層8' && nodes['移動先']?.depth === 9, `移動先 should sit at depth 9 under 階層8: ${JSON.stringify(nodes['移動先'])}`);
    return result;
  });

  await step('drag-deeper-undo', async () => {
    const result = await undo();
    check(result.messages.length === 0, `⌘Z showed ${JSON.stringify(result.messages)}`);
    check(result.source === afterSibling.source, `⌘Z did not restore the document:\nexpected: ${JSON.stringify(afterSibling.source)}\nactual:   ${JSON.stringify(result.source)}`);
    return result;
  });

  // 7. The Markdown editor beside the map (「Markdown を横に開く」): Tab／Shift+Tab typed there on
  // 階層9の兄弟's line, as Obsidian indents a list item itself — by its own indent unit (`useTab`／`tabSize`:
  // a tab of 4 columns with this vault's defaults), not the 2 spaces the fixture uses, so the lines end up
  // with tabs and spaces mixed. Where an item then lands is a matter of CommonMark columns (a tab stops at
  // the next multiple of 4), so the oracle is not a guess but the editor the keys were typed into: its
  // live-preview list level (`HyperMD-list-line-N`, CodeMirror's CommonMark parse) must be every list
  // node's depth on the map. Obsidian's reading view and metadata cache parse mixed indentation their own
  // way and disagree with both (LEV-17 で確認: 下の `reading` に記録するだけで合否には使わない。別チケット).
  await step('open-editor', () => evaluate(`${VIEW}
    await view.showSource(true);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const editor = app.workspace.getLeavesOfType('markdown').find(item => item.view.file?.path === view.file.path);
    if (!editor) throw new Error('No Markdown leaf opened beside the map');
    window.__mappyE2EEditor = editor;
    return { useTab: app.vault.getConfig('useTab'), tabSize: app.vault.getConfig('tabSize') };`));

  /** Put the caret at the end of the line holding `title`, focus the editor, and send a real (Shift+)Tab. */
  const editorIndent = async (title, shiftKey) => {
    const before = await evaluate(`
      const editor = window.__mappyE2EEditor.view.editor;
      const line = editor.getValue().split('\\n').findIndex(text => text.endsWith(${JSON.stringify(`- ${title}`)}));
      if (line < 0) throw new Error('No line for ' + ${JSON.stringify(title)});
      app.workspace.setActiveLeaf(window.__mappyE2EEditor, { focus: true });
      editor.focus();
      editor.setCursor({ line, ch: editor.getLine(line).length });
      return editor.getValue();`);
    await wait(200);
    const sentAt = Date.now();
    await cdp.realKey('Tab', shiftKey ? 8 : 0);
    return { before, sentAt };
  };

  /** Wait (up to 3 s) until the map's own parse puts `title` under `parent`; how long that took after the key. */
  const followed = async (title, parent, sentAt) => {
    for (;;) {
      const nodes = await tree();
      if (nodes[title]?.parent === parent) return { nodes, ms: Date.now() - sentAt };
      if (Date.now() - sentAt > 3000) return { nodes, ms: null };
      await wait(50);
    }
  };

  /**
   * Once Obsidian has saved the editor's text (its own debounce, ~2 s): whether the note on disk is the
   * editor's text and the map's source is that note, and per list line the depth the map gives it beside the
   * list level the editor's live preview draws it at. `reading` is Obsidian's metadata cache's parent line
   * for the same lines (negative for a top-level item) — recorded, not checked (see step 7).
   */
  const settle = () => evaluate(`${VIEW}
    const editorView = window.__mappyE2EEditor.view;
    const editorText = editorView.editor.getValue();
    const lineOf = (text, offset) => text.slice(0, offset).split('\\n').length - 1;
    for (let waited = 0; ; waited += 100) {
      const disk = await source();
      const doc = view.document;
      if ((disk === editorText && doc.source === disk) || waited > 8000) {
        const cm = editorView.editor.cm;
        const levels = {};
        for (const element of editorView.containerEl.querySelectorAll('.cm-line')) {
          const level = /HyperMD-list-line-(\\d+)/u.exec(element.className);
          if (level) levels[cm.state.doc.lineAt(cm.posAtDOM(element)).number - 1] = Number(level[1]);
        }
        const items = app.metadataCache.getFileCache(view.file)?.listItems ?? [];
        const reading = Object.fromEntries(items.map(item => [item.position.start.line, item.parent]));
        const byId = new Map(doc.nodes.map(node => [node.id, node]));
        const depth = node => { let d = 0; for (let at = node; at?.parentId && byId.has(at.parentId); at = byId.get(at.parentId)) d += 1; return d; };
        const lines = doc.nodes.filter(node => node.kind === 'list').map(node => {
          const line = lineOf(doc.source, node.from);
          return { title: node.title, line, text: disk.split('\\n')[line], map: depth(node), editor: levels[line] ?? null, reading: reading[line] ?? null };
        });
        return { waited, saved: disk === editorText, mapCurrent: doc.source === disk, lines };
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }`);

  /** The checks every editor step shares: saved, the map re-read it, and every list node's depth is the editor's list level. */
  const checkSettled = (settled, label) => {
    check(settled.saved, `${label}: the note on disk does not match the editor after 8 s`);
    check(settled.mapCurrent, `${label}: the map's source is not the saved note`);
    const disagreeing = settled.lines.filter(item => item.map !== item.editor);
    check(disagreeing.length === 0, `${label}: the map's depth is not the editor's list level for: ${JSON.stringify(disagreeing)}`);
  };

  // 7a. Tab: 階層9の兄弟 (column 16) moves 4 columns in, under 階層9 (content column 18), which has no
  // children — so it becomes 階層9's child at level 10.
  await step('editor-indent', async () => {
    const { before, sentAt } = await editorIndent('階層9の兄弟', false);
    const { nodes, ms } = await followed('階層9の兄弟', '階層9', sentAt);
    check(ms !== null, `the map did not re-parent 階層9の兄弟 under 階層9 within 3 s: ${JSON.stringify(nodes['階層9の兄弟'])}`);
    check(nodes['階層9の兄弟']?.depth === 10, `階層9の兄弟 should sit at depth 10: ${JSON.stringify(nodes['階層9の兄弟'])}`);
    const settled = await settle();
    const line = settled.lines.find(item => item.title === '階層9の兄弟')?.text;
    check(line !== before.split('\n').find(text => text.endsWith('- 階層9の兄弟')), 'Tab in the editor did not change the line');
    checkSettled(settled, 'Tab');
    return { ms, ...settled };
  });

  // 7b. Shift+Tab: back to column 16, under 階層8 at level 9.
  await step('editor-outdent', async () => {
    const { sentAt } = await editorIndent('階層9の兄弟', true);
    const { nodes, ms } = await followed('階層9の兄弟', '階層8', sentAt);
    check(ms !== null && nodes['階層9の兄弟']?.depth === 9, `Shift+Tab should bring 階層9の兄弟 back to depth 9 under 階層8: ${JSON.stringify(nodes['階層9の兄弟'])}`);
    const settled = await settle();
    checkSettled(settled, 'Shift+Tab');
    return { ms, ...settled };
  });

  // 7c. Shift+Tab again: column 12, 階層7's own column — its next sibling under 階層6 (level 7). 階層8の兄弟
  // (column 14) then falls inside 階層9の兄弟's content column and nests under it; that is CommonMark, and
  // the map has to agree with the editor about it too.
  await step('editor-outdent-again', async () => {
    const { sentAt } = await editorIndent('階層9の兄弟', true);
    const { nodes, ms } = await followed('階層9の兄弟', '階層6', sentAt);
    check(ms !== null && nodes['階層9の兄弟']?.depth === 7, `a second Shift+Tab should put 階層9の兄弟 at depth 7 under 階層6: ${JSON.stringify(nodes['階層9の兄弟'])}`);
    check(nodes['階層9']?.parent === '階層8' && nodes['階層8']?.parent === '階層7', 'outdenting 階層9の兄弟 moved 階層8 or 階層9');
    const settled = await settle();
    checkSettled(settled, 'the second Shift+Tab');
    const labels = (await state()).labels;
    check(labels.includes('階層9の兄弟') && labels.includes('階層8の兄弟'), 'the map no longer draws every item');
    return { ms, nodes, ...settled };
  });

  if (!flag('--keep')) {
    await step('clean', () => evaluate(`${VIEW}
      const file = view.file;
      window.__mappyE2EEditor?.detach();
      leaf.detach();
      if (file) await app.vault.delete(file, true);
      delete window.__mappyE2E;
      delete window.__mappyE2EBefore;
      delete window.__mappyE2EEditor;
      return { removed: file?.path ?? null };`));
  }
} finally {
  cdp.close();
}

process.exit(await finish(record, value('--json')));
