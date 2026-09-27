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
 * 4. held-own-node: F2 → text → the node itself changed outside the map → the Enter is refused and held → the tab
 *    closed: the note keeps the outside change, and a Notice says the draft was not saved (not a silent loss).
 * 5. new-node: Tab adds a child under its provisional name → the tab closed: the node stays as added (only Escape
 *    takes it back, LEV-203), nothing more written.
 * 6. plugin: F2 → text → Mappy disabled (its views go) and enabled again: the note has the text.
 * The popout window closed with a draft open is E50's step 7 (judged "saved" since LEV-215).
 *
 * With `--exits`, two ends that do not go through the view's `onClose` follow, recorded and not judged (what they do
 * is Obsidian's, and the PR lists them): 7. reload: F2 → text → `app:reload`; 8. quit: F2 → text → Obsidian quit
 * (`app.quit()`), the note read from the disk afterwards. The quit ends the Obsidian the case drives, so it comes last,
 * and it leaves the note (and the map's tab, which the next launch restores: close it before the next run).
 *
 * Usage: npm run harness:e2e:close-draft -- [--reload] [--json <out.json>] [--keep] [--exits]
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connect, VAULT, wait } from './cdp.mjs';
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
  for (let started = Date.now(); Date.now() - started < 30000; await wait(1000)) {
    try { cdp = await connect(); break; } catch { /* the window is reloading */ }
  }
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
    if (!added.editing || !added.source.includes('  - サブトピック\n')) throw new Error(`Tab did not add a child with its draft open: ${JSON.stringify(added)}`);
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

  await step('after', async () => {
    const errors = await evaluate('return [...(window.__mappyE2EErrors ?? [])];');
    check(errors.length === 0, `page errors: ${JSON.stringify(errors).slice(0, 1500)}`);
    return { errors };
  });

  if (flag('--exits')) {
    // Recorded, not judged: neither end goes through the view's onClose.
    await step('7-reload', async () => {
      await reset();
      await open();
      await openDraft('再読込の前の下書き');
      await evaluate(`window.__mappyE2E = null; setTimeout(() => app.commands.executeCommandById('app:reload'), 0); return true;`);
      await wait(2000);
      await reconnect();
      await wait(1500);
      const source = await read();
      await detachAll();
      return { outcome: source === renamed('再読込の前の下書き') ? 'saved' : source === SOURCE ? 'dropped' : 'other', source };
    });
    await step('8-quit', async () => {
      await reset();
      await open();
      await openDraft('終了の前の下書き');
      await evaluate(`window.__mappyE2E = null; setTimeout(() => require('electron').remote.app.quit(), 0); return true;`);
      cdp.close();
      for (let started = Date.now(); Date.now() - started < 20000; await wait(500)) {
        const up = await connect().then(connection => { connection.close(); return true; }).catch(() => false);
        if (!up) break;
      }
      await wait(1000);
      const source = await readFile(join(VAULT, NOTE), 'utf8');
      return { outcome: source === renamed('終了の前の下書き') ? 'saved' : source === SOURCE ? 'dropped' : 'other', source };
    });
  }
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`stopped: ${error}`);
} finally {
  const quit = Boolean(record.steps['8-quit']);
  if (!quit) {
    try { await detachAll(); } catch (error) { record.failures.push(`close maps: ${error}`); }
    if (record.steps.setup && !record.steps.setup.error && !flag('--keep')) {
      await wait(300);
      await step('clean', makeDeleteNote(evaluate, NOTE));
    }
    cdp.close();
  }
}

process.exit(await finish(record, value('--json')));
