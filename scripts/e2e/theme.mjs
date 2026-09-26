/**
 * E48 (docs/harness.md, E11 のテーマ部分・§5 M1「明色・暗色テーマ…で破綻しない」・M14 のテーマ設定): the map under
 * Obsidian's light and dark base themes × the plugin's theme setting (Obsidian に従う／明色／暗色), on the real
 * Obsidian (LEV-14). The setting is changed where a person changes it — the plugin's settings tab, its dropdown —
 * and Obsidian's theme with `app.changeTheme` (what Appearance → Base color scheme calls); the map stays open
 * throughout, so every state is also a live switch, not a fresh open.
 *
 * In each of the 6 states, what the pixels have is read, not the class names (window-helpers.mjs `COLOR`):
 * - the scheme the map shows (its canvas is dark or light) is the one the setting asks for, and the view carries
 *   `theme-light` / `theme-dark` only when the setting is explicit;
 * - WCAG contrast of what is on the map against what it sits on: node text, the root's text, the collapsed branch's
 *   count, the zoom label, the gear popover's title and description, the inline editor's text ≥ 4.5; a link ≥ what
 *   Obsidian's own link colour has on its own page (capped at 4.5; the default light theme's is 4.26); the edges, a
 *   node's border, the selection outline and the floating buttons' icons ≥ 3 (non-text);
 * - an explicit theme looks like Obsidian's own theme of the same scheme: 明色 under the dark app is, element by
 *   element, the colour 「Obsidian に従う」 has under the light app (and the other three pairings), within 4/255 per
 *   channel. This is what the variable mapping in styles.css (`:where(.mappy-view.theme-light, …)`) is for.
 * Nothing is written to the note. The app's theme and the plugin's setting are put back at the end.
 *
 * What this cannot judge is recorded, not passed: whether it looks right (screenshots of each state, with and
 * without the popover, go to `--shot`), community themes, and the OS's own "follow system" switch.
 *
 * Usage: npm run harness:e2e:theme -- [--reload] [--json <out.json>] [--shot <out.png>] [--keep]
 *   --shot  writes <out>-<app>-<setting>.png and <out>-<app>-<setting>-popover.png for each state
 *   --keep  leave the note in the vault
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep, makeOpenStep, makeClickIn, makePress, makeDeleteNote } from './dom-helpers.mjs';
import { COLOR, ERRORS, APP_THEMES, makeAppTheme } from './window-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-theme.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## テーマの確認', '',
  '- 通常のノード', '  - [[uneven-branches|リンクのノード]]', '  - 画像のノード ![[sample-image.svg]]',
  '- 折りたたむ枝', '  - 隠れる子 1', '  - 隠れる子 2', '',
].join('\n');
const SETTINGS = ['follow', 'light', 'dark'];
const TEXT = 4.5;
const NON_TEXT = 3;
const TOLERANCE = 4;

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);

/** The plugin's theme setting, through its settings tab: the dropdown in the row named テーマ, as a person picks it. */
const setSetting = theme => evaluate(`app.setting.open(); app.setting.openTabById('mappy');
  await new Promise(resolve => setTimeout(resolve, 200));
  const tab = app.setting.activeTab;
  if (tab?.id !== 'mappy') throw new Error('the Mappy settings tab did not open');
  const row = Array.from(tab.containerEl.querySelectorAll('.setting-item')).find(item => item.querySelector('.setting-item-name')?.textContent === 'テーマ');
  const dropdown = row?.querySelector('select');
  if (!dropdown) throw new Error('no テーマ dropdown in the settings tab');
  dropdown.value = ${JSON.stringify(theme)};
  dropdown.dispatchEvent(new Event('change'));
  for (const started = Date.now(); Date.now() - started < 3000 && app.plugins.plugins.mappy.settings.theme !== ${JSON.stringify(theme)}; await new Promise(resolve => setTimeout(resolve, 50)));
  app.setting.close();
  await new Promise(resolve => setTimeout(resolve, 300));
  return app.plugins.plugins.mappy.settings.theme;`);

const appTheme = makeAppTheme(evaluate);
const setAppTheme = async scheme => (await appTheme(scheme))[0];

/** A real click at the centre of `selector` inside the view under test (dom-helpers' `makeClickIn`). */
const clickIn = makeClickIn(cdp, evaluate);
const press = makePress(cdp, evaluate);

/**
 * Script: `pairs` of [name, foreground, background, minimum] for what is on screen now, each colour composited to
 * what the pixels show. `part` is 'map' (with the map as it is), 'popover' or 'input' (read while those are open).
 */
const READ = part => `${VIEW} ${COLOR}
  const nodeTitled = title => nodes().find(node => label(node) === title);
  const canvas = el.querySelector('.mappy-canvas');
  const ground = backdrop(canvas);
  // What reaches the pixels: the colour with the element's and its ancestors' opacity folded into its alpha (a faded
  // label is that much closer to its background).
  const faded = element => { let alpha = 1; for (let at = element; at && at.nodeType === 1; at = at.parentElement) alpha *= Number(getComputedStyle(at).opacity); return alpha; };
  const drawn = (element, css) => { const color = rgba(css); return [color[0], color[1], color[2], color[3] * faded(element)]; };
  const text = element => onto(drawn(element, getComputedStyle(element).color), backdrop(element));
  // An outline that is not drawn (outline: none, zero width) has the ground's own colour: contrast 1.
  const outline = element => { const style = getComputedStyle(element);
    return style.outlineStyle === 'none' || parseFloat(style.outlineWidth) === 0 ? ground : onto(drawn(element, style.outlineColor), ground); };
  const pairs = [];
  const add = (name, fg, bg, min) => pairs.push({ name, fg: css(fg), bg: css(bg), ratio: contrast(fg, bg), min });
  if (${JSON.stringify(part)} === 'map') {
    const plain = nodeTitled('通常のノード'); const root = nodes().find(node => node.classList.contains('is-root'));
    const link = el.querySelector('.mappy-node a');
    const folded = el.querySelector('.mappy-node.is-collapsed .mappy-node-toggle-mark');
    const selected = el.querySelector('.mappy-node.is-selected');
    const bordered = nodes().find(node => parseFloat(getComputedStyle(node).borderTopWidth) > 0);
    const edge = el.querySelector('.mappy-edges path');
    const zoomIn = el.querySelector('.mappy-zoom .mappy-button[aria-label="拡大"]');
    const zoomLabel = Array.from(el.querySelectorAll('.mappy-zoom .mappy-button')).find(button => /%$/u.test(button.textContent.trim()));
    const missing = Object.entries({ plain, root, link, folded, selected, bordered, edge, zoomIn, zoomLabel }).filter(([, item]) => !item).map(([name]) => name);
    if (missing.length > 0) throw new Error('not on the map: ' + missing.join(', '));
    add('node-text', text(plain.querySelector('.mappy-node-content') ?? plain), backdrop(plain), ${TEXT});
    add('root-text', text(root.querySelector('.mappy-node-content') ?? root), backdrop(root), ${TEXT});
    // A link's bar is set in the 'contrast' step from Obsidian's own pairing (see there); null here.
    add('link', text(link), backdrop(link), null);
    add('collapsed-count', text(folded), backdrop(folded), ${TEXT});
    add('zoom-label', text(zoomLabel), backdrop(zoomLabel), ${TEXT});
    add('edge', onto(drawn(edge, getComputedStyle(edge).stroke), ground), ground, ${NON_TEXT});
    add('node-border', onto(drawn(bordered, getComputedStyle(bordered).borderTopColor), ground), ground, ${NON_TEXT});
    add('selection', outline(selected), ground, ${NON_TEXT});
    add('button-icon', text(zoomIn), backdrop(zoomIn), ${NON_TEXT});
    add('canvas', ground, ground, 0);
  } else if (${JSON.stringify(part)} === 'popover') {
    const title = el.querySelector('.mappy-popover-item:not(.is-disabled) .mappy-popover-title');
    const description = el.querySelector('.mappy-popover-item:not(.is-disabled) .mappy-popover-description');
    if (!title || !description) throw new Error('the popover is not open');
    add('popover-title', text(title), backdrop(title), ${TEXT});
    add('popover-description', text(description), backdrop(description), ${TEXT});
  } else {
    const box = input();
    if (!box) throw new Error('the inline editor is not open');
    add('inline-input', text(box), backdrop(box), ${TEXT});
  }
  // Obsidian's own link colour on its own page background, in the app's current theme (the body's variables).
  const page = getComputedStyle(document.body);
  const appGround = onto(rgba(page.getPropertyValue('--background-primary')), [255, 255, 255, 1]);
  const appLink = contrast(onto(rgba(page.getPropertyValue('--link-color')), appGround), appGround);
  return { classes: ['theme-light', 'theme-dark'].filter(name => el.classList.contains(name)), dark: luminance(ground) < 0.2, light: luminance(ground) > 0.6, appLink, pairs };`;

const shotBase = value('--shot')?.replace(/\.png$/u, '');

try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  required(record, 'original', await step('original', () => evaluate(`${ERRORS}
    return { appTheme: app.vault.getConfig('theme') ?? 'system', setting: app.plugins.plugins.mappy.settings.theme };`)));
  required(record, 'open', await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE })));

  // The branch folded (its count badge is on the map) and a node selected (its outline is), by real clicks.
  required(record, 'prepare', await step('prepare', async () => {
    // The toggle of 折りたたむ枝, hovered first as a pointer reaches it (its mark shows on hover), and hit-tested.
    await press(`const node = nodes().find(item => label(item) === '折りたたむ枝')?.querySelector('.mappy-node-toggle');`, { hover: true });
    await wait(250);
    await select('通常のノード');
    const state = await evaluate(`${VIEW} return { collapsed: !!el.querySelector('.mappy-node.is-collapsed'), selected: label(el.querySelector('.mappy-node.is-selected')) };`);
    if (!state.collapsed || state.selected !== '通常のノード') throw new Error(`fold/select did not take: ${JSON.stringify(state)}`);
    return state;
  }));

  const states = {};
  for (const scheme of Object.keys(APP_THEMES)) {
    for (const setting of SETTINGS) {
      const name = `${scheme}-${setting}`;
      states[name] = await step(`state-${name}`, async () => {
        const app = await setAppTheme(scheme);
        const stored = await setSetting(setting);
        await select('通常のノード');
        const map = await evaluate(READ('map'));
        if (shotBase) await cdp.screenshot(`${shotBase}-${name}.png`);
        await clickIn('.mappy-actions .mappy-button');
        const popover = await evaluate(READ('popover'));
        if (shotBase) await cdp.screenshot(`${shotBase}-${name}-popover.png`);
        await cdp.realKey('Escape');
        await wait(200);
        await select('通常のノード');
        await cdp.realKey('F2');
        await wait(300);
        const inline = await evaluate(READ('input'));
        await cdp.realKey('Escape');
        await wait(200);

        const expected = setting === 'follow' ? scheme : setting;
        check(app === scheme, `${name}: the app is ${app}, not ${scheme}`);
        check(stored === setting, `${name}: the setting saved ${stored}, not ${setting}`);
        check(expected === 'dark' ? map.dark : map.light, `${name}: the map shows a ${map.dark ? 'dark' : map.light ? 'light' : 'mid-grey'} canvas, not ${expected}`);
        const classes = setting === 'follow' ? [] : [`theme-${setting}`];
        check(JSON.stringify(map.classes) === JSON.stringify(classes), `${name}: the view has ${JSON.stringify(map.classes)}, not ${JSON.stringify(classes)}`);
        return { app, stored, expected, classes: map.classes, appLink: map.appLink, pairs: [...map.pairs, ...popover.pairs, ...inline.pairs] };
      });
    }
  }

  // Contrast, once every state is read. A link wears Obsidian's link colour (--link-color), which in the default light
  // theme is 4.26:1 on white, as in Obsidian's own notes: its bar is Obsidian's own pairing in the scheme the map shows
  // (read in that scheme's 「Obsidian に従う」 state, from the app's body), up to 4.5 — the map must not make a link
  // harder to read than a note does, and cannot be asked to beat the theme's own colour.
  await step('contrast', () => {
    const below = [];
    for (const [name, state] of Object.entries(states)) {
      if (!state?.pairs) continue;
      const reference = states[`${state.expected}-follow`]?.appLink;
      for (const pair of state.pairs) {
        const min = pair.name === 'link' ? Math.min(TEXT, reference ?? TEXT) : pair.min;
        pair.min = min;
        if (pair.ratio < min) below.push(`${name}: ${pair.name} ${pair.fg} on ${pair.bg} has contrast ${pair.ratio} (< ${min})`);
      }
    }
    for (const failure of below) check(false, failure);
    return { below, linkBar: Object.fromEntries(Object.keys(APP_THEMES).map(scheme => [scheme, states[`${scheme}-follow`]?.appLink ?? null])) };
  });

  // An explicit theme against Obsidian's own theme of the same scheme, element by element.
  await step('explicit-equals-app', () => {
    const channels = color => color.match(/\d+/gu).map(Number);
    const compared = [];
    for (const scheme of Object.keys(APP_THEMES)) {
      const reference = states[`${scheme}-follow`];
      for (const app of Object.keys(APP_THEMES)) {
        const explicit = states[`${app}-${scheme}`];
        if (!reference?.pairs || !explicit?.pairs) continue;
        for (const pair of explicit.pairs) {
          const same = reference.pairs.find(item => item.name === pair.name);
          if (!same) continue;
          const diff = Math.max(...['fg', 'bg'].flatMap(key => channels(pair[key]).map((channel, index) => Math.abs(channel - channels(same[key])[index]))));
          compared.push({ explicit: `${app}-${scheme}`, reference: `${scheme}-follow`, name: pair.name, diff });
          check(diff <= TOLERANCE, `${app}-${scheme}: ${pair.name} is ${pair.fg} on ${pair.bg}, but Obsidian's ${scheme} theme draws it ${same.fg} on ${same.bg} (off by ${diff}/255)`);
        }
      }
    }
    check(compared.length > 0, 'no pair was compared (a state failed before it was read)');
    return { compared: compared.length, worst: compared.sort((a, b) => b.diff - a.diff).slice(0, 5) };
  });

  await step('unchanged', async () => {
    const source = await evaluate(`${VIEW} return await source();`);
    check(source === SOURCE, 'the note changed while switching themes');
    const errors = await evaluate('return [...(window.__mappyE2EErrors ?? [])];');
    check(errors.length === 0, `page errors: ${JSON.stringify(errors).slice(0, 1500)}`);
    return { unchanged: source === SOURCE, errors };
  });
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`stopped: ${error}`);
} finally {
  // Each part of the restore on its own: a settings tab that would not open must not leave the app's theme changed.
  const tidy = async (name, run) => { try { await run(); } catch (error) { record.failures.push(`${name}: ${error}`); } };
  const original = record.steps.original;
  if (original && !original.error) {
    await tidy('restore setting', () => setSetting(original.setting));
    await tidy('restore theme', () => evaluate(`app.changeTheme(${JSON.stringify(original.appTheme)}); return true;`));
  }
  // Only the map this case opened (the open step refuses a note already open elsewhere, and then there is none).
  if (record.steps.open && !record.steps.open.error) {
    await tidy('detach', () => evaluate(`window.__mappyE2E?.detach(); window.__mappyE2E = null; return true;`));
    if (!flag('--keep')) {
      await wait(300);
      await step('clean', makeDeleteNote(evaluate, NOTE));
    }
  }
  cdp.close();
}

process.exit(await finish(record, value('--json')));
