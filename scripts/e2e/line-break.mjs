/**
 * E40 (docs/harness.md): a line break inside a node (LEV-202). 本人の操作（F2 で開いて Shift+Enter で改行し、Enter で
 * 確定する）を対象の形ごとに回す: リストのノートの項目・本文のルート（H2）・トピック・Tab で作ったノード（仮の名前を上書き）と、見出しの
 * ノートの ATX 見出し・1 行の Setext 見出し・複数行の Setext 見出し（1 行にして <br>）、拒否される形（\ の直後）。続けて、そのまま
 * 確定しても原文が変わらないこと、⌘Z／⌘⇧Z、複数行の文の挿入（貼り付けと同じ input）、拒否された下書きがダブルクリックで
 * 消えないこと、Markdown 側（外部の書き込み）で書いた `<br>` がマップに改行で現れること、Obsidian 自身の描画
 * （閲覧モード）が `<br>` を改行にし、インラインコードの中は文字のままにすることを見る。
 *
 * Shift+Enter は文字を伴う実キー（`realKey(..., '\r')`）で送る: 既定動作（textarea の改行の挿入）が走るのはそのときだけ。
 * ネイティブ IME はここでは送れない（CDP の insertText は変換の確定と同じ input を出すだけ）ので、IME の変換中の
 * Enter／Shift+Enter は人の手で確かめる（docs/harness.md E40 (3)）。
 *
 * Usage: npm run harness:e2e:line-break -- [--reload] [--json <out.json>] [--shot <out.png>] [--keep]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeAfter, makeFocusCanvas, makeHistory, makeOpenStep, makePluginStep, makeSelect, makeState, refuseOpenLeaves } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-line-break.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 旅の計画', '',
  '- 温泉旅行', '  - 予約',
  '- 持ち物', '',
  '## 買うもの', '',
].join('\n');

const HEADINGS_NOTE = 'Fixtures/E2E-line-break-headings.md';
const PREVIEW_NOTE = 'Fixtures/E2E-line-break-preview.md';
const HEADINGS = [
  '---', 'mappy: true', '---',
  '# 旅の計画', '',
  '## 温泉旅行', '',
  '設定', '---', '',
  '複数', '行', '---', '',
].join('\n');

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const state = makeState(evaluate);
const after = makeAfter(evaluate);
const history = makeHistory(cdp, evaluate);
const focusCanvas = makeFocusCanvas(cdp, evaluate);

const draft = () => evaluate(`${VIEW} return input()?.value ?? null;`);
const source = () => evaluate(`${VIEW} return await source();`);
/** The node's label as drawn: how many `<br>` it holds and how many rows its text takes. */
const drawn = name => evaluate(`${VIEW}
  const node = nth(${JSON.stringify(name)}, 0);
  const text = node?.querySelector('.mappy-node-label');
  if (!text) return null;
  const range = document.createRange();
  range.selectNodeContents(text);
  return { breaks: text.querySelectorAll('br').length, rows: new Set(Array.from(range.getClientRects(), rect => Math.round(rect.top))).size };`);

async function waitForEditor(timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await draft() !== null) return;
    await wait(100);
  }
  throw new Error('the inline editor did not open');
}

/** Select `title`, F2, type `first`, Shift+Enter (a real key that types), `second`, Enter. */
async function breakAndConfirm(title, first, second, open = 'F2') {
  if (open === 'F2') { await select(title); await cdp.realKey('F2'); }
  else { await select(title); await cdp.realKey('Tab'); }
  await waitForEditor();
  // F2 selects the whole title (`InlineEditor` calls `select()`), so the typing replaces it. Tab opens the new node's
  // provisional name 「サブトピック」 selected the same way (LEV-203).
  if (open === 'Tab') await wait(800);
  await cdp.insertText(first);
  await cdp.realKey('Enter', 8, '\r');
  await wait(300);
  const typed = await draft();
  await cdp.insertText(second);
  await wait(200);
  const before = await source();
  await cdp.realKey('Enter');
  return { typed, ...await after(before) };
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
  required(record, 'open', await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE })));

  const shapes = [
    { id: 'list-item', title: '温泉旅行', first: '温泉', second: '旅行', line: '- 温泉<br>旅行' },
    { id: 'root', title: '旅の計画', first: '旅の', second: '計画', line: '## 旅の<br>計画' },
    { id: 'topic', title: '買うもの', first: '買う', second: 'もの', line: '## 買う<br>もの' },
  ];
  let expected = SOURCE;
  for (const shape of shapes) {
    await step(`break-${shape.id}`, async () => {
      const result = await breakAndConfirm(shape.title, shape.first, shape.second);
      check(result.typed === `${shape.first}\n`, `${shape.id}: after Shift+Enter the draft is ${JSON.stringify(result.typed)}`);
      check(result.messages.length === 0, `${shape.id}: ${JSON.stringify(result.messages)}`);
      check(!result.editing, `${shape.id}: Enter left the draft open`);
      const lineBefore = shape.id === 'list-item' ? '- 温泉旅行' : `## ${shape.title}`;
      expected = expected.replace(lineBefore, shape.line);
      check(result.source === expected, `${shape.id}: unexpected source:\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(result.source)}`);
      const shown = await drawn(`${shape.first} ${shape.second}`);
      check(shown?.breaks === 1 && shown.rows === 2, `${shape.id}: label ${JSON.stringify(shown)}`);
      return { ...result, shown };
    });
  }

  await step('reedit-untouched', async () => {
    await select('温泉 旅行');
    await cdp.realKey('F2');
    await waitForEditor();
    const reopened = await draft();
    check(reopened === '温泉\n旅行', `the draft reopened as ${JSON.stringify(reopened)}`);
    const before = await source();
    await cdp.realKey('Enter');
    const result = await after(before, 1500);
    check(!result.editing, 'Enter left the draft open');
    check(result.source === before, 'confirming the untouched draft changed the note');
    return { reopened, ...result };
  });

  await step('undo-redo', async () => {
    const withBreak = await source();
    const undone = await history('undo');
    check(undone.source === withBreak.replace('## 買う<br>もの', '## 買うもの'), `⌘Z: ${JSON.stringify(undone.source)}`);
    const redone = await history('redo');
    check(redone.source === withBreak, `⌘⇧Z: ${JSON.stringify(redone.source)}`);
    return { undone: undone.source, redone: redone.source };
  });

  await step('break-empty-tab', async () => {
    const before = await source();
    const result = await breakAndConfirm('持ち物', 'タオル', '着替え', 'Tab');
    check(result.typed === 'タオル\n', `after Shift+Enter the draft is ${JSON.stringify(result.typed)}`);
    check(result.messages.length === 0, JSON.stringify(result.messages));
    const want = before.replace('- 持ち物\n', '- 持ち物\n  - タオル<br>着替え\n');
    check(result.source === want, `unexpected source:\nexpected: ${JSON.stringify(want)}\nactual:   ${JSON.stringify(result.source)}`);
    return result;
  });

  // Several lines arriving at once, as a paste does (Input.insertText fires the same input events).
  await step('multi-line-insert', async () => {
    await select('予約');
    await cdp.realKey('F2');
    await waitForEditor();
    await cdp.insertText('宿を\r\n予約する');
    await wait(200);
    const before = await source();
    await cdp.realKey('Enter');
    const result = await after(before);
    check(result.messages.length === 0, JSON.stringify(result.messages));
    check(result.source.includes('  - 宿を<br>予約する\n'), `unexpected source: ${JSON.stringify(result.source)}`);
    return result;
  });

  await step('refused-draft-dblclick', async () => {
    await select('宿を 予約する');
    await cdp.realKey('F2');
    await waitForEditor();
    await cdp.insertText('[ ] 宿');
    await wait(200);
    const before = await source();
    await cdp.realKey('Enter');
    await wait(800);
    const refused = await state();
    check(refused.messages.length > 0 && refused.editing, `the task-marker name was not refused: ${JSON.stringify(refused.messages)}`);
    // Double-click the node the draft stands on, beside the textarea (its top-left corner inside the frame).
    const box = await evaluate(`${VIEW}
      const node = input()?.closest('.mappy-node');
      const rect = node.getBoundingClientRect();
      return { x: rect.left + 3, y: rect.top + 3 };`);
    for (const clickCount of [1, 2]) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount });
      }
    }
    await wait(800);
    const kept = await draft();
    check(kept === '[ ] 宿', `the refused draft became ${JSON.stringify(kept)}`);
    check(await source() === before, 'the note changed');
    await cdp.realKey('Escape');
    await wait(300);
    return { messages: refused.messages, kept };
  });

  await step('markdown-side-br', async () => {
    await focusCanvas();
    const before = await source();
    const written = before.replace('- 持ち物\n', '- 持ち物<BR/>リスト\n');
    await evaluate(`${VIEW} await app.vault.modify(view.file, ${JSON.stringify(written)}); return true;`);
    const result = await after(before);
    const shown = await drawn('持ち物 リスト');
    check(shown?.breaks === 1 && shown.rows === 2, `label ${JSON.stringify(shown)}`);
    check(result.source === written, 'the map rewrote the note it only read');
    return { shown, labels: result.labels };
  });

  // What Obsidian itself makes of the same text (the reading view and live preview go through it too).
  // What Obsidian itself makes of the same text: the note opened in its reading view (a Markdown leaf in preview
  // mode), whose `<br>` count is read from the rendered section. The window's `require` does not reach `obsidian`.
  await step('obsidian-renders-br', () => evaluate(`
    const path = ${JSON.stringify(PREVIEW_NOTE)};
    ${refuseOpenLeaves([PREVIEW_NOTE])}
    const existing = app.vault.getAbstractFileByPath(path);
    const text = '- 温泉<br>旅行\\n\\n## 温泉<BR/>旅行\\n\\n\\x60a<br>b\\x60\\n';
    const file = existing ?? await app.vault.create(path, text);
    if (existing) await app.vault.modify(file, text);
    const preview = app.workspace.getLeaf('tab');
    await preview.setViewState({ type: 'markdown', state: { file: path, mode: 'preview' }, active: true });
    let breaks = 0;
    for (let tries = 0; tries < 30 && breaks < 2; tries += 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
      breaks = preview.view.containerEl.querySelectorAll('.markdown-preview-view br').length;
    }
    const code = preview.view.containerEl.querySelector('.markdown-preview-view code')?.textContent ?? null;
    const html = preview.view.containerEl.querySelector('.markdown-preview-view')?.innerText.slice(0, 200) ?? '';
    preview.detach();
    await app.vault.delete(file, true);
    if (breaks !== 2 || code !== 'a<br>b') throw new Error('reading view: ' + breaks + ' breaks, code ' + JSON.stringify(code) + ': ' + JSON.stringify(html));
    return { breaks, code };`));

  if (value('--shot')) await step('shot', async () => ({ path: await cdp.screenshot(value('--shot')) }));
  if (!flag('--keep')) await step('clean', clean);

  // A note in the older heading format: an ATX heading, a one-line Setext heading (written with `<br>` as ATX is), a
  // multi-line one (written as one line with `<br>`), and the refusal of a break right after a backslash (the tag would be
  // text there), whose draft stays with its reason.
  required(record, 'open-headings', await step('open-headings', makeOpenStep(evaluate, { note: HEADINGS_NOTE, source: HEADINGS })));
  await step('break-atx', async () => {
    const result = await breakAndConfirm('温泉旅行', '温泉', '旅行');
    check(result.messages.length === 0 && !result.editing, `ATX: ${JSON.stringify(result.messages)}`);
    const want = HEADINGS.replace('## 温泉旅行', '## 温泉<br>旅行');
    check(result.source === want, `ATX: unexpected source:\nexpected: ${JSON.stringify(want)}\nactual:   ${JSON.stringify(result.source)}`);
    return result;
  });
  await step('break-setext-one-line', async () => {
    const before = await source();
    const result = await breakAndConfirm('設定', '設', '定');
    check(result.messages.length === 0 && !result.editing, `Setext: ${JSON.stringify(result.messages)}`);
    const want = before.replace('\n設定\n---\n', '\n設<br>定\n---\n');
    check(result.source === want, `Setext: unexpected source:\nexpected: ${JSON.stringify(want)}\nactual:   ${JSON.stringify(result.source)}`);
    return result;
  });
  // A multi-line Setext heading is written as one line with `<br>` (本人の決定 2026-09-26; before, the edit was
  // refused): Obsidian does not read the two-line form as a heading, and reads this one as the heading the map shows.
  await step('break-setext-multi-line', async () => {
    const before = await source();
    const result = await breakAndConfirm('複数 行', '複数', '行の見出し');
    check(result.messages.length === 0 && !result.editing, `multi-line Setext: ${JSON.stringify(result.messages)}`);
    const want = before.replace('\n複数\n行\n---\n', '\n複数<br>行の見出し\n---\n');
    check(result.source === want, `multi-line Setext: unexpected source:\nexpected: ${JSON.stringify(want)}\nactual:   ${JSON.stringify(result.source)}`);
    return result;
  });
  await step('refused-after-backslash', async () => {
    const before = await source();
    const result = await breakAndConfirm('温泉 旅行', 'C:\\', 'dir');
    check(result.messages.length > 0 && result.editing, `not refused (${JSON.stringify(result.messages)})`);
    check(await draft() === 'C:\\\ndir', 'the draft was not kept');
    check(result.source === before, 'the note changed');
    await cdp.realKey('Escape');
    await wait(300);
    return { messages: result.messages };
  });
  if (!flag('--keep')) await step('clean-headings', clean);
} catch (error) {
  if (!(error instanceof StopCase)) throw error;
} finally {
  cdp.close();
}

process.exit(await finish(record, value('--json')));
