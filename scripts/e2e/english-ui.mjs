/**
 * E63 (docs/harness.md, LEV-226・LEV-235): the plugin in an English Obsidian. Every other case runs the test Obsidian in
 * Japanese (cdp.mjs `LANGUAGE`) and reads the Japanese text; this one switches the app to English the way the setting
 * does (the stored `language`, then a reload of the app, which is when `getLanguage()` is read), checks what a person
 * sees and what is written to the note, and switches back to Japanese, checking that too.
 *
 * In English:
 * - the commands (the palette's names), the layout, zoom and gear buttons, the gear popover's items, the tab's title,
 *   the settings tab's names, the right-click menu of a node: all English, no Japanese character anywhere in them;
 * - Tab on a node writes the English provisional name (`- Subtopic`) into the note, and Enter keeps it;
 * - a name the map refuses (a task marker) shows core's English reason on the draft's error line.
 * Back in Japanese: the layout buttons and the provisional name are Japanese again (`サブトピック`).
 *
 * The expected English is written out here, not read from src/i18n/en.ts: it is what a person reads, and the case
 * must fail if the table changes it by accident.
 *
 * Usage: npm run harness:e2e:english-ui -- [--reload] [--json <out.json>] [--shot <out.png>] [--keep]
 *   --shot  writes <out>-en.png (the map with the gear popover open) and <out>-ja.png
 *   --keep  leave the note in the vault
 */
import { connect, LANGUAGE, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep, makeOpenStep, makeClickIn, makeDeleteNote } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-english-ui.md';
const SOURCE = ['---', 'mappy: true', '---', '## Trip', '', '- Packing', '  - Clothes', '- Booking', ''].join('\n');
const JAPANESE = /[\u3000-\u9fff\uff00-\uffef]/u;
const COMMANDS = {
  'mappy:create-mindmap': 'Create new mind map',
  'mappy:convert-note-to-mindmap': 'Turn this note into a mind map',
  'mappy:open-mindmap': 'Open mind map',
  'mappy:open-mindmap-split': 'Open mind map beside Markdown',
  'mappy:toggle-mindmap': 'Switch between map and Markdown',
  'mappy:remove-mindmap': 'Turn off mind map for this note',
  'mappy:insert-into-excalidraw': 'Insert current map into Excalidraw drawing',
  'mappy:export-map-image': 'Export current map as SVG or PNG',
  'mappy:call-map': 'Search and insert a map',
  'mappy:convert-to-list': 'Change current map to list format',
};
const LAYOUTS = ['Mind map', 'Timeline', 'Hierarchy', 'Balanced'];
const SETTINGS = ['Theme', 'Default layout for new maps', 'Folder for new maps', 'Layouts in the bottom-left corner'];
const POPOVER = ['Switch to Markdown', 'Search and insert a map', 'Export'];

if (LANGUAGE !== 'ja') throw new Error('E63 starts from the Japanese test Obsidian (MAPPY_E2E_LANGUAGE unset or ja); it switches to English itself.');

const record = createRecord(VAULT, NOTE);
let cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);

/** The app in `language`, as Settings → General → Language leaves it: the stored key, then the app reloaded. */
const switchTo = async language => {
  await evaluate(`localStorage.setItem('language', ${JSON.stringify(language)});
    window.__mappyE2E = null; setTimeout(() => app.commands.executeCommandById('app:reload'), 50); return true;`);
  await wait(3000);
  let refused = null;
  for (const started = Date.now(); Date.now() - started < 30000; await wait(1000)) {
    try {
      cdp = await connect({ language });
      if (await cdp.evaluate('!!(app.workspace.layoutReady && app.plugins.plugins.mappy)')) return { language, loaded: await cdp.evaluate('window.moment.locale()') };
      cdp.close();
    } catch (error) { refused = error; }
  }
  throw refused ?? new Error(`the window did not come back in ${language} with Mappy loaded within 30 s`);
};

/** What the map view and the app show now: the texts this case compares, each list in screen order. */
const READ = `${VIEW}
  const attr = (selector, name) => Array.from(el.querySelectorAll(selector), item => item.getAttribute(name) ?? '');
  const commands = Object.fromEntries(Object.keys(app.commands.commands).filter(id => id.startsWith('mappy:')).map(id => [id, app.commands.commands[id].name]));
  return {
    commands,
    layouts: attr('.mappy-modes .mappy-button', 'aria-label'),
    zoom: attr('.mappy-zoom .mappy-button', 'aria-label').filter(Boolean),
    gear: attr('.mappy-actions .mappy-button', 'aria-label'),
    regions: [...attr('.mappy-modes', 'aria-label'), ...attr('.mappy-actions', 'aria-label'), ...attr('.mappy-zoom', 'aria-label'), ...attr('.mappy-canvas', 'aria-label')],
    title: view.getDisplayText(),
    labels: nodes().map(label),
    source: await source(),
  };`;

const clean = makeDeleteNote(evaluate, NOTE);
let exitCode = 1;
try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  required(record, 'to-en', await step('to-en', () => switchTo('en')));
  required(record, 'open-en', await step('open-en', makeOpenStep(evaluate, { note: NOTE, source: SOURCE })));

  const en = required(record, 'read-en', await step('read-en', () => evaluate(READ)));
  for (const [id, name] of Object.entries(COMMANDS)) check(en.commands[id] === `Mappy: ${name}`, `command ${id}: ${JSON.stringify(en.commands[id])}, not "Mappy: ${name}"`);
  check(JSON.stringify(en.layouts) === JSON.stringify(LAYOUTS), `layout buttons: ${JSON.stringify(en.layouts)}`);
  check(en.zoom.includes('Zoom in') && en.zoom.includes('Zoom out') && en.zoom.includes('Fit to view'), `zoom buttons: ${JSON.stringify(en.zoom)}`);
  check(JSON.stringify(en.gear) === JSON.stringify(['Actions']), `gear: ${JSON.stringify(en.gear)}`);
  check(en.title === 'E2E-english-ui · map', `tab title: ${en.title}`);
  const japanese = [...Object.values(en.commands), ...en.layouts, ...en.zoom, ...en.gear, ...en.regions, en.title].filter(text => JAPANESE.test(text));
  check(japanese.length === 0, `Japanese in the English UI: ${JSON.stringify(japanese)}`);

  const clickIn = makeClickIn(cdp, evaluate);
  const popover = await step('popover-en', async () => {
    await clickIn('.mappy-actions .mappy-button');
    await wait(300);
    const items = await evaluate(`${VIEW} return Array.from(el.querySelectorAll('.mappy-popover-item'), item => [item.querySelector('.mappy-popover-title')?.textContent ?? '', item.querySelector('.mappy-popover-description')?.textContent ?? '']);`);
    if (value('--shot')) await cdp.screenshot(`${value('--shot').replace(/\.png$/u, '')}-en.png`);
    await cdp.realKey('Escape');
    await wait(200);
    return items;
  });
  check(JSON.stringify(popover?.map?.(([title]) => title)) === JSON.stringify(POPOVER), `popover: ${JSON.stringify(popover)}`);
  check(!(popover ?? []).flat().some(text => JAPANESE.test(text)), `Japanese in the popover: ${JSON.stringify(popover)}`);

  const select = makeSelect(cdp, evaluate);
  const menu = await step('menu-en', async () => {
    await select('Packing');
    const box = await evaluate(`${VIEW} const rect = nth('Packing', 0).getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'right', clickCount: 1 });
    await wait(300);
    const titles = await evaluate(`return Array.from(document.querySelectorAll('.menu .menu-item-title'), item => item.textContent);`);
    await cdp.realKey('Escape');
    await wait(200);
    return titles;
  });
  check(Array.isArray(menu) && menu.includes('Edit text') && menu.includes('Add child') && menu.includes('Delete branch'), `node menu: ${JSON.stringify(menu)}`);
  check(!(menu ?? []).some(text => JAPANESE.test(text)), `Japanese in the node menu: ${JSON.stringify(menu)}`);

  const settings = await step('settings-en', () => evaluate(`app.setting.open(); app.setting.openTabById('mappy');
    await new Promise(resolve => setTimeout(resolve, 300));
    const tab = app.setting.activeTab;
    const names = Array.from(tab.containerEl.querySelectorAll('.setting-item-name'), item => item.textContent);
    const descriptions = Array.from(tab.containerEl.querySelectorAll('.setting-item-description'), item => item.textContent);
    const options = Array.from(tab.containerEl.querySelectorAll('select option'), item => item.textContent);
    app.setting.close();
    return { names, descriptions, options };`));
  check(SETTINGS.every(name => settings?.names?.includes(name)), `settings names: ${JSON.stringify(settings?.names)}`);
  check(settings?.options?.includes('Follow Obsidian') && settings?.options?.includes('Mind map'), `settings options: ${JSON.stringify(settings?.options)}`);
  const settingsJapanese = [...(settings?.names ?? []), ...(settings?.descriptions ?? []), ...(settings?.options ?? [])].filter(text => JAPANESE.test(text));
  check(settingsJapanese.length === 0, `Japanese in the settings tab: ${JSON.stringify(settingsJapanese)}`);

  // Markdown written in the app's language: Tab adds a child under its provisional name, Enter keeps it.
  const added = await step('add-en', async () => {
    await select('Booking');
    await cdp.realKey('Tab');
    await wait(500);
    await cdp.realKey('Enter', 0, '\r');
    await wait(800);
    return evaluate(`${VIEW} return await source();`);
  });
  check(typeof added === 'string' && added.includes('- Booking\n  - Subtopic\n'), `the added child is not written as Subtopic: ${JSON.stringify(added)}`);

  // core's reason, in English, on the draft's error line.
  const refused = await step('refuse-en', async () => {
    await select('Clothes');
    await cdp.realKey('F2');
    await wait(300);
    await evaluate(`${VIEW} const box = input(); box.value = '[ ] Clothes'; box.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    await cdp.realKey('Enter', 0, '\r');
    await wait(500);
    const line = await evaluate(`${VIEW} return el.querySelector('.mappy-inline-error')?.textContent ?? null;`);
    await cdp.realKey('Escape');
    await wait(300);
    return line;
  });
  check(refused === 'This name would change the heading syntax. Edit it in Markdown.', `refusal line: ${JSON.stringify(refused)}`);

  required(record, 'to-ja', await step('to-ja', () => switchTo('ja')));
  required(record, 'open-ja', await step('open-ja', makeOpenStep(evaluate, { note: NOTE, source: SOURCE })));
  const ja = required(record, 'read-ja', await step('read-ja', () => evaluate(READ)));
  check(JSON.stringify(ja.layouts) === JSON.stringify(['通常マップ', 'タイムライン', '階層図', '左右バランス']), `layout buttons back in Japanese: ${JSON.stringify(ja.layouts)}`);
  check(ja.commands['mappy:create-mindmap'] === 'Mappy: 新しいマインドマップを作成', `command back in Japanese: ${ja.commands['mappy:create-mindmap']}`);
  const addedJa = await step('add-ja', async () => {
    await makeSelect(cdp, evaluate)('Booking');
    await cdp.realKey('Tab');
    await wait(500);
    await cdp.realKey('Enter', 0, '\r');
    await wait(800);
    if (value('--shot')) await cdp.screenshot(`${value('--shot').replace(/\.png$/u, '')}-ja.png`);
    return evaluate(`${VIEW} return await source();`);
  });
  check(typeof addedJa === 'string' && addedJa.includes('- Booking\n  - サブトピック\n'), `the added child is not written as サブトピック: ${JSON.stringify(addedJa)}`);
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`unexpected: ${error}`);
} finally {
  // Whatever happened, the test Obsidian goes back to Japanese: every other case refuses a window in another language.
  const language = await cdp.evaluate(`localStorage.getItem('language') || 'en'`).catch(() => null);
  if (language !== 'ja') await step('restore-ja', () => switchTo('ja'));
  await evaluate('app.workspace.getLeavesOfType("mappy-map").forEach(leaf => leaf.detach()); return true;').catch(() => null);
  if (!flag('--keep')) await step('clean', clean);
  exitCode = await finish(record, value('--json'));
  cdp.close();
}
process.exit(exitCode);
