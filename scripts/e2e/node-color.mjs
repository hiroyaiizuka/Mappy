/**
 * E91 (docs/harness.md): the colour of a node (LEV-364, the person's decision of 2026-10-19: the node's text wrapped in
 * `<mark style="background: …;">`, Highlightr's six colours). Rows are the person's operations × the node's shape:
 *
 * - operations: the context menu's 色 (a real click on 色 and on the colour in the menu that opens), the commands
 *   (`executeCommandById`, as the palette and a hotkey run them), changing a colour, 色なし, ⌘Z／⌘⇧Z (real keys), renaming a
 *   coloured node (real F2, `Input.insertText`, real Enter), the colour written by hand in Markdown (`vault.modify`:
 *   `<mark style>`, `==…==`, a mark over part of the text), and a colour chosen while the inline editor composes Japanese
 *   (`Input.imeSetComposition`; not the OS's IME);
 * - shapes: a list item, the body root, a free topic, an item with a link, an item with an image, the second of two
 *   same-named items, an empty node, and in a heading note an ATX and a one-line Setext heading.
 *
 * Then where the colour has to reach and what it must not break: the box's fill and the text's contrast on it in the
 * light and the dark theme (Obsidian's, and the map's own setting both ways), the selection's outline outside the box,
 * Obsidian's own heading match for a heading coloured in a note that is not a map (recorded: Obsidian finds no
 * `#heading` there), the embed of a map's coloured `#heading` (M10, reading view), a link to it (`openLinkText`), the
 * `mappy-topics` entry of a coloured topic (the key follows, the topic stays where it was), a map calling a coloured
 * heading and a coloured calling item (M12), a Canvas card (M10), the SVG export (M13), Excalidraw's "Insert image"
 * painter and Mappy's own insert into a drawing (M6), and that reading never writes the note. Page errors are counted.
 *
 * Menus: macOS shows Obsidian's menus natively, outside the page; the vault's `nativeMenus` is turned off for the run
 * and put back, and the context menu is a synthesized `contextmenu` (CDP's right button opens none), as E76 does.
 *
 * Usage: npm run harness:e2e:node-color -- [--reload] [--json <out.json>] [--shot <out.png>] [--keep]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required, until } from './case-runner.mjs';
import { VIEW, makeAfter, makeHistory, makeMarkSeen, makePluginStep, makePress, makeSelect, refuseOpenLeaves, writeNote } from './dom-helpers.mjs';
import { COLOR, ERRORS, makeAppTheme } from './window-helpers.mjs';

const { flag, value } = parseArgs();

const FOLDER = 'Fixtures/E2E-color';
const NOTE = `${FOLDER}/色のマップ.md`;
const HEADINGS_NOTE = `${FOLDER}/色の見出し.md`;
const PLAIN = `${FOLDER}/色のふつう.md`;
const HOST = `${FOLDER}/色のホスト.md`;
const CALLER = `${FOLDER}/色の呼び出し.md`;
const CANVAS = `${FOLDER}/色のボード.canvas`;
const DRAWING = `${FOLDER}/色の図面.excalidraw.md`;

const VALUE = { yellow: '#FFF3A3A6', orange: '#FFB86CA6', red: '#FF5582A6', green: '#BBFABBA6', blue: '#ADCCFFA6', purple: '#D2B3FFA6' };
const LABEL = { yellow: '黄色', orange: 'オレンジ', red: '赤', green: '緑', blue: '青', purple: '紫' };
/** What the light theme shows for each: the value as written, its alpha over the white page. */
const LIGHT = { yellow: [255, 247, 195], orange: [255, 209, 159], red: [255, 144, 174], green: [211, 252, 211], blue: [202, 222, 255], purple: [226, 206, 255] };
const DARK = { yellow: [107, 93, 18], orange: [110, 67, 25], red: [108, 38, 54], green: [36, 87, 42], blue: [36, 63, 110], purple: [70, 48, 110] };
const mark = color => `<mark style="background: ${VALUE[color]};">`;

const SOURCE = [
  '---', 'mappy: true', 'mappy-topics:', '  トピック: { mindmap: [420, 60] }', '---',
  '## 旅の計画', '',
  '- 温泉旅行', '  - [[宿]] を予約', '- 写真 ![[sample-image.svg]]', '- 同じ', '- 同じ', '- ', '- 手書き', '',
  '## トピック', '', '- 下の枝', '',
].join('\n');
const HEADINGS = ['---', 'mappy: true', '---', '# 計画', '', '## 見出しの枝', '', '本文', '', '下線の枝', '---', ''].join('\n');
const PLAIN_SOURCE = ['## 旅の計画', '', '本文', ''].join('\n');
const HOST_SOURCE = [
  '![[色のふつう#旅の計画]]', '', '![[色のマップ#旅の計画]]', '', '[[色のマップ#トピック]]', '',
].join('\n');
const CALLER_SOURCE = (calling) => ['---', 'mappy: true', '---', '## 呼び出し', '', '- ![[色のマップ#旅の計画]]', `- ${calling}`, ''].join('\n');

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const after = makeAfter(evaluate);
const history = makeHistory(cdp, evaluate);
const press = makePress(cdp, evaluate);
const appTheme = makeAppTheme(evaluate);
const markSeen = makeMarkSeen(evaluate);

const source = () => evaluate(`${VIEW} return await source();`);

/**
 * Script, after VIEW and COLOR: `fillOf(node)` — the node's own fill as the page composites it, its text's contrast on
 * it, the element's `data-mappy-color`, the label as drawn, and the selection's outline (style and offset).
 */
const FILL = `const fillOf = node => {
    const style = getComputedStyle(node);
    const back = backdrop(node);
    const text = onto(rgba(getComputedStyle(node.querySelector('.mappy-node-content') ?? node).color), back);
    return { color: node.dataset.mappyColor ?? null, background: style.backgroundColor, fill: back.slice(0, 3), ratio: contrast(text, back),
      label: node.querySelector('.mappy-node-label')?.textContent ?? null, marks: node.querySelectorAll('.mappy-node-label mark').length,
      outline: { style: style.outlineStyle, offset: parseFloat(style.outlineOffset) } };
  };`;

/** The map's view of node `title` (#index): its fill and what it shows. */
const nodeFill = (title, index = 0) => evaluate(`${VIEW} ${COLOR} ${FILL}
  const node = nth(${JSON.stringify(title)}, ${index});
  if (!node) throw new Error('No node ' + ${JSON.stringify(title)});
  return fillOf(node);`);

/** A colour channel triple within 2 of `want` (the page's own compositing rounds). */
const near = (got, want) => Array.isArray(got) && got.every((channel, at) => Math.abs(channel - want[at]) <= 2);

/** The titles of Obsidian's menu on screen now, and the checked one. */
const menuState = () => evaluate(`const items = Array.from(document.querySelectorAll('.menu .menu-item'));
  return { titles: items.map(item => item.querySelector('.menu-item-title')?.textContent ?? ''),
    checked: items.filter(item => item.classList.contains('mod-checked') || item.classList.contains('is-checked') || item.querySelector('.menu-item-icon svg.lucide-check, .mod-checked')).map(item => item.querySelector('.menu-item-title')?.textContent ?? '') };`);

/** A real click on the menu item titled `title` in the menu on screen. */
const chooseMenu = title => press(`const node = Array.from(document.querySelectorAll('.menu .menu-item')).find(item => item.querySelector('.menu-item-title')?.textContent === ${JSON.stringify(title)});`);

/**
 * Right-click on node `title` (#index) → 色 → the colour (its label, or 色なし). Returns the colour menu's titles and
 * checked item as it opened, and what the map shows once the write has landed.
 */
async function colorFromMenu(title, label, index = 0) {
  await select(title, index);
  await evaluate(`${VIEW}
    const node = nth(${JSON.stringify(title)}, ${index}); const rect = node.getBoundingClientRect();
    node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.left + 4, clientY: rect.top + 4 }));
    return true;`);
  await until(async () => (await menuState()).titles.includes('色'), 3000, 'the context menu has no 色');
  await chooseMenu('色');
  const menu = await until(async () => { const state = await menuState(); return state.titles.includes('色なし') ? state : null; }, 3000, '色 opened no colour menu');
  const before = await source();
  await chooseMenu(label);
  const result = await after(before);
  return { menu, ...result };
}

/** Runs a Mappy command by id with the map active, then what the map shows once the write has landed (or not). */
async function command(id, timeout) {
  const before = await source();
  const ran = await evaluate(`app.workspace.setActiveLeaf(window.__mappyE2E, { focus: false }); return app.commands.executeCommandById(${JSON.stringify(id)});`);
  return { ran, ...await after(before, timeout) };
}

/** Opens `note` as a map in a new tab (the case's own) in place of the map the case had open, and records it as the view under test. */
const openMap = (note, text) => evaluate(`window.__mappyE2E?.detach();
  ${refuseOpenLeaves([note])}
  ${writeNote(note, text)}
  const opened = app.workspace.getLeaf('tab');
  await opened.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(note)}, layout: 'mindmap' }, active: true });
  await new Promise(resolve => setTimeout(resolve, 1500));
  app.workspace.setActiveLeaf(opened, { focus: true });
  window.__mappyE2E = opened;
  ${VIEW}
  return { labels: nodes().map(label) };`);

/** Writes `text` over the note under test from outside the map (a sync, another editor) and waits for the map to read it. */
async function writeOutside(text) {
  const before = await source();
  await evaluate(`${VIEW} await app.vault.modify(view.file, ${JSON.stringify(text)}); return true;`);
  return after(before);
}

const mtime = path => evaluate(`const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)}); return file ? { mtime: file.stat.mtime, text: await app.vault.read(file) } : null;`);

let expected = SOURCE;
const nativeMenusBefore = await evaluate(`return app.vault.getConfig('nativeMenus');`);
const appThemeBefore = await evaluate(`return app.vault.getConfig('theme') ?? null;`);

try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  required(record, 'setup', await step('setup', () => evaluate(`
    ${ERRORS}
    window.__mappyE2EErrors.length = 0;
    ${refuseOpenLeaves([NOTE, HEADINGS_NOTE, PLAIN, HOST, CALLER, CANVAS, DRAWING], ['markdown', 'mappy-map', 'canvas', 'excalidraw'])}
    if (!app.vault.getAbstractFileByPath(${JSON.stringify(FOLDER)})) await app.vault.createFolder(${JSON.stringify(FOLDER)});
    if (!app.vault.getAbstractFileByPath('Fixtures/sample-image.svg')) throw new Error('Fixtures/sample-image.svg is missing (npm run harness:prepare)');
    app.vault.setConfig('nativeMenus', false);
    return { obsidian: require('electron').ipcRenderer.sendSync('version'), mappy: app.plugins.plugins.mappy.manifest.version,
      excalidraw: app.plugins.plugins['obsidian-excalidraw-plugin']?.manifest?.version ?? null };`)));
  // The image item names `sample-image.svg`, which resolves to the fixture's by its name (shortest path). A notice left on
  // screen by whatever ran before is not this run's to report.
  await markSeen();

  await appTheme('light');
  required(record, 'open', await step('open', () => openMap(NOTE, SOURCE)));

  // Right-click → 色 → a colour, on each shape of the list note; only that node's text range changes.
  const shapes = [
    { id: 'list-item', title: '温泉旅行', color: 'blue', line: ['- 温泉旅行', `- ${mark('blue')}温泉旅行</mark>`] },
    { id: 'root', title: '旅の計画', color: 'purple', line: ['## 旅の計画', `## ${mark('purple')}旅の計画</mark>`] },
    { id: 'link', title: '[[宿]] を予約', color: 'green', line: ['  - [[宿]] を予約', `  - ${mark('green')}[[宿]] を予約</mark>`] },
    { id: 'image', title: '写真 ![[sample-image.svg]]', color: 'orange', line: ['- 写真 ![[sample-image.svg]]', `- ${mark('orange')}写真 ![[sample-image.svg]]</mark>`] },
    { id: 'same-name-2nd', title: '同じ', index: 1, color: 'red', line: ['- 同じ\n- 同じ\n', `- 同じ\n- ${mark('red')}同じ</mark>\n`] },
    { id: 'empty', title: '空のノード', color: 'yellow', line: ['- \n', `- ${mark('yellow')}</mark>\n`] },
    { id: 'topic', title: 'トピック', color: 'yellow', topic: true },
  ];
  for (const shape of shapes) {
    await step(`menu-${shape.id}`, async () => {
      const position = shape.topic ? await evaluate(`${VIEW}
        const root = nodes().find(node => node.classList.contains('is-root') && !node.classList.contains('is-topic'));
        const topic = nth('トピック', 0); const a = root.getBoundingClientRect(); const b = topic.getBoundingClientRect();
        return { dx: Math.round(b.left - a.left), dy: Math.round(b.top - a.top) };`) : null;
      const result = await colorFromMenu(shape.title, LABEL[shape.color], shape.index ?? 0);
      check(JSON.stringify(result.menu.titles) === JSON.stringify(['色なし', ...Object.values(LABEL)]), `${shape.id}: colour menu ${JSON.stringify(result.menu.titles)}`);
      check(result.messages.length === 0, `${shape.id}: ${JSON.stringify(result.messages)}`);
      // A topic's `mappy-topics` key is its heading as written: it follows the colour in the same edit set.
      if (shape.topic) {
        expected = expected.replace('  トピック: { mindmap: [420, 60] }', `  "${mark('yellow').replace(/"/gu, '\\"')}トピック</mark>": { mindmap: [420, 60] }`)
          .replace('## トピック', `## ${mark('yellow')}トピック</mark>`);
      } else expected = expected.replace(shape.line[0], shape.line[1]);
      check(result.source === expected, `${shape.id}: source\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(result.source)}`);
      const fill = await nodeFill(shape.title, shape.index ?? 0);
      check(fill.color === shape.color, `${shape.id}: data-mappy-color ${fill.color}`);
      check(near(fill.fill, LIGHT[shape.color]), `${shape.id}: fill ${JSON.stringify(fill.fill)} (${fill.background})`);
      check(fill.ratio >= 4.5, `${shape.id}: text contrast ${fill.ratio}`);
      check(fill.marks === 0 && !(fill.label ?? '').includes('<mark'), `${shape.id}: the label shows the mark (${fill.label})`);
      check(fill.outline.style !== 'none' && fill.outline.offset >= 0, `${shape.id}: selection outline ${JSON.stringify(fill.outline)}`);
      let moved = null;
      if (shape.topic) {
        const metadata = await evaluate(`${VIEW} return app.metadataCache.getFileCache(view.file)?.frontmatter?.['mappy-topics'] ?? null;`);
        const now = await evaluate(`${VIEW}
          const root = nodes().find(node => node.classList.contains('is-root') && !node.classList.contains('is-topic'));
          const topic = nth('トピック', 0); const a = root.getBoundingClientRect(); const b = topic.getBoundingClientRect();
          return { dx: Math.round(b.left - a.left), dy: Math.round(b.top - a.top) };`);
        moved = { before: position, after: now, metadata };
        check(Math.abs(now.dx - position.dx) <= 1 && Math.abs(now.dy - position.dy) <= 1, `topic moved: ${JSON.stringify(moved)}`);
        check(metadata?.[`${mark('yellow')}トピック</mark>`]?.mindmap?.join() === '420,60' && Object.keys(metadata).length === 1, `metadataCache mappy-topics ${JSON.stringify(metadata)}`);
      }
      // A link on a colour takes the text's colour (Obsidian's underline marks it), readable on every fill.
      let link = null;
      if (shape.id === 'link') {
        link = await evaluate(`${VIEW} ${COLOR}
          const node = nth(${JSON.stringify(shape.title)}, 0); const anchor = node.querySelector('.mappy-node-label a');
          const back = backdrop(node);
          return { ratio: contrast(onto(rgba(getComputedStyle(anchor).color), back), back), underline: getComputedStyle(anchor).textDecorationLine };`);
        check(link.ratio >= 4.5, `link contrast ${JSON.stringify(link)}`);
      }
      return { menu: result.menu, fill, moved, link };
    });
  }

  await step('change-and-none', async () => {
    const changed = await colorFromMenu('温泉旅行', '赤');
    check(changed.menu.checked.join() === '青' || changed.menu.checked.length === 0, `checked ${JSON.stringify(changed.menu.checked)}`);
    expected = expected.replace(`- ${mark('blue')}温泉旅行</mark>`, `- ${mark('red')}温泉旅行</mark>`);
    check(changed.source === expected, `change: ${JSON.stringify(changed.source)}`);
    const none = await colorFromMenu('温泉旅行', '色なし');
    expected = expected.replace(`- ${mark('red')}温泉旅行</mark>`, '- 温泉旅行');
    check(none.source === expected, `none: ${JSON.stringify(none.source)}`);
    const fill = await nodeFill('温泉旅行');
    check(fill.color === null, `none left ${fill.color}`);
    return { checked: changed.menu.checked, after: fill };
  });

  await step('undo-redo', async () => {
    const undone = await history('undo');
    const red = expected.replace('- 温泉旅行', `- ${mark('red')}温泉旅行</mark>`);
    check(undone.source === red, `⌘Z: ${JSON.stringify(undone.source)}`);
    const undone2 = await history('undo');
    check(undone2.source === expected.replace('- 温泉旅行', `- ${mark('blue')}温泉旅行</mark>`), `⌘Z ×2: ${JSON.stringify(undone2.source)}`);
    const redone = await history('redo');
    check(redone.source === red, `⌘⇧Z: ${JSON.stringify(redone.source)}`);
    check((await nodeFill('温泉旅行')).color === 'red', 'the map does not show the redone colour');
    expected = red;
    return { messages: [...undone.messages, ...undone2.messages, ...redone.messages] };
  });

  await step('commands', async () => {
    const listed = await evaluate(`return Object.values(app.commands.commands).filter(item => /^mappy:color-/u.test(item.id)).map(item => [item.id, item.name]);`);
    check(listed.length === 7, `commands ${JSON.stringify(listed)}`);
    await select('手書き');
    const green = await command('mappy:color-green');
    expected = expected.replace('- 手書き', `- ${mark('green')}手書き</mark>`);
    check(green.ran === true && green.source === expected, `color-green: ${JSON.stringify(green.source)}`);
    const none = await command('mappy:color-none');
    expected = expected.replace(`- ${mark('green')}手書き</mark>`, '- 手書き');
    check(none.source === expected, `color-none: ${JSON.stringify(none.source)}`);
    // The colour it already has: no write.
    await select('温泉旅行');
    const same = await command('mappy:color-red', 1200);
    check(same.source === expected && same.messages.length === 0, `the same colour wrote: ${JSON.stringify(same.source)}`);
    return { listed, messages: [...green.messages, ...none.messages, ...same.messages] };
  });

  await step('rename-colored', async () => {
    await select('温泉旅行');
    await cdp.realKey('F2');
    const draft = await until(() => evaluate(`${VIEW} return input()?.value ?? null;`), 3000, 'F2 opened no draft');
    check(draft === '温泉旅行', `the draft holds ${JSON.stringify(draft)}`);
    await cdp.insertText('温泉旅行（箱根）');
    await wait(200);
    const before = await source();
    await cdp.realKey('Enter');
    const result = await after(before);
    expected = expected.replace(`- ${mark('red')}温泉旅行</mark>`, `- ${mark('red')}温泉旅行（箱根）</mark>`);
    check(result.source === expected, `rename: ${JSON.stringify(result.source)}`);
    check(!result.editing && result.messages.length === 0, `rename: ${JSON.stringify(result.messages)}`);
    check((await nodeFill('温泉旅行（箱根）')).color === 'red', 'the renamed node lost its colour');
    return { draft, messages: result.messages };
  });

  await step('ime-composing', async () => {
    await select('手書き');
    await cdp.realKey('F2');
    await until(() => evaluate(`${VIEW} return input() ? true : null;`), 3000, 'F2 opened no draft');
    await cdp.send('Input.imeSetComposition', { text: 'てがき', selectionStart: 3, selectionEnd: 3 });
    await wait(300);
    const composing = await evaluate(`${VIEW} return input()?.value ?? null;`);
    const before = await source();
    const ran = await evaluate(`return app.commands.executeCommandById('mappy:color-yellow');`);
    const result = await after(before, 3000);
    // Whatever stands in the draft when the colour is chosen is saved first, then coloured: no text is lost.
    const want = expected.replace('- 手書き', `- ${mark('yellow')}${composing}</mark>`);
    check(result.source === want, `ime: ${JSON.stringify(result.source)} (draft ${JSON.stringify(composing)})`);
    check(!result.editing, 'the draft stayed open');
    if (result.editing) { await cdp.send('Input.imeCommitComposition', {}).catch(() => undefined); await cdp.realKey('Escape'); }
    expected = result.source;
    return { composing, ran, editing: result.editing, messages: result.messages };
  });

  await step('markdown-by-hand', async () => {
    const written = expected
      .replace(`- ${mark('orange')}写真 ![[sample-image.svg]]</mark>`, `- 前半 <mark>後半</mark> ${mark('orange')}写真 ![[sample-image.svg]]</mark>`)
      .replace('- 下の枝', '- ==下の枝==');
    if (written === expected) throw new Error('nothing to write by hand: ' + JSON.stringify(expected));
    const result = await writeOutside(written);
    check(result.source === written, 'the map rewrote what it read');
    const highlight = await nodeFill('下の枝');
    check(highlight.color === 'yellow' && near(highlight.fill, LIGHT.yellow), `==highlight== ${JSON.stringify(highlight)}`);
    const partial = await nodeFill('前半 <mark>後半</mark> <mark style="background: #FFB86CA6;">写真 ![[sample-image.svg]]</mark>');
    check(partial.color === null && partial.marks >= 1, `a mark over part of the text: ${JSON.stringify(partial)}`);
    expected = written;
    return { highlight, partial };
  });

  if (value('--shot')) await step('shot', async () => ({ path: await cdp.screenshot(value('--shot')) }));

  await step('themes', async () => {
    const read = () => nodeFill('温泉旅行（箱根）');
    const setMap = theme => evaluate(`window.__mappyE2E.view.setTheme(${JSON.stringify(theme)}); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true;`);
    const rows = {};
    await appTheme('dark');
    rows.appDark = await read();
    await setMap('light');
    rows.appDarkMapLight = await read();
    await setMap('follow');
    await appTheme('light');
    rows.appLight = await read();
    await setMap('dark');
    rows.appLightMapDark = await read();
    await setMap(await evaluate('return app.plugins.plugins.mappy.settings.theme;'));
    check(near(rows.appDark.fill, DARK.red) && rows.appDark.ratio >= 4.5, `dark: ${JSON.stringify(rows.appDark)}`);
    check(near(rows.appDarkMapLight.fill, LIGHT.red) && rows.appDarkMapLight.ratio >= 4.5, `dark app, light map: ${JSON.stringify(rows.appDarkMapLight)}`);
    check(near(rows.appLight.fill, LIGHT.red) && rows.appLight.ratio >= 4.5, `light: ${JSON.stringify(rows.appLight)}`);
    check(near(rows.appLightMapDark.fill, DARK.red) && rows.appLightMapDark.ratio >= 4.5, `light app, dark map: ${JSON.stringify(rows.appLightMapDark)}`);
    return rows;
  });

  required(record, 'headings', await step('headings', async () => {
    await openMap(HEADINGS_NOTE, HEADINGS);
    await select('見出しの枝');
    const atx = await command('mappy:color-blue');
    let want = HEADINGS.replace('## 見出しの枝', `## ${mark('blue')}見出しの枝</mark>`);
    check(atx.source === want, `ATX: ${JSON.stringify(atx.source)}`);
    await select('下線の枝');
    const setext = await command('mappy:color-green');
    want = want.replace('\n下線の枝\n---', `\n${mark('green')}下線の枝</mark>\n---`);
    check(setext.source === want, `Setext: ${JSON.stringify(setext.source)}`);
    const fills = [await nodeFill('見出しの枝'), await nodeFill('下線の枝')];
    check(fills[0].color === 'blue' && fills[1].color === 'green', `fills ${JSON.stringify(fills)}`);
    return { fills };
  }));

  // What the colour does to the links to a heading. Obsidian's own: a note that is not a map, embedded in a host.
  await step('obsidian-heading-match', () => evaluate(`
    { ${writeNote(PLAIN, PLAIN_SOURCE.replace('## 旅の計画', `## ${mark('purple')}旅の計画</mark>`))} }
    { ${writeNote(HOST, HOST_SOURCE)} }
    const headings = app.metadataCache.getFileCache(app.vault.getAbstractFileByPath(${JSON.stringify(PLAIN)}))?.headings?.map(item => item.heading) ?? [];
    const before = await app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}));
    const mtimeBefore = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}).stat.mtime;
    const leaf = app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: 'markdown', state: { file: ${JSON.stringify(HOST)}, mode: 'preview' }, active: true });
    let frames = [];
    for (let tries = 0; tries < 40 && frames.length < 1; tries += 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
      frames = Array.from(leaf.view.containerEl.querySelectorAll('.markdown-preview-view .mappy-embed'));
    }
    await new Promise(resolve => setTimeout(resolve, 800));
    let plainEmbed = null;
    for (let tries = 0; tries < 40 && !/見つかりません|Unable to find|本文/u.test(plainEmbed?.textContent ?? ''); tries += 1) {
      plainEmbed = leaf.view.containerEl.querySelector('.markdown-preview-view .internal-embed[src="色のふつう#旅の計画"]');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const frame = frames[0];
    const shown = frame ? Array.from(frame.querySelectorAll('.mappy-node')).map(node => ({ name: node.querySelector('.mappy-node-name')?.textContent, color: node.dataset.mappyColor ?? null })) : null;
    const message = frame?.querySelector('.mappy-embed-message:not([hidden])')?.textContent ?? null;
    // Read before the tab closes: closing it empties the embed.
    const obsidianEmbed = plainEmbed?.textContent.replace(/\\s+/g, ' ').slice(0, 160) ?? null;
    leaf.detach();
    const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
    const unchanged = (await app.vault.read(file)) === before && file.stat.mtime === mtimeBefore;
    return { headings, obsidianEmbed, mapEmbed: shown, message, unchanged };`).then(result => {
    // Obsidian finds no `#旅の計画` under the coloured heading (its rule reads the tag as words); the map's embed still does.
    check(/見つかりません|Unable to find/u.test(result.obsidianEmbed ?? ''), `Obsidian's own embed: ${JSON.stringify(result.obsidianEmbed)}`);
    check(result.mapEmbed?.[0]?.name === '旅の計画' && result.mapEmbed[0].color === 'purple' && result.message === null, `map embed: ${JSON.stringify(result)}`);
    check(result.unchanged, 'reading the host wrote the map note');
    return result;
  }));

  await step('link-to-colored-heading', async () => {
    const result = await evaluate(`
      // The case's own map stays open meanwhile: with no tab left, Obsidian 1.14.4 finds no tab group to open a tab in.
      const before = new Set();
      app.workspace.iterateAllLeaves(item => { before.add(item); });
      await app.workspace.openLinkText('色のマップ#トピック', ${JSON.stringify(HOST)}, 'tab');
      await new Promise(resolve => setTimeout(resolve, 1500));
      let leaf = null;
      app.workspace.iterateAllLeaves(item => { if (!before.has(item) && item.view?.file?.path === ${JSON.stringify(NOTE)}) leaf = item; });
      if (!leaf) throw new Error('the link opened no new tab on the map note');
      const view = leaf.view;
      const selected = view.contentEl.querySelector('.mappy-node.is-selected .mappy-node-name')?.textContent ?? null;
      const type = view.getViewType();
      leaf.detach();
      return { type, selected };`);
    check(result.type === 'mappy-map' && result.selected === 'トピック', `link: ${JSON.stringify(result)}`);
    return result;
  });

  await step('calls', async () => {
    const calling = `${mark('blue')}![[色のマップ]]</mark>`;
    await openMap(CALLER, CALLER_SOURCE(calling));
    await wait(800);
    const shown = await evaluate(`${VIEW} ${COLOR} ${FILL}
      return nodes().map(node => ({ name: label(node), color: node.dataset.mappyColor ?? null, called: node.classList.contains('is-called'), callRoot: node.classList.contains('is-called-root') }));`);
    // The uncoloured item shows the coloured heading it calls without its colour (the item's own, none); the coloured item its own.
    const heading = shown.find(item => item.callRoot && item.name === '旅の計画' && item.color === null);
    const colored = shown.find(item => item.callRoot && item.color === 'blue');
    check(heading !== undefined, `the call of the coloured heading: ${JSON.stringify(shown)}`);
    check(colored !== undefined, `the coloured calling item: ${JSON.stringify(shown)}`);
    check(shown.some(item => item.called && !item.callRoot && item.name.includes('温泉旅行')), `no called branch: ${JSON.stringify(shown)}`);
    await evaluate(`window.__mappyE2E.detach(); return true;`);
    return { shown };
  });

  await step('canvas-card', async () => {
    const before = await mtime(NOTE);
    const result = await evaluate(`
      ${writeNote(CANVAS, JSON.stringify({ nodes: [{ id: 'card', type: 'file', file: NOTE, x: 0, y: 0, width: 760, height: 460 }], edges: [] }))}
      const leaf = app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: 'canvas', state: { file: ${JSON.stringify(CANVAS)} }, active: true });
      let shown = [];
      for (let tries = 0; tries < 40 && shown.length === 0; tries += 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
        shown = Array.from(leaf.view.containerEl.querySelectorAll('.canvas-node .mappy-embed .mappy-node')).map(node => ({ name: node.querySelector('.mappy-node-name')?.textContent, color: node.dataset.mappyColor ?? null }));
      }
      leaf.detach();
      return { shown };`);
    const now = await mtime(NOTE);
    check(result.shown.some(item => item.name === '旅の計画' && item.color === 'purple'), `canvas card: ${JSON.stringify(result.shown)}`);
    check(now.mtime === before.mtime && now.text === before.text, 'the canvas card wrote the note');
    return result;
  });

  required(record, 'reopen', await step('reopen', () => openMap(NOTE, expected)));
  await step('export-svg', async () => {
    const before = await mtime(NOTE);
    const result = await evaluate(`${VIEW}
      const exported = await view.exportImage('svg');
      const file = app.vault.getAbstractFileByPath(exported.path);
      const text = await app.vault.read(file);
      await app.vault.delete(file);
      // A mark over part of a text is drawn as Obsidian draws it (a <mark> element); a node's own colour is its box's, never its text.
      return { path: exported.path, red: text.includes('rgba(255, 85, 130, 0.65)'), purple: text.includes('rgba(210, 179, 255, 0.65)'), mark: text.includes('&lt;mark') || text.includes('mark style=') };`);
    const now = await mtime(NOTE);
    check(result.red && result.purple, `the SVG lacks the fills: ${JSON.stringify(result)}`);
    check(!result.mark, 'the SVG shows a node colour\'s mark as text or as a styled element');
    check(now.mtime === before.mtime && now.text === before.text, 'the export wrote the note');
    return result;
  });

  await step('excalidraw', async () => {
    const before = await mtime(NOTE);
    const result = await evaluate(`
      const mappy = app.plugins.plugins.mappy;
      const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
      // Excalidraw's "Insert image" draws the map with this painter (E27 drags the note for real).
      const painted = await mappy.bridge.paint(file, { svg: true });
      const svg = painted.svg ?? '';
      if (!window.ExcalidrawAutomate) return { svgRed: svg.includes('rgba(255, 85, 130, 0.65)'), excalidraw: false };
      const old = app.vault.getAbstractFileByPath(${JSON.stringify(DRAWING)});
      if (old) await app.vault.delete(old, true);
      const ea = window.ExcalidrawAutomate;
      ea.reset();
      const created = await ea.create({ filename: ${JSON.stringify(DRAWING.slice(DRAWING.lastIndexOf('/') + 1).replace(/\.excalidraw\.md$/u, ''))}, foldername: ${JSON.stringify(FOLDER)}, onNewPane: true });
      let leaf = null;
      for (let tries = 0; tries < 50 && !leaf?.view?.excalidrawAPI; tries += 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
        leaf = app.workspace.getLeavesOfType('excalidraw').find(item => item.view.file?.path === created) ?? null;
      }
      if (!leaf?.view?.excalidrawAPI) throw new Error('the drawing did not open');
      app.workspace.setActiveLeaf(leaf, { focus: true });
      await new Promise(resolve => setTimeout(resolve, 500));
      await mappy.bridge.insertIntoActiveDrawing({ file, mode: 'mindmap', collapsed: new Set() });
      await new Promise(resolve => setTimeout(resolve, 1000));
      const elements = leaf.view.excalidrawAPI.getSceneElements();
      const texts = elements.filter(element => element.type === 'text');
      const fills = texts.map(text => ({ text: text.text, fill: elements.find(element => element.id === text.containerId)?.backgroundColor ?? null }));
      // Saved and closed before the file goes: Excalidraw saving a drawing whose file was deleted under it warns of a lost save.
      await leaf.view.save?.();
      leaf.detach();
      await new Promise(resolve => setTimeout(resolve, 1500));
      await app.vault.delete(app.vault.getAbstractFileByPath(created), true);
      await new Promise(resolve => setTimeout(resolve, 1500));
      const notices = Array.from(document.querySelectorAll('.notice:not([data-mappy-e2e-seen])'), item => item.textContent.trim());
      return { svgRed: svg.includes('rgba(255, 85, 130, 0.65)'), excalidraw: true, fills, notices };`);
    const now = await mtime(NOTE);
    check(result.svgRed, 'the painter\'s SVG lacks the red fill');
    if (result.excalidraw) {
      const fill = text => result.fills.find(item => item.text === text)?.fill ?? null;
      check(fill('旅の計画') === '#e2ceff', `root fill ${fill('旅の計画')}`);
      check(fill('温泉旅行（箱根）') === '#ff90ae', `branch fill ${fill('温泉旅行（箱根）')}`);
      check(fill('同じ') === null || result.fills.filter(item => item.text === '同じ').some(item => item.fill === null), `the uncoloured 同じ: ${JSON.stringify(result.fills)}`);
    } else check(false, 'Excalidraw is not loaded in this vault');
    check(now.mtime === before.mtime && now.text === before.text, 'the inserts wrote the note');
    check((result.notices ?? []).length === 0, `notices: ${JSON.stringify(result.notices)}`);
    return result;
  });

  await step('page-errors', () => evaluate(`return window.__mappyE2EErrors.slice();`).then(errors => {
    check(errors.length === 0, `page errors: ${JSON.stringify(errors)}`);
    return { errors };
  }));

  if (!flag('--keep')) {
    await step('clean', () => evaluate(`
      for (const leaf of app.workspace.getLeavesOfType('mappy-map')) if (${JSON.stringify([NOTE, HEADINGS_NOTE, CALLER])}.includes(leaf.view.file?.path)) leaf.detach();
      delete window.__mappyE2E;
      const removed = [];
      for (const path of ${JSON.stringify([NOTE, HEADINGS_NOTE, PLAIN, HOST, CALLER, CANVAS])}) {
        const file = app.vault.getAbstractFileByPath(path);
        if (file) { await app.vault.delete(file); removed.push(path); }
      }
      return { removed };`));
  }
} catch (error) {
  if (!(error instanceof StopCase)) throw error;
} finally {
  await evaluate(`app.vault.setConfig('nativeMenus', ${JSON.stringify(nativeMenusBefore)}); return true;`).catch(() => undefined);
  await evaluate(`if (${JSON.stringify(appThemeBefore)} !== null) app.changeTheme(${JSON.stringify(appThemeBefore)}); return true;`).catch(() => undefined);
  cdp.close();
}

process.exit(await finish(record, value('--json')));
