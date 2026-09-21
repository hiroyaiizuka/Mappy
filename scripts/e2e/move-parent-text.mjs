/**
 * E19 (docs/harness.md): a list item ("はじめに") with its own body both before and after its child
 * list. Moving a child with ⌥↑／⌥↓ must not carry the parent's trailing text away with it, and must
 * not reach past the child list into the parent's own siblings. `src/core/list-commands.ts`'s `move()`
 * swaps only the two neighbouring children's own `from`/`to` spans, which sit inside the parent's span
 * but end before its trailing text — this case drives that through the real keyboard.
 *
 * The trailing text only parses as the parent's own body, rather than lazy-continuing the last child's
 * paragraph (CommonMark), when a blank line separates it from the child list — the fixture keeps that
 * blank line for that reason.
 *
 * Also checks the row's other half: attaching an image to the parent does not touch the child list or
 * the trailing text (`attachImage`/`planAppendBody` write just before the first child).
 *
 * Usage: npm run harness:e2e:move-parent-text -- [--reload] [--json <out.json>] [--keep]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish } from './case-runner.mjs';
import { VIEW, makeSelect, makeState, makePluginStep, makeOpenStep, makePaste } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-move-parent-text.md';
const TRAILING = '子リストの後の本文です。前後の文が入れ替わりで消えないことを確認します。';
const LEADING = '子リストの前の本文です。';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 親本文を挟む移動の確認', '',
  '- はじめに',
  `  ${LEADING}`, '',
  '  - 学ぶこと',
  '  - 全体の流れ', '',
  `  ${TRAILING}`,
  '- 記録する',
  '  - 毎日のログ', '',
].join('\n');

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const paste = makePaste(evaluate);
const state = makeState(evaluate);

/** ⌥↑ or ⌥↓ on the selected node: modifiers bit 1 = Alt (scripts/e2e/cdp.mjs). Only sent with no draft open (docs/harness.md 実機検証). */
const moveAlt = async key => {
  const before = await state();
  if (before.editing) throw new Error(`${key} sent while a draft was open`);
  await cdp.realKey(key, 1);
  await wait(800);
  return state();
};

try {
  await step('plugin', makePluginStep(cdp, evaluate, flag));
  const opened = await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE }));
  const initial = opened.source;

  // 1. ⌥↓ on the first child: the two children swap, and はじめに's own trailing text is untouched.
  const afterDown = await step('move-down', async () => {
    await select('学ぶこと');
    const result = await moveAlt('ArrowDown');
    check(result.messages.length === 0, `⌥↓ showed ${JSON.stringify(result.messages)}`);
    // The exact byte-equality check above already pins the trailing text's one, unmoved occurrence;
    // nothing further to check here.
    const expected = initial.replace('  - 学ぶこと\n  - 全体の流れ\n', '  - 全体の流れ\n  - 学ぶこと\n');
    check(result.source === expected, `unexpected diff swapping the children:\nbefore: ${JSON.stringify(initial)}\nafter:  ${JSON.stringify(result.source)}`);
    return result;
  });

  // 2. Boundary: 学ぶこと is now the last child of はじめに, with no further sibling there — ⌥↓ must
  // be a no-op, not reach past the trailing text into 記録する.
  await step('move-down-boundary', async () => {
    await select('学ぶこと');
    const result = await moveAlt('ArrowDown');
    check(result.messages.length === 0, `⌥↓ at the boundary showed ${JSON.stringify(result.messages)}`);
    check(result.source === afterDown.source, `⌥↓ past the last child changed the document:\nbefore: ${JSON.stringify(afterDown.source)}\nafter:  ${JSON.stringify(result.source)}`);
    return result;
  });

  // 3. Boundary the other way: 全体の流れ is now the first child — ⌥↑ must be a no-op too (not swap
  // はじめに itself with 記録する at the top level).
  await step('move-up-boundary', async () => {
    await select('全体の流れ');
    const result = await moveAlt('ArrowUp');
    check(result.messages.length === 0, `⌥↑ at the boundary showed ${JSON.stringify(result.messages)}`);
    check(result.source === afterDown.source, `⌥↑ past the first child changed the document:\nbefore: ${JSON.stringify(afterDown.source)}\nafter:  ${JSON.stringify(result.source)}`);
    return result;
  });

  // 4. ⌥↑ back on 学ぶこと: the round trip returns exactly the document this case started from.
  await step('move-up', async () => {
    await select('学ぶこと');
    const result = await moveAlt('ArrowUp');
    check(result.messages.length === 0, `⌥↑ showed ${JSON.stringify(result.messages)}`);
    check(result.source === initial, `the round trip did not return to the original Markdown:\nexpected: ${JSON.stringify(initial)}\nactual:   ${JSON.stringify(result.source)}`);
    return result;
  });

  // 5. An image pasted onto はじめに (the parent, selected but not being edited) lands in its own
  // body, before the child list — the child list and the trailing text must not move.
  await step('attach-image', async () => {
    await select('はじめに');
    await paste('parent-body.png');
    await wait(2000);
    const result = await state();
    check(result.messages.length === 0, `the paste showed ${JSON.stringify(result.messages)}`);
    check(result.labels.filter(title => title === '学ぶこと' || title === '全体の流れ').length === 2,
      'both children of はじめに should still be on the map');
    check(result.source.includes(TRAILING), 'the parent\'s trailing text is missing after the image was attached');
    const imageMatch = result.source.match(/!\[\[parent-body[^\]]*\.png[^\]]*\]\]/u);
    check(!!imageMatch, 'the pasted image was not written into the note');
    if (imageMatch) {
      const firstChildAt = result.source.indexOf('- 学ぶこと');
      const trailingAt = result.source.indexOf(TRAILING);
      check(imageMatch.index < firstChildAt, 'the image should land in the parent\'s own body, before the child list');
      check(imageMatch.index < trailingAt, 'the image should not land after the parent\'s trailing text');
    }
    return result;
  });

  if (!flag('--keep')) {
    await step('clean', () => evaluate(`${VIEW}
      // Only what this run put there (E37's paste-image.mjs established the same before-snapshot pattern).
      const before = window.__mappyE2EBefore ?? new Set();
      const file = view.file;
      const attachments = app.vault.getFiles().filter(f => !before.has(f.path) && f.extension === 'png');
      leaf.detach();
      for (const attachment of attachments) await app.vault.delete(attachment, true);
      if (file) await app.vault.delete(file, true);
      delete window.__mappyE2E;
      delete window.__mappyE2EBefore;
      return { removed: [file?.path, ...attachments.map(f => f.path)].filter(Boolean) };`));
  }
} finally {
  cdp.close();
}

process.exit(await finish(record, value('--json')));
