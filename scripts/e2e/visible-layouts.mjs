/**
 * E72 (docs/harness.md, LEV-257): the setting 「左下に表示するレイアウト」／`Layouts in the bottom-left corner` on the real
 * Obsidian, in Japanese and in English. What a person sees on a new install, how the default layout locks its toggle,
 * and what a data file saved by an earlier version turns into.
 *
 * Rows, each in both languages (the test Obsidian's Japanese, then English switched as E63 does, then back):
 * - fresh: no data file, the plugin reloaded → three buttons at the bottom left (the balanced map hidden), the toggles
 *   on, on, on, off, only the regular map locked, no note under them, and no data file written by loading;
 * - toggles: real clicks turn the balanced map on and the timeline off, and the map's buttons follow at once;
 * - default: the dropdown set to the (hidden) timeline shows it again in the same save, locks its toggle and names it
 *   under the toggles; real clicks on it and on the regular map change nothing; back to the regular map, it is free;
 * - legacy: a data file with the balanced map as the default and only the regular map shown (possible before the lock)
 *   → the balanced map is shown and locked, and stays the default;
 * - all four: a data file with all four shown (an earlier version's default, saved with any other change) → kept.
 *
 * How the toggles sit (LEV-370), read in every row above: one layout per line under the row's name and description,
 * each toggle's right edge at the x where the other settings' controls end (within half a pixel), each name on one
 * line, no text of a line reaching its toggle, and「いつも出ます」／`Always shown` beside exactly the locked ones. Also
 * read: the tab right after `update()` while it is open (1.13+ then draws the row again into the same Setting: still one
 * set of four), and, with the timeline locked, Obsidian's base theme set light and then dark (`app.changeTheme`) before
 * it is put back key and all, and the settings window narrowed to 460 px through CDP's viewport emulation of that
 * window alone (no OS window is touched), where no toggle may end past the window either.
 *
 * The data file is the plugin's own (`.obsidian/plugins/mappy/data.json`), written and removed through the vault adapter
 * with the plugin then disabled and enabled, which is when it reads the file. The file as the run found it is copied to
 * a backup first and put back at the end; a backup already there means an earlier run stopped before that, and the case
 * refuses to start. The names and the note are written out here, not read from src/i18n.
 *
 * Usage: npm run harness:e2e:visible-layouts -- [--json <out.json>] [--shot <out.png>] [--keep]
 *   --shot  writes <out>-<language>-<theme>.png: the settings window with the timeline locked, ja/en × light/dark
 *   --keep  leave the note in the vault
 */
import { LANGUAGE, VAULT, connect, wait } from './cdp.mjs';
import { switchLanguage } from './language.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeOpenStep, makeDeleteNote, makePluginStep } from './dom-helpers.mjs';
import { makeAppTheme } from './window-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-visible-layouts.md';
const SOURCE = ['---', 'mappy: true', '---', '## 旅行', '', '- 持ち物', '- 予約', ''].join('\n');
const DATA = '.obsidian/plugins/mappy/data.json';
const BACKUP = `${DATA}.e72-backup`;
const MODES = ['mindmap', 'timeline', 'hierarchy', 'balanced'];
const TEXT = {
  ja: { labels: ['通常マップ', 'タイムライン', '階層図', '左右バランス'], locked: layout => `「${layout}」は新規マップの既定レイアウトなので外せません。`, always: 'いつも出ます' },
  en: { labels: ['Mind map', 'Timeline', 'Hierarchy', 'Balanced'], locked: layout => `${layout} is the default layout for new maps, so it can't be hidden.`, always: 'Always shown' },
};
/** How far apart, in CSS pixels, two right edges may be and still count as one. */
const EDGE = 0.5;

if (LANGUAGE !== 'ja') throw new Error('E72 starts from the Japanese test Obsidian (MAPPY_E2E_LANGUAGE unset or ja); it switches to English itself.');

const record = createRecord(VAULT, NOTE);
let cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);

/** The stored `language` key as this run found it, put back at the end. */
const storedAtStart = await cdp.evaluate("localStorage.getItem('language')");
/** The plugin's settings as this run found them; compared with what the restore leaves. */
let settingsAtStart = null;
/** Whether this run wrote the backup, and so owns the data file until it has put it back. */
let ownsData = false;
/**
 * Obsidian's base theme as this run found it, put back at the end: the vault's own `theme` key (null when the vault never
 * chose one, which Obsidian reads as 'system') and the scheme the window showed.
 */
const themeAtStart = await cdp.evaluate("({ key: app.vault.config.theme ?? null, scheme: document.body.classList.contains('theme-dark') ? 'dark' : 'light' })");
/** Whether this run changed the base theme and has not put it back yet. */
let themeChanged = false;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/**
 * Obsidian 1.14 opens the settings in a window of their own (an `about:blank` page target, `is-popout-modal`): a real
 * click has to go to that window's connection. That window has no `app` of its own, so the main window, already
 * checked, marks its body, and `connect({ popout, appless })` takes the target carrying that mark.
 */
let settingsCdp = null;
const closeSettings = async () => {
  settingsCdp?.close();
  settingsCdp = null;
  return evaluate('app.setting.close(); await new Promise(resolve => setTimeout(resolve, 400)); return true;');
};
/** This run's own mark, so a settings window of another vault's Obsidian on the same port is never taken. */
const MARK = `settings-${process.pid}-${Date.now()}`;
async function openSettings() {
  if (settingsCdp && !settingsCdp.closed) return settingsCdp;
  await evaluate(`app.setting.open(); await new Promise(resolve => setTimeout(resolve, 600));
    app.setting.openTabById('mappy'); await new Promise(resolve => setTimeout(resolve, 600));
    if (app.setting.activeTab?.id !== 'mappy') throw new Error('the Mappy settings tab did not open');
    const settingsDocument = app.setting.activeTab.containerEl.ownerDocument;
    // Before 1.14 the settings are a modal in this window: the case is written for their own window, and says so.
    if (settingsDocument === document) throw new Error('the settings opened in the main window: E72 needs Obsidian 1.14+, where they have a window of their own');
    settingsDocument.body.dataset.mappyE2ePopout = ${JSON.stringify(MARK)};
    return true;`);
  for (let tries = 0; tries < 10 && !settingsCdp; tries += 1) {
    settingsCdp = await connect({ popout: MARK, appless: true }).catch(async error => { if (tries === 9) throw error; await wait(300); return null; });
  }
  return settingsCdp;
}
/** Close the map tabs on this case's note only. */
const detachMaps = () => evaluate(`app.workspace.getLeavesOfType('mappy-map')
  .filter(leaf => (leaf.view.file?.path ?? leaf.getViewState().state?.file) === ${JSON.stringify(NOTE)})
  .forEach(leaf => leaf.detach());
  await new Promise(resolve => setTimeout(resolve, 300)); return true;`);

/** The data file set to `data` (`null` removes it), then the plugin disabled and enabled so it reads the file again. */
async function load(data) {
  await closeSettings();
  await detachMaps();
  const settings = await evaluate(`const adapter = app.vault.adapter;
    const data = ${JSON.stringify(data)};
    if (data === null) { if (await adapter.exists(${JSON.stringify(DATA)})) await adapter.remove(${JSON.stringify(DATA)}); }
    else await adapter.write(${JSON.stringify(DATA)}, JSON.stringify(data, null, 2));
    await app.plugins.disablePlugin('mappy'); await app.plugins.enablePlugin('mappy');
    for (let tries = 0; tries < 30 && !app.commands.commands['mappy:convert-to-list']; tries += 1) await new Promise(resolve => setTimeout(resolve, 200));
    await new Promise(resolve => setTimeout(resolve, 400));
    return JSON.parse(JSON.stringify(app.plugins.plugins.mappy.settings));`);
  const opened = await makeOpenStep(evaluate, { note: NOTE, source: SOURCE })();
  return { settings, labels: opened.labels };
}

/** Script: the default layout's dropdown (Obsidian 1.14 puts a hidden measuring select beside each one). */
const LAYOUT_SELECT = `app.setting.activeTab.containerEl.querySelectorAll('.setting-item')[1].querySelector('select.dropdown:not(.is-measuring)')`;

/**
 * What a person sees: the settings tab's layout row, the map's bottom-left buttons, and the data file. Each toggle
 * comes with where it is drawn (its box, how many lines its name takes, the「いつも出ます」beside it when shown), and
 * `controls` is where each other row's control ends on the right (Obsidian 1.14's hidden measuring select left out).
 */
const READ = `${VIEW}
  const tab = app.setting.activeTab.containerEl;
  const style = node => node.ownerDocument.defaultView.getComputedStyle(node);
  const shown = node => Boolean(node) && !node.hidden && style(node).display !== 'none';
  const items = Array.from(tab.querySelectorAll('.setting-item'));
  const row = items.find(item => item.querySelector('.mappy-setting-layouts'));
  const note = row?.querySelector('.mappy-setting-note');
  const lines = text => {
    const range = text.ownerDocument.createRange();
    range.selectNodeContents(text);
    return new Set(Array.from(range.getClientRects(), rect => Math.round(rect.top))).size;
  };
  const toggles = Array.from(row?.querySelectorAll('.mappy-setting-layout') ?? [], item => {
    const toggle = item.querySelector('.checkbox-container');
    // Before LEV-370 the name was the line's only span.
    const name = item.querySelector('.mappy-setting-layout-name') ?? item.querySelector('span');
    const text = Array.from(item.querySelectorAll('span'), span => span.getBoundingClientRect().right);
    const always = item.querySelector('.mappy-setting-layout-always');
    const { left, right, top, bottom } = toggle.getBoundingClientRect();
    return {
      label: name?.textContent ?? '', on: toggle.classList.contains('is-enabled'), locked: toggle.classList.contains('is-disabled'),
      box: { left, right, top, bottom }, nameLines: name ? lines(name) : 0, always: shown(always) ? always.textContent : null,
      textRight: text.length > 0 ? Math.max(...text) : null,
    };
  });
  const controls = items.filter(item => item !== row).map(item => {
    const control = Array.from(item.querySelector('.setting-item-control')?.children ?? []).filter(child => !child.classList.contains('is-measuring') && shown(child)).pop();
    return control ? control.getBoundingClientRect().right : null;
  });
  const bar = Array.from(el.querySelectorAll('.mappy-modes .mappy-button'))
    .filter(button => !button.hidden && getComputedStyle(button).display !== 'none' && button.getBoundingClientRect().width > 0)
    .map(button => button.getAttribute('aria-label'));
  const raw = await app.vault.adapter.exists(${JSON.stringify(DATA)}) ? await app.vault.adapter.read(${JSON.stringify(DATA)}) : null;
  return {
    toggles,
    controls,
    width: tab.ownerDocument.defaultView.innerWidth,
    theme: tab.ownerDocument.body.classList.contains('theme-dark') ? 'dark' : 'light',
    note: note ? { text: note.textContent, hidden: note.hidden || style(note).display === 'none' } : null,
    layout: ${LAYOUT_SELECT}?.value ?? null,
    bar,
    data: raw === null ? null : JSON.parse(raw),
    settings: JSON.parse(JSON.stringify(app.plugins.plugins.mappy.settings)),
  };`;
const read = async () => { await openSettings(); return evaluate(READ); };

/** A real click at the centre of the `index`-th layout toggle in the open settings tab (a toggle takes a click as a checkbox does). */
async function clickToggle(index) {
  const popout = await openSettings();
  const box = await popout.evaluate(`(async () => { const toggle = document.querySelectorAll('.mappy-setting-layout .checkbox-container')[${index}];
    if (!toggle) throw new Error('no toggle ${index}');
    toggle.scrollIntoView({ block: 'center' });
    await new Promise(resolve => setTimeout(resolve, 150));
    const rect = toggle.getBoundingClientRect();
    const x = rect.left + rect.width / 2; const y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x, y, hit: toggle.contains(top), cover: top ? String(top.className) : 'nothing' }; })()`);
  if (!box.hit) throw new Error(`toggle ${index} is covered by ${box.cover}`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await popout.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  await wait(600);
  return read();
}

/** The default layout dropdown set as a person's choice leaves it (Electron draws the list natively, out of reach of CDP). */
async function chooseDefault(layout) {
  await openSettings();
  await evaluate(`const select = ${LAYOUT_SELECT};
    select.value = ${JSON.stringify(layout)}; select.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  await wait(600);
  return read();
}

const flags = state => state?.toggles?.map?.(toggle => [toggle.on, toggle.locked]);

/**
 * How the toggles sit (LEV-370): one set of four, one per line, stacked down the row at one x; every toggle's right
 * edge where each other row's control ends, inside the window; no text of a line reaching its toggle; each name on one
 * line; and「いつも出ます」beside exactly the locked toggles. A step that failed has its own failure already.
 */
function checkLines(name, state, always) {
  if (!state || state.error) return;
  const toggles = state.toggles ?? [];
  if (toggles.length !== MODES.length) { check(false, `${name}: ${toggles.length} toggles drawn`); return; }
  const edges = [...toggles.map(toggle => toggle.box.right), ...(state.controls ?? [])];
  const aligned = state.controls?.length > 0 && edges.every(edge => typeof edge === 'number') && Math.max(...edges) - Math.min(...edges) <= EDGE;
  check(aligned, `${name}: the toggles end at ${JSON.stringify(toggles.map(toggle => toggle.box.right))}, the other controls at ${JSON.stringify(state.controls)}`);
  const stacked = toggles.every((toggle, index) => index === 0
    || (toggle.box.top >= toggles[index - 1].box.bottom && Math.abs(toggle.box.left - toggles[0].box.left) <= EDGE));
  check(stacked, `${name}: the toggles are not one per line: ${JSON.stringify(toggles.map(toggle => toggle.box))}`);
  check(toggles.every(toggle => toggle.box.right <= state.width + EDGE), `${name}: a toggle ends past the window's ${state.width}: ${JSON.stringify(toggles.map(toggle => toggle.box.right))}`);
  check(toggles.every(toggle => toggle.textRight === null || toggle.textRight <= toggle.box.left + EDGE), `${name}: a line's text runs under its toggle: ${JSON.stringify(toggles.map(toggle => [toggle.label, toggle.textRight, toggle.box.left]))}`);
  check(toggles.every(toggle => toggle.nameLines === 1), `${name}: a name wraps: ${JSON.stringify(toggles.map(toggle => [toggle.label, toggle.nameLines]))}`);
  check(toggles.every(toggle => (toggle.always === always) === toggle.locked), `${name}: 「${always}」 beside ${JSON.stringify(toggles.map(toggle => [toggle.label, toggle.always]))}`);
}

/** The settings window's own evaluate, for what has to be waited for there (its body's theme class). */
const inSettings = async expression => (await openSettings()).evaluate(`(async () => { ${expression} })()`);
const appTheme = makeAppTheme(evaluate);
/** Obsidian's base theme set to `scheme`, waited for in the main window and the settings window. */
async function setTheme(scheme) {
  themeChanged = true;
  return appTheme(scheme, [evaluate, inSettings]);
}
/**
 * The base theme put back as the run found it, key and all (Obsidian's `setConfig` with undefined removes the key, so a
 * vault that never chose a theme is left without one), checked against what the run found.
 */
async function restoreTheme(name) {
  const back = await step(name, () => evaluate(`const start = ${JSON.stringify(themeAtStart)};
    app.changeTheme(start.key ?? 'system');
    if (start.key === null) app.vault.setConfig('theme', undefined);
    for (const started = Date.now(); Date.now() - started < 5000 && !document.body.classList.contains('theme-' + start.scheme); await new Promise(resolve => setTimeout(resolve, 50)));
    return { key: app.vault.config.theme ?? null, scheme: document.body.classList.contains('theme-dark') ? 'dark' : 'light' };`));
  check(same(back, themeAtStart), `${name}: the base theme is ${JSON.stringify(back)}, not ${JSON.stringify(themeAtStart)} as the run found it`);
  themeChanged = false;
}
/** A settings window narrower than the default, through CDP's viewport emulation of that window alone (no OS window is touched). */
const NARROW = 460;

async function rows(language, shot) {
  const { labels, locked, always } = TEXT[language];
  const pick = modes => modes.map(mode => labels[MODES.indexOf(mode)]);
  const row = name => `${language}/${name}`;
  /** A step that reads the settings tab, its toggles then checked for how they sit. */
  const look = async (name, run) => {
    const state = await step(name, run);
    if (state) checkLines(name, state, always);
    return state;
  };

  const fresh = required(record, row('fresh-load'), await step(row('fresh-load'), () => load(null)));
  check(same(fresh.settings.visibleLayouts, ['mindmap', 'timeline', 'hierarchy']), `${row('fresh')}: loaded ${JSON.stringify(fresh.settings.visibleLayouts)}`);
  const first = await look(row('fresh'), read);
  // While the tab is open, 1.13+ draws a row again into the same Setting (its cleanup, `clear()`, render): still one set.
  const redrawn = await look(row('redraw'), async () => { await evaluate('app.setting.activeTab.update(); await new Promise(resolve => setTimeout(resolve, 400)); return true;'); return read(); });
  check(same(flags(redrawn), flags(first)), `${row('redraw')}: toggles ${JSON.stringify(redrawn?.toggles)}`);
  check(same(first?.bar, pick(['mindmap', 'timeline', 'hierarchy'])), `${row('fresh')}: the bar shows ${JSON.stringify(first?.bar)}`);
  check(same(first?.toggles?.map(toggle => toggle.label), labels), `${row('fresh')}: toggles named ${JSON.stringify(first?.toggles)}`);
  check(same(flags(first), [[true, true], [true, false], [true, false], [false, false]]), `${row('fresh')}: toggles ${JSON.stringify(first?.toggles)}`);
  check(first?.note?.hidden === true, `${row('fresh')}: a note is shown: ${JSON.stringify(first?.note)}`);
  check(first?.data === null, `${row('fresh')}: loading wrote the data file: ${JSON.stringify(first?.data)}`);

  const balancedOn = await look(row('balanced-on'), () => clickToggle(3));
  check(same(balancedOn?.data?.visibleLayouts, MODES), `${row('balanced-on')}: saved ${JSON.stringify(balancedOn?.data)}`);
  check(same(balancedOn?.bar, labels), `${row('balanced-on')}: the bar shows ${JSON.stringify(balancedOn?.bar)}`);
  const timelineOff = await look(row('timeline-off'), () => clickToggle(1));
  check(same(timelineOff?.data?.visibleLayouts, ['mindmap', 'hierarchy', 'balanced']), `${row('timeline-off')}: saved ${JSON.stringify(timelineOff?.data)}`);
  check(same(timelineOff?.bar, pick(['mindmap', 'hierarchy', 'balanced'])), `${row('timeline-off')}: the bar shows ${JSON.stringify(timelineOff?.bar)}`);

  const toTimeline = await look(row('default-timeline'), () => chooseDefault('timeline'));
  check(toTimeline?.data?.defaultLayout === 'timeline' && same(toTimeline.data.visibleLayouts, MODES), `${row('default-timeline')}: saved ${JSON.stringify(toTimeline?.data)}`);
  check(same(flags(toTimeline), [[true, true], [true, true], [true, false], [true, false]]), `${row('default-timeline')}: toggles ${JSON.stringify(toTimeline?.toggles)}`);
  check(toTimeline?.note?.hidden === false && toTimeline.note.text === locked(labels[1]), `${row('default-timeline')}: note ${JSON.stringify(toTimeline?.note)}`);
  check(same(toTimeline?.bar, labels), `${row('default-timeline')}: the bar shows ${JSON.stringify(toTimeline?.bar)}`);
  // The same tab under Obsidian's light and dark themes, then the theme the run found.
  for (const scheme of ['light', 'dark']) {
    const themed = await look(row(`theme-${scheme}`), async () => { await setTheme(scheme); return read(); });
    check(themed?.theme === scheme, `${row(`theme-${scheme}`)}: the settings window shows the ${themed?.theme} theme`);
    check(same(flags(themed), flags(toTimeline)), `${row(`theme-${scheme}`)}: toggles ${JSON.stringify(themed?.toggles)}`);
    // The evidence the run was asked for: a missing picture is a failure, not a silent skip.
    if (shot) await step(row(`shot-${scheme}`), () => { if (!settingsCdp || settingsCdp.closed) throw new Error('no settings window to take'); return settingsCdp.screenshot(`${shot}-${language}-${scheme}.png`); });
  }
  await restoreTheme(row('theme-back'));
  // A narrow settings window: the lines shrink with the row, and nothing runs under a toggle or pushes it out.
  const narrow = await look(row('narrow'), async () => {
    await (await openSettings()).send('Emulation.setDeviceMetricsOverride', { width: NARROW, height: 700, deviceScaleFactor: 0, mobile: false });
    await wait(500);
    return read();
  });
  check(narrow?.width === NARROW, `${row('narrow')}: the settings window is ${narrow?.width} wide`);
  await step(row('narrow-back'), async () => { await (await openSettings()).send('Emulation.clearDeviceMetricsOverride', {}); await wait(300); return true; });
  const lockedClick = await look(row('locked-clicks'), async () => { await clickToggle(1); return clickToggle(0); });
  check(same(lockedClick?.data, toTimeline?.data), `${row('locked-clicks')}: a locked toggle saved ${JSON.stringify(lockedClick?.data)}`);
  check(same(flags(lockedClick), flags(toTimeline)), `${row('locked-clicks')}: toggles ${JSON.stringify(lockedClick?.toggles)}`);
  const toMindmap = await look(row('default-mindmap'), () => chooseDefault('mindmap'));
  check(toMindmap?.data?.defaultLayout === 'mindmap' && same(toMindmap.data.visibleLayouts, MODES), `${row('default-mindmap')}: saved ${JSON.stringify(toMindmap?.data)}`);
  check(same(flags(toMindmap), [[true, true], [true, false], [true, false], [true, false]]), `${row('default-mindmap')}: toggles ${JSON.stringify(toMindmap?.toggles)}`);
  check(toMindmap?.note?.hidden === true, `${row('default-mindmap')}: note ${JSON.stringify(toMindmap?.note)}`);

  const legacyData = { theme: 'follow', defaultLayout: 'balanced', newMapFolder: '', visibleLayouts: ['mindmap'] };
  const legacyLoad = required(record, row('legacy-load'), await step(row('legacy-load'), () => load(legacyData)));
  check(legacyLoad.settings.defaultLayout === 'balanced' && same(legacyLoad.settings.visibleLayouts, ['mindmap', 'balanced']), `${row('legacy')}: loaded ${JSON.stringify(legacyLoad.settings)}`);
  const legacy = await look(row('legacy'), read);
  check(legacy?.layout === 'balanced', `${row('legacy')}: the dropdown says ${legacy?.layout}`);
  check(same(flags(legacy), [[true, true], [false, false], [false, false], [true, true]]), `${row('legacy')}: toggles ${JSON.stringify(legacy?.toggles)}`);
  check(legacy?.note?.hidden === false && legacy.note.text === locked(labels[3]), `${row('legacy')}: note ${JSON.stringify(legacy?.note)}`);
  check(same(legacy?.bar, pick(['mindmap', 'balanced'])), `${row('legacy')}: the bar shows ${JSON.stringify(legacy?.bar)}`);

  const allLoad = required(record, row('all-four-load'), await step(row('all-four-load'), () => load({ ...legacyData, defaultLayout: 'mindmap', visibleLayouts: MODES })));
  check(same(allLoad.settings.visibleLayouts, MODES), `${row('all-four')}: loaded ${JSON.stringify(allLoad.settings)}`);
  const all = await look(row('all-four'), read);
  check(same(flags(all), [[true, true], [true, false], [true, false], [true, false]]), `${row('all-four')}: toggles ${JSON.stringify(all?.toggles)}`);
  check(same(all?.bar, labels), `${row('all-four')}: the bar shows ${JSON.stringify(all?.bar)}`);
  await closeSettings();
}

let exitCode = 1;
try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  required(record, 'backup', await step('backup', async () => {
    const found = await evaluate(`const adapter = app.vault.adapter;
      if (await adapter.exists(${JSON.stringify(BACKUP)})) throw new Error('${BACKUP} is already there (a run stopped before its restore?): put it back as data.json by hand, then remove it');
      const raw = await adapter.exists(${JSON.stringify(DATA)}) ? await adapter.read(${JSON.stringify(DATA)}) : null;
      await adapter.write(${JSON.stringify(BACKUP)}, JSON.stringify({ raw }));
      return { raw, settings: JSON.parse(JSON.stringify(app.plugins.plugins.mappy.settings)) };`);
    settingsAtStart = found.settings;
    ownsData = true;
    return found;
  }));
  const shot = value('--shot')?.replace(/\.png$/u, '');
  await rows('ja', shot);
  required(record, 'to-en', await step('to-en', async () => { cdp = await switchLanguage(cdp, 'en'); return cdp.evaluate('window.moment.locale()'); }));
  await rows('en', shot);
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`unexpected: ${error}`);
} finally {
  // The data file first (it does not depend on the language), then the language, as E71 does.
  if (cdp.closed) cdp = await connect({ language: null }).catch(() => cdp);
  if (cdp.closed) record.failures.push('the window could not be reached to put its data file and language back: check them by hand');
  else {
    await closeSettings().catch(() => null);
    await detachMaps().catch(() => null);
    if (themeChanged) await restoreTheme('restore-theme');
    if (ownsData) {
      const restored = await step('restore-data', () => evaluate(`const adapter = app.vault.adapter;
        const { raw } = JSON.parse(await adapter.read(${JSON.stringify(BACKUP)}));
        if (raw === null) { if (await adapter.exists(${JSON.stringify(DATA)})) await adapter.remove(${JSON.stringify(DATA)}); }
        else await adapter.write(${JSON.stringify(DATA)}, raw);
        await app.plugins.disablePlugin('mappy'); await app.plugins.enablePlugin('mappy');
        for (let tries = 0; tries < 30 && !app.commands.commands['mappy:convert-to-list']; tries += 1) await new Promise(resolve => setTimeout(resolve, 200));
        const back = await adapter.exists(${JSON.stringify(DATA)}) ? await adapter.read(${JSON.stringify(DATA)}) : null;
        if (back !== raw) throw new Error('the data file is not as the run found it');
        await adapter.remove(${JSON.stringify(BACKUP)});
        return JSON.parse(JSON.stringify(app.plugins.plugins.mappy.settings));`));
      const differ = settingsAtStart ? Object.keys(settingsAtStart).filter(key => !same(restored?.[key], settingsAtStart[key])) : ['(none read)'];
      check(differ.length === 0, `the settings are ${JSON.stringify(restored)}, not ${JSON.stringify(settingsAtStart)} as the run found them (${differ.join(', ')})`);
    }
    if (!flag('--keep')) await step('clean', makeDeleteNote(evaluate, NOTE));
    const now = await cdp.evaluate("[window.moment?.locale?.() ?? null, localStorage.getItem('language')]").catch(() => [null, null]);
    if (now[0] !== 'ja' || now[1] !== storedAtStart) await step('restore', async () => { cdp = await switchLanguage(cdp, storedAtStart, 'ja'); return true; });
  }
  exitCode = await finish(record, value('--json'));
  cdp.close();
}
process.exit(exitCode);
