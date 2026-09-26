/**
 * E49 (docs/harness.md, E09 の開閉・再読込): open and close the map 50 times, reload the plugin with a map open, and
 * reload the whole window, on the real Obsidian (LEV-14). What each close has to leave is read, not assumed
 * (window-helpers.mjs):
 *
 * - every handler the view put on `app.workspace` / `app.vault` / `app.metadataCache` is gone (the counts equal the
 *   ones before the first open, event name by event name — 「多重イベント」なし);
 * - every closed view and its `contentEl` can be collected (`WeakRef`s after a full GC — 「残留 DOM」なし), and no
 *   `.mappy-view`, popover or inline editor is left in the document;
 * - between the 10th and the 50th close the DOM node count, the listener count and the JS heap do not keep growing
 *   (「継続的なメモリ増加」なし; the first 10 are the warm-up of Obsidian's and the renderer's own caches).
 *
 * The 50 cycles are not all the same open-and-close: a view closed with a draft open, with the gear's popover open
 * (it holds listeners on the document and the window), after a zoom, and as one of two views of the same note are
 * where a close has something to take down beyond the plain case. None of them changes the note (the draft is the
 * node's own title; what a different draft does on close is LEV-215's, and E50 step 7 records it).
 *
 * Then the plugin is disabled and enabled 5 times with the map open (the leaf keeps its place and gets the map back;
 * commands, the stylesheet, the `setViewState` routing and the handlers are there once, not once per load), and the
 * window is reloaded (`app:reload`) with the map open (the map comes back once from the saved workspace).
 *
 * Usage: npm run harness:e2e:view-lifecycle -- [--reload] [--json <out.json>] [--cycles <n>] [--keep]
 *   --cycles  open/close count (default 50); the memory checkpoints are the 10th and the last
 *   --keep    leave the note in the vault
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep, makeClickIn, makeNoteStep, makeDeleteNote } from './dom-helpers.mjs';
import { HANDLERS, handlerDiff, memory, preciseGc, makeTrack, ERRORS } from './window-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-view-lifecycle.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 開閉の確認', '',
  '- 通常のノード', '  - 子ノード', '  - [[uneven-branches|リンクのノード]]', '  - 画像のノード ![[sample-image.svg]]',
  '- 長い日本語のノードを含む枝', '  - 吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。', '',
].join('\n');
/** Every item of SOURCE is a node (the section's heading is the root); a cycle waits for all of them. */
const NODES = 7;
const CHECKPOINT = 10;
const CYCLES = Number(value('--cycles') ?? 50);
// Fewer than 20 would leave the growth between the checkpoint and the last close too short to mean anything, and a
// value that is not a whole number would run no cycle at all and still pass: refuse both before touching the vault.
if (!Number.isInteger(CYCLES) || CYCLES < 2 * CHECKPOINT) {
  console.error(`--cycles must be a whole number of at least ${2 * CHECKPOINT} (got ${value('--cycles')})`);
  process.exit(2);
}
const RELOADS = 5;
/**
 * Allowed growth between the 10th and the last close. A view that stayed reachable would keep its whole DOM (~120
 * nodes for this note) and its listeners on every one of the 40 closes; the `WeakRef` check catches that directly,
 * and these bounds catch what grows outside the views (a cache keyed per open, a listener left on the document).
 */
const GROWTH = { nodes: 200, jsEventListeners: 20, heapMB: 2 };

const record = createRecord(VAULT, NOTE);
let cdp = await connect();
let evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const track = makeTrack(expression => evaluate(expression));

/**
 * Script: open the note as a map in a new tab (remembered as `window.__mappyE2E` at once, so a failure after this
 * still closes it) and wait until all its nodes are laid out — the first frame can hold the root alone.
 */
const OPEN = `const leaf = app.workspace.getLeaf('tab');
  window.__mappyE2E = leaf;
  await leaf.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(NOTE)} }, active: true });
  let laid = 0;
  for (const started = Date.now(); Date.now() - started < 5000 && laid < ${NODES}; await new Promise(resolve => setTimeout(resolve, 50))) {
    laid = Array.from(leaf.view.contentEl?.querySelectorAll('.mappy-node') ?? []).filter(node => node.getBoundingClientRect().width > 0).length;
  }
  if (laid < ${NODES}) throw new Error('the map laid out ' + laid + ' of ${NODES} nodes within 5 s');
  app.workspace.setActiveLeaf(leaf, { focus: true });`;

/** What of Mappy is in the window: its views, popovers, inline editors and leaves. */
const LEFT = `return {
  views: document.querySelectorAll('.mappy-view').length,
  popovers: document.querySelectorAll('.mappy-popover').length,
  inputs: document.querySelectorAll('.mappy-inline-input').length,
  leaves: app.workspace.getLeavesOfType('mappy-map').length,
};`;

/** The connection as the helpers see it: always the current `cdp` (the window reload replaces it). */
const live = {
  send: (...args) => cdp.send(...args), realKey: (...args) => cdp.realKey(...args), insertText: (...args) => cdp.insertText(...args),
};
const run = expression => evaluate(expression);
const select = makeSelect(live, run);
const clickIn = makeClickIn(live, run);

/**
 * One open and close. `kind` is what happens while it is open (see the file comment); what it did is returned so a
 * cycle whose action silently did nothing is a failure, not a plain open counted as the harder one.
 */
const cycle = async (index, kind) => {
  try {
    return await act(index, kind);
  } finally {
    await evaluate(`const leaf = window.__mappyE2E; if (!leaf) return false; const view = leaf.view; ${track.statement(`${index}-${kind}`)}
      leaf.detach(); window.__mappyE2E = null; await new Promise(resolve => setTimeout(resolve, 50)); return true;`);
  }
};

const act = async (index, kind) => {
  await evaluate(`${OPEN} return true;`);
  let did = null;
  if (kind === 'draft') {
    await select('子ノード');
    await cdp.realKey('F2');
    await wait(200);
    // The draft keeps the node's own title: closing the tab saves a draft through the textarea's blur (the element
    // leaves the DOM before `onClose` drops it — LEV-215), so a different text would be written and the next cycle
    // would open another note. What this cycle checks is that a view closed mid-edit is taken down, not the save.
    await cdp.insertText('子ノード');
    did = await evaluate(`${VIEW} return input()?.value === '子ノード';`);
  } else if (kind === 'popover') {
    await clickIn('.mappy-actions .mappy-button');
    did = await evaluate(`${VIEW} return !!el.querySelector('.mappy-popover');`);
  } else if (kind === 'zoom') {
    const before = await evaluate(`${VIEW} return el.querySelector('.mappy-zoom').textContent;`);
    await clickIn('.mappy-zoom .mappy-button[aria-label="拡大"]');
    did = before !== await evaluate(`${VIEW} return el.querySelector('.mappy-zoom').textContent;`);
  } else if (kind === 'split') {
    did = await evaluate(`const second = app.workspace.getLeaf('split');
      await second.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(NOTE)} } });
      await new Promise(resolve => setTimeout(resolve, 400));
      const view = second.view; ${track.statement(`${index}-split-second`)}
      const drawn = view.contentEl.querySelectorAll('.mappy-node').length > 0;
      second.detach();
      return drawn;`);
  }
  return did;
};

try {
  const plugin = required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  required(record, 'setup', await step('setup', async () => {
    const result = await makeNoteStep(evaluate, { note: NOTE, source: SOURCE, errors: ERRORS, extra: `{ mappy: ${JSON.stringify(plugin.version)} }` })();
    await track.reset();
    return result;
  }));

  // Warm-up: one open and close, so the baseline has Obsidian's own lazily created handlers (the first map view is
  // the first view of its kind) and the first read of the note in it.
  await step('warm-up', () => cycle('warm-up', 'plain'));
  const baseline = await step('baseline', async () => ({ handlers: await evaluate(`return ${HANDLERS};`), memory: await memory(cdp) }));

  const kinds = ['plain', 'draft', 'popover', 'zoom', 'split'];
  const missed = [];
  const checkpoints = {};
  await step('cycles', async () => {
    for (let index = 1; index <= CYCLES; index += 1) {
      const kind = kinds[index % kinds.length];
      const did = await cycle(index, kind);
      if (kind !== 'plain' && did !== true) missed.push(`${index}-${kind}`);
      if (index === CHECKPOINT || index === CYCLES) checkpoints[index] = await memory(cdp);
    }
    return { cycles: CYCLES, missed, checkpoints };
  });
  check(missed.length === 0, `cycles whose action did not happen (draft not open, popover not shown, zoom unchanged, second view not drawn): ${missed.join(', ')}`);

  await step('after-cycles', async () => {
    const handlers = await evaluate(`return ${HANDLERS};`);
    const diff = handlerDiff(baseline.handlers, handlers);
    check(diff.length === 0, `handlers after ${CYCLES} opens and closes differ from before: ${diff.join('; ')}`);
    const left = await evaluate(LEFT);
    check(Object.values(left).every(count => count === 0), `left in the window after the last close: ${JSON.stringify(left)}`);
    // Collected again here, not only at the last checkpoint: that GC runs right after the last close, and a view closed
    // in the same moment can still be held by work Obsidian finishes after it (measured: the 50th view once).
    const first = checkpoints[CHECKPOINT]; const last = checkpoints[CYCLES];
    await preciseGc(cdp);
    const alive = await track.alive();
    const tracked = await track.count();
    check(tracked === CYCLES + 1 + Math.floor((CYCLES + 1) / 5), `${tracked} views tracked, ${CYCLES + 1 + Math.floor((CYCLES + 1) / 5)} expected (warm-up, every cycle, and each split's second view)`);
    check(alive.length === 0, `${alive.length} of ${tracked} closed views are still reachable after a full GC: ${alive.slice(0, 12).join(', ')}`);

    // A cycles step that stopped early has no last checkpoint; its own failure is already recorded.
    const growth = first && last ? Object.fromEntries(Object.keys(GROWTH).map(key => [key, Math.round((last[key] - first[key]) * 100) / 100])) : null;
    check(growth !== null, `no memory reading at close ${CHECKPOINT} and close ${CYCLES} (the cycles stopped early)`);
    if (growth) {
      for (const [key, limit] of Object.entries(GROWTH)) {
        check(growth[key] <= limit, `${key} grew by ${growth[key]} between close ${CHECKPOINT} and close ${CYCLES} (limit ${limit})`);
      }
    }
    const source = await evaluate(`return app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}));`);
    check(source === SOURCE, 'the note changed while opening and closing (a draft or a zoom must not write)');
    return { diff, left, tracked, alive, growth, baseline: baseline.memory, first, last };
  });

  // Plugin reload with the map open: the leaf keeps its place, the map comes back, and nothing is there twice.
  await step('plugin-reload', async () => {
    await evaluate(`${OPEN} return true;`);
    const loaded = `const proto = (() => { let owner = Object.getPrototypeOf(window.__mappyE2E); while (owner && !Object.prototype.hasOwnProperty.call(owner, 'setViewState')) owner = Object.getPrototypeOf(owner); return owner; })();
      return {
        type: window.__mappyE2E.view.getViewType(),
        nodes: window.__mappyE2E.view.contentEl.querySelectorAll('.mappy-node').length,
        views: document.querySelectorAll('.mappy-view').length,
        commands: Object.keys(app.commands.commands).filter(id => id.startsWith('mappy:')).length,
        styles: Array.from(document.head.querySelectorAll('style')).filter(style => style.textContent.includes('.mappy-view')).length,
        settingTabs: app.setting.pluginTabs.filter(tab => tab.id === 'mappy').length,
        // Each distinct setViewState gets a number the first time it is seen: the one Obsidian has without Mappy
        // must be the same number after every disable, and a different one (a fresh wrapper) after every enable.
        // Held weakly, so the harness does not keep an unloaded plugin (its wrapper closes over it) reachable.
        routing: (() => { const seen = window.__mappyE2ERouting ??= []; let id = seen.findIndex(ref => ref.deref() === proto.setViewState); if (id === -1) { id = seen.length; seen.push(new WeakRef(proto.setViewState)); } return id; })(),
        handlers: ${HANDLERS},
      };`;
    const before = await evaluate(loaded);
    const rounds = [];
    for (let round = 1; round <= RELOADS; round += 1) {
      await evaluate(`const view = window.__mappyE2E.view; ${track.statement(`reload-${round}`)}
        await app.plugins.disablePlugin('mappy');
        await new Promise(resolve => setTimeout(resolve, 300));
        return true;`);
      const disabled = await evaluate(loaded);
      await evaluate(`await app.plugins.enablePlugin('mappy');
        for (const started = Date.now(); Date.now() - started < 5000; await new Promise(resolve => setTimeout(resolve, 100))) {
          if (window.__mappyE2E.view.contentEl.querySelector('.mappy-node')) break;
        }
        return true;`);
      const enabled = await evaluate(loaded);
      rounds.push({ disabled: { ...disabled, handlers: undefined }, enabled: { ...enabled, handlers: undefined } });
      check(disabled.views === 0 && disabled.commands === 0 && disabled.styles === 0 && disabled.settingTabs === 0,
        `reload ${round}, disabled: Mappy left ${JSON.stringify({ views: disabled.views, commands: disabled.commands, styles: disabled.styles, settingTabs: disabled.settingTabs })}`);
      const wrapped = round === 1 ? before.routing : rounds[round - 2].enabled.routing;
      check(disabled.routing !== wrapped, `reload ${round}, disabled: setViewState is still Mappy's wrapper`);
      check(disabled.routing === (rounds[0]?.disabled.routing ?? disabled.routing), `reload ${round}, disabled: setViewState is not the one the first disable left (${disabled.routing} vs ${rounds[0]?.disabled.routing})`);
      check(enabled.routing !== disabled.routing, `reload ${round}, enabled: setViewState is not wrapped again (the map routing is gone)`);
      check(enabled.type === 'mappy-map' && enabled.nodes > 0, `reload ${round}, enabled: the leaf did not get its map back (${enabled.type}, ${enabled.nodes} nodes)`);
      check(enabled.views === 1 && enabled.commands === before.commands && enabled.styles === 1 && enabled.settingTabs === 1,
        `reload ${round}, enabled: not exactly once: ${JSON.stringify({ views: enabled.views, commands: enabled.commands, styles: enabled.styles, settingTabs: enabled.settingTabs })}`);
      const diff = handlerDiff(before.handlers, enabled.handlers);
      check(diff.length === 0, `reload ${round}, enabled: handlers differ from before the reloads: ${diff.join('; ')}`);
    }
    await preciseGc(cdp);
    const alive = (await track.alive()).filter(label => label.startsWith('reload-'));
    check(alive.length === 0, `views unloaded by disabling the plugin are still reachable: ${alive.join(', ')}`);
    return { before: { ...before, handlers: undefined }, rounds, alive };
  });

  // The window reload below starts a new page, and with it an empty error list: what the cycles and the plugin
  // reloads threw is read now.
  await step('errors-before-reload', async () => {
    const errors = await evaluate('return [...(window.__mappyE2EErrors ?? [])];');
    check(errors.length === 0, `page errors while opening, closing and reloading the plugin: ${JSON.stringify(errors).slice(0, 1500)}`);
    return errors;
  });

  // Window reload with the map open: the saved workspace brings the map back, once.
  await step('app-reload', async () => {
    await evaluate(`await app.workspace.requestSaveLayout.run?.(); await app.workspace.saveLayout?.(); return true;`);
    // The page the reload makes has no collector until something installs one, and whatever it throws while Mappy loads
    // and the map is restored would go unseen: this connection has the page run it first, before the page's own scripts
    // (`Page.addScriptToEvaluateOnNewDocument` lives as long as the connection, which is closed only after the reload).
    const before = cdp;
    await before.send('Page.enable');
    await before.send('Page.addScriptToEvaluateOnNewDocument', { source: ERRORS });
    await evaluate(`setTimeout(() => app.commands.executeCommandById('app:reload'), 50); return true;`);
    await wait(3000);
    let restored = null;
    let connected = false;
    // Until the map is drawn or 30 s pass. Each try uses one connection and closes it unless it is the one kept.
    for (const started = Date.now(); Date.now() - started < 30000 && !(restored?.nodes > 0); await wait(500)) {
      let next = null;
      try {
        next = await connect();
        restored = await next.evaluate(`(async () => { if (!app.workspace.layoutReady || !app.plugins.plugins.mappy) return null;
          const leaves = app.workspace.getLeavesOfType('mappy-map');
          // By its view state: a tab restored in the background is deferred and has no \`view.file\` until loaded.
          const leaf = leaves.find(item => item.getViewState().state?.file === ${JSON.stringify(NOTE)});
          if (!leaf) return { leaves: leaves.length, nodes: 0, views: document.querySelectorAll('.mappy-view').length };
          app.workspace.revealLeaf?.(leaf); await leaf.loadIfDeferred?.();
          for (const started = Date.now(); Date.now() - started < 5000; await new Promise(resolve => setTimeout(resolve, 100))) {
            if (leaf.view.contentEl?.querySelector('.mappy-node')) break;
          }
          window.__mappyE2E = leaf;
          return { leaves: leaves.length, nodes: leaf.view.contentEl.querySelectorAll('.mappy-node').length, views: document.querySelectorAll('.mappy-view').length }; })()`);
      } catch {
        restored = null;
      }
      if (restored?.nodes > 0) { cdp = next; connected = true; } else next?.close();
    }
    // Without a live connection the \`finally\` below would wait out a closed socket's timeouts: connect once more.
    if (!connected) { try { cdp = await connect(); } catch { /* the finally records its own failure */ } }
    before.close();
    check(restored !== null, 'the window did not come back with Mappy loaded within 30 s');
    check(connected, `the map was not drawn again within 30 s of the window reload: ${JSON.stringify(restored)}`);
    if (restored) {
      check(restored.leaves === 1 && restored.nodes > 0 && restored.views === 1, `after the window reload the map is not back exactly once: ${JSON.stringify(restored)}`);
    }
    return restored;
  });

  await step('errors', async () => {
    const errors = await evaluate('return window.__mappyE2EErrors ? [...window.__mappyE2EErrors] : null;');
    check(errors !== null, 'the reloaded page has no error collector (addScriptToEvaluateOnNewDocument did not run)');
    check(errors?.length === 0, `page errors after the window reload: ${JSON.stringify(errors).slice(0, 1500)}`);
    return errors;
  });
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`stopped: ${error}`);
} finally {
  try {
    await evaluate(`for (const leaf of app.workspace.getLeavesOfType('mappy-map')) if (leaf.view.file?.path === ${JSON.stringify(NOTE)}) leaf.detach();
      delete window.__mappyE2ERouting; delete window.__mappyE2ETracked; return true;`);
    if (!flag('--keep') && record.steps.setup && !record.steps.setup.error) {
      await step('clean', makeDeleteNote(evaluate, NOTE));
    }
  } catch (error) {
    record.failures.push(`clean: ${error}`);
  }
  cdp.close();
}

process.exit(await finish(record, value('--json')));
