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
import { connect, VAULT } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeSelect, makeState, makePluginStep, makeOpenStep, makeAddNamed, makeAfter } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-add-delete.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 追加と削除', '',
  '- 親', '  - 子1', '  - 子2',
  '- 記録する', '  - 毎日のログ', '',
].join('\n');

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const state = makeState(evaluate);

/** Enter or Tab on the selected node, then a title and Enter (`makeAddNamed`, dom-helpers.mjs). */
const addNamed = makeAddNamed(cdp, evaluate);
const after = makeAfter(evaluate);

try {
  await step('plugin', makePluginStep(cdp, evaluate, flag));
  const opened = required(record, 'open', await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE })));
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
    const before = (await state()).source;
    await cdp.realKey('Delete');
    const result = await after(before);
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
    const before = (await state()).source;
    await cdp.realKey('Delete');
    const result = await after(before);
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
      delete window.__mappyE2EBefore;
      return { removed: file?.path ?? null };`));
  }
} catch (error) {
  if (!(error instanceof StopCase)) throw error;
} finally {
  cdp.close();
}

process.exit(await finish(record, value('--json')));
