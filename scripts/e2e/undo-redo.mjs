/**
 * E03 (docs/harness.md): one edit, ⌘Z, ⌘⇧Z, a round trip through "マップと Markdown を切り替え"
 * (`mappy:toggle-mindmap`), then ⌘Z／⌘⇧Z again. The history lives in `DocumentStore`
 * (`src/obsidian/document-store.ts`), shared by every view on the note; toggling only swaps which view
 * sits on the leaf (`showSource`/`main.ts`'s `open`) and never touches the store, so this checks that
 * undo/redo after the round trip still applies the one edit exactly once each way — not zero times
 * (lost) and not twice (LEV-16, never committed as a re-runnable case before this one).
 *
 * The edit is an F2 rename rather than Tab/Enter's add-then-name: `InlineEditor` commits the empty add
 * and the typed title as two separate `store.apply()` calls (confirmed by running this case with that
 * shape first — one ⌘Z only undid the title, landing back on an empty node), so a rename is the one
 * that matches the row's "編集→Undo→Redo" — a single history entry.
 *
 * Usage: npm run harness:e2e:undo-redo -- [--reload] [--json <out.json>] [--keep]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish } from './case-runner.mjs';
import { VIEW, makeSelect, makeState, makeFocusCanvas, makePluginStep, makeOpenStep } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-undo-redo.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## Undo・Redo の確認', '',
  '- 親', '  - 子1',
  '- 記録する', '',
].join('\n');

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const focusCanvas = makeFocusCanvas(cdp, evaluate);
const mapState = makeState(evaluate);

/**
 * F2 on the selected node: the inline editor opens with its current title selected (`InlineEditor`'s
 * constructor calls `input.select()`), so typing replaces it outright. One `commit()`, one history entry.
 */
const rename = async title => {
  await cdp.realKey('F2');
  await wait(1000);
  const editing = await evaluate(`${VIEW} return !!input();`);
  if (!editing) throw new Error('F2 did not open the inline editor');
  await cdp.insertText(title);
  await wait(300);
  await cdp.realKey('Enter');
  await wait(1000);
  return mapState();
};

/**
 * ⌘Z / ⌘⇧Z, on the canvas rather than a specific node (`MapEvents.keydown`: the history answers with
 * nothing selected too). A blank click first puts focus back in the canvas — after a toggle round trip
 * (`showSource`'s `editor.focus()`, then the map's own async refocus) it is not guaranteed to be there,
 * and the chord is only ever caught by the map's `keydown` listener while it is (docs/harness.md 実機検証:
 * otherwise it reaches macOS and CDP hangs on the native dialog). Only sent with no draft open.
 */
const history = async direction => {
  await focusCanvas();
  const before = await mapState();
  if (before.editing) throw new Error(`${direction} sent while a draft was open`);
  await cdp.realKey('z', direction === 'redo' ? 12 : 4);
  await wait(1000);
  return mapState();
};

const toggle = () => evaluate(`
  const before = window.__mappyE2E.view.getViewType();
  await app.commands.executeCommandById('mappy:toggle-mindmap');
  await new Promise(resolve => setTimeout(resolve, 1000));
  const leaf = window.__mappyE2E; const view = leaf.view;
  return {
    before, after: view.getViewType(),
    diskSource: await app.vault.read(view.file),
    editorSource: view.getViewType() === 'markdown' ? view.editor.getValue() : null,
  };`);

try {
  await step('plugin', makePluginStep(cdp, evaluate, flag));
  const opened = await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE }));
  const initial = opened.source;

  // 編集 (F2 rename, one history entry). The expected text is computed independently of what the map
  // reports, so a rename that corrupts something other than the title (indentation, the EOF newline,
  // frontmatter) still fails here instead of quietly becoming the new "expected" for every later step.
  const afterEdit = await step('edit', async () => {
    await select('子1');
    const result = await rename('子1改');
    check(result.messages.length === 0, `F2 rename showed ${JSON.stringify(result.messages)}`);
    check(result.labels.includes('子1改') && !result.labels.includes('子1'), 'the map does not show the renamed node');
    const expected = initial.replace('  - 子1\n', '  - 子1改\n');
    check(result.source === expected, `unexpected diff renaming the node:\nbefore: ${JSON.stringify(initial)}\nafter:  ${JSON.stringify(result.source)}`);
    return result;
  });

  // Undo → Redo.
  await step('undo', async () => {
    const result = await history('undo');
    check(result.messages.length === 0, `⌘Z showed ${JSON.stringify(result.messages)}`);
    check(result.source === initial, `⌘Z did not return to the original document:\nexpected: ${JSON.stringify(initial)}\nactual:   ${JSON.stringify(result.source)}`);
    return result;
  });
  await step('redo', async () => {
    const result = await history('redo');
    check(result.messages.length === 0, `⌘⇧Z showed ${JSON.stringify(result.messages)}`);
    check(result.source === afterEdit.source, `⌘⇧Z did not redo the rename:\nexpected: ${JSON.stringify(afterEdit.source)}\nactual:   ${JSON.stringify(result.source)}`);
    return result;
  });

  // 表裏切替: neither direction touches DocumentStore's history (src/obsidian/document-store.ts),
  // only which view is on the leaf.
  await step('toggle-to-markdown', async () => {
    const result = await toggle();
    check(result.after === 'markdown', `expected the Markdown view, got ${result.after}`);
    check(result.diskSource === afterEdit.source, 'the note changed just from switching to Markdown');
    check(result.editorSource === afterEdit.source, 'the Markdown editor does not show the same text as the map did');
    return result;
  });
  await step('toggle-to-map', async () => {
    const result = await toggle();
    check(result.after === 'mappy-map', `expected the map view, got ${result.after}`);
    check(result.diskSource === afterEdit.source, 'the note changed just from switching back to the map');
    return result;
  });

  // The round trip must not have doubled or dropped the one history entry: undo and redo each still
  // apply exactly once.
  await step('undo-after-toggle', async () => {
    const result = await history('undo');
    check(result.messages.length === 0, `⌘Z showed ${JSON.stringify(result.messages)}`);
    check(result.source === initial, `⌘Z after the round trip did not return to the original document in one step:\nexpected: ${JSON.stringify(initial)}\nactual:   ${JSON.stringify(result.source)}`);
    return result;
  });
  await step('redo-after-toggle', async () => {
    const result = await history('redo');
    check(result.messages.length === 0, `⌘⇧Z showed ${JSON.stringify(result.messages)}`);
    check(result.source === afterEdit.source, `⌘⇧Z after the round trip did not redo the rename exactly once:\nexpected: ${JSON.stringify(afterEdit.source)}\nactual:   ${JSON.stringify(result.source)}`);
    return result;
  });
  // One further redo must be a no-op: the stack is exhausted, not somehow re-armed by the round trip.
  await step('redo-exhausted', async () => {
    const result = await history('redo');
    check(result.messages.length === 0, `⌘⇧Z showed ${JSON.stringify(result.messages)}`);
    check(result.source === afterEdit.source, `a redo past the end of the stack changed the document:\nexpected: ${JSON.stringify(afterEdit.source)}\nactual:   ${JSON.stringify(result.source)}`);
    return result;
  });

  if (!flag('--keep')) {
    await step('clean', () => evaluate(`${VIEW}
      const file = view.file;
      leaf.detach();
      if (file) await app.vault.delete(file, true);
      delete window.__mappyE2E;
      delete window.__mappyE2EBefore;
      return { removed: file?.path ?? null };`));
  }
} finally {
  cdp.close();
}

process.exit(await finish(record, value('--json')));
