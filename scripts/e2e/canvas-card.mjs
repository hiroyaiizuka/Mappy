/**
 * E88 (docs/harness.md): a Canvas file card of a `mappy: true` note shows the note's map, read-only, and a double click
 * on the card opens the note as a map beside the canvas, where it is edited (LEV-348, 本人の希望 2026-10-18).
 *
 * Canvas renders a file card's note with the same embed as `![[…]]` (Obsidian 1.14.4 app.js), so before LEV-348 a map
 * note's card showed the note's title, properties and bullets, and a double click opened Canvas's Markdown editor.
 *
 * Rows are the person's operations × the card's shape, on one canvas (`ボード.canvas`) holding five file cards: the
 * map note (`マップ`, with a web link), a heading of a map note (`計画#準備`), the same note whole (`計画`: two cards of
 * one note, told apart by their place in the canvas's data), a note that is not a map (`ふつう`) and a missing note
 * (`ない`). Operations: place (open the canvas), a real double click (on the plain card, twice on the map card, on the
 * heading card, on a fold of the map and on the open button of a selected card), a real click on the web link, a card
 * added later (`createFileNode`, the call Canvas's drop and its 「保管庫からノートを追加」 make), edit in the map beside
 * (real click, Enter, typed title, Enter), Canvas's own 「編集」 (real click on its card menu, then on the board), zoom
 * out past the point where Canvas takes the cards' content off and back (real ⌘+wheel, real click on Canvas's own
 * "reset zoom"), move and resize the card (real drags), the read-only canvas (Canvas's menu item `setReadonly(true)`,
 * real double click, real click on the lock to leave it), the light and dark themes (contrast of what the card shows),
 * close the canvas (the handlers on Obsidian's event hubs back to where they were before it opened, as E34 counts them)
 * and disable Mappy (the card is Obsidian's again, with the text as it is now). Throughout: the source notes and the
 * `.canvas` file are written only by the edit row and Canvas's own saves (the added card, the move and the resize), and
 * the page has no uncaught error. The web link row catches `window.open` for its click, so no browser starts.
 *
 * Not covered here: OS IME text input in the map beside (E01 covers the view), a canvas embedded in a note or shown in a
 * hover preview (its cards stay Obsidian's: no canvas leaf holds their data, architecture.md §5b), and re-enabling
 * Mappy with the canvas open (its cards stay Obsidian's until the canvas is opened again; recorded, not checked).
 *
 * Usage (see docs/harness.md 実機検証 for the Obsidian instance):
 *   npm run harness:e2e:canvas-card -- [--reload] [--json <out.json>] [--shot <dir>] [--keep]
 */
import { join } from 'node:path';
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required, until } from './case-runner.mjs';
import { makeSelect, makePluginStep, makeAddNamed, refuseOpenLeaves } from './dom-helpers.mjs';
import { COLOR, ERRORS, HANDLERS, handlerDiff, makeAppTheme } from './window-helpers.mjs';

const { flag, value } = parseArgs();

const DIR = 'Fixtures/E2E-canvas';
const MAP = `${DIR}/マップ.md`;
const PLAN = `${DIR}/計画.md`;
const PLAIN = `${DIR}/ふつう.md`;
const MISSING = `${DIR}/ない.md`;
const BOARD = `${DIR}/ボード.canvas`;
const WEB = 'https://example.com/mappy-e2e';
const MAP_SOURCE = ['---', 'mappy: true', '---', '## 講座の案内', '- 回復する', '  - 睡眠', '  - 運動', '- 記録する', '  - 日誌', `- [サイト](${WEB})`, ''].join('\n');
const PLAN_SOURCE = ['---', 'mappy: true', '---', '# 計画', '', '## 準備', '### 荷物', '#### 服', '## 当日', '### 出発', ''].join('\n');
const PLAIN_SOURCE = '# ふつう\n\n- 項目\n';
const BOARD_SOURCE = `${JSON.stringify({
  nodes: [
    { id: 'map', type: 'file', file: MAP, x: 0, y: 0, width: 480, height: 320 },
    { id: 'heading', type: 'file', file: PLAN, subpath: '#準備', x: 560, y: 0, width: 400, height: 300 },
    { id: 'plain', type: 'file', file: PLAIN, x: 0, y: 400, width: 400, height: 240 },
    { id: 'missing', type: 'file', file: MISSING, x: 560, y: 400, width: 320, height: 200 },
    // The plan note a second time, whole: two cards of one note with different headings (told apart by their place).
    { id: 'whole', type: 'file', file: PLAN, x: 0, y: 700, width: 400, height: 260 },
  ],
  edges: [],
}, null, '\t')}\n`;
const FILES = { [MAP]: MAP_SOURCE, [PLAN]: PLAN_SOURCE, [PLAIN]: PLAIN_SOURCE, [BOARD]: BOARD_SOURCE };
const NEW_TOPIC = 'ふりかえり';
const MAP_LABELS = ['講座の案内', '回復する', '記録する', 'サイト'];
// theme.mjs: WCAG AA for text, and 3:1 for lines and borders.
const TEXT = 4.5;
const NON_TEXT = 3;

const record = createRecord(VAULT, BOARD);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const addNamed = makeAddNamed(cdp, evaluate);
const appTheme = makeAppTheme(evaluate);
const shotDir = value('--shot');
const shot = async name => (shotDir ? cdp.screenshot(join(shotDir, `canvas-card-${name}.png`)) : null);

/**
 * Script prelude: the canvas leaf under test (`window.__mappyE2ECanvas`), its cards by id, and what a card shows. A card's
 * node is Canvas's own object (`canvas.nodes`); the case reads it to find the card, never to drive what the person does.
 */
const CARDS = `const canvasLeaf = window.__mappyE2ECanvas;
  if (!canvasLeaf || canvasLeaf.view.getViewType() !== 'canvas') throw new Error('the canvas is not open');
  const canvas = canvasLeaf.view.canvas;
  const card = id => { const node = canvas.nodes.get(id); if (!node) throw new Error('no card ' + id); return node; };
  const box = el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const shows = id => {
    const node = card(id);
    const content = node.contentEl;
    const frame = content?.querySelector(':scope > .mappy-embed');
    const labels = frame ? Array.from(frame.querySelectorAll('.mappy-node .mappy-node-label'), item => item.textContent.trim()) : [];
    const rendered = content?.querySelector(':scope > .markdown-embed-content');
    const inside = content ? box(content) : null;
    // Every node on screen inside the card (1 px for rounding); an empty list is not "inside".
    const nodes = frame ? Array.from(frame.querySelectorAll('.mappy-node'), box) : [];
    const within = inside !== null && nodes.length > 0 && nodes.every(r => r.left >= inside.left - 1 && r.right <= inside.right + 1 && r.top >= inside.top - 1 && r.bottom <= inside.bottom + 1);
    return {
      mounted: !!content?.isConnected, placeholder: !!node.placeholderEl?.isConnected,
      frame: !!frame, frameShown: !!frame && getComputedStyle(frame).display !== 'none', frameId: frame?.dataset.mappyE2eFrame ?? null,
      host: !!content?.classList.contains('mappy-embed-host'),
      labels, within, editing: node.nodeEl.classList.contains('is-editing'),
      renderedShown: rendered ? getComputedStyle(rendered).display !== 'none' : false,
      text: content?.innerText.trim().slice(0, 200) ?? '',
      frameBox: frame ? box(frame) : null, cardBox: inside,
      scale: Number(frame?.querySelector('.mappy-world')?.style.transform.match(/scale\\(([\\d.]+)\\)/u)?.[1] ?? NaN),
      data: { x: node.x, y: node.y, width: node.width, height: node.height },
    };
  };
  const mapLeaves = path => app.workspace.getLeavesOfType('mappy-map').filter(leaf => leaf.getViewState().state?.file === path);`;

/**
 * Script: `leaf`, a new tab for the canvas. Obsidian's `getLeaf('tab')` throws when no leaf of the main area has been
 * active yet (a workspace whose only tab is the empty one the previous run's close left); the unpinned leaf then.
 */
const NEW_TAB = `const leaf = (() => { try { return app.workspace.getLeaf('tab'); } catch { return app.workspace.getLeaf(false); } })();`;

/** A card's labels once the map has drawn them (the first frame can be empty). */
const settledCard = (id, wanted, timeout = 4000) => until(async () => {
  const shown = await evaluate(`${CARDS} return shows(${JSON.stringify(id)});`);
  return wanted(shown) ? shown : null;
}, timeout, `card ${id} did not show what was expected`);

/** A real double click (two presses, the second with clickCount 2: Chromium then fires dblclick) at a point of a card. */
const doubleClickAt = async at => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  for (const clickCount of [1, 2]) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount });
    await wait(60);
  }
  await wait(1200);
  return at;
};
const doubleClick = async (id, fx = 0.3, fy = 0.8) => doubleClickAt(await onCard(id, fx, fy).catch(async () => { await fit(); return onCard(id, fx, fy); }));

/** The centre of the first element matching `selector` in a card's map, once it is what is on top there. */
const onMapPart = (id, selector) => evaluate(`${CARDS} const part = card(${JSON.stringify(id)}).contentEl.querySelector(':scope > .mappy-embed ' + ${JSON.stringify(selector)});
  if (!part) throw new Error('no ' + ${JSON.stringify(selector)} + ' on the card');
  const r = part.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2;
  const top = document.elementFromPoint(x, y);
  if (!part.contains(top)) throw new Error('something else is on ' + ${JSON.stringify(selector)} + ': ' + (top?.className?.baseVal ?? top?.className ?? 'nothing'));
  return { x, y };`);

/**
 * A real click near a card's lower left corner (the middle of each edge holds Canvas's connection handle once the card
 * is hovered): Canvas selects the card and takes the cover off its content. A card already selected is left as it is.
 */
const selectCard = async id => {
  if (await evaluate(`${CARDS} return card(${JSON.stringify(id)}).nodeEl.classList.contains('is-focused');`)) return;
  await clickAt(await onCard(id, 0.08, 0.92).catch(async () => { await fit(); return onCard(id, 0.08, 0.92); }));
};

/**
 * A real click on Canvas's own 「フィットするようにズーム」 control: every card on screen again after a split narrowed the
 * canvas or a zoom moved it, as the person would bring them back. Fails if the fit lands past Canvas's breakpoint
 * (the cards' content would be off).
 */
const fit = async () => {
  const control = await evaluate(`${CARDS} const button = Array.from(canvas.wrapperEl.querySelectorAll('.canvas-control-item')).find(item => (item.getAttribute('aria-label') ?? '').startsWith('フィットするようにズーム'));
    if (!button) throw new Error('no fit control'); return box(button);`);
  await clickAt({ x: control.left + control.width / 2, y: control.top + control.height / 2 });
  await wait(700);
  const zoom = await evaluate(`${CARDS} return { zoom: canvas.zoom, breakpoint: canvas.zoomBreakpoint };`);
  if (zoom.zoom <= zoom.breakpoint) throw new Error(`the fit zoom ${zoom.zoom} is past the breakpoint ${zoom.breakpoint}`);
  return zoom;
};

/** The point of a card at fractions of its size, once the card is what is on top there. */
const onCard = (id, fx, fy) => evaluate(`${CARDS} const r = card(${JSON.stringify(id)}).nodeEl.querySelector('.canvas-node-container').getBoundingClientRect();
  const x = r.left + r.width * ${fx}; const y = r.top + r.height * ${fy};
  const top = document.elementFromPoint(x, y);
  if (!card(${JSON.stringify(id)}).nodeEl.contains(top)) throw new Error('something else is on the card: ' + (top?.className ?? 'nothing'));
  return { x, y };`);

/** A real click at a point (window CSS pixels). */
const clickAt = async ({ x, y }) => {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
  await wait(300);
};

/** A real drag from one point to another, in steps, as a mouse moves. */
const drag = async (from, to) => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 12; i += 1) {
    const x = from.x + (to.x - from.x) * i / 12; const y = from.y + (to.y - from.y) * i / 12;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    await wait(16);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  await wait(600);
};

/** A point of the canvas's empty background, away from the cards. */
const blank = () => evaluate(`${CARDS} const r = canvas.wrapperEl.getBoundingClientRect();
  for (const [fx, fy] of [[0.05, 0.95], [0.95, 0.95], [0.05, 0.15], [0.5, 0.97]]) {
    const x = r.left + r.width * fx; const y = r.top + r.height * fy;
    const top = document.elementFromPoint(x, y);
    if (top === canvas.wrapperEl || top?.classList.contains('canvas-background') || top?.closest?.('.canvas-background')) return { x, y };
  }
  throw new Error('no empty background on screen');`);

/** The notes and the canvas file as they are on disk, with their modified times. */
const disk = () => evaluate(`const out = {};
  for (const path of ${JSON.stringify(Object.keys(FILES))}) { const file = app.vault.getAbstractFileByPath(path); out[path] = file ? { text: await app.vault.adapter.read(path), mtime: file.stat.mtime } : null; }
  return out;`);

let baseline = null;
let written = null;
let theme = null;
let sidebar = null;
try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));

  required(record, 'setup', await step('setup', () => evaluate(`${refuseOpenLeaves([...Object.keys(FILES), MISSING], ['markdown', 'mappy-map', 'canvas'])}
    ${ERRORS}
    const maps = app.workspace.getLeavesOfType('mappy-map').length; const canvases = app.workspace.getLeavesOfType('canvas').length;
    if (maps + canvases > 0) throw new Error(maps + ' map and ' + canvases + ' canvas leaves are open; the baseline would count their handlers. Close them first.');
    if (!app.vault.getAbstractFileByPath(${JSON.stringify(DIR)})) await app.vault.createFolder(${JSON.stringify(DIR)});
    const missing = app.vault.getAbstractFileByPath(${JSON.stringify(MISSING)});
    if (missing) await app.vault.delete(missing);
    for (const [path, text] of Object.entries(${JSON.stringify(FILES)})) {
      const file = app.vault.getAbstractFileByPath(path);
      if (file) await app.vault.modify(file, text); else await app.vault.create(path, text);
    }
    await new Promise(resolve => setTimeout(resolve, 600));
    window.__mappyE2EBaseline = ${HANDLERS};
    return { obsidian: require('electron').ipcRenderer.sendSync('version'), theme: document.body.classList.contains('theme-dark') ? 'dark' : 'light' };`)));
  baseline = await evaluate('return window.__mappyE2EBaseline;');
  theme = record.steps.setup.theme;
  // The left sidebar folded for the run, so the canvas keeps room for its four cards beside a split; put back in clean.
  sidebar = await evaluate(`const collapsed = app.workspace.leftSplit.collapsed; app.workspace.leftSplit.collapse(); await new Promise(resolve => setTimeout(resolve, 300)); return collapsed;`);
  written = await disk();

  // 置く: the canvas opens with its four cards.
  await step('place', async () => {
    await evaluate(`${NEW_TAB}
      window.__mappyE2ECanvas = leaf;
      await leaf.openFile(app.vault.getAbstractFileByPath(${JSON.stringify(BOARD)}), { active: true });
      // Fit the four cards on screen at a zoom where Canvas keeps their content (above its breakpoint).
      await new Promise(resolve => setTimeout(resolve, 800));
      const canvas = leaf.view.canvas; canvas.zoomToFit(); await new Promise(resolve => setTimeout(resolve, 600));
      if (canvas.zoom <= canvas.zoomBreakpoint) canvas.setViewport(canvas.tx, canvas.ty, 0);
      return true;`);
    const map = await settledCard('map', shown => shown.labels.length >= MAP_LABELS.length).catch(error => ({ error: String(error) }));
    const heading = await settledCard('heading', shown => shown.labels.length >= 2).catch(error => ({ error: String(error) }));
    const whole = await settledCard('whole', shown => shown.labels.length >= 3).catch(error => ({ error: String(error) }));
    const result = await evaluate(`${CARDS}
      const frame = card('map').contentEl.querySelector(':scope > .mappy-embed'); if (frame) frame.dataset.mappyE2eFrame = 'first';
      return { plain: shows('plain'), missing: shows('missing'), zoom: canvas.zoom, breakpoint: canvas.zoomBreakpoint };`);
    await shot('place');
    check(map.frame && !map.renderedShown, `the map card is not a map: ${JSON.stringify(map)}`);
    check(JSON.stringify([...(map.labels ?? [])].sort()) === JSON.stringify([...MAP_LABELS].sort()), `the map card shows ${JSON.stringify(map.labels)}`);
    check(map.within, 'the map card draws nodes outside the card');
    check(map.frameBox && Math.abs(map.frameBox.width - map.cardBox.width) <= 2 && Math.abs(map.frameBox.height - map.cardBox.height) <= 2, `the map does not fill the card: ${JSON.stringify([map.frameBox, map.cardBox])}`);
    check(map.scale > 0 && map.scale <= 1, `the map's fit is ${map.scale}`);
    check(heading.frame && JSON.stringify([...(heading.labels ?? [])].sort()) === JSON.stringify(['準備', '荷物'].sort()), `the heading card shows ${JSON.stringify(heading.labels)}`);
    check(!result.plain.frame && !result.plain.host && result.plain.renderedShown && result.plain.text.includes('項目'), `the plain card is not Obsidian's: ${JSON.stringify(result.plain)}`);
    check(!result.missing.frame && !result.missing.host, `the missing card is not Obsidian's: ${JSON.stringify(result.missing)}`);
    check(whole.frame && JSON.stringify([...(whole.labels ?? [])].sort()) === JSON.stringify(['計画', '準備', '当日'].sort()), `the whole-plan card shows ${JSON.stringify(whole.labels)}`);
    return { map, heading, whole, ...result };
  });

  // The plain card keeps Canvas's own double click: its Markdown editor.
  await step('dblclick-plain', async () => {
    await doubleClick('plain');
    const during = await evaluate(`${CARDS} return { editing: card('plain').isEditing, maps: mapLeaves(${JSON.stringify(PLAIN)}).length };`);
    await clickAt(await blank());
    await wait(400);
    const after = await evaluate(`${CARDS} return { editing: card('plain').isEditing, text: await app.vault.adapter.read(${JSON.stringify(PLAIN)}) };`);
    check(during.editing && during.maps === 0, `the plain card did not get Canvas's editor: ${JSON.stringify(during)}`);
    check(!after.editing && after.text === PLAIN_SOURCE, `the plain card's editor did not close cleanly: ${JSON.stringify(after)}`);
    return { during, after };
  });

  // ダブルクリック: the map card (not selected: Canvas's cover takes the pointer), then again on the same card.
  await step('dblclick-map', async () => {
    const at = await doubleClick('map');
    const result = await evaluate(`${CARDS} const leaves = mapLeaves(${JSON.stringify(MAP)}); const beside = leaves[0];
      window.__mappyE2E = beside;
      return { leaves: leaves.length, otherGroup: !!beside && beside.parent !== canvasLeaf.parent,
        right: !!beside && beside.view.containerEl.getBoundingClientRect().left >= canvasLeaf.view.containerEl.getBoundingClientRect().right - 2,
        active: app.workspace.getActiveViewOfType(Object)?.leaf === beside || app.workspace.activeLeaf === beside,
        canvasStill: canvasLeaf.view.getViewType() === 'canvas' && canvasLeaf.view.file?.path === ${JSON.stringify(BOARD)},
        card: shows('map') };`);
    await shot('dblclick');
    check(result.leaves === 1 && result.otherGroup && result.right, `the double click did not open the map beside the canvas: ${JSON.stringify(result)}`);
    check(!result.card.editing && result.card.frame && !result.card.renderedShown, `Canvas started its editor on the map card: ${JSON.stringify(result.card)}`);
    check(result.canvasStill, 'the canvas leaf no longer shows the canvas');
    return { at, ...result };
  });
  await step('dblclick-again', async () => {
    await doubleClick('map', 0.7, 0.2);
    const result = await evaluate(`${CARDS} return { leaves: mapLeaves(${JSON.stringify(MAP)}).length, same: mapLeaves(${JSON.stringify(MAP)})[0] === window.__mappyE2E,
      all: app.workspace.getLeavesOfType('mappy-map').length, editing: shows('map').editing };`);
    check(result.leaves === 1 && result.same && result.all === 1 && !result.editing, `a second double click did not bring the same map tab forward: ${JSON.stringify(result)}`);
    return result;
  });
  await step('dblclick-heading', async () => {
    await doubleClick('heading');
    const result = await evaluate(`${CARDS} const leaf = mapLeaves(${JSON.stringify(PLAN)})[0];
      const view = leaf?.view; const id = view?.selectedId; const doc = view?.document;
      const selected = id && doc ? [doc.root, ...doc.nodes].find(node => node.id === id)?.title : null;
      const out = { opened: !!leaf, otherGroup: !!leaf && leaf.parent !== canvasLeaf.parent, selected, editing: shows('heading').editing };
      leaf?.detach();
      return out;`);
    check(result.opened && result.otherGroup && result.selected === '準備' && !result.editing, `the heading card's double click: ${JSON.stringify(result)}`);
    return result;
  });
  // A double click on a fold of the map on a selected card: its two clicks work the fold, and nothing opens beside.
  await step('dblclick-fold', async () => {
    await selectCard('map');
    const before = await evaluate(`${CARDS} return { maps: app.workspace.getLeavesOfType('mappy-map').length, labels: shows('map').labels };`);
    await doubleClickAt(await onMapPart('map', '.mappy-node.is-collapsed .mappy-node-toggle'));
    const after = await evaluate(`${CARDS} return { maps: app.workspace.getLeavesOfType('mappy-map').length, labels: shows('map').labels, editing: shows('map').editing };`);
    check(after.maps === before.maps && !after.editing, `a double click on a fold opened something or started Canvas's editor: ${JSON.stringify({ before, after })}`);
    return { before, after };
  });

  // A web link in the map on a selected card opens (the case catches window.open, so no browser starts) and Canvas
  // does not start its editor.
  await step('web-link', async () => {
    await evaluate(`window.__mappyE2EOpen = window.open; window.__mappyE2EOpened = [];
      window.open = (...args) => { window.__mappyE2EOpened.push(String(args[0])); return null; }; return true;`);
    let result;
    try {
      await selectCard('map');
      await clickAt(await onMapPart('map', 'a.external-link'));
      await wait(500);
      result = await evaluate(`${CARDS} return { opened: window.__mappyE2EOpened.slice(), editing: shows('map').editing };`);
    } finally {
      await evaluate('window.open = window.__mappyE2EOpen; return true;');
    }
    check(JSON.stringify(result.opened) === JSON.stringify([WEB]) && !result.editing, `the web link on the card: ${JSON.stringify(result)}`);
    return result;
  });

  // 描画で書き換えない: up to here the case has only shown, opened and double-clicked; nothing is written.
  await step('untouched', async () => {
    const now = await disk();
    const changed = Object.entries(written).filter(([path, before]) => now[path]?.text !== before.text || now[path]?.mtime !== before.mtime).map(([path]) => path);
    check(changed.length === 0, `showing the cards wrote ${changed.join(', ')}`);
    return { changed };
  });

  // 新しく置く: a card the person adds (the call Canvas's drop and 「保管庫からノートを追加」 make) is a map at once.
  await step('add-card', async () => {
    const id = await evaluate(`${CARDS} const node = canvas.createFileNode({ pos: { x: 560, y: 700 }, size: { width: 400, height: 260 },
      file: app.vault.getAbstractFileByPath(${JSON.stringify(MAP)}) }); return node.id;`);
    await fit();
    const shown = await settledCard(id, item => item.labels.length >= MAP_LABELS.length).catch(error => ({ error: String(error) }));
    check(shown.frame && shown.frameShown && !shown.renderedShown && shown.within, `the added card is not a map: ${JSON.stringify(shown)}`);
    return { id, shown: { frame: shown.frame, labels: shown.labels, within: shown.within } };
  });

  // 横の画面で直す: a new main topic in the map beside, by real keys; the card follows.
  await step('edit-beside', async () => {
    await evaluate(`const leaf = window.__mappyE2E; if (!leaf) throw new Error('no map beside'); app.workspace.setActiveLeaf(leaf, { focus: true }); return true;`);
    await select('記録する');
    const added = await addNamed('Enter', NEW_TOPIC);
    const card = await settledCard('map', shown => shown.labels.includes(NEW_TOPIC)).catch(error => ({ error: String(error) }));
    await shot('edit');
    check(added.source.includes(`- ${NEW_TOPIC}`), `the map beside did not write the new topic: ${added.source}`);
    check(card.frame && card.labels?.includes(NEW_TOPIC) && !card.renderedShown && card.frameId === 'first', `the card did not follow the edit as the same map: ${JSON.stringify(card)}`);
    return { added: { labels: added.labels, waited: added.waited }, card };
  });

  // Canvas のメニューの「編集」: the card's Markdown editor shows instead of the map, and the map comes back after it.
  await step('menu-edit', async () => {
    await selectCard('map');
    const button = await evaluate(`${CARDS} const item = Array.from(canvas.wrapperEl.querySelectorAll('.canvas-menu .clickable-icon')).find(each => each.getAttribute('aria-label') === '編集');
      if (!item) throw new Error('no 編集 in the canvas menu'); return box(item);`);
    await clickAt({ x: button.left + button.width / 2, y: button.top + button.height / 2 });
    await wait(800);
    const during = await evaluate(`${CARDS} const content = card('map').contentEl;
      const editor = Array.from(content.querySelectorAll(':scope > .markdown-embed-content')).find(each => getComputedStyle(each).display !== 'none' && each.offsetHeight > 0);
      return { ...shows('map'), editorShown: !!editor, editorText: editor?.innerText.slice(0, 120) ?? '' };`);
    await shot('menu-edit');
    await clickAt(await blank());
    const after = await settledCard('map', item => !item.editing && item.frameShown && item.labels.length > 0).catch(error => ({ error: String(error) }));
    // The later rows tell the map apart by this mark: put it on the frame shown now.
    await evaluate(`${CARDS} const frame = card('map').contentEl.querySelector(':scope > .mappy-embed'); const same = frame?.dataset.mappyE2eFrame === 'first'; if (frame) frame.dataset.mappyE2eFrame = 'first'; return same;`);
    check(during.editing && !during.frameShown && during.editorShown, `Canvas's Edit did not show the editor in place of the map: ${JSON.stringify({ editing: during.editing, frameShown: during.frameShown, editorShown: during.editorShown })}`);
    check(after.frame && after.frameShown && !after.renderedShown && after.labels?.includes(NEW_TOPIC), `the map did not come back after the editor: ${JSON.stringify(after)}`);
    return { during: { editing: during.editing, frameShown: during.frameShown, editorShown: during.editorShown }, after: { frameShown: after.frameShown, frameId: after.frameId, labels: after.labels } };
  });

  // ズームで縮小して戻す: past Canvas's breakpoint the cards' content is taken off; the map comes back with it.
  await step('zoom', async () => {
    const point = await blank();
    let out = null;
    for (let turn = 0; turn < 12; turn += 1) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: 300, modifiers: 4 });
      await wait(150);
      out = await evaluate(`${CARDS} return { zoom: canvas.zoom, breakpoint: canvas.zoomBreakpoint, card: shows('map') };`);
      if (out.zoom < out.breakpoint - 0.2) break;
    }
    await wait(400);
    out = await evaluate(`${CARDS} return { zoom: canvas.zoom, breakpoint: canvas.zoomBreakpoint, card: shows('map') };`);
    await shot('zoomed-out');
    check(out.zoom < out.breakpoint && !out.card.mounted && out.card.placeholder, `the zoom did not take the card's content off: ${JSON.stringify({ zoom: out.zoom, breakpoint: out.breakpoint, mounted: out.card.mounted })}`);
    const reset = await evaluate(`${CARDS} const button = Array.from(canvas.wrapperEl.querySelectorAll('.canvas-control-item')).find(item => item.getAttribute('aria-label') === 'ズームをリセット');
      if (!button) throw new Error('no reset-zoom control'); return box(button);`);
    await clickAt({ x: reset.left + reset.width / 2, y: reset.top + reset.height / 2 });
    await wait(800);
    const back = await settledCard('map', shown => shown.mounted && shown.labels.length > 0).catch(error => ({ error: String(error) }));
    const zoom = await evaluate(`${CARDS} return canvas.zoom;`);
    await shot('zoomed-back');
    check(back.frame && back.frameId === 'first' && back.within && back.labels?.includes(NEW_TOPIC) && !back.renderedShown, `the map did not come back with the card: ${JSON.stringify(back)}`);
    return { out: { zoom: out.zoom, breakpoint: out.breakpoint, mounted: out.card.mounted }, back, zoom };
  });

  // 開くボタンのダブルクリック: its two clicks and the double click open the map once.
  await step('open-button', async () => {
    await evaluate(`for (const leaf of app.workspace.getLeavesOfType('mappy-map')) leaf.detach(); window.__mappyE2E = null; await new Promise(resolve => setTimeout(resolve, 300)); return true;`);
    await fit();
    await selectCard('map');
    await doubleClickAt(await onMapPart('map', '.mappy-embed-open'));
    const result = await evaluate(`${CARDS} return { leaves: mapLeaves(${JSON.stringify(MAP)}).length, all: app.workspace.getLeavesOfType('mappy-map').length, editing: shows('map').editing };`);
    check(result.leaves === 1 && result.all === 1 && !result.editing, `a double click on the open button: ${JSON.stringify(result)}`);
    return result;
  });

  // 付箋の移動と大きさの変更: real drags of the card body and of its corner.
  await step('move', async () => {
    // The map beside is closed first: the canvas gets its width back, so the fit keeps the cards' content on.
    await evaluate(`for (const leaf of app.workspace.getLeavesOfType('mappy-map')) leaf.detach(); window.__mappyE2E = null; await new Promise(resolve => setTimeout(resolve, 300)); return true;`);
    await fit();
    const before = await evaluate(`${CARDS} return shows('map');`);
    const from = await onCard('map', 0.15, 0.85);
    await drag(from, { x: from.x + 90, y: from.y + 50 });
    const after = await settledCard('map', shown => shown.within).catch(error => ({ error: String(error) }));
    check(after.data && (after.data.x !== before.data.x || after.data.y !== before.data.y), `the card did not move: ${JSON.stringify([before.data, after.data])}`);
    check(after.frame && after.frameId === 'first' && after.within && !after.editing, `the map did not move with the card: ${JSON.stringify(after)}`);
    return { before: before.data, after: after.data, editing: after.editing };
  });
  await step('resize', async () => {
    // A real click selects the card, and Canvas puts its resize handles around it.
    await fit();
    await clickAt(await onCard('map', 0.5, 0.9));
    const before = await evaluate(`${CARDS} return { ...shows('map'), selected: canvas.selection.has(card('map')) };`);
    check(before.selected && !before.editing, `a click did not select the map card (or started its editor): ${JSON.stringify({ selected: before.selected, editing: before.editing })}`);
    const corner = await evaluate(`${CARDS} const handle = canvas.wrapperEl.querySelector('.canvas-node-resizer[data-resize="bottomright"]');
      if (!handle) throw new Error('no corner handle'); return box(handle);`);
    const from = { x: corner.left + corner.width / 2, y: corner.top + corner.height / 2 };
    await drag(from, { x: from.x - 0.55 * before.cardBox.width, y: from.y - 0.5 * before.cardBox.height });
    const smaller = await settledCard('map', shown => shown.within && shown.scale < before.scale).catch(error => ({ error: String(error) }));
    await shot('resized');
    check(smaller.data && smaller.data.width < before.data.width && smaller.data.height < before.data.height, `the card did not get smaller: ${JSON.stringify([before.data, smaller.data])}`);
    check(smaller.frame && smaller.frameId === 'first' && smaller.within && smaller.scale < before.scale
      && Math.abs(smaller.frameBox.width - smaller.cardBox.width) <= 2 && Math.abs(smaller.frameBox.height - smaller.cardBox.height) <= 2,
    `the map did not fit the smaller card: ${JSON.stringify(smaller)}`);
    // Back to its size, by the corner again.
    const again = await evaluate(`${CARDS} const handle = canvas.wrapperEl.querySelector('.canvas-node-resizer[data-resize="bottomright"]'); return handle ? box(handle) : null;`);
    if (again) await drag({ x: again.left + again.width / 2, y: again.top + again.height / 2 }, { x: again.left + again.width / 2 + 0.55 * before.cardBox.width, y: again.top + again.height / 2 + 0.5 * before.cardBox.height });
    const restored = await settledCard('map', shown => shown.within).catch(error => ({ error: String(error) }));
    await clickAt(await blank());
    return { before: { data: before.data, scale: before.scale }, smaller: { data: smaller.data, scale: smaller.scale }, restored: { data: restored.data, scale: restored.scale } };
  });

  // 読み取り専用の Canvas: the double click still only opens the map.
  await step('readonly', async () => {
    await evaluate(`${CARDS} for (const leaf of mapLeaves(${JSON.stringify(MAP)})) leaf.detach(); window.__mappyE2E = null;
      // What the canvas settings menu's 「読み取り専用」 runs (Obsidian 1.14.4 app.js; the menu is native on macOS).
      canvas.setReadonly(true); canvasLeaf.view.saveLocalData(); await new Promise(resolve => setTimeout(resolve, 300)); return true;`);
    await doubleClick('map');
    const opened = await evaluate(`${CARDS} const leaves = mapLeaves(${JSON.stringify(MAP)}); window.__mappyE2E = leaves[0] ?? null;
      return { readonly: canvas.readonly, leaves: leaves.length, editing: shows('map').editing, card: shows('map').frame };`);
    // Leaving read-only is a click on the canvas's settings control, which shows a lock while read-only.
    const lock = await evaluate(`${CARDS} const button = canvas.wrapperEl.querySelector('.canvas-controls .canvas-control-item'); return box(button);`);
    await clickAt({ x: lock.left + lock.width / 2, y: lock.top + lock.height / 2 });
    const left = await evaluate(`${CARDS} return canvas.readonly;`);
    check(opened.readonly && opened.leaves === 1 && !opened.editing && opened.card, `the read-only canvas's double click: ${JSON.stringify(opened)}`);
    check(left === false, 'the canvas is still read-only');
    return { opened, readonlyAfter: left };
  });

  // 明色・暗色テーマ: what the card shows reads on its ground.
  for (const scheme of ['light', 'dark']) {
    await step(`theme-${scheme}`, async () => {
      const [shown] = await appTheme(scheme);
      await wait(400);
      const pairs = await evaluate(`${CARDS} ${COLOR}
        const frame = card('map').contentEl.querySelector(':scope > .mappy-embed');
        if (!frame) throw new Error('no map on the card');
        const root = frame.querySelector('.mappy-node.is-root'); const plain = Array.from(frame.querySelectorAll('.mappy-node')).find(node => !node.classList.contains('is-root'));
        const badge = frame.querySelector('.mappy-node.is-collapsed .mappy-node-toggle-mark'); const edge = frame.querySelector('.mappy-edges path');
        const canvasEl = frame.querySelector('.mappy-canvas'); const ground = backdrop(canvasEl);
        const text = element => onto(rgba(getComputedStyle(element).color), backdrop(element));
        const missing = Object.entries({ root, plain, badge, edge }).filter(([, item]) => !item).map(([name]) => name);
        if (missing.length) throw new Error('not on the card: ' + missing.join(', '));
        return [
          { name: 'node-text', ratio: contrast(text(plain.querySelector('.mappy-node-content') ?? plain), backdrop(plain)), min: ${TEXT} },
          { name: 'root-text', ratio: contrast(text(root.querySelector('.mappy-node-content') ?? root), backdrop(root)), min: ${TEXT} },
          { name: 'collapsed-count', ratio: contrast(text(badge), backdrop(badge)), min: ${TEXT} },
          { name: 'edge', ratio: contrast(onto(rgba(getComputedStyle(edge).stroke), ground), ground), min: ${NON_TEXT} },
        ];`);
      await shot(`theme-${scheme}`);
      check(shown === scheme, `the app did not switch to ${scheme}`);
      for (const pair of pairs) check(pair.ratio >= pair.min, `${scheme}: ${pair.name} contrast ${pair.ratio} (< ${pair.min})`);
      return { shown, pairs };
    });
  }

  // Canvas を閉じる: nothing of the cards stays.
  await step('close', async () => {
    const result = await evaluate(`${CARDS} for (const leaf of app.workspace.getLeavesOfType('mappy-map')) leaf.detach(); window.__mappyE2E = null;
      canvasLeaf.detach(); window.__mappyE2ECanvas = null;
      await new Promise(resolve => setTimeout(resolve, 800));
      return { handlers: ${HANDLERS}, left: document.querySelectorAll('.mappy-embed, .mappy-embed-anchor, .mappy-embed-host').length };`);
    const changed = handlerDiff(baseline, result.handlers);
    check(changed.length === 0, `handlers left after the canvas closed: ${changed.join(', ')}`);
    check(result.left === 0, `${result.left} map elements left after the canvas closed`);
    return { changed, left: result.left };
  });

  // Mappy を無効化: the card is Obsidian's again, with the note as it is now.
  await step('disable', async () => {
    await evaluate(`${NEW_TAB} window.__mappyE2ECanvas = leaf;
      await leaf.openFile(app.vault.getAbstractFileByPath(${JSON.stringify(BOARD)}), { active: true });
      await new Promise(resolve => setTimeout(resolve, 800));
      const canvas = leaf.view.canvas; canvas.zoomToFit(); await new Promise(resolve => setTimeout(resolve, 600));
      if (canvas.zoom <= canvas.zoomBreakpoint) canvas.setViewport(canvas.tx, canvas.ty, 0);
      return true;`);
    const shownBefore = await settledCard('map', shown => shown.frame && shown.labels.includes(NEW_TOPIC)).catch(error => ({ error: String(error) }));
    await evaluate(`await app.plugins.disablePlugin('mappy'); await new Promise(resolve => setTimeout(resolve, 1000)); return true;`);
    const disabled = await evaluate(`${CARDS} return shows('map');`);
    await shot('disabled');
    await evaluate(`await app.plugins.enablePlugin('mappy'); await new Promise(resolve => setTimeout(resolve, 1200)); return true;`);
    const reenabled = await evaluate(`${CARDS} return shows('map');`);
    check(shownBefore.frame, `the reopened canvas did not show the map: ${JSON.stringify(shownBefore)}`);
    check(!disabled.frame && !disabled.host && disabled.renderedShown && disabled.text.includes(NEW_TOPIC) && disabled.text.includes('講座の案内'),
      `the disabled card is not Obsidian's current text: ${JSON.stringify(disabled)}`);
    // Recorded, not checked: an open canvas's cards stay Obsidian's until it is opened again (the case file comment).
    return { disabled: { frame: disabled.frame, host: disabled.host, renderedShown: disabled.renderedShown, text: disabled.text }, reenabled: { frame: reenabled.frame } };
  });

  // What was written by the end: the map note by the edit beside, the canvas file by the move and the resize of the
  // map card (Canvas's own save: the card's place and size), and nothing else.
  await step('unchanged', async () => {
    const now = await disk();
    const changed = [];
    const expected = { [MAP]: MAP_SOURCE.replace('  - 日誌\n', `  - 日誌\n- ${NEW_TOPIC}\n`), [PLAN]: PLAN_SOURCE, [PLAIN]: PLAIN_SOURCE };
    for (const [path, text] of Object.entries(expected)) {
      if (now[path]?.text !== text) changed.push(`${path}: ${JSON.stringify(now[path]?.text)}`);
      if (path !== MAP && now[path]?.mtime !== written[path].mtime) changed.push(`${path}: modified at ${now[path]?.mtime} (was ${written[path].mtime})`);
    }
    const board = JSON.parse(now[BOARD]?.text ?? '{}');
    const original = JSON.parse(BOARD_SOURCE);
    for (const node of original.nodes) {
      const saved = board.nodes?.find(item => item.id === node.id);
      const keys = node.id === 'map' ? ['type', 'file', 'subpath'] : Object.keys(node);
      if (!saved || keys.some(key => saved[key] !== node[key])) changed.push(`${BOARD}: card ${node.id} is ${JSON.stringify(saved)}`);
    }
    check(changed.length === 0, `the notes or the canvas file changed: ${changed.join('; ')}`);
    return { changed };
  });

  await step('errors', async () => {
    const errors = await evaluate('return window.__mappyE2EErrors ?? [];');
    check(errors.length === 0, `page errors: ${errors.join(' | ')}`);
    return { errors };
  });
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`unexpected: ${error}`);
} finally {
  if (theme) await appTheme(theme).catch(() => null);
  if (sidebar === false) await evaluate('app.workspace.leftSplit.expand(); return true;').catch(() => null);
  await step('clean', () => evaluate(`for (const leaf of app.workspace.getLeavesOfType('mappy-map')) leaf.detach();
    const leaf = window.__mappyE2ECanvas;
    if (leaf?.view?.canvas?.readonly) { leaf.view.canvas.setReadonly(false); leaf.view.saveLocalData(); }
    leaf?.detach(); window.__mappyE2ECanvas = null; window.__mappyE2E = null;
    if (${!flag('--keep')}) {
      for (const path of ${JSON.stringify(Object.keys(FILES))}) { const file = app.vault.getAbstractFileByPath(path); if (file) await app.vault.delete(file); }
    }
    return true;`));
  cdp.close();
}
process.exitCode = await finish(record, value('--json'));
