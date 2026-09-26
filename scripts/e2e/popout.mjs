/**
 * E50 (docs/harness.md, E09 の別ウィンドウ): the map in Obsidian's popout windows, on the real Obsidian (LEV-14). A
 * popout is another `window` and `document` with the same `app`; everything the view does against "the" document
 * (listeners, timers, `elementFromPoint`, focus, its stylesheet) has to be the popout's, and closing the window has
 * to take all of it down. The keys and clicks go to the popout's own CDP target (`connect({ popout })`), so they
 * arrive where a person's would.
 *
 * 1. open-popout: a map opened in a new popout draws there — its nodes are in the popout's document, Mappy's
 *    stylesheet is in the popout's head and applies (the root has its border).
 * 2. keys: a real click selects a node, F2 → type → Enter renames it, Tab adds a named child (the note gets exactly
 *    those lines).
 * 3. popover: the gear opens its popover in the popout (focus inside it), a real press on the empty canvas closes it.
 * 4. zoom and resize: the zoom button changes the label; resizing the popout window resizes the canvas.
 * 5. theme: switching Obsidian to the dark theme reaches the popout (its body and the map's canvas are dark).
 * 6. move-to-popout: a map open in the main window moved to a new window (`moveLeafToPopout`, what the tab menu's
 *    「新規ウィンドウに移動」 calls) keeps working there: select + F2 rename by real keys in the new window.
 * 7. close-with-draft: closing a popout window with a draft open leaves the note either as it was or with exactly the
 *    draft saved (which of the two is LEV-215's to settle; the record says which happened), and the window goes.
 * 8. cycles: a popout with a map opened and its window closed 10 times.
 * Then: the handler counts on the app's event hubs equal the ones before step 1, every view that lived in a popout
 * can be collected after a full GC, no popout window is left, and no page error happened in any window.
 *
 * What it cannot check (recorded, not passed): moving a window across monitors with different scale factors, the
 * OS window's own look, and dragging a tab out by hand (the case moves it with the API the menu uses).
 *
 * Usage: npm run harness:e2e:popout -- [--reload] [--json <out.json>] [--shot <out.png>] [--keep]
 *   --shot  a screenshot of the popout after step 2 (and <out>-dark.png in step 5)
 *   --keep  leave the note in the vault
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep, makeRename, makeAddNamed, refuseOpenLeaves } from './dom-helpers.mjs';
import { HANDLERS, handlerDiff, preciseGc, makeTrack, ERRORS } from './window-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-popout.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 別ウィンドウの確認', '',
  '- 通常のノード', '  - 子ノード', '  - [[uneven-branches|リンクのノード]]',
  '- 移動するノード', '  - 画像のノード ![[sample-image.svg]]', '',
].join('\n');
const CYCLES = 10;

const record = createRecord(VAULT, NOTE);
const main = await connect();
const evaluate = expression => main.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const track = makeTrack(evaluate);
const read = () => evaluate(`return app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}));`);

/** The popouts this case opened, by mark, so the `finally` can close whatever a failed step left. */
const opened = new Set();
let serial = 0;

/**
 * Script (main window): `leaf` is in a popout; mark its window, remember the leaf there as `window.__mappyE2E` (the
 * name dom-helpers' `VIEW` reads, in the popout's own global scope), send its uncaught errors to the main window's
 * list, and wait for the map to lay out.
 */
const settle = mark => `const win = leaf.view.contentEl.win;
  if (win === window) throw new Error('the leaf is not in a popout window');
  win.document.body.dataset.mappyE2ePopout = ${JSON.stringify(mark)};
  win.__mappyE2E = leaf;
  win.addEventListener('error', event => { window.__mappyE2EErrors.push(${JSON.stringify(mark)} + ': ' + String(event.error?.stack ?? event.message)); });
  win.addEventListener('unhandledrejection', event => { window.__mappyE2EErrors.push(${JSON.stringify(mark)} + ': ' + String(event.reason?.stack ?? event.reason)); });
  // Every key the popout's window receives (capture phase: Obsidian's keymap and the inline editor stop some keys before
  // they bubble), the element it was sent to, and — read once the event's task is over — whether something took it.
  // Kept in the record of step 6, to tell one key acted on twice (the inline editor and the map) from a second key.
  win.__mappyE2EKeys = [];
  win.addEventListener('keydown', event => {
    const entry = { key: event.key, target: String(event.target.className || event.target.tagName) };
    win.__mappyE2EKeys.push(entry);
    win.setTimeout(() => { entry.prevented = event.defaultPrevented; }, 0);
  }, true);
  let laid = false;
  for (const started = Date.now(); Date.now() - started < 5000 && !laid; await new Promise(resolve => setTimeout(resolve, 50))) {
    const node = leaf.view.contentEl.querySelector('.mappy-node');
    laid = !!node && node.getBoundingClientRect().width > 0;
  }
  if (!laid) throw new Error('the map did not lay out in the popout within 5 s');`;

/** Opens the note as a map in a new popout window; returns its mark. */
const openPopout = async () => {
  const mark = `p${serial += 1}`;
  opened.add(mark);
  await evaluate(`const leaf = app.workspace.openPopoutLeaf({ size: { width: 1000, height: 760 } });
    await leaf.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(NOTE)} }, active: true });
    ${settle(mark)} return true;`);
  return mark;
};

/** Connects to a marked popout and gives the helpers a case uses in the main window, bound to it. */
const attach = async mark => {
  const cdp = await connect({ popout: mark });
  const inPopout = expression => cdp.evaluate(`(async () => { ${expression} })()`);
  const clickIn = async selector => {
    const box = await inPopout(`${VIEW} const target = el.querySelector(${JSON.stringify(selector)});
      if (!target) throw new Error('no ' + ${JSON.stringify(selector)});
      const rect = target.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await wait(250);
  };
  return { cdp, evaluate: inPopout, select: makeSelect(cdp, inPopout), rename: makeRename(cdp, inPopout), add: makeAddNamed(cdp, inPopout), clickIn };
};

/**
 * The popout window marked `mark`, closed as its close button closes it (`window.close()` → Obsidian detaches its
 * leaves); its views are tracked first. Resolves to whether the window is gone.
 */
const closePopout = async mark => {
  const closed = await evaluate(`const leaves = [];
    app.workspace.iterateAllLeaves(leaf => { if (leaf.view?.contentEl?.doc?.body?.dataset.mappyE2ePopout === ${JSON.stringify(mark)}) leaves.push(leaf); });
    const win = leaves[0]?.view.contentEl.win;
    if (!win) return false;
    for (const leaf of leaves) { const view = leaf.view; ${track.statement(mark)} }
    win.close();
    for (const started = Date.now(); Date.now() - started < 5000 && !win.closed; await new Promise(resolve => setTimeout(resolve, 50)));
    await new Promise(resolve => setTimeout(resolve, 200));
    return win.closed;`);
  opened.delete(mark);
  return closed;
};

const windows = () => evaluate(`return require('electron').remote.BrowserWindow.getAllWindows().length;`);

try {
  required(record, 'plugin', await step('plugin', makePluginStep(main, evaluate, flag)));
  const setup = required(record, 'setup', await step('setup', async () => {
    const result = await evaluate(`${refuseOpenLeaves([NOTE])}
      ${ERRORS}
      const open = app.workspace.getLeavesOfType('mappy-map').length;
      if (open > 0) throw new Error(open + ' map leaves are already open; the baseline would count their handlers. Close them first.');
      const existing = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
      if (existing) await app.vault.modify(existing, ${JSON.stringify(SOURCE)});
      else await app.vault.create(${JSON.stringify(NOTE)}, ${JSON.stringify(SOURCE)});
      await new Promise(resolve => setTimeout(resolve, 400));
      return { appTheme: app.vault.getConfig('theme') ?? 'system', windows: require('electron').remote.BrowserWindow.getAllWindows().length };`);
    await track.reset();
    return result;
  }));
  // Warm-up (as E49): one popout opened and closed, so Obsidian's own lazily created handlers are in the baseline.
  required(record, 'warm-up', await step('warm-up', async () => closePopout(await openPopout())));
  const baseline = await step('baseline', () => evaluate(`return ${HANDLERS};`));

  // 1–5 in one popout.
  const first = await openPopout();
  const pop = await attach(first);
  await step('1-open-popout', async () => {
    const result = await pop.evaluate(`${VIEW}
      const root = nodes().find(item => item.classList.contains('is-root')) ?? nodes()[0];
      return {
        ownDocument: root.ownerDocument === document && document !== window.opener?.document,
        nodes: nodes().length,
        stylesheet: Array.from(document.head.querySelectorAll('style')).some(style => style.textContent.includes('.mappy-view')),
        border: parseFloat(getComputedStyle(root).borderTopWidth),
      };`);
    check(result.ownDocument, '1-open-popout: the map nodes are not in the popout\'s document');
    check(result.nodes > 0, '1-open-popout: no nodes in the popout');
    check(result.stylesheet, '1-open-popout: Mappy\'s stylesheet is not in the popout\'s head');
    check(result.border > 0, '1-open-popout: the root has no border in the popout (Mappy\'s CSS does not apply)');
    return result;
  });

  await step('2-keys', async () => {
    await pop.select('子ノード');
    const renamed = await pop.rename('改名した子');
    check(renamed.messages.length === 0 && !renamed.editing, `2-keys: F2 rename left ${JSON.stringify(renamed.messages)} (editing ${renamed.editing})`);
    const expectRenamed = SOURCE.replace('  - 子ノード\n', '  - 改名した子\n');
    check(renamed.source === expectRenamed, `2-keys: F2 rename in the popout wrote ${JSON.stringify(renamed.source)}`);
    await pop.select('改名した子');
    const added = await pop.add('Tab', '追加した孫');
    const expectAdded = expectRenamed.replace('  - 改名した子\n', '  - 改名した子\n    - 追加した孫\n');
    check(added.source === expectAdded && added.labels.includes('追加した孫'), `2-keys: Tab in the popout wrote ${JSON.stringify(added.source)}`);
    const shot = value('--shot');
    if (shot) await pop.cdp.screenshot(shot);
    return { renamed: renamed.source === expectRenamed, added: added.source === expectAdded };
  });

  await step('3-popover', async () => {
    await pop.clickIn('.mappy-actions .mappy-button');
    const shown = await pop.evaluate(`${VIEW} const card = el.querySelector('.mappy-popover');
      return { open: !!card, inPopout: card?.ownerDocument === document, focusInside: !!card && card.contains(document.activeElement) };`);
    check(shown.open && shown.inPopout, `3-popover: the gear did not open its popover in the popout: ${JSON.stringify(shown)}`);
    check(shown.focusInside, '3-popover: the focus is not in the popover');
    // A press on the canvas away from the nodes and the floating controls: the outside-press listener is on the popout's document.
    const box = await pop.evaluate(`${VIEW} const rect = el.querySelector('.mappy-canvas').getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.bottom - 90 };`);
    for (const type of ['mousePressed', 'mouseReleased']) await pop.cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await wait(250);
    const closed = await pop.evaluate(`${VIEW} return !el.querySelector('.mappy-popover');`);
    check(closed, '3-popover: a press outside did not close the popover in the popout');
    return { ...shown, closed };
  });

  await step('4-zoom-resize', async () => {
    const label = () => pop.evaluate(`${VIEW} return el.querySelector('.mappy-zoom').textContent;`);
    const before = await label();
    await pop.clickIn('.mappy-zoom .mappy-button[aria-label="拡大"]');
    const after = await label();
    check(before !== after, `4-zoom-resize: the zoom button did not change the label (${before})`);
    const canvas = () => pop.evaluate(`${VIEW} const rect = el.querySelector('.mappy-canvas').getBoundingClientRect(); return [Math.round(rect.width), Math.round(rect.height)];`);
    const sizeBefore = await canvas();
    await evaluate(`const leaves = []; app.workspace.iterateAllLeaves(leaf => { if (leaf.view?.contentEl?.doc?.body?.dataset.mappyE2ePopout === ${JSON.stringify(first)}) leaves.push(leaf); });
      leaves[0].view.contentEl.win.resizeTo(760, 560); await new Promise(resolve => setTimeout(resolve, 700)); return true;`);
    const sizeAfter = await canvas();
    const nodesAfter = await pop.evaluate(`${VIEW} return nodes().filter(node => node.getBoundingClientRect().width > 0).length;`);
    check(sizeAfter[0] < sizeBefore[0] && sizeAfter[1] < sizeBefore[1], `4-zoom-resize: the canvas did not follow the window (${sizeBefore} → ${sizeAfter})`);
    check(nodesAfter > 0, '4-zoom-resize: no laid-out nodes after the resize');
    return { before, after, sizeBefore, sizeAfter, nodesAfter };
  });

  await step('5-theme', async () => {
    await evaluate(`app.changeTheme('obsidian'); await new Promise(resolve => setTimeout(resolve, 600)); return true;`);
    const dark = await pop.evaluate(`${VIEW}
      const [r, g, b] = getComputedStyle(el.querySelector('.mappy-canvas')).backgroundColor.match(/\\d+/gu).map(Number);
      return { body: document.body.classList.contains('theme-dark'), canvas: [r, g, b], canvasDark: r + g + b < 3 * 90 };`);
    const shot = value('--shot');
    if (shot) await pop.cdp.screenshot(shot.replace(/\.png$/u, '-dark.png'));
    await evaluate(`app.changeTheme(${JSON.stringify(setup.appTheme)}); await new Promise(resolve => setTimeout(resolve, 400)); return true;`);
    check(dark.body && dark.canvasDark, `5-theme: the popout did not follow the dark theme: ${JSON.stringify(dark)}`);
    return dark;
  });
  pop.cdp.close();
  await step('close-first', async () => {
    const closed = await closePopout(first);
    check(closed, 'close-first: the popout window did not close');
    return closed;
  });

  // 6. A map in the main window moved to a new window.
  await step('6-move-to-popout', async () => {
    const mark = `p${serial += 1}`;
    opened.add(mark);
    await evaluate(`const tab = app.workspace.getLeaf('tab');
      await tab.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(NOTE)} }, active: true });
      await new Promise(resolve => setTimeout(resolve, 600));
      { const view = tab.view; ${track.statement('moved-from-main')} }
      app.workspace.moveLeafToPopout(tab);
      await new Promise(resolve => setTimeout(resolve, 800));
      const leaf = app.workspace.getLeavesOfType('mappy-map').find(item => item.view.file?.path === ${JSON.stringify(NOTE)} && item.view.contentEl.win !== window);
      if (!leaf) throw new Error('no map leaf in a new window after moveLeafToPopout');
      ${settle(mark)} return true;`);
    const moved = await attach(mark);
    const before = await read();
    await moved.select('通常のノード');
    const renamed = await moved.rename('移動先で改名');
    const keys = await moved.evaluate('return window.__mappyE2EKeys;');
    moved.cdp.close();
    // Once in six runs (2026-09-26, LEV-216) the Enter also added a sibling 「サブトピック」 here; not reproduced in 15
    // isolated tries. `keys` says whether that is one Enter handled twice or a second key.
    const expected = before.replace('- 通常のノード\n', '- 移動先で改名\n');
    check(renamed.source === expected, `6-move-to-popout: F2 rename after the move wrote ${JSON.stringify(renamed.source)} (keys ${JSON.stringify(keys)})`);
    const closed = await closePopout(mark);
    check(closed, '6-move-to-popout: the window did not close');
    return { renamed: renamed.source === expected, closed, keys };
  });

  // 7. The popout closed with a draft open.
  await step('7-close-with-draft', async () => {
    const mark = await openPopout();
    const drafting = await attach(mark);
    const before = await read();
    await drafting.select('移動するノード');
    await drafting.cdp.realKey('F2');
    await wait(250);
    await drafting.cdp.insertText('保存されない下書き');
    const editing = await drafting.evaluate(`${VIEW} return !!input();`);
    drafting.cdp.close();
    const closed = await closePopout(mark);
    await wait(500);
    const after = await read();
    check(editing, '7-close-with-draft: the draft did not open');
    check(closed, '7-close-with-draft: the window did not close');
    // Whether closing saves the draft or drops it is not settled (the view's onClose says dropped; a closing tab saves it
    // through the textarea's blur — LEV-215). Either is accepted here and recorded; anything else is a broken write.
    const saved = before.replace('- 移動するノード\n', '- 保存されない下書き\n');
    check(after === before || after === saved, `7-close-with-draft: closing the window left neither the note nor the draft saved: ${JSON.stringify(after)}`);
    return { editing, closed, outcome: after === before ? 'dropped' : after === saved ? 'saved' : 'other' };
  });

  // 8. Popouts opened and closed.
  await step('8-cycles', async () => {
    const failures = [];
    for (let index = 1; index <= CYCLES; index += 1) {
      const mark = await openPopout();
      if (!await closePopout(mark)) failures.push(mark);
    }
    check(failures.length === 0, `8-cycles: popouts that did not close: ${failures.join(', ')}`);
    return { cycles: CYCLES, failures };
  });

  await step('after', async () => {
    const handlers = await evaluate(`return ${HANDLERS};`);
    const diff = handlerDiff(baseline, handlers);
    check(diff.length === 0, `handlers after the popouts differ from before: ${diff.join('; ')}`);
    const count = await windows();
    check(count === setup.windows, `${count} windows are open, ${setup.windows} were before`);
    await preciseGc(main);
    const alive = await track.alive();
    const tracked = await track.count();
    check(tracked >= CYCLES + 3 && alive.length === 0, `${alive.length} of ${tracked} closed popout views are still reachable after a full GC: ${alive.join(', ')}`);
    const errors = await evaluate('return [...(window.__mappyE2EErrors ?? [])];');
    check(errors.length === 0, `page errors: ${JSON.stringify(errors).slice(0, 1500)}`);
    return { diff, windows: count, tracked, alive, errors };
  });
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`stopped: ${error}`);
} finally {
  try {
    for (const mark of [...opened]) await closePopout(mark);
    if (record.steps.setup && !record.steps.setup.error) {
      await evaluate(`app.changeTheme(${JSON.stringify(record.steps.setup.appTheme)});
        for (const leaf of app.workspace.getLeavesOfType('mappy-map')) if (leaf.view.file?.path === ${JSON.stringify(NOTE)}) leaf.detach();
        delete window.__mappyE2ETracked; return true;`);
      if (!flag('--keep')) {
        await wait(300);
        await step('clean', () => evaluate(`const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}); if (file) await app.vault.delete(file); return true;`));
      }
    }
  } catch (error) {
    record.failures.push(`clean: ${error}`);
  }
  main.close();
}

process.exit(await finish(record, value('--json')));
