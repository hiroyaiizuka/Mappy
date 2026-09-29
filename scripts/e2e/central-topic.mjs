/**
 * E71 (docs/harness.md, LEV-255): a new map starts from a central topic, on the real Obsidian, in Japanese and in
 * English. The command 「新しいマインドマップを作成」／`Create new mind map` names the file 「無題のマインドマップ」／
 * `Untitled mind map` as before, and writes the note's root as 「中心トピック」／`Central topic`, which the map draws as
 * its root. Tab there gives 「メイントピック」／`Main topic` (LEV-250), and Tab on that 「サブトピック」／`Subtopic`.
 *
 * Rows: the setting 新規マップの既定レイアウト (all four) × the language (the test Obsidian's Japanese, then English
 * switched as E63 does, then back). Each row sets the layout and a folder of its own through the plugin's settings, runs
 * the command, reads the file's name, the note and the root the map draws, then selects the root with a real click and
 * presses Tab, Enter on the untouched draft, the same on the new node, and compares the whole note. The command is the
 * only way a new map is made: the ribbon opens the active note, and the file menu turns an existing note into a map
 * (src/main.ts); neither writes a note.
 *
 * The names are written out here, not read from src/i18n: the case must fail if the table changes them by accident.
 * The settings as the run found them are put back at the end, and the folder is removed.
 *
 * Usage: npm run harness:e2e:central-topic -- [--reload] [--json <out.json>] [--shot <out.png>] [--keep]
 *   --shot  writes <out>.png (the new Japanese mind map, before any Tab) and <out>-en.png (the same in English)
 *   --keep  leave the folder and its notes in the vault
 */
import { LANGUAGE, VAULT, connect, wait } from './cdp.mjs';
import { switchLanguage } from './language.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const FOLDER = 'Fixtures/E2E-central-topic';
const NAMES = {
  ja: { file: '無題のマインドマップ', root: '中心トピック', main: 'メイントピック', sub: 'サブトピック' },
  en: { file: 'Untitled mind map', root: 'Central topic', main: 'Main topic', sub: 'Subtopic' },
};
const LAYOUTS = ['mindmap', 'timeline', 'hierarchy', 'balanced'];

if (LANGUAGE !== 'ja') throw new Error('E71 starts from the Japanese test Obsidian (MAPPY_E2E_LANGUAGE unset or ja); it switches to English itself.');

const record = createRecord(VAULT, FOLDER);
let cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);

/** The stored `language` key as this run found it, put back at the end. */
const storedAtStart = await cdp.evaluate("localStorage.getItem('language')");
/** The plugin's settings as this run found them, read once the plugin step has (re)loaded it; put back at the end. */
let settingsAtStart = null;
/** Close the map tabs on this case's folder only: other tabs in the test Obsidian are not the case's to close. */
const detachMaps = () => evaluate(`app.workspace.getLeavesOfType('mappy-map')
  .filter(leaf => (leaf.view.file?.path ?? leaf.getViewState().state?.file ?? '').startsWith(${JSON.stringify(`${FOLDER}/`)}))
  .forEach(leaf => leaf.detach());
  await new Promise(resolve => setTimeout(resolve, 300)); return true;`);
const removeFolder = () => evaluate(`const folder = app.vault.getAbstractFileByPath(${JSON.stringify(FOLDER)});
  if (folder) await app.vault.delete(folder, true); return true;`);

/** Write the settings through the plugin, as the settings tab does (it saves the whole object). */
const saveSettings = settings => evaluate(`const plugin = app.plugins.plugins.mappy;
  await plugin.saveSettings({ ...plugin.settings, ...${JSON.stringify(settings)} }); return plugin.settings;`);

/** The expected note: the marker, the layout unless it is the regular map, the central topic, and what Tab added. */
function expected(layout, names, added = '') {
  const properties = layout === 'mindmap' ? 'mappy: true\n' : `mappy: true\nmappy-layout: ${layout}\n`;
  return `---\n${properties}---\n\n## ${names.root}\n${added}`;
}

/** Tab on `target` with a real click and key, then Enter on the untouched draft; what the draft held and the note after. */
async function tabAndKeep(target) {
  await makeSelect(cdp, evaluate)(target);
  await cdp.realKey('Tab', 0);
  await wait(600);
  const draft = await evaluate(`${VIEW} const box = input(); return box ? { value: box.value, selected: box.selectionStart === 0 && box.selectionEnd === box.value.length } : null;`);
  await cdp.realKey('Enter', 0, '\r');
  await wait(800);
  const after = await evaluate(`${VIEW} return { editing: !!input(), source: await source() };`);
  return { draft, ...after };
}

async function rows(language, shot) {
  const names = NAMES[language];
  for (const layout of LAYOUTS) {
    const label = `${language}/${layout}`;
    const created = await step(`${label}/create`, async () => {
      await detachMaps();
      await removeFolder();
      const saved = await saveSettings({ defaultLayout: layout, newMapFolder: FOLDER });
      if (saved.defaultLayout !== layout || saved.newMapFolder !== FOLDER) throw new Error(`the settings did not take: ${JSON.stringify(saved)}`);
      return evaluate(`if (!app.commands.executeCommandById('mappy:create-mindmap')) throw new Error('the command did not run');
        let made = null;
        for (let tries = 0; tries < 30 && !made; tries += 1) {
          await new Promise(resolve => setTimeout(resolve, 200));
          made = app.workspace.getLeavesOfType('mappy-map').find(item => item.view.file?.path.startsWith(${JSON.stringify(`${FOLDER}/`)})) ?? null;
        }
        if (!made) throw new Error('no map opened on a new note in ' + ${JSON.stringify(FOLDER)});
        await new Promise(resolve => setTimeout(resolve, 1200));
        app.workspace.setActiveLeaf(made, { focus: true });
        window.__mappyE2E = made;
        ${VIEW}
        const roots = nodes().filter(node => node.classList.contains('is-root')).map(label);
        return { path: view.file.path, layout: view.getState().layout, roots, labels: nodes().map(label), source: await source() };`);
    });
    check(created?.path === `${FOLDER}/${names.file}.md`, `${label}: the new note is ${created?.path}, not ${FOLDER}/${names.file}.md`);
    check(created?.layout === layout, `${label}: the map opened in ${created?.layout}, not ${layout}`);
    check(created?.source === expected(layout, names), `${label}: the new note is ${JSON.stringify(created?.source)}, not ${JSON.stringify(expected(layout, names))}`);
    check(JSON.stringify(created?.roots) === JSON.stringify([names.root]), `${label}: the root drawn is ${JSON.stringify(created?.roots)}, not 「${names.root}」`);
    check(!created?.labels?.includes(names.file), `${label}: the file name 「${names.file}」 is drawn as a node: ${JSON.stringify(created?.labels)}`);
    if (!created) continue;
    // Right after the command: the tab titled with the file name, the map with the central topic alone.
    if (shot && layout === 'mindmap') await cdp.screenshot(shot);

    const main = await step(`${label}/root-tab`, () => tabAndKeep(names.root));
    check(main?.draft?.value === names.main && main.draft.selected, `${label}: Tab on the root opened ${JSON.stringify(main?.draft)}, not 「${names.main}」 selected`);
    check(main?.editing === false, `${label}: Enter on the untouched draft did not close it`);
    const afterMain = expected(layout, names, `\n- ${names.main}\n`);
    check(main?.source === afterMain, `${label}: after Tab on the root the note is ${JSON.stringify(main?.source)}, not ${JSON.stringify(afterMain)}`);

    const sub = await step(`${label}/main-tab`, () => tabAndKeep(names.main));
    check(sub?.draft?.value === names.sub && sub.draft.selected, `${label}: Tab on the main topic opened ${JSON.stringify(sub?.draft)}, not 「${names.sub}」 selected`);
    check(sub?.editing === false, `${label}: Enter on the untouched draft did not close it`);
    const afterSub = expected(layout, names, `\n- ${names.main}\n  - ${names.sub}\n`);
    check(sub?.source === afterSub, `${label}: after Tab on the main topic the note is ${JSON.stringify(sub?.source)}, not ${JSON.stringify(afterSub)}`);
  }
}

let exitCode = 1;
/** The folder is this run's to remove only once the run has checked that no earlier run left it there. */
let ownsFolder = false;
try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  required(record, 'settings', await step('settings', async () => {
    settingsAtStart = await evaluate('return JSON.parse(JSON.stringify(app.plugins.plugins.mappy?.settings ?? null));');
    if (!settingsAtStart) throw new Error('the plugin has no settings to put back');
    // A run killed before its restore leaves this case's folder in the settings: taking that as the start would "restore" it.
    if (settingsAtStart.newMapFolder === FOLDER) throw new Error(`the settings still point at ${FOLDER} (a run stopped before its restore?): set "Folder for new maps" and the default layout back by hand first`);
    const leftover = await evaluate(`return !!app.vault.getAbstractFileByPath(${JSON.stringify(FOLDER)});`);
    if (leftover) throw new Error(`${FOLDER} is already in the vault (a --keep run?): remove it first`);
    ownsFolder = true;
    return settingsAtStart;
  }));
  await rows('ja', value('--shot'));
  required(record, 'to-en', await step('to-en', async () => { cdp = await switchLanguage(cdp, 'en'); return cdp.evaluate('window.moment.locale()'); }));
  const shot = value('--shot');
  await rows('en', shot && `${shot.replace(/\.png$/u, '')}-en.png`);
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`unexpected: ${error}`);
} finally {
  // Whatever happened, the settings and the folder are put back first (they do not depend on the language, and a
  // language switch that never comes back would leave them), then the test Obsidian goes back to Japanese with the
  // stored key as it was (as E63 and E69 do).
  if (cdp.closed) cdp = await connect({ language: null }).catch(() => cdp);
  if (cdp.closed) record.failures.push('the window could not be reached to put its settings and language back: check them by hand');
  else {
    await detachMaps().catch(() => null);
    if (settingsAtStart) {
      const restored = await step('restore-settings', () => saveSettings(settingsAtStart));
      // Key by key: the reload of a language switch may normalize the object into another key order.
      const differ = Object.keys(settingsAtStart).filter(key => JSON.stringify(restored?.[key]) !== JSON.stringify(settingsAtStart[key]));
      check(restored && differ.length === 0, `the settings are ${JSON.stringify(restored)}, not ${JSON.stringify(settingsAtStart)} as the run found them (${differ.join(', ')})`);
    }
    if (ownsFolder && !flag('--keep')) await step('clean', removeFolder);
    const now = await cdp.evaluate("[window.moment?.locale?.() ?? null, localStorage.getItem('language')]").catch(() => [null, null]);
    if (now[0] !== 'ja' || now[1] !== storedAtStart) await step('restore', async () => { cdp = await switchLanguage(cdp, storedAtStart, 'ja'); return true; });
  }
  exitCode = await finish(record, value('--json'));
  cdp.close();
}
process.exit(exitCode);
