/**
 * E82 (docs/harness.md, LEV-300): the left ribbon's 「マインドマップを開く」 on the real Obsidian. A map note
 * (`mappy: true`) active opens as a map, as before; anything else active (a note that is not a map, `mappy: false`, a
 * file that is not Markdown, nothing open) gets a new 「無題のマインドマップ」 in the settings' folder and default layout,
 * as the command 「新しいマインドマップを作成」 does. The active file is never written (no conversion).
 *
 * Rows: the user's action (a real click on the ribbon icon) × what is active: the map note in the Markdown editor, the
 * same note as a map, a plain note (clicked once, and double-clicked), an empty note (what Ctrl+N makes), a note with
 * `mappy: false`, an old-format note (`mappy-layout` alone: pointed to the conversion, nothing made), a canvas, an
 * empty tab. On Obsidian 1.14.2 the double click's second click lands ~95 ms after the
 * first, when the first map is already open and indexed, so it opens that map (artifacts/lev-300/record.md); there is
 * no guard in the code for a second click that lands earlier. Each row reads what opened, the
 * files the vault gained, and the active file's text before and after. The settings get a folder of this case's own
 * and the hierarchy layout (not the map note's timeline, so the two routes cannot pass for each other), and are put
 * back at the end; the folder is removed.
 *
 * Usage: npm run harness:e2e:ribbon-new-map -- [--reload] [--json <out.json>] [--shot <out.png>] [--keep]
 *   --shot  the plain-note row right after the click (the new map)
 *   --keep  leave the folder and its files in the vault
 */
import { LANGUAGE, VAULT, connect, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { makePluginStep } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const FOLDER = 'Fixtures/E2E-ribbon-new-map';
const NEW_FOLDER = `${FOLDER}/New`;
const UNTITLED = '無題のマインドマップ';
const RIBBON = 'マインドマップを開く';
const FILES = {
  map: { path: `${FOLDER}/Map.md`, source: '---\nmappy: true\nmappy-layout: timeline\n---\n\n## 地図\n\n- 枝\n' },
  plain: { path: `${FOLDER}/Plain.md`, source: '# ふつうのノート\n\n- 項目\n' },
  off: { path: `${FOLDER}/Off.md`, source: '---\nmappy: false\n---\n\n## 消したマップ\n' },
  empty: { path: `${FOLDER}/Empty.md`, source: '' },
  legacy: { path: `${FOLDER}/Old.md`, source: '---\nmappy-layout: timeline\n---\n\n## 古いマップ\n\n- 枝\n' },
  // In the format Obsidian's canvas view saves it in when it opens it, so that save changes nothing.
  canvas: { path: `${FOLDER}/Board.canvas`, source: '{\n\t"nodes":[],\n\t"edges":[]\n}' },
};

const record = createRecord(VAULT, FOLDER);
if (LANGUAGE !== 'ja') {
  // Recorded, not thrown: a run with --json leaves its FAIL and the reason like every other stop.
  record.failures.push('E82 finds the ribbon icon by its Japanese name: run it on the Japanese test Obsidian.');
  process.exit(await finish(record, value('--json')));
}
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);

let settingsAtStart = null;
const saveSettings = settings => evaluate(`const plugin = app.plugins.plugins.mappy;
  await plugin.saveSettings({ ...plugin.settings, ...${JSON.stringify(settings)} }); return plugin.settings;`);
/** Close every leaf on this case's folder, so a row starts from what it opens itself. */
const detach = () => evaluate(`app.workspace.iterateAllLeaves(leaf => {
    const path = leaf.view.file?.path ?? leaf.getViewState().state?.file ?? '';
    if (path.startsWith(${JSON.stringify(`${FOLDER}/`)})) leaf.detach();
  });
  await new Promise(resolve => setTimeout(resolve, 300)); return true;`);
const removeFolder = () => evaluate(`const folder = app.vault.getAbstractFileByPath(${JSON.stringify(FOLDER)});
  if (folder) await app.vault.delete(folder, true); return true;`);
const clearNew = () => evaluate(`const folder = app.vault.getAbstractFileByPath(${JSON.stringify(NEW_FOLDER)});
  if (folder) await app.vault.delete(folder, true); return true;`);

/** What the window shows: the active leaf's type and file, the files in the case's folder, and the fixtures' text. */
const state = () => evaluate(`const leaf = app.workspace.getMostRecentLeaf();
  const files = app.vault.getFiles().map(file => file.path).filter(path => path.startsWith(${JSON.stringify(`${FOLDER}/`)})).sort();
  const texts = {};
  for (const path of ${JSON.stringify(Object.values(FILES).map(file => file.path))}) {
    const file = app.vault.getAbstractFileByPath(path); texts[path] = file ? await app.vault.read(file) : null;
  }
  const view = leaf?.view;
  return { type: view?.getViewType?.() ?? null, file: view?.file?.path ?? null,
    layout: view?.getViewType?.() === 'mappy-map' ? view.getState().layout : null, files, texts,
    notices: [...document.querySelectorAll('.notice')].map(notice => notice.textContent) };`);

/** Real clicks on the ribbon icon (`times` of them, 80 ms apart, as a double click), refused if something else is at its centre. */
async function clickRibbon(times = 1) {
  const box = await evaluate(`document.querySelectorAll('.notice').forEach(notice => notice.remove());
    const icon = [...document.querySelectorAll('.side-dock-ribbon-action')].find(item => item.getAttribute('aria-label') === ${JSON.stringify(RIBBON)});
    if (!icon) throw new Error('no ribbon icon named ' + ${JSON.stringify(RIBBON)});
    const rect = icon.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !icon.contains(hit)) throw new Error('the ribbon icon is covered by ' + (hit?.className ?? 'nothing'));
    return { x, y };`);
  for (let click = 1; click <= times; click += 1) {
    if (click > 1) await wait(80);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: click });
    }
  }
}

/**
 * The state once a map is active (or 10 s have passed), then 1.5 s more, so a second note made late is seen too. In the
 * row whose map is active before the click the ribbon changes nothing that can be waited for (it opens the same map in
 * the same leaf), so that row reads after the 1.5 s alone: a note made, or a layout changed, later than that is missed.
 */
async function settled(mapExpected = true) {
  for (let tries = 0; mapExpected && tries < 50; tries += 1) {
    await wait(200);
    if ((await state()).type === 'mappy-map') break;
  }
  await wait(1500);
  return state();
}

/** Puts `open` (a script that leaves one leaf active) in front, then clicks the ribbon; the state before and after. */
async function row(label, open, clicks = 1, mapExpected = true) {
  return step(label, async () => {
    await detach();
    await clearNew();
    await evaluate(`${open}
      await new Promise(resolve => setTimeout(resolve, 1200)); return true;`);
    const before = await state();
    await clickRibbon(clicks);
    return { before, after: await settled(mapExpected) };
  });
}

const openAs = (path, type) => `const leaf = app.workspace.getLeaf('tab');
  await leaf.setViewState({ type: ${JSON.stringify(type)}, state: { file: ${JSON.stringify(path)} }, active: true });
  app.workspace.setActiveLeaf(leaf, { focus: true });`;
/** A map note in the Markdown editor: the plugin's router sends a plain `markdown` state for it to the map, so this
 * takes the road 「マップと Markdown を切り替え」 takes (`ViewRouter.openMarkdown`), which keeps the leaf Markdown. */
const openMapNoteAsMarkdown = path => `const leaf = app.workspace.getLeaf('tab');
  await app.plugins.plugins.mappy.router.openMarkdown(leaf, app.vault.getAbstractFileByPath(${JSON.stringify(path)}), true);
  app.workspace.setActiveLeaf(leaf, { focus: true });`;
const openFile = path => `const leaf = app.workspace.getLeaf('tab');
  await leaf.openFile(app.vault.getAbstractFileByPath(${JSON.stringify(path)}), { active: true });
  app.workspace.setActiveLeaf(leaf, { focus: true });`;
const emptyTab = `const leaf = app.workspace.getLeaf('tab');
  window.__mappyRibbonEmpty = leaf;
  await leaf.setViewState({ type: 'empty', active: true });
  app.workspace.setActiveLeaf(leaf, { focus: true });`;

/** The click wrote none of the fixtures: each reads after the click as the case wrote it. */
const untouched = (label, result, notices = []) => {
  for (const file of Object.values(FILES)) {
    const after = result?.after?.texts?.[file.path];
    check(after === file.source, `${label}: ${file.path} is ${JSON.stringify(after)}, not as written`);
  }
  check(JSON.stringify(result?.after?.notices) === JSON.stringify(notices), `${label}: notices ${JSON.stringify(result?.after?.notices)}, not ${JSON.stringify(notices)}`);
};

/** The old format (`mappy-layout` alone): the ribbon points to the conversion, as through 0.4.5, and makes nothing. */
function pointed(label, result) {
  const path = FILES.legacy.path;
  check(result?.before?.type === 'markdown' && result.before.file === path, `${label}: before the click the active view is ${result?.before?.type} on ${result?.before?.file}, not markdown on ${path}`);
  check(result?.after?.type === 'markdown' && result.after.file === path, `${label}: after the click ${result?.after?.type} on ${result?.after?.file}, not still markdown on ${path}`);
  check(!result?.after?.files?.some(file => file.startsWith(`${NEW_FOLDER}/`)), `${label}: a note was made: ${JSON.stringify(result?.after?.files)}`);
  untouched(label, result, ['先に「このノートをマインドマップ化」を実行してください。']);
}

/** The ribbon opened the map note itself and made nothing. */
function opened(label, result, from) {
  check(result?.before?.type === from && result.before.file === FILES.map.path, `${label}: before the click the active view is ${result?.before?.type} on ${result?.before?.file}, not ${from} on ${FILES.map.path}`);
  check(result?.after?.type === 'mappy-map' && result.after.file === FILES.map.path, `${label}: after the click ${result?.after?.type} on ${result?.after?.file}, not the map on ${FILES.map.path}`);
  check(result?.after?.layout === 'timeline', `${label}: the map opened in ${result?.after?.layout}, not its own timeline`);
  check(!result?.after?.files?.some(path => path.startsWith(`${NEW_FOLDER}/`)), `${label}: a note was made: ${JSON.stringify(result?.after?.files)}`);
  untouched(label, result);
}

/** The ribbon made one untitled map in the settings' folder and layout, and opened it. */
function created(label, result, before) {
  const made = `${NEW_FOLDER}/${UNTITLED}.md`;
  check(before(result?.before), `${label}: before the click the active view is ${result?.before?.type} on ${result?.before?.file}`);
  const gained = (result?.after?.files ?? []).filter(path => !(result?.before?.files ?? []).includes(path));
  check(JSON.stringify(gained) === JSON.stringify([made]), `${label}: the vault gained ${JSON.stringify(gained)}, not ${made}`);
  check(result?.after?.type === 'mappy-map' && result.after.file === made, `${label}: after the click ${result?.after?.type} on ${result?.after?.file}, not the map on ${made}`);
  check(result?.after?.layout === 'hierarchy', `${label}: the new map opened in ${result?.after?.layout}, not the settings' hierarchy`);
  untouched(label, result);
}

let exitCode = 1;
let ownsFolder = false;
try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  required(record, 'settings', await step('settings', async () => {
    const found = await evaluate('return JSON.parse(JSON.stringify(app.plugins.plugins.mappy?.settings ?? null));');
    if (!found) throw new Error('the plugin has no settings to put back');
    if (found.newMapFolder === NEW_FOLDER) throw new Error(`the settings still point at ${NEW_FOLDER} (a run stopped before its restore?): set them back by hand first`);
    if (await evaluate(`return !!app.vault.getAbstractFileByPath(${JSON.stringify(FOLDER)});`)) throw new Error(`${FOLDER} is already in the vault (a --keep run?): remove it first`);
    settingsAtStart = found;
    ownsFolder = true;
    const saved = await saveSettings({ defaultLayout: 'hierarchy', newMapFolder: NEW_FOLDER });
    if (saved.defaultLayout !== 'hierarchy' || saved.newMapFolder !== NEW_FOLDER) throw new Error(`the settings did not take: ${JSON.stringify(saved)}`);
    await evaluate(`await app.vault.createFolder(${JSON.stringify(FOLDER)});
      ${Object.values(FILES).map(file => `await app.vault.create(${JSON.stringify(file.path)}, ${JSON.stringify(file.source)});`).join('\n')}
      await new Promise(resolve => setTimeout(resolve, 600)); return true;`);
    return found;
  }));

  const markdownMap = await row('map-note-in-editor', openMapNoteAsMarkdown(FILES.map.path));
  opened('map-note-in-editor', markdownMap, 'markdown');
  const mapView = await row('map-note-as-map', openAs(FILES.map.path, 'mappy-map'));
  opened('map-note-as-map', mapView, 'mappy-map');

  const plain = await row('plain-note', openAs(FILES.plain.path, 'markdown'));
  const shot = value('--shot');
  if (shot) await cdp.screenshot(shot);
  created('plain-note', plain, before => before?.type === 'markdown' && before.file === FILES.plain.path);
  const twice = await row('plain-note-double-click', openAs(FILES.plain.path, 'markdown'), 2);
  created('plain-note-double-click', twice, before => before?.type === 'markdown' && before.file === FILES.plain.path);
  const blank = await row('empty-note', openAs(FILES.empty.path, 'markdown'));
  created('empty-note', blank, before => before?.type === 'markdown' && before.file === FILES.empty.path);
  // No map is expected, and Obsidian's notice goes after a few seconds: read after the 1.5 s alone.
  const old = await row('old-format', openAs(FILES.legacy.path, 'markdown'), 1, false);
  pointed('old-format', old);
  const off = await row('mappy-false', openAs(FILES.off.path, 'markdown'));
  created('mappy-false', off, before => before?.type === 'markdown' && before.file === FILES.off.path);
  const canvas = await row('canvas', openFile(FILES.canvas.path));
  created('canvas', canvas, before => before?.type === 'canvas' && before.file === FILES.canvas.path);
  const empty = await row('empty-tab', emptyTab);
  created('empty-tab', empty, before => before?.type === 'empty' && before.file === null);
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`unexpected: ${error}`);
} finally {
  if (ownsFolder) {
    await detach().catch(() => null);
    // The empty tab of the last row is the case's own too (the new map may have taken it over: then it is closed above).
    await evaluate(`window.__mappyRibbonEmpty?.detach(); delete window.__mappyRibbonEmpty; return true;`).catch(() => null);
  }
  if (settingsAtStart) {
    const restored = await step('restore-settings', () => saveSettings(settingsAtStart));
    const differ = Object.keys(settingsAtStart).filter(key => JSON.stringify(restored?.[key]) !== JSON.stringify(settingsAtStart[key]));
    check(restored && differ.length === 0, `the settings are ${JSON.stringify(restored)}, not ${JSON.stringify(settingsAtStart)} (${differ.join(', ')})`);
  }
  if (ownsFolder && !flag('--keep')) await step('clean', removeFolder);
  exitCode = await finish(record, value('--json'));
  cdp.close();
}
process.exit(exitCode);
