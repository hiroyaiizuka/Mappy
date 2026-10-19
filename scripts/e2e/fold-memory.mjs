/**
 * E90 (LEV-365): the branches folded and opened by hand on a map stay so once the map comes back — the person's report of
 * 2026-10-19: another note opened in the same tab and the map opened again showed every branch open. The matrix is the
 * person's operations × the shapes a map comes in (AGENTS.md): each row sets the folds it starts from by real clicks on the
 * fold controls and real Space keys (`ensure`), takes what the map shows (`sig`: the folded nodes by name and place, and how
 * many nodes are drawn), does the operation, and compares.
 *
 * Shapes: a list map (`LIST`) with a branch, two siblings of one name (the second folded), an empty-titled item, a deep
 * branch, a free topic's branch, a link to the plain note and a call (`![[E2E-fold-called]]`) whose called branches start
 * folded below the called root's children (§5 M12: C1 opened by hand, C2 left as it starts, C1a under C1 as it starts); a
 * headings map (`HEADINGS`, two headings of one name); a map of 2,000 nodes (`BIG`, the generated performance-2000 note
 * with `mappy: true` put in front).
 *
 * Rows: 1 the file explorer (another note in the same tab, then the map again), 2 a link on the map and back／forward,
 * 3 the same note in another tab, 4 Markdown and back (`mappy:toggle-mindmap`), 5 Markdown edits (a node added, one
 * deleted, two branches swapped, written from outside the map: the folds stay but the second 同名's, which goes with its
 * id as before, E05) and the map opened again as it showed, 6 the note renamed into another
 * folder (in place, then opened again; the memory names the new path only), 7 two tabs on one note (the provisional
 * answer: each tab keeps its own folds while it is open, and a map opened next takes the last change made), 8 the headings
 * map and 9 the 2,000-node map opened again, 10 the plugin disabled and enabled with a change made just before (no wait
 * for the throttled write), 11 the window reloaded once the change has rested (a) and at once (b: the change is lost, the
 * file is not; provisional), 12 Obsidian quit at once after a change (`app.quit()`, then
 * launched again with `MAPPY_E2E_PROFILE` on the same port: macOS only) — every map as it was, 13 a deleted note leaves
 * the memory. `--perf` also measures, on whatever build is installed: the 2,000-node map's opening (setViewState to the
 * first laid-out node) and one fold's handler (the click's synchronous work) and frame, and, when the build has the
 * memory, its file for 1,000 notes × 20 folds (size, write, read) in a file of its own beside it.
 *
 * Usage: npm run harness:e2e:fold-memory -- [--json <out.json>] [--keep] [--perf] [--no-quit]
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, PORT, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required, until } from './case-runner.mjs';
import { makePluginStep, writeNote } from './dom-helpers.mjs';
import { ERRORS } from './window-helpers.mjs';

const { flag, value } = parseArgs();

const FOLDER = 'Fixtures/E2E-fold';
const LIST = `${FOLDER}/E2E-fold-list.md`;
const MOVED = `${FOLDER}/moved/E2E-fold-list-moved.md`;
const CALLED = `${FOLDER}/E2E-fold-called.md`;
const HEADINGS = `${FOLDER}/E2E-fold-headings.md`;
const OTHER = `${FOLDER}/E2E-fold-other.md`;
const BIG = `${FOLDER}/E2E-fold-2000.md`;
const GONE = `${FOLDER}/E2E-fold-gone.md`;
/** The memory's file (the person's decision of 2026-10-19: Mappy's own file in the plugin's folder, by note path). */
const MEMORY = join(VAULT, '.obsidian', 'plugins', 'mappy', 'folds.json');

const LIST_SOURCE = [
  '---', 'mappy: true', '---',
  '## リストのマップ',
  '- 枝A', '  - A1', '    - A1a',
  '- 同名', '  - 一つ目の子',
  '- 同名', '  - 二つ目の子',
  '- ', '  - 空の子',
  '- 深い', '  - 深2', '    - 深3', '      - 深4', '        - 深5', '          - 深6', '            - 深7',
  '- 消す枝', '  - 消す子',
  '- [[E2E-fold-other]]',
  '- ![[E2E-fold-called]]',
  '',
  '## トピック', '- T1', '  - T1a', '',
].join('\n');
const CALLED_SOURCE = ['---', 'mappy: true', '---', '## 呼び出し先', '- C1', '  - C1a', '    - C1b', '- C2', '  - C2a', ''].join('\n');
const HEADINGS_SOURCE = [
  '---', 'mappy: true', 'mappy-layout: mindmap', '---',
  '# 見出しのマップ', '## 章1', '### 節1', '#### 項1', '## 章2', '### 同じ見出し', '#### 子1', '### 同じ見出し', '#### 子2', '',
].join('\n');
const OTHER_SOURCE = '# ほかのノード\n\n本文だけのノート。\n';
const GONE_SOURCE = ['---', 'mappy: true', '---', '## 消すノート', '- 畳む', '  - 中', ''].join('\n');

/** What each map shows folded once `ensure` has run: `<name>#<n>`, the n-th node of that name from the top. */
const LIST_FOLDS = ['C1a#1', 'C2#1', 'T1#1', '同名#2', '枝A#1', '深6#1', '空のノード#1'];
const HEADING_FOLDS = ['同じ見出し#2', '章1#1'];
const BIG_FOLDS = ['第1節#1', '第3節#1', '第50節#1'];

const OBSIDIAN_APP = process.env.MAPPY_E2E_OBSIDIAN_APP ?? '/Applications/Obsidian.app';
const PROFILE = process.env.MAPPY_E2E_PROFILE ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'artifacts', 'obsidian-profile');
let quitDone = false;

const record = createRecord(VAULT, LIST);
let cdp = await connect();
let evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);

/**
 * Page script: `sig(leaf)` — the map's folded nodes as `<name>#<n>` (n counts the nodes of that name from the top, then
 * from the left, as drawn), sorted, and how many nodes are drawn; `find(leaf, name, n)` that node's element; `leafOf(path)`
 * the newest map leaf on the note.
 */
const PAGE = `const label = node => (node.getAttribute('aria-labelledby') ?? '').split(/\\s+/u).filter(Boolean)
    .map(id => (node.ownerDocument.getElementById(id) ?? node.querySelector('[id="' + CSS.escape(id) + '"]'))?.textContent?.trim() ?? '').join(' ');
  const ranked = (leaf, name) => Array.from(leaf.view.contentEl.querySelectorAll('.mappy-node')).filter(node => label(node) === name)
    .map(node => ({ node, rect: node.getBoundingClientRect() })).sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left).map(item => item.node);
  const find = (leaf, name, n) => ranked(leaf, name)[n - 1] ?? null;
  const sig = leaf => {
    const nodes = Array.from(leaf.view.contentEl.querySelectorAll('.mappy-node'));
    const folded = nodes.filter(node => node.classList.contains('is-collapsed')).map(node => label(node) + '#' + (ranked(leaf, label(node)).indexOf(node) + 1));
    return { folded: folded.sort(), drawn: nodes.length };
  };
  const leafOf = path => app.workspace.getLeavesOfType('mappy-map').filter(item => item.view.file?.path === path).at(-1) ?? null;
  const laidOut = async leaf => {
    for (const started = Date.now(); Date.now() - started < 8000; await new Promise(resolve => setTimeout(resolve, 50))) {
      const node = leaf?.view?.contentEl?.querySelector('.mappy-node');
      if (node && node.getBoundingClientRect().width > 0) { await new Promise(resolve => setTimeout(resolve, 400)); return true; }
    }
    throw new Error('the map did not lay out within 8 s');
  };`;

/** The note as a map in a new tab, active; remembered as `__mappyE2E`. */
const openTab = path => evaluate(`${PAGE}
  const leaf = app.workspace.getLeaf('tab');
  await leaf.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(path)} }, active: true });
  await laidOut(leaf);
  app.workspace.setActiveLeaf(leaf, { focus: true });
  window.__mappyE2E = leaf;
  return sig(leaf);`);

/** What the case's map (`__mappyE2E`) shows now. */
const current = () => evaluate(`${PAGE} const leaf = window.__mappyE2E; if (!leaf?.view?.file) throw new Error('the case map is gone'); await laidOut(leaf); return { path: leaf.view.file.path, type: leaf.view.getViewType(), ...sig(leaf) };`);

/** A real press at an element `locate` (page script setting `target`) finds in the case's map; `hover` moves there first. */
async function press(locate, { hover = false } = {}) {
  let box;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    box = await evaluate(`${PAGE} const leaf = window.__mappyE2E; let target = null; ${locate}
      if (!target) throw new Error('nothing to press: ' + ${JSON.stringify(locate)});
      const rect = target.getBoundingClientRect();
      const x = rect.left + rect.width / 2; const y = rect.top + rect.height / 2;
      const top = document.elementFromPoint(x, y);
      if (top && !target.contains(top)) top.closest('.notice')?.click();
      return { x, y, hit: !!top && target.contains(top), cover: top ? String(top.className?.baseVal ?? top.className ?? top.tagName) : 'nothing' };`);
    if (box.hit) break;
    // Off screen, or too small to press (a 2,000-node map fitted to the pane): the view centres its node at 100 %, as a
    // person zooms in to reach it. Only the viewport moves; the folds are not touched.
    await evaluate(`${PAGE} const leaf = window.__mappyE2E; let target = null; ${locate}
      const view = leaf.view; const owner = target?.closest('.mappy-node');
      const placed = owner && view.layout?.nodes.find(item => item.id === owner.dataset.nodeId);
      const canvas = view.contentEl.querySelector('.mappy-canvas');
      if (placed && canvas) view.viewport.set({ scale: 1, x: canvas.clientWidth / 2 - placed.x - placed.width / 2, y: canvas.clientHeight / 2 - placed.y - placed.height / 2 });
      return true;`);
    await wait(400);
  }
  if (!box.hit) throw new Error(`cannot press at (${Math.round(box.x)},${Math.round(box.y)}): ${box.cover} is there`);
  if (hover) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y }); await wait(150); }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  await wait(350);
}

/** One fold toggled the way a person does: a click on its control, or the node selected by a click and Space. */
async function toggle(name, n, how) {
  const locate = `const node = find(leaf, ${JSON.stringify(name)}, ${n});`;
  if (how === 'space') {
    await press(`${locate} target = node?.querySelector('.mappy-node-content') ?? node;`);
    await cdp.realKey(' ');
  } else {
    await press(`${locate} target = node?.querySelector('.mappy-node-toggle');`, { hover: true });
  }
  await wait(350);
}

/**
 * The case's map brought to show `folds` folded, by toggles alone (`toggle`, alternating the click and Space): opening
 * first, as an opened fold can show a node to fold (C1 shows C1a). Throws when the map will not get there.
 */
async function ensure(folds) {
  let how = 'click';
  for (let round = 0; round < 16; round += 1) {
    const now = await current();
    const extra = now.folded.filter(item => !folds.includes(item));
    const missing = folds.filter(item => !now.folded.includes(item));
    if (extra.length === 0 && missing.length === 0) return now;
    const visible = await evaluate(`${PAGE} const leaf = window.__mappyE2E;
      return ${JSON.stringify(missing)}.filter(item => { const at = item.lastIndexOf('#'); return !!find(leaf, item.slice(0, at), Number(item.slice(at + 1))); });`);
    const next = extra[0] ?? visible[0];
    if (!next) throw new Error(`cannot reach ${JSON.stringify(folds)} from ${JSON.stringify(now.folded)}`);
    const at = next.lastIndexOf('#');
    await toggle(next.slice(0, at), Number(next.slice(at + 1)), how);
    how = how === 'click' ? 'space' : 'click';
  }
  throw new Error(`the folds did not settle on ${JSON.stringify(folds)}`);
}

/** A command by id on the active leaf (the case's map is made active first). */
const command = id => evaluate(`const leaf = window.__mappyE2E; app.workspace.setActiveLeaf(leaf, { focus: true });
  const done = app.commands.executeCommandById(${JSON.stringify(id)}); await new Promise(resolve => setTimeout(resolve, 1200)); return done;`);

/** A real click on the note in the file explorer, the case's tab being the one it opens in. */
async function explorerOpen(path) {
  await evaluate(`const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
    app.workspace.leftSplit.expand();
    const explorer = app.workspace.getLeavesOfType('file-explorer')[0];
    if (!explorer) throw new Error('no file explorer');
    explorer.view.revealInFolder(file);
    await new Promise(resolve => setTimeout(resolve, 500));
    app.workspace.setActiveLeaf(window.__mappyE2E, { focus: true });
    return true;`);
  let box;
  for (let attempt = 0; attempt < 5 && !box?.hit; attempt += 1) {
    box = await evaluate(`const item = document.querySelector('.nav-file-title[data-path="' + CSS.escape(${JSON.stringify(path)}) + '"]');
      if (!item) return { hit: false };
      item.scrollIntoView({ block: 'center' });
      const rect = item.getBoundingClientRect(); const x = rect.left + Math.min(40, rect.width / 2); const y = rect.top + rect.height / 2;
      const top = document.elementFromPoint(x, y);
      return { x, y, hit: !!top && item.contains(top) };`);
    if (!box.hit) await wait(300);
  }
  if (!box?.hit) throw new Error(`${path} is not reachable in the file explorer`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  await wait(1500);
  return evaluate(`const leaf = window.__mappyE2E; return { type: leaf.view.getViewType(), path: leaf.view.file?.path ?? null };`);
}

/** The memory's file as it is on disk now (null when there is none), once the throttled write has had time to land. */
async function memoryOnDisk(settle = 2500) {
  await wait(settle);
  try { return JSON.parse(await readFile(MEMORY, 'utf8')); } catch (error) { return error?.code === 'ENOENT' ? null : { unreadable: String(error) }; }
}

/** Longer than the memory's throttle: what was changed before it is on disk. */
const SETTLED = 2500;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function reconnect() {
  for (let started = Date.now(); ; await wait(500)) {
    try { cdp = await connect(); break; } catch (error) {
      if (Date.now() - started > 60000) throw error;
    }
  }
  evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
  await until(() => evaluate(`return !!app.workspace.layoutReady && !!app.plugins.plugins.mappy;`), 30000, 'Obsidian came back without Mappy');
  await evaluate(`${ERRORS} return true;`);
}

/** Every map and Markdown leaf on the case's notes detached, so a row starts from tabs of its own. */
const detachAll = () => evaluate(`const paths = ${JSON.stringify([LIST, MOVED, CALLED, HEADINGS, OTHER, BIG, GONE])};
  const leaves = [];
  app.workspace.iterateAllLeaves(leaf => { const state = leaf.getViewState(); if (['mappy-map', 'markdown'].includes(state.type) && paths.includes(leaf.view.file?.path ?? state.state?.file)) leaves.push(leaf); });
  for (const leaf of leaves) leaf.detach();
  await new Promise(resolve => setTimeout(resolve, 300));
  return leaves.length;`);

let list = LIST;

try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  required(record, 'setup', await step('setup', async () => {
    await detachAll();
    const big = await evaluate(`return await app.vault.adapter.read('Fixtures/performance-2000.md');`);
    const moved = await evaluate(`return !!app.vault.getAbstractFileByPath(${JSON.stringify(MOVED)});`);
    if (moved) await evaluate(`await app.fileManager.renameFile(app.vault.getAbstractFileByPath(${JSON.stringify(MOVED)}), ${JSON.stringify(LIST)}); return true;`);
    await evaluate(`if (!app.vault.getAbstractFileByPath(${JSON.stringify(FOLDER)})) await app.vault.createFolder(${JSON.stringify(FOLDER)});
      { ${writeNote(CALLED, CALLED_SOURCE)} } { ${writeNote(OTHER, OTHER_SOURCE)} } { ${writeNote(HEADINGS, HEADINGS_SOURCE)} }
      { ${writeNote(BIG, `---\nmappy: true\n---\n${big}`)} } { ${writeNote(LIST, LIST_SOURCE)} }
      ${ERRORS}
      await new Promise(resolve => setTimeout(resolve, 800)); return true;`);
    const obsidian = await evaluate(`return require('electron').ipcRenderer.sendSync('version');`);
    return { obsidian, memoryBefore: await memoryOnDisk(0) };
  }));

  // Row 1: the file explorer — another note in the same tab, then the map again.
  await step('1-explorer', async () => {
    await openTab(list);
    const before = await ensure(LIST_FOLDS);
    const away = await explorerOpen(OTHER);
    if (away.path !== OTHER) throw new Error(`the explorer did not open the other note in the case's tab: ${JSON.stringify(away)}`);
    const back = await explorerOpen(list);
    const after = await current();
    check(after.type === 'mappy-map' && same(after.folded, before.folded), `1-explorer: the map came back with other folds: ${JSON.stringify(after.folded)} (was ${JSON.stringify(before.folded)})`);
    return { before, away, back, after };
  });

  // Row 2: a link on the map, then back and forward.
  await step('2-link-history', async () => {
    const before = await ensure(LIST_FOLDS);
    await press(`target = Array.from(leaf.view.contentEl.querySelectorAll('.mappy-node a.internal-link')).find(link => link.getAttribute('data-href') === 'E2E-fold-other') ?? null;`);
    await wait(1200);
    const away = await evaluate(`const leaf = window.__mappyE2E; return { type: leaf.view.getViewType(), path: leaf.view.file?.path ?? null };`);
    if (away.path !== OTHER) throw new Error(`the link did not open the other note in the case's tab: ${JSON.stringify(away)}`);
    await command('app:go-back');
    const back = await current();
    check(same(back.folded, before.folded), `2-link-history: back showed other folds: ${JSON.stringify(back.folded)}`);
    await command('app:go-forward');
    const forward = await evaluate(`const leaf = window.__mappyE2E; return leaf.view.file?.path ?? null;`);
    await command('app:go-back');
    const again = await current();
    check(forward === OTHER && same(again.folded, before.folded), `2-link-history: forward then back showed other folds: ${JSON.stringify(again.folded)} (forward on ${forward})`);
    return { before, away, back, forward, again };
  });

  // Row 3: the same note in another tab.
  await step('3-other-tab', async () => {
    const before = await ensure(LIST_FOLDS);
    const first = await evaluate(`return window.__mappyE2E.id;`);
    const other = await openTab(list);
    check(same(other.folded, before.folded), `3-other-tab: the second tab showed other folds: ${JSON.stringify(other.folded)}`);
    await evaluate(`const leaf = window.__mappyE2E; window.__mappyE2E = app.workspace.getLeafById(${JSON.stringify(first)}); leaf.detach(); app.workspace.setActiveLeaf(window.__mappyE2E, { focus: true }); return true;`);
    return { before, other };
  });

  // Row 4: Markdown and back, by the command (the 操作 popover's first item runs the same switch).
  await step('4-markdown', async () => {
    const before = await ensure(LIST_FOLDS);
    await command('mappy:toggle-mindmap');
    const markdown = await evaluate(`return window.__mappyE2E.view.getViewType();`);
    if (markdown !== 'markdown') throw new Error(`the switch did not show Markdown: ${markdown}`);
    await command('mappy:toggle-mindmap');
    const after = await current();
    check(after.type === 'mappy-map' && same(after.folded, before.folded), `4-markdown: the map came back with other folds: ${JSON.stringify(after.folded)}`);
    return { before, markdown, after };
  });

  // Row 5: Markdown edits from outside the map — a node added, one deleted, two branches swapped — then opened again.
  await step('5-edits', async () => {
    const before = await ensure(LIST_FOLDS);
    const edited = LIST_SOURCE
      .replace('- 消す枝\n  - 消す子\n', '')
      .replace('- 枝A\n  - A1\n    - A1a\n', '')
      .replace('- [[E2E-fold-other]]\n', '- [[E2E-fold-other]]\n- 枝A\n  - A1\n    - A1a\n- 足した枝\n  - 足した子\n');
    await evaluate(`await app.vault.adapter.write(${JSON.stringify(list)}, ${JSON.stringify(edited)}); await new Promise(resolve => setTimeout(resolve, 1500)); return true;`);
    const live = await current();
    // A change made outside the map matches nodes by unique titles only: the second 同名 gets a new id and its fold goes
    // with the old one, as before (E05, LEV-237); every other fold stays.
    const kept = before.folded.filter(item => item !== '同名#2');
    check(same(live.folded, kept), `5-edits: the edit left other folds than the rule keeps: ${JSON.stringify(live.folded)} (expected ${JSON.stringify(kept)})`);
    await explorerOpen(OTHER);
    await explorerOpen(list);
    const after = await current();
    check(same(after.folded, live.folded), `5-edits: the map opened again with other folds than it showed: ${JSON.stringify(after.folded)} (showed ${JSON.stringify(live.folded)})`);
    await evaluate(`await app.vault.adapter.write(${JSON.stringify(list)}, ${JSON.stringify(LIST_SOURCE)}); await new Promise(resolve => setTimeout(resolve, 1500)); return true;`);
    return { before, live, after };
  });

  // Row 6: the note renamed into another folder: kept in place, and opened again under the new path.
  await step('6-rename-move', async () => {
    const before = await ensure(LIST_FOLDS);
    await evaluate(`if (!app.vault.getAbstractFileByPath(${JSON.stringify(`${FOLDER}/moved`)})) await app.vault.createFolder(${JSON.stringify(`${FOLDER}/moved`)});
      await app.fileManager.renameFile(app.vault.getAbstractFileByPath(${JSON.stringify(LIST)}), ${JSON.stringify(MOVED)});
      await new Promise(resolve => setTimeout(resolve, 1200)); return true;`);
    list = MOVED;
    const live = await current();
    check(live.path === MOVED && same(live.folded, before.folded), `6-rename-move: the map lost folds on the move: ${JSON.stringify(live)}`);
    await explorerOpen(OTHER);
    await explorerOpen(MOVED);
    const after = await current();
    check(same(after.folded, before.folded), `6-rename-move: the moved note opened with other folds: ${JSON.stringify(after.folded)}`);
    const disk = await memoryOnDisk();
    const notes = disk?.notes ?? {};
    check(MOVED in notes && !(LIST in notes), `6-rename-move: the memory does not name the moved path alone: ${JSON.stringify(Object.keys(notes))}`);
    return { before, live, after, paths: Object.keys(notes) };
  });

  // Row 7: two tabs on one note — each keeps its folds while open; a map opened next takes the last change.
  await step('7-two-tabs', async () => {
    const before = await ensure(LIST_FOLDS);
    const first = await evaluate(`return window.__mappyE2E.id;`);
    const second = await openTab(list);
    const secondId = await evaluate(`return window.__mappyE2E.id;`);
    await evaluate(`window.__mappyE2E = app.workspace.getLeafById(${JSON.stringify(first)}); app.workspace.setActiveLeaf(window.__mappyE2E, { focus: true }); await new Promise(resolve => setTimeout(resolve, 400)); return true;`);
    await toggle('枝A', 1, 'click');
    const changed = await current();
    const kept = await evaluate(`${PAGE} return sig(app.workspace.getLeafById(${JSON.stringify(secondId)}));`);
    check(same(kept.folded, second.folded), `7-two-tabs: the other tab changed with this one: ${JSON.stringify(kept.folded)}`);
    await wait(1500);
    const third = await openTab(list);
    check(same(third.folded, changed.folded), `7-two-tabs: a tab opened next did not take the last change: ${JSON.stringify(third.folded)} (last ${JSON.stringify(changed.folded)})`);
    await evaluate(`for (const id of [${JSON.stringify(secondId)}]) app.workspace.getLeafById(id)?.detach(); window.__mappyE2E.detach();
      window.__mappyE2E = app.workspace.getLeafById(${JSON.stringify(first)}); app.workspace.setActiveLeaf(window.__mappyE2E, { focus: true }); return true;`);
    await ensure(LIST_FOLDS);
    return { before, second, changed, kept, third };
  });

  // Rows 8 and 9: the headings map and the 2,000-node map opened again in the same tab.
  for (const [name, path, folds] of [['8-headings', HEADINGS, HEADING_FOLDS], ['9-2000', BIG, BIG_FOLDS]]) {
    await step(name, async () => {
      await openTab(path);
      const before = await ensure(folds);
      await explorerOpen(OTHER);
      await explorerOpen(path);
      const after = await current();
      check(same(after.folded, before.folded), `${name}: the map came back with other folds: ${JSON.stringify(after.folded)}`);
      return { before, after };
    });
  }

  // Row 10: a change, then the plugin disabled and enabled at once (no wait for the throttled write).
  await step('10-plugin-toggle', async () => {
    await detachAll();
    await openTab(list);
    await ensure(LIST_FOLDS);
    // The memory holds T1 folded before the change, so only a write at the disable can hold it open.
    await wait(SETTLED);
    await toggle('T1', 1, 'click');
    const before = await current();
    await evaluate(`await app.plugins.disablePlugin('mappy'); await app.plugins.enablePlugin('mappy'); await new Promise(resolve => setTimeout(resolve, 1500)); return true;`);
    await detachAll();
    const after = await openTab(list);
    check(same(after.folded, before.folded), `10-plugin-toggle: the map opened after the plugin came back with other folds: ${JSON.stringify(after.folded)} (was ${JSON.stringify(before.folded)})`);
    await ensure(LIST_FOLDS);
    return { before, after };
  });

  // Row 11: the window reloaded (`app:reload`, Obsidian's "Reload app without saving": `location.reload()`, no quit event).
  // 11a: a change that has rested past the throttle is kept. 11b: a change made just before the reload is not on disk yet
  // and the page goes before a write started then can finish (it leaves `folds.next.json` cut, LEV-230's way): the map
  // opens as it was before that change, and the file the change would have replaced still reads (provisional, LEV-365's
  // PR: the person's decision).
  for (const [name, rest] of [['11a-reload-rested', SETTLED], ['11b-reload-at-once', 0]]) {
    await step(name, async () => {
      await wait(SETTLED);
      const settled = await current();
      await toggle('T1', 1, 'space');
      const changed = await current();
      await wait(rest);
      await evaluate(`setTimeout(() => app.commands.executeCommandById('app:reload'), 0); return true;`);
      cdp.close();
      await wait(3000);
      await reconnect();
      await wait(1500);
      const disk = await memoryOnDisk(0);
      await detachAll();
      const after = await openTab(list);
      const expected = rest > 0 ? changed : settled;
      check(same(after.folded, expected.folded), `${name}: the map after the reload showed other folds: ${JSON.stringify(after.folded)} (expected ${JSON.stringify(expected.folded)})`);
      check(disk && !('unreadable' in disk) && list in (disk.notes ?? {}), `${name}: the memory's file did not read after the reload: ${JSON.stringify(disk).slice(0, 300)}`);
      await ensure(LIST_FOLDS);
      return { settled, changed, after, files: await evaluate(`const dir = app.plugins.manifests.mappy.dir; const listed = await app.vault.adapter.list(dir);
        return await Promise.all(listed.files.filter(path => path.includes('folds')).map(async path => ({ path, size: (await app.vault.adapter.stat(path))?.size ?? null })));`) };
    });
  }

  // Row 12: a change, then Obsidian quit at once and launched again: every map as it was.
  if (!flag('--no-quit')) {
    await step('12-quit', async () => {
      if (process.platform !== 'darwin') throw new Error('12-quit launches Obsidian again after the quit, which the case does only on macOS');
      await wait(SETTLED);
      await toggle('T1', 1, 'click');
      const before = { list: await current() };
      await evaluate(`window.__mappyE2E = null; setTimeout(() => require('electron').remote.app.quit(), 0); return true;`);
      cdp.close();
      let running = true;
      for (let started = Date.now(); running && Date.now() - started < 20000; await wait(500)) {
        running = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false);
      }
      if (running) throw new Error('Obsidian was still running 20 s after app.quit()');
      quitDone = true;
      const disk = await memoryOnDisk(0);
      const launched = spawnSync('open', ['-na', OBSIDIAN_APP, '--args', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`], { encoding: 'utf8' });
      if (launched.status !== 0) throw new Error(`open could not launch Obsidian again (${launched.status}): ${launched.stderr || launched.error}`);
      quitDone = false;
      await reconnect();
      await wait(2000);
      await detachAll();
      const after = {};
      for (const [key, path] of [['list', list], ['headings', HEADINGS], ['big', BIG]]) after[key] = await openTab(path);
      check(same(after.list.folded, before.list.folded), `12-quit: the list map after the launch showed other folds: ${JSON.stringify(after.list.folded)} (was ${JSON.stringify(before.list.folded)})`);
      check(same(after.headings.folded, HEADING_FOLDS), `12-quit: the headings map after the launch showed other folds: ${JSON.stringify(after.headings.folded)}`);
      check(same(after.big.folded, BIG_FOLDS), `12-quit: the 2,000-node map after the launch showed other folds: ${JSON.stringify(after.big.folded)}`);
      return { before, onDiskAtQuit: disk ? Object.keys(disk.notes ?? {}) : null, after };
    });
  }

  // Row 13: a deleted note leaves the memory.
  await step('13-delete', async () => {
    await detachAll();
    await evaluate(`${writeNote(GONE, GONE_SOURCE)} return true;`);
    await openTab(GONE);
    await ensure(['畳む#1']);
    const kept = await memoryOnDisk();
    const had = GONE in (kept?.notes ?? {});
    await detachAll();
    await evaluate(`await app.vault.delete(app.vault.getAbstractFileByPath(${JSON.stringify(GONE)})); return true;`);
    const after = await memoryOnDisk();
    check(had, `13-delete: the memory never held the note: ${JSON.stringify(Object.keys(kept?.notes ?? {}))}`);
    check(!(GONE in (after?.notes ?? {})), `13-delete: the memory still holds the deleted note: ${JSON.stringify(Object.keys(after?.notes ?? {}))}`);
    return { had, after: Object.keys(after?.notes ?? {}) };
  });

  if (flag('--perf')) {
    // The 2,000-node map's opening and one fold's handler, on the build installed (run on the build before the fix too).
    await step('perf-open-2000', async () => {
      await detachAll();
      const times = [];
      for (let run = 0; run < 12; run += 1) {
        times.push(await evaluate(`${PAGE}
          const leaf = app.workspace.getLeaf('tab');
          const started = performance.now();
          await leaf.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(BIG)} }, active: true });
          for (;;) { const node = leaf.view.contentEl.querySelector('.mappy-node'); if (node && node.getBoundingClientRect().width > 0) break; await new Promise(resolve => requestAnimationFrame(resolve)); }
          const took = performance.now() - started;
          leaf.detach(); await new Promise(resolve => setTimeout(resolve, 300));
          return took;`));
      }
      return stats(times.slice(2));
    });
    await step('perf-fold-handler', async () => {
      await openTab(BIG);
      const sample = await evaluate(`${PAGE} const leaf = window.__mappyE2E;
        const handler = []; const frame = [];
        for (let run = 0; run < 40; run += 1) {
          const toggle = find(leaf, '第2節', 1)?.querySelector('.mappy-node-toggle');
          if (!toggle) throw new Error('no toggle on 第2節');
          const started = performance.now();
          toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          handler.push(performance.now() - started);
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          frame.push(performance.now() - started);
          await new Promise(resolve => setTimeout(resolve, 60));
        }
        return { handler, frame };`);
      return { handler: stats(sample.handler.slice(4)), frame: stats(sample.frame.slice(4)) };
    });
    await step('perf-memory-file', async () => evaluate(`
      const store = app.workspace.getLeavesOfType('mappy-map').map(leaf => leaf.view.memory).find(Boolean);
      if (!store) return { skipped: 'this build has no fold memory' };
      const folder = app.plugins.plugins.mappy.manifest.dir + '/perf-measure';
      const Store = store.constructor;
      const measure = new Store(app.vault.adapter, folder + '/folds.json', () => true);
      if (!(await app.vault.adapter.exists(folder))) await app.vault.adapter.mkdir(folder);
      await measure.load();
      const key = (note, fold) => ['第' + note + '章 計画の見出し', '節 ' + (fold % 5), '項目の題名 ' + fold];
      const set = performance.now();
      for (let note = 0; note < 1000; note += 1) {
        measure.set('Projects/分野 ' + (note % 20) + '/計画ノート ' + note + '.md', { folds: Array.from({ length: 20 }, (_, fold) => key(note, fold)), open: [] });
      }
      const setMs = performance.now() - set;
      const writes = [];
      for (let run = 0; run < 5; run += 1) {
        measure.set('Projects/分野 0/計画ノート 0.md', { folds: [key(0, run)], open: [] });
        const started = performance.now(); await measure.flush(); writes.push(performance.now() - started);
      }
      const bytes = (await app.vault.adapter.stat(folder + '/folds.json'))?.size ?? null;
      const reads = [];
      for (let run = 0; run < 5; run += 1) {
        const again = new Store(app.vault.adapter, folder + '/folds.json', () => true);
        const started = performance.now(); await again.load(); reads.push(performance.now() - started);
      }
      for (const name of await app.vault.adapter.list(folder).then(listed => listed.files)) await app.vault.adapter.remove(name);
      await app.vault.adapter.rmdir(folder, false);
      return { notes: 1000, foldsPerNote: 20, bytes, setMs, writes, reads };`));
  }
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`stopped: ${error}`);
} finally {
  if (!quitDone) {
    try { await detachAll(); } catch (error) { record.failures.push(`close maps: ${error}`); }
    if (record.steps.setup && !record.steps.setup.error && !flag('--keep')) {
      await step('clean', () => evaluate(`const folder = app.vault.getAbstractFileByPath(${JSON.stringify(FOLDER)});
        if (folder) await app.vault.delete(folder, true); return true;`));
    }
    cdp.close();
  }
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: sorted.length, median: at(0.5), p90: at(0.9), max: sorted.at(-1), min: sorted[0], values: values.map(v => Math.round(v * 10) / 10) };
}

process.exitCode = await finish(record, value('--json'));
