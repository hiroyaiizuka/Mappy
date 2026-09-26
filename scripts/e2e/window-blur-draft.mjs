/**
 * E56 (docs/harness.md, LEV-216): a draft open while its window loses the OS focus, on the real Obsidian. Switching
 * to another app (or another Obsidian window) blurs the focused textarea while it stays the document's active element
 * (`document.hasFocus()` is false). Builds through 0.3.7 saved the draft on that blur and closed it, so the Enter the
 * person pressed on coming back to confirm it reached the selected node instead and added a sibling 「サブトピック」
 * (seen once in E50's step 6, a map moved to a new window). The window's focus is taken away with Electron's own
 * `BrowserWindow.blur()` and given back with `focus()`, as another app taking it would; the case checks that the blur
 * really happened (the textarea still active, the document without focus) before it counts the Enter.
 *
 * 1. main: F2 → text → the window blurs and comes back → Enter: the note has the rename and nothing else, no draft is
 *    left open.
 * 2. moved: the same in a map moved to a new window (`moveLeafToPopout`, the tab menu's 「新規ウィンドウに移動」).
 * 3. click-after: F2 → text → the window blurs and comes back → a press on the empty canvas: the draft is saved (a
 *    blur inside the window still commits it).
 * Every step also records the keys its window received; a key the case did not send (someone typing while the test
 * window has the OS focus) fails the step as foreign input, not as the build's.
 *
 * Usage: npm run harness:e2e:window-blur-draft -- [--reload] [--json <out.json>] [--keep]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep, makeAfter, makePress, makeNoteStep, makeDeleteNote } from './dom-helpers.mjs';
import { ERRORS } from './window-helpers.mjs';

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
 * Script (main window): `leaf` shows the note. Remembers it as its window's `__mappyE2E` (dom-helpers' `VIEW`), and
 * logs in that window every key it receives (capture phase) and every blur／focus of the window itself.
 */
const watch = `const win = leaf.view.contentEl.win;
  win.__mappyE2E = leaf;
  if (!win.__mappyE2EWindowLog) {
    const log = win.__mappyE2EWindowLog = [];
    win.addEventListener('keydown', event => { win.__mappyE2EWindowLog?.push({ key: event.key, target: String(event.target.className || event.target.tagName) }); }, true);
    win.addEventListener('blur', event => {
      if (event.target !== win) return;
      const active = win.document.activeElement;
      log.push({ window: 'blur', draftActive: !!active?.matches?.('textarea.mappy-inline-input'), hasFocus: win.document.hasFocus() });
    }, true);
    win.addEventListener('focus', event => { if (event.target === win) log.push({ window: 'focus' }); }, true);
  }
  win.__mappyE2EWindowLog.length = 0;
  for (let started = Date.now(); Date.now() - started < 5000 && !leaf.view.contentEl.querySelector('.mappy-node'); await new Promise(resolve => setTimeout(resolve, 50)));`;

/**
 * Script (main window): the Electron window `leaf` is in, as `bw`. A popout is the one `about:blank` window besides the
 * main one (the case opens no other).
 */
const browserWindow = `const { BrowserWindow } = require('electron').remote;
  const me = require('electron').remote.getCurrentWindow();
  let bw = me;
  if (leaf.view.contentEl.win !== window) {
    const others = BrowserWindow.getAllWindows().filter(item => item.webContents.id !== me.webContents.id && item.webContents.getURL() === 'about:blank');
    if (others.length !== 1) throw new Error(others.length + ' popout windows; the case expects exactly one');
    bw = others[0];
  }`;

/** Script (main window) finding the case's leaf as `leaf`. */
const LEAF = `const leaf = app.workspace.getLeavesOfType('mappy-map').find(item => item.view.file?.path === ${JSON.stringify(NOTE)});
  if (!leaf) throw new Error('the map is not open');`;

/**
 * Takes the OS focus from the window the map is in and gives it back, as switching to another app and back does.
 * Resolves to the window log entry of the blur, or throws when no blur with the draft still active happened (a
 * window that did not have the focus to lose — then the step would prove nothing).
 */
const leaveWindow = async windowEval => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const mark = await windowEval('return window.__mappyE2EWindowLog.length;');
    await evaluate(`${LEAF} ${browserWindow}
      // Obsidian has to be the active app for its window to have a focus to lose (macOS ignores focus() otherwise).
      require('electron').remote.app.focus({ steal: true });
      bw.focus(); await new Promise(resolve => setTimeout(resolve, 300));
      bw.blur(); await new Promise(resolve => setTimeout(resolve, 400));
      bw.focus(); await new Promise(resolve => setTimeout(resolve, 400));
      return true;`);
    const blur = await windowEval(`return window.__mappyE2EWindowLog.slice(${mark}).find(entry => entry.window === 'blur') ?? null;`);
    if (blur) {
      if (!blur.draftActive || blur.hasFocus) throw new Error(`the window blurred, but not with the draft active and the document unfocused: ${JSON.stringify(blur)}`);
      return blur;
    }
  }
  throw new Error('the window never lost the OS focus (BrowserWindow.blur had no effect in 3 tries)');
};

/** The keys a step's window received, and the ones among them the step did not send. */
const keysOf = async (windowEval, sent) => {
  const keys = (await windowEval('return window.__mappyE2EWindowLog.filter(entry => entry.key);'));
  const expected = [...sent];
  const foreign = keys.filter(entry => { const at = expected.indexOf(entry.key); if (at === -1) return true; expected.splice(at, 1); return false; });
  return { keys, foreign };
};

/** One step: F2 on 「通常のノード」, a title, the window left and come back to, then `finish` (Enter or a canvas press). */
const draftAcrossWindow = async (cdp, windowEval, { title, finishWith }) => {
  const select = makeSelect(cdp, windowEval);
  const after = makeAfter(windowEval);
  await select('通常のノード');
  await cdp.realKey('F2');
  for (let started = Date.now(); !(await windowEval(`${VIEW} return !!input();`)); await wait(100)) {
    if (Date.now() - started > 3000) throw new Error('F2 did not open the draft');
  }
  await cdp.insertText(title);
  await wait(300);
  const blur = await leaveWindow(windowEval);
  const kept = await windowEval(`${VIEW} return { editing: !!input(), active: document.activeElement === input(), source: await source() };`);
  const before = kept.source;
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
  const errors = await evaluate('return window.__mappyE2EErrors.length;');
  return { blur, kept: { editing: kept.editing, active: kept.active, unchanged: before === SOURCE }, source: final, editing: done.editing, keys, foreign, errorsSoFar: errors };
};

/** Closes every map of the note in the main window, so the next step finds only its own. */
const detach = () => evaluate(`for (const leaf of app.workspace.getLeavesOfType('mappy-map')) {
    if (leaf.view.file?.path === ${JSON.stringify(NOTE)} && leaf.view.contentEl.win === window) { window.__mappyE2E = null; leaf.detach(); }
  } await new Promise(resolve => setTimeout(resolve, 300)); return true;`);

const expectRenamed = title => SOURCE.replace('- 通常のノード\n', `- ${title}\n`);

try {
  required(record, 'plugin', await step('plugin', makePluginStep(main, evaluate, flag)));
  required(record, 'setup', await step('setup', makeNoteStep(evaluate, { note: NOTE, source: SOURCE, errors: ERRORS })));

  await step('1-main', async () => {
    await reset();
    await evaluate(`const leaf = app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(NOTE)} }, active: true });
      app.workspace.setActiveLeaf(leaf, { focus: true });
      ${watch} return true;`);
    const result = await draftAcrossWindow(main, evaluate, { title: '戻って確定', finishWith: 'Enter' }).finally(detach);
    check(result.foreign.length === 0, `1-main: keys the case did not send reached the window (foreign input; the step proves nothing): ${JSON.stringify(result.foreign)}`);
    check(result.kept.editing && result.kept.active && result.kept.unchanged, `1-main: leaving the window closed or saved the draft: ${JSON.stringify(result.kept)}`);
    check(result.source === expectRenamed('戻って確定') && !result.editing, `1-main: the Enter after coming back wrote ${JSON.stringify(result.source)} (editing ${result.editing})`);
    return result;
  });

  await step('2-moved', async () => {
    await detach();
    await reset();
    await evaluate(`const tab = app.workspace.getLeaf('tab');
      await tab.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(NOTE)} }, active: true });
      await new Promise(resolve => setTimeout(resolve, 600));
      app.workspace.moveLeafToPopout(tab);
      await new Promise(resolve => setTimeout(resolve, 800));
      ${LEAF}
      if (leaf.view.contentEl.win === window) throw new Error('the map did not move to a new window');
      leaf.view.contentEl.doc.body.dataset.mappyE2ePopout = 'blur-draft';
      ${watch} return true;`);
    const moved = await connect({ popout: 'blur-draft' });
    const inMoved = expression => moved.evaluate(`(async () => { ${expression} })()`);
    try {
      const result = await draftAcrossWindow(moved, inMoved, { title: '移動先で戻って確定', finishWith: 'Enter' });
      check(result.foreign.length === 0, `2-moved: keys the case did not send reached the window (foreign input; the step proves nothing): ${JSON.stringify(result.foreign)}`);
      check(result.kept.editing && result.kept.active && result.kept.unchanged, `2-moved: leaving the window closed or saved the draft: ${JSON.stringify(result.kept)}`);
      check(result.source === expectRenamed('移動先で戻って確定') && !result.editing, `2-moved: the Enter after coming back wrote ${JSON.stringify(result.source)} (editing ${result.editing})`);
      return result;
    } finally {
      moved.close();
      await evaluate(`${LEAF} const win = leaf.view.contentEl.win; win.__mappyE2E = null; win.__mappyE2EWindowLog = null; win.close();
        for (let started = Date.now(); Date.now() - started < 5000 && !win.closed; await new Promise(resolve => setTimeout(resolve, 50)));
        return win.closed;`);
    }
  });

  await step('3-click-after', async () => {
    await reset();
    await evaluate(`const leaf = app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(NOTE)} }, active: true });
      app.workspace.setActiveLeaf(leaf, { focus: true });
      ${watch} return true;`);
    const result = await draftAcrossWindow(main, evaluate, { title: '押して確定', finishWith: 'press' }).finally(detach);
    check(result.foreign.length === 0, `3-click-after: keys the case did not send reached the window (foreign input; the step proves nothing): ${JSON.stringify(result.foreign)}`);
    check(result.kept.editing && result.kept.unchanged, `3-click-after: leaving the window closed or saved the draft: ${JSON.stringify(result.kept)}`);
    check(result.source === expectRenamed('押して確定') && !result.editing, `3-click-after: a press inside the window after coming back did not save the draft: ${JSON.stringify(result.source)} (editing ${result.editing})`);
    return result;
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
