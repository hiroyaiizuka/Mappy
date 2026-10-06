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
 * this run made it and it is empty, through the adapter's `rmdir` (`vault.delete` on the folder stopped with EISDIR on
 * Obsidian 1.13.7). A run left behind by an earlier one (this note emptied or cut, its draft kept, its map open, an
 * empty folder) is taken up: setup closes this note's leaves and rewrites it; a folder that was there is left as it is.
 *
 * Usage: npm run harness:e2e:exit-draft-recovery -- [--cut] [--reload] [--json <out.json>] [--keep]
 */
import { readFile, stat } from 'node:fs/promises';
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
/** src/ui/exit-drafts.ts's `EXIT_DRAFTS_KEY`. */
const EXIT_KEY = 'mappy-exit-drafts';
/** src/ui/exit-draft-recovery.ts's `RECOVERY_FOLDER`. */
const FOLDER = 'Mappy Recovery';
const COMMAND = 'mappy:rescue-exit-drafts';
/** src/i18n/ja.ts's `exitDraftNotWritten`, `exitNoteChanged` and `exitKeptSource` joined (no space after 「。」) for this draft (the reason is `exitNoteChanged`), copied: a change of wording fails here. */
const KEPT_NOTICE = `再読込・終了のときに ${NOTE} で編集していた「${TITLE}」を書き込めませんでした。その間にノートが変わりました。入力と元の原文は残してあります。コマンド「保存できなかった下書きを救出」で別ファイルに保存できます。`;
const SAVED = 'に保存しました。元のノートは変更していません。下書きは残してあるので、もう一度救出すると同じ内容のファイルが増えます。';
/** Where the fault listener writes what it saw (`window.localStorage`, synchronous, kept across the reload). */
const FAULT_KEY = 'mappy-e2e-exit-draft-fault';

/**
 * Script (with `app`): removes `folder` through the adapter only when it is empty on disk; what it found. These script
 * builders use nothing outside themselves, so they can be checked without Obsidian by reading this file's text (not by
 * importing it: like every case, the file runs the case when loaded).
 */
export const removeEmptyFolderScript = folder => `const adapter = app.vault.adapter;
  if (!(await adapter.exists(${JSON.stringify(folder)}))) return 'gone';
  const listed = await adapter.list(${JSON.stringify(folder)});
  if (listed.files.length > 0 || listed.folders.length > 0) return { kept: 'not empty', files: listed.files, folders: listed.folders };
  await adapter.rmdir(${JSON.stringify(folder)}, false);
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
  const record = createRecord(VAULT, NOTE);
  /** The note on disk as the fault leaves it. */
  const left = flag('--cut') ? CUT_LEFT : '';
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
      // the draft; a synchronous write, so the note is empty (or cut) before the page goes. What it saw is kept for the
      // next page.
      await evaluate(`window.addEventListener('pagehide', event => {
          if (event.persisted) return;
          const kept = app.loadLocalStorage(${JSON.stringify(EXIT_KEY)});
          const ours = Array.isArray(kept) ? kept.filter(item => item?.path === ${JSON.stringify(NOTE)}) : [];
          const target = require('path').join(app.vault.adapter.basePath, ${JSON.stringify(NOTE)});
          let wrote = false;
          try { require('fs').writeFileSync(target, ${JSON.stringify(left)}); wrote = true; } catch {}
          window.localStorage.setItem(${JSON.stringify(FAULT_KEY)}, JSON.stringify({ at: Date.now(), keptBefore: ours.length, wrote }));
        });
        window.__mappyE2E = null;
        setTimeout(() => app.commands.executeCommandById('app:reload'), 0);
        return true;`);
      await wait(2000);
      await reconnect();
      await evaluate(`${ERRORS} return true;`);
      const fault = await evaluate(`return JSON.parse(window.localStorage.getItem(${JSON.stringify(FAULT_KEY)}) ?? 'null');`);
      if (!fault?.wrote) throw new Error(`the fault did not write the note as the page went (the case would prove nothing): ${JSON.stringify(fault)}`);
      if (fault.keptBefore !== 1) throw new Error(`Mappy had not kept the draft when the fault ran (the listener order is not as the case assumes): ${JSON.stringify(fault)}`);
      return { typed, fault, shape: flag('--cut') ? 'cut' : 'empty', left };
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
      check(unsaved.text === left, 'rescue: the note changed before the save');
      const saved = await evaluate(`const button = Array.from(document.querySelectorAll('.modal button')).find(item => item.textContent === '別ファイルに保存');
        if (!button) return false; button.click(); return true;`);
      if (!saved) throw new Error(`no 別ファイルに保存 button: ${JSON.stringify(confirm)}`);
      // What the save made is known before the Notice is waited for, so the clean step deletes it whatever follows.
      created = await until(async () => {
        const made = (await recoveryFiles()).filter(path => !before.includes(path));
        return made.length > 0 ? made : null;
      }, 5000, `no new file in ${FOLDER}`);
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
        await part('note', makeDeleteNote(evaluate, NOTE));
        await part('fault', () => evaluate(`window.localStorage.removeItem(${JSON.stringify(FAULT_KEY)}); return true;`));
        return parts;
      });
    }
    cdp.close();
  }

  process.exit(await finish(record, value('--json')));
}
