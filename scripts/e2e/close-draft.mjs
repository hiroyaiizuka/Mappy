/**
 * E59 (docs/harness.md, LEV-215): a title draft open (F2, neither Enter nor Escape) when its map view closes, on the
 * real Obsidian. Decided 2026-09-27: closing saves the draft, as a Markdown tab keeps what was typed. Through 0.3.8
 * only the textarea's blur saved it (Obsidian takes the view's element out before `onClose`, and Chromium blurs the
 * focused draft as it goes), while `onClose` dropped the draft: what that blur does not save was lost without a word.
 * The rows are the way of closing × the draft's shape.
 *
 * 1. tab: F2 → text → the tab closed with ⌘W's command (`workspace:close`): the note has the text.
 * 2. ime: F2 → a composition left unconfirmed (`Input.imeSetComposition`) → the tab closed: the note has what the
 *    draft showed as it closed (the case checks that a composition really was under way first).
 * 3. held-refreshed: F2 → text → another line changed outside the map just before the Enter, which is refused and
 *    held with the line saying the same Enter now applies it → the tab closed: the draft is applied over the change.
 * 3b. unread: F2 → text → another line changed outside the map and the tab closed at once, before the map reads it: the
 *    save on close is refused, re-reads the note and applies the draft over the change (review 1).
 * 4. held-own-node: F2 → text → the node itself changed outside the map → the Enter is refused and held → the tab
 *    closed: the note keeps the outside change, and a Notice says the draft was not saved (not a silent loss).
 * 5. new-node: Tab adds a child under its provisional name → the tab closed: the node stays as added (only Escape
 *    takes it back, LEV-203), nothing more written.
 * 6. plugin: F2 → text → Mappy disabled (its views go) and enabled again: the note has the text.
 * 7. popout-held: row 4 in a popout window, closed with its close button: the Notice shows in the main window (the
 *    popout's document goes with the window, and a Notice there would be the silent loss again).
 * The popout window closed with a plain draft is E50's step 7 (judged "saved" since LEV-215).
 *
 * Rows 1, 5 and 6 pass on 0.3.8 too (the draft's blur saved rows 1 and 6; row 5 writes nothing): they pin that the save
 * on close keeps those, not that it was needed. Rows 2, 3, 3b, 4 and 7 fail there (lost without a word).
 *
 * With `--exits`, the two ends that do not go through the view's `onClose` follow (LEV-230, judged since then):
 * 8. reload: F2 → text → `app:reload`: after the reload the note has the text, with no Notice saying otherwise (kept
 *    at `pagehide` and applied as Mappy loads again). 8b. reload-held-own-node: row 4's held draft → `app:reload`: the
 *    note keeps the outside change and a Notice after the reload names the draft. 9. quit: row 3's held draft (its
 *    blur does not save it) → Obsidian quit (`app.quit()`): the process ends (not only the window: a quit that waits
 *    for a task leaves Obsidian running with no window on macOS), the note on disk is as before the quit (kept, not
 *    written as the page went), and once the case has launched Obsidian again (macOS only: `open -na`, the profile
 *    `MAPPY_E2E_PROFILE`, default `artifacts/obsidian-profile`, and the same port) the note has the draft over the
 *    change, with no Notice saying otherwise, and the kept entry is used up (8 too: an apply that threw before the
 *    page's error collector was installed again would leave it). Notices of others at launch are not counted. On
 *    0.3.9, 8 and 9 lose the draft and 8b shows no Notice; a plain draft at the quit passes there too (the window's
 *    blur after `unload` saves it), so row 9 uses a held one. The quit comes last.
 *
 * Usage: npm run harness:e2e:close-draft -- [--reload] [--json <out.json>] [--keep] [--exits]
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, PORT, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep, makeNoteStep, makeDeleteNote } from './dom-helpers.mjs';
import { ERRORS } from './window-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-close-draft.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 閉じる下書き', '',
  '- 親', '  - 子ノード', '- 別のノード', '',
].join('\n');
const renamed = (title, from = SOURCE) => from.replace('  - 子ノード\n', `  - ${title}\n`);
const REFRESHED = 'Markdown が更新されました。もう一度確定すると新しい内容に適用し、取り消すと閉じます。';
const NOT_SAVED = '編集中の内容を保存できませんでした';
const EXIT_NOT_SAVED = '再読込・終了のときに';
/** src/ui/exit-drafts.ts's `EXIT_DRAFTS_KEY`: empty once the plugin has applied what the page before kept. */
const EXIT_KEY = 'mappy-exit-drafts';

/** Row 9 launches Obsidian again after its quit, with the profile the harness names (docs/harness.md 実機検証). */
const OBSIDIAN_APP = process.env.MAPPY_E2E_OBSIDIAN_APP ?? '/Applications/Obsidian.app';
const PROFILE = process.env.MAPPY_E2E_PROFILE ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'artifacts', 'obsidian-profile');
/** Set while Obsidian is down after row 9's quit: nothing is left to tidy or to reach. */
let quitDone = false;

const record = createRecord(VAULT, NOTE);
let cdp = await connect();
let evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const read = () => evaluate(`return app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}));`);
const reset = () => evaluate(`const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}); await app.vault.modify(file, ${JSON.stringify(SOURCE)});
  await new Promise(resolve => setTimeout(resolve, 600)); return true;`);

/** Script finding the case's map leaf as `leaf` (null when none is open). */
const LEAF = `const leaf = app.workspace.getLeavesOfType('mappy-map').find(item => item.view.file?.path === ${JSON.stringify(NOTE)}) ?? null;`;

/**
 * The note in a new main-window tab, active and focused, remembered as `__mappyE2E` (dom-helpers' `VIEW`). Notices
 * already on screen are dismissed, so what a step reads is its own; the composition log is installed on the window.
 */
const open = () => evaluate(`for (const notice of document.querySelectorAll('.notice')) notice.remove();
  const anchor = app.workspace.getMostRecentLeaf(app.workspace.rootSplit);
  if (anchor) app.workspace.setActiveLeaf(anchor, { focus: false });
  const leaf = app.workspace.getLeaf('tab');
  await leaf.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(NOTE)}, layout: 'mindmap' }, active: true });
  await new Promise(resolve => setTimeout(resolve, 1200));
  app.workspace.setActiveLeaf(leaf, { focus: true });
  window.__mappyE2E = leaf;
  window.__mappyE2EComposition = [];
  if (!window.__mappyE2ECompositionWatched) {
    window.__mappyE2ECompositionWatched = true;
    for (const type of ['compositionstart', 'compositionend']) {
      document.addEventListener(type, event => { window.__mappyE2EComposition?.push(type + ':' + (event.data ?? '')); }, true);
    }
  }
  return true;`);

/** F2 on 「子ノード」, then `title` typed (none: the draft keeps the title it opened on). */
const openDraft = async title => {
  await makeSelect(cdp, evaluate)('子ノード');
  await cdp.realKey('F2');
  for (let started = Date.now(); !(await evaluate(`${VIEW} return !!input();`)); await wait(100)) {
    if (Date.now() - started > 3000) throw new Error('F2 did not open the draft');
  }
  if (title !== undefined) {
    await evaluate(`${VIEW} input().select(); return true;`);
    await cdp.insertText(title);
  }
  await wait(300);
};

/**
 * ⌘W's command on the case's tab (it is the active leaf), then time for a save started on close to land. Resolves to
 * whether the map is gone, the note, and the Notices that showed.
 */
const closeTab = async () => {
  const active = await evaluate(`${LEAF} return app.workspace.activeLeaf === leaf;`);
  if (!active) throw new Error('the map is not the active leaf; workspace:close would close another tab');
  await evaluate(`window.__mappyE2E = null; app.commands.executeCommandById('workspace:close'); return true;`);
  await wait(1500);
  return evaluate(`${LEAF} return { gone: !leaf, source: await app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)})),
    notices: Array.from(document.querySelectorAll('.notice'), item => item.textContent.trim()) };`);
};

/** The draft's error line and text. */
const draftState = () => evaluate(`${VIEW} return { editing: !!input(), value: input()?.value ?? null,
  error: el.querySelector('.mappy-inline-error')?.textContent ?? '' };`);

/** Closes every map of the note, so the next step finds only its own. */
const detachAll = () => evaluate(`for (const leaf of app.workspace.getLeavesOfType('mappy-map')) {
    if (leaf.view.file?.path === ${JSON.stringify(NOTE)}) leaf.detach();
  } window.__mappyE2E = null; await new Promise(resolve => setTimeout(resolve, 300)); return true;`);

/** Waits for the CDP port to answer with our vault's window again (after `app:reload`), and reconnects. */
const reconnect = async () => {
  cdp.close();
  // While the window reloads connect() refuses; the last refusal is the reason when it never comes back (a window
  // that came back in another language says so, rather than "did not come back").
  let refused = null;
  for (let started = Date.now(); Date.now() - started < 30000; await wait(1000)) {
    try { cdp = await connect(); refused = null; break; } catch (error) { refused = error; }
  }
  if (refused) throw refused;
  evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
  for (let started = Date.now(); Date.now() - started < 30000; await wait(500)) {
    if (await evaluate('return !!app.plugins.plugins.mappy && app.workspace.layoutReady;').catch(() => false)) return;
  }
  throw new Error('the window did not come back after the reload');
};

try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  required(record, 'setup', await step('setup', makeNoteStep(evaluate, { note: NOTE, source: SOURCE, errors: ERRORS })));

  await step('1-tab', async () => {
    await reset();
    await open();
    await openDraft('閉じたタブの下書き');
    const closed = await closeTab();
    check(closed.gone, '1-tab: the tab did not close');
    check(closed.source === renamed('閉じたタブの下書き'), `1-tab: closing the tab did not save the draft: ${JSON.stringify(closed.source)}`);
    check(closed.notices.length === 0, `1-tab: a Notice showed: ${JSON.stringify(closed.notices)}`);
    return closed;
  });

  await step('2-ime', async () => {
    await reset();
    await open();
    await openDraft();
    await evaluate(`${VIEW} const box = input(); box.setSelectionRange(box.value.length, box.value.length); return true;`);
    await cdp.send('Input.imeSetComposition', { text: 'へんかん', selectionStart: 4, selectionEnd: 4 });
    await wait(300);
    const composing = await evaluate(`${VIEW} return { value: input()?.value ?? null, log: [...window.__mappyE2EComposition] };`);
    if (!composing.log.some(entry => entry.startsWith('compositionstart')))
      throw new Error(`no composition started (the step would prove nothing): ${JSON.stringify(composing)}`);
    if (composing.log.some(entry => entry.startsWith('compositionend')))
      throw new Error(`the composition ended before the close: ${JSON.stringify(composing)}`);
    const closed = await closeTab();
    const log = await evaluate('return [...(window.__mappyE2EComposition ?? [])];');
    check(closed.gone, '2-ime: the tab did not close');
    check(closed.source === renamed(composing.value), `2-ime: closing mid composition did not save what the draft showed (${JSON.stringify(composing.value)}): ${JSON.stringify(closed.source)}`);
    check(closed.notices.length === 0, `2-ime: a Notice showed: ${JSON.stringify(closed.notices)}`);
    return { composing, log, ...closed };
  });

  await step('3-held-refreshed', async () => {
    await reset();
    await open();
    await openDraft('再読込のあとの下書き');
    const other = SOURCE.replace('- 別のノード\n', '- 外で書き足した\n');
    // Written behind the map's back (the adapter: no vault event until the file watcher's), and the Enter sent at once,
    // so the map plans the save on the note it last read and the store refuses it (E05).
    await evaluate(`${VIEW} await app.vault.adapter.write(${JSON.stringify(NOTE)}, ${JSON.stringify(other)});
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true;`);
    let held;
    for (let started = Date.now(); Date.now() - started < 4000; await wait(200)) {
      held = await draftState();
      if (held.error === REFRESHED) break;
    }
    if (!held?.editing || held.error !== REFRESHED) throw new Error(`the draft was not held for the re-read note (the step would prove nothing): ${JSON.stringify(held)}`);
    const closed = await closeTab();
    check(closed.gone, '3-held-refreshed: the tab did not close');
    check(closed.source === renamed('再読込のあとの下書き', other), `3-held-refreshed: closing did not apply the held draft over the change: ${JSON.stringify(closed.source)}`);
    check(closed.notices.length === 0, `3-held-refreshed: a Notice showed: ${JSON.stringify(closed.notices)}`);
    return { held, ...closed };
  });

  await step('3b-unread', async () => {
    await reset();
    await open();
    await openDraft('読む前に閉じた下書き');
    const other = SOURCE.replace('- 別のノード\n', '- 外で書き足した\n');
    // Written behind the map's back and the tab closed at once, before any watcher: the save on close is planned on the
    // note the map last read, refused, and applied after the save's own re-read (review 1 of LEV-215).
    const active = await evaluate(`${LEAF} return app.workspace.activeLeaf === leaf;`);
    if (!active) throw new Error('the map is not the active leaf; workspace:close would close another tab');
    const seen = await evaluate(`${VIEW} const shown = view.document?.source;
      await app.vault.adapter.write(${JSON.stringify(NOTE)}, ${JSON.stringify(other)});
      const unread = view.document?.source === shown;
      window.__mappyE2E = null; app.commands.executeCommandById('workspace:close'); return { unread };`);
    if (!seen.unread) throw new Error('the map read the change before the close (the step would prove nothing)');
    await wait(1500);
    const closed = await evaluate(`${LEAF} return { gone: !leaf, source: await app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)})),
      notices: Array.from(document.querySelectorAll('.notice'), item => item.textContent.trim()) };`);
    check(closed.gone, '3b-unread: the tab did not close');
    check(closed.source === renamed('読む前に閉じた下書き', other), `3b-unread: closing did not apply the draft over the unread change: ${JSON.stringify(closed.source)}`);
    check(closed.notices.length === 0, `3b-unread: a Notice showed: ${JSON.stringify(closed.notices)}`);
    return closed;
  });

  await step('4-held-own-node', async () => {
    await reset();
    await open();
    await openDraft('外で変わったノードの下書き');
    const external = SOURCE.replace('  - 子ノード\n', '  - 外で書き換えた\n');
    await evaluate(`await app.vault.modify(app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}), ${JSON.stringify(external)});
      await new Promise(resolve => setTimeout(resolve, 600)); return true;`);
    await evaluate(`${VIEW} input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true;`);
    await wait(600);
    const held = await draftState();
    if (!held.editing || !held.error) throw new Error(`the Enter was not refused with the draft held (the step would prove nothing): ${JSON.stringify(held)}`);
    const closed = await closeTab();
    check(closed.gone, '4-held-own-node: the tab did not close');
    check(closed.source === external, `4-held-own-node: closing wrote over the outside change: ${JSON.stringify(closed.source)}`);
    check(closed.notices.some(item => item.includes(NOT_SAVED)), `4-held-own-node: no Notice said the draft was not saved: ${JSON.stringify(closed.notices)}`);
    return { held, ...closed };
  });

  await step('5-new-node', async () => {
    await reset();
    await open();
    await makeSelect(cdp, evaluate)('別のノード');
    await cdp.realKey('Tab');
    await wait(800);
    const added = await evaluate(`${VIEW} return { editing: !!input(), value: input()?.value ?? null, source: await source() };`);
    // The provisional name is the plugin's (t().newNodeTitle, in Japanese here); any one child added under 別のノード is the row's.
    if (!added.editing || !/- 別のノード\n {2}- [^\n]+\n$/u.test(added.source)) throw new Error(`Tab did not add a child with its draft open: ${JSON.stringify(added)}`);
    const closed = await closeTab();
    check(closed.gone, '5-new-node: the tab did not close');
    check(closed.source === added.source, `5-new-node: closing changed the note the addition left: ${JSON.stringify(closed.source)}`);
    check(closed.notices.length === 0, `5-new-node: a Notice showed: ${JSON.stringify(closed.notices)}`);
    return { added, ...closed };
  });

  await step('6-plugin', async () => {
    await reset();
    await open();
    await openDraft('無効化の前の下書き');
    await evaluate(`window.__mappyE2E = null; await app.plugins.disablePlugin('mappy'); await new Promise(resolve => setTimeout(resolve, 1500)); return true;`);
    const source = await read();
    // The leaf keeps its place (enabling Mappy again gives it the map back, E51); the map view itself is gone.
    const views = await evaluate(`return document.querySelectorAll('.mappy-view').length;`);
    await evaluate(`await app.plugins.enablePlugin('mappy'); await new Promise(resolve => setTimeout(resolve, 1200)); return true;`);
    await detachAll();
    check(views === 0, `6-plugin: ${views} map views outlived the plugin`);
    check(source === renamed('無効化の前の下書き'), `6-plugin: disabling Mappy did not save the draft: ${JSON.stringify(source)}`);
    return { views, source };
  });

  await step('7-popout-held', async () => {
    await reset();
    // The map in a popout window, marked for `connect({ popout })`; the draft is driven there by that window's keys.
    await evaluate(`for (const notice of document.querySelectorAll('.notice')) notice.remove();
      const leaf = app.workspace.openPopoutLeaf({ size: { width: 900, height: 700 } });
      const win = leaf.getContainer().win;
      if (win === window) { leaf.detach(); throw new Error('openPopoutLeaf gave a leaf in the main window'); }
      win.document.body.dataset.mappyE2ePopout = 'close-draft';
      await leaf.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(NOTE)}, layout: 'mindmap' }, active: true });
      await new Promise(resolve => setTimeout(resolve, 1200));
      win.__mappyE2E = leaf;
      window.__mappyE2EPopout = win;
      return true;`);
    const popout = await connect({ popout: 'close-draft' });
    const inPopout = expression => popout.evaluate(`(async () => { ${expression} })()`);
    let held; let closed;
    try {
      await makeSelect(popout, inPopout)('子ノード');
      await popout.realKey('F2');
      for (let started = Date.now(); !(await inPopout(`${VIEW} return !!input();`)); await wait(100)) {
        if (Date.now() - started > 3000) throw new Error('F2 did not open the draft in the popout');
      }
      await inPopout(`${VIEW} input().select(); return true;`);
      await popout.insertText('別ウィンドウで外と競合した下書き');
      await wait(300);
      const external = SOURCE.replace('  - 子ノード\n', '  - 外で書き換えた\n');
      await evaluate(`await app.vault.modify(app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}), ${JSON.stringify(external)});
        await new Promise(resolve => setTimeout(resolve, 600)); return true;`);
      await inPopout(`${VIEW} input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true;`);
      await wait(600);
      held = await inPopout(`${VIEW} return { editing: !!input(), error: el.querySelector('.mappy-inline-error')?.textContent ?? '' };`);
      if (!held.editing || !held.error) throw new Error(`the Enter was not refused with the draft held (the step would prove nothing): ${JSON.stringify(held)}`);
    } finally {
      popout.close();
      closed = await evaluate(`const win = window.__mappyE2EPopout; window.__mappyE2EPopout = null;
        if (!win || win === window) return false; win.__mappyE2E = null; win.close();
        for (let started = Date.now(); Date.now() - started < 5000 && !win.closed; await new Promise(resolve => setTimeout(resolve, 50)));
        return win.closed;`);
    }
    await wait(1500);
    const after = await evaluate(`return { source: await app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)})),
      notices: Array.from(document.querySelectorAll('.notice'), item => item.textContent.trim()) };`);
    check(closed, '7-popout-held: the window did not close');
    check(after.source === SOURCE.replace('  - 子ノード\n', '  - 外で書き換えた\n'), `7-popout-held: closing wrote over the outside change: ${JSON.stringify(after.source)}`);
    check(after.notices.some(item => item.includes(NOT_SAVED)), `7-popout-held: no Notice in the main window said the draft was not saved: ${JSON.stringify(after.notices)}`);
    return { held, closed, ...after };
  });

  await step('after', async () => {
    const errors = await evaluate('return [...(window.__mappyE2EErrors ?? [])];');
    check(errors.length === 0, `page errors: ${JSON.stringify(errors).slice(0, 1500)}`);
    return { errors };
  });

  if (flag('--exits')) {
    // Neither end goes through the view's onClose (LEV-230): both keep the draft at `pagehide`, and the plugin applies it
    // as it loads again (after the reload, at the next launch).
    /** `app:reload`, then the reloaded window with the error collector installed again and time for the kept drafts. */
    const reloadWindow = async () => {
      await evaluate(`window.__mappyE2E = null; setTimeout(() => app.commands.executeCommandById('app:reload'), 0); return true;`);
      await wait(2000);
      await reconnect();
      // The reloaded page has no error collector: installed again, what the restored map throws is still recorded.
      await evaluate(`${ERRORS} return true;`);
      await wait(1500);
      return evaluate(`return { source: await app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)})),
        notices: Array.from(document.querySelectorAll('.notice'), item => item.textContent.trim()),
        errors: [...(window.__mappyE2EErrors ?? [])], kept: app.loadLocalStorage(${JSON.stringify(EXIT_KEY)}) };`);
    };
    await step('8-reload', async () => {
      await reset();
      await open();
      await openDraft('再読込の前の下書き');
      const after = await reloadWindow();
      await detachAll();
      check(after.errors.length === 0, `8-reload: page errors after the reload: ${JSON.stringify(after.errors).slice(0, 1500)}`);
      check(after.source === renamed('再読込の前の下書き'), `8-reload: the reload lost the draft: ${JSON.stringify(after.source)}`);
      check(!after.notices.some(item => item.includes(EXIT_NOT_SAVED)), `8-reload: a Notice said the draft was not saved: ${JSON.stringify(after.notices)}`);
      check(after.kept === null, `8-reload: the kept drafts were not used up after the reload: ${JSON.stringify(after.kept)}`);
      return { outcome: after.source === renamed('再読込の前の下書き') ? 'saved' : after.source === SOURCE ? 'dropped' : 'other', ...after };
    });
    await step('8b-reload-held-own-node', async () => {
      await reset();
      await open();
      await openDraft('再読込で保存できない下書き');
      const external = SOURCE.replace('  - 子ノード\n', '  - 外で書き換えた\n');
      await evaluate(`await app.vault.modify(app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}), ${JSON.stringify(external)});
        await new Promise(resolve => setTimeout(resolve, 600)); return true;`);
      await evaluate(`${VIEW} input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true;`);
      await wait(600);
      const held = await draftState();
      if (!held.editing || !held.error) throw new Error(`the Enter was not refused with the draft held (the step would prove nothing): ${JSON.stringify(held)}`);
      const after = await reloadWindow();
      await detachAll();
      check(after.errors.length === 0, `8b-reload-held-own-node: page errors after the reload: ${JSON.stringify(after.errors).slice(0, 1500)}`);
      check(after.source === external, `8b-reload-held-own-node: the reload wrote over the outside change: ${JSON.stringify(after.source)}`);
      check(after.notices.some(item => item.includes(EXIT_NOT_SAVED) && item.includes('再読込で保存できない下書き')),
        `8b-reload-held-own-node: no Notice after the reload named the draft that was not saved: ${JSON.stringify(after.notices)}`);
      return { held, ...after };
    });
    // A held draft: its blur does not save it (LEV-202), so only the draft kept at `pagehide` can. A plain draft passes on
    // 0.3.9 too, saved by the window's blur after `unload` (artifacts/lev-230), and would not tell the two apart.
    await step('9-quit', async () => {
      if (process.platform !== 'darwin') throw new Error('9-quit launches Obsidian again after the quit, which the case does only on macOS');
      await reset();
      await open();
      await openDraft('終了の前の下書き');
      const other = SOURCE.replace('- 別のノード\n', '- 外で書き足した\n');
      await evaluate(`${VIEW} await app.vault.adapter.write(${JSON.stringify(NOTE)}, ${JSON.stringify(other)});
        input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true;`);
      let held;
      for (let started = Date.now(); Date.now() - started < 4000; await wait(200)) {
        held = await draftState();
        if (held.error === REFRESHED) break;
      }
      if (!held?.editing || held.error !== REFRESHED) throw new Error(`the draft was not held for the re-read note (the step would prove nothing): ${JSON.stringify(held)}`);
      await evaluate(`window.__mappyE2E = null; setTimeout(() => require('electron').remote.app.quit(), 0); return true;`);
      cdp.close();
      // The process itself must end, not only the vault's window: a quit that waits for a task ends on macOS with
      // Obsidian running and no window (LEV-230's first build). The CDP port closes with the process.
      let running = true;
      for (let started = Date.now(); running && Date.now() - started < 20000; await wait(500)) {
        running = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false);
      }
      if (running) throw new Error('Obsidian was still running 20 s after app.quit() (its window may have closed)');
      quitDone = true;
      const onDisk = await readFile(join(VAULT, NOTE), 'utf8');
      // The draft is kept for the next launch, not written as the page went (nothing half-written).
      check(onDisk === other, `9-quit: the note on disk after the quit is not the note before it: ${JSON.stringify(onDisk)}`);
      const launched = spawnSync('open', ['-na', OBSIDIAN_APP, '--args', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`], { encoding: 'utf8' });
      if (launched.status !== 0) throw new Error(`open could not launch Obsidian again (${launched.status}): ${launched.stderr || launched.error}`);
      // Obsidian is up again: the cleanup runs even if reaching it fails below (and records that it could not).
      quitDone = false;
      await reconnect();
      await evaluate(`${ERRORS} return true;`);
      await wait(2000);
      const after = await evaluate(`return { source: await app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)})),
        notices: Array.from(document.querySelectorAll('.notice'), item => item.textContent.trim()),
        errors: [...(window.__mappyE2EErrors ?? [])], kept: app.loadLocalStorage(${JSON.stringify(EXIT_KEY)}) };`);
      check(after.source === renamed('終了の前の下書き', other), `9-quit: the next launch did not apply the held draft over the change: ${JSON.stringify(after.source)}`);
      check(!after.notices.some(item => item.includes(EXIT_NOT_SAVED)), `9-quit: a Notice after the launch said the draft was not saved: ${JSON.stringify(after.notices)}`);
      check(after.kept === null, `9-quit: the kept drafts were not used up after the launch: ${JSON.stringify(after.kept)}`);
      check(after.errors.length === 0, `9-quit: page errors after the launch: ${JSON.stringify(after.errors).slice(0, 1500)}`);
      return { held, onDisk, outcome: after.source === renamed('終了の前の下書き', other) ? 'saved' : after.source === other ? 'dropped' : 'other', ...after };
    });
  }
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`stopped: ${error}`);
} finally {
  // Only a quit after which Obsidian did not come back leaves nothing to reach.
  if (!quitDone) {
    try { await detachAll(); } catch (error) { record.failures.push(`close maps: ${error}`); }
    if (record.steps.setup && !record.steps.setup.error && !flag('--keep')) {
      await wait(300);
      await step('clean', makeDeleteNote(evaluate, NOTE));
    }
    cdp.close();
  }
}

process.exit(await finish(record, value('--json')));
