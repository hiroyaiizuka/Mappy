/**
 * E24 (docs/harness.md, §5 M6): a `mappy: true` note and a plain note in Excalidraw's interactive frames
 * (embeddables), side by side, on the real Obsidian.
 *
 * Excalidraw renders a Markdown file in a frame through a workspace leaf of its own and `setViewState({ type:
 * 'markdown' })`, so the frame of a map note becomes the live map only through Mappy's routing
 * (src/obsidian/view-routing.ts, which is why it patches the prototype and not the workspace). The case checks the
 * frame the way the harness row words it — 「Mappy のビューがライブ表示され、線・枠・リンクが見える。通常ノートは
 * Markdown のまま」:
 * - the map's frame holds a `mappy-map` leaf whose nodes are drawn inside the frame, the root and the first-level
 *   branches with a visible border, the lines as SVG paths of non-zero length, and the link as a clickable
 *   `a.internal-link`;
 * - the plain note's frame holds no Mappy view and shows its heading and link as Markdown.
 * `--shot` saves the two frames together, which is the evidence the ticket asks for.
 *
 * The frames are added with `ExcalidrawAutomate.addEmbeddable`, the element Excalidraw's own 「Insert as
 * embeddable」 creates; its dialog is not driven. Mappy's reshaping of a dialog-created frame (E27, the watcher in
 * src/obsidian/excalidraw-bridge.ts) is not part of this case.
 *
 * Usage: npm run harness:e2e:excalidraw-frame -- [--reload] [--json <out.json>] [--shot <out.png>] [--keep]
 *   --reload  re-enable Mappy first, so a build made after Obsidian started is the one under test
 *   --keep    leave the notes and the drawing in the vault
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { makePluginStep } from './dom-helpers.mjs';
import {
  MAP_ROOT, mapSource, plainSource, makeDrawingSetup, makeDrawingClean, makeNoStaleRouting,
} from './excalidraw-helpers.mjs';

const { flag, value } = parseArgs();

const MAP = 'Fixtures/E2E-excalidraw-frame-map.md';
const PLAIN = 'Fixtures/E2E-excalidraw-frame-plain.md';
const PLAIN_NAME = 'E2E-excalidraw-frame-plain';
const MAP_NAME = 'E2E-excalidraw-frame-map';
const DRAWING = 'Fixtures/E2E-excalidraw-frame.excalidraw.md';

const record = createRecord(VAULT, MAP);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);

/** What each frame holds, read from its DOM: the leaf's view type, the map's nodes, lines and links, or the Markdown. */
const readFrames = () => evaluate(`const E = window.__mappyExcalidrawE2E;
  const view = E.leaf.view;
  const api = view.excalidrawAPI;
  const inside = (outer, rect) => rect.width > 0 && rect.height > 0 && rect.left >= outer.left - 1 && rect.right <= outer.right + 1
    && rect.top >= outer.top - 1 && rect.bottom <= outer.bottom + 1;
  const bordered = element => { const style = getComputedStyle(element); return parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none'; };
  const frames = {};
  for (const [key, id] of Object.entries(E.frames)) {
    const element = api.getSceneElements().find(item => item.id === id);
    // Excalidraw 2.27.3 puts a \`#embed-<element id>\` inside each frame's container: the frame of this element, and
    // not whichever frame happens to hold a map (that would find "the map's frame" even with the routing broken).
    const container = view.containerEl.querySelector('#embed-' + CSS.escape(id))?.closest('.excalidraw__embeddable-container') ?? null;
    if (!element || !container) { frames[key] = { element: !!element, container: false }; continue; }
    const box = container.getBoundingClientRect();
    const nodes = [...container.querySelectorAll('.mappy-node')];
    const paths = [...container.querySelectorAll('.mappy-edges path')];
    frames[key] = {
      element: true, container: true, link: element.link,
      leafTypes: [...container.querySelectorAll('.workspace-leaf-content')].map(item => item.dataset.type),
      nodes: nodes.map(node => ({
        label: node.getAttribute('aria-label'),
        role: node.classList.contains('is-root') ? 'root' : node.classList.contains('is-stage') ? 'stage' : 'branch',
        bordered: bordered(node.querySelector('.mappy-node-content') ?? node) || bordered(node),
        visible: inside(box, node.getBoundingClientRect()),
      })),
      // A line counts when it has length and a stroke one can see: a colour with some alpha, and a width above zero.
      lines: paths.filter(path => {
        const style = getComputedStyle(path);
        const alpha = style.stroke.match(/rgba\\([^)]*,\\s*([\\d.]+)\\)/u)?.[1];
        const visible = style.stroke !== 'none' && style.stroke !== 'transparent' && (alpha === undefined || parseFloat(alpha) > 0);
        return path.getTotalLength() > 0 && visible && parseFloat(style.strokeWidth) > 0 && parseFloat(style.strokeOpacity || '1') > 0;
      }).length,
      // Reading view (what Excalidraw 2.27.3 shows) and live preview (should a later version open the note editable)
      // draw the same heading and link with different elements; either counts.
      links: [...container.querySelectorAll('a.internal-link, .cm-hmd-internal-link')].filter(link => inside(box, link.getBoundingClientRect())).map(link => link.textContent.trim()),
      markdown: !!container.querySelector('.markdown-preview-view, .markdown-source-view, .markdown-rendered'),
      headings: [...container.querySelectorAll('h1, .cm-header-1')].map(heading => heading.textContent.trim()),
    };
  }
  return frames;`);

try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  required(record, 'setup', await step('setup', makeDrawingSetup(evaluate, {
    notes: { [MAP]: mapSource(PLAIN_NAME), [PLAIN]: plainSource(MAP_NAME) },
    drawing: DRAWING,
  })));
  // Otherwise a window still routing through an earlier build's wrapper would pass a build that has no routing at all
  // (docs/harness.md 「壊したビルドの検証は…起動し直す」). It unloads Mappy once, so a build that does not take its
  // routing off on unload stops here too (the message says to restart to tell the two apart).
  required(record, 'no-stale-routing', await step('no-stale-routing', makeNoStaleRouting(evaluate, MAP)));

  required(record, 'insert', await step('insert', () => evaluate(`const E = window.__mappyExcalidrawE2E;
    const view = E.leaf.view;
    const ea = window.ExcalidrawAutomate.getAPI(view);
    try {
      const map = ea.addEmbeddable(0, 0, 520, 380, undefined, app.vault.getFileByPath(${JSON.stringify(MAP)}));
      const plain = ea.addEmbeddable(580, 0, 520, 380, undefined, app.vault.getFileByPath(${JSON.stringify(PLAIN)}));
      if (!await ea.addElementsToView(false, true, false)) throw new Error('Excalidraw did not add the frames');
      E.frames = { map, plain };
    } finally {
      ea.destroy?.();
    }
    // A frame is rendered only while it is on screen: fit both into the view, with the sidebar out of the way (put
    // back as it was in the case's finally, --keep or not).
    E.sidebarCollapsed = app.workspace.leftSplit.collapsed;
    app.workspace.leftSplit.collapse();
    await new Promise(resolve => setTimeout(resolve, 400));
    view.zoomToFit(false);
    return E.frames;`)));

  const frames = await step('frames', async () => {
    // Poll until both frames have drawn what they are going to draw (a leaf each, the map's nodes laid out).
    let read;
    for (const started = Date.now(); Date.now() - started < 15000;) {
      await wait(500);
      read = await readFrames();
      const map = read.map; const plain = read.plain;
      if (map?.container && plain?.container && map.nodes.length > 0 && map.nodes.every(node => node.visible) && plain.markdown) break;
    }
    return read;
  });

  const shot = value('--shot');
  if (shot) await cdp.screenshot(shot);

  const map = frames.map ?? {};
  const plain = frames.plain ?? {};
  // A frame that never rendered has no node list: read it as empty, so every check below still runs and says so.
  const mapNodes = map.nodes ?? [];
  const plainNodes = plain.nodes ?? [];
  check(map.container, 'the map note\'s frame was not rendered');
  check(map.leafTypes?.includes('mappy-map'), `the map note's frame holds ${JSON.stringify(map.leafTypes)}, not a mappy-map leaf`);
  const labels = mapNodes.map(node => node.label);
  for (const title of [MAP_ROOT, '線と枠', '二つ目の枝']) check(labels.includes(title), `the map in the frame has no node ${title}`);
  check(mapNodes.length > 0 && mapNodes.every(node => node.visible), 'a node of the map is outside its frame (not fitted)');
  check(mapNodes.filter(node => node.role !== 'branch').every(node => node.bordered)
    && mapNodes.some(node => node.role === 'root') && mapNodes.filter(node => node.role === 'stage').length === 2,
  `the root and the two first-level branches should be drawn boxed: ${JSON.stringify(mapNodes)}`);
  // The fixture has three edges: the root to its two first-level branches, and 線と枠 to its child.
  check(map.lines === 3, `the map in the frame draws ${map.lines} visible lines, not the fixture's 3`);
  check(map.links?.includes(PLAIN_NAME), `the link to ${PLAIN_NAME} is not shown in the map's frame: ${JSON.stringify(map.links)}`);
  check(plain.container, 'the plain note\'s frame was not rendered');
  check(!plain.leafTypes?.includes('mappy-map') && plainNodes.length === 0, 'the plain note\'s frame shows a map');
  check(plain.markdown && plain.headings?.includes('通常ノート'), 'the plain note\'s frame does not show its Markdown');
  check(plain.links?.includes(MAP_NAME), 'the plain note\'s frame does not show its link');

  const errors = await evaluate('return [...window.__mappyExcalidrawE2E.errors];');
  record.steps.errors = errors;
  check(errors.length === 0, `page errors: ${JSON.stringify(errors)}`);
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`stopped: ${error}`);
} finally {
  await evaluate(`const E = window.__mappyExcalidrawE2E;
    if (E && E.sidebarCollapsed === false) app.workspace.leftSplit.expand();
    return true;`).catch(() => {});
  if (!flag('--keep') && record.steps.setup && !record.steps.setup.error) {
    await step('clean', makeDrawingClean(evaluate, [MAP, PLAIN]));
  }
  cdp.close();
}

process.exit(await finish(record, value('--json')));
