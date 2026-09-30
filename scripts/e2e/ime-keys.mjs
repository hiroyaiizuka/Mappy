/**
 * E01 (docs/harness.md): the keys pressed while a Japanese IME is composing (LEV-15, LEV-223). 本人の報告
 * （2026-09-27、macOS の日本語 IME で A1〜A6・B「問題なし」）には証跡が無く、再実行できる形も無かったので、
 * 変換中のキー制御だけをここで CDP で固定する。**OS の IME そのものではない**: 変換は `Input.imeSetComposition`
 * （compositionstart／update と変換中の input）、確定は `Input.insertText`（compositionend）、取り消しは空の
 * `Input.imeSetComposition` で起こし、キーは実キー（`Input.dispatchKeyEvent`）で送る。候補の窓・ライブ変換（A6）・
 * IME ごとのキーの受け方は再現しない。この PASS を E01 の完了と呼ばない。
 *
 * 行列は本人の操作 × 対象の形:
 *   A. 既存ノードを F2 で開き、変換中（「にほんご」）に Enter・Tab・Escape × IME の受け方 × 通常ノード・本文のルート・
 *      トピック・ステージ。IME の受け方は 2 通り:
 *        ime  — IME がキーを受けた形。Chromium（macOS）が送る keyCode 229 の keydown（`isComposing`）。
 *        pass — IME がキーを受けずにそのまま流した形。そのキー本来の keyCode の keydown（`isComposing`）で、
 *               止めなければ既定動作（Tab ならフォーカス移動）が走る。LEV-15 の review 3 がこの形で A3 が壊れうると指摘した。
 *      キーのあとで IME が自分の仕事をする: Enter・Tab は変換の確定（「日本語」）、Escape は変換の取り消し。
 *      期待（E01）: (A1) 変換中の Enter で題名を確定しない・ノードは増えない、(A2) 確定後の Enter で題名が確定、
 *      (A3) 変換中の Tab で子が増えず、変換中の文字が残り編集が続く、(A4) 変換中の Escape で編集を閉じない。
 *   A5. Enter（兄弟）・Tab（子）・空白のダブルクリック（トピック）で開いた新しいノードの入力欄で、全選択の仮の名前の上で
 *      変換して、変換中に Enter（ime）・Tab（pass）→ 確定 → Enter。ノードは 1 つだけ増え、題名は確定した文字。
 *   B. 分割で並べた Markdown 側で、リスト項目・見出しを変換しながら入力する（Obsidian の保存の間隔より長く変換を続け、
 *      変換中の保存を挟む）。確定後、マップのノードが 1 つだけ増え、題名は確定した文字で、変換途中の読みが残らない。
 *
 * 実行されていない行を PASS にしない（PR #76 の教訓）:
 *   - 行の一覧（`ROWS`）を先に決め、最後に全行が結果を持つことを確かめる。例外で飛んだ行は「実行されていない」で FAIL。
 *   - 各行は、変換が本当に対象の要素で起きたこと（compositionstart）と、キーが変換中として対象に届いたこと
 *     （`isComposing` の keydown、keyCode も）をページ側の記録で確かめる。届いていなければ「何も起きなかった」は PASS にならない。
 *   - 対照の行: 同じキーを変換なしで送ると本来の動作（Enter で確定、Tab で子、Escape で閉じる）をすること。
 *     キーが Mappy に届かない窓では、変換中の行の「何も起きない」が素通りで緑になるので、対照が落ちれば全体を FAIL にする。
 *   - 読み込まれているビルドを記録する（版と、Vault に入っている main.js の SHA-256）。
 *
 * Usage: npm run harness:e2e:ime-keys -- [--reload] [--json <out.json>] [--keep]
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeOpenStep, makePluginStep, makeSelect } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-ime-keys.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 旅の計画', '',
  '- 温泉旅行',
  '  - 予約',
  '- 持ち物', '',
  '## 買うもの', '',
  '- 野菜', '',
].join('\n');
const LABELS = ['旅の計画', '温泉旅行', '予約', '持ち物', '買うもの', '野菜'];
const TARGETS = [
  { id: 'plain', title: '予約' },
  { id: 'root', title: '旅の計画' },
  { id: 'topic', title: '買うもの' },
  { id: 'stage', title: '温泉旅行' },
];
/** keyCode of each key when the IME lets it through; 229 when the IME took it (Chromium on macOS). */
const KEYS = { Enter: 13, Tab: 9, Escape: 27 };
const DELIVERIES = ['ime', 'pass'];
const READING = 'にほんご';
const WORD = '日本語';
const NEW_WAYS = [
  { id: 'Tab', from: '持ち物', name: 'サブトピック', written: SOURCE.replace('- 持ち物\n', `- 持ち物\n  - ${WORD}\n`) },
  { id: 'Enter', from: '予約', name: 'サブトピック', written: SOURCE.replace('  - 予約\n', `  - 予約\n  - ${WORD}\n`) },
  { id: 'dblclick', from: null, name: 'トピック', written: `${SOURCE}\n## ${WORD}\n` },
];
const NEW_KEYS = [{ key: 'Enter', delivery: 'ime' }, { key: 'Tab', delivery: 'pass' }];
const MARKDOWN = [
  { id: 'list', reading: ['に', 'にほ', 'にほん', READING], word: WORD, lead: [], written: SOURCE.replace('- 野菜\n', `- 野菜\n- ${WORD}\n`) },
  { id: 'heading', reading: ['み', 'みだ', 'みだし'], word: '見出し', lead: ['## '], written: `${SOURCE}\n## 見出し` },
];

/** Every row this case must run: a row with no result at the end was not run, and fails the case. */
const ROWS = [
  ...Object.keys(KEYS).map(key => `control/${key}`),
  ...Object.keys(KEYS).flatMap(key => DELIVERIES.flatMap(delivery => TARGETS.map(target => `A/${key}/${delivery}/${target.id}`))),
  ...NEW_WAYS.flatMap(way => NEW_KEYS.map(({ key, delivery }) => `A5/${way.id}/${key}/${delivery}`)),
  ...MARKDOWN.map(item => `B/${item.id}`),
];

const record = createRecord(VAULT, NOTE);
record.rows = {};
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);

const source = () => evaluate(`${VIEW} return await source();`);
/** What the map shows: whether a draft is open and what it holds, the node labels, and where the focus is. */
const look = () => evaluate(`${VIEW}
  return { editing: !!input(), draft: input()?.value ?? null, labels: nodes().map(label), active: document.activeElement?.tagName ?? null };`);

/**
 * The page's own record of the composition and key events, so a row can show it was exercised: the IME's events on the
 * element under test, and the key reaching it as a composing keydown. Installed once per window; `take` empties it.
 */
const LOG = `if (!window.__mappyImeLog) {
    window.__mappyImeLog = [];
    for (const type of ['compositionstart', 'compositionend', 'keydown']) {
      document.addEventListener(type, event => {
        const target = event.target;
        window.__mappyImeLog.push({
          type, key: event.key ?? null, keyCode: event.keyCode ?? null, isComposing: event.isComposing ?? null, data: event.data ?? null,
          where: target?.closest?.('.cm-content') ? 'markdown' : target?.classList?.contains('mappy-inline-input') ? 'draft' : String(target?.tagName ?? ''),
        });
      }, true);
    }
  }`;
const take = () => evaluate(`${LOG} return window.__mappyImeLog.splice(0);`);

/** The fixture's nodes, in any order: the DOM puts a node drawn again after an edit elsewhere. */
const sameLabels = labels => [...labels].sort().join('|') === [...LABELS].sort().join('|');

async function until(test, timeout, what) {
  const started = Date.now();
  for (;;) {
    const result = await test();
    if (result) return result;
    if (Date.now() - started > timeout) throw new Error(`${what} (waited ${timeout} ms)`);
    await wait(100);
  }
}
const waitEditing = (wanted = true) => until(async () => (await look()).editing === wanted, 3000,
  wanted ? 'the inline editor did not open' : 'the inline editor did not close').then(() => wait(250));

/** A key as the IME hands it on: keyCode 229 when it took the key (`ime`), the key's own when it let it through (`pass`). */
async function imeKey(key, delivery) {
  const keyCode = delivery === 'ime' ? 229 : KEYS[key];
  const base = { key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
const compose = text => cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });

/** The note back to SOURCE, re-read by the map and fitted to the pane; a composition or draft left open is ended first. */
async function restore() {
  if ((await look()).editing) {
    await compose('');
    await cdp.realKey('Escape');
    await wait(400);
  }
  await evaluate(`${VIEW}
    if (await source() !== ${JSON.stringify(SOURCE)}) await app.vault.modify(view.file, ${JSON.stringify(SOURCE)});
    await new Promise(resolve => setTimeout(resolve, 700));
    app.workspace.leftSplit?.collapse?.();
    el.querySelector('.mappy-button[aria-label="全体表示"]')?.click();
    await new Promise(resolve => setTimeout(resolve, 500));
    return true;`);
  const shown = await look();
  if (!sameLabels(shown.labels)) throw new Error(`the map did not re-read the fixture: ${JSON.stringify(shown.labels)}`);
  await take();
}

/**
 * Whether the log shows the IME composing on `where` and `key` reaching it while it composed, as `keyCode`. Returns the
 * reasons it does not (empty when it does): a row that fails here was not exercised, whatever else it saw.
 */
function unexercised(log, where, key, keyCode) {
  const reasons = [];
  if (!log.some(item => item.type === 'compositionstart' && item.where === where)) reasons.push(`no compositionstart on the ${where}`);
  if (key && !log.some(item => item.type === 'keydown' && item.key === key && item.isComposing === true && item.keyCode === keyCode && item.where === where)) {
    reasons.push(`no composing keydown ${key} (keyCode ${keyCode}) on the ${where}`);
  }
  return reasons;
}

/** Runs one row of ROWS: its result (or error) goes to `record.rows`, its failures to the record with the row's label. */
async function row(label, run) {
  if (!ROWS.includes(label)) throw new Error(`row ${label} is not in ROWS`);
  const failures = [];
  const expect = (condition, failure) => { if (!condition) failures.push(failure); };
  try {
    await restore();
    const result = await run(expect);
    record.rows[label] = { ...result, failures };
  } catch (error) {
    failures.push(String(error));
    record.rows[label] = { error: String(error), failures };
  }
  for (const failure of failures) check(false, `${label}: ${failure}`);
  console.log(label, failures.length ? `FAIL ${failures.join(' / ')}` : 'PASS');
}


try {
  await step('plugin', makePluginStep(cdp, evaluate, flag));
  record.chromium = await evaluate(`return navigator.userAgent.match(/Chrome\\/[\\d.]+/u)?.[0] ?? null;`);
  record.obsidian = await evaluate(`return require('electron').ipcRenderer.sendSync('version') ?? null;`).catch(() => null);
  // The build this run reports on: the file Obsidian loads the plugin from (a reverted build is told apart by it).
  record.mainJs = createHash('sha256').update(await readFile(join(VAULT, '.obsidian', 'plugins', 'mappy', 'main.js'))).digest('hex');
  required(record, 'open', await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE })));
  await evaluate(`${LOG} return true;`);

  await step('map', async () => {
    // Controls: the same keys, no composition, do what they do. Without these a window whose keys never reach the map
    // would pass every composing row below ("nothing happened").
    for (const key of Object.keys(KEYS)) {
      await row(`control/${key}`, async expect => {
        await select('予約');
        await cdp.realKey('F2');
        await waitEditing();
        await cdp.insertText('対照');
        await wait(200);
        await imeKey(key, 'pass');
        await wait(600);
        const after = await look();
        const written = await source();
        const log = await take();
        expect(log.some(item => item.type === 'keydown' && item.key === key && item.isComposing === false && item.where === 'draft'),
          `${key} did not reach the draft`);
        if (key === 'Escape') {
          expect(!after.editing && written === SOURCE, `Escape did not close the draft unchanged: editing ${after.editing}, ${JSON.stringify(written)}`);
        } else if (key === 'Enter') {
          expect(!after.editing && written === SOURCE.replace('予約', '対照'), `Enter did not confirm: editing ${after.editing}, ${JSON.stringify(written)}`);
        } else {
          // Tab confirms and adds a child, whose own draft opens on its provisional name.
          expect(after.editing && after.draft === 'サブトピック' && written === SOURCE.replace('  - 予約\n', '  - 対照\n    - サブトピック\n'),
            `Tab did not confirm and add a child: ${JSON.stringify(after)}, ${JSON.stringify(written)}`);
        }
        return { after, written };
      });
    }

    // A1〜A4: F2 on an existing node, then a key while composing, then the IME's own work, then Enter or Escape.
    for (const key of Object.keys(KEYS)) {
      for (const delivery of DELIVERIES) {
        for (const target of TARGETS) {
          await row(`A/${key}/${delivery}/${target.id}`, async expect => {
            await select(target.title);
            await cdp.realKey('F2');
            await waitEditing();
            await compose(READING);
            await wait(200);
            await imeKey(key, delivery);
            await wait(600);
            const during = await look();
            const log = await take();
            for (const reason of unexercised(log, 'draft', key, delivery === 'ime' ? 229 : KEYS[key])) expect(false, `not exercised: ${reason}`);
            expect(during.editing && during.draft === READING && during.active === 'TEXTAREA',
              `the draft did not stay open with the reading after ${key}: ${JSON.stringify(during)}`);
            expect(sameLabels(during.labels), `${key} while composing changed the nodes: ${JSON.stringify(during.labels)}`);
            expect(await source() === SOURCE, `${key} while composing wrote the note`);
            // The IME's own work: Enter and Tab confirm the conversion, Escape takes it back.
            if (key === 'Escape') await compose(''); else await cdp.insertText(WORD);
            await wait(400);
            const ended = await look();
            const endLog = await take();
            expect(endLog.some(item => item.type === 'compositionend' && item.where === 'draft'), 'the composition did not end on the draft');
            expect(ended.editing && ended.draft === (key === 'Escape' ? '' : WORD),
              `after the composition ended the draft is ${JSON.stringify(ended)}`);
            expect(await source() === SOURCE, 'ending the composition wrote the note');
            // A2: the next Enter confirms the title; after the cancelled one, Escape closes the draft as it was.
            const finalKey = key === 'Escape' ? 'Escape' : 'Enter';
            await cdp.realKey(finalKey);
            await waitEditing(false);
            const expected = key === 'Escape' ? SOURCE : SOURCE.replace(target.title, WORD);
            const written = await until(async () => { const text = await source(); return text === expected ? text : null; }, 3000,
              `${finalKey} after the composition did not write the expected note`).catch(async error => { expect(false, `${error.message}: ${JSON.stringify(await source())}`); return null; });
            const final = await look();
            expect(final.labels.length === LABELS.length, `${finalKey} left ${final.labels.length} nodes: ${JSON.stringify(final.labels)}`);
            return { during, ended, final: final.labels, written };
          });
        }
      }
    }

    // A5: a new node's draft, its provisional name selected, composed over.
    for (const way of NEW_WAYS) {
      for (const { key, delivery } of NEW_KEYS) {
        await row(`A5/${way.id}/${key}/${delivery}`, async expect => {
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
          const opened = await look();
          expect(opened.draft === way.name, `the new node opened on ${JSON.stringify(opened.draft)}, not ${way.name}`);
          await compose(READING);
          await wait(200);
          await imeKey(key, delivery);
          await wait(600);
          const during = await look();
          const log = await take();
          for (const reason of unexercised(log, 'draft', key, delivery === 'ime' ? 229 : KEYS[key])) expect(false, `not exercised: ${reason}`);
          expect(during.editing && during.draft === READING && during.active === 'TEXTAREA',
            `the new node's draft did not stay open with the reading after ${key}: ${JSON.stringify(during)}`);
          expect(during.labels.length === LABELS.length + 1, `${key} while composing left ${during.labels.length} nodes: ${JSON.stringify(during.labels)}`);
          await cdp.insertText(WORD);
          await wait(400);
          await cdp.realKey('Enter');
          await waitEditing(false);
          const written = await until(async () => { const text = await source(); return text.replace(/mappy-topics:[\s\S]*?(?=---)/u, '') === way.written ? text : null; }, 3000,
            'the new node was not written with the confirmed word').catch(async error => { expect(false, `${error.message}: ${JSON.stringify(await source())}`); return null; });
          const final = await look();
          expect(final.labels.length === LABELS.length + 1 && final.labels.filter(item => item === WORD).length === 1,
            `after Enter the map has ${JSON.stringify(final.labels)}`);
          return { opened: opened.draft, during, final: final.labels, written };
        });
      }
    }
    return Object.fromEntries(Object.entries(record.rows).map(([label, result]) => [label, result.failures.length === 0]));
  });

  // B: the Markdown beside the map, typed in with the IME. Last: from here on the note is open in an editor too.
  await step('markdown', async () => {
    // The map's own 「Markdown を横に開く」 (a plain markdown view state of a map note is routed to a map), then editing
    // mode with live preview: the reading view would never take the keys.
    required(record, 'split', await step('split', () => evaluate(`${VIEW}
      await view.showSource(true);
      await new Promise(resolve => setTimeout(resolve, 1000));
      const md = app.workspace.getLeavesOfType('markdown').find(item => item.view.file?.path === view.file.path);
      if (!md) throw new Error('No Markdown leaf opened beside the map');
      await md.setViewState({ type: 'markdown', state: { ...md.getViewState().state, mode: 'source', source: false } });
      await new Promise(resolve => setTimeout(resolve, 500));
      if (md.view.getMode?.() !== 'source') throw new Error('The Markdown leaf beside the map is not in editing mode: ' + md.view.getMode?.());
      window.__mappyE2EMarkdown = md;
      return { type: md.view.getViewType(), file: md.view.file?.path ?? null };`)));
    for (const item of MARKDOWN) {
      await row(`B/${item.id}`, async expect => {
        // The cursor at the end of 「- 野菜」 (list) or of the note (heading), in the editor, with the focus there.
        const at = await evaluate(`const md = window.__mappyE2EMarkdown; const editor = md.view.editor;
          app.workspace.setActiveLeaf(md, { focus: true });
          editor.focus();
          const line = ${item.id === 'list' ? `editor.getValue().split('\\n').indexOf('- 野菜')` : 'editor.lastLine()'};
          editor.setCursor({ line, ch: editor.getLine(line).length });
          await new Promise(resolve => setTimeout(resolve, 300));
          return { line, focused: md.view.contentEl.contains(document.activeElement) };`);
        expect(at.focused, 'the Markdown editor did not take the focus');
        await cdp.realKey('Enter', 0, '\r');
        await wait(300);
        for (const text of item.lead) await cdp.insertText(text);
        // Slower than Obsidian's save interval (2 s): a save of the note falls in the middle of the composition.
        for (const text of item.reading) {
          await compose(text);
          await wait(800);
        }
        const during = await look();
        await cdp.insertText(item.word);
        const log = await take();
        for (const reason of unexercised(log, 'markdown')) expect(false, `not exercised: ${reason}`);
        expect(log.some(entry => entry.type === 'compositionend' && entry.where === 'markdown'), 'the composition did not end in the Markdown editor');
        const written = await until(async () => { const text = await source(); return text === item.written ? text : null; }, 6000,
          'the note did not reach the typed text').catch(async error => { expect(false, `${error.message}: ${JSON.stringify(await source())}`); return null; });
        const final = await until(async () => {
          const shown = await look();
          return shown.labels.includes(item.word) ? shown : null;
        }, 3000, 'the map did not show the typed node').catch(async error => { expect(false, error.message); return look(); });
        expect(final.labels.length === LABELS.length + 1 && final.labels.filter(label => label === item.word).length === 1,
          `the map has ${JSON.stringify(final.labels)}, not the fixture and one ${item.word}`);
        expect(!final.labels.some(label => item.reading.some(reading => label.includes(reading))), `a reading is left on the map: ${JSON.stringify(final.labels)}`);
        return { during: during.labels, final: final.labels, written };
      });
    }
    return Object.fromEntries(MARKDOWN.map(item => [item.id, record.rows[`B/${item.id}`]?.failures.length === 0]));
  });

  if (!flag('--keep')) {
    await step('clean', () => evaluate(`${VIEW}
      const file = view.file;
      window.__mappyE2EMarkdown?.detach();
      leaf.detach();
      if (file) await app.vault.delete(file, true);
      delete window.__mappyE2E;
      delete window.__mappyE2EBefore;
      delete window.__mappyE2EMarkdown;
      return { removed: file?.path ?? null };`));
  }
} catch (error) {
  if (!(error instanceof StopCase)) throw error;
} finally {
  cdp.close();
}

// A row with no result was not run: never a PASS by omission.
const missing = ROWS.filter(label => !(label in record.rows));
record.missing = missing;
check(missing.length === 0, `rows not run: ${missing.join(', ')}`);
process.exit(await finish(record, value('--json')));
