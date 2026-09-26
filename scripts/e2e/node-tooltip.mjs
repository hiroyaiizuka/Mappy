/**
 * E57 (docs/harness.md): no tooltip over a node (LEV-200, the real-Obsidian case of LEV-199). 本人の報告は「ノードに
 * マウスを乗せると黒い吹き出し（題名）がノードの下に出て、Enter／Tab で下に足したノードの入力欄を覆う」。LEV-199 は
 * ノードの `aria-label` をやめ（名前は `aria-labelledby` の隠し要素、呼び出したノードの「呼び出し元: …」は
 * `aria-describedby`）、残る祖先の `aria-label`（canvas の操作説明・入力欄の「ノードのテキスト」・埋め込みのマップ名）は
 * CSS 変数 `--no-tooltip: true` で止めた。ブラウザ検証ページ（`node-tooltip`・`embed-node-tooltip`）は Obsidian 1.14.2 の
 * app.js の判定を写したものなので、ここでは実機の Obsidian に実ポインター（CDP の `Input.dispatchMouseEvent`）を
 * 乗せ、Obsidian 自身が `.tooltip` を出すかを見る。
 *
 * 行列は本人の操作 × 対象の形:
 *   1. 前提（回避策が成り立つ条件）: Mappy の外に置いた `aria-label` 付きの要素に乗せると吹き出しが出て（この検出が
 *      効いていることの対照）、同じ要素に `--no-tooltip: true` を付けると出ない（Obsidian がこの印を見ていること）。
 *      マップの canvas・埋め込みの canvas の計算値が `true`、開閉ボタンが `true` でない。
 *   2. 乗せる: マップのすべてのノード（ルート・子を持つノード・子・空のノード・呼び出し元の項目・呼び出したノード）×
 *      本体（文字の外）・題名、F2 で開いた入力欄、埋め込みのすべてのノード × 本体・題名。どれも 2 s（Obsidian の
 *      吹き出しの遅延 1 s の 2 倍）待っても `.tooltip` が出ず、待ち終えた時点でもポインターがその対象の上にある
 *      （途中でノードが動いて空の canvas に乗っていたら、出ないことは何も示さない）。離れたら残らない。
 *      出ないことを見る行（3 と入力欄も）の前後には、出るはずのボタンに乗せる対照を置く（遅延に間に合わなかっただけの
 *      PASS を除く）。描かれたノードの題名が期待の一覧どおりか先に確かめる（形が黙って抜けないように）。
 *   3. 本人の報告: ノードを実クリックで選び、ポインターをいったん外してからそのノードに乗せて 2 s 待ち、そのまま
 *      Enter／Tab。乗せた時点でも、下に足したノードの入力欄が開いてさらに 2 s 待った時点でも吹き出しが出ず、その時点で
 *      ポインターがまだそのノードの上にある。吹き出しが新しいノードの箱に重なったかは記録に残す（`.tooltip` は
 *      `pointer-events: none` なので `elementFromPoint` では分からない。箱の交差で見る）。クリックの直後に押すだけでは
 *      再現しない: Obsidian は `pointerup` で吹き出しを消し、同じ要素の中の移動では `pointerover` が起きないので、修正前の
 *      ビルドでも吹き出しは出ない。
 *   4. 吹き出しを残すもの: 開閉ボタン・左下（レイアウト）・右下（ズーム）・右上（操作）のボタン、埋め込みの開閉ボタンと
 *      「マップで開く」。それぞれ自分の `aria-label` の吹き出しが出る。
 *   5. 読み上げ: Chromium のアクセシビリティツリー（CDP の `Accessibility.getPartialAXTree`）でノードの名前が題名
 *      （空なら「空のノード」）、呼び出したノードの説明が「呼び出し元: <パス>」。VoiceOver が実際に読むかは人の手で見る
 *      （このケースは確かめない）。
 *
 * 修正を戻しても通る行: 1 の前提のうち Obsidian の性質を見る 2 つ（対照の要素に出る・`--no-tooltip` で消える）と、4 のボタン
 * と各グループの対照（残すものが残ることを見る）。1 の canvas の算出値は LEV-199 の CSS を見るので、CSS を外すと落ちる。
 *
 * Usage: npm run harness:e2e:node-tooltip -- [--reload] [--json <out.json>] [--shot <file.png>] [--keep]
 *   --shot  the Enter／Tab frames go to <file>-Enter.png and <file>-Tab.png
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, viewScript, writeNote, makeOpenStep, makePluginStep, makePress, makeSelect, refuseOpenLeaves } from './dom-helpers.mjs';
import { noteName } from './excalidraw-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-node-tooltip.md';
const CALLED = 'Fixtures/E2E-node-tooltip-called.md';
const HOST = 'Fixtures/E2E-node-tooltip-host.md';
const CALLED_SOURCE = ['---', 'mappy: true', '---', '## 呼ばれたマップ', '', '- 呼ばれた子', ''].join('\n');
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 吹き出しの確認', '',
  '- 自分のノード',
  '  - 下のノード',
  '- ',
  '- 呼び出し',
  `  - ![[${noteName(CALLED)}]]`,
  '',
].join('\n');
/** The nodes each view draws (labels in document order): the shapes the hover matrix promises to cover. */
const MAP_LABELS = ['吹き出しの確認', '自分のノード', '下のノード', '空のノード', '呼び出し', '呼ばれたマップ', '呼ばれた子'];
/** The embed shows the root and its children only (the rest folded), the called map not at all. */
const EMBED_LABELS = ['吹き出しの確認', '自分のノード', '空のノード', '呼び出し'];
const HOST_SOURCE = ['# 埋め込みの吹き出し', '', `![[${noteName(NOTE)}]]`, ''].join('\n');
/**
 * How long a hover rests before the tooltips are read. Obsidian (app.js 1.14.2) shows one 1000 ms after the pointer
 * arrives (at once only if another was shown in the last 100 ms); at 1.2 s a hover right after a fit, with the map busy
 * drawing, now and then read nothing — a pass for the absence checks. Twice the delay, and a control around each group.
 */
const DWELL = 2000;
/** The embed's frame in the Markdown note the embed step opens (`window.__mappyE2EHost`), as the root VIEW reads nodes under. */
const EMBED_VIEW = viewScript(`(() => {
  const frame = window.__mappyE2EHost?.view.contentEl.querySelector('.mappy-embed');
  if (!frame) throw new Error('no embedded map');
  return frame;
})()`);

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const press = makePress(cdp, evaluate);
/** The notes this run wrote (and so may delete): a stop at `refuseOpenLeaves` leaves someone else's tab and note alone. */
const made = new Set();

/** Script: the tooltips Obsidian has on screen now (its `.tooltip` element, attached and drawn), with text and box. */
const TOOLTIPS = `Array.from(document.querySelectorAll('.tooltip')).filter(tip => tip.isConnected && tip.getBoundingClientRect().width > 0)
  .map(tip => { const r = tip.getBoundingClientRect(); return { text: tip.textContent.trim(), left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })`;
const tooltips = () => evaluate(`return ${TOOLTIPS};`);
const texts = shown => JSON.stringify(shown.map(tip => tip.text));

const move = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });

/** Polls `read` every 100 ms until `done(value)` or `timeout` ms; returns the last value read. */
async function until(read, done, timeout) {
  const started = Date.now();
  for (;;) {
    const current = await read();
    if (done(current) || Date.now() - started > timeout) return current;
    await wait(100);
  }
}

/**
 * The pointer off anything named (the window's top-left corner, the title bar); the tooltips still on screen after
 * up to 3 s, which a hover's own row reports (so a lingering one is blamed on the row that showed it).
 */
async function leave() {
  // Two moves here too: Obsidian ignores a pointerover until it has counted two mouse pointermoves (RC, never reset
  // but by a touch), and the pointerover of a hover comes before its own moves are counted. In a window just started,
  // the first hover was dropped for that — the premise's control reading no tooltip at all.
  await move(4, 2);
  await move(2, 2);
  return until(tooltips, left => left.length === 0, 3000);
}

/**
 * Hover where `locate` (script, after `view`) says: it defines `node`, the element to hover, and may define `at`
 * ({ x, y }; the centre of `node` otherwise). `makePress` aims without clicking: the topmost element there must be
 * `node` or inside it (not inside `avoid`), a Notice in the way is dismissed, anything else stops the step. Then
 * `DWELL` ms, what Obsidian shows, and whether the pointer is still on `node` (a node that moved away during the dwell
 * leaves it on the canvas, where nothing shows whatever the build). With `stay`, the pointer is left there.
 */
async function hover(locate, { avoid, view = VIEW, stay = false } = {}) {
  const before = await leave();
  if (before.length) throw new Error(`a tooltip from before this hover stays: ${texts(before)}`);
  const point = await press(locate, { avoid, view, click: false });
  // Two moves, as a hand arrives: Obsidian counts `pointermove`s of a mouse and ignores hovers before the second
  // (app.js 1.14.2 takes fewer for a touch), so a single jump would show nothing whatever the build does.
  await move(point.x - 1, point.y);
  await move(point.x, point.y);
  await wait(DWELL);
  const shown = await tooltips();
  const onTarget = await evaluate(`${view} let at; ${locate}
    const top = document.elementFromPoint(${point.x}, ${point.y});
    return !!node && !!top && node.contains(top) && ${avoid ? `!top.closest(${JSON.stringify(avoid)})` : 'true'};`);
  const lingers = stay ? [] : await leave();
  return { at: `${Math.round(point.x)},${Math.round(point.y)}`, point, tooltips: shown, onTarget, lingers };
}

/** The checks of a row whose hover must show nothing. */
function absent(label, shown) {
  check(shown.onTarget, `${label}: the pointer was no longer on its target after the dwell (it moved), so no tooltip means nothing`);
  check(shown.tooltips.length === 0, `${label}: tooltip ${texts(shown.tooltips)}`);
  check(shown.lingers.length === 0, `${label}: tooltip ${texts(shown.lingers)} stays after the pointer left`);
}

/**
 * The control around the absence rows: a button that keeps its tooltip, hovered the same way, must show it within the
 * dwell. If not, the rows beside it could have read nothing only because Obsidian had not drawn one yet.
 */
async function control(label, locate, view = VIEW) {
  const name = await evaluate(`${view} ${locate} return node?.getAttribute('aria-label') ?? null;`);
  const shown = await hover(locate, { view, stay: true });
  const found = shown.tooltips.some(tip => tip.text === name);
  // A miss is still a FAIL; how long it took past the dwell (or that it never came in 3 s more) tells a late tooltip from none.
  let late = null;
  if (!found) {
    const started = Date.now();
    const seen = await until(tooltips, now => now.some(tip => tip.text === name), 3000);
    if (seen.some(tip => tip.text === name)) late = DWELL + Date.now() - started;
  }
  const lingers = await leave();
  check(name && shown.onTarget && found,
    `${label}: control ${JSON.stringify(name)} showed ${texts(shown.tooltips)} within ${DWELL} ms (on target: ${shown.onTarget}, ${late === null ? 'none in 3 s more' : `shown at ${late} ms`}); the rows beside it prove nothing`);
  check(lingers.length === 0, `${label}: tooltip ${texts(lingers)} stays after the pointer left`);
  return { label, name, ...shown, late, lingers };
}
const MAP_CONTROL = `const node = el.querySelector('.mappy-zoom .mappy-button');`;
const EMBED_CONTROL = `const node = el.querySelector('.mappy-embed-open');`;

/** Script, after VIEW: the called map's nodes — described since LEV-199, titled on hover before it (so a reverted build finds them too). */
const CALLED_NODES = `const calledNodes = () => nodes().filter(node => node.hasAttribute('aria-describedby') || node.hasAttribute('title'));`;

/**
 * Script for `hover`: the node to hover and where. `pick` is 'own' (「自分のノード」) or 'index' (the `index`-th node
 * under the root), and `part` is 'body' (inside the node, left of its text) or 'title' (the centre of its text).
 */
const nodeTarget = (pick, part, index = 0) => `
  const picked = ${{ own: `nth('自分のノード', 0)`, index: `nodes()[${index}]` }[pick]};
  if (!picked) throw new Error('no ${pick} node #${index}');
  const content = picked.querySelector('.mappy-node-content');
  const node = ${part === 'title' ? `content.textContent.trim() ? content : picked` : 'picked'};
  ${part === 'body' ? `{ const box = picked.getBoundingClientRect(); const text = content.getBoundingClientRect();
    at = { x: box.left + Math.max(2, (text.left - box.left) / 2), y: box.top + box.height / 2 }; }` : ''}`;

/** Every node × body, title under `view`, each row named by the node's label. */
async function hoverAll(view, prefix) {
  const labels = await evaluate(`${view} return nodes().map(label);`);
  const results = [];
  for (const [index, name] of labels.entries()) {
    for (const part of ['body', 'title']) {
      const row = `${prefix}${JSON.stringify(name)}#${index}/${part}`;
      const shown = await hover(nodeTarget('index', part, index), { view, avoid: '.mappy-node-toggle' });
      absent(row, shown);
      results.push({ row, ...shown });
    }
  }
  return results;
}

const editing = () => evaluate(`${VIEW} return !!input();`);
async function waitEditing(wanted = true, timeout = 3000) {
  if (await until(editing, open => open === wanted, timeout) !== wanted) throw new Error(wanted ? 'the inline editor did not open' : 'the inline editor did not close');
  await wait(300);
}

/** The note back to SOURCE, the whole map in the pane, no draft open. */
async function restore() {
  if (await editing()) { await cdp.realKey('Escape'); await waitEditing(false); }
  await evaluate(`${VIEW}
    if (await source() !== ${JSON.stringify(SOURCE)}) { await app.vault.modify(view.file, ${JSON.stringify(SOURCE)}); await new Promise(resolve => setTimeout(resolve, 900)); }
    app.workspace.leftSplit?.collapse?.();
    app.workspace.rightSplit?.collapse?.();
    const fit = el.querySelector('.mappy-button[aria-label="全体表示"]');
    if (!fit) throw new Error('no 全体表示 button: the map cannot be fitted, and the hovers below would miss nodes out of the pane');
    fit.click();
    await new Promise(resolve => setTimeout(resolve, 600));
    return true;`);
}

/** Every node's name and description as Chromium's accessibility tree computes them (what a screen reader is given). */
async function axFacts(view) {
  await cdp.send('Accessibility.enable', {});
  const count = await evaluate(`${view} return nodes().length;`);
  const facts = [];
  for (let index = 0; index < count; index += 1) {
    const handle = await cdp.send('Runtime.evaluate', { expression: `(() => { ${view} return nodes()[${index}]; })()` });
    const attributes = await evaluate(`${view} const node = nodes()[${index}];
      return { label: label(node), ariaLabel: node.getAttribute('aria-label'), title: node.getAttribute('title'), text: node.querySelector('.mappy-node-content')?.textContent.trim() ?? '' };`);
    const tree = await cdp.send('Accessibility.getPartialAXTree', { objectId: handle.result.objectId, fetchRelatives: false });
    await cdp.send('Runtime.releaseObject', { objectId: handle.result.objectId });
    const ax = tree.nodes[0];
    facts.push({ ...attributes, role: ax?.role?.value ?? null, name: ax?.name?.value ?? null, description: ax?.description?.value ?? null });
  }
  return facts;
}

/**
 * Close what this run opened and delete the notes it wrote (`made`), the premise's probe too; nothing at all when it
 * wrote nothing (a stop at `refuseOpenLeaves`: the handles and probe may be another run's). Run from `finally`
 * (unless `--keep`), so a case stopped midway does not leave the map open: the next run's `open` would refuse it.
 */
const clean = () => made.size === 0 ? [] : evaluate(`
  document.querySelectorAll('[data-mappy-e2e-tooltip-probe]').forEach(probe => probe.remove());
  for (const path of ${JSON.stringify([HOST, NOTE, CALLED].filter(path => made.has(path)))}) {
    app.workspace.getLeavesOfType('markdown').concat(app.workspace.getLeavesOfType('mappy-map'))
      .filter(item => item.view.file?.path === path).forEach(item => item.detach());
    const file = app.vault.getAbstractFileByPath(path);
    if (file) await app.vault.delete(file, true);
  }
  delete window.__mappyE2E;
  delete window.__mappyE2EBefore;
  delete window.__mappyE2EHost;
  return ${JSON.stringify([...made])};`);

const PROBE = `document.querySelector('[data-mappy-e2e-tooltip-probe]')`;

try {
  await step('plugin', makePluginStep(cdp, evaluate, flag));
  record.chromium = await evaluate(`return navigator.userAgent.match(/Chrome\\/[\\d.]+/u)?.[0] ?? null;`).catch(() => null);
  record.obsidian = await evaluate(`return require('electron').ipcRenderer.sendSync('version') ?? null;`).catch(() => null);
  required(record, 'called', await step('called', async () => {
    await evaluate(`${refuseOpenLeaves([CALLED, HOST, NOTE])} return true;`);
    made.add(CALLED);
    return evaluate(`${writeNote(CALLED, CALLED_SOURCE)} return true;`);
  }));
  made.add(NOTE);
  required(record, 'open', await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE })));
  required(record, 'fit', await step('fit', restore));

  // 1. The premise: Obsidian draws an aria-label as a tooltip on hover, and not where `--no-tooltip` is `true`.
  required(record, 'premise', await step('premise', async () => {
    let plain; let marked;
    try {
      await evaluate(`const probe = document.body.createDiv({ attr: { 'aria-label': 'E2E 吹き出しの対照', 'data-mappy-e2e-tooltip-probe': '' } });
        // Not fixed: Obsidian draws a tooltip only for an element that isShown() (one with an offsetParent).
        Object.assign(probe.style, { position: 'absolute', left: '40%', top: '45%', width: '120px', height: '40px', zIndex: 100000, background: 'var(--background-secondary)' });
        return true;`);
      const locate = `const node = ${PROBE};`;
      plain = await hover(locate);
      await evaluate(`${PROBE}.style.setProperty('--no-tooltip', 'true'); return true;`);
      marked = await hover(locate);
    } finally {
      await evaluate(`${PROBE}?.remove(); return true;`).catch(() => {});
    }
    const css = await evaluate(`${VIEW}
      const value = element => element ? getComputedStyle(element).getPropertyValue('--no-tooltip').trim() : null;
      return { canvas: value(el.querySelector('.mappy-canvas')), toggle: value(el.querySelector('.mappy-node-toggle')), button: value(el.querySelector('.mappy-button')) };`);
    if (!plain.tooltips.some(tip => tip.text === 'E2E 吹き出しの対照')) {
      throw new Error(`no tooltip over a plain aria-label: this window does not show them, so no absence below means anything (${JSON.stringify(plain)})`);
    }
    check(marked.onTarget && marked.tooltips.length === 0, `premise: Obsidian shows a tooltip where --no-tooltip is true, so LEV-199's CSS no longer holds: ${JSON.stringify(marked)}`);
    check(css.canvas === 'true', `premise: the map canvas's --no-tooltip is ${JSON.stringify(css.canvas)}`);
    check(css.toggle !== 'true' && css.button !== 'true', `premise: a control carries --no-tooltip: ${JSON.stringify(css)}`);
    return { plain: plain.tooltips, marked: marked.tooltips, css };
  }));

  // 2. Hovering every node of the map (root, parent, child, empty, calling item, called nodes) × body, title.
  await step('hover-nodes', async () => {
    const labels = await evaluate(`${VIEW} return nodes().map(label);`);
    check(JSON.stringify(labels) === JSON.stringify(MAP_LABELS), `the map drew ${JSON.stringify(labels)}, not ${JSON.stringify(MAP_LABELS)}: a shape of the matrix is missing`);
    const calledCount = await evaluate(`${VIEW} ${CALLED_NODES} return calledNodes().length;`);
    check(calledCount >= 2, `the called map drew ${calledCount} nodes with a description (its root and child expected)`);
    const first = await control('control-before', MAP_CONTROL);
    const rows = await hoverAll(VIEW, '');
    const last = await control('control-after', MAP_CONTROL);
    return { calledCount, controls: [first, last], rows };
  });

  // 2. The inline input opened with F2 on a node, hovered.
  await step('hover-input', async () => {
    await restore();
    await select('自分のノード');
    await cdp.realKey('F2');
    await waitEditing();
    const first = await control('input-control-before', MAP_CONTROL);
    const shown = await hover(`const node = input();`);
    absent('input', shown);
    const last = await control('input-control-after', MAP_CONTROL);
    await cdp.realKey('Escape');
    await waitEditing(false);
    return { controls: [first, last], ...shown };
  });

  // 3. The report: the pointer resting on a node, Enter／Tab adds one below it, its input opens under the pointer's node.
  await step('add-under-pointer', async () => {
    const results = [];
    for (const key of ['Enter', 'Tab']) {
      await restore();
      await select('自分のノード');
      // The control after the click: Obsidian must be drawing tooltips now, or the no-tooltip reads below mean nothing.
      const first = await control(`${key}-control-before`, MAP_CONTROL);
      // The hand then rests on the node it chose: the click's tooltip is gone (pointerup), this hover is what shows one.
      const before = await hover(nodeTarget('own', 'title'), { stay: true });
      await cdp.realKey(key);
      await waitEditing();
      await wait(DWELL);
      const after = await evaluate(`${VIEW} const draft = input(); const rect = draft.closest('.mappy-node').getBoundingClientRect();
        const top = document.elementFromPoint(${before.point.x}, ${before.point.y});
        return { value: draft.value, onNode: !!top && nth('自分のノード', 0).contains(top),
          box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } };`);
      const shown = await tooltips();
      // Recorded, not a verdict of its own: a tooltip here already fails the checks below. Measured on the new node's
      // box, since the tooltip takes no pointer events and no hit test sees it.
      const covering = shown.filter(tip => tip.left < after.box.right && tip.right > after.box.left && tip.top < after.box.bottom && tip.bottom > after.box.top);
      check(before.onTarget && before.tooltips.length === 0, `${key}: tooltip ${texts(before.tooltips)} with the pointer on the node before the key (on target: ${before.onTarget})`);
      check(after.onNode, `${key}: after the new node opened the pointer is no longer on 自分のノード (the map moved), so no tooltip means nothing`);
      check(shown.length === 0, `${key}: tooltip ${texts(shown)} with the pointer on the node after the new one opened${covering.length ? ', covering the new node' : ''}`);
      const shot = value('--shot');
      if (shot) await cdp.screenshot(`${shot.replace(/\.png$/u, '')}-${key}.png`);
      const lingers = await leave();
      check(lingers.length === 0, `${key}: tooltip ${texts(lingers)} stays after the pointer left`);
      // And after: a tooltip Obsidian was slow to draw would have shown by now on the control.
      const last = await control(`${key}-control-after`, MAP_CONTROL);
      await cdp.realKey('Escape');
      await waitEditing(false);
      results.push({ key, controls: [first, last], before: before.tooltips, tooltips: shown, covering: covering.length, draft: after });
    }
    return results;
  });

  // 4. What keeps its tooltip: the fold control and the map's buttons.
  await step('hover-controls', async () => {
    await restore();
    const results = [];
    for (const [id, locate] of [
      ['toggle', `const node = nth('自分のノード', 0).querySelector('.mappy-node-toggle');`],
      ['bottom-left', `const node = el.querySelector('.mappy-modes .mappy-button');`],
      ['bottom-right', MAP_CONTROL],
      ['top-right', `const node = el.querySelector('.mappy-actions .mappy-button');`],
    ]) results.push(await control(id, locate));
    return results;
  });

  // 5. What a screen reader is given (the attributes and Chromium's computed name and description).
  await step('accessible-names', async () => {
    await restore();
    const facts = await axFacts(VIEW);
    const calledPath = `呼び出し元: ${CALLED}`;
    for (const fact of facts) {
      const wanted = fact.text || '空のノード';
      check(fact.ariaLabel === null && fact.title === null, `${wanted}: aria-label ${JSON.stringify(fact.ariaLabel)}, title ${JSON.stringify(fact.title)} (a tooltip's source)`);
      check(fact.role === 'treeitem' && fact.name === wanted, `${wanted}: accessible ${fact.role} named ${JSON.stringify(fact.name)}`);
      if (fact.description) check(fact.description === calledPath, `${wanted}: described as ${JSON.stringify(fact.description)}`);
    }
    check(facts.some(fact => fact.name === '空のノード'), 'no node is named 空のノード');
    check(facts.filter(fact => fact.description === calledPath).length >= 2, `the called nodes are not described as ${calledPath}`);
    return facts;
  });

  // 2, 4 and 5 in an embed: a Markdown note (reading view) that embeds the map.
  await step('embed', async () => {
    made.add(HOST);
    await evaluate(`${writeNote(HOST, HOST_SOURCE)}
      const leaf = app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: 'markdown', state: { file: ${JSON.stringify(HOST)}, mode: 'preview' }, active: true });
      window.__mappyE2EHost = leaf;
      for (let i = 0; i < 40 && !leaf.view.contentEl.querySelector('.mappy-embed .mappy-node'); i += 1) await new Promise(resolve => setTimeout(resolve, 150));
      await new Promise(resolve => setTimeout(resolve, 600));
      return true;`);
    const labels = await evaluate(`${EMBED_VIEW} return nodes().map(label);`);
    check(JSON.stringify(labels) === JSON.stringify(EMBED_LABELS), `the embed drew ${JSON.stringify(labels)}, not ${JSON.stringify(EMBED_LABELS)}`);
    const first = await control('embed-control-before', EMBED_CONTROL, EMBED_VIEW);
    const rows = await hoverAll(EMBED_VIEW, 'embed ');
    const last = await control('embed-control-after', EMBED_CONTROL, EMBED_VIEW);
    const toggle = await control('embed-toggle', `const node = el.querySelector('.mappy-node-toggle:not([hidden])');`, EMBED_VIEW);
    const css = await evaluate(`${EMBED_VIEW} return getComputedStyle(el.querySelector('.mappy-canvas')).getPropertyValue('--no-tooltip').trim();`);
    check(css === 'true', `premise: the embed canvas's --no-tooltip is ${JSON.stringify(css)}`);
    const facts = await axFacts(EMBED_VIEW);
    for (const fact of facts) {
      check(fact.ariaLabel === null && fact.title === null && fact.name === (fact.text || '空のノード'), `embed ${JSON.stringify(fact.text)}: ${JSON.stringify(fact)}`);
    }
    return { controls: [first, last, toggle], rows, css, names: facts };
  });
} catch (error) {
  if (!(error instanceof StopCase)) {
    // An error outside a step still ends as a FAIL with a record, not an unhandled rejection with none.
    record.failures.push(`uncaught: ${error}`);
    record.stopped = String(error);
  }
} finally {
  await move(2, 2).catch(() => {});
  if (!flag('--keep')) await step('clean', clean);
  cdp.close();
}

process.exit(await finish(record, value('--json')));
