/**
 * E92 (docs/harness.md): the map's right-click card (LEV-369, the person's decision of 2026-10-19「1=A」). The right-click
 * of a node opens a card of the map's own — the row of colour circles on top, 本文・リンクを編集 and 画像を追加, a line, and
 * 削除 in the error colour — in place of Obsidian's menu, which 1.14.4 on macOS draws natively (a menu of colour names).
 * Rows are the person's operations × what the card is for:
 *
 * - operations: the right-click (CDP's right press, which raises the `contextmenu` in 1.14.4's window; the event is
 *   dispatched at the same point only if it did not, and the record says which), Obsidian's 「OS のメニュー」 on and off,
 *   a real click on a circle and on a row, the card's keys (real ←→↑↓, Tab, Home, End, Enter, Space, Escape), a real
 *   click outside, a real wheel and ⌘-wheel over the map, another tab made active, the window's blur (a dispatched
 *   `blur`: the case moves no OS window), and the menu key and Shift+F10 on a focused node (recorded: 1.14.4 on macOS
 *   raised a `contextmenu` for the menu key, none for Shift+F10);
 * - shapes: a list item, a free topic, the calling item and a node of the called map (M12), the empty canvas, a heading
 *   note's node, a point at the pane's corner, and the map in a popout window.
 *
 * Then: the rows taken off (テキストを編集, 子を追加, 兄弟を追加, 前へ移動, 後ろへ移動, 元に戻す, やり直す) are nowhere, and the
 * keys they went to (F2 and the double click, Tab, Enter, ⌥↓, ⌘Z／⌘⇧Z) do what they did; a colour
 * is one write and one ⌘Z; the circles look like the node fills in the light and the dark theme (Obsidian's, and the
 * map's own setting); the focus goes back to the node; opening and closing write nothing; no page error.
 *
 * Obsidian's 「OS のメニュー」 is off for the run (put back at the end) and turned on only in `native-menus`, and only once
 * `own-node` has seen the build draw its own card: a build that still opens Obsidian's menu would put an OS menu on the
 * screen of whoever uses the Mac, which no CDP key or click reaches (the first run on main's build left one open).
 *
 * Usage: npm run harness:e2e:node-menu -- [--reload] [--json <out.json>] [--shot <out.png>] [--keep]
 *   --shot  the card in the light theme at <out>.png and in the dark one at <out>-dark.png
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required, until } from './case-runner.mjs';
import { VIEW, makeAfter, makeHistory, makeMarkSeen, makePluginStep, makePress, makeSelect, refuseOpenLeaves, writeNote } from './dom-helpers.mjs';
import { COLOR, ERRORS, makeAppTheme } from './window-helpers.mjs';

const { flag, value } = parseArgs();

const FOLDER = 'Fixtures/E2E-node-menu';
const NOTE = `${FOLDER}/メニューのマップ.md`;
const CALLED = `${FOLDER}/メニューの呼び出し先.md`;
const HEADINGS_NOTE = `${FOLDER}/メニューの見出し.md`;

const SOURCE = [
  '---', 'mappy: true', 'mappy-topics:', '  トピック: { mindmap: [460, 40] }', '---',
  '## 旅の計画', '',
  '- 温泉旅行', '  - 宿を予約', '- 持ち物', '- 手書き', '- ![[メニューの呼び出し先]]', '',
  '## トピック', '', '- 下の枝', '',
].join('\n');
const CALLED_SOURCE = ['---', 'mappy: true', '---', '## 呼ばれた根', '', '- 呼ばれた枝', '  - 呼ばれた葉', ''].join('\n');
const HEADINGS = ['---', 'mappy: true', '---', '# 計画', '', '## 見出しの枝', '', '本文', ''].join('\n');

const COLORS = ['色なし', '黄色', 'オレンジ', '赤', '緑', '青', '紫'];
const NODE_ROWS = ['本文・リンクを編集', '画像を追加', '削除'];
const REMOVED = ['テキストを編集', '子を追加', '兄弟を追加', '前へ移動', '後ろへ移動', '元に戻す', 'やり直す'];
const mark = value => `<mark style="background: ${value};">`;
const BLUE = '#ADCCFFA6'; const RED = '#FF5582A6'; const YELLOW = '#FFF3A3A6'; const GREEN = '#BBFABBA6';

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const after = makeAfter(evaluate);
const history = makeHistory(cdp, evaluate);
const appTheme = makeAppTheme(evaluate);
const markSeen = makeMarkSeen(evaluate);
const source = () => evaluate(`${VIEW} return await source();`);

/**
 * Script, after VIEW: `card()` and `cardState()` — what the open card shows (its rows, keys, colours and the checked one,
 * the focused element's name, where it sits against the pane) and whether Obsidian's own menu is on the page as well.
 */
const CARD = `const card = () => el.ownerDocument.querySelector('.mappy-context-card');
  const nameOf = element => element?.getAttribute?.('aria-label') ?? element?.querySelector?.('.mappy-popover-title')?.textContent ?? null;
  const cardState = () => {
    const c = card();
    const focused = el.ownerDocument.activeElement;
    const focus = { name: nameOf(focused), node: focused?.classList?.contains('mappy-node') ? label(focused) : null };
    if (!c) return { open: false, focus, obsidianMenu: !!el.ownerDocument.querySelector('.menu') };
    const rows = Array.from(c.querySelectorAll('.mappy-popover-item'));
    const circles = Array.from(c.querySelectorAll('.mappy-swatch'));
    const r = c.getBoundingClientRect(); const p = el.getBoundingClientRect();
    return { open: true, role: c.getAttribute('role'), label: c.getAttribute('aria-label'), inView: el.contains(c),
      rows: rows.map(nameOf), keys: rows.map(row => row.querySelector('.mappy-popover-key')?.textContent ?? null),
      shortcuts: rows.map(row => row.getAttribute('aria-keyshortcuts')), danger: rows.filter(row => row.classList.contains('mod-warning')).map(nameOf),
      swatches: circles.map(circle => circle.getAttribute('aria-label')), checked: circles.filter(circle => circle.getAttribute('aria-checked') === 'true').map(nameOf),
      swatchRoles: [...new Set(circles.map(circle => circle.getAttribute('role')))], text: c.textContent,
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, pane: { left: p.left, top: p.top, right: p.right, bottom: p.bottom },
      obsidianMenu: !!el.ownerDocument.querySelector('.menu'), focus };
  };`;

/** What the card shows now (in the window `run` evaluates in). */
const cardState = (run = evaluate) => run(`${VIEW} ${CARD} return cardState();`);

/**
 * The right-click at the point `locate` (script after VIEW, defining `node` and optionally `at`) aims at: CDP's right
 * press, which moves the focus as a person's does and raises the `contextmenu`; only if no card opened is the event
 * dispatched there (E77's probe of 2026-09-30 found none raised, with Obsidian's own menu). `viaCdp` says which.
 * `cdpOnly` stops after the press (the probe row).
 */
const makeRightClick = (connection, run) => {
  const aim = makePress(connection, run);
  return async (locate, { cdpOnly = false, point } = {}) => {
    const at = point ?? await aim(locate, { click: false });
    await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'right', buttons: 2, clickCount: 1 });
    await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'right', buttons: 0, clickCount: 1 });
    await wait(300);
    if (cdpOnly) return { at, opened: (await cardState(run)).open };
    const already = (await cardState(run)).open;
    if (!already) {
      await run(`${VIEW} const target = el.ownerDocument.elementFromPoint(${at.x}, ${at.y});
        target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: ${at.x}, clientY: ${at.y} }));
        return true;`);
      await wait(200);
    }
    return { at, viaCdp: already, state: await cardState(run) };
  };
};
const rightClick = makeRightClick(cdp, evaluate);
const onNode = (title, index = 0) => `const node = nth(${JSON.stringify(title)}, ${index});`;

/** A real click on the open card's circle named `name`, or its row titled `name`. */
const clickCard = (name, connection = cdp, run = evaluate) => makePress(connection, run)(`const node = Array.from(el.ownerDocument.querySelectorAll('.mappy-context-card .mappy-swatch, .mappy-context-card .mappy-popover-item'))
  .find(item => (item.getAttribute('aria-label') ?? item.querySelector('.mappy-popover-title')?.textContent) === ${JSON.stringify(name)});`);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** A colour channel triple within 2 of the other (the page's compositing rounds). */
const near = (a, b) => Array.isArray(a) && Array.isArray(b) && a.every((channel, at) => Math.abs(channel - b[at]) <= 2);

/** Escape on the card (a real key), and what the page shows after. */
const escape = async () => { await cdp.realKey('Escape'); await wait(200); return cardState(); };

const openMap = (note, text, extra = '') => evaluate(`window.__mappyE2E?.detach();
  ${refuseOpenLeaves([note])}
  ${writeNote(note, text)}
  ${extra}
  const opened = app.workspace.getLeaf('tab');
  await opened.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(note)}, layout: 'mindmap' }, active: true });
  await new Promise(resolve => setTimeout(resolve, 1500));
  app.workspace.setActiveLeaf(opened, { focus: true });
  window.__mappyE2E = opened;
  ${VIEW}
  return { labels: nodes().map(label) };`);

/** The vault's own value (undefined when unset, which Obsidian reads as its default): put back as it was, unset included. */
const nativeMenusBefore = await evaluate(`return app.vault.config?.nativeMenus;`);
const nativeMenusBack = nativeMenusBefore === undefined ? 'undefined' : JSON.stringify(nativeMenusBefore);
/** The delete key the card names: a Mac's delete key is Backspace (src/ui/mindmap-view.ts `deleteKey`). */
const DELETE_KEY = await evaluate(`return process.platform === 'darwin';`) ? { cap: '⌫', keys: 'Backspace Delete' } : { cap: 'Delete', keys: 'Delete Backspace' };
const appThemeBefore = await evaluate(`return app.vault.getConfig('theme') ?? null;`);
const popoutMark = `node-menu-${Date.now()}`;

try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  required(record, 'setup', await step('setup', () => evaluate(`
    ${ERRORS}
    window.__mappyE2EErrors.length = 0;
    ${refuseOpenLeaves([NOTE, CALLED, HEADINGS_NOTE])}
    if (!app.vault.getAbstractFileByPath(${JSON.stringify(FOLDER)})) await app.vault.createFolder(${JSON.stringify(FOLDER)});
    { ${writeNote(CALLED, CALLED_SOURCE)} }
    app.vault.setConfig('nativeMenus', false);
    return { obsidian: require('electron').ipcRenderer.sendSync('version'), mappy: app.plugins.plugins.mappy.manifest.version,
      platform: process.platform, nativeMenusBefore: ${JSON.stringify(nativeMenusBefore === undefined ? 'unset' : nativeMenusBefore)} };`)));
  await markSeen();
  await appTheme('light');
  required(record, 'open', await step('open', () => openMap(NOTE, SOURCE)));
  const mtime = () => evaluate(`return app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}).stat.mtime;`);
  const mtimeAtOpen = await mtime();

  // CDP's own right press on a node, alone: recorded (macOS: no `contextmenu` from it in Obsidian's window, E77).
  await step('cdp-right-press', async () => {
    const pressed = await rightClick(onNode('温泉旅行'), { cdpOnly: true });
    if (pressed.opened) await escape();
    return pressed;
  });

  // The node's card: what is on it, and what is not.
  let ownCard = false;
  await step('own-node', async () => {
    const { state, viaCdp } = await rightClick(onNode('温泉旅行'));
    check(state.open, 'no card opened on 温泉旅行');
    if (!state.open) return state;
    ownCard = true;
    check(!state.obsidianMenu, 'Obsidian\'s menu is on the page as well');
    check(state.role === 'menu' && state.label === 'ノードのメニュー' && state.inView, `card ${JSON.stringify([state.role, state.label, state.inView])}`);
    check(same(state.swatches, COLORS) && same(state.checked, ['色なし']), `colours ${JSON.stringify([state.swatches, state.checked])}`);
    check(same(state.swatchRoles, ['menuitemradio']), `colour roles ${JSON.stringify(state.swatchRoles)}`);
    check(same(state.rows, NODE_ROWS), `rows ${JSON.stringify(state.rows)}`);
    check(same(state.keys, [null, null, DELETE_KEY.cap]) && state.shortcuts[2] === DELETE_KEY.keys, `keys ${JSON.stringify([state.keys, state.shortcuts])}`);
    check(same(state.danger, ['削除']), `danger ${JSON.stringify(state.danger)}`);
    const removed = REMOVED.filter(title => state.text.includes(title));
    check(removed.length === 0, `rows taken off are on the card: ${JSON.stringify(removed)}`);
    check(state.focus.name === '色なし', `focus on opening ${JSON.stringify(state.focus)}`);
    const closed = await escape();
    check(!closed.open && closed.focus.node === '温泉旅行', `Escape: ${JSON.stringify(closed)}`);
    return { viaCdp, state, closed };
  });

  // Obsidian's 「OS のメニュー」 either way: the same card (the case puts the setting back). On only for a build seen to
  // draw its own card (see above).
  await step('native-menus', async () => {
    const rows = {};
    if (!ownCard) {
      check(false, 'not run with 「OS のメニュー」 on: the build opened no card of its own (an OS menu would be left on screen)');
      return { notRun: true };
    }
    for (const setting of [true, false]) {
      await evaluate(`app.vault.setConfig('nativeMenus', ${setting}); return true;`);
      const { state } = await rightClick(onNode('温泉旅行'));
      rows[setting] = { rows: state.rows, swatches: state.swatches, obsidianMenu: state.obsidianMenu };
      check(state.open && same(state.rows, NODE_ROWS) && same(state.swatches, COLORS) && !state.obsidianMenu, `nativeMenus ${setting}: ${JSON.stringify(state)}`);
      await escape();
    }
    await evaluate(`app.vault.setConfig('nativeMenus', false); return true;`);
    return rows;
  });

  // A colour in one press, changed, taken off; each one write of that line, each one ⌘Z back.
  await step('colors', async () => {
    let expected = SOURCE;
    const steps = [];
    for (const [name, value_] of [['青', BLUE], ['赤', RED], ['色なし', null]]) {
      const { state } = await rightClick(onNode('温泉旅行'));
      const before = await source();
      await clickCard(name);
      const result = await after(before);
      expected = value_ ? SOURCE.replace('- 温泉旅行', `- ${mark(value_)}温泉旅行</mark>`) : SOURCE;
      const shown = await evaluate(`${VIEW} ${CARD} return { color: nth('温泉旅行', 0)?.dataset.mappyColor ?? null, ...cardState() };`);
      check(result.source === expected, `${name}: source ${JSON.stringify(result.source)}`);
      check(result.messages.length === 0, `${name}: ${JSON.stringify(result.messages)}`);
      check(!shown.open && shown.focus.node === '温泉旅行', `${name}: after the click ${JSON.stringify(shown)}`);
      steps.push({ name, checkedBefore: state.checked, color: shown.color });
    }
    check(same(steps.map(item => item.checkedBefore), [['色なし'], ['青'], ['赤']]), `checked ${JSON.stringify(steps)}`);
    check(same(steps.map(item => item.color), ['blue', 'red', null]), `fills ${JSON.stringify(steps)}`);
    const undone = [await history('undo'), await history('undo'), await history('undo')].map(item => item.source);
    check(same(undone, [SOURCE.replace('- 温泉旅行', `- ${mark(RED)}温泉旅行</mark>`), SOURCE.replace('- 温泉旅行', `- ${mark(BLUE)}温泉旅行</mark>`), SOURCE]), `⌘Z: ${JSON.stringify(undone)}`);
    return { steps, undone: undone.length };
  });

  // The card's keys, real ones.
  await step('keyboard', async () => {
    await rightClick(onNode('持ち物'));
    const trail = [];
    const key = async (name, modifiers = 0) => { await cdp.realKey(name, modifiers); await wait(120); const state = await cardState(); trail.push([name, state.open ? state.focus.name : 'closed']); return state; };
    trail.push(['open', (await cardState()).focus.name]);
    for (const name of ['ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowDown', 'Tab', 'Tab', 'End', 'Home', 'ArrowUp']) await key(name);
    await key('Tab', 8);
    check(same(trail, [['open', '色なし'], ['ArrowRight', '黄色'], ['ArrowRight', 'オレンジ'], ['ArrowLeft', '黄色'], ['ArrowDown', '本文・リンクを編集'],
      ['ArrowRight', '本文・リンクを編集'], ['ArrowDown', '画像を追加'], ['Tab', '削除'], ['Tab', '色なし'], ['End', '削除'], ['Home', '色なし'], ['ArrowUp', '削除'], ['Tab', '画像を追加']]),
    `keys ${JSON.stringify(trail)}`);
    // Enter on a circle colours the node; the card goes and the node has the focus.
    await key('Home');
    await key('ArrowRight');
    const before = await source();
    await cdp.realKey('Enter');
    const colored = await after(before);
    const afterEnter = await cardState();
    check(colored.source === SOURCE.replace('- 持ち物', `- ${mark(YELLOW)}持ち物</mark>`), `Enter on 黄色: ${JSON.stringify(colored.source)}`);
    check(!afterEnter.open && afterEnter.focus.node === '持ち物', `after Enter ${JSON.stringify(afterEnter)}`);
    // Space on a row runs it: 本文・リンクを編集 opens its modal; Escape there writes nothing.
    await rightClick(onNode('持ち物'));
    await key('ArrowDown');
    await cdp.realKey(' ');
    const modal = await until(() => evaluate(`return !!document.querySelector('.modal .mappy-edit-input');`), 3000, 'Space did not open the body modal');
    await cdp.realKey('Escape');
    await wait(400);
    const undone = await history('undo');
    check(undone.source === SOURCE, `⌘Z after the keys ${JSON.stringify(undone.source)}`);
    return { trail, modal, afterEnter };
  });

  // What closes the card, and where the focus goes.
  await step('close', async () => {
    const rows = {};
    const canvasPoint = await evaluate(`${VIEW} const r = el.querySelector('.mappy-canvas').getBoundingClientRect(); return { x: r.left + 40, y: r.top + 90 };`);
    // A real click on the empty canvas.
    await rightClick(onNode('温泉旅行'));
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: canvasPoint.x, y: canvasPoint.y, button: 'left', clickCount: 1 });
    await wait(300);
    rows.outside = await cardState();
    // A real wheel over the map (a scroll), then ⌘-wheel (a zoom).
    for (const [name, modifiers] of [['scroll', 0], ['zoom', 4]]) {
      await rightClick(onNode('温泉旅行'));
      // Over the map, away from the card (a wheel over the card scrolls the card, not the map).
      const over = await evaluate(`${VIEW} const r = el.querySelector('.mappy-canvas').getBoundingClientRect(); return { x: r.left + 60, y: r.top + 150 };`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: over.x, y: over.y, deltaX: 0, deltaY: 120, modifiers });
      await wait(400);
      rows[name] = await cardState();
    }
    // Another tab made active, then the map's again.
    await rightClick(onNode('温泉旅行'));
    await evaluate(`const other = app.workspace.getLeaf('tab'); window.__mappyE2EOther = other; app.workspace.setActiveLeaf(other, { focus: true }); await new Promise(resolve => setTimeout(resolve, 300)); return true;`);
    rows.tab = await cardState();
    await evaluate(`window.__mappyE2EOther?.detach(); delete window.__mappyE2EOther; app.workspace.setActiveLeaf(window.__mappyE2E, { focus: true }); await new Promise(resolve => setTimeout(resolve, 300)); return true;`);
    // The window's blur, dispatched (the case moves no OS window): the focus is left on the node for the window's return.
    await rightClick(onNode('温泉旅行'));
    await evaluate(`window.dispatchEvent(new Event('blur')); return true;`);
    await wait(200);
    rows.blur = await cardState();
    check(!rows.outside.open, `outside click left it open ${JSON.stringify(rows.outside)}`);
    check(!rows.scroll.open && rows.scroll.focus.node === '温泉旅行', `scroll ${JSON.stringify(rows.scroll)}`);
    check(!rows.zoom.open && rows.zoom.focus.node === '温泉旅行', `zoom ${JSON.stringify(rows.zoom)}`);
    check(!rows.tab.open, `another tab ${JSON.stringify(rows.tab)}`);
    check(!rows.blur.open && rows.blur.focus.node === '温泉旅行', `window blur ${JSON.stringify(rows.blur)}`);
    return rows;
  });

  // The menu key and Shift+F10 on the focused node: recorded (what Chromium raises for them is the platform's); a card
  // they open is the node's.
  await step('menu-key', async () => {
    await select('温泉旅行');
    const rows = {};
    for (const [name, key, modifiers] of [['ContextMenu', 'ContextMenu', 0], ['Shift+F10', 'F10', 8]]) {
      await cdp.realKey(key, modifiers);
      await wait(300);
      const state = await cardState();
      rows[name] = { opened: state.open, rows: state.rows ?? null };
      if (state.open) {
        check(same(state.rows, NODE_ROWS), `${name} opened another card ${JSON.stringify(state)}`);
        await escape();
      }
    }
    return rows;
  });

  // Where the rows taken off went: each key (and the double click) does what its row did, on the real Obsidian.
  await step('removed-rows-reach', async () => {
    const rows = {};
    const draftOpen = () => until(() => evaluate(`${VIEW} return !!input();`), 3000, 'no draft opened');
    // テキストを編集 → F2 and the double click: the draft opens on the node; Escape closes it, nothing written.
    await select('持ち物');
    await cdp.realKey('F2');
    rows.f2 = { draft: await draftOpen().catch(() => false), value: await evaluate(`${VIEW} return input()?.value ?? null;`) };
    await cdp.realKey('Escape');
    await wait(300);
    const at = await makePress(cdp, evaluate)(onNode('持ち物'), { click: false });
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 2 });
    rows.doubleClick = { draft: await draftOpen().catch(() => false), value: await evaluate(`${VIEW} return input()?.value ?? null;`) };
    await cdp.realKey('Escape');
    await wait(300);
    // 子を追加 → Tab, 兄弟を追加 → Enter: the new node under its provisional name; Escape at once takes it back.
    for (const [name, key, line] of [['tab', 'Tab', '- 持ち物\n  - サブトピック\n'], ['enter', 'Enter', '- 持ち物\n- メイントピック\n']]) {
      await select('持ち物');
      const before = await source();
      await cdp.realKey(key);
      const added = await after(before);
      await cdp.realKey('Escape');
      const back = await after(added.source);
      rows[name] = { added: added.source.includes(line), editing: added.editing, back: back.source === SOURCE };
    }
    // 前へ移動・後ろへ移動 → ⌥↓ (and a drag, E02/E25); 元に戻す・やり直す → ⌘Z・⌘⇧Z.
    await select('持ち物');
    const before = await source();
    await cdp.realKey('ArrowDown', 1);
    const moved = await after(before);
    const undone = await history('undo');
    const redone = await history('redo');
    const undoneAgain = await history('undo');
    rows.move = { moved: moved.source === SOURCE.replace('- 持ち物\n- 手書き\n', '- 手書き\n- 持ち物\n'), undo: undone.source === SOURCE, redo: redone.source === moved.source, back: undoneAgain.source === SOURCE };
    check(rows.f2.draft && rows.f2.value === '持ち物', `F2 ${JSON.stringify(rows.f2)}`);
    check(rows.doubleClick.draft && rows.doubleClick.value === '持ち物', `double click ${JSON.stringify(rows.doubleClick)}`);
    check(rows.tab.added && rows.tab.editing && rows.tab.back, `Tab ${JSON.stringify(rows.tab)}`);
    check(rows.enter.added && rows.enter.editing && rows.enter.back, `Enter ${JSON.stringify(rows.enter)}`);
    check(Object.values(rows.move).every(Boolean), `⌥↓ ⌘Z ⌘⇧Z ${JSON.stringify(rows.move)}`);
    check(await source() === SOURCE, 'the note is not back as it was');
    return rows;
  });

  // 削除 from the card, as Delete does; ⌘Z brings the node back.
  await step('delete', async () => {
    await rightClick(onNode('手書き'));
    const before = await source();
    await clickCard('削除');
    const deleted = await after(before);
    check(deleted.source === SOURCE.replace('- 手書き\n', ''), `削除 ${JSON.stringify(deleted.source)}`);
    const undone = await history('undo');
    check(undone.source === SOURCE, `⌘Z ${JSON.stringify(undone.source)}`);
    // The key the row shows, pressed on the card, runs it too.
    await rightClick(onNode('手書き'));
    const before2 = await source();
    await cdp.realKey(DELETE_KEY.cap === '⌫' ? 'Backspace' : 'Delete');
    const byKey = await after(before2);
    check(byKey.source === SOURCE.replace('- 手書き\n', ''), `${DELETE_KEY.cap} on the card ${JSON.stringify(byKey.source)}`);
    const undone2 = await history('undo');
    check(undone2.source === SOURCE, `⌘Z ${JSON.stringify(undone2.source)}`);
    return { deleted: deleted.source !== before, byKey: byKey.source !== before2 };
  });

  // A free topic, the calling item and a node of the called map.
  await step('shapes', async () => {
    const topic = (await rightClick(onNode('トピック'))).state;
    await escape();
    const calling = (await rightClick(`const node = nodes().find(item => item.classList.contains('is-called-root'));`)).state;
    await escape();
    const called = (await rightClick(`const node = nodes().find(item => item.classList.contains('is-called') && !item.classList.contains('is-called-root') && item.classList.contains('is-parent'));`)).state;
    await escape();
    check(same(topic.rows, ['本文・リンクを編集', '画像を追加', 'トピックを削除']) && same(topic.swatches, COLORS), `topic ${JSON.stringify(topic)}`);
    check(same(calling.rows, ['元のマップを開く', ...NODE_ROWS]) && same(calling.swatches, COLORS), `calling item ${JSON.stringify(calling)}`);
    // A called branch below the called root's children starts folded: its row expands it.
    check(same(called.rows, ['元のマップを開く', '展開']) && same(called.keys, [null, null]) && same(called.swatches, []), `called node ${JSON.stringify(called)}`);
    return { topic: topic.rows, calling: calling.rows, called: { rows: called.rows, keys: called.keys, swatches: called.swatches } };
  });

  // The empty canvas: トピックを追加 alone, which adds the topic there (Escape at once takes it back).
  await step('empty-canvas', async () => {
    const point = await evaluate(`${VIEW} const r = el.querySelector('.mappy-canvas').getBoundingClientRect(); return { x: r.left + 40, y: r.top + 90 };`);
    const { state } = await rightClick('', { point });
    check(state.open && state.label === 'マップのメニュー' && same(state.rows, ['トピックを追加']) && same(state.swatches, []), `empty canvas ${JSON.stringify(state)}`);
    const before = await source();
    await clickCard('トピックを追加');
    const added = await after(before);
    check(added.source === `${SOURCE}\n## トピック\n`, `added ${JSON.stringify(added.source)}`);
    check(added.editing, 'no draft on the new topic');
    await cdp.realKey('Escape');
    const back = await after(added.source);
    check(back.source === SOURCE, `Escape left ${JSON.stringify(back.source)}`);
    return { added: added.source !== before, editing: added.editing };
  });

  // At the pane's corner: the card stays inside the pane.
  await step('edge', async () => {
    const corner = await evaluate(`${VIEW} const r = el.getBoundingClientRect(); return { x: r.right - 6, y: r.bottom - 6 };`);
    await evaluate(`${VIEW} nth('温泉旅行', 0).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: ${corner.x}, clientY: ${corner.y} })); return true;`);
    await wait(200);
    const state = await cardState();
    await escape();
    const inside = state.open && state.rect.left >= state.pane.left && state.rect.top >= state.pane.top && state.rect.right <= state.pane.right && state.rect.bottom <= state.pane.bottom;
    check(inside, `the card leaves the pane ${JSON.stringify(state.rect)} in ${JSON.stringify(state.pane)}`);
    return { rect: state.rect, pane: state.pane };
  });

  // A heading note keeps the conversion to the list form (no other press reaches it).
  await step('headings', async () => {
    await openMap(HEADINGS_NOTE, HEADINGS);
    const { state } = await rightClick(onNode('見出しの枝'));
    await escape();
    check(same(state.rows, ['本文・リンクを編集', '画像を追加', 'リスト形式に変更', '削除']), `heading note ${JSON.stringify(state.rows)}`);
    await openMap(NOTE, SOURCE);
    return { rows: state.rows };
  });

  // The circles as the map fills a node, in both themes (Obsidian's, and the map's own setting); a shot of each.
  await step('themes', async () => {
    await select('温泉旅行');
    const before = await source();
    await evaluate(`app.workspace.setActiveLeaf(window.__mappyE2E, { focus: false }); return app.commands.executeCommandById('mappy:color-red');`);
    await after(before);
    const read = async name => {
      await rightClick(onNode('温泉旅行'));
      const fills = await evaluate(`${VIEW} ${COLOR} ${CARD}
        const node = nth('温泉旅行', 0); const swatch = card()?.querySelector('.mappy-swatch-fill[data-mappy-color="red"]');
        return { node: backdrop(node).slice(0, 3), swatch: swatch ? backdrop(swatch).slice(0, 3) : null,
          card: getComputedStyle(card()).backgroundColor, text: getComputedStyle(card().querySelector('.mappy-popover-title')).color,
          danger: getComputedStyle(card().querySelector('.mod-warning')).color, ratio: contrast(rgba(getComputedStyle(card().querySelector('.mappy-popover-title')).color), backdrop(card())) };`);
      if (value('--shot')) fills.shot = await cdp.screenshot(name === 'appLight' ? value('--shot') : value('--shot').replace(/\.png$/u, `-${name}.png`));
      await escape();
      return fills;
    };
    const setMap = theme => evaluate(`window.__mappyE2E.view.setTheme(${JSON.stringify(theme)}); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true;`);
    const rows = {};
    rows.appLight = await read('appLight');
    await setMap('dark');
    rows.appLightMapDark = await read('appLightMapDark');
    await setMap('follow');
    await appTheme('dark');
    rows.dark = await read('dark');
    await setMap('light');
    rows.appDarkMapLight = await read('appDarkMapLight');
    await setMap(await evaluate('return app.plugins.plugins.mappy.settings.theme;'));
    await appTheme('light');
    for (const [name, row] of Object.entries(rows)) {
      check(near(row.swatch, row.node), `${name}: circle ${JSON.stringify(row.swatch)} vs node ${JSON.stringify(row.node)}`);
      check(row.ratio >= 4.5, `${name}: the card's text contrast ${row.ratio}`);
    }
    // Dark fills are the darker six (LEV-364): the red's is #6C2636.
    check(near(rows.dark.swatch, [108, 38, 54]) && near(rows.appLightMapDark.swatch, [108, 38, 54]), `dark red ${JSON.stringify([rows.dark.swatch, rows.appLightMapDark.swatch])}`);
    const undone = await history('undo');
    check(undone.source === SOURCE, `⌘Z after the themes ${JSON.stringify(undone.source)}`);
    return rows;
  });

  // The map in a popout window: the card is in the popout's document, and a circle there colours the node.
  await step('popout', async () => {
    await evaluate(`const leaf = app.workspace.openPopoutLeaf({ size: { width: 1000, height: 720 } });
      const win = leaf.getContainer().win;
      if (win === window) { leaf.detach(); throw new Error('openPopoutLeaf gave a leaf in the main window'); }
      win.document.body.dataset.mappyE2ePopout = ${JSON.stringify(popoutMark)};
      win.__mappyE2E = leaf;
      window.__mappyE2EPopout = win;
      return true;`);
    const popout = await connect({ popout: popoutMark });
    const inPopout = expression => popout.evaluate(`(async () => { ${expression} })()`);
    try {
      await inPopout(`await window.__mappyE2E.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(NOTE)}, layout: 'mindmap' }, active: true });
        await new Promise(resolve => setTimeout(resolve, 1500)); return true;`);
      const { state } = await makeRightClick(popout, inPopout)(onNode('温泉旅行'));
      const where = await inPopout(`${VIEW} return { inPopout: document.querySelector('.mappy-context-card')?.ownerDocument === document && el.ownerDocument === document };`);
      const mainHasCard = await evaluate(`return !!document.querySelector('.mappy-context-card');`);
      const before = await source();
      await clickCard('緑', popout, inPopout);
      const colored = await after(before);
      const closed = await cardState(inPopout);
      check(state.open && same(state.rows, NODE_ROWS) && where.inPopout && !mainHasCard, `popout card ${JSON.stringify({ state, where, mainHasCard })}`);
      check(colored.source === SOURCE.replace('- 温泉旅行', `- ${mark(GREEN)}温泉旅行</mark>`), `popout colour ${JSON.stringify(colored.source)}`);
      check(!closed.open && closed.focus.node === '温泉旅行', `popout after the click ${JSON.stringify(closed)}`);
      return { state: { rows: state.rows, swatches: state.swatches }, where, mainHasCard };
    } finally {
      popout.close();
      await evaluate(`const win = window.__mappyE2EPopout; window.__mappyE2EPopout = null;
        if (win && win !== window) { win.close(); for (let started = Date.now(); Date.now() - started < 5000 && !win.closed; await new Promise(resolve => setTimeout(resolve, 50))); }
        return true;`);
      await wait(800);
      await evaluate(`app.workspace.setActiveLeaf(window.__mappyE2E, { focus: true }); return true;`);
      const undone = await history('undo');
      check(undone.source === SOURCE, `⌘Z after the popout ${JSON.stringify(undone.source)}`);
    }
  });

  // Reading never writes: the note is what the steps left (each write taken back), and its card opened and closed alone.
  await step('no-write', async () => {
    const atStart = await mtime();
    await rightClick(onNode('温泉旅行'));
    await escape();
    await rightClick('', { point: await evaluate(`${VIEW} const r = el.querySelector('.mappy-canvas').getBoundingClientRect(); return { x: r.left + 40, y: r.top + 90 };`) });
    await escape();
    await wait(600);
    const text = await source();
    check(text === SOURCE, `the note is not back as it was ${JSON.stringify(text)}`);
    check(await mtime() === atStart, 'opening and closing the cards wrote the note');
    return { mtimeAtOpen, atStart };
  });

  await step('page-errors', () => evaluate(`return window.__mappyE2EErrors.slice();`).then(errors => {
    check(errors.length === 0, `page errors: ${JSON.stringify(errors)}`);
    return { errors };
  }));

  if (!flag('--keep')) {
    await step('clean', () => evaluate(`
      for (const leaf of app.workspace.getLeavesOfType('mappy-map')) if (${JSON.stringify([NOTE, HEADINGS_NOTE])}.includes(leaf.view.file?.path)) leaf.detach();
      delete window.__mappyE2E;
      const removed = [];
      for (const path of ${JSON.stringify([NOTE, CALLED, HEADINGS_NOTE])}) {
        const file = app.vault.getAbstractFileByPath(path);
        if (file) { await app.vault.delete(file); removed.push(path); }
      }
      return { removed };`));
  }
} catch (error) {
  if (!(error instanceof StopCase)) throw error;
} finally {
  await evaluate(`app.vault.setConfig('nativeMenus', ${nativeMenusBack}); return true;`).catch(() => undefined);
  await evaluate(`if (${JSON.stringify(appThemeBefore)} !== null) app.changeTheme(${JSON.stringify(appThemeBefore)}); return true;`).catch(() => undefined);
  cdp.close();
}

process.exit(await finish(record, value('--json')));
