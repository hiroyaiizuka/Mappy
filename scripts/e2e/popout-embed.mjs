/**
 * E89 (docs/harness.md): a map note embedded with `![[…]]` in a note open in a popout window becomes a map there as soon
 * as Obsidian puts it on the popout's document, without the main window's DOM changing (LEV-359).
 *
 * Obsidian 1.14.4 builds a popout's sections in the main window's document and puts them on the popout's afterwards. In
 * live preview Mappy waits for that (the embedded note's sections reach it off the document, LEV-91), and builds before
 * LEV-359 watched only the document a section was built in: in a popout they claimed only once the main window's DOM
 * changed after the section joined the popout's, and with the main window quiet (an embed below the fold scrolled to in
 * the popout) the embed stayed Obsidian's note embed. The reading view replaces the placeholder before Obsidian loads
 * the note (no wait), and its rows are here to show that path stays as it was in a popout.
 *
 * Rows are the person's operations × the embed's shape: open the host note in a popout (with the same host open in a
 * main tab, and without), scroll to an embed below the fold in the popout, and move a tab of the host to a new window
 * (`moveLeafToPopout`, what the tab menu's 「新規ウィンドウに移動」 calls) × live preview and the reading view, two embeds
 * in the host (`![[地図]]` and `![[地図#講座の案内]]`). Each popout row records the order of the popout's waiting sections,
 * its map frames and the main window's DOM changes (`watchClaimOrder`): a map claimed only after a main-window change
 * fails as one that never came. Then: everything closed leaves no map element and no handler on Obsidian's event hubs
 * beyond the ones before the case (the wait's window events go with it), the notes are not written, and no page error.
 *
 * Not covered here: dragging a tab out of the window by hand, moving a popout's tab back into the main window (no API;
 * a drag), the Canvas card in a popout (E88), and the main window's own embeds (E55, LEV-354).
 *
 * Usage (see docs/harness.md 実機検証 for the Obsidian instance):
 *   npm run harness:e2e:popout-embed -- [--reload] [--json <out.json>] [--keep]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required, until } from './case-runner.mjs';
import { makePluginStep, refuseOpenLeaves } from './dom-helpers.mjs';
import { CLAIM_ORDER, ERRORS, HANDLERS, claimWaitedOnMain, forwardErrors, handlerDiff, watchClaimOrder } from './window-helpers.mjs';

const { flag, value } = parseArgs();

const DIR = 'Fixtures/E2E-popout-embed';
const MAP = `${DIR}/地図.md`;
const HOST = `${DIR}/ホスト.md`;
const LONG = `${DIR}/長いホスト.md`;
const MAP_SOURCE = ['---', 'mappy: true', '---', '## 講座の案内', '- 回復する', '  - 睡眠', '  - 運動', '- 記録する', '  - 日誌', ''].join('\n');
const HOST_SOURCE = '# ホスト\n\n本文。\n\n![[地図]]\n\n![[地図#講座の案内]]\n';
// Far below the fold of a popout of 800 px: Obsidian renders the embed only when it is scrolled to.
const LONG_SOURCE = `# 長いホスト\n\n${Array.from({ length: 120 }, (_, i) => `段落 ${i + 1}。`).join('\n\n')}\n\n![[地図]]\n\n終わり。\n`;
const FILES = { [MAP]: MAP_SOURCE, [HOST]: HOST_SOURCE, [LONG]: LONG_SOURCE };
const LIVE = { mode: 'source', source: false };
const READING = { mode: 'preview' };
/** How long a popout's embeds get to become maps once they are on its document. */
const CLAIM_WAIT = 4000;

const record = createRecord(VAULT, HOST);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);

/** Script: `leaf`, a new tab of the main window (the unpinned leaf when no tab group has been active yet). */
const NEW_TAB = `const leaf = (() => { try { return app.workspace.getLeaf('tab'); } catch { return app.workspace.getLeaf(false); } })();`;

/**
 * Script: what the embeds of the leaf `window.__mappyE2EEmbedLeaf` show in the mode on screen — map frames with their node
 * count, and Obsidian's own embeds left. Only the mode on screen: a note opened in the reading view keeps its hidden
 * editor, whose live-preview embeds stay Obsidian's until the editor is shown (in the main window too).
 */
const SHOWN = `const leaf = window.__mappyE2EEmbedLeaf; const view = leaf?.view;
  if (!view?.containerEl) throw new Error('no leaf under test');
  const root = view.getMode?.() === 'preview' ? view.previewMode.containerEl : view.containerEl.querySelector('.markdown-source-view') ?? view.containerEl;
  const spans = Array.from(root.querySelectorAll('.internal-embed'));
  const frames = Array.from(root.querySelectorAll('.mappy-embed'), frame => frame.querySelectorAll('.mappy-node').length);
  return { window: leaf.getContainer().win === window ? 'main' : 'popout', mode: view.getMode?.() ?? null,
    maps: frames.filter(count => count >= 2).length, frames, embeds: spans.length,
    obsidian: spans.filter(span => !span.classList.contains('mappy-embed-host') && span.querySelector('.markdown-embed-content')).length };`;

/** The leaf's embeds once `maps` of them are maps; a timeout names what was seen last. */
const settled = async (maps, timeout = CLAIM_WAIT) => {
  let last = null;
  try {
    return await until(async () => { last = await evaluate(SHOWN); return last.maps >= maps ? last : null; }, timeout, `${maps} maps did not show`);
  } catch (error) {
    throw new Error(`${error.message}; last seen: ${JSON.stringify(last)}`);
  }
};

/** Opens a popout leaf (marked for `connect({ popout })`), connects to it first (background throttling off), and hands both back. */
const openPopout = async mark => {
  await evaluate(`const leaf = app.workspace.openPopoutLeaf({ size: { width: 900, height: 800 } });
    const win = leaf.getContainer().win;
    if (win === window) { leaf.detach(); throw new Error('openPopoutLeaf gave a leaf in the main window'); }
    win.document.body.dataset.mappyE2ePopout = ${JSON.stringify(mark)};
    ${forwardErrors('win', mark)}
    window.__mappyE2EEmbedLeaf = leaf; return true;`);
  return connect({ popout: mark });
};

/** Closes every popout window and every leaf on the case's notes, as the person would, and waits for them to go. */
const closeAll = () => evaluate(`const paths = ${JSON.stringify(Object.keys(FILES))};
  const leaves = []; app.workspace.iterateAllLeaves(item => { if (paths.includes(item.view?.file?.path)) leaves.push(item); });
  for (const item of leaves) item.detach();
  window.__mappyE2EEmbedLeaf?.detach(); window.__mappyE2EEmbedLeaf = null;
  await new Promise(resolve => setTimeout(resolve, 900));
  return true;`);

/** A real wheel over the leaf's scroller in the popout until its embed is on screen. */
const scrollToEmbed = async (pop, scroller) => {
  const inPop = expression => pop.evaluate(`(() => { ${expression} })()`);
  const at = await inPop(`const s = document.querySelector(${JSON.stringify(scroller)}); if (!s) throw new Error('no scroller'); const r = s.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
  for (let notch = 0; notch < 80; notch += 1) {
    await pop.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: 400 });
    await wait(40);
    const seen = await inPop(`const s = document.querySelector(${JSON.stringify(scroller)}); const view = s.getBoundingClientRect();
      const embed = Array.from(document.querySelectorAll('.internal-embed, .mappy-embed')).find(el => { const r = el.getBoundingClientRect(); return r.bottom > view.top && r.top < view.bottom; });
      return { onScreen: !!embed, top: Math.round(s.scrollTop), end: s.scrollTop + s.clientHeight >= s.scrollHeight - 2 };`);
    if (seen.onScreen || seen.end) return { notches: notch + 1, ...seen };
  }
  throw new Error('the embed did not come on screen');
};

/**
 * One popout row: `host` opened in a popout in `state` (a main tab of it first when `alongside`), or, with `scroll`,
 * opened there and then scrolled to the embed with the main window left alone. The claim order is recorded from just
 * before the embeds can reach the popout's document.
 */
const popoutRow = async ({ name, host, state, maps, alongside = false, scroll = null }) => {
  let main = null;
  if (alongside) {
    main = await evaluate(`${NEW_TAB} await leaf.openFile(app.vault.getAbstractFileByPath(${JSON.stringify(host)}), { state: ${JSON.stringify(state)}, active: true });
      window.__mappyE2EEmbedLeaf = leaf; return true;`).then(() => settled(maps));
  }
  const pop = await openPopout(`lev359-${name}`);
  try {
    let scrolled = null;
    if (scroll) {
      await evaluate(`const leaf = window.__mappyE2EEmbedLeaf; await leaf.openFile(app.vault.getAbstractFileByPath(${JSON.stringify(host)}), { state: ${JSON.stringify(state)}, active: true });
        await new Promise(resolve => setTimeout(resolve, 1500)); return true;`);
      const before = await evaluate(SHOWN);
      await evaluate(`const leaf = window.__mappyE2EEmbedLeaf; ${watchClaimOrder('leaf')} return true;`);
      scrolled = { before, ...(await scrollToEmbed(pop, scroll)) };
    } else {
      await evaluate(`const leaf = window.__mappyE2EEmbedLeaf; ${watchClaimOrder('leaf')}
        await leaf.openFile(app.vault.getAbstractFileByPath(${JSON.stringify(host)}), { state: ${JSON.stringify(state)}, active: true }); return true;`);
    }
    const shown = await settled(maps).catch(error => ({ error: String(error) }));
    const order = await evaluate(`return ${CLAIM_ORDER};`);
    const claims = claimWaitedOnMain(order);
    check(!shown.error && shown.window === 'popout' && shown.obsidian === 0, `${name}: the popout's embeds are not maps: ${JSON.stringify({ shown, claims })}`);
    check(claims.waitedOnMain.length === 0 && claims.stillWaiting === 0, `${name}: the popout's embeds waited for the main window's DOM to change (LEV-359): ${JSON.stringify({ claims, order })}`);
    if (scroll) check(scrolled.before.maps === 0, `${name}: the embed was drawn before the scroll, so the row did not scroll to it: ${JSON.stringify(scrolled)}`);
    return { shown, claims, order, scrolled, main };
  } finally {
    pop.close();
    await evaluate(`${CLAIM_ORDER}; return true;`).catch(() => null);
    await closeAll();
  }
};

/** The notes as they are on disk, with their modified times. */
const disk = () => evaluate(`const out = {};
  for (const path of ${JSON.stringify(Object.keys(FILES))}) { const file = app.vault.getAbstractFileByPath(path); out[path] = file ? { text: await app.vault.adapter.read(path), mtime: file.stat.mtime } : null; }
  return out;`);

let baseline = null;
let written = null;
try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));

  required(record, 'setup', await step('setup', () => evaluate(`${refuseOpenLeaves(Object.keys(FILES))}
    ${ERRORS}
    const popouts = []; app.workspace.iterateAllLeaves(item => { if (item.getContainer().win !== window) popouts.push(item.getViewState().type); });
    if (popouts.length) throw new Error('popout windows are open (' + popouts.join(', ') + '); close them first');
    if (!app.vault.getAbstractFileByPath(${JSON.stringify(DIR)})) await app.vault.createFolder(${JSON.stringify(DIR)});
    for (const [path, text] of Object.entries(${JSON.stringify(FILES)})) {
      const file = app.vault.getAbstractFileByPath(path);
      if (file) await app.vault.modify(file, text); else await app.vault.create(path, text);
    }
    await new Promise(resolve => setTimeout(resolve, 800));
    // The main area as the case leaves it (a tab opened and closed: Obsidian's own new empty tab), so the handlers compare.
    ${NEW_TAB} await leaf.openFile(app.vault.getAbstractFileByPath(${JSON.stringify(MAP)}), { active: true }); leaf.detach();
    await new Promise(resolve => setTimeout(resolve, 800));
    window.__mappyE2EBaseline = ${HANDLERS};
    return { obsidian: require('electron').ipcRenderer.sendSync('version') };`)));
  baseline = await evaluate('return window.__mappyE2EBaseline;');
  written = await disk();

  // ライブプレビュー: the host open in a main tab too, then in a popout; and in a popout alone.
  await step('live-alongside', () => popoutRow({ name: 'live-alongside', host: HOST, state: LIVE, maps: 2, alongside: true }));
  await step('live-alone', () => popoutRow({ name: 'live-alone', host: HOST, state: LIVE, maps: 2 }));
  // An embed below the fold of the popout, scrolled to there: nothing of the main window changes meanwhile.
  await step('live-scroll', () => popoutRow({ name: 'live-scroll', host: LONG, state: LIVE, maps: 1, scroll: '.cm-scroller' }));
  // 閲覧: the same in the reading view.
  await step('reading-alongside', () => popoutRow({ name: 'reading-alongside', host: HOST, state: READING, maps: 2, alongside: true }));
  await step('reading-scroll', () => popoutRow({ name: 'reading-scroll', host: LONG, state: READING, maps: 1, scroll: '.markdown-preview-view' }));

  // 「新規ウィンドウに移動」: a second tab of the host moved to a new window (the main window loses a tab, so it changes).
  await step('move', async () => {
    try {
      await evaluate(`${NEW_TAB} await leaf.openFile(app.vault.getAbstractFileByPath(${JSON.stringify(HOST)}), { state: ${JSON.stringify(LIVE)}, active: true }); return true;`);
      await evaluate(`${NEW_TAB} await leaf.openFile(app.vault.getAbstractFileByPath(${JSON.stringify(HOST)}), { state: ${JSON.stringify(LIVE)}, active: true });
        window.__mappyE2EEmbedLeaf = leaf; return true;`);
      const before = await settled(2);
      await evaluate(`const leaf = window.__mappyE2EEmbedLeaf; app.workspace.moveLeafToPopout(leaf);
        await new Promise(resolve => setTimeout(resolve, 300));
        if (leaf.getContainer().win === window) throw new Error('the tab did not move to a new window');
        ${forwardErrors('leaf.getContainer().win', 'lev359-move')} return true;`);
      const shown = await settled(2).catch(error => ({ error: String(error) }));
      check(!shown.error && shown.window === 'popout' && shown.obsidian === 0, `move: the moved tab's embeds are not maps: ${JSON.stringify(shown)}`);
      return { before, shown };
    } finally {
      await closeAll();
    }
  });

  // Everything closed: no map element in the main window, and the event hubs back to where they were (the wait's
  // `window-open`／`window-close` and every map's own listeners went with them).
  await step('close', async () => {
    const result = await evaluate(`await new Promise(resolve => setTimeout(resolve, 600));
      const popouts = []; app.workspace.iterateAllLeaves(item => { if (item.getContainer().win !== window) popouts.push(item.getViewState().type); });
      return { handlers: ${HANDLERS}, left: document.querySelectorAll('.mappy-embed, .mappy-embed-anchor, .mappy-embed-host').length, popouts };`);
    const changed = handlerDiff(baseline, result.handlers);
    check(changed.length === 0, `handlers left after everything closed: ${changed.join(', ')}`);
    check(result.left === 0, `${result.left} map elements left in the main window`);
    check(result.popouts.length === 0, `popout leaves left: ${result.popouts.join(', ')}`);
    return { changed, left: result.left, popouts: result.popouts };
  });

  // 閲覧で書き換えない: the notes are as the case wrote them, not even saved again.
  await step('unchanged', async () => {
    const now = await disk();
    const changed = Object.keys(FILES).filter(path => now[path]?.text !== FILES[path] || now[path]?.mtime !== written[path]?.mtime);
    check(changed.length === 0, `notes written by the case's viewing: ${changed.join(', ')}`);
    return { changed };
  });

  await step('errors', async () => {
    const errors = await evaluate('return window.__mappyE2EErrors ?? [];');
    check(errors.length === 0, `page errors: ${errors.join(' | ')}`);
    return { errors };
  });
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`unexpected: ${error}`);
} finally {
  await step('clean', async () => {
    await closeAll();
    if (!flag('--keep')) {
      await evaluate(`for (const path of ${JSON.stringify(Object.keys(FILES))}) { const file = app.vault.getAbstractFileByPath(path); if (file) await app.vault.delete(file); }
        return true;`);
    }
    return true;
  });
  cdp.close();
}
process.exitCode = await finish(record, value('--json'));
