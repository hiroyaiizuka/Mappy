/**
 * E56 (docs/harness.md, LEV-216): a draft open while its window loses the OS focus, on the real Obsidian. Switching
 * to another app (or another Obsidian window) blurs the focused textarea while it stays the document's active element
 * (`document.hasFocus()` is false). Builds through 0.3.7 saved the draft on that blur and closed it, so the Enter the
 * person pressed on coming back to confirm it reached the selected node instead and added a sibling 「サブトピック」
 * (seen once in E50's step 6, a map moved to a new window). The draft is still saved on leaving the window, but stays
 * open. The window's focus is taken away with Electron's own
 * `BrowserWindow.blur()` and given back with `focus()`, as another app taking it would; the case checks that the blur
 * really happened (the textarea still active, the document without focus) before it counts the Enter.
 *
 * 1. main: F2 → text → the window blurs (the note has the rename, the draft is still open and active) and comes back
 *    → Enter: the note has the rename and nothing else, no draft is left open.
 * 2. moved: the same in a map moved to a new window (`moveLeafToPopout`, the tab menu's 「新規ウィンドウに移動」).
 * 3. click-after: F2 → text → the window blurs and comes back → a press on the empty canvas: the draft is saved (a
 *    blur inside the window still commits it).
 * 4. close-moved: F2 → text → the moved window blurs and, still in the background, is closed: the draft is in the
 *    note (a window without the focus sends the draft no blur as it goes, so what saves it is the save on leaving;
 *    review 1 of LEV-216 found a build that kept the draft unsaved losing it here).
 * 5. close-main: the same with the main window's tab closed (`leaf.detach()`) while the window is in the background.
 * Steps 1–3 also record the keys their window received; a key the case did not send (someone typing while the test
 * window has the OS focus) fails the step as foreign input, not as the build's. Steps 4 and 5 send no key after F2.
 *
 * Usage: npm run harness:e2e:window-blur-draft -- [--reload] [--json <out.json>] [--keep]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep, makeAfter, makePress, makeNoteStep, makeDeleteNote } from './dom-helpers.mjs';
import { ERRORS, WINDOW_LOG, foreignKeys, forwardErrors, LAID_OUT } from './window-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-window-blur-draft.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## ウィンドウを離れる下書き', '',
  '- 通常のノード', '  - 子ノード', '- 別のノード', '',
].join('\n');

const record = createRecord(VAULT, NOTE);
const main = await connect();
const evaluate = expression => main.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const read = () => evaluate(`return app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}));`);
const reset = () => evaluate(`const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}); await app.vault.modify(file, ${JSON.stringify(SOURCE)});
  await new Promise(resolve => setTimeout(resolve, 600)); return true;`);

/**
 * Script (main window): `leaf` shows the note. Remembers it as its window's `__mappyE2E` (dom-helpers' `VIEW`), logs
 * the window's keys and OS focus changes (`WINDOW_LOG`), and sends a popout's uncaught errors to the main window's
 * list, which `after` reads.
 */
const watch = `const win = leaf.view.contentEl.win;
  win.__mappyE2E = leaf;
  ${WINDOW_LOG}
  ${forwardErrors('win', 'moved')}
  ${LAID_OUT}`;

/**
 * Script (main window): a new tab in the main window as `tab`. `getLeaf('tab')` opens it beside the active leaf, which
 * can be in a popout (one Obsidian restored at launch from an earlier run's layout), so a main-window leaf is made
 * active first.
 */
const MAIN_TAB = `const anchor = app.workspace.getMostRecentLeaf(app.workspace.rootSplit);
  if (anchor) app.workspace.setActiveLeaf(anchor, { focus: false });
  const tab = app.workspace.getLeaf('tab');
  if (tab.getContainer().win !== window) { tab.detach(); throw new Error('a new tab did not open in the main window'); }`;

/**
 * Script (main window): the Electron window `leaf` is in, as `bw`. A popout is found by the mark step 2 puts on its body
 * (each window's page is asked), so another vault's popout or one an earlier run left open is never taken.
 */
const browserWindow = `const { BrowserWindow } = require('electron').remote;
  let bw = require('electron').remote.getCurrentWindow();
  if (leaf.view.contentEl.win !== window) {
    const mark = leaf.view.contentEl.doc.body.dataset.mappyE2ePopout;
    const found = [];
    for (const item of BrowserWindow.getAllWindows()) {
      if (item.isDestroyed()) continue;
      const its = await item.webContents.executeJavaScript('document.body?.dataset.mappyE2ePopout ?? null').catch(() => null);
      if (mark && its === mark) found.push(item);
    }
    if (found.length !== 1) throw new Error(found.length + ' windows carry the popout mark ' + mark);
    bw = found[0];
  }`;

/** Script (main window) finding the case's leaf as `leaf`. */
const LEAF = `const leaf = app.workspace.getLeavesOfType('mappy-map').find(item => item.view.file?.path === ${JSON.stringify(NOTE)});
  if (!leaf) throw new Error('the map is not open');`;

/**
 * Takes the OS focus from the window the map is in and gives it back, as switching to another app and back does.
 * Resolves to the window log entries of the blur and of the focus after it. Throws when no blur with the draft still
 * active happened (a window that did not have the focus to lose), or when the window did not get the focus back (a key
 * sent then still reaches the page over CDP, so the step would pass without the person's return) — either way the
 * step would prove nothing.
 */
const leaveWindow = async (windowEval, { back = true } = {}) => {
  // Obsidian has to be the active app for its window to have a focus to lose or get back (macOS ignores focus() otherwise).
  const refocus = `require('electron').remote.app.focus({ steal: true }); bw.focus(); await new Promise(resolve => setTimeout(resolve, 400));`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const mark = await windowEval('return window.__mappyE2EWindowLog.length;');
    await evaluate(`${LEAF} ${browserWindow}
      ${refocus}
      bw.blur(); await new Promise(resolve => setTimeout(resolve, 400));
      ${back ? refocus : ''}
      return true;`);
    const seen = await windowEval(`const log = window.__mappyE2EWindowLog.slice(${mark});
      const blur = log.findIndex(entry => entry.window === 'blur');
      return { blur: log[blur] ?? null, focus: blur === -1 ? null : log.slice(blur).find(entry => entry.window === 'focus') ?? null, hasFocus: document.hasFocus() };`);
    if (!seen.blur) continue;
    if (!seen.blur.draftActive || seen.blur.hasFocus) throw new Error(`the window blurred, but not with the draft active and the document unfocused: ${JSON.stringify(seen.blur)}`);
    if (!back) {
      if (seen.hasFocus) throw new Error(`the window got the OS focus back, which this step must not give it: ${JSON.stringify(seen)}`);
      return { blur: seen.blur };
    }
    if (!seen.focus || !seen.hasFocus) throw new Error(`the window did not get the OS focus back after the blur: ${JSON.stringify(seen)}`);
    return { blur: seen.blur, focus: seen.focus };
  }
  throw new Error('the window never lost the OS focus (BrowserWindow.blur had no effect in 3 tries)');
};

/** The keys a step's window received, and the ones among them the step did not send. */
const keysOf = async (windowEval, sent) => {
  const keys = await windowEval('return window.__mappyE2EWindowLog.filter(entry => entry.key);');
  return { keys, foreign: foreignKeys(keys, sent) };
};

/** F2 on 「通常のノード」 and `title` typed into the draft. */
const openDraft = async (cdp, windowEval, title) => {
  await makeSelect(cdp, windowEval)('通常のノード');
  await cdp.realKey('F2');
  for (let started = Date.now(); !(await windowEval(`${VIEW} return !!input();`)); await wait(100)) {
    if (Date.now() - started > 3000) throw new Error('F2 did not open the draft');
  }
  await cdp.insertText(title);
  await wait(300);
};

/** One step: F2 on 「通常のノード」, a title, the window left and come back to, then `finish` (Enter or a canvas press). */
const draftAcrossWindow = async (cdp, windowEval, { title, finishWith }) => {
  const after = makeAfter(windowEval);
  await openDraft(cdp, windowEval, title);
  const left = await leaveWindow(windowEval);
  const kept = await windowEval(`${VIEW} return { editing: !!input(), active: document.activeElement === input(), source: await source() };`);
  const before = kept.source;
  const saved = before === expectRenamed(title);
  let sent;
  if (finishWith === 'Enter') {
    await cdp.realKey('Enter');
    sent = ['F2', 'Enter'];
  } else {
    await makePress(cdp, windowEval)(`const node = el.querySelector('.mappy-canvas'); const box = node.getBoundingClientRect(); at = { x: box.left + 12, y: box.top + 12 };`,
      { avoid: '.mappy-node, .mappy-floating, .mappy-popover' });
    sent = ['F2'];
  }
  const done = await after(before);
  await wait(400);
  const { keys, foreign } = await keysOf(windowEval, sent);
  const final = await read();
  return { left, kept: { editing: kept.editing, active: kept.active, saved }, source: final, editing: done.editing, keys, foreign };
};

/** Closes every map of the note in the main window, so the next step finds only its own. */
const detach = () => evaluate(`for (const leaf of app.workspace.getLeavesOfType('mappy-map')) {
    if (leaf.view.file?.path === ${JSON.stringify(NOTE)} && leaf.view.contentEl.win === window) { window.__mappyE2E = null; leaf.detach(); }
  } await new Promise(resolve => setTimeout(resolve, 300)); return true;`);

/** The note in a main-window tab, as the case's leaf. */
const openInMain = () => evaluate(`${MAIN_TAB} const leaf = tab;
  await leaf.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(NOTE)} }, active: true });
  app.workspace.setActiveLeaf(leaf, { focus: true });
  ${watch} return true;`);

/** The note opened in a main-window tab and moved to a new window (the tab menu's 「新規ウィンドウに移動」), marked for `connect`. */
const openMoved = () => evaluate(`${MAIN_TAB}
  await tab.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(NOTE)} }, active: true });
  await new Promise(resolve => setTimeout(resolve, 600));
  app.workspace.moveLeafToPopout(tab);
  await new Promise(resolve => setTimeout(resolve, 800));
  ${LEAF}
  if (leaf.view.contentEl.win === window) throw new Error('the map did not move to a new window');
  leaf.view.contentEl.doc.body.dataset.mappyE2ePopout = 'blur-draft';
  ${watch} return true;`);

/** Closes the moved window, as its close button does. Resolves to whether it is gone. */
const closeMoved = () => evaluate(`${LEAF} const win = leaf.view.contentEl.win; if (win === window) throw new Error('the map is not in a moved window');
  win.__mappyE2E = null; win.__mappyE2EWindowLog = null; win.close();
  for (let started = Date.now(); Date.now() - started < 5000 && !win.closed; await new Promise(resolve => setTimeout(resolve, 50)));
  return win.closed;`);

/** The note once the view's own save has had time to land (a save started on close ends after the view is gone). */
const readSettled = async () => { await wait(1500); return read(); };

const expectRenamed = title => SOURCE.replace('- 通常のノード\n', `- ${title}\n`);

/** Step 5's body: the draft opened in the main tab, the window left without coming back, the tab closed. */
const closeInBackground = async () => {
  await openDraft(main, evaluate, '背景で閉じたタブの下書き');
  const left = await leaveWindow(evaluate, { back: false });
  const kept = await evaluate(`${VIEW} return { editing: !!input(), saved: (await source()) === ${JSON.stringify(expectRenamed('背景で閉じたタブの下書き'))} };`);
  await detach();
  const source = await readSettled();
  check(kept.editing && kept.saved, `5-close-main: leaving the window closed the draft or did not save it: ${JSON.stringify(kept)}`);
  check(source === expectRenamed('背景で閉じたタブの下書き'), `5-close-main: closing the tab in the background lost the draft: ${JSON.stringify(source)}`);
  return { left, kept, source };
};

try {
  required(record, 'plugin', await step('plugin', makePluginStep(main, evaluate, flag)));
  required(record, 'setup', await step('setup', makeNoteStep(evaluate, { note: NOTE, source: SOURCE, errors: ERRORS })));

  await step('1-main', async () => {
    await reset();
    await openInMain();
    const result = await draftAcrossWindow(main, evaluate, { title: '戻って確定', finishWith: 'Enter' }).finally(detach);
    check(result.foreign.length === 0, `1-main: keys the case did not send reached the window (foreign input; the step proves nothing): ${JSON.stringify(result.foreign)}`);
    check(result.kept.editing && result.kept.active && result.kept.saved, `1-main: leaving the window closed the draft or did not save it: ${JSON.stringify(result.kept)}`);
    check(result.source === expectRenamed('戻って確定') && !result.editing, `1-main: the Enter after coming back wrote ${JSON.stringify(result.source)} (editing ${result.editing})`);
    return result;
  });

  await step('2-moved', async () => {
    await detach();
    await reset();
    await openMoved();
    const moved = await connect({ popout: 'blur-draft' });
    const inMoved = expression => moved.evaluate(`(async () => { ${expression} })()`);
    try {
      const result = await draftAcrossWindow(moved, inMoved, { title: '移動先で戻って確定', finishWith: 'Enter' });
      check(result.foreign.length === 0, `2-moved: keys the case did not send reached the window (foreign input; the step proves nothing): ${JSON.stringify(result.foreign)}`);
      check(result.kept.editing && result.kept.active && result.kept.saved, `2-moved: leaving the window closed the draft or did not save it: ${JSON.stringify(result.kept)}`);
      check(result.source === expectRenamed('移動先で戻って確定') && !result.editing, `2-moved: the Enter after coming back wrote ${JSON.stringify(result.source)} (editing ${result.editing})`);
      return result;
    } finally {
      moved.close();
      await closeMoved();
    }
  });

  await step('3-click-after', async () => {
    await reset();
    await openInMain();
    const result = await draftAcrossWindow(main, evaluate, { title: '押して確定', finishWith: 'press' }).finally(detach);
    check(result.foreign.length === 0, `3-click-after: keys the case did not send reached the window (foreign input; the step proves nothing): ${JSON.stringify(result.foreign)}`);
    check(result.kept.editing && result.kept.saved, `3-click-after: leaving the window closed the draft or did not save it: ${JSON.stringify(result.kept)}`);
    check(result.source === expectRenamed('押して確定') && !result.editing, `3-click-after: a press inside the window after coming back did not save the draft: ${JSON.stringify(result.source)} (editing ${result.editing})`);
    return result;
  });

  await step('4-close-moved', async () => {
    await reset();
    await openMoved();
    const moved = await connect({ popout: 'blur-draft' });
    const inMoved = expression => moved.evaluate(`(async () => { ${expression} })()`);
    let left; let kept; let closed;
    try {
      await openDraft(moved, inMoved, '背景で閉じた下書き');
      left = await leaveWindow(inMoved, { back: false });
      kept = await inMoved(`${VIEW} return { editing: !!input(), saved: (await source()) === ${JSON.stringify(expectRenamed('背景で閉じた下書き'))} };`);
    } finally {
      moved.close();
      closed = await closeMoved();
    }
    const source = await readSettled();
    check(kept?.editing && kept.saved, `4-close-moved: leaving the window closed the draft or did not save it: ${JSON.stringify(kept)}`);
    check(closed, '4-close-moved: the window did not close');
    check(source === expectRenamed('背景で閉じた下書き'), `4-close-moved: closing the window in the background lost the draft: ${JSON.stringify(source)}`);
    return { left, kept, closed, source };
  });

  await step('5-close-main', async () => {
    await reset();
    await openInMain();
    // The main window would stay in the background otherwise, whatever this step ends with; the cleanup and the next
    // case expect it in front.
    const front = () => evaluate(`require('electron').remote.app.focus({ steal: true }); require('electron').remote.getCurrentWindow().focus(); return true;`);
    try { return await closeInBackground(); } finally { await front(); }
  });

  await step('after', async () => {
    const errors = await evaluate('return [...(window.__mappyE2EErrors ?? [])];');
    check(errors.length === 0, `page errors: ${JSON.stringify(errors).slice(0, 1500)}`);
    return { errors };
  });
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`stopped: ${error}`);
} finally {
  const tidy = async (name, run) => { try { await run(); } catch (error) { record.failures.push(`${name}: ${error}`); } };
  await tidy('close popout', () => evaluate(`for (const leaf of app.workspace.getLeavesOfType('mappy-map')) {
      if (leaf.view.file?.path !== ${JSON.stringify(NOTE)}) continue;
      const win = leaf.view.contentEl.win; if (win !== window && !win.closed) win.close(); else leaf.detach();
    } return true;`));
  if (record.steps.setup && !record.steps.setup.error && !flag('--keep')) {
    await wait(300);
    await step('clean', makeDeleteNote(evaluate, NOTE));
  }
  main.close();
}

process.exit(await finish(record, value('--json')));
