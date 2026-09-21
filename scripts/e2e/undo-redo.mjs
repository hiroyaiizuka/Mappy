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
import { connect, installedVersion, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish } from './case-runner.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-undo-redo.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## Undo・Redo の確認', '',
  '- 親', '  - 子1',
  '- 記録する', '',
].join('\n');

const VIEW = `const leaf = window.__mappyE2E; const view = leaf.view; const el = view.contentEl;
  const nodes = () => Array.from(el.querySelectorAll('.mappy-node'));
  const label = node => node.getAttribute('aria-label') ?? '';
  const nth = (title, index) => nodes().filter(node => label(node) === title)[index];
  const input = () => el.querySelector('textarea.mappy-inline-input');
  const messages = () => [
    ...Array.from(el.querySelectorAll('.mappy-inline-error'), item => item.textContent.trim()),
    ...Array.from(document.querySelectorAll('.notice'), item => item.textContent.trim()),
  ].filter(Boolean);`;

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);

/** Click a node until the map shows it selected: the first click after the view opens can land mid-layout. */
const select = async (title, index = 0) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const box = await evaluate(`${VIEW}
      const node = nth(${JSON.stringify(title)}, ${index});
      if (!node) throw new Error('No node ' + ${JSON.stringify(title)} + ' #' + ${index});
      const rect = node.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await wait(400);
    const selected = await evaluate(`${VIEW}
      return nth(${JSON.stringify(title)}, ${index})?.classList.contains('is-selected') ?? false;`);
    if (selected) return;
  }
  throw new Error(`The map would not select ${title} #${index}`);
};

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

/** What the map view shows: read from the note on disk, not a simulated diff (AGENTS.md: 実機で確かめる). */
const mapState = () => evaluate(`${VIEW}
  return { messages: messages(), editing: !!input(), labels: nodes().map(label), source: await app.vault.read(view.file) };`);

/** ⌘Z / ⌘⇧Z, on the canvas rather than a specific node (`MapEvents.keydown`: the history answers with nothing selected too). Only sent with no draft open (docs/harness.md 実機検証). */
const history = async direction => {
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
  await step('plugin', async () => {
    if (flag('--reload')) {
      await evaluate(`
        if (document.querySelector('.mappy-inline-input')) throw new Error('A draft is open in this window');
        if (typeof app.plugins.loadManifests === 'function') await app.plugins.loadManifests();
        await app.plugins.disablePlugin('mappy'); await app.plugins.enablePlugin('mappy');
        await new Promise(resolve => setTimeout(resolve, 800));
        return true;`);
    }
    const version = await installedVersion(cdp);
    if (version === null) throw new Error('Mappy is not loaded in this window (restricted mode?). Turn community plugins on and retry.');
    return { version, reloaded: flag('--reload') };
  });

  const opened = await step('open', () => evaluate(`
    const existing = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
    if (existing) await app.vault.modify(existing, ${JSON.stringify(SOURCE)});
    else await app.vault.create(${JSON.stringify(NOTE)}, ${JSON.stringify(SOURCE)});
    await new Promise(resolve => setTimeout(resolve, 400));
    const opened = app.workspace.getLeaf('tab');
    await opened.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(NOTE)}, layout: 'mindmap' }, active: true });
    await new Promise(resolve => setTimeout(resolve, 1500));
    app.workspace.setActiveLeaf(opened, { focus: true });
    window.__mappyE2E = opened;
    ${VIEW}
    return { labels: nodes().map(label), source: await app.vault.read(opened.view.file) };`));
  const initial = opened.source;

  // 編集 (F2 rename, one history entry).
  const afterEdit = await step('edit', async () => {
    await select('子1');
    const result = await rename('子1改');
    check(result.messages.length === 0, `F2 rename showed ${JSON.stringify(result.messages)}`);
    check(result.labels.includes('子1改') && !result.labels.includes('子1'), 'the map does not show the renamed node');
    check(result.source !== initial, 'the rename did not change the note');
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
    await step('clean', () => evaluate(`
      const leaf = window.__mappyE2E; const file = leaf.view.file;
      leaf.detach();
      if (file) await app.vault.delete(file, true);
      delete window.__mappyE2E;
      return { removed: file?.path ?? null };`));
  }
} finally {
  cdp.close();
}

process.exit(await finish(record, value('--json')));
