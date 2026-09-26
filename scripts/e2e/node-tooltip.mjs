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
 *   2. 乗せる: 自分のノード・空のノード・呼び出したノード × 本体（文字の外）・題名、F2 で開いた入力欄、埋め込みのノード
 *      × 本体・題名。どれも 2 s（Obsidian の吹き出しの遅延 1 s の 2 倍）待っても `.tooltip` が出ない。
 *   3. 本人の報告: ノードを実クリックで選び、ポインターをいったん外してからそのノードに乗せて 2 s 待ち、そのまま
 *      Enter／Tab。乗せた時点でも、下に足したノードの入力欄が開いてさらに 2 s 待った時点でも吹き出しが出ず、どの
 *      吹き出しも新しいノードの箱に重ならないこと（`.tooltip` は `pointer-events: none` なので、`elementFromPoint` では
 *      覆われたかを判定できない。箱の交差で見る）。クリックの直後に押すだけでは再現しない: Obsidian は `pointerup` で
 *      吹き出しを消し、同じ要素の中の移動では `pointerover` が起きないので、修正前のビルドでも吹き出しは出ない。
 *   4. 吹き出しを残すもの: 開閉ボタン・左下（レイアウト）・右下（ズーム）・右上（操作）のボタン、埋め込みの開閉ボタンと
 *      「マップで開く」。それぞれ自分の `aria-label` の吹き出しが出る。
 *   5. 読み上げ: Chromium のアクセシビリティツリー（CDP の `Accessibility.getPartialAXTree`）でノードの名前が題名
 *      （空なら「空のノード」）、呼び出したノードの説明が「呼び出し元: <パス>」。VoiceOver が実際に読むかは人の手で見る
 *      （このケースは確かめない）。
 *
 * 修正を戻しても通る行: 1 の前提（Obsidian の性質を見る）と 4 のボタン（残すものが残ることを見る）。
 *
 * Usage: npm run harness:e2e:node-tooltip -- [--reload] [--json <out.json>] [--shot <dir>] [--keep]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, viewScript, makeOpenStep, makePluginStep, makePress, makeSelect, refuseOpenLeaves } from './dom-helpers.mjs';

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
  `  - ![[${CALLED.replace(/^Fixtures\//u, '').replace(/\.md$/u, '')}]]`,
  '',
].join('\n');
const HOST_SOURCE = ['# 埋め込みの吹き出し', '', `![[${NOTE.replace(/^Fixtures\//u, '').replace(/\.md$/u, '')}]]`, ''].join('\n');
/**
 * How long a hover rests before the tooltips are read. Obsidian (app.js 1.14.2) shows one 1000 ms after the pointer
 * arrives (at once only if another was shown in the last 100 ms); at 1.2 s a hover right after a fit, with the map busy
 * drawing, now and then read nothing — a pass for the absence checks. Twice the delay.
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

/** Script: the tooltips Obsidian has on screen now (its `.tooltip` element, attached and drawn), with text and box. */
const TOOLTIPS = `Array.from(document.querySelectorAll('.tooltip')).filter(tip => tip.isConnected && tip.getBoundingClientRect().width > 0)
  .map(tip => { const r = tip.getBoundingClientRect(); return { text: tip.textContent.trim(), left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })`;
const tooltips = () => evaluate(`return ${TOOLTIPS};`);
const texts = shown => JSON.stringify(shown.map(tip => tip.text));

const move = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });

/**
 * The pointer off anything named (the window's top-left corner, the title bar), until no tooltip is left from
 * the last hover: each hover then starts from none, so a tooltip seen after it is that hover's.
 */
async function away() {
  await move(2, 2);
  const started = Date.now();
  for (;;) {
    const left = await tooltips();
    if (left.length === 0) return;
    if (Date.now() - started > 3000) throw new Error(`a tooltip stays after the pointer left: ${JSON.stringify(left)}`);
    await wait(100);
  }
}

/**
 * Hover where `locate` (script, after `view`) says: it defines `node`, the element to hover, and may define `at`
 * ({ x, y }; the centre of `node` otherwise). `makePress` aims without clicking: the topmost element there must be
 * `node` or inside it (not inside `avoid`), a Notice in the way is dismissed, anything else stops the step. Then
 * `DWELL` ms, and what Obsidian shows.
 */
async function hover(locate, { avoid, view = VIEW } = {}) {
  await away();
  const point = await press(locate, { avoid, view, click: false });
  // Two moves, as a hand arrives: Obsidian counts `pointermove`s of a mouse and ignores hovers before the second
  // (app.js 1.14.2 takes fewer for a touch), so a single jump would show nothing whatever the build does.
  await move(point.x - 1, point.y);
  await move(point.x, point.y);
  await wait(DWELL);
  return { at: `${Math.round(point.x)},${Math.round(point.y)}`, tooltips: await tooltips() };
}

/** Script, after VIEW: the called map's nodes — described since LEV-199, titled on hover before it (so a reverted build finds them too). */
const CALLED_NODES = `const calledNodes = () => nodes().filter(node => node.hasAttribute('aria-describedby') || node.hasAttribute('title'));`;

/**
 * Script for `hover`: the node to hover and where. `pick` is 'own' (「自分のノード」), 'empty' (the untitled one),
 * 'called' (the `index`-th node of the called map) or 'index' (the `index`-th node under the root, for the embed), and
 * `part` is 'body' (inside the node, left of its text) or 'title' (the centre of its text).
 */
const nodeTarget = (pick, part, index = 0) => `${CALLED_NODES}
  const picked = ${{ own: `nth('自分のノード', 0)`, empty: `nth('空のノード', 0)`, called: `calledNodes()[${index}]`, index: `nodes()[${index}]` }[pick]};
  if (!picked) throw new Error('no ${pick} node #${index}');
  const content = picked.querySelector('.mappy-node-content');
  const node = ${part === 'title' ? `content.textContent.trim() ? content : picked` : 'picked'};
  ${part === 'body' ? `{ const box = picked.getBoundingClientRect(); const text = content.getBoundingClientRect();
    at = { x: box.left + Math.max(2, (text.left - box.left) / 2), y: box.top + box.height / 2 }; }` : ''}`;

const editing = () => evaluate(`${VIEW} return !!input();`);
async function waitEditing(wanted = true, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await editing() === wanted) { await wait(300); return; }
    await wait(100);
  }
  throw new Error(wanted ? 'the inline editor did not open' : 'the inline editor did not close');
}

/** The note back to SOURCE, the whole map in the pane, no draft open. */
async function restore() {
  if (await editing()) { await cdp.realKey('Escape'); await waitEditing(false); }
  await evaluate(`${VIEW}
    if (await source() !== ${JSON.stringify(SOURCE)}) { await app.vault.modify(view.file, ${JSON.stringify(SOURCE)}); await new Promise(resolve => setTimeout(resolve, 900)); }
    app.workspace.leftSplit?.collapse?.();
    app.workspace.rightSplit?.collapse?.();
    el.querySelector('.mappy-button[aria-label="全体表示"]')?.click();
    await new Promise(resolve => setTimeout(resolve, 600));
    return true;`);
  return true;
}

/** Every node's name and description as Chromium's accessibility tree computes them (what a screen reader is given). */
async function axFacts(view) {
  await cdp.send('Accessibility.enable', {});
  const count = await evaluate(`${view} return nodes().length;`);
  const facts = [];
  for (let index = 0; index < count; index += 1) {
    const handle = await cdp.send('Runtime.evaluate', { expression: `(() => { ${view} return nodes()[${index}]; })()` });
    const attributes = await evaluate(`${view} const node = nodes()[${index}];
      return { label: label(node), ariaLabel: node.getAttribute('aria-label'), title: node.closest('[title]')?.getAttribute('title') ?? null, text: node.querySelector('.mappy-node-content')?.textContent.trim() ?? '' };`);
    const tree = await cdp.send('Accessibility.getPartialAXTree', { objectId: handle.result.objectId, fetchRelatives: false });
    await cdp.send('Runtime.releaseObject', { objectId: handle.result.objectId });
    const ax = tree.nodes[0];
    facts.push({ ...attributes, role: ax?.role?.value ?? null, name: ax?.name?.value ?? null, description: ax?.description?.value ?? null });
  }
  return facts;
}

/**
 * Close what this run opened and delete its notes, the premise's probe too. Run from `finally` (unless `--keep`), so a
 * case stopped midway does not leave the map open: the next run's `open` would refuse it.
 */
const clean = () => evaluate(`
  document.querySelectorAll('[data-mappy-e2e-tooltip-probe]').forEach(probe => probe.remove());
  for (const path of ${JSON.stringify([HOST, NOTE, CALLED])}) {
    app.workspace.getLeavesOfType('markdown').concat(app.workspace.getLeavesOfType('mappy-map'))
      .filter(item => item.view.file?.path === path).forEach(item => item.detach());
    const file = app.vault.getAbstractFileByPath(path);
    if (file) await app.vault.delete(file, true);
  }
  delete window.__mappyE2E;
  delete window.__mappyE2EBefore;
  delete window.__mappyE2EHost;
  return true;`);

const PROBE = `document.querySelector('[data-mappy-e2e-tooltip-probe]')`;

try {
  await step('plugin', makePluginStep(cdp, evaluate, flag));
  record.chromium = await evaluate(`return navigator.userAgent.match(/Chrome\\/[\\d.]+/u)?.[0] ?? null;`).catch(() => null);
  record.obsidian = await evaluate(`return require('electron').ipcRenderer.sendSync('version') ?? null;`).catch(() => null);
  required(record, 'called', await step('called', () => evaluate(`${refuseOpenLeaves([CALLED, HOST])}
    const existing = app.vault.getAbstractFileByPath(${JSON.stringify(CALLED)});
    if (existing) await app.vault.modify(existing, ${JSON.stringify(CALLED_SOURCE)});
    else await app.vault.create(${JSON.stringify(CALLED)}, ${JSON.stringify(CALLED_SOURCE)});
    await new Promise(resolve => setTimeout(resolve, 400));
    return true;`)));
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
    check(marked.tooltips.length === 0, `premise: Obsidian shows a tooltip where --no-tooltip is true, so LEV-199's CSS no longer holds: ${JSON.stringify(marked.tooltips)}`);
    check(css.canvas === 'true', `premise: the map canvas's --no-tooltip is ${JSON.stringify(css.canvas)}`);
    check(css.toggle !== 'true' && css.button !== 'true', `premise: a control carries --no-tooltip: ${JSON.stringify(css)}`);
    return { plain: plain.tooltips, marked: marked.tooltips, css };
  }));

  // 2. Hovering the map's nodes: own, empty, called × body, title.
  await step('hover-nodes', async () => {
    const results = [];
    const calledCount = await evaluate(`${VIEW} ${CALLED_NODES} return calledNodes().length;`);
    check(calledCount >= 2, `the called map drew ${calledCount} nodes with a description (its root and child expected)`);
    const targets = [['own', 0], ['empty', 0], ...Array.from({ length: calledCount }, (_, index) => ['called', index])];
    for (const [pick, index] of targets) {
      for (const part of ['body', 'title']) {
        const label = `${pick}${pick === 'called' ? `#${index}` : ''}/${part}`;
        const shown = await hover(nodeTarget(pick, part, index), { avoid: '.mappy-node-toggle' });
        check(shown.tooltips.length === 0, `${label}: tooltip ${texts(shown.tooltips)} over the node`);
        results.push({ label, ...shown });
      }
    }
    return results;
  });

  // 2. The inline input opened with F2 on a node, hovered.
  await step('hover-input', async () => {
    await restore();
    await select('自分のノード');
    await cdp.realKey('F2');
    await waitEditing();
    const shown = await hover(`const node = input();`);
    check(shown.tooltips.length === 0, `input: tooltip ${texts(shown.tooltips)} over the inline input`);
    await cdp.realKey('Escape');
    await waitEditing(false);
    return shown;
  });

  // 3. The report: the pointer resting on a node, Enter／Tab adds one below it, its input opens under the pointer's node.
  await step('add-under-pointer', async () => {
    const results = [];
    for (const key of ['Enter', 'Tab']) {
      await restore();
      await select('自分のノード');
      // The hand then rests on the node it chose: the click's tooltip is gone (pointerup), this hover is what shows one.
      const before = await hover(nodeTarget('own', 'title'));
      await cdp.realKey(key);
      await waitEditing();
      await wait(DWELL);
      // Covering is judged on the new node's box: the tooltip takes no pointer events, so no hit test sees it.
      const box = await evaluate(`${VIEW} const draft = input(); const rect = draft.closest('.mappy-node').getBoundingClientRect();
        return { value: draft.value, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };`);
      const shown = await tooltips();
      const shot = value('--shot');
      if (shot) await cdp.screenshot(`${shot}/node-tooltip-${key}.png`);
      const covers = tip => tip.left < box.right && tip.right > box.left && tip.top < box.bottom && tip.bottom > box.top;
      const covering = [...before.tooltips, ...shown].filter(covers);
      check(before.tooltips.length === 0, `${key}: tooltip ${texts(before.tooltips)} with the pointer on the node before the key`);
      check(shown.length === 0, `${key}: tooltip ${texts(shown)} with the pointer on the node after the new one opened`);
      check(covering.length === 0, `${key}: tooltip ${texts(covering)} covers the new node`);
      await cdp.realKey('Escape');
      await waitEditing(false);
      results.push({ key, before: before.tooltips, tooltips: shown, covering: covering.length, draft: box });
    }
    return results;
  });

  // 4. What keeps its tooltip: the fold control and the map's buttons.
  await step('hover-controls', async () => {
    await restore();
    const results = [];
    const controls = [
      ['toggle', `const node = nth('自分のノード', 0).querySelector('.mappy-node-toggle');`],
      ['bottom-left', `const node = el.querySelector('.mappy-modes .mappy-button');`],
      ['bottom-right', `const node = el.querySelector('.mappy-zoom .mappy-button');`],
      ['top-right', `const node = el.querySelector('.mappy-actions .mappy-button');`],
    ];
    for (const [id, locate] of controls) {
      const name = await evaluate(`${VIEW} ${locate} return node?.getAttribute('aria-label') ?? null;`);
      const shown = await hover(locate);
      check(name && shown.tooltips.some(tip => tip.text === name), `${id}: ${JSON.stringify(name)} expected, tooltips ${texts(shown.tooltips)}`);
      results.push({ id, name, ...shown });
    }
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
    await evaluate(`${refuseOpenLeaves([HOST])}
      const existing = app.vault.getAbstractFileByPath(${JSON.stringify(HOST)});
      if (existing) await app.vault.modify(existing, ${JSON.stringify(HOST_SOURCE)});
      else await app.vault.create(${JSON.stringify(HOST)}, ${JSON.stringify(HOST_SOURCE)});
      const leaf = app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: 'markdown', state: { file: ${JSON.stringify(HOST)}, mode: 'preview' }, active: true });
      window.__mappyE2EHost = leaf;
      for (let i = 0; i < 40 && !leaf.view.contentEl.querySelector('.mappy-embed .mappy-node'); i += 1) await new Promise(resolve => setTimeout(resolve, 150));
      await new Promise(resolve => setTimeout(resolve, 600));
      return true;`);
    const count = await evaluate(`${EMBED_VIEW} return nodes().length;`);
    check(count >= 3, `the embed drew ${count} nodes`);
    const results = [];
    for (let index = 0; index < count; index += 1) {
      for (const part of ['body', 'title']) {
        const shown = await hover(nodeTarget('index', part, index), { view: EMBED_VIEW, avoid: '.mappy-node-toggle' });
        check(shown.tooltips.length === 0, `embed node #${index}/${part}: tooltip ${texts(shown.tooltips)}`);
        results.push({ label: `embed#${index}/${part}`, ...shown });
      }
    }
    for (const [id, locate] of [
      ['embed-toggle', `const node = el.querySelector('.mappy-node-toggle:not([hidden])');`],
      ['embed-open', `const node = el.querySelector('.mappy-embed-open');`],
    ]) {
      const name = await evaluate(`${EMBED_VIEW} ${locate} return node?.getAttribute('aria-label') ?? null;`);
      const shown = await hover(locate, { view: EMBED_VIEW });
      check(name && shown.tooltips.some(tip => tip.text === name), `${id}: ${JSON.stringify(name)} expected, tooltips ${texts(shown.tooltips)}`);
      results.push({ label: id, name, ...shown });
    }
    const css = await evaluate(`${EMBED_VIEW} return getComputedStyle(el.querySelector('.mappy-canvas')).getPropertyValue('--no-tooltip').trim();`);
    check(css === 'true', `premise: the embed canvas's --no-tooltip is ${JSON.stringify(css)}`);
    const facts = await axFacts(EMBED_VIEW);
    for (const fact of facts) {
      check(fact.ariaLabel === null && fact.title === null && fact.name === (fact.text || '空のノード'), `embed ${JSON.stringify(fact.text)}: ${JSON.stringify(fact)}`);
    }
    await away();
    return { hovers: results, css, names: facts };
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
