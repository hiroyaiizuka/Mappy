/**
 * E77 (docs/harness.md): an open draft and the map's own writes on the real Obsidian (LEV-141).
 *
 * 4. The real clipboard. Every earlier check (jsdom, E37) built the paste event itself, `clipboardData` included, and
 *    dispatched it on the canvas. Here the OS clipboard holds the image (Electron's `clipboard`, which is the
 *    system pasteboard), and the paste is the one ⌘V runs through Obsidian's Edit menu (`webContents.paste()`): the
 *    event starts in the draft's textarea, carries what the pasteboard gives, and reaches the canvas by bubbling.
 *    Shapes: an image only, text only, and an image with text (what a spreadsheet's cells put on the pasteboard).
 * A real right press closes a plain draft (its blur saves it), so on the real Obsidian the menu's commands and Undo run
 * over an open draft only when it is held with a reason on its error line. Steps 3 and 2 hold it first (`holdDraft`),
 * and `right-click-closes-plain-draft` pins the premise.
 * 3. Undo over a held draft: an image pasted onto its node, then right click on the empty canvas → 元に戻す, then Enter.
 * 2. A command the note refuses over a held draft: the draft on one sixth-level heading, a right click on another → 子を追加
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
// `mappy: true`: a note the router takes as a map (without it the leaf opens as Markdown).
const SOURCE = [
  '---', 'mappy: true', '---',
  '# 計画', '',
  '## 学ぶこと', '',
  '## 記録する', '',
  '## 二', '', '### 三', '', '#### 四', '', '##### 五', '', '###### 六', '', '###### 七', '',
].join('\n');

const record = createRecord(VAULT, NOTE);
// The OS clipboard is every instance's (LEV-327): run alone.
const cdp = await connect({ solo: 'puts images and text on the OS clipboard' });
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
  // A draft a failed step left open (held) is given up first, so one step's failure does not type into the next's.
  if (await evaluate(`${VIEW} return !!input();`)) {
    await focusDraft();
    await cdp.realKey('Escape');
    await wait(500);
  }
  await select(title);
  await cdp.realKey('F2');
  await wait(500);
  const open = await evaluate(`${VIEW} return !!input() && document.activeElement === input();`);
  if (!open) throw new Error(`F2 did not open a focused draft on ${title}`);
  await cdp.insertText(text);
  await wait(300);
};
const draftValue = () => evaluate(`${VIEW} return input()?.value ?? null;`);
/** A real right press and release where `locate` (makePress) says: what it does to the focus is the real pointer's. */
const rightPress = async locate => {
  const at = await press(locate, { click: false });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'right', buttons: 2, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'right', buttons: 0, clickCount: 1 });
  await wait(500);
  return at;
};
/**
 * The context menu at the same point. CDP's right button does not raise `contextmenu` in Obsidian's window (probe
 * 2026-09-30, with and without `buttons`), so the event is dispatched there, as E76 does. True when the menu opened.
 */
const openMenu = async locate => {
  const at = await press(locate, { click: false });
  return evaluate(`const target = document.elementFromPoint(${at.x}, ${at.y});
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: ${at.x}, clientY: ${at.y} }));
    await new Promise(resolve => setTimeout(resolve, 300));
    return !!document.querySelector('.menu');`);
};
const closeMenu = () => evaluate(`document.querySelectorAll('.menu').forEach(menu => menu.remove()); return true;`);
/**
 * Hold the open draft: ` #` typed after its text makes the heading's rename one the note refuses (the closing sequence
 * of an ATX heading), so Enter keeps it with the reason on its error line; Backspace ×2 then takes the ` #` back. A
 * held draft is not saved by a blur. Returns the reason shown.
 */
const holdDraft = async () => {
  await cdp.insertText(' #');
  await wait(200);
  await cdp.realKey('Enter');
  await wait(1200);
  const reason = await evaluate(`${VIEW} return el.querySelector('.mappy-inline-error')?.textContent?.trim() ?? '';`);
  await cdp.realKey('Backspace');
  await cdp.realKey('Backspace');
  await wait(300);
  return reason;
};
/** A real click into the open draft's textarea, so the next key is the draft's. */
const focusDraft = () => press(`const node = input();`);
const CANVAS_CORNER = `const node = el.querySelector('.mappy-canvas'); const r = node.getBoundingClientRect(); at = { x: r.left + 40, y: r.top + 80 };`;
/** A real click on the open menu's item titled `title`. */
const menuItem = title => press(`const node = Array.from(document.querySelectorAll('.menu .menu-item'))
  .find(item => item.querySelector('.menu-item-title')?.textContent === ${JSON.stringify(title)});`, { view: VIEW });

try {
  await step('plugin', makePluginStep(cdp, evaluate, flag));
  required(record, 'open', await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE })));
  // What the pasteboard held before the case, written back in `finally`.
  // Obsidian's own menus (not the OS's) for the run, as E76 does: the case reads and clicks the menu in the page. Put back
  // in `finally`.
  await evaluate(`window.__mappyE2ENativeMenus = app.vault.getConfig('nativeMenus'); app.vault.setConfig('nativeMenus', false); return true;`);
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

  // A plain draft on a real right click: the press takes the focus from the textarea, and its blur saves and closes the
  // draft before any menu (probe 2026-09-30: on the empty canvas and on another node alike). So Undo or a command from
  // the context menu never runs over a plain draft on the real Obsidian; the drafts that stay open are those held with a
  // reason on their error line, which a blur does not save. Pinned here, since steps 3 and 2 rest on it.
  await step('right-click-closes-plain-draft', async () => {
    await openDraft('記録する', '記録（右クリック）');
    await rightPress(CANVAS_CORNER);
    const after = await state();
    await closeMenu();
    check(!after.editing, 'a real right press left a plain draft open: steps 3 and 2 no longer cover the open-draft case alone');
    check(after.source.includes('## 記録（右クリック）\n'), 'the right press did not save the plain draft');
    return { editing: after.editing, saved: after.source.includes('## 記録（右クリック）\n') };
  });

  // 3. Undo over a held draft, from the canvas's context menu. The image pasted onto the node being edited is taken back;
  // Enter then writes the draft (before LEV-141: 「編集中の内容が Markdown 側で変わりました…」).
  await step('undo-over-held-draft', async () => {
    await openDraft('三', '三（編集）');
    await clip({ image: true });
    await pasteKey();
    const pasted = await state();
    const reason = await holdDraft();
    await markSeen();
    await rightPress(CANVAS_CORNER);
    const held = await evaluate(`${VIEW} return { editing: !!input(), draft: input()?.value ?? null };`);
    const opened = await openMenu(CANVAS_CORNER);
    if (!held.editing || !opened) {
      check(held.editing, 'the right press closed the held draft');
      check(opened, 'the context menu did not open');
      await closeMenu();
      return { pasted: pasted.source, reason, held, opened };
    }
    await menuItem('元に戻す');
    await wait(1500);
    const undone = await state();
    const typed = await draftValue();
    await focusDraft();
    await cdp.realKey('Enter');
    await wait(1500);
    const settled = await state();
    check(/### 三\n\n!\[\[[^\]]+\.png\]\]/u.test(pasted.source), 'the image was not pasted under 三');
    check(reason.length > 0, 'the draft was not held (no error line)');
    check(undone.editing && typed === '三（編集）', `Undo did not leave the draft open with the typed text: ${JSON.stringify(typed)}`);
    check(!/### 三\n\n!\[\[/u.test(undone.source), 'Undo did not take the image back');
    check(settled.messages.length === 0, `Enter after Undo showed ${JSON.stringify(settled.messages)}`);
    check(!settled.editing && settled.source.includes('### 三（編集）\n'), 'Enter after Undo did not write the draft');
    return { reason, held, undone: { ...undone, draft: typed }, settled };
  });

  // 2. A command the note refuses, over a held draft: 子を追加 on another sixth-level heading. Nothing is written, the draft
  // stays with what was typed (before LEV-141: the draft was written, then the command refused).
  await step('refused-command-over-held-draft', async () => {
    // The whole map in view: the sixth-level headings sit far right of the body root.
    await evaluate(`${VIEW} if (view.layout) view.viewport.fit(view.layout.bounds); await new Promise(resolve => setTimeout(resolve, 500)); return true;`);
    await openDraft('六', '六（編集）');
    const reason = await holdDraft();
    const before = (await state()).source;
    await markSeen();
    const on七 = `const node = nth('七', 0);`;
    // Fit again: the held draft's error line can widen the map.
    await evaluate(`${VIEW} if (view.layout) view.viewport.fit(view.layout.bounds); await new Promise(resolve => setTimeout(resolve, 500)); return true;`);
    await rightPress(on七);
    const held = await evaluate(`${VIEW} return { editing: !!input() };`);
    const opened = await openMenu(on七);
    if (!held.editing || !opened) {
      check(held.editing, 'the right press on 七 closed the held draft');
      check(opened, 'the context menu on 七 did not open');
      await closeMenu();
      return { reason, held, opened };
    }
    await menuItem('子を追加');
    await wait(1500);
    const after = await state();
    const typed = await draftValue();
    // Before LEV-141 the draft was written and closed by then: nothing left to give up.
    if (after.editing) {
      await focusDraft();
      await cdp.realKey('Escape');
      await wait(800);
    }
    check(reason.length > 0, 'the draft was not held (no error line)');
    check(after.messages.includes('見出しは 6 階層までです。'), `the refusal was not shown: ${JSON.stringify(after.messages)}`);
    check(after.source === before, 'the refused command left a write behind');
    check(after.editing && typed === '六（編集）', `the draft did not stay open with the typed text: ${JSON.stringify(typed)}`);
    return { reason, held, after: { ...after, draft: typed } };
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
  await evaluate(`if ('__mappyE2ENativeMenus' in window) { app.vault.setConfig('nativeMenus', window.__mappyE2ENativeMenus); delete window.__mappyE2ENativeMenus; } return true;`).catch(() => undefined);
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
