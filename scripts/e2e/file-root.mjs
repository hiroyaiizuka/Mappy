/**
 * E83 ファイル名の仮の根（LEV-301）: 見出しの無いノートの地図は中心にファイル名を出す。そこで
 *   ダブルクリック・F2 → ファイル名の入った入力欄が開き、打った名前が `## <名前>` として本文の先頭に書かれて根になる。
 *     打たずに Enter なら何も書かない。
 *   Tab → `## <ファイル名>` とその下の「メイントピック」が 1 回の編集で書かれ、ファイル名は中心に残り右に子がつながる。
 *   いずれも ⌘Z 1 回で書く前の原文に戻る。
 *   Enter（兄弟）は修正前と同じく何も書かない（対照）。
 * 修正前は ダブルクリック・F2 が「このノードはファイル名です。子ノードを追加できます。」の通知で止まり、Tab は
 * 「## トピック」を書いて、それが根に代わってファイル名が消えた（本人の報告 2026-10-02）。
 *
 * 行列は本人の操作（実マウスのダブルクリック・実キーの F2／Tab／Enter）× 対象の形（frontmatter だけ・見出しの無い段落・
 * 見出しの無い項目・項目の後に H2 のトピック）。最後に、根の入力欄で日本語を変換中の Enter（keyCode 229）が確定しない
 * ことを見る（OS の IME ではない。E01 と同じく `Input.imeSetComposition` で変換を起こす）。各行はノートを書き直して開き直す。
 *
 * Usage: npm run harness:e2e:file-root -- [--reload] [--json <out.json>] [--shot <out.png>] [--keep]
 *   --shot  writes the map after Tab on the note with items (the report's shape with something in it)
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeAim, makeSelect, makeState, makePluginStep, makeOpenStep, makeDeleteNote, makeFocusCanvas, makeMarkSeen } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-file-root.md';
const ROOT = 'E2E-file-root';
const MAIN = 'メイントピック';
const NAME = '新しい名前';
const FM = '---\nmappy: true\n---\n';

/** Each shape: the note, what the rename writes, what Tab writes (both spelled out: the case must fail if either changes). */
const SHAPES = [
  { id: 'frontmatter-only', source: FM, renamed: `${FM}\n## ${NAME}\n`, tab: `${FM}\n## ${ROOT}\n\n- ${MAIN}\n` },
  { id: 'paragraph', source: `${FM}メモ\n`, renamed: `${FM}\n## ${NAME}\n\nメモ\n`, tab: `${FM}\n## ${ROOT}\n\nメモ\n\n- ${MAIN}\n` },
  {
    id: 'items', source: `${FM}- 温泉旅行\n  - 予約\n`,
    renamed: `${FM}\n## ${NAME}\n\n- 温泉旅行\n  - 予約\n`, tab: `${FM}\n## ${ROOT}\n\n- 温泉旅行\n  - 予約\n- ${MAIN}\n`,
  },
  {
    id: 'items-and-topic', source: `${FM}- a\n\n## 別の話\n- b\n`,
    renamed: `${FM}\n## ${NAME}\n\n- a\n\n## 別の話\n- b\n`, tab: `${FM}\n## ${ROOT}\n\n- a\n- ${MAIN}\n\n## 別の話\n- b\n`,
  },
];

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const aim = makeAim(evaluate);
const select = makeSelect(cdp, evaluate);
const state = makeState(evaluate);
const focusCanvas = makeFocusCanvas(cdp, evaluate);
const markSeen = makeMarkSeen(evaluate);

/** The draft's text and whether all of it is selected, or null with no draft open. */
const draft = () => evaluate(`${VIEW} const box = input(); return box ? { value: box.value, all: box.selectionStart === 0 && box.selectionEnd === box.value.length } : null;`);
/** The map's body root as drawn (a free topic's root is `is-root` too): the file name, or the heading that took its place. */
const root = () => evaluate(`${VIEW} const node = el.querySelector('.mappy-node.is-root:not(.is-topic)'); return node ? label(node) : null;`);

async function open(source) {
  await evaluate('app.workspace.getLeavesOfType("mappy-map").forEach(leaf => leaf.detach()); await new Promise(resolve => setTimeout(resolve, 300)); return true;');
  await makeOpenStep(evaluate, { note: NOTE, source })();
  await markSeen();
}

async function doubleClick(title) {
  const box = await aim(title);
  for (const clickCount of [1, 2]) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount });
    }
  }
  await wait(600);
}

/** ⌘Z after a blank click puts the focus in the canvas (a modified key that reaches macOS hangs CDP: docs/harness.md). */
async function undo() {
  await focusCanvas();
  const focused = await evaluate(`${VIEW} return el.querySelector('.mappy-canvas').contains(document.activeElement) && !input();`);
  if (!focused) return { undoSent: false };
  await cdp.realKey('z', 4);
  await wait(800);
  return { undoSent: true, ...await state() };
}

const OPENERS = {
  dblclick: () => doubleClick(ROOT),
  F2: async () => { await select(ROOT); await cdp.realKey('F2'); await wait(600); },
};

const cleanNote = makeDeleteNote(evaluate, NOTE);
let exitCode = 1;
try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  for (const shape of SHAPES) {
    for (const [operation, openDraft] of Object.entries(OPENERS)) {
      const label = `${shape.id}/${operation}`;
      const result = await step(label, async () => {
        await open(shape.source);
        await openDraft();
        const opened = await draft();
        await cdp.insertText(NAME);
        await cdp.realKey('Enter', 0, '\r');
        await wait(800);
        const written = { ...await state(), root: await root() };
        const undone = await undo();
        return { opened, written, undone };
      });
      check(result?.opened?.value === ROOT && result.opened.all, `${label}: the draft opened as ${JSON.stringify(result?.opened)}, not the file name selected`);
      check(result?.written?.messages?.length === 0, `${label}: showed ${JSON.stringify(result?.written?.messages)}`);
      check(result?.written?.editing === false, `${label}: Enter did not close the draft`);
      check(result?.written?.source === shape.renamed, `${label}: wrote ${JSON.stringify(result?.written?.source)}, not ${JSON.stringify(shape.renamed)}`);
      check(result?.written?.root === NAME, `${label}: the root reads ${JSON.stringify(result?.written?.root)}, not ${NAME}`);
      check(result?.undone?.undoSent && result.undone.source === shape.source, `${label}: ⌘Z left ${JSON.stringify(result?.undone)}`);
    }

    const unchanged = await step(`${shape.id}/dblclick-unchanged`, async () => {
      await open(shape.source);
      await doubleClick(ROOT);
      await cdp.realKey('Enter', 0, '\r');
      await wait(800);
      return { ...await state(), root: await root() };
    });
    check(unchanged?.editing === false && unchanged.source === shape.source && unchanged.root === ROOT && unchanged.messages.length === 0,
      `${shape.id}/dblclick-unchanged: ${JSON.stringify(unchanged)}`);

    const tab = await step(`${shape.id}/Tab`, async () => {
      await open(shape.source);
      await select(ROOT);
      await cdp.realKey('Tab');
      await wait(800);
      const opened = await draft();
      await cdp.realKey('Enter', 0, '\r');
      await wait(800);
      const written = { ...await state(), root: await root() };
      if (shape.id === 'items' && value('--shot')) await cdp.screenshot(value('--shot'));
      const undone = await undo();
      return { opened, written, undone };
    });
    check(tab?.opened?.value === MAIN && tab.opened.all, `${shape.id}/Tab: the draft opened as ${JSON.stringify(tab?.opened)}, not 「${MAIN}」 selected`);
    check(tab?.written?.messages?.length === 0, `${shape.id}/Tab: showed ${JSON.stringify(tab?.written?.messages)}`);
    check(tab?.written?.source === shape.tab, `${shape.id}/Tab: wrote ${JSON.stringify(tab?.written?.source)}, not ${JSON.stringify(shape.tab)}`);
    check(tab?.written?.root === ROOT && tab.written.labels.includes(MAIN), `${shape.id}/Tab: the root reads ${JSON.stringify(tab?.written?.root)} with ${JSON.stringify(tab?.written?.labels)}`);
    check(tab?.undone?.undoSent && tab.undone.source === shape.source, `${shape.id}/Tab: ⌘Z left ${JSON.stringify(tab?.undone)}`);

    // A control: a sibling of the file name was refused before the fix and still is; nothing is written.
    const enter = await step(`${shape.id}/Enter`, async () => {
      await open(shape.source);
      await select(ROOT);
      await cdp.realKey('Enter', 0, '\r');
      await wait(800);
      return state();
    });
    check(enter?.editing === false && enter.source === shape.source, `${shape.id}/Enter: ${JSON.stringify(enter)}`);
  }

  // Japanese input on the root's draft: the Enter that confirms a conversion (keyCode 229) does not confirm the draft.
  const ime = await step('ime-enter', async () => {
    await open(FM);
    await select(ROOT);
    await cdp.realKey('F2');
    await wait(600);
    await cdp.send('Input.imeSetComposition', { text: 'しんしい', selectionStart: 4, selectionEnd: 4 });
    await cdp.realKey('Enter', 0, undefined, 229);
    await wait(600);
    const composing = await state();
    await cdp.insertText('新しい');
    await wait(200);
    await cdp.realKey('Enter', 0, '\r');
    await wait(800);
    return { composing, written: await state() };
  });
  check(ime?.composing?.editing === true && ime.composing.source === FM, `ime-enter: the Enter of the conversion confirmed the draft: ${JSON.stringify(ime?.composing)}`);
  check(ime?.written?.source === `${FM}\n## 新しい\n`, `ime-enter: wrote ${JSON.stringify(ime?.written?.source)}`);
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`unexpected: ${error}`);
} finally {
  await evaluate('app.workspace.getLeavesOfType("mappy-map").forEach(leaf => leaf.detach()); return true;').catch(() => null);
  if (!flag('--keep')) await step('clean', cleanNote);
  exitCode = await finish(record, value('--json'));
  cdp.close();
}
process.exit(exitCode);
