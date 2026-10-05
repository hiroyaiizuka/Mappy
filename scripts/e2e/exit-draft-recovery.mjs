/**
 * E84 (docs/harness.md, LEV-240): a title draft kept at a reload that the next load cannot write stays kept, is
 * reported, and the command 保存できなかった下書きを救出 saves what it holds to a separate file, on the real Obsidian.
 *
 * The investigation (2026-10-05) saw a note left empty by a write cut off as the page went (s2-m1: Mappy's own Enter
 * save), and the next load drop the kept draft as its Notice showed. That truncation is not reproducible on demand
 * (2 of 15 runs), so this case makes the failure itself: an **artificial fault**. After Mappy's own `pagehide` handler
 * has kept the draft, a `pagehide` listener the case adds later (listeners run in the order added) empties the note
 * with a synchronous `fs.writeFileSync(…, '')`, which finishes before the page goes. It is not the real truncation,
 * and the case does not show why a note empties nor that it no longer does (LEV-240 does not fix that).
 *
 * 1. setup: `Fixtures/E2E-exit-draft-recovery.md` (`mappy: true`, `- 親`／`  - 子ノード`／`- 別のノード`); a draft of
 *    this note kept by an earlier run is taken out of `mappy-exit-drafts` first (the others are left as they are).
 * 2. reload: the map opened, F2 on 「子ノード」, a title typed, the fault listener added, `app:reload`. Before the page
 *    went, the listener saw Mappy's kept draft (Mappy's handler ran first) and emptied the note.
 * 3. after-reload: a Notice names the note and the title and says the input and the note's text are kept and the
 *    rescue command saves them (the exact Japanese text); `mappy-exit-drafts` still holds the draft with the note's
 *    text as it was; the note is still 0 bytes on disk 3 s later (Mappy writes nothing back).
 * 4. rescue: the command → the list (the row of this note and title) → 選ぶ → the confirmation (保存先, 元のノートは
 *    変更しません) → 別ファイルに保存: one new file in `Mappy Recovery/`, named `<note> <date time> <id>.md`, holding the
 *    note's text in a fence; the metadata cache gives it no frontmatter (no `mappy`); the Notice names it; the note is
 *    still 0 bytes and the draft is still kept.
 * The case then takes its draft out of `mappy-exit-drafts` and deletes the files it made (not with `--keep`).
 *
 * Usage: npm run harness:e2e:exit-draft-recovery -- [--reload] [--json <out.json>] [--keep]
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required, until } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep, makeNoteStep, makeDeleteNote } from './dom-helpers.mjs';
import { ERRORS } from './window-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-exit-draft-recovery.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 救出する下書き', '',
  '- 親', '  - 子ノード', '- 別のノード', '',
].join('\n');
const TITLE = '救出する入力';
/** src/ui/exit-drafts.ts's `EXIT_DRAFTS_KEY`. */
const EXIT_KEY = 'mappy-exit-drafts';
/** src/ui/exit-draft-recovery.ts's `RECOVERY_FOLDER`. */
const FOLDER = 'Mappy Recovery';
const COMMAND = 'mappy:rescue-exit-drafts';
/** src/i18n/ja.ts's `exitDraftNotWritten` + `exitKeptSource` for this draft (the reason is `exitNoteChanged`), copied: a change of wording fails here. */
const KEPT_NOTICE = `再読込・終了のときに ${NOTE} で編集していた「${TITLE}」を書き込めませんでした。その間にノートが変わりました。 入力と元の原文は残してあります。コマンド「保存できなかった下書きを救出」で別ファイルに保存できます。`;
const SAVED = 'に保存しました。元のノートは変更していません。下書きは残してあるので、もう一度救出すると同じ内容のファイルが増えます。';
/** Where the fault listener writes what it saw (`window.localStorage`, synchronous, kept across the reload). */
const FAULT_KEY = 'mappy-e2e-exit-draft-fault';

const record = createRecord(VAULT, NOTE);
let cdp = await connect();
let evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);

/** The kept drafts of this note (script). */
const OURS = `(app.loadLocalStorage(${JSON.stringify(EXIT_KEY)}) ?? []).filter(item => item?.path === ${JSON.stringify(NOTE)})`;
/** Takes this note's drafts out of the entry and leaves the others as they are; resolves to how many went. */
const dropOurs = () => evaluate(`const all = app.loadLocalStorage(${JSON.stringify(EXIT_KEY)});
  if (!Array.isArray(all)) return 0;
  const rest = all.filter(item => item?.path !== ${JSON.stringify(NOTE)});
  app.saveLocalStorage(${JSON.stringify(EXIT_KEY)}, rest.length > 0 ? rest : null);
  return all.length - rest.length;`);
/** The files under the recovery folder (script result: their paths). */
const recoveryFiles = () => evaluate(`return app.vault.getFiles().map(file => file.path).filter(path => path.startsWith(${JSON.stringify(`${FOLDER}/`)}));`);
const onDisk = async () => ({ bytes: (await stat(join(VAULT, NOTE))).size, text: await readFile(join(VAULT, NOTE), 'utf8') });
const notices = () => evaluate(`return Array.from(document.querySelectorAll('.notice'), item => item.textContent.trim());`);

/** Waits for the CDP port to answer with our vault's window again (after `app:reload`), and reconnects (close-draft.mjs). */
const reconnect = async () => {
  cdp.close();
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

/** Closes every leaf on the note, so nothing reads or holds it while the case checks the file. */
const detachAll = () => evaluate(`app.workspace.iterateAllLeaves(leaf => {
    const state = leaf.getViewState();
    if (leaf.view?.file?.path === ${JSON.stringify(NOTE)} || state.state?.file === ${JSON.stringify(NOTE)}) leaf.detach();
  }); window.__mappyE2E = null; await new Promise(resolve => setTimeout(resolve, 300)); return true;`);

/** The files in the recovery folder before the case: the clean step deletes only what this run made. */
let before = [];
let created = [];
let folderCreated = false;

try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  required(record, 'setup', await step('setup', async () => {
    const leftover = await dropOurs();
    const result = await makeNoteStep(evaluate, { note: NOTE, source: SOURCE, errors: ERRORS })();
    before = await recoveryFiles();
    folderCreated = !(await evaluate(`return !!app.vault.getAbstractFileByPath(${JSON.stringify(FOLDER)});`));
    const folderIsFile = await evaluate(`const found = app.vault.getAbstractFileByPath(${JSON.stringify(FOLDER)}); return !!found && !('children' in found);`);
    if (folderIsFile) throw new Error(`${FOLDER} is a file in this vault; the rescue would refuse to create its folder`);
    await evaluate(`window.localStorage.removeItem(${JSON.stringify(FAULT_KEY)}); return true;`);
    return { ...result, leftover, recoveryBefore: before, folderExisted: !folderCreated };
  }));

  required(record, 'reload', await step('reload', async () => {
    await evaluate(`for (const notice of document.querySelectorAll('.notice')) notice.remove();
      const leaf = app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(NOTE)}, layout: 'mindmap' }, active: true });
      await new Promise(resolve => setTimeout(resolve, 1200));
      app.workspace.setActiveLeaf(leaf, { focus: true });
      window.__mappyE2E = leaf;
      return true;`);
    await makeSelect(cdp, evaluate)('子ノード');
    await cdp.realKey('F2');
    await until(() => evaluate(`${VIEW} return !!input();`), 3000, 'F2 did not open the draft');
    await evaluate(`${VIEW} input().select(); return true;`);
    await cdp.insertText(TITLE);
    await wait(300);
    const typed = await evaluate(`${VIEW} return input()?.value ?? null;`);
    if (typed !== TITLE) throw new Error(`the draft does not hold the title typed: ${JSON.stringify(typed)}`);
    // The artificial fault: added after Mappy's handler (registered when the plugin loaded), so it runs after Mappy kept
    // the draft; a synchronous write, so the note is empty before the page goes. What it saw is kept for the next page.
    await evaluate(`window.addEventListener('pagehide', event => {
        if (event.persisted) return;
        const kept = app.loadLocalStorage(${JSON.stringify(EXIT_KEY)});
        const ours = Array.isArray(kept) ? kept.filter(item => item?.path === ${JSON.stringify(NOTE)}) : [];
        const target = require('path').join(app.vault.adapter.basePath, ${JSON.stringify(NOTE)});
        let emptied = false;
        try { require('fs').writeFileSync(target, ''); emptied = true; } catch {}
        window.localStorage.setItem(${JSON.stringify(FAULT_KEY)}, JSON.stringify({ at: Date.now(), keptBefore: ours.length, emptied }));
      });
      window.__mappyE2E = null;
      setTimeout(() => app.commands.executeCommandById('app:reload'), 0);
      return true;`);
    await wait(2000);
    await reconnect();
    await evaluate(`${ERRORS} return true;`);
    const fault = await evaluate(`return JSON.parse(window.localStorage.getItem(${JSON.stringify(FAULT_KEY)}) ?? 'null');`);
    if (!fault?.emptied) throw new Error(`the fault did not empty the note as the page went (the case would prove nothing): ${JSON.stringify(fault)}`);
    if (fault.keptBefore !== 1) throw new Error(`Mappy had not kept the draft when the fault ran (the listener order is not as the case assumes): ${JSON.stringify(fault)}`);
    return { typed, fault };
  }));

  await step('after-reload', async () => {
    const shown = await until(async () => {
      const list = await notices();
      return list.some(item => item.includes(NOTE)) ? list : null;
    }, 10000, 'no Notice named the note after the reload');
    await wait(3000);
    const kept = await evaluate(`return ${OURS};`);
    const disk = await onDisk();
    await detachAll();
    const later = await onDisk();
    check(shown.includes(KEPT_NOTICE), `after-reload: the Notice is not the one saying the input and the note's text are kept: ${JSON.stringify(shown.filter(item => item.includes(NOTE)))}`);
    check(kept.length === 1 && kept[0].title === TITLE && kept[0].source === SOURCE,
      `after-reload: ${EXIT_KEY} does not hold the draft with the note's text: ${JSON.stringify(kept).slice(0, 800)}`);
    check(disk.bytes === 0 && later.bytes === 0, `after-reload: the note is not empty on disk (Mappy wrote something back?): ${disk.bytes} then ${later.bytes} bytes`);
    return { notices: shown, kept, bytes: [disk.bytes, later.bytes] };
  });

  await step('rescue', async () => {
    await evaluate(`for (const notice of document.querySelectorAll('.notice')) notice.remove();
      if (!app.commands.findCommand(${JSON.stringify(COMMAND)})) throw new Error('no command ${COMMAND}');
      app.commands.executeCommandById(${JSON.stringify(COMMAND)}); return true;`);
    const listed = await until(() => evaluate(`const rows = Array.from(document.querySelectorAll('.modal .setting-item'), row => ({
        name: row.querySelector('.setting-item-name')?.textContent ?? '', desc: row.querySelector('.setting-item-description')?.textContent ?? '' }));
      return rows.length > 0 ? { title: document.querySelector('.modal .modal-title')?.textContent ?? '', rows } : null;`), 3000, 'the list did not open');
    const picked = await evaluate(`const row = Array.from(document.querySelectorAll('.modal .setting-item')).find(item =>
        item.querySelector('.setting-item-name')?.textContent === ${JSON.stringify(NOTE)}
        && item.querySelector('.setting-item-description')?.textContent.includes(${JSON.stringify(`題名: ${TITLE}`)}));
      const button = row?.querySelector('button');
      if (!button) return false;
      button.click(); return true;`);
    if (!picked) throw new Error(`no row for this note and title in the list: ${JSON.stringify(listed)}`);
    const confirm = await until(() => evaluate(`const texts = Array.from(document.querySelectorAll('.modal p'), item => item.textContent);
      return texts.some(text => text.startsWith('保存先: ')) ? { title: document.querySelector('.modal .modal-title')?.textContent ?? '', texts,
        buttons: Array.from(document.querySelectorAll('.modal button'), item => ({ text: item.textContent, cta: item.classList.contains('mod-cta') })) } : null;`),
    3000, 'the confirmation did not open');
    const unsaved = await onDisk();
    check(unsaved.bytes === 0, 'rescue: the note changed before the save');
    const saved = await evaluate(`const button = Array.from(document.querySelectorAll('.modal button')).find(item => item.textContent === '別ファイルに保存');
      if (!button) return false; button.click(); return true;`);
    if (!saved) throw new Error(`no 別ファイルに保存 button: ${JSON.stringify(confirm)}`);
    const notice = await until(async () => (await notices()).find(item => item.includes(SAVED)) ?? null, 5000, 'no Notice said where the draft was saved');
    const after = await recoveryFiles();
    created = after.filter(path => !before.includes(path));
    check(created.length === 1, `rescue: not one new file in ${FOLDER}: ${JSON.stringify(created)}`);
    const path = created[0] ?? '';
    check(/^Mappy Recovery\/E2E-exit-draft-recovery \d{4}-\d{2}-\d{2} \d{6} [0-9a-z]{6}( \d+)?\.md$/u.test(path), `rescue: the file name is not <note> <date time> <id>.md: ${path}`);
    check(notice === `${path} ${SAVED}`, `rescue: the Notice does not name the file: ${JSON.stringify(notice)}`);
    const text = path ? await readFile(join(VAULT, path), 'utf8') : '';
    check(text.startsWith('# Mappy の退避: `E2E-exit-draft-recovery`\n'), `rescue: the file does not start with its heading: ${JSON.stringify(text.slice(0, 120))}`);
    check(text.includes(`\n\`\`\`\n${SOURCE}\`\`\`\n`), 'rescue: the note text is not in a fence in the file');
    check(text.includes('元のノートは変更していません'), 'rescue: the file does not say the original note was not changed');
    // The metadata cache reads the file on its own schedule: waited for, then it must see no frontmatter.
    const cache = path ? await until(() => evaluate(`const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
      const cache = file ? app.metadataCache.getFileCache(file) : null;
      return cache ? { frontmatter: cache.frontmatter ?? null, headings: (cache.headings ?? []).map(item => item.heading) } : null;`), 5000, 'the metadata cache did not read the file') : null;
    check(cache?.frontmatter === null, `rescue: the metadata cache gives the file frontmatter: ${JSON.stringify(cache?.frontmatter)}`);
    const disk = await onDisk();
    const kept = await evaluate(`return ${OURS};`);
    check(disk.bytes === 0, `rescue: the original note changed: ${disk.bytes} bytes`);
    check(kept.length === 1 && kept[0].source === SOURCE, `rescue: the draft is no longer kept: ${JSON.stringify(kept).slice(0, 400)}`);
    return { listed, confirm, notice, path, cache, bytes: disk.bytes, keptCount: kept.length, text: text.slice(0, 600) };
  });

  await step('after', async () => {
    const errors = await evaluate('return [...(window.__mappyE2EErrors ?? [])];');
    check(errors.length === 0, `page errors: ${JSON.stringify(errors).slice(0, 1500)}`);
    return { errors };
  });
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`stopped: ${error}`);
} finally {
  try { await evaluate(`for (const modal of document.querySelectorAll('.modal-container')) modal.remove(); return true;`); } catch { /* No window. */ }
  try { await detachAll(); } catch (error) { record.failures.push(`close leaves: ${error}`); }
  if (record.steps.setup && !record.steps.setup.error && !flag('--keep')) {
    await step('clean', async () => {
      const dropped = await dropOurs();
      for (const path of created) await evaluate(`const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)}); if (file) await app.vault.delete(file); return true;`);
      const folder = folderCreated ? await evaluate(`const folder = app.vault.getAbstractFileByPath(${JSON.stringify(FOLDER)});
        if (folder && 'children' in folder && folder.children.length === 0) { await app.vault.delete(folder); return 'deleted'; } return 'kept';`) : 'existed';
      await makeDeleteNote(evaluate, NOTE)();
      await evaluate(`window.localStorage.removeItem(${JSON.stringify(FAULT_KEY)}); return true;`);
      return { dropped, deleted: created, folder };
    });
  }
  cdp.close();
}

process.exit(await finish(record, value('--json')));
