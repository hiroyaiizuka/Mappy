/**
 * E41 削除後の選択（LEV-204）: Delete／Backspace のあと、選択は 1 つ上の兄弟 → なければ 1 つ下の兄弟 → なければ
 * 親へ移る（原文順。左右バランスでも画面の上下ではない）。行列は本人の操作（Delete・Backspace を実キーで）× 対象の形
 * （末尾・中間・先頭・一人っ子の項目、呼び出し項目 `![[…]]`、フリートピックの中の項目、隣にトピックがあるトピックの
 * ルートと一つだけのトピックのルート、本体のルート、H2 のない本体の項目とその隣のトピック、見出し形式の見出しと H1 の
 * 区画）× 4 レイアウト。各削除のあと ⌘Z で消えたノードが戻り原文がバイト一致すること、選択が削除のときに移した
 * ノードに残ることも見る。最後に、選択先が画面の外にあるとき削除で表示の中へ入ることを見る。
 *
 * 選択は `src/core/commands.ts` の `selectionAfterDelete` が決め（見出し形式・リスト形式の両方の `delete` が使う）、
 * view の `reveal` が折りたたみを開いて選択・表示する。修正前のビルド（常に親）で走らせた結果は docs/harness.md の
 * 「E2E ケース一覧」の行に書く。
 *
 * Usage: npm run harness:e2e:delete-selection -- [--reload] [--json <out.json>] [--keep]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeSelect, makeState, makePluginStep, makeOpenStep, makeAfter, makeMarkSeen } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-delete-selection.md';
const CALLED = 'Fixtures/E2E-delete-selection-called.md';
const CALLED_SOURCE = ['---', 'mappy: true', '---', '## 呼び出し先', '- 中身', ''].join('\n');
const note = (...lines) => ['---', 'mappy: true', '---', ...lines, ''].join('\n');
// The report (LEV-204): the parent had three children and the last one, 「aaaa」, was deleted.
const SOURCE = note(
  '## 注意残余の対策',
  '- 作業途中で、ひと言メモを残す',
  '- aaaaaaaa',
  '- aaaa',
  '- 次の枝',
  '  - 一人っ子',
  '- ![[E2E-delete-selection-called]]',
  '', '## トピック', '- t1', '- t2',
  '', '## トピック2',
);
/**
 * Each note × each layout, one row at a time: [what is deleted, what must be selected after]. The key alternates
 * by row and by layout (`keyFor`), so over the four layouts every shape is pressed with Delete twice and with
 * Backspace twice. Every row is undone before the next, so each starts from the note as written here.
 */
const NOTES = [
  {
    name: 'report', path: NOTE, source: SOURCE, rows: [
      ['aaaa', 'aaaaaaaa'],
      ['aaaaaaaa', '作業途中で、ひと言メモを残す'],
      ['作業途中で、ひと言メモを残す', 'aaaaaaaa'],
      ['一人っ子', '次の枝'],
      // The calling item shows the called map's root title (§5 M12); the item itself is deletable, its branch goes with it.
      ['呼び出し先', '次の枝'],
      // Items inside a free topic, then the topic roots: siblings of each other, never the body between them.
      ['t2', 't1'],
      ['t1', 't2'],
      ['トピック2', 'トピック'],
      ['トピック', 'トピック2'],
      // The body root goes: the first topic below takes its place.
      ['注意残余の対策', 'トピック'],
    ],
  },
  {
    // The only topic: no topic beside it, so the body root, which stands for the topics' parent on the map.
    name: 'only-topic', path: 'Fixtures/E2E-delete-selection-topic.md',
    source: note('## 本体', '- b', '', '## 一つだけのトピック', '- t'),
    rows: [['一つだけのトピック', '本体']],
  },
  {
    // A body without an H2: its items sit on the virtual root, which is never selected, beside the topic.
    name: 'virtual-body', path: 'Fixtures/E2E-delete-selection-virtual.md',
    source: note('- a', '- b', '', '## T', '- t'),
    rows: [['b', 'a'], ['a', 'b'], ['T', 'b']],
  },
  {
    // The headings format, two H1 sections: the second is a free topic of the first.
    name: 'headings', path: 'Fixtures/E2E-delete-selection-headings.md',
    source: note('# 見出し', '', '## A', '', '## B', '', '## C', '', '# 二つ目'),
    rows: [['C', 'B'], ['A', 'B'], ['B', 'A'], ['二つ目', '見出し'], ['見出し', '二つ目']],
  },
];
const LAYOUTS = ['mindmap', 'timeline', 'hierarchy', 'balanced'];
const keyFor = (row, pass) => (row + pass) % 2 === 0 ? 'Delete' : 'Backspace';

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const state = makeState(evaluate);
const after = makeAfter(evaluate);
const markSeen = makeMarkSeen(evaluate);

/** The selected node's title, whether the focus is in the map, and whether it is drawn inside the canvas. */
const selection = () => evaluate(`${VIEW}
  const chosen = nodes().filter(node => node.classList.contains('is-selected'));
  const canvas = el.querySelector('.mappy-canvas');
  const box = canvas.getBoundingClientRect();
  const rect = chosen[0]?.getBoundingClientRect();
  return {
    titles: chosen.map(label),
    focused: canvas.contains(document.activeElement) && !input(),
    inside: !!rect && rect.top >= box.top && rect.bottom <= box.bottom && rect.left >= box.left && rect.right <= box.right,
  };`);

/**
 * ⌘Z with the focus where the delete left it (the selected node): no blank click first, so the selection is the
 * one the delete made. Not sent unless the focus is in the map and no draft is open — a modified key that reaches
 * macOS instead opens a native dialog and hangs CDP (docs/harness.md 実機検証). Then the row is recorded as a
 * failure and the note is written back, so the rows after it still run on the note they were written for.
 */
async function undo(before, initial, what) {
  const now = await selection();
  check(now.focused, `${what}: the focus is not in the map after the delete; ⌘Z not sent, the note was written back`);
  if (!now.focused) {
    await evaluate(`${VIEW} await app.vault.modify(view.file, ${JSON.stringify(initial)}); return true;`);
    return { ...await after(before), undoSent: false };
  }
  await cdp.realKey('z', 4);
  return { ...await after(before), undoSent: true };
}

async function deleteRow(initial, [title, expected], key, layout) {
  await select(title);
  await markSeen();
  const before = (await state()).source;
  await cdp.realKey(key);
  const result = await after(before);
  const chosen = await selection();
  check(result.messages.length === 0, `${layout} ${key} ${title}: showed ${JSON.stringify(result.messages)}`);
  check(!result.labels.includes(title), `${layout} ${key} ${title}: the node is still on the map`);
  check(JSON.stringify(chosen.titles) === JSON.stringify([expected]), `${layout} ${key} ${title}: selected ${JSON.stringify(chosen.titles)}, expected ${expected}`);
  check(chosen.inside, `${layout} ${key} ${title}: the selected node is not inside the canvas`);
  const undone = await undo(result.source, initial, `${layout} ${key} ${title}`);
  const kept = await selection();
  check(undone.source === initial, `${layout} ${key} ${title}: ⌘Z did not restore the note byte for byte`);
  check(undone.labels.includes(title), `${layout} ${key} ${title}: ⌘Z did not bring the node back`);
  check(JSON.stringify(kept.titles) === JSON.stringify([expected]), `${layout} ${key} ${title}: after ⌘Z selected ${JSON.stringify(kept.titles)}, expected ${expected} to stay`);
  return { key, deleted: title, selected: chosen.titles, inside: chosen.inside, undoSent: undone.undoSent, afterUndo: kept.titles, restored: undone.source === initial };
}

const closeNote = () => evaluate(`${VIEW}
  leaf.detach();
  delete window.__mappyE2E;
  return true;`);

try {
  await step('plugin', makePluginStep(cdp, evaluate, flag));
  await step('called-note', () => evaluate(`
    const existing = app.vault.getAbstractFileByPath(${JSON.stringify(CALLED)});
    if (existing) await app.vault.modify(existing, ${JSON.stringify(CALLED_SOURCE)});
    else await app.vault.create(${JSON.stringify(CALLED)}, ${JSON.stringify(CALLED_SOURCE)});
    return true;`));

  for (const target of NOTES) {
    for (const [pass, layout] of LAYOUTS.entries()) {
      const where = `${target.name}-${layout}`;
      const opened = required(record, `open-${where}`, await step(`open-${where}`, makeOpenStep(evaluate, { note: target.path, source: target.source, layout })));
      await step(`rows-${where}`, async () => {
        const results = [];
        for (const [index, row] of target.rows.entries()) results.push(await deleteRow(opened.source, row, keyFor(index, pass), where));
        return results;
      });
      await step(`close-${where}`, closeNote);
    }
  }

  // Off-screen: pan so the sibling above leaves the canvas, then delete; the selection must be drawn inside it.
  const offscreen = required(record, 'open-offscreen', await step('open-offscreen', makeOpenStep(evaluate, { note: NOTE, source: SOURCE, layout: 'mindmap' })));
  await step('offscreen', async () => {
    await select('aaaa');
    const shift = await evaluate(`${VIEW}
      const box = el.querySelector('.mappy-canvas').getBoundingClientRect();
      const above = nodes().find(node => label(node) === 'aaaaaaaa').getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, delta: above.bottom - box.top + 3 };`);
    // A plain wheel pans (src/ui/map-viewport.ts) and leaves the focus on the selected node.
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: shift.x, y: shift.y, deltaX: 0, deltaY: shift.delta });
    await wait(400);
    const before = await evaluate(`${VIEW}
      const box = el.querySelector('.mappy-canvas').getBoundingClientRect();
      const rect = nodes().find(node => label(node) === 'aaaaaaaa').getBoundingClientRect();
      return { outside: rect.bottom <= box.top, source: await source() };`);
    check(before.outside, 'the pan did not take 「aaaaaaaa」 out of the canvas; the off-screen row did not run as intended');
    await cdp.realKey('Delete');
    await after(before.source);
    const chosen = await selection();
    check(JSON.stringify(chosen.titles) === '["aaaaaaaa"]', `off-screen: selected ${JSON.stringify(chosen.titles)}`);
    check(chosen.inside, 'off-screen: the selected sibling was not brought inside the canvas');
    const undone = await undo((await state()).source, offscreen.source, 'off-screen');
    check(undone.source === offscreen.source, 'off-screen: ⌘Z did not restore the note byte for byte');
    return { outsideBefore: before.outside, selected: chosen.titles, inside: chosen.inside };
  });
  await step('close-offscreen', closeNote);

  if (!flag('--keep')) {
    await step('clean', () => evaluate(`
      window.__mappyE2E?.detach();
      for (const path of ${JSON.stringify([CALLED, ...NOTES.map(target => target.path)])}) {
        const file = app.vault.getAbstractFileByPath(path);
        if (file) await app.vault.delete(file, true);
      }
      delete window.__mappyE2E;
      delete window.__mappyE2EBefore;
      return true;`));
  }
} catch (error) {
  if (!(error instanceof StopCase)) throw error;
} finally {
  cdp.close();
}

process.exit(await finish(record, value('--json')));
