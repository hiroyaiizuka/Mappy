/**
 * E81 (docs/harness.md): Obsidian's page preview for a link on a map (LEV-265). 本人の要望は「マップのノードのリンクに
 * マウスを乗せると、Markdown の画面と同じくリンク先が小窓で覗ける」。マップは Page preview のソース `mappy` を登録し
 * （`registerHoverLinkSource`）、内部リンクに乗ったら `workspace.trigger('hover-link', …)` を送る。小窓を出すか
 * （⌘／Ctrl が要るか）は Page preview の判断なので、ここでは実機の Obsidian に実ポインター（CDP の
 * `Input.dispatchMouseEvent`。⌘ は同じイベントの `modifiers`）を乗せ、Obsidian 自身が `.hover-popover` を出すか、
 * 出たならリンク先の中身か（元ファイルからの解決）を見る。
 *
 * 行列は本人の操作 × 対象の形:
 *   1. 前提: ページプレビューが有効、ソース `mappy` が登録され既定で ⌘ が要る（`defaultMod: true`）。Markdown の閲覧
 *      モードの同じリンクに ⌘ で乗せると小窓が出る（この検出が効いていることの対照）。
 *   2. マップのタブ: 内部リンク・見出し（`#見出し`）・ブロック参照（`#^id`）・別名（`[[a|b]]`）・画像の添付・本文の
 *      リンク × ⌘ あり（出る。中身がリンク先どおり）・⌘ なし（出ない）。外部リンク（http）は ⌘ でも出ない。
 *   3. 元ファイルからの解決: 同じ名前のノート `同名` が host と called の 2 つのフォルダにあり、マップのタブのリンクは
 *      host の、呼び出した枝のリンクは called の中身を出す。
 *   4. 並べた表示（同じマップを右に分割）・埋め込み（閲覧モードとライブプレビュー）× ⌘ あり・なし。埋め込みでは
 *      周りの閲覧モードが同じリンクをもう一度出さない（小窓は 1 つ）。
 *   5. 設定: このソースの「⌘ が要る」を切ると ⌘ なしで出る。戻すと出ない。
 *   6. 出さないもの・閉じるもの: F2 で入力欄を開いている間（別のノードのリンクに ⌘ で乗せても出ない）、ノードの
 *      ドラッグ中・空のキャンバスのパン中（ボタンを押したまま ⌘ でリンクの上を通る）、出ている小窓はホイールで閉じる。
 *      クリックはリンクを開き、⌘ クリックは新しいタブで開く。
 *   7. 寿命: 小窓が出たままタブを閉じると消え、プラグインを無効にすると消えてソースの登録も消える（有効に戻す）。
 *
 * 修正を戻しても通る行: 1 の Markdown の対照、2 の ⌘ なし・外部リンク、6 の出さない行とクリック（出ないことを見る行は
 * 修正前のビルドでも出ない）。出る行（2・3・4・5 の ⌘ あり、7）は修正前のビルドで落ちる。
 *
 * Usage: npm run harness:e2e:link-preview -- [--reload] [--json <out.json>] [--shot <file.png>] [--keep]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, viewScript, writeNote, makePluginStep, makePress, refuseOpenLeaves, PNG_FIXTURE } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const DIR = 'Fixtures/E2E-link-preview';
const NOTE = `${DIR}/host/E2E-link-preview.md`;
const TARGET = `${DIR}/host/E2E-link-preview-target.md`;
const HOST_SAME = `${DIR}/host/同名.md`;
const CALLED = `${DIR}/called/E2E-link-preview-called.md`;
const CALLED_SAME = `${DIR}/called/同名.md`;
const IMAGE = `${DIR}/host/E2E-link-preview.png`;
const READING = `${DIR}/host/E2E-link-preview-reading.md`;
const NOTES = [NOTE, TARGET, HOST_SAME, CALLED, CALLED_SAME, READING];

const TARGET_SOURCE = ['冒頭の段落 E2E-TOP', '', '# 見出し', '', '見出しの本文 E2E-HEADING', '', '# 別の見出し', '', 'ブロックの本文 E2E-BLOCK ^blk', ''].join('\n');
const SOURCE = [
  '---', 'mappy: true', '---',
  '## プレビューの確認',
  '- [[E2E-link-preview-target]]',
  '- [[E2E-link-preview-target#見出し]]',
  '- [[E2E-link-preview-target#^blk]]',
  '- [[E2E-link-preview-target|別名]]',
  '- [[E2E-link-preview.png]]',
  '- 本文を持つ',
  '  [[同名]]',
  '- [外部](https://example.com/)',
  '- ![[E2E-link-preview-called]]',
  '',
].join('\n');
const CALLED_SOURCE = ['---', 'mappy: true', '---', '## 呼ばれたマップ', '- [[同名]]', ''].join('\n');
const READING_SOURCE = ['# 閲覧', '', '本文の [[E2E-link-preview-target]] リンク', '', '![[E2E-link-preview]]', ''].join('\n');

/** How long an absence row waits (Page preview shows after ~300 ms), and how long a show row may take. */
const DWELL = 1500;
const SHOW_WITHIN = 3000;
const META = 4;

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const press = makePress(cdp, evaluate);
const made = new Set();

/** Script: the popovers on screen (attached and drawn) with their text and whether they hold an image. */
const POPOVERS = `Array.from(document.querySelectorAll('.hover-popover')).filter(p => p.isConnected && p.getBoundingClientRect().width > 0)
  .map(p => ({ text: p.textContent.replace(/\\s+/gu, ' ').trim().slice(0, 200), image: !!p.querySelector('img') }))`;
const popovers = () => evaluate(`return ${POPOVERS};`);

const move = (x, y, modifiers = 0, buttons = 0) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers, buttons, ...(buttons ? { button: 'left' } : {}) });

async function until(read, done, timeout) {
  const started = Date.now();
  for (;;) {
    const current = await read();
    if (done(current) || Date.now() - started > timeout) return current;
    await wait(100);
  }
}

/** The pointer to the title bar corner and the popovers gone (Page preview closes one the pointer left). */
async function leave() {
  await move(4, 2);
  await move(2, 2);
  return until(popovers, shown => shown.length === 0, 3000);
}

/** Script, after `view`: the `index`-th internal link whose data-href is `href` (text `text` if given). */
const linkTarget = (href, { text, index = 0 } = {}) => `const node = Array.from(el.querySelectorAll('a.internal-link'))
  .filter(a => a.dataset.href === ${JSON.stringify(href)} ${text ? `&& a.textContent.trim() === ${JSON.stringify(text)}` : ''})[${index}];`;

/**
 * Hover where `locate` says, as a hand arrives (two moves), with ⌘ held when `mod`; then either wait for a popover
 * (`expect: true`, up to SHOW_WITHIN) or DWELL ms. Reports what showed and whether the pointer is still on the target.
 */
async function hover(locate, { view = VIEW, mod = false, expect = true, stay = false } = {}) {
  const before = await leave();
  if (before.length) throw new Error(`a popover from before this hover stays: ${JSON.stringify(before)}`);
  const point = await press(locate, { view, click: false });
  const modifiers = mod ? META : 0;
  await move(point.x - 2, point.y, modifiers);
  await move(point.x, point.y, modifiers);
  const shown = expect ? await until(popovers, now => now.length > 0, SHOW_WITHIN) : (await wait(DWELL), await popovers());
  const onTarget = await evaluate(`${view} ${locate} const top = document.elementFromPoint(${point.x}, ${point.y});
    return !!node && !!top && node.contains(top);`);
  const lingers = stay ? [] : await leave();
  return { at: `${Math.round(point.x)},${Math.round(point.y)}`, point, popovers: shown, onTarget, lingers };
}

/** A row that must show one popover holding `marker` (or an image). */
function shows(label, shown, marker) {
  check(shown.onTarget, `${label}: the pointer was not on the link after the hover`);
  check(shown.popovers.length === 1, `${label}: ${shown.popovers.length} popovers ${JSON.stringify(shown.popovers)}`);
  const found = marker === 'image' ? shown.popovers.some(p => p.image) : shown.popovers.some(p => p.text.includes(marker));
  check(found, `${label}: the popover does not show ${marker}: ${JSON.stringify(shown.popovers)}`);
  check(shown.lingers.length === 0, `${label}: the popover stays after the pointer left`);
}

function absent(label, shown) {
  check(shown.onTarget, `${label}: the pointer was not on the link after the dwell, so no popover means nothing`);
  check(shown.popovers.length === 0, `${label}: popover ${JSON.stringify(shown.popovers)}`);
}

/**
 * Page preview's switch for our source: `options[source]` of its instance, `true` when ⌘ is needed, absent for the
 * source's `defaultMod` (Obsidian 1.14.3 app.js, `onHoverLink`). Saved as its settings tab does, through the core
 * plugin's `saveData`. The value found at the start (`original`) is what `clean` puts back.
 */
const PREVIEW = `const preview = app.internalPlugins.getPluginById('page-preview');`;
let original = null;
const setMod = needed => evaluate(`${PREVIEW}
  const options = preview.instance.options;
  if (${needed === undefined ? 'true' : 'false'}) delete options.mappy; else options.mappy = ${Boolean(needed)};
  await preview.saveData?.(options);
  return { options: { ...options } };`);

/** The map's leaves this run opened; `window.__mappyE2E` is the tab under test (VIEW). */
const openMap = (key, direction) => evaluate(`
  const leaf = ${direction ? `app.workspace.getLeaf('split', ${JSON.stringify(direction)})` : `app.workspace.getLeaf('tab')`};
  await leaf.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(NOTE)}, layout: 'mindmap' }, active: true });
  window[${JSON.stringify(key)}] = leaf;
  for (let i = 0; i < 40 && !leaf.view.contentEl.querySelector('a.internal-link'); i += 1) await new Promise(r => setTimeout(r, 150));
  await new Promise(r => setTimeout(r, 800));
  leaf.view.contentEl.querySelector('.mappy-button[aria-label="全体表示"]')?.click();
  await new Promise(r => setTimeout(r, 600));
  return leaf.view.contentEl.querySelectorAll('a.internal-link').length;`);

const SPLIT_VIEW = viewScript('window.__mappyE2ESplit.view.contentEl');
const EMBED_VIEW = viewScript(`(() => {
  const frame = window.__mappyE2EHost?.view.contentEl.querySelector('.mappy-embed');
  if (!frame) throw new Error('no embedded map');
  return frame;
})()`);
const HOST_VIEW = viewScript('window.__mappyE2EHost.view.contentEl');

const clean = () => made.size === 0 ? [] : evaluate(`
  for (const key of ['__mappyE2E', '__mappyE2ESplit', '__mappyE2EHost', '__mappyE2EOpened']) { try { window[key]?.detach(); } catch {} delete window[key]; }
  for (const path of ${JSON.stringify([...NOTES, IMAGE])}) {
    if (!${JSON.stringify([...made])}.includes(path)) continue;
    app.workspace.getLeavesOfType('markdown').concat(app.workspace.getLeavesOfType('mappy-map'))
      .filter(item => item.view.file?.path === path).forEach(item => item.detach());
    const file = app.vault.getAbstractFileByPath(path);
    if (file) await app.vault.delete(file, true);
  }
  for (const folder of ${JSON.stringify([`${DIR}/host`, `${DIR}/called`, DIR])}) {
    const item = app.vault.getAbstractFileByPath(folder);
    if (item && item.children?.length === 0) await app.vault.delete(item, true);
  }
  ${PREVIEW} const options = preview?.instance?.options;
  if (options) { if (${JSON.stringify(original)} === null) delete options.mappy; else options.mappy = ${JSON.stringify(original)}; await preview.saveData?.(options); }
  return ${JSON.stringify([...made])};`);

try {
  await step('plugin', makePluginStep(cdp, evaluate, flag));
  record.obsidian = await evaluate(`return require('electron').ipcRenderer.sendSync('version') ?? null;`).catch(() => null);
  required(record, 'notes', await step('notes', async () => {
    await evaluate(`${refuseOpenLeaves(NOTES)} return true;`);
    for (const path of [...NOTES, IMAGE]) made.add(path);
    await evaluate(`for (const folder of ${JSON.stringify([DIR, `${DIR}/host`, `${DIR}/called`])}) if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
      if (!app.vault.getAbstractFileByPath(${JSON.stringify(IMAGE)})) await app.vault.createBinary(${JSON.stringify(IMAGE)}, ${PNG_FIXTURE}.buffer);
      return true;`);
    // The called map and the notes it links to before the host that calls it, so the first draw finds them all.
    for (const [path, text] of [[TARGET, TARGET_SOURCE], [HOST_SAME, 'ホストの隣 E2E-HOST-SAME\n'], [CALLED_SAME, '呼び出し先の隣 E2E-CALLED-SAME\n'],
      [CALLED, CALLED_SOURCE], [NOTE, SOURCE], [READING, READING_SOURCE]]) await evaluate(`${writeNote(path, text)} return true;`);
    return true;
  }));

  // 1. The premise.
  required(record, 'premise', await step('premise', async () => {
    const state = await evaluate(`${PREVIEW}
      return { enabled: !!preview?.enabled, source: app.workspace.hoverLinkSources?.mappy ?? null, option: preview?.instance?.options && Object.hasOwn(preview.instance.options, 'mappy') ? preview.instance.options.mappy : null };`);
    if (!state.enabled) throw new Error(`Page preview is off in this vault: ${JSON.stringify(state)}. Turn it on (Settings → Core plugins) and retry.`);
    check(state.source?.display === 'Mappy' && state.source?.defaultMod === true, `the source mappy is ${JSON.stringify(state.source)}, not { display: Mappy, defaultMod: true }`);
    original = state.option;
    // The default (no option of our own): ⌘ needed, as `defaultMod` says.
    await setMod(undefined);
    // The control: a link in a Markdown note's reading view, hovered with ⌘, shows Obsidian's popover in this window.
    await evaluate(`const leaf = app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: 'markdown', state: { file: ${JSON.stringify(READING)}, mode: 'preview' }, active: true });
      window.__mappyE2EHost = leaf;
      for (let i = 0; i < 40 && !leaf.view.contentEl.querySelector('.mappy-embed a.internal-link'); i += 1) await new Promise(r => setTimeout(r, 150));
      await new Promise(r => setTimeout(r, 600)); return true;`);
    const control = await hover(`const node = Array.from(el.querySelectorAll('a.internal-link')).find(a => !a.closest('.mappy-embed'));`, { view: HOST_VIEW, mod: true });
    if (!control.popovers.some(p => p.text.includes('E2E-TOP'))) {
      throw new Error(`no popover over a reading view's link with ⌘: this window does not show them, so nothing below means anything (${JSON.stringify(control)})`);
    }
    return { ...state, control: control.popovers };
  }));

  // 4 (embed, reading view) while the reading view is open.
  await step('embed-reading', async () => {
    const withMod = await hover(linkTarget('E2E-link-preview-target'), { view: EMBED_VIEW, mod: true });
    shows('embed reading ⌘', withMod, 'E2E-TOP');
    const without = await hover(linkTarget('E2E-link-preview-target'), { view: EMBED_VIEW, expect: false });
    absent('embed reading no ⌘', without);
    return { withMod: withMod.popovers, without: without.popovers };
  });

  // 4 (embed, live preview).
  await step('embed-live', async () => {
    await evaluate(`const leaf = window.__mappyE2EHost;
      await leaf.setViewState({ type: 'markdown', state: { file: ${JSON.stringify(READING)}, mode: 'source', source: false }, active: true });
      for (let i = 0; i < 40 && !leaf.view.contentEl.querySelector('.mappy-embed a.internal-link'); i += 1) await new Promise(r => setTimeout(r, 150));
      await new Promise(r => setTimeout(r, 800)); return true;`);
    const withMod = await hover(linkTarget('E2E-link-preview-target'), { view: EMBED_VIEW, mod: true });
    shows('embed live ⌘', withMod, 'E2E-TOP');
    const without = await hover(linkTarget('E2E-link-preview-target'), { view: EMBED_VIEW, expect: false });
    absent('embed live no ⌘', without);
    await evaluate(`window.__mappyE2EHost?.detach(); delete window.__mappyE2EHost; return true;`);
    return { withMod: withMod.popovers, without: without.popovers };
  });

  required(record, 'open', await step('open', async () => {
    const count = await openMap('__mappyE2E');
    if (count < 7) throw new Error(`the map drew ${count} internal links`);
    return { count };
  }));

  // 2 and 3: every kind of link in the tab × ⌘ / no ⌘.
  await step('tab-kinds', async () => {
    const rows = [];
    for (const [label, locate, marker] of [
      ['link', linkTarget('E2E-link-preview-target', { text: 'E2E-link-preview-target' }), 'E2E-TOP'],
      ['heading', linkTarget('E2E-link-preview-target#見出し'), 'E2E-HEADING'],
      ['block', linkTarget('E2E-link-preview-target#^blk'), 'E2E-BLOCK'],
      ['alias', linkTarget('E2E-link-preview-target', { text: '別名' }), 'E2E-TOP'],
      ['image', linkTarget('E2E-link-preview.png'), 'image'],
      ['body (host 同名)', `${linkTarget('同名')} if (node?.closest('.is-called')) throw new Error('the first 同名 is in the called branch');`, 'E2E-HOST-SAME'],
      ['called branch (called 同名)', `const node = Array.from(el.querySelectorAll('.is-called a.internal-link')).find(a => a.dataset.href === '同名');`, 'E2E-CALLED-SAME'],
    ]) {
      const withMod = await hover(locate, { mod: true });
      shows(`tab ${label} ⌘`, withMod, marker);
      const without = await hover(locate, { expect: false });
      absent(`tab ${label} no ⌘`, without);
      rows.push({ label, withMod: withMod.popovers, without: without.popovers });
    }
    const external = await hover(`const node = el.querySelector('a.external-link, a[href^="https://"]');`, { mod: true, expect: false });
    absent('tab external ⌘', external);
    rows.push({ label: 'external', withMod: external.popovers });
    const shot = value('--shot');
    if (shot) { await hover(linkTarget('E2E-link-preview-target#見出し'), { mod: true, stay: true }); await cdp.screenshot(shot); await leave(); }
    return rows;
  });

  // 5. The setting: ⌘ not needed for this source.
  await step('setting-off', async () => {
    const setting = await setMod(false);
    const without = await hover(linkTarget('E2E-link-preview-target', { text: 'E2E-link-preview-target' }));
    shows('setting off, no ⌘', without, 'E2E-TOP');
    await setMod(undefined);
    const back = await hover(linkTarget('E2E-link-preview-target', { text: 'E2E-link-preview-target' }), { expect: false });
    absent('setting back on, no ⌘', back);
    return { setting, without: without.popovers, back: back.popovers };
  });

  // 4. Side by side.
  await step('split', async () => {
    await openMap('__mappyE2ESplit', 'vertical');
    const withMod = await hover(linkTarget('E2E-link-preview-target#見出し'), { view: SPLIT_VIEW, mod: true });
    shows('split ⌘', withMod, 'E2E-HEADING');
    const without = await hover(linkTarget('E2E-link-preview-target#見出し'), { view: SPLIT_VIEW, expect: false });
    absent('split no ⌘', without);
    await evaluate(`window.__mappyE2ESplit?.detach(); delete window.__mappyE2ESplit; app.workspace.setActiveLeaf(window.__mappyE2E, { focus: true }); await new Promise(r => setTimeout(r, 600)); return true;`);
    return { withMod: withMod.popovers, without: without.popovers };
  });

  // 6. Not while writing, dragging or panning; a wheel closes one; clicks open.
  await step('not-while', async () => {
    const results = {};
    const link = linkTarget('E2E-link-preview-target#見出し');
    // F2 on another node, then ⌘ over a link.
    await press(`const node = nth('本文を持つ', 0);`);
    await cdp.realKey('F2');
    const editing = await until(() => evaluate(`${VIEW} return !!input();`), open => open, 3000);
    check(editing, 'the inline editor did not open');
    results.editing = await hover(link, { mod: true, expect: false });
    absent('editing ⌘', results.editing);
    await cdp.realKey('Escape');
    await wait(400);
    // A node dragged over the link with ⌘ held: pressed on the root, moved onto the link, released back at the start.
    for (const [kind, from] of [['drag', `const node = nth('プレビューの確認', 0);`], ['pan', `const node = el.querySelector('.mappy-canvas'); { const r = node.getBoundingClientRect(); at = { x: r.left + 12, y: r.bottom - 60 }; }`]]) {
      const start = await press(from, { click: false });
      const end = await press(link, { click: false });
      await leave();
      await move(start.x, start.y, META);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1, modifiers: META });
      for (let i = 1; i <= 8; i += 1) await move(start.x + (end.x - start.x) * i / 8, start.y + (end.y - start.y) * i / 8, META, 1);
      await wait(DWELL);
      const shown = await popovers();
      for (let i = 7; i >= 0; i -= 1) await move(start.x + (end.x - start.x) * i / 8, start.y + (end.y - start.y) * i / 8, META, 1);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x, y: start.y, button: 'left', buttons: 0, clickCount: 1 });
      await wait(400);
      check(shown.length === 0, `${kind} over a link with ⌘: popover ${JSON.stringify(shown)}`);
      results[kind] = shown;
      await cdp.realKey('z', META);
      await wait(600);
    }
    const source = await evaluate(`${VIEW} return await source();`);
    check(source === SOURCE, 'the drag or pan changed the note (the ⌘Z did not take it back)');
    // A wheel closes the popover that shows.
    const shown = await hover(link, { mod: true, stay: true });
    shows('before the wheel', { ...shown, lingers: [] }, 'E2E-HEADING');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: shown.point.x, y: shown.point.y, deltaX: 0, deltaY: 40 });
    results.wheel = await until(popovers, now => now.length === 0, 1500);
    check(results.wheel.length === 0, `a wheel left the popover: ${JSON.stringify(results.wheel)}`);
    await leave();
    // A click opens the link in this tab's place? No: Mappy opens it (openLinkText) in the active leaf; ⌘-click in a new tab.
    const before = await evaluate(`return app.workspace.getLeavesOfType('markdown').length;`);
    const point = await press(link, { click: false });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1, modifiers: META });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1, modifiers: META });
    await wait(1200);
    const after = await evaluate(`const leaves = app.workspace.getLeavesOfType('markdown');
      const opened = leaves.find(leaf => leaf.view.file?.path === ${JSON.stringify(TARGET)});
      window.__mappyE2EOpened = opened; return { count: leaves.length, opened: !!opened };`);
    check(after.opened && after.count === before + 1, `⌘-click did not open the target in a new tab: ${JSON.stringify({ before, after })}`);
    await evaluate(`window.__mappyE2EOpened?.detach(); delete window.__mappyE2EOpened; app.workspace.setActiveLeaf(window.__mappyE2E, { focus: true }); await new Promise(r => setTimeout(r, 600)); return true;`);
    results.click = { before, after };
    return results;
  });

  // 7. The tab closed, the plugin disabled, with a popover showing.
  await step('lifecycle', async () => {
    const shown = await hover(linkTarget('E2E-link-preview-target#見出し'), { mod: true, stay: true });
    check(shown.popovers.length === 1, `no popover before the tab closed: ${JSON.stringify(shown.popovers)}`);
    await evaluate(`window.__mappyE2E.detach(); delete window.__mappyE2E; return true;`);
    const afterClose = await until(popovers, now => now.length === 0, 1500);
    check(afterClose.length === 0, `the popover stays after its tab closed: ${JSON.stringify(afterClose)}`);
    await move(2, 2);
    await openMap('__mappyE2E');
    const again = await hover(linkTarget('E2E-link-preview-target#見出し'), { mod: true, stay: true });
    check(again.popovers.length === 1, `no popover before the plugin was disabled: ${JSON.stringify(again.popovers)}`);
    await evaluate(`await app.plugins.disablePlugin('mappy'); await new Promise(r => setTimeout(r, 400)); return true;`);
    const afterDisable = await until(popovers, now => now.length === 0, 1500);
    const source = await evaluate(`return app.workspace.hoverLinkSources?.mappy ?? null;`);
    check(afterDisable.length === 0, `the popover stays after the plugin was disabled: ${JSON.stringify(afterDisable)}`);
    check(source === null, `the source stays registered after the plugin was disabled: ${JSON.stringify(source)}`);
    await move(2, 2);
    await evaluate(`await app.plugins.enablePlugin('mappy'); await new Promise(r => setTimeout(r, 800)); delete window.__mappyE2E; return true;`);
    return { shown: shown.popovers, afterClose, again: again.popovers, afterDisable, source };
  });
} catch (error) {
  if (!(error instanceof StopCase)) {
    record.failures.push(`uncaught: ${error}`);
    record.stopped = String(error);
  }
} finally {
  await move(2, 2).catch(() => {});
  if (!flag('--keep')) await step('clean', clean);
  cdp.close();
}

process.exit(await finish(record, value('--json')));
