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
 * The data file is the plugin's own (`.obsidian/plugins/mappy/data.json`), written and removed through the vault adapter
 * with the plugin then disabled and enabled, which is when it reads the file. The file as the run found it is copied to
 * a backup first and put back at the end; a backup already there means an earlier run stopped before that, and the case
 * refuses to start. The names and the note are written out here, not read from src/i18n.
 *
 * Usage: npm run harness:e2e:visible-layouts -- [--json <out.json>] [--shot <out.png>] [--keep]
 *   --shot  writes <out>.png (the Japanese settings tab with the timeline locked) and <out>-en.png (the same in English)
 *   --keep  leave the note in the vault
 */
import { LANGUAGE, VAULT, connect, wait } from './cdp.mjs';
import { switchLanguage } from './language.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeOpenStep, makeDeleteNote, makePluginStep } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-visible-layouts.md';
const SOURCE = ['---', 'mappy: true', '---', '## 旅行', '', '- 持ち物', '- 予約', ''].join('\n');
const DATA = '.obsidian/plugins/mappy/data.json';
const BACKUP = `${DATA}.e72-backup`;
const MODES = ['mindmap', 'timeline', 'hierarchy', 'balanced'];
const TEXT = {
  ja: { labels: ['通常マップ', 'タイムライン', '階層図', '左右バランス'], locked: layout => `「${layout}」は新規マップの既定レイアウトなので外せません。` },
  en: { labels: ['Mind map', 'Timeline', 'Hierarchy', 'Balanced'], locked: layout => `${layout} is the default layout for new maps, so it can't be hidden.` },
};

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

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const closeSettings = () => evaluate('app.setting.close(); await new Promise(resolve => setTimeout(resolve, 200)); return true;');
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

/** What a person sees: the settings tab's layout row (opened if it is not), the map's bottom-left buttons, and the data file. */
const READ = `${VIEW}
  if (app.setting.activeTab?.id !== 'mappy' || !app.setting.containerEl.isConnected) {
    app.setting.open(); app.setting.openTabById('mappy');
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  const tab = app.setting.activeTab.containerEl;
  const row = Array.from(tab.querySelectorAll('.setting-item')).find(item => item.querySelector('.mappy-setting-layouts'));
  const note = row?.querySelector('.mappy-setting-note');
  const toggles = Array.from(row?.querySelectorAll('.mappy-setting-layout') ?? [], item => {
    const toggle = item.querySelector('.checkbox-container');
    return { label: item.querySelector('span')?.textContent ?? '', on: toggle.classList.contains('is-enabled'), locked: toggle.classList.contains('is-disabled') };
  });
  const bar = Array.from(el.querySelectorAll('.mappy-modes .mappy-button'))
    .filter(button => !button.hidden && getComputedStyle(button).display !== 'none' && button.getBoundingClientRect().width > 0)
    .map(button => button.getAttribute('aria-label'));
  const raw = await app.vault.adapter.exists(${JSON.stringify(DATA)}) ? await app.vault.adapter.read(${JSON.stringify(DATA)}) : null;
  return {
    toggles,
    note: note ? { text: note.textContent, hidden: note.hidden || getComputedStyle(note).display === 'none' } : null,
    layout: tab.querySelectorAll('select')[1]?.value ?? null,
    bar,
    data: raw === null ? null : JSON.parse(raw),
    settings: JSON.parse(JSON.stringify(app.plugins.plugins.mappy.settings)),
  };`;
const read = () => evaluate(READ);

/** A real click at the centre of the `index`-th layout toggle in the open settings tab (a toggle takes a click as a checkbox does). */
async function clickToggle(index) {
  const box = await evaluate(`const toggle = app.setting.activeTab.containerEl.querySelectorAll('.mappy-setting-layout .checkbox-container')[${index}];
    if (!toggle) throw new Error('no toggle ${index}');
    toggle.scrollIntoView({ block: 'center' });
    await new Promise(resolve => setTimeout(resolve, 150));
    const rect = toggle.getBoundingClientRect();
    const x = rect.left + rect.width / 2; const y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x, y, hit: toggle.contains(top), cover: top ? String(top.className) : 'nothing' };`);
  if (!box.hit) throw new Error(`toggle ${index} is covered by ${box.cover}`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  await wait(600);
  return read();
}

/** The default layout dropdown set as a person's choice leaves it (Electron draws the list natively, out of reach of CDP). */
async function chooseDefault(layout) {
  await evaluate(`const select = app.setting.activeTab.containerEl.querySelectorAll('select')[1];
    select.value = ${JSON.stringify(layout)}; select.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  await wait(600);
  return read();
}

const flags = state => state?.toggles?.map?.(toggle => [toggle.on, toggle.locked]);

async function rows(language, shot) {
  const { labels, locked } = TEXT[language];
  const pick = modes => modes.map(mode => labels[MODES.indexOf(mode)]);
  const row = name => `${language}/${name}`;

  const fresh = required(record, row('fresh-load'), await step(row('fresh-load'), () => load(null)));
  check(same(fresh.settings.visibleLayouts, ['mindmap', 'timeline', 'hierarchy']), `${row('fresh')}: loaded ${JSON.stringify(fresh.settings.visibleLayouts)}`);
  const first = await step(row('fresh'), read);
  check(same(first?.bar, pick(['mindmap', 'timeline', 'hierarchy'])), `${row('fresh')}: the bar shows ${JSON.stringify(first?.bar)}`);
  check(same(first?.toggles?.map(toggle => toggle.label), labels), `${row('fresh')}: toggles named ${JSON.stringify(first?.toggles)}`);
  check(same(flags(first), [[true, true], [true, false], [true, false], [false, false]]), `${row('fresh')}: toggles ${JSON.stringify(first?.toggles)}`);
  check(first?.note?.hidden === true, `${row('fresh')}: a note is shown: ${JSON.stringify(first?.note)}`);
  check(first?.data === null, `${row('fresh')}: loading wrote the data file: ${JSON.stringify(first?.data)}`);

  const balancedOn = await step(row('balanced-on'), () => clickToggle(3));
  check(same(balancedOn?.data?.visibleLayouts, MODES), `${row('balanced-on')}: saved ${JSON.stringify(balancedOn?.data)}`);
  check(same(balancedOn?.bar, labels), `${row('balanced-on')}: the bar shows ${JSON.stringify(balancedOn?.bar)}`);
  const timelineOff = await step(row('timeline-off'), () => clickToggle(1));
  check(same(timelineOff?.data?.visibleLayouts, ['mindmap', 'hierarchy', 'balanced']), `${row('timeline-off')}: saved ${JSON.stringify(timelineOff?.data)}`);
  check(same(timelineOff?.bar, pick(['mindmap', 'hierarchy', 'balanced'])), `${row('timeline-off')}: the bar shows ${JSON.stringify(timelineOff?.bar)}`);

  const toTimeline = await step(row('default-timeline'), () => chooseDefault('timeline'));
  check(toTimeline?.data?.defaultLayout === 'timeline' && same(toTimeline.data.visibleLayouts, MODES), `${row('default-timeline')}: saved ${JSON.stringify(toTimeline?.data)}`);
  check(same(flags(toTimeline), [[true, true], [true, true], [true, false], [true, false]]), `${row('default-timeline')}: toggles ${JSON.stringify(toTimeline?.toggles)}`);
  check(toTimeline?.note?.hidden === false && toTimeline.note.text === locked(labels[1]), `${row('default-timeline')}: note ${JSON.stringify(toTimeline?.note)}`);
  check(same(toTimeline?.bar, labels), `${row('default-timeline')}: the bar shows ${JSON.stringify(toTimeline?.bar)}`);
  if (shot) await cdp.screenshot(shot);
  const lockedClick = await step(row('locked-clicks'), async () => { await clickToggle(1); return clickToggle(0); });
  check(same(lockedClick?.data, toTimeline?.data), `${row('locked-clicks')}: a locked toggle saved ${JSON.stringify(lockedClick?.data)}`);
  check(same(flags(lockedClick), flags(toTimeline)), `${row('locked-clicks')}: toggles ${JSON.stringify(lockedClick?.toggles)}`);
  const toMindmap = await step(row('default-mindmap'), () => chooseDefault('mindmap'));
  check(toMindmap?.data?.defaultLayout === 'mindmap' && same(toMindmap.data.visibleLayouts, MODES), `${row('default-mindmap')}: saved ${JSON.stringify(toMindmap?.data)}`);
  check(same(flags(toMindmap), [[true, true], [true, false], [true, false], [true, false]]), `${row('default-mindmap')}: toggles ${JSON.stringify(toMindmap?.toggles)}`);
  check(toMindmap?.note?.hidden === true, `${row('default-mindmap')}: note ${JSON.stringify(toMindmap?.note)}`);

  const legacyData = { theme: 'follow', defaultLayout: 'balanced', newMapFolder: '', visibleLayouts: ['mindmap'] };
  const legacyLoad = required(record, row('legacy-load'), await step(row('legacy-load'), () => load(legacyData)));
  check(legacyLoad.settings.defaultLayout === 'balanced' && same(legacyLoad.settings.visibleLayouts, ['mindmap', 'balanced']), `${row('legacy')}: loaded ${JSON.stringify(legacyLoad.settings)}`);
  const legacy = await step(row('legacy'), read);
  check(legacy?.layout === 'balanced', `${row('legacy')}: the dropdown says ${legacy?.layout}`);
  check(same(flags(legacy), [[true, true], [false, false], [false, false], [true, true]]), `${row('legacy')}: toggles ${JSON.stringify(legacy?.toggles)}`);
  check(legacy?.note?.hidden === false && legacy.note.text === locked(labels[3]), `${row('legacy')}: note ${JSON.stringify(legacy?.note)}`);
  check(same(legacy?.bar, pick(['mindmap', 'balanced'])), `${row('legacy')}: the bar shows ${JSON.stringify(legacy?.bar)}`);

  const allLoad = required(record, row('all-four-load'), await step(row('all-four-load'), () => load({ ...legacyData, defaultLayout: 'mindmap', visibleLayouts: MODES })));
  check(same(allLoad.settings.visibleLayouts, MODES), `${row('all-four')}: loaded ${JSON.stringify(allLoad.settings)}`);
  const all = await step(row('all-four'), read);
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
  await rows('ja', shot && `${shot}.png`);
  required(record, 'to-en', await step('to-en', async () => { cdp = await switchLanguage(cdp, 'en'); return cdp.evaluate('window.moment.locale()'); }));
  await rows('en', shot && `${shot}-en.png`);
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`unexpected: ${error}`);
} finally {
  // The data file first (it does not depend on the language), then the language, as E71 does.
  if (cdp.closed) cdp = await connect({ language: null }).catch(() => cdp);
  if (cdp.closed) record.failures.push('the window could not be reached to put its data file and language back: check them by hand');
  else {
    await closeSettings().catch(() => null);
    await detachMaps().catch(() => null);
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
