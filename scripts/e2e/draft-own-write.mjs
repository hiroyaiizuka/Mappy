/**
 * E77 (docs/harness.md): an open draft and the map's own writes on the real Obsidian (LEV-141).
 *
 * 4. The real clipboard. Every earlier check (jsdom, E37) built the paste event itself, `clipboardData` included, and
 *    dispatched it on the canvas. Here the OS clipboard holds the image (Electron's `clipboard`, which is the
 *    system pasteboard), and the paste is the one ⌘V runs through Obsidian's Edit menu (`webContents.paste()`): the
 *    event starts in the draft's textarea, carries what the pasteboard gives, and reaches the canvas by bubbling.
 *    Shapes: an image only, text only, and an image with text (what a spreadsheet's cells put on the pasteboard).
 * 3. ⌘Z／⌘⇧Z over an open draft: right click on the empty canvas → 元に戻す, with the draft still open. The step
 *    records whether the right click leaves the draft open at all (a real pointer press may take the focus from it).
 * 2. A command the note refuses over an open draft: the draft on one sixth-level heading, a right click on another → 子を追加
 *    (the draft's own node cannot be right clicked: its textarea covers it and keeps the browser's menu).
 *
 * The clipboard is the user's: what it held is read before the case and written back after it (text, HTML, RTF and an
 * image), and is never logged.
 *
 * Usage (see docs/harness.md 実機検証 for the Obsidian instance):
 *   npm run harness:e2e:draft-own-write -- [--reload] [--json <out.json>] [--keep]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep, makeOpenStep, makeState, makeMarkSeen, makePress, PNG_FIXTURE } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-draft-own-write.md';
const SOURCE = [
  '# 計画', '',
  '## 学ぶこと', '',
  '## 記録する', '',
  '## 二', '', '### 三', '', '#### 四', '', '##### 五', '', '###### 六', '', '###### 七', '',
].join('\n');

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const state = makeState(evaluate);
const markSeen = makeMarkSeen(evaluate);
const press = makePress(cdp, evaluate);

/** Put `items` on the OS clipboard: `text`, and `image` for the case's PNG. */
const clip = items => evaluate(`const { clipboard, nativeImage } = require('electron');
  const data = {};
  if (${JSON.stringify(items.text ?? null)} !== null) data.text = ${JSON.stringify(items.text ?? '')};
  if (${items.image ? 'true' : 'false'}) data.image = nativeImage.createFromBuffer(Buffer.from(${PNG_FIXTURE}));
  clipboard.clear();
  clipboard.write(data);
  return clipboard.availableFormats();`);
/** ⌘V as Obsidian's Edit menu runs it: the renderer pastes from the system clipboard into the focused element. */
const pasteKey = async () => {
  await evaluate(`require('electron').remote.getCurrentWebContents().paste(); return true;`);
  await wait(2500);
};
/** F2 on the selected node opens its draft with the text selected; `text` replaces it as typing would. */
const openDraft = async (title, text) => {
  await select(title);
  await cdp.realKey('F2');
  await wait(500);
  const open = await evaluate(`${VIEW} return !!input() && document.activeElement === input();`);
  if (!open) throw new Error(`F2 did not open a focused draft on ${title}`);
  await cdp.insertText(text);
  await wait(300);
};
const draftValue = () => evaluate(`${VIEW} return input()?.value ?? null;`);
/** A real right click at the canvas's empty top-left corner, or on a node (`locate` for makePress). */
const rightClick = async locate => {
  const at = await press(locate, { click: false });
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'right', clickCount: 1 });
  }
  await wait(500);
};
const CANVAS_CORNER = `const node = el.querySelector('.mappy-canvas'); const r = node.getBoundingClientRect(); at = { x: r.left + 12, y: r.top + 12 };`;
/** A real click on the open menu's item titled `title`. */
const menuItem = title => press(`const node = Array.from(document.querySelectorAll('.menu .menu-item'))
  .find(item => item.querySelector('.menu-item-title')?.textContent === ${JSON.stringify(title)});`, { view: VIEW });

try {
  await step('plugin', makePluginStep(cdp, evaluate, flag));
  required(record, 'open', await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE })));
  // What the pasteboard held before the case, written back in `finally`.
  required(record, 'clipboard-saved', await step('clipboard-saved', () => evaluate(`const { clipboard } = require('electron');
    const image = clipboard.readImage();
    window.__mappyE2EClipboard = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(),
      image: image.isEmpty() ? null : image.toPNG().toString('base64') };
    return { formats: clipboard.availableFormats() };`)));

  // 4a. An image on the OS clipboard, pasted into the open draft.
  await step('paste-image', async () => {
    await openDraft('学ぶこと', '学ぶこと（編集）');
    await markSeen();
    const formats = await clip({ image: true });
    await pasteKey();
    const after = await state();
    const typed = await draftValue();
    await cdp.realKey('Enter');
    await wait(1500);
    const settled = await state();
    check(formats.includes('image/png'), `the clipboard did not hold an image: ${JSON.stringify(formats)}`);
    check(after.messages.length === 0, `the paste showed ${JSON.stringify(after.messages)}`);
    check(after.editing && typed === '学ぶこと（編集）', `the draft did not stay open with the typed text: ${JSON.stringify(typed)}`);
    check(/## 学ぶこと\n\n!\[\[[^\]]+\.png\]\]/u.test(after.source), 'the pasted image was not written under 学ぶこと');
    check(settled.messages.length === 0, `Enter showed ${JSON.stringify(settled.messages)}`);
    check(!settled.editing && /## 学ぶこと（編集）\n\n!\[\[[^\]]+\.png\]\]/u.test(settled.source), 'Enter did not write the draft beside the image');
    return { formats, after: { ...after, draft: typed }, settled };
  });

  // 4b. Text only: the textarea's own paste, the map not involved.
  await step('paste-text', async () => {
    const before = (await state()).source;
    await openDraft('記録する', '記録');
    await markSeen();
    const formats = await clip({ text: '貼った文字' });
    await pasteKey();
    const after = await state();
    const typed = await draftValue();
    await cdp.realKey('Escape');
    await wait(800);
    check(after.messages.length === 0, `the paste showed ${JSON.stringify(after.messages)}`);
    check(typed === '記録貼った文字', `the text did not go into the draft: ${JSON.stringify(typed)}`);
    check(after.source === before, 'a text paste wrote the note');
    return { formats, draft: typed, changed: after.source !== before };
  });

  // 4c. An image with text, as a spreadsheet's cells put them on the pasteboard. Which one wins is recorded as observed
  // (`imageAttached`, `draft`), not checked: the checks are only that nothing is refused and the draft stays open.
  await step('paste-image-and-text', async () => {
    const before = (await state()).source;
    await openDraft('記録する', '記録');
    await markSeen();
    const formats = await clip({ text: '表のセル', image: true });
    await pasteKey();
    const after = await state();
    const typed = await draftValue();
    await cdp.realKey('Escape');
    await wait(800);
    check(after.messages.length === 0, `the paste showed ${JSON.stringify(after.messages)}`);
    check(after.editing, 'the draft closed on the paste');
    return { formats, draft: typed, imageAttached: after.source !== before && /## 記録する\n\n!\[\[/u.test(after.source) };
  });

  // 3. Undo over an open draft, from the canvas's context menu.
  await step('undo-over-draft', async () => {
    await openDraft('三', '三（編集）');
    await clip({ image: true });
    await pasteKey();
    const pasted = await state();
    await markSeen();
    await rightClick(CANVAS_CORNER);
    const menu = await evaluate(`${VIEW} return { menu: !!document.querySelector('.menu'), editing: !!input(), draft: input()?.value ?? null };`);
    check(menu.menu, 'the right click did not open the menu');
    // Where the draft closed on the right click (its blur saved it), Undo would take that save back instead: the case has
    // not reached what it is for, and says so as a failure rather than a PASS that ran nothing (PR #76).
    check(menu.editing, 'the right click closed the draft: Undo over an open draft was not reached');
    if (!menu.menu || !menu.editing) {
      await cdp.realKey('Escape');
      return { pasted: pasted.source, menu, reachable: false };
    }
    await menuItem('元に戻す');
    await wait(1500);
    const undone = await state();
    const typed = await draftValue();
    await cdp.realKey('Enter');
    await wait(1500);
    const settled = await state();
    check(/### 三\n\n!\[\[/u.test(pasted.source), 'the image was not pasted under 三');
    check(undone.editing && typed === '三（編集）', `Undo did not leave the draft open with the typed text: ${JSON.stringify(typed)}`);
    check(!/### 三\n\n!\[\[/u.test(undone.source), 'Undo did not take the image back');
    check(settled.messages.length === 0, `Enter after Undo showed ${JSON.stringify(settled.messages)}`);
    check(!settled.editing && settled.source.includes('### 三（編集）\n'), 'Enter after Undo did not write the draft');
    return { menu, reachable: true, undone: { ...undone, draft: typed }, settled };
  });

  // 2. A command the note refuses, over an open draft: nothing is written, the draft stays with what was typed.
  await step('refused-command', async () => {
    const before = (await state()).source;
    await openDraft('六', '六（編集）');
    await markSeen();
    await rightClick(`const node = nth('七', 0);`);
    const menu = await evaluate(`${VIEW} return { menu: !!document.querySelector('.menu'), editing: !!input() };`);
    if (!menu.menu || !menu.editing) {
      await cdp.realKey('Escape');
      check(menu.menu, 'the right click on 七 did not open the menu');
      check(menu.editing, 'the right click closed the draft: the refused command over an open draft was not reached');
      return { menu, reachable: false };
    }
    await menuItem('子を追加');
    await wait(1500);
    const after = await state();
    const typed = await draftValue();
    await cdp.realKey('Escape');
    await wait(800);
    check(after.messages.includes('見出しは 6 階層までです。'), `the refusal was not shown: ${JSON.stringify(after.messages)}`);
    check(after.source === before, 'the refused command left a write behind');
    check(after.editing && typed === '六（編集）', `the draft did not stay open with the typed text: ${JSON.stringify(typed)}`);
    return { menu, reachable: true, after: { ...after, draft: typed } };
  });

} catch (error) {
  if (!(error instanceof StopCase)) throw error;
} finally {
  // Whatever stopped the steps, the note, its attachments and the leaf this run made go (not with --keep): a next run
  // would otherwise open a note left open here, and count its attachments as the vault's own.
  if (!flag('--keep')) {
    await step('clean', () => evaluate(`const leaf = window.__mappyE2E;
      if (!leaf) return { removed: [] };
      const before = window.__mappyE2EBefore ?? new Set();
      const attachments = app.vault.getFiles().filter(file => !before.has(file.path) && file.extension === 'png');
      const note = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
      for (const file of [...attachments, ...(note ? [note] : [])]) await app.vault.delete(file, true);
      leaf.detach();
      delete window.__mappyE2E;
      delete window.__mappyE2EBefore;
      return { removed: attachments.map(file => file.path) };`)).catch(() => undefined);
  }
  // The user's clipboard back as it was, whatever the steps did.
  await step('clipboard-restored', () => evaluate(`const saved = window.__mappyE2EClipboard;
    if (!saved) return { restored: false };
    const { clipboard, nativeImage } = require('electron');
    const data = {};
    if (saved.text) data.text = saved.text;
    if (saved.html) data.html = saved.html;
    if (saved.rtf) data.rtf = saved.rtf;
    if (saved.image) data.image = nativeImage.createFromBuffer(Buffer.from(saved.image, 'base64'));
    clipboard.clear();
    if (Object.keys(data).length > 0) clipboard.write(data);
    delete window.__mappyE2EClipboard;
    return { restored: true, formats: clipboard.availableFormats() };`)).catch(() => undefined);
  cdp.close();
}

process.exit(await finish(record, value('--json')));
