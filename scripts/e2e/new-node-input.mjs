/**
 * E43 (docs/harness.md): a new node's inline editor (LEV-203). 本人の報告は「新しいノードの入力欄が縦長で、カーソルが
 * 縦の中央に来ない。フォーカスを外すと箱の大きさが変わり、もう一度ダブルクリックするとまた変わるので画面がずれる」。
 * Obsidian 1.14.2 の Chromium 124 でだけ起きた形（入力欄が空のノードからはみ出す）があるので、ブラウザ検証ページ
 * （headless Chrome、`new-node-*`）とは別にここで回す。
 *
 * 行列は本人の操作 × 対象の形:
 *   1. 外形: 4 レイアウト × 通常ノード・本文のルート・トピック・ステージ × 空・1 文字・折り返す長さ・2 行（Shift+Enter）で、
 *      F2 → 入力 → Enter → F2 → Escape の各時点のノードの外形（配置位置と倍率 1 の幅・高さ）が同じこと、入力欄が行数
 *      ちょうどの高さでノードの文字の枠の上端から始まること（カーソルが行の縦の中央）。
 *   2. 仮の名前（本人の決定 2026-09-26）: 4 レイアウト × Tab（子）・Enter（兄弟）・空白のダブルクリック（トピック）で
 *      「サブトピック」「トピック」が全選択で開き、その外形が確定後も同じこと。すぐ Escape で原文が元に戻り、Undo の手順が
 *      残らないこと（⌘Z が何も戻さない）。そのまま Enter で仮の名前のまま確定すること。
 *   3. IME: 全選択の仮の名前の上で変換を始める（CDP の Input.imeSetComposition。OS の IME そのものではない）と置き換わり、
 *      確定した文字が書かれること。
 *
 * Usage: npm run harness:e2e:new-node -- [--reload] [--json <out.json>] [--shot <dir>] [--keep]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeFocusCanvas, makeOpenStep, makePluginStep, makeSelect } from './dom-helpers.mjs';
import { MEASURE_NODE_BOX, draftProblems, sameBox, showBox } from '../node-box.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-new-node.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 旅の計画', '',
  '- 温泉旅行',
  '  - 予約',
  '- 持ち物', '',
  '## 買うもの', '',
  '- 野菜', '',
].join('\n');
const LAYOUTS = ['mindmap', 'timeline', 'hierarchy', 'balanced'];
const TARGETS = [
  { id: 'plain', title: '予約' },
  { id: 'root', title: '旅の計画' },
  { id: 'topic', title: '買うもの' },
  { id: 'stage', title: '温泉旅行' },
];
const TEXTS = [
  { id: 'empty', text: '', rows: 1 },
  { id: 'one', text: 'あ', rows: 1 },
  { id: 'wrap', text: 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ', rows: 2 },
  { id: 'lines', text: '温泉\n旅行', rows: 2 },
];

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const focusCanvas = makeFocusCanvas(cdp, evaluate);

const source = () => evaluate(`${VIEW} return await source();`);
const editing = () => evaluate(`${VIEW} return !!input();`);
/** The node being edited (or else the selected one): its box, and the draft's rows, height and top (scripts/node-box.mjs). */
const box = () => evaluate(`${VIEW}
  const draft = input();
  const node = draft ? draft.closest('.mappy-node') : el.querySelector('.mappy-node.is-selected');
  return node ? (${MEASURE_NODE_BOX})(node, draft) : null;`);
const same = sameBox;
const show = showBox;

async function waitEditing(wanted = true, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await editing() === wanted) { await wait(300); return; }
    await wait(100);
  }
  throw new Error(wanted ? 'the inline editor did not open' : 'the inline editor did not close');
}

/** The note back to SOURCE, re-read by the map and fitted to the pane; a draft left open is closed first. */
async function restore(mode) {
  if (await editing()) { await cdp.realKey('Escape'); await wait(400); }
  await evaluate(`${VIEW}
    await app.vault.modify(view.file, ${JSON.stringify(SOURCE)});
    if (view.getState().layout !== ${JSON.stringify(mode)}) await view.setState({ ...view.getState(), layout: ${JSON.stringify(mode)} }, { history: false });
    await new Promise(resolve => setTimeout(resolve, 900));
    // The whole map in the pane, clear of the file explorer: a zoom left by an earlier run puts nodes out of reach.
    app.workspace.leftSplit?.collapse?.();
    el.querySelector('.mappy-button[aria-label="全体表示"]')?.click();
    await new Promise(resolve => setTimeout(resolve, 600));
    return true;`);
}

/** Replace the draft with `text` as typed; `\n` is a Shift+Enter. */
async function typeDraft(text) {
  await evaluate(`document.activeElement.select(); return true;`);
  if (text === '') await cdp.realKey('Backspace');
  for (const [index, part] of text.split('\n').entries()) {
    if (index > 0) await cdp.realKey('Enter', 8, '\r');
    if (part) await cdp.insertText(part);
  }
  await wait(400);
}

function checkDraft(draft, rows, label) {
  for (const problem of draftProblems(draft, rows, label)) check(false, problem);
}

/** Close the map under test and delete its note (`--keep` leaves both). */
const clean = () => evaluate(`${VIEW}
  const file = view.file;
  leaf.detach();
  if (file) await app.vault.delete(file, true);
  delete window.__mappyE2E;
  delete window.__mappyE2EBefore;
  return { removed: file?.path ?? null };`);

try {
  await step('plugin', makePluginStep(cdp, evaluate, flag));
  record.chromium = await evaluate(`return navigator.userAgent.match(/Chrome\\/[\\d.]+/u)?.[0] ?? null;`);
  record.obsidian = await evaluate(`return require('electron').ipcRenderer.sendSync('version') ?? null;`).catch(() => null);
  required(record, 'open', await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE })));

  for (const mode of LAYOUTS) {
    // 1. The box through F2 → text → Enter → F2 → Escape.
    await step(`box-${mode}`, async () => {
      const results = [];
      for (const target of TARGETS) {
        for (const text of TEXTS) {
          const label = `${mode}/${target.id}/${text.id}`;
          await restore(mode);
          await select(target.title);
          await cdp.realKey('F2');
          await waitEditing();
          await typeDraft(text.text);
          const draft = await box();
          checkDraft(draft, text.rows, label);
          await cdp.realKey('Enter');
          await waitEditing(false);
          const confirmed = await box();
          await cdp.realKey('F2');
          await waitEditing();
          const again = await box();
          checkDraft(again, text.rows, `${label} again`);
          await cdp.realKey('Escape');
          await waitEditing(false);
          const closed = await box();
          check(same(draft, confirmed) && same(confirmed, again) && same(again, closed),
            `${label}: draft ${show(draft)}, confirmed ${show(confirmed)}, again ${show(again)}, after Escape ${show(closed)}`);
          results.push({ label, draft: show(draft), confirmed: show(confirmed), again: show(again), closed: show(closed) });
        }
      }
      return results;
    });

    // 2. The provisional names: Tab (child), Enter (sibling), a double click on the empty canvas (topic).
    await step(`provisional-${mode}`, async () => {
      const results = [];
      const ways = [
        { id: 'Tab', name: 'サブトピック', from: '持ち物', written: SOURCE.replace('- 持ち物\n', '- 持ち物\n  - サブトピック\n') },
        { id: 'Enter', name: 'サブトピック', from: '予約', written: SOURCE.replace('  - 予約\n', '  - 予約\n  - サブトピック\n') },
        { id: 'dblclick', name: 'トピック', from: null, written: `${SOURCE}\n## トピック\n` },
      ];
      for (const way of ways) {
        // Escape right away: the node goes, the note is as before, and ⌘Z has nothing of it to undo.
        for (const end of ['Escape', 'Enter']) {
          const label = `${mode}/${way.id}/${end}`;
          await restore(mode);
          if (way.from) {
            await select(way.from);
            await cdp.realKey(way.id);
          } else {
            const point = await evaluate(`${VIEW}
              const rect = el.querySelector('.mappy-canvas').getBoundingClientRect();
              return { x: rect.left + 24, y: rect.bottom - 120 };`);
            for (const clickCount of [1, 2]) {
              for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount });
            }
          }
          await waitEditing();
          const draft = await box();
          check(draft.value === way.name && draft.selected, `${label}: the draft is ${JSON.stringify(draft.value)}, selected: ${draft.selected}`);
          checkDraft(draft, 1, label);
          const written = await source();
          check(written.replace(/mappy-topics:[\s\S]*?(?=---)/u, '') === way.written, `${label}: written ${JSON.stringify(written)}`);
          if (end === 'Escape') {
            await cdp.realKey('Escape');
            await waitEditing(false);
            await wait(600);
            const back = await source();
            check(back === SOURCE, `${label}: after Escape the note is ${JSON.stringify(back)}`);
            await focusCanvas();
            await cdp.realKey('z', 4);
            await wait(800);
            check(await source() === SOURCE, `${label}: ⌘Z after Escape changed the note`);
            results.push({ label, draft: show(draft) });
          } else {
            await cdp.realKey('Enter');
            await waitEditing(false);
            const confirmed = await box();
            check(same(draft, confirmed), `${label}: draft ${show(draft)}, confirmed ${show(confirmed)}`);
            const kept = await source();
            check(kept.includes(way.name === 'トピック' ? '\n## トピック\n' : '  - サブトピック\n'), `${label}: the provisional name was not kept: ${JSON.stringify(kept)}`);
            results.push({ label, draft: show(draft), confirmed: show(confirmed) });
          }
        }
      }
      const shot = value('--shot');
      if (shot) {
        await restore(mode);
        await select('持ち物');
        await cdp.realKey('Tab');
        await waitEditing();
        await cdp.screenshot(`${shot}/new-node-${mode}-draft.png`);
        await cdp.realKey('Enter');
        await waitEditing(false);
        await cdp.screenshot(`${shot}/new-node-${mode}-confirmed.png`);
      }
      return results;
    });
  }

  // 3. IME over the selected provisional name.
  await step('ime', async () => {
    await restore('mindmap');
    await select('持ち物');
    await cdp.realKey('Tab');
    await waitEditing();
    await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
    await wait(200);
    const composing = await evaluate(`${VIEW} return input()?.value ?? null;`);
    check(composing === 'にほん', `while composing the draft is ${JSON.stringify(composing)}`);
    await cdp.insertText('日本');
    await wait(200);
    await cdp.realKey('Enter');
    await waitEditing(false);
    const written = await source();
    check(written === SOURCE.replace('- 持ち物\n', '- 持ち物\n  - 日本\n'), `after the composition: ${JSON.stringify(written)}`);
    return { composing, written };
  });
  if (!flag('--keep')) await step('clean', clean);
} catch (error) {
  if (!(error instanceof StopCase)) throw error;
} finally {
  cdp.close();
}

process.exit(await finish(record, value('--json')));
