/**
 * E18 (docs/harness.md): a map note in the old heading format (H1 root, H2–H6 below it, body text under some
 * headings, two sections with the same name) is not converted by opening it; the explicit command
 * 「現在のマップをリスト形式に変更」 (`mappy:convert-to-list` → `src/core/list-conversion.ts`'s
 * `planListConversion`) rewrites the headings into H2 + nested list items in place, keeping every title and
 * parent; ⌘Z restores the original bytes and ⌘⇧Z applies the conversion again.
 *
 * Around it, the two halves of product-plan M2's row: in the heading format a child under the H6 is refused
 * (「従来の形式で H6 を超える見出しを生成せず」, `src/core/commands.ts`) without touching the note, and after
 * the conversion the same Tab on the same node adds a seventh level as a list item.
 *
 * The structure compared before and after is the map's own parse (`view.document`): each node's title and
 * the title of its parent, in document order — which is what "同じタイトル・構造" means on the map.
 *
 * Usage: npm run harness:e2e:convert-to-list -- [--reload] [--json <out.json>] [--keep]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import {
  VIEW, makeSelect, makeState, makeFocusCanvas, makePluginStep, makeOpenStep, makeMarkSeen, makeAfter, makeAddNamed,
  makeHistory, makeTree,
} from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-convert-to-list.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '# 旧形式のマップ',
  '本文の段落です。', '',
  '## 第1章',
  '第1章の本文。', '',
  '### 節A',
  '#### 項目',
  '##### 細目',
  '###### 最深',
  '最深の本文。', '',
  '### 節A',
  '## 第2章',
  '### まとめ', '',
].join('\n');
/** The note after the conversion: the single H1 becomes the H2 section, each heading a list item nested by its level, body lines indented under their item, blank lines left as they were. */
const CONVERTED = [
  '---', 'mappy: true', '---',
  '## 旧形式のマップ',
  '本文の段落です。', '',
  '- 第1章',
  '  第1章の本文。', '',
  '  - 節A',
  '    - 項目',
  '      - 細目',
  '        - 最深',
  '          最深の本文。', '',
  '  - 節A',
  '- 第2章',
  '  - まとめ', '',
].join('\n');
const CONVERTED_NOTICE = 'H2 とリストの形式に変更しました。元に戻す操作で復元できます。';
/** `src/core/commands.ts`'s add-child guard — not its move guard 「見出しは子孫を含めて 6 階層までです。」. */
const H6_REFUSAL = '見出しは 6 階層までです。';

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const focusCanvas = makeFocusCanvas(cdp, evaluate);
const state = makeState(evaluate);
const markSeen = makeMarkSeen(evaluate);
const after = makeAfter(evaluate);
const addNamed = makeAddNamed(cdp, evaluate);
const history = makeHistory(cdp, evaluate);

const readTree = makeTree(evaluate);
/** The map's own parse (`makeTree`): its format, and each node as `title ← parent title` in document order. */
const structure = async () => {
  const { format, nodes } = await readTree();
  return { format, nodes: nodes.map(node => `${node.title} ← ${node.parent}`) };
};

/** The note this run opened; `clean` runs once it is set, whether the case finished or stopped. */
let opened;
const clean = () => step('clean', () => evaluate(`${VIEW}
  const file = view.file;
  leaf.detach();
  if (file) await app.vault.delete(file, true);
  delete window.__mappyE2E;
  delete window.__mappyE2EBefore;
  return { removed: file?.path ?? null };`));

try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  opened = required(record, 'open', await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE })));

  // 1. Opening is not converting: the note stays exactly as written, and the map reads it as headings.
  const original = await step('open-unchanged', async () => {
    await wait(1500);
    const result = await state();
    check(result.source === SOURCE, `opening the map changed the note:\nexpected: ${JSON.stringify(SOURCE)}\nactual:   ${JSON.stringify(result.source)}`);
    check(opened.source === SOURCE, 'the note was not written as the fixture');
    const shape = await structure();
    check(shape.format === 'headings', `the map should read the note as the heading format, not ${shape.format}`);
    return { ...result, shape };
  });

  // 2. Heading format: Tab on the H6 is refused with the add-child guard's message, no draft opens, the note
  // is untouched. (The right answer is that nothing changes, so this waits out `after`'s whole timeout.)
  await step('h6-child-refused', async () => {
    await select('最深');
    await markSeen();
    await cdp.realKey('Tab');
    const result = await after(SOURCE, 1500);
    check(!result.editing, 'Tab on an H6 opened a draft');
    check(JSON.stringify(result.messages) === JSON.stringify([H6_REFUSAL]), `Tab on an H6 should show only 「${H6_REFUSAL}」, showed ${JSON.stringify(result.messages)}`);
    check(result.source === SOURCE, `Tab on an H6 changed the note:\n${JSON.stringify(result.source)}`);
    return result;
  });

  // 3. The command: headings become H2 + list items, same titles, same parents.
  const converted = await step('convert', async () => {
    await focusCanvas();
    await markSeen();
    await evaluate(`app.workspace.setActiveLeaf(window.__mappyE2E, { focus: true });
      if (!app.commands.executeCommandById('mappy:convert-to-list')) throw new Error('mappy:convert-to-list was not available');
      return true;`);
    const result = await after(SOURCE);
    check(JSON.stringify(result.messages) === JSON.stringify([CONVERTED_NOTICE]), `the conversion should show only its own notice, showed ${JSON.stringify(result.messages)}`);
    check(result.source === CONVERTED, `unexpected conversion:\nexpected: ${JSON.stringify(CONVERTED)}\nactual:   ${JSON.stringify(result.source)}`);
    const shape = await structure();
    check(shape.format === 'list', `the map should read the converted note as the list format, not ${shape.format}`);
    check(JSON.stringify(shape.nodes) === JSON.stringify(original.shape.nodes), `the conversion changed titles or parents:\nbefore: ${JSON.stringify(original.shape.nodes)}\nafter:  ${JSON.stringify(shape.nodes)}`);
    return { ...result, shape };
  });

  // 4. ⌘Z: the original heading-format note, byte for byte, and the same structure.
  await step('undo', async () => {
    await markSeen();
    const result = await history('undo');
    check(result.messages.length === 0, `⌘Z showed ${JSON.stringify(result.messages)}`);
    check(result.source === SOURCE, `⌘Z did not restore the heading-format note:\nexpected: ${JSON.stringify(SOURCE)}\nactual:   ${JSON.stringify(result.source)}`);
    const shape = await structure();
    check(shape.format === 'headings', `after ⌘Z the map should read headings again, not ${shape.format}`);
    check(JSON.stringify(shape.nodes) === JSON.stringify(original.shape.nodes), `⌘Z changed titles or parents:\nbefore: ${JSON.stringify(original.shape.nodes)}\nafter:  ${JSON.stringify(shape.nodes)}`);
    return { ...result, shape };
  });

  // 5. ⌘⇧Z: the conversion again, the same bytes as the command wrote.
  await step('redo', async () => {
    await markSeen();
    const result = await history('redo');
    check(result.messages.length === 0, `⌘⇧Z showed ${JSON.stringify(result.messages)}`);
    check(result.source === converted.source, `⌘⇧Z did not re-apply the conversion:\nexpected: ${JSON.stringify(converted.source)}\nactual:   ${JSON.stringify(result.source)}`);
    return result;
  });

  // 6. List format: the Tab refused in step 2 now adds a seventh level under 最深, as a list item.
  await step('seventh-level', async () => {
    await select('最深');
    await markSeen();
    const result = await addNamed('Tab', '7段目');
    check(result.messages.length === 0, `Tab showed ${JSON.stringify(result.messages)}`);
    const expected = CONVERTED.replace('          最深の本文。\n', '          最深の本文。\n          - 7段目\n');
    check(result.source === expected, `unexpected diff adding the seventh level:\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(result.source)}`);
    const shape = await structure();
    check(shape.nodes.includes('7段目 ← 最深'), `7段目 should be 最深's child: ${JSON.stringify(shape.nodes)}`);
    return result;
  });

} catch (error) {
  if (!(error instanceof StopCase)) throw error;
} finally {
  // Also after a stop: a map left on the note would make the next run refuse to open it (makeOpenStep).
  if (opened && !flag('--keep')) await clean();
  cdp.close();
}

process.exit(await finish(record, value('--json')));
