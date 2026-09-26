/**
 * E37 (docs/harness.md): paste an image onto a node, twice, on the real Obsidian.
 *
 * The steps are the ones the user actually performs, because that is what broke twice: an image pasted
 * onto a node leaves that node with no title, so the next paste happens on a map that already holds an
 * untitled node. Matched by title, every untitled node is the same node, and the ids used to be reassigned
 * on each write — the draft then lost its node and the map answered
 * 「編集していたノードが Markdown 側で見つかりません。マップでノードを選び直してください。」 (LEV-146; the same
 * failure for repeated titles was LEV-142). The case also watches what the map shows: the image has to be on
 * the node the moment it is pasted, while its text is still being edited. `tests/ui/mindmap-view-paste.test.ts`
 * holds this matrix in jsdom; this case runs it through the real write path, watcher and renderer.
 *
 * Usage (see docs/harness.md 実機検証 for the Obsidian instance):
 *   npm run harness:e2e:paste -- [--reload] [--json <out.json>] [--shot <out.png>] [--keep]
 *   --reload  re-enable the plugin first, so a build made after Obsidian started is the one under test
 *   --keep    leave the note and its attachments in the vault
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep, makeOpenStep, makePaste } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-paste-image.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 画像を貼る', '',
  '- はじめに', '  - 学ぶこと',
  '- 記録する', '  - 毎日のログ', '',
].join('\n');

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const paste = makePaste(evaluate);

/**
 * Tab: a new child, named in place (LEV-203: written as 「サブトピック」 and opened with that name selected). With
 * `clear`, Backspace takes the selected name, so the node the case pastes onto can be confirmed untitled.
 */
const addChild = async (clear = false) => {
  await cdp.realKey('Tab');
  await wait(1200);
  const editing = await evaluate(`${VIEW} return !!input();`);
  if (!editing) throw new Error('Tab did not open the inline editor on a new child');
  if (clear) {
    await cdp.realKey('Backspace');
    await wait(300);
  }
};
const state = () => evaluate(`${VIEW}
  // What the node being edited actually shows: an image pasted onto it has to be on screen right away, not
  // once the draft is confirmed (報告: 2026-09-22). A box with no height is drawn but not visible.
  const editingNode = el.querySelector('.mappy-node.is-editing');
  const shownImages = editingNode === null ? 0
    : Array.from(editingNode.querySelectorAll('.mappy-node-attachments img, .mappy-node-attachments .image-embed'))
      .filter(item => item.getBoundingClientRect().height >= 8).length;
  return { messages: messages(), editing: !!input(), shownImages, labels: nodes().map(label), source: await source() };`);

try {
  await step('plugin', makePluginStep(cdp, evaluate, flag));
  required(record, 'open', await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE })));

  // 1. The user's operation as reported: a new node, an image pasted onto it, and Escape. Since LEV-203 the node is
  // written as 「サブトピック」; the paste wrote its body, so Escape gives up the draft only and the node keeps that name.
  await step('first-paste', async () => {
    await select('記録する');
    await addChild();
    await paste('first.png');
    await wait(2500);
    const after = await state();
    await cdp.realKey('Escape');
    await wait(600);
    const settled = await state();
    check(after.messages.length === 0, `first paste showed ${JSON.stringify(after.messages)}`);
    check(after.shownImages >= 1, 'the first image is not drawn on the node while its text is being edited');
    check(settled.messages.length === 0, `Escape showed ${JSON.stringify(settled.messages)}`);
    check(/- サブトピック\n\n? *!\[\[first[^\]]*\.png\]\]/u.test(settled.source), 'the node with the first image did not stay as 「サブトピック」');
    return { after, settled };
  });

  // 1b. The untitled shape LEV-142 and LEV-146 broke on: the provisional name cleared, an image pasted, Enter.
  await step('untitled-paste', async () => {
    await select('学ぶこと');
    await addChild(true);
    await paste('untitled.png');
    await wait(2500);
    const after = await state();
    await cdp.realKey('Enter');
    await wait(600);
    const settled = await state();
    check(after.messages.length === 0, `the untitled paste showed ${JSON.stringify(after.messages)}`);
    check(after.shownImages >= 1, 'the image is not drawn on the untitled node while its text is being edited');
    check(/!\[\[untitled[^\]]*\.png\]\]/u.test(settled.source), 'the image was not written into the note');
    check(settled.labels.includes('空のノード'), 'the node that took the image should be untitled');
    return { after, settled };
  });

  // 2. The same again, with that untitled node still on the map: the shape that failed on 0.3.1 and 0.3.2.
  await step('second-paste', async () => {
    await select('はじめに');
    await addChild();
    await paste('second.png');
    await wait(2500);
    const afterPaste = await state();
    // The frame the report is about: the image on the node, the draft still open.
    const shot = value('--shot');
    if (shot) await cdp.screenshot(shot);
    await cdp.insertText('二枚目の話');
    await wait(300);
    await cdp.realKey('Enter');
    await wait(2000);
    const afterEnter = await state();
    check(afterPaste.messages.length === 0, `second paste showed ${JSON.stringify(afterPaste.messages)}`);
    check(afterPaste.shownImages >= 1, 'the second image is not drawn on the node while its text is being edited');
    check(afterEnter.messages.length === 0, `confirming the title showed ${JSON.stringify(afterEnter.messages)}`);
    check(!afterEnter.editing, 'the inline editor should have closed on Enter');
    check(afterEnter.source.includes('- 二枚目の話'), 'the title was not written into the note');
    check(/!\[\[second[^\]]*\.png\]\]/u.test(afterEnter.source), 'the second image was not written into the note');
    check(afterEnter.labels.includes('二枚目の話'), 'the map does not show the named node');
    return { afterPaste, afterEnter };
  });

  if (!flag('--keep')) {
    await step('clean', () => evaluate(`${VIEW}
      // Only what this run put there: Obsidian names a colliding attachment "first 1.png", and whatever the
      // vault already held is not the case's to tidy.
      const before = window.__mappyE2EBefore ?? new Set();
      const attachments = app.vault.getFiles().filter(file => !before.has(file.path) && file.extension === 'png');
      for (const file of [...attachments, view.file]) await app.vault.delete(file, true);
      leaf.detach();
      delete window.__mappyE2E;
      delete window.__mappyE2EBefore;
      return { removed: attachments.map(file => file.path) };`));
  }
} catch (error) {
  if (!(error instanceof StopCase)) throw error;
} finally {
  cdp.close();
}

process.exit(await finish(record, value('--json')));
