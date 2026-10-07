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
 * With `--cut` (LEV-309) the fault leaves the first part of the note instead (`CUT_LEFT`: up to a few characters into
 * the line after the edited one), the shape a write that stopped part way would leave and the investigation did not
 * see. Before LEV-309 the next load wrote the title over what was left and dropped the draft with the note's text.
 *
 * 1. setup: `Fixtures/E2E-exit-draft-recovery.md` (`mappy: true`, `- 親`／`  - 子ノード`／`- 別のノード`); a draft of
 *    this note kept by an earlier run is taken out of `mappy-exit-drafts` first (the others are left as they are).
 * 2. reload: the map opened, F2 on 「子ノード」, a title typed, the fault listener added, `app:reload`. Before the page
 *    went, the listener saw Mappy's kept draft (Mappy's handler ran first) and emptied the note (`--cut`: cut it).
 * 3. after-reload: a Notice names the note and the title and says the input and the note's text are kept and the
 *    rescue command saves them (the exact Japanese text); `mappy-exit-drafts` still holds the draft with the note's
 *    text as it was; the note is still as the fault left it on disk 3 s later (Mappy writes nothing back).
 * 4. rescue: the command → the list (the row of this note and title) → 選ぶ → the confirmation (保存先, 元のノートは
 *    変更しません) → 別ファイルに保存: one new file in `Mappy Recovery/`, named `<note> <date time> <id>.md`, holding the
 *    note's text in a fence; the metadata cache gives it no frontmatter (no `mappy`); the Notice names it; the note is
 *    still as the fault left it and the draft is still kept.
 * The case then takes its draft out of `mappy-exit-drafts` and deletes the files it made (not with `--keep`): each part
 * of the clean-up is tried on its own and a failure is recorded without stopping the rest; the folder goes only when
 * this run made it and it is empty, through Node's `fs.promises.rmdir`, which removes an empty folder only
 * (`vault.delete` and the adapter's `rmdir(…, false)` both stopped with EISDIR on Obsidian 1.13.7: the adapter's is
 * `fs.promises.rm`, which takes a folder only when recursive; LEV-309's run). A run left behind by an earlier one (this note emptied or cut, its draft kept, its map open, an
 * empty folder) is taken up: setup closes this note's leaves and rewrites it; a folder that was there is left as it is.
 *
 * LEV-309 (the owner's decision of 2026-10-06) adds a row to each mode, after the rescue. `--cut`: (a) a note whose last
 * node a write was moving up when the page went, cut just after it (shorter than the note, ending like it): the draft
 * is not written, stays with its note text, the Notice says so, and no backup is made. Without `--cut`: (b) a change
 * made elsewhere while the window reloaded (a longer last line) that the draft is written over: the note is written,
 * after a backup of it in `<plugin folder>/exit-backups/`, which the rescue lists and saves to a new file; (c) the
 * backup's prepared file was renamed to the applied one (no prepared or temporary file of it is left), and, as an
 * observation recorded but not judged, what the adapter's `rename` does onto a name that is there, in a folder of its
 * own beside the backups; (d) the applied file's bytes on disk, the adapter's `stat` and its text's UTF-8 length agree
 * (the size the store counts the folder by). The backup files this run made are deleted with the rest (not with
 * `--keep`); the plugin itself deletes none.
 *
 * LEV-310 adds 破棄 to the rescue list, after a confirmation, and these rows. In both modes, after the rescue:
 * (e) discard-draft: a second draft of this note is put beside the one kept (as a later page would keep it); 破棄 on the
 * kept one's line → the confirmation (what goes, 破棄する as a warning, キャンセル) → キャンセル: the entry is as it was, to
 * the character, and the note too; then 破棄 → 破棄する: that draft alone is gone, the second one and every other item
 * stay as they were and where they were, the note is as before, no file is made, and the Notice says it was discarded.
 * Without `--cut`, after the backup's rescue: (f) discard-backup: 破棄 on the applied backup's line → the confirmation
 * (it goes to the system trash) → キャンセル: the backup folder is as it was; then 破棄 → 破棄する: that file alone is gone
 * from the folder (moved to the system trash, or to the vault's `.trash/` where it cannot, as the Notice says), the note is as
 * written. Where the trashed file went is recorded, not judged, and the clean step takes that copy out of the trash
 * when it can read it (not with `--keep`). Nothing else discards: the plugin deletes nothing itself.
 *
 * Usage: npm run harness:e2e:exit-draft-recovery -- [--cut] [--reload] [--json <out.json>] [--keep]
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required, until } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep, makeNoteStep, makeDeleteNote } from './dom-helpers.mjs';
import { ERRORS } from './window-helpers.mjs';

const NOTE = 'Fixtures/E2E-exit-draft-recovery.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 救出する下書き', '',
  '- 親', '  - 子ノード', '- 別のノード', '',
].join('\n');
const TITLE = '救出する入力';
/**
 * What `--cut`'s fault leaves of the note: up to 「- 別」, after the edited line (cut just after the edited line, the
 * change would touch the edit, refused before LEV-309 too).
 */
const CUT_LEFT = SOURCE.slice(0, SOURCE.indexOf('- 別のノード') + 3);
/** `--cut`'s row (a): a note whose last node 「- 末」 a write was moving above 「- 二」, cut just after it moved. */
const MOVE_SOURCE = ['---', 'mappy: true', '---', '## 救出する下書き', '', '- 親', '  - 子ノード', '- 一', '- 二', '- 末', ''].join('\n');
const MOVE_TITLE = '移す途中の入力';
const MOVED = MOVE_SOURCE.replace('- 二\n- 末\n', '- 末\n- 二\n');
const MOVED_CUT = MOVED.slice(0, MOVED.indexOf('- 二'));
/** The normal mode's row (b): the last line made longer elsewhere while the window reloaded; the draft is written over it. */
const BACKUP_TITLE = '控えを残す入力';
const LONGER = SOURCE.replace('- 別のノード\n', '- 別のノードを外で長くした\n');
/** src/ui/exit-drafts.ts's `EXIT_DRAFTS_KEY`. */
const EXIT_KEY = 'mappy-exit-drafts';
/** src/ui/exit-draft-recovery.ts's `RECOVERY_FOLDER`. */
const FOLDER = 'Mappy Recovery';
const COMMAND = 'mappy:rescue-exit-drafts';
/** src/i18n/ja.ts's `exitDraftNotWritten`, `exitNoteChanged` and `exitKeptSource` joined (no space after 「。」) for this draft (the reason is `exitNoteChanged`), copied: a change of wording fails here. */
const keptNotice = title => `再読込・終了のときに ${NOTE} で編集していた「${title}」を書き込めませんでした。その間にノートが変わりました。入力と元の原文は残してあります。コマンド「保存できなかった下書きを救出」で別ファイルに保存できます。`;
const KEPT_NOTICE = keptNotice(TITLE);
/** src/i18n/ja.ts's `exitWrittenWithBackup` for a draft of this note, copied. */
const wroteNotice = title => `再読込・終了のときに ${NOTE} で編集していた「${title}」を書き込みました。書き込む直前のノートの控えを残しています。コマンド「保存できなかった下書きを救出」で別ファイルに保存できます。`;
/** src/i18n/ja.ts's `rescueSavedBackup` after the path, copied. */
const SAVED_BACKUP = 'に保存しました。元のノートと控えは変更していません。';
/**
 * src/core/exit-drafts.ts's `draftKey` and src/core/exit-backup.ts's `backupId`, copied: the name a kept draft's backup
 * files take (its edits as `readExitDrafts` keeps them).
 */
const backupIdOf = draft => createHash('sha256').update(JSON.stringify([draft.path, draft.title, draft.at, draft.before, draft.after,
  draft.edits.map(edit => ({ from: edit.from, to: edit.to, text: edit.text }))])).digest('hex');
const SAVED = 'に保存しました。元のノートは変更していません。下書きは残してあるので、もう一度救出すると同じ内容のファイルが増えます。要らなくなった下書きは、同じコマンドの一覧の「破棄」で消せます。';
/**
 * src/i18n/ja.ts's `discardDraftWhat`, `discardedDraft`, `discardedBackupTrash`, `discardedBackupLocalTrash` and
 * `discardedBackupUnconfirmed`, copied (LEV-310).
 */
const discardWhat = title => `再読込・終了のときに ${NOTE} で編集していた「${title}」の下書きを破棄します。`;
const discarded = title => `「${title}」の下書きを破棄しました。元のノートは変更していません。`;
const BACKUP_TRASHED = '控えを OS のゴミ箱に移しました。元のノートは変更していません。';
const BACKUP_LOCAL_TRASH = 'OS のゴミ箱が使えなかったため、控えを Vault の .trash フォルダに移しました。元のノートは変更していません。';
const BACKUP_UNCONFIRMED = '控えは保存先から無くなりましたが、OS のゴミ箱に移ったかどうかは確かめられませんでした。元のノートは変更していません。';
/** The second draft of this note the discard row puts beside the kept one, which must stay (LEV-310). */
const SIBLING_TITLE = '残す入力';
/** Where the fault listener writes what it saw (`window.localStorage`, synchronous, kept across the reload). */
const FAULT_KEY = 'mappy-e2e-exit-draft-fault';

/**
 * Script (with `app`): removes `folder` only when it is empty on disk; what it found. Not the adapter's `rmdir`: on
 * Obsidian 1.13.7 it is `fs.promises.rm(…, { recursive })`, which refuses a folder unless recursive (EISDIR), and
 * recursive would take what came in after the listing; `fs.promises.rmdir` refuses a folder that is not empty.
 * These script builders use nothing outside themselves, so they can be checked without Obsidian by reading this
 * file's text (not by importing it: like every case, the file runs the case when loaded).
 */
export const removeEmptyFolderScript = folder => `const adapter = app.vault.adapter;
  if (!(await adapter.exists(${JSON.stringify(folder)}))) return 'gone';
  const listed = await adapter.list(${JSON.stringify(folder)});
  if (listed.files.length > 0 || listed.folders.length > 0) return { kept: 'not empty', files: listed.files, folders: listed.folders };
  await require('fs').promises.rmdir(adapter.getFullPath(${JSON.stringify(folder)}));
  // The vault takes it out when its watcher sees the change; the next case's setup reads the vault (run.mjs runs
  // exit-draft-cut right after this case), so it waits for that.
  for (let waited = 0; waited < 5000 && app.vault.getAbstractFileByPath(${JSON.stringify(folder)}); waited += 100) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (app.vault.getAbstractFileByPath(${JSON.stringify(folder)})) throw new Error('removed on disk, but the vault still lists it after 5 s');
  return 'removed';`;

/** Script (with `app`): deletes the file at `path` if the vault has one there (a folder is not touched); what it did. */
export const deleteFileScript = path => `const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
  if (!file) return 'gone';
  if ('children' in file) return 'a folder: left';
  await app.vault.delete(file);
  return 'deleted';`;

/**
 * Script (with `app`): what an earlier run left of this case before setup (the note's size, the leaves on it, the
 * folder), and those leaves closed: a map an earlier run left open on the note would make setup refuse it.
 */
export const leftoverScript = (note, folder) => `const file = app.vault.getAbstractFileByPath(${JSON.stringify(note)});
  const leaves = [];
  app.workspace.iterateAllLeaves(leaf => {
    const state = leaf.getViewState();
    if (leaf.view?.file?.path === ${JSON.stringify(note)} || state.state?.file === ${JSON.stringify(note)}) leaves.push(leaf);
  });
  for (const leaf of leaves) leaf.detach();
  const found = app.vault.getAbstractFileByPath(${JSON.stringify(folder)});
  return { noteBytes: file && !('children' in file) ? file.stat?.size ?? null : null, leavesClosed: leaves.length,
    folder: !found ? 'none' : 'children' in found ? (found.children.length === 0 ? 'empty folder' : 'folder') : 'file' };`;

// Always run, as every case does: a run decided by comparing paths could end with 0 and no record when they differ.
await main();

async function main() {
  const { flag, value } = parseArgs();
  const cut = flag('--cut');
  const record = createRecord(VAULT, NOTE);
  // The case this run is (one script behind two: run.mjs, package.json): the gate takes it over the JSON's file name,
  // so a run without `--cut` saved as exit-draft-cut.json does not stand for it (review 1 of LEV-309).
  record.case = cut ? 'exit-draft-cut' : 'exit-draft-recovery';
  /** The note on disk as the fault leaves it. */
  const left = cut ? CUT_LEFT : '';
  let cdp = await connect();
  let evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
  const step = makeStep(record);
  const check = makeCheck(record);

  /** The kept drafts of this note (script). */
  const OURS = `(Array.isArray(app.loadLocalStorage(${JSON.stringify(EXIT_KEY)})) ? app.loadLocalStorage(${JSON.stringify(EXIT_KEY)}) : [])
    .filter(item => item?.path === ${JSON.stringify(NOTE)})`;
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
  /** The plugin's backup folder (vault path), and the backup files this run made there (LEV-309). */
  let backupsDir = '';
  const backupsMade = [];
  /** Where the backup this run discarded went (a trash), with its text: the clean step takes that copy out (LEV-310). */
  const trashedCopies = [];
  /** The names in the backup folder on disk now (none when it is not there). */
  const backupFiles = async () => {
    try { return (await readdir(join(VAULT, backupsDir))).sort(); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  };

  /**
   * Opens the note as a map, F2 on 「子ノード」, types `title`, adds the artificial fault (the note written as `written`
   * as the page goes, after Mappy kept the draft), reloads and reconnects; what the fault saw, the draft kept among it.
   */
  const reloadWithFault = async (title, written) => {
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
    await cdp.insertText(title);
    await wait(300);
    const typed = await evaluate(`${VIEW} return input()?.value ?? null;`);
    if (typed !== title) throw new Error(`the draft does not hold the title typed: ${JSON.stringify(typed)}`);
    await evaluate(`window.localStorage.removeItem(${JSON.stringify(FAULT_KEY)}); return true;`);
    // The artificial fault: added after Mappy's handler (registered when the plugin loaded), so it runs after Mappy kept
    // the draft; a synchronous write, so the note is as written before the page goes. What it saw is kept for the next
    // page, the draft kept among it.
    await evaluate(`window.addEventListener('pagehide', event => {
        if (event.persisted) return;
        const kept = app.loadLocalStorage(${JSON.stringify(EXIT_KEY)});
        const ours = Array.isArray(kept) ? kept.filter(item => item?.path === ${JSON.stringify(NOTE)}) : [];
        const target = require('path').join(app.vault.adapter.basePath, ${JSON.stringify(NOTE)});
        let wrote = false;
        try { require('fs').writeFileSync(target, ${JSON.stringify(written)}); wrote = true; } catch {}
        window.localStorage.setItem(${JSON.stringify(FAULT_KEY)}, JSON.stringify({ at: Date.now(), keptBefore: ours.length, wrote, draft: ours[ours.length - 1] ?? null }));
      });
      window.__mappyE2E = null;
      setTimeout(() => app.commands.executeCommandById('app:reload'), 0);
      return true;`);
    await wait(2000);
    await reconnect();
    await evaluate(`${ERRORS} return true;`);
    const fault = await evaluate(`return JSON.parse(window.localStorage.getItem(${JSON.stringify(FAULT_KEY)}) ?? 'null');`);
    if (!fault?.wrote) throw new Error(`the fault did not write the note as the page went (the case would prove nothing): ${JSON.stringify(fault)}`);
    if (fault.keptBefore !== 1 || fault.draft?.title !== title) throw new Error(`Mappy had not kept the draft when the fault ran (the listener order is not as the case assumes): ${JSON.stringify(fault)}`);
    return { typed, fault };
  };

  /**
   * Opens the rescue list and presses 破棄 on the `kind` line of this note whose title is `title`; the confirmation as
   * shown (title, texts, buttons), or throws when the line or the confirmation is not there (LEV-310).
   */
  const openDiscard = async (kind, title) => {
    // A modal left open is closed through its own close button (its `close`, which lets its keys go), not taken out
    // of the page (review 3).
    await evaluate(`for (const close of document.querySelectorAll('.modal-container .modal-close-button')) close.click();
      await new Promise(resolve => setTimeout(resolve, 200));
      app.commands.executeCommandById(${JSON.stringify(COMMAND)}); return true;`);
    await until(() => evaluate(`return document.querySelectorAll('.modal .setting-item').length > 0;`), 3000, 'the list did not open');
    const pressed = await evaluate(`const row = Array.from(document.querySelectorAll('.modal .setting-item[data-mappy-rescue=${JSON.stringify(kind)}]')).find(item =>
        item.querySelector('.setting-item-name')?.textContent === ${JSON.stringify(NOTE)}
        && item.querySelector('.setting-item-description')?.textContent.includes(${JSON.stringify(`題名: ${title}`)}));
      const button = row?.querySelector('button[data-mappy-rescue-action="discard"]');
      if (!button) return false;
      button.click(); return true;`);
    if (!pressed) throw new Error(`no ${kind} line with 破棄 for this note and ${title}`);
    return until(() => evaluate(`const title = document.querySelector('.modal .modal-title')?.textContent ?? '';
      return title.endsWith('を破棄') ? { title, texts: Array.from(document.querySelectorAll('.modal p'), item => item.textContent),
        buttons: Array.from(document.querySelectorAll('.modal button'), item => ({ text: item.textContent, warning: item.classList.contains('mod-destructive'), disabled: item.disabled })) } : null;`),
    3000, 'the discard confirmation did not open');
  };
  /** Presses the confirmation's button `text`, then waits for the modal to close. */
  const pressInModal = async text => {
    const pressed = await evaluate(`const button = Array.from(document.querySelectorAll('.modal button')).find(item => item.textContent === ${JSON.stringify(text)});
      if (!button) return false; button.click(); return true;`);
    if (!pressed) throw new Error(`no ${text} button in the confirmation`);
    await until(() => evaluate(`return document.querySelectorAll('.modal').length === 0;`), 3000, 'the confirmation did not close');
  };
  /** The entry as stored (its JSON text, to compare to the character), and its items. */
  const entryNow = () => evaluate(`const raw = app.loadLocalStorage(${JSON.stringify(EXIT_KEY)}); return { text: JSON.stringify(raw), items: Array.isArray(raw) ? raw : [] };`);

  try {
    required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
    required(record, 'setup', await step('setup', async () => {
      const leftover = await dropOurs();
      const earlier = await evaluate(leftoverScript(NOTE, FOLDER));
      if (earlier.leavesClosed > 0) await wait(300);
      const result = await makeNoteStep(evaluate, { note: NOTE, source: SOURCE, errors: ERRORS })();
      before = await recoveryFiles();
      folderCreated = !(await evaluate(`return !!app.vault.getAbstractFileByPath(${JSON.stringify(FOLDER)});`));
      const folderIsFile = await evaluate(`const found = app.vault.getAbstractFileByPath(${JSON.stringify(FOLDER)}); return !!found && !('children' in found);`);
      if (folderIsFile) throw new Error(`${FOLDER} is a file in this vault; the rescue would refuse to create its folder`);
      // The product takes a top-level entry of the folder's name in another case (macOS, Windows); this case looks for
      // the exact name only, so it refuses one rather than look in a folder the rescue does not use.
      const otherCase = await evaluate(`return app.vault.getRoot().children.map(child => child.name)
        .filter(name => name !== ${JSON.stringify(FOLDER)} && name.toLowerCase() === ${JSON.stringify(FOLDER.toLowerCase())});`);
      if (otherCase.length > 0) throw new Error(`the vault has ${JSON.stringify(otherCase)} at its top, the folder's name in another case; rename or remove it first`);
      await evaluate(`window.localStorage.removeItem(${JSON.stringify(FAULT_KEY)}); return true;`);
      return { ...result, leftover, earlier, recoveryBefore: before, folderExisted: !folderCreated };
    }));

    required(record, 'reload', await step('reload', async () => {
      backupsDir = `${await evaluate('return app.plugins.plugins.mappy.manifest.dir;')}/exit-backups`;
      const { typed, fault } = await reloadWithFault(TITLE, left);
      return { typed, fault, left, backupsDir };
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
      check(disk.text === left && later.text === left, `after-reload: the note is not as the fault left it on disk (Mappy wrote something back?): ${JSON.stringify(disk.text)} then ${JSON.stringify(later.text)}`);
      return { notices: shown, kept, bytes: [disk.bytes, later.bytes], text: later.text };
    });

    await step('rescue', async () => {
      await evaluate(`for (const notice of document.querySelectorAll('.notice')) notice.remove();
        if (!app.commands.findCommand(${JSON.stringify(COMMAND)})) throw new Error('no command ${COMMAND}');
        app.commands.executeCommandById(${JSON.stringify(COMMAND)}); return true;`);
      const listed = await until(() => evaluate(`const rows = Array.from(document.querySelectorAll('.modal .setting-item'), row => ({
          name: row.querySelector('.setting-item-name')?.textContent ?? '', desc: row.querySelector('.setting-item-description')?.textContent ?? '' }));
        return rows.length > 0 ? { title: document.querySelector('.modal .modal-title')?.textContent ?? '', rows } : null;`), 3000, 'the list did not open');
      const picked = await evaluate(`const row = Array.from(document.querySelectorAll('.modal .setting-item[data-mappy-rescue="draft"]')).find(item =>
          item.querySelector('.setting-item-name')?.textContent === ${JSON.stringify(NOTE)}
          && item.querySelector('.setting-item-description')?.textContent.includes(${JSON.stringify(`題名: ${TITLE}`)}));
        const button = row?.querySelector('button[data-mappy-rescue-action="pick"]');
        if (!button) return false;
        button.click(); return true;`);
      if (!picked) throw new Error(`no row for this note and title in the list: ${JSON.stringify(listed)}`);
      const confirm = await until(() => evaluate(`const texts = Array.from(document.querySelectorAll('.modal p'), item => item.textContent);
        return texts.some(text => text.startsWith('保存先: ')) ? { title: document.querySelector('.modal .modal-title')?.textContent ?? '', texts,
          buttons: Array.from(document.querySelectorAll('.modal button'), item => ({ text: item.textContent, cta: item.classList.contains('mod-cta') })) } : null;`),
      3000, 'the confirmation did not open');
      const unsaved = await onDisk();
      check(unsaved.text === left, 'rescue: the note changed before the save');
      const saved = await evaluate(`const button = Array.from(document.querySelectorAll('.modal button')).find(item => item.textContent === '別ファイルに保存');
        if (!button) return false; button.click(); return true;`);
      if (!saved) throw new Error(`no 別ファイルに保存 button: ${JSON.stringify(confirm)}`);
      // What the save made is known before the Notice is waited for, so the clean step deletes it whatever follows.
      created = await until(async () => {
        const made = (await recoveryFiles()).filter(path => !before.includes(path));
        return made.length > 0 ? made : null;
      }, 5000, `no new file in ${FOLDER}`);
      before = [...before, ...created];
      const notice = await until(async () => (await notices()).find(item => item.includes(SAVED)) ?? null, 5000, 'no Notice said where the draft was saved');
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
      check(disk.text === left, `rescue: the original note changed: ${JSON.stringify(disk.text)}`);
      check(kept.length === 1 && kept[0].source === SOURCE, `rescue: the draft is no longer kept: ${JSON.stringify(kept).slice(0, 400)}`);
      return { listed, confirm, notice, path, cache, bytes: disk.bytes, keptCount: kept.length, text: text.slice(0, 600) };
    });

    // (e) LEV-310: 破棄 on the kept draft's line: キャンセル changes nothing; 破棄する takes out that draft alone.
    await step('discard-draft', async () => {
      // A second draft of this note beside the kept one, as a later page would keep it: it must stay.
      const added = await evaluate(`const raw = app.loadLocalStorage(${JSON.stringify(EXIT_KEY)});
        const items = Array.isArray(raw) ? raw.slice() : [];
        const kept = items.find(item => item?.path === ${JSON.stringify(NOTE)} && item?.title === ${JSON.stringify(TITLE)});
        if (!kept) return null;
        const sibling = { ...kept, title: ${JSON.stringify(SIBLING_TITLE)}, at: kept.at + 1000 };
        app.saveLocalStorage(${JSON.stringify(EXIT_KEY)}, [...items, sibling]);
        return sibling;`);
      if (!added) throw new Error(`no kept draft of ${TITLE} to put a second one beside`);
      const start = await entryNow();
      const recoveryBefore = await recoveryFiles();
      const noteBefore = await onDisk();
      const shown = await openDiscard('draft', TITLE);
      check(shown.title === '下書きを破棄' && shown.texts[0] === discardWhat(TITLE), `discard-draft: the confirmation does not say which draft goes: ${JSON.stringify(shown)}`);
      check(JSON.stringify(shown.buttons) === JSON.stringify([{ text: '破棄する', warning: true, disabled: false }, { text: 'キャンセル', warning: false, disabled: false }]),
        `discard-draft: the confirmation's buttons are not 破棄する (a warning) and キャンセル: ${JSON.stringify(shown.buttons)}`);
      await pressInModal('キャンセル');
      await wait(500);
      const cancelled = await entryNow();
      check(cancelled.text === start.text, `discard-draft: キャンセル changed the entry: ${cancelled.text.slice(0, 400)}`);
      const confirm = await openDiscard('draft', TITLE);
      await evaluate(`for (const notice of document.querySelectorAll('.notice')) notice.remove(); return true;`);
      await pressInModal('破棄する');
      const notice = await until(async () => (await notices()).find(item => item === discarded(TITLE)) ?? null, 5000, 'no Notice said the draft was discarded');
      const after = await entryNow();
      const expected = start.items.filter((item, index) => index !== start.items.findIndex(other => other?.path === NOTE && other?.title === TITLE));
      check(JSON.stringify(after.items) === JSON.stringify(expected), `discard-draft: the entry is not the one before less that draft: ${after.text.slice(0, 600)}`);
      check(after.items.some(item => item?.path === NOTE && item?.title === SIBLING_TITLE), 'discard-draft: the second draft of this note went too');
      const noteAfter = await onDisk();
      check(noteBefore.text === left && noteAfter.text === left, `discard-draft: the note changed: ${JSON.stringify(noteAfter.text)}`);
      const recoveryAfter = await recoveryFiles();
      check(JSON.stringify(recoveryAfter) === JSON.stringify(recoveryBefore), `discard-draft: files changed in ${FOLDER}: ${JSON.stringify(recoveryAfter)}`);
      const errors = await evaluate('return [...(window.__mappyE2EErrors ?? [])];');
      check(errors.length === 0, `discard-draft: page errors: ${JSON.stringify(errors).slice(0, 600)}`);
      await dropOurs();
      return { shown, cancelledSame: cancelled.text === start.text, confirm, notice, before: start.items.length, after: after.items.length,
        others: after.items.filter(item => item?.path !== NOTE).length, noteBytes: noteAfter.bytes };
    });

    // (a) LEV-309: the cut the earlier guards let through, shorter than the note: not written, nothing backed up.
    if (cut) await step('moved-cut', async () => {
      await detachAll();
      await dropOurs();
      await makeNoteStep(evaluate, { note: NOTE, source: MOVE_SOURCE, errors: ERRORS })();
      const backupsBefore = await backupFiles();
      const { fault } = await reloadWithFault(MOVE_TITLE, MOVED_CUT);
      const shown = await until(async () => {
        const list = await notices();
        return list.some(item => item.includes(MOVE_TITLE)) ? list : null;
      }, 10000, 'no Notice named the draft after the reload');
      await wait(3000);
      const kept = await evaluate(`return ${OURS};`);
      const disk = await onDisk();
      await detachAll();
      const made = (await backupFiles()).filter(name => !backupsBefore.includes(name));
      backupsMade.push(...made);
      check(shown.includes(keptNotice(MOVE_TITLE)), `moved-cut: the Notice is not the one saying the input and the note's text are kept: ${JSON.stringify(shown.filter(item => item.includes(NOTE)))}`);
      check(kept.some(item => item.title === MOVE_TITLE && item.source === MOVE_SOURCE), `moved-cut: ${EXIT_KEY} does not hold the draft with the note's text: ${JSON.stringify(kept).slice(0, 600)}`);
      check(disk.text === MOVED_CUT, `moved-cut: the note is not as the fault left it (written over?): ${JSON.stringify(disk.text)}`);
      check(made.length === 0, `moved-cut: a backup was made though nothing was to be written: ${JSON.stringify(made)}`);
      return { notices: shown, kept, text: disk.text, id: backupIdOf(fault.draft), made };
    });

    // (b), (c), (d) LEV-309: written over a longer change made elsewhere, after a backup the rescue saves.
    if (!cut) await step('written-backup', async () => {
      await detachAll();
      await dropOurs();
      await makeNoteStep(evaluate, { note: NOTE, source: SOURCE, errors: ERRORS })();
      const backupsBefore = await backupFiles();
      const { fault } = await reloadWithFault(BACKUP_TITLE, LONGER);
      const id = backupIdOf(fault.draft);
      const shown = await until(async () => {
        const list = await notices();
        return list.some(item => item.includes(BACKUP_TITLE)) ? list : null;
      }, 10000, 'no Notice named the draft after the reload');
      await wait(1000);
      const kept = await evaluate(`return ${OURS};`);
      const disk = await onDisk();
      await detachAll();
      const made = (await backupFiles()).filter(name => !backupsBefore.includes(name));
      backupsMade.push(...made);
      const expected = LONGER.replace('  - 子ノード\n', `  - ${BACKUP_TITLE}\n`);
      check(shown.includes(wroteNotice(BACKUP_TITLE)), `written-backup: no Notice saying it was written with a backup: ${JSON.stringify(shown.filter(item => item.includes(NOTE)))}`);
      check(disk.text === expected, `written-backup: the note is not the change made elsewhere with the title written: ${JSON.stringify(disk.text)}`);
      check(kept.length === 0, `written-backup: the draft is still kept: ${JSON.stringify(kept).slice(0, 400)}`);
      // (c) the prepared file became the applied one: no prepared or temporary file of it is left.
      check(JSON.stringify(made) === JSON.stringify([`${id}.applied.json`]), `written-backup: the backup files made are not just ${id}.applied.json: ${JSON.stringify(made)}`);
      const appliedPath = `${backupsDir}/${id}.applied.json`;
      const content = made.includes(`${id}.applied.json`) ? await readFile(join(VAULT, appliedPath), 'utf8') : '';
      let backup = null;
      try { backup = JSON.parse(content); } catch { /* Checked below. */ }
      check(backup?.format === 'mappy-exit-backup' && backup?.version === 1 && backup?.id === id, `written-backup: the applied file is not a backup of this draft: ${content.slice(0, 300)}`);
      check(backup?.note?.before === LONGER, 'written-backup: the backup does not hold the note as it was just before the write');
      check(backup?.draft?.source === SOURCE && backup?.draft?.title === BACKUP_TITLE, 'written-backup: the backup does not hold the draft as it was kept, with its note text');
      // (d) the bytes on disk, the adapter's stat and the text's UTF-8 length agree.
      const onDiskBytes = content ? (await stat(join(VAULT, appliedPath))).size : -1;
      const adapterBytes = content ? await evaluate(`return (await app.vault.adapter.stat(${JSON.stringify(appliedPath)}))?.size ?? null;`) : null;
      check(onDiskBytes === Buffer.byteLength(content, 'utf8') && adapterBytes === onDiskBytes,
        `written-backup: the sizes do not agree: on disk ${onDiskBytes}, adapter ${adapterBytes}, UTF-8 ${Buffer.byteLength(content, 'utf8')}`);
      // The rescue lists the backup and saves it to a new file.
      await evaluate(`for (const notice of document.querySelectorAll('.notice')) notice.remove();
        app.commands.executeCommandById(${JSON.stringify(COMMAND)}); return true;`);
      const listed = await until(() => evaluate(`const rows = Array.from(document.querySelectorAll('.modal .setting-item'), row => ({ kind: row.dataset.mappyRescue,
          name: row.querySelector('.setting-item-name')?.textContent ?? '', desc: row.querySelector('.setting-item-description')?.textContent ?? '' }));
        return rows.length > 0 ? rows : null;`), 3000, 'the list did not open');
      // The newest backup first: this run's, if an earlier run left one of the same title.
      const picked = await evaluate(`const row = Array.from(document.querySelectorAll('.modal .setting-item[data-mappy-rescue="applied"]')).find(item =>
          item.querySelector('.setting-item-name')?.textContent === ${JSON.stringify(NOTE)}
          && item.querySelector('.setting-item-description')?.textContent.includes(${JSON.stringify(`題名: ${BACKUP_TITLE}`)}));
        const button = row?.querySelector('button[data-mappy-rescue-action="pick"]');
        if (!button) return false;
        button.click(); return true;`);
      if (!picked) throw new Error(`no applied backup row for this note and title in the list: ${JSON.stringify(listed)}`);
      await until(() => evaluate(`return Array.from(document.querySelectorAll('.modal p'), item => item.textContent).some(text => text.startsWith('保存先: '));`), 3000, 'the confirmation did not open');
      const saved = await evaluate(`const button = Array.from(document.querySelectorAll('.modal button')).find(item => item.textContent === '別ファイルに保存');
        if (!button) return false; button.click(); return true;`);
      if (!saved) throw new Error('no 別ファイルに保存 button for the backup');
      const rescued = await until(async () => {
        const made = (await recoveryFiles()).filter(path => !before.includes(path));
        return made.length > 0 ? made : null;
      }, 5000, `no new file in ${FOLDER} for the backup`);
      created.push(...rescued);
      before = [...before, ...rescued];
      const notice = await until(async () => (await notices()).find(item => item.includes(SAVED_BACKUP)) ?? null, 5000, 'no Notice said where the backup was saved');
      const text = rescued.length === 1 ? await readFile(join(VAULT, rescued[0]), 'utf8') : '';
      check(rescued.length === 1 && notice === `${rescued[0]} ${SAVED_BACKUP}`, `written-backup: not one rescued file named in the Notice: ${JSON.stringify({ rescued, notice })}`);
      check(text.includes(`\n\`\`\`\n${LONGER}\`\`\`\n`) && text.includes(`\n\`\`\`\n${SOURCE}\`\`\`\n`), 'written-backup: the rescued file does not hold the note before the write and the draft\'s text in fences');
      const after = await backupFiles();
      check(after.includes(`${id}.applied.json`) && (await readFile(join(VAULT, appliedPath), 'utf8')) === content, 'written-backup: the rescue changed the backup');
      return { id, made, notices: shown, listed, notice, rescued, sizes: { onDiskBytes, adapterBytes, utf8: Buffer.byteLength(content, 'utf8') } };
    });

    // (f) LEV-310: 破棄 on the applied backup's line: キャンセル changes nothing; 破棄する takes that file alone away.
    if (!cut) await step('discard-backup', async () => {
      const id = record.steps['written-backup']?.id;
      if (!id) throw new Error('written-backup did not make a backup to discard');
      const name = `${id}.applied.json`;
      const folderBefore = await backupFiles();
      if (!folderBefore.includes(name)) throw new Error(`${name} is not in the backup folder`);
      const content = await readFile(join(VAULT, backupsDir, name), 'utf8');
      const expectedNote = LONGER.replace('  - 子ノード\n', `  - ${BACKUP_TITLE}\n`);
      const shown = await openDiscard('applied', BACKUP_TITLE);
      check(shown.title === '控えを破棄' && shown.texts.some(text => text.includes('OS のゴミ箱に移します')),
        `discard-backup: the confirmation does not say the backup goes to the system trash: ${JSON.stringify(shown)}`);
      check(shown.buttons[0]?.text === '破棄する' && shown.buttons[0]?.warning && !shown.buttons[0]?.disabled, `discard-backup: 破棄する is not offered: ${JSON.stringify(shown.buttons)}`);
      await pressInModal('キャンセル');
      await wait(500);
      const cancelled = await backupFiles();
      check(JSON.stringify(cancelled) === JSON.stringify(folderBefore), `discard-backup: キャンセル changed the backup folder: ${JSON.stringify(cancelled)}`);
      await openDiscard('applied', BACKUP_TITLE);
      await evaluate(`for (const notice of document.querySelectorAll('.notice')) notice.remove(); return true;`);
      await pressInModal('破棄する');
      const notice = await until(async () => (await notices()).find(item => item === BACKUP_TRASHED || item === BACKUP_LOCAL_TRASH || item === BACKUP_UNCONFIRMED) ?? null, 5000, 'no Notice said the backup was discarded');
      const folderAfter = await backupFiles();
      check(JSON.stringify(folderAfter) === JSON.stringify(folderBefore.filter(item => item !== name)), `discard-backup: the backup folder is not the one before less ${name}: ${JSON.stringify(folderAfter)}`);
      const disk = await onDisk();
      check(disk.text === expectedNote, `discard-backup: the note changed: ${JSON.stringify(disk.text)}`);
      // Where the trashed file went: recorded, not judged (macOS keeps the name; reading ~/.Trash may be refused).
      // Where it went, by what the Notice says; out of the folder with no trash saying so, both are looked in.
      const trashFolders = notice === BACKUP_TRASHED ? [join(process.env.HOME ?? '', '.Trash')] : notice === BACKUP_LOCAL_TRASH ? [join(VAULT, '.trash')]
        : [join(process.env.HOME ?? '', '.Trash'), join(VAULT, '.trash')];
      const inTrash = {};
      for (const folder of trashFolders) {
        trashedCopies.push({ path: join(folder, name), content });
        try { inTrash[folder] = (await readFile(join(folder, name), 'utf8')) === content; } catch (error) { inTrash[folder] = `not read: ${error?.code ?? error}`; }
      }
      const errors = await evaluate('return [...(window.__mappyE2EErrors ?? [])];');
      check(errors.length === 0, `discard-backup: page errors: ${JSON.stringify(errors).slice(0, 600)}`);
      return { shown, notice, trashed: notice === BACKUP_TRASHED, folderBefore, folderAfter, observation: { inTrash } };
    });

    // (c) An observation, recorded and not judged: what the adapter's rename does onto a name that is there. The store
    // never asks for one (it checks first); this says whether that check is what keeps a backup from being replaced.
    if (!cut) await step('rename-probe', async () => {
      const probe = `${backupsDir}-e2e-probe`;
      return evaluate(`const adapter = app.vault.adapter;
        const probe = ${JSON.stringify(probe)};
        if (await adapter.exists(probe)) throw new Error(probe + ' is there already (an earlier run left it): look at it, then remove it');
        await adapter.mkdir(probe);
        await adapter.write(probe + '/from.json', 'from');
        await adapter.write(probe + '/to.json', 'to');
        let threw = null;
        try { await adapter.rename(probe + '/from.json', probe + '/to.json'); } catch (error) { threw = String(error); }
        const seen = { threw, fromLeft: await adapter.exists(probe + '/from.json'), to: await adapter.read(probe + '/to.json') };
        for (const name of ['from.json', 'to.json']) if (await adapter.exists(probe + '/' + name)) await adapter.remove(probe + '/' + name);
        await require('fs').promises.rmdir(adapter.getFullPath(probe));
        return { observation: 'adapter.rename onto a name that is there', obsidian: require('electron').ipcRenderer.sendSync('version'), ...seen };`);
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
        // Each part on its own: one that fails is recorded, and the rest still runs.
        const parts = {};
        const part = async (name, run) => {
          try { parts[name] = await run(); } catch (error) { parts[name] = { error: String(error) }; record.failures.push(`clean ${name}: ${error}`); }
        };
        await part('drafts', async () => ({ dropped: await dropOurs() }));
        await part('files', async () => {
          // And any file the rescue made that the step did not get to record (it stopped before).
          created = [...new Set([...created, ...(await recoveryFiles()).filter(path => !before.includes(path))])];
          const done = {};
          for (const path of created) {
            try { done[path] = await evaluate(deleteFileScript(path)); } catch (error) { done[path] = { error: String(error) }; record.failures.push(`clean file ${path}: ${error}`); }
          }
          return done;
        });
        await part('folder', () => folderCreated ? evaluate(removeEmptyFolderScript(FOLDER)) : 'existed before the run: left');
        await part('trashed', async () => {
          // The copy of the backup this run discarded, in the trash it went to (LEV-310): taken out only when it is
          // that file, with that text; one the system does not let the case read or remove is left and said so.
          const done = {};
          for (const { path, content } of trashedCopies) {
            let text = null;
            try { text = await readFile(path, 'utf8'); } catch (error) { done[path] = `left: not read (${error?.code ?? error})`; continue; }
            if (text !== content) { done[path] = 'left: another file of the name'; continue; }
            try { await unlink(path); done[path] = 'deleted'; } catch (error) { done[path] = `left: not removed (${error?.code ?? error})`; }
          }
          return done;
        });
        await part('backups', async () => {
          // Only the backup files this run made (LEV-309); the plugin itself deletes none.
          const done = {};
          for (const name of backupsMade) {
            const path = `${backupsDir}/${name}`;
            try {
              done[path] = await evaluate(`if (!(await app.vault.adapter.exists(${JSON.stringify(path)}))) return 'gone';
                await app.vault.adapter.remove(${JSON.stringify(path)}); return 'deleted';`);
            } catch (error) { done[path] = { error: String(error) }; record.failures.push(`clean backup ${path}: ${error}`); }
          }
          return done;
        });
        await part('note', makeDeleteNote(evaluate, NOTE));
        await part('fault', () => evaluate(`window.localStorage.removeItem(${JSON.stringify(FAULT_KEY)}); return true;`));
        return parts;
      });
    }
    cdp.close();
  }

  process.exit(await finish(record, value('--json')));
}
