/**
 * E70 (docs/harness.md, LEV-253): the map's container keeps Obsidian's pane padding off without `!important`, on the
 * real Obsidian. The community review's CSS lint (0.4.1) warned on `padding: 0 !important` for `.mappy-view`; the rule
 * is now `.workspace-leaf-content .view-content.mappy-view { padding: 0 }`, one class above app.css's
 * `.workspace-leaf-content .view-content` padding. What has to hold wherever a map is drawn:
 *
 * - main: the map in a tab of the main window;
 * - popout: the map in a popout window (its own document and a copy of the stylesheet);
 * - embed: the note embedded (`![[…]]`) in another note's reading view, which is not a pane's `.view-content`;
 * each under Obsidian's light and dark base theme (`app.changeTheme`, what Appearance → Base color scheme calls).
 *
 * In each of the 6 states: the container's computed padding is 0 on all four sides, the canvas fills the container,
 * and a view's container fills its leaf below the tab header. The geometry of the canvas and the floating controls
 * (layouts, gear, zoom) relative to the container is recorded; `--compare <json>` checks it against another run's
 * record (the 0.4.1 stylesheet, before LEV-253) to within half a pixel, which is what "no visible change" means here.
 * Whether it looks the same beyond those boxes is what the screenshots are for (`--shot`), not passed by this case.
 *
 * Usage: npm run harness:e2e:view-padding -- [--reload] [--json <out.json>] [--shot <out.png>] [--compare <json>] [--keep]
 *   --shot     writes <out>-<state>-<scheme>.png for each state
 *   --compare  a record this case wrote before (`--json`), to compare the geometry with
 *   --keep     leave the notes in the vault
 */
import { readFile } from 'node:fs/promises';
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { makePluginStep, makeNoteStep, makeDeleteNote, refuseOpenLeaves, writeNote } from './dom-helpers.mjs';
import { ERRORS, makeAppTheme, LAID_OUT } from './window-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-view-padding.md';
const HOST = 'Fixtures/E2E-view-padding-host.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 余白の確認', '',
  '- 左上のノード', '  - 子ノード', '- 別の枝', '  - 画像のノード ![[sample-image.svg]]', '',
].join('\n');
const HOST_SOURCE = ['# 埋め込みの置き場', '', '![[E2E-view-padding]]', '', '下の段落。', ''].join('\n');
const SCHEMES = ['light', 'dark'];
const TOLERANCE = 0.5;

const record = createRecord(VAULT, NOTE);
const main = await connect();
const evaluate = expression => main.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const appTheme = makeAppTheme(evaluate);

/**
 * Script: `measure(content)`, what the container `content` (in whichever window) shows: its computed padding, whether
 * the LEV-253 selector matches it, and the boxes of the canvas and the floating controls relative to it, and of the
 * container relative to its leaf (null for an embed).
 */
const MEASURE = `const measure = content => {
  const style = content.ownerDocument.defaultView.getComputedStyle(content);
  const at = content.getBoundingClientRect();
  const round = number => Math.round(number * 100) / 100;
  const box = (element, origin = at) => { if (!element) return null; const rect = element.getBoundingClientRect();
    return [rect.left - origin.left, rect.top - origin.top, rect.width, rect.height].map(round); };
  const leaf = content.closest('.workspace-leaf-content');
  const header = leaf?.querySelector(':scope > .view-header');
  return {
    padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
    selector: content.matches('.workspace-leaf-content .view-content.mappy-view'),
    size: [round(at.width), round(at.height)],
    // Inside the border (the embed's frame is 1px, a view's container has none): where \`inset: 0\` puts the canvas.
    inner: [content.clientLeft, content.clientTop, content.clientWidth, content.clientHeight],
    canvas: box(content.querySelector('.mappy-canvas')),
    modes: box(content.querySelector(':scope > .mappy-modes')),
    actions: box(content.querySelector(':scope > .mappy-actions')),
    zoom: box(content.querySelector(':scope > .mappy-zoom')),
    inLeaf: leaf ? box(content, leaf.getBoundingClientRect()) : null,
    header: header ? round(header.getBoundingClientRect().height) : null,
  };
};`;

/** Script: `leaf.view.contentEl` measured once the map has laid out. */
const measureView = leaf => `const leaf = ${leaf}; ${MEASURE}
  const el = leaf.view.contentEl; ${LAID_OUT}
  return measure(el);`;

/** The checks every state shares; `view` is false for the embed, which sits in a note, not a leaf of its own. */
const checkState = (name, state, view) => {
  check(state.padding.every(side => side === '0px'), `${name}: padding ${state.padding.join(' ')}`);
  const fills = state.canvas && state.inner.every((edge, index) => Math.abs(state.canvas[index] - edge) <= TOLERANCE);
  check(fills, `${name}: the canvas ${JSON.stringify(state.canvas)} does not fill the container inside its border ${JSON.stringify(state.inner)}`);
  if (!view) return;
  check(state.selector, `${name}: the container does not match .workspace-leaf-content .view-content.mappy-view`);
  // Below the header, edge to edge: the leaf's own padding is none in app.css, so any gap is the view-content's.
  check(state.inLeaf && Math.abs(state.inLeaf[0]) <= TOLERANCE && Math.abs(state.inLeaf[1] - state.header) <= TOLERANCE,
    `${name}: the container sits at ${JSON.stringify(state.inLeaf)} in its leaf (header ${state.header})`);
  check(state.modes && state.actions && state.zoom, `${name}: a floating control is missing`);
};

const shoot = async (cdp, name) => {
  const shot = value('--shot');
  if (shot) await cdp.screenshot(shot.replace(/\.png$/u, `-${name}.png`));
};

let popoutMark = null;
let popout = null;

try {
  required(record, 'plugin', await step('plugin', makePluginStep(main, evaluate, flag)));
  required(record, 'setup', await step('setup', async () => {
    const result = await makeNoteStep(evaluate, { note: NOTE, source: SOURCE, errors: ERRORS,
      extra: `{ appTheme: app.vault.getConfig('theme') ?? 'system' }` })();
    await evaluate(`${refuseOpenLeaves([HOST])} ${writeNote(HOST, HOST_SOURCE)} return true;`);
    return result;
  }));

  // The map in a tab, the host note in reading view split below it, and the map in a popout: open once, measured under
  // each theme (a live switch, as a person changes it).
  required(record, 'open', await step('open', async () => {
    await evaluate(`const tab = app.workspace.getLeaf('tab');
      await tab.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(NOTE)} }, active: true });
      window.__mappyE2E = tab;
      const host = app.workspace.createLeafBySplit(tab, 'horizontal');
      await host.setViewState({ type: 'markdown', state: { file: ${JSON.stringify(HOST)}, mode: 'preview' }, active: false });
      window.__mappyE2EHost = host;
      const pop = app.workspace.openPopoutLeaf({ size: { width: 900, height: 700 } });
      await pop.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(NOTE)} }, active: true });
      window.__mappyE2EPopout = pop;
      const win = pop.view.contentEl.win;
      if (win === window) throw new Error('the popout leaf is in the main window');
      win.document.body.dataset.mappyE2ePopout = 'view-padding';
      await new Promise(resolve => setTimeout(resolve, 1500));
      app.workspace.setActiveLeaf(tab, { focus: true });
      return true;`);
    popoutMark = 'view-padding';
    for (const started = Date.now(); ; await wait(100)) {
      if (await evaluate(`return !!window.__mappyE2EHost.view.containerEl.querySelector('.mappy-embed.mappy-view .mappy-node');`)) break;
      if (Date.now() - started > 5000) throw new Error('the embed never drew its map');
    }
    return true;
  }));
  popout = await connect({ popout: popoutMark });
  const popoutEvaluate = expression => popout.evaluate(`(async () => { ${expression} })()`);

  const states = {};
  for (const scheme of SCHEMES) {
    // Measured under the theme asked for, or not at all: a switch that did not happen must not be recorded as dark.
    required(record, `theme-${scheme}`, await step(`theme-${scheme}`, async () => {
      const windows = await appTheme(scheme, [evaluate, popoutEvaluate]);
      if (windows.some(theme => theme !== scheme)) throw new Error(`asked for ${scheme}, the windows show ${windows.join(', ')}`);
      return windows;
    }));
    await wait(400);
    for (const [name, script, view] of [
      ['main', measureView('window.__mappyE2E'), true],
      ['popout', measureView('window.__mappyE2EPopout'), true],
      ['embed', `${MEASURE} const content = window.__mappyE2EHost.view.containerEl.querySelector('.mappy-embed.mappy-view');
        if (!content) throw new Error('no embedded map in the host note'); return measure(content);`, false],
    ]) {
      const id = `${name}-${scheme}`;
      const state = await step(id, () => evaluate(script));
      if (!state || 'error' in state) continue;
      states[id] = state;
      checkState(id, state, view);
      await shoot(name === 'popout' ? popout : main, id);
    }
  }

  const compare = value('--compare');
  if (compare) {
    await step('compare', async () => {
      const before = JSON.parse(await readFile(compare, 'utf8')).steps;
      const differences = [];
      for (const [id, state] of Object.entries(states)) {
        const old = before[id];
        if (!old || 'error' in old) { differences.push(`${id}: not in ${compare}`); continue; }
        for (const key of ['size', 'inner', 'canvas', 'modes', 'actions', 'zoom', 'inLeaf']) {
          const now = state[key] ?? []; const then = old[key] ?? [];
          if (now.length !== then.length || now.some((number, index) => Math.abs(number - then[index]) > TOLERANCE)) {
            differences.push(`${id}.${key}: ${JSON.stringify(then)} → ${JSON.stringify(now)}`);
          }
        }
      }
      check(differences.length === 0, `the geometry differs from ${compare}: ${differences.join('; ')}`);
      return { compared: Object.keys(states).length, differences };
    });
  }

  await step('errors', async () => {
    const errors = await evaluate('return [...(window.__mappyE2EErrors ?? [])];');
    check(errors.length === 0, `page errors: ${JSON.stringify(errors).slice(0, 1500)}`);
    return errors;
  });
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`stopped: ${error}`);
} finally {
  const tidy = async (name, run) => { try { await run(); } catch (error) { record.failures.push(`${name}: ${error}`); } };
  if (popout) await tidy('close popout connection', () => popout.close());
  if (record.steps.setup && !record.steps.setup.error) {
    await tidy('restore theme', () => evaluate(`app.changeTheme(${JSON.stringify(record.steps.setup.appTheme)}); return true;`));
  }
  await tidy('detach', () => evaluate(`for (const key of ['__mappyE2EPopout', '__mappyE2EHost', '__mappyE2E']) { window[key]?.detach(); delete window[key]; }
    return true;`));
  if (record.steps.setup && !record.steps.setup.error && !flag('--keep')) {
    await wait(300);
    await step('clean', makeDeleteNote(evaluate, HOST));
    await step('clean-note', makeDeleteNote(evaluate, NOTE));
  }
  main.close();
}

process.exit(await finish(record, value('--json')));
