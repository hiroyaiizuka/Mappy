/**
 * E02 (docs/harness.md): select a node, add a sibling with Enter and a child with Tab, name each in
 * place, then Delete both. The commands are what `src/ui/map-events.ts` wires the keys to
 * (`add-sibling`/`add-child`/`delete`), and each step's Markdown is byte-compared to the step before —
 * an inserted item must be the only change, and removing a middle item must not leave the blank line
 * LEV-75 fixed (`tests/core/list-commands.test.ts`「delete removes the item's lines without leaving a
 * blank line」). The whole round trip (add sibling, add child, delete child, delete sibling) is checked
 * byte-for-byte against the note this case started from.
 *
 * Usage: npm run harness:e2e:add-delete -- [--reload] [--json <out.json>] [--keep]
 */
import { connect, installedVersion, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish } from './case-runner.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-add-delete.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 追加と削除', '',
  '- 親', '  - 子1', '  - 子2',
  '- 記録する', '  - 毎日のログ', '',
].join('\n');

const VIEW = `const leaf = window.__mappyE2E; const view = leaf.view; const el = view.contentEl;
  const nodes = () => Array.from(el.querySelectorAll('.mappy-node'));
  const label = node => node.getAttribute('aria-label') ?? '';
  const nth = (title, index) => nodes().filter(node => label(node) === title)[index];
  const input = () => el.querySelector('textarea.mappy-inline-input');
  const messages = () => [
    ...Array.from(el.querySelectorAll('.mappy-inline-error'), item => item.textContent.trim()),
    ...Array.from(document.querySelectorAll('.notice'), item => item.textContent.trim()),
  ].filter(Boolean);
  const source = () => app.vault.read(view.file);`;

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

const state = () => evaluate(`${VIEW}
  return { messages: messages(), editing: !!input(), labels: nodes().map(label), source: await source() };`);

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
    return { labels: nodes().map(label), source: await source() };`));
  const initial = opened.source;

  // 1. Enter on 子1: a new sibling between 子1 and 子2, named in place. A tight list, so the only
  // change should be the one inserted line — no blank line appears around it.
  const afterSibling = await step('add-sibling', async () => {
    await select('子1');
    const result = await addNamed('Enter', '新しい兄弟');
    check(result.messages.length === 0, `Enter showed ${JSON.stringify(result.messages)}`);
    check(!result.editing, 'the inline editor should have closed on Enter');
    check(result.labels.includes('新しい兄弟'), 'the map does not show the new sibling');
    const expected = initial.replace('  - 子1\n', '  - 子1\n  - 新しい兄弟\n');
    check(result.source === expected, `unexpected diff adding the sibling:\nbefore: ${JSON.stringify(initial)}\nafter:  ${JSON.stringify(result.source)}`);
    return result;
  });

  // 2. Tab on the new sibling: one level deeper, named in place.
  await step('add-child', async () => {
    await select('新しい兄弟');
    const result = await addNamed('Tab', '新しい子');
    check(result.messages.length === 0, `Tab showed ${JSON.stringify(result.messages)}`);
    check(!result.editing, 'the inline editor should have closed on Enter');
    check(result.labels.includes('新しい子'), 'the map does not show the new child');
    const expected = afterSibling.source.replace('  - 新しい兄弟\n', '  - 新しい兄弟\n    - 新しい子\n');
    check(result.source === expected, `unexpected diff adding the child:\nbefore: ${JSON.stringify(afterSibling.source)}\nafter:  ${JSON.stringify(result.source)}`);
    return result;
  });

  // 3. Delete the child: back to the state right after step 1, byte for byte.
  await step('delete-child', async () => {
    await select('新しい子');
    await cdp.realKey('Delete');
    await wait(800);
    const result = await state();
    check(result.messages.length === 0, `Delete showed ${JSON.stringify(result.messages)}`);
    check(!result.labels.includes('新しい子'), 'the deleted child is still on the map');
    check(result.source === afterSibling.source, `Delete left the list different from before the child was added:\nexpected: ${JSON.stringify(afterSibling.source)}\nactual:   ${JSON.stringify(result.source)}`);
    check(!result.source.includes('\n\n\n'), 'a stray blank line was left in the list');
    return result;
  });

  // 4. Delete the sibling (a middle item, between 子1 and 子2 — the LEV-75 shape): back to the
  // document this case started from, byte for byte.
  await step('delete-sibling', async () => {
    await select('新しい兄弟');
    await cdp.realKey('Delete');
    await wait(800);
    const result = await state();
    check(result.messages.length === 0, `Delete showed ${JSON.stringify(result.messages)}`);
    check(!result.labels.includes('新しい兄弟'), 'the deleted sibling is still on the map');
    check(result.source === initial, `the round trip did not return to the original Markdown:\nexpected: ${JSON.stringify(initial)}\nactual:   ${JSON.stringify(result.source)}`);
    check(!result.source.includes('\n\n\n'), 'a stray blank line was left in the list');
    return result;
  });

  if (!flag('--keep')) {
    await step('clean', () => evaluate(`${VIEW}
      const file = view.file;
      leaf.detach();
      if (file) await app.vault.delete(file, true);
      delete window.__mappyE2E;
      return { removed: file?.path ?? null };`));
  }
} finally {
  cdp.close();
}

process.exit(await finish(record, value('--json')));
