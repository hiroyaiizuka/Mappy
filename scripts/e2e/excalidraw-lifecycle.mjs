/**
 * E25 (docs/harness.md, §5 M6): Mappy disabled → Excalidraw reloaded → Mappy enabled, on the real Obsidian.
 *
 * §5 M6 asks two things of the plugin's lifecycle: 「Excalidraw が無効でも Mappy は通常どおり動き、Excalidraw を後から
 * 有効化・再読込してもドロップが効く」 and 「Mappy を無効化するとフックと `setViewState` の差し替えが外れる」. Both hang on
 * two slots other code shares: `ExcalidrawAutomate.onDropHook` (one global slot, `ExcalidrawBridge` chains to what
 * was there and puts it back) and `WorkspaceLeaf.prototype.setViewState`, which Excalidraw wraps too
 * (`patchMethod`, src/obsidian/patch.ts). Which of the two wrappers is on top depends on the order the plugins
 * loaded, and the removal takes a different road in each: under Excalidraw's wrapper Mappy's turns into a
 * pass-through, on top it puts the one below back. One pass through the stages below walks both roads whatever order
 * Obsidian started the plugins in: Excalidraw is reloaded first (stages 1–2, which is also 「後から有効化」), so its
 * wrapper is the outer one when Mappy is disabled in stage 3; Mappy is enabled last in stage 6, so its wrapper is the
 * outer one when it is disabled in stage 7.
 *
 * At every stage the case reads, rather than trusts, what the stage should have left:
 * - `opens`: the view a `mappy: true` note gets from `setViewState({ type: 'markdown' })` in a fresh tab — the map
 *   while Mappy is loaded, Markdown otherwise (the routing is gone, not just unused);
 * - the prototype's `setViewState` and the drawing's `onDropHook`, compared by identity with the earlier stages;
 * - `drop`: a real Option-drag of the note from the file explorer onto the drawing (`makeFileDrag`) — the map's
 *   elements while Mappy is loaded, Excalidraw's own default otherwise.
 * The plugins are toggled with `app.plugins.disablePlugin`/`enablePlugin`, which do not rewrite
 * `community-plugins.json`, and both are enabled again at the end, whatever happened.
 *
 * Usage: npm run harness:e2e:excalidraw-lifecycle -- [--reload] [--json <out.json>] [--shot <out.png>] [--keep]
 *   --reload  re-enable Mappy first, so a build made after Obsidian started is the one under test
 *   --keep    leave the notes and the drawing in the vault
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { makePluginStep } from './dom-helpers.mjs';
import {
  EXCALIDRAW, mapSource, plainSource, makeDrawingSetup, makeFileDrag, makeDrawingClean, makeToggle, DRAWING_LEAF,
} from './excalidraw-helpers.mjs';

const { flag, value } = parseArgs();

const MAP = 'Fixtures/E2E-excalidraw-lifecycle-map.md';
const PLAIN = 'Fixtures/E2E-excalidraw-lifecycle-plain.md';
const DRAWING = 'Fixtures/E2E-excalidraw-lifecycle.excalidraw.md';
const ALT = 1;

const record = createRecord(VAULT, MAP);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const drag = makeFileDrag(cdp, evaluate);
const toggle = makeToggle(evaluate);

/**
 * What this stage left, stored under `label` for the identity checks of later stages: which plugins are loaded,
 * whether the automate object is there (and the same one), the drop hook and the prototype's `setViewState` against
 * each earlier stage, and what a `mappy: true` note opens as. A stage whose snapshot failed is not stored, so a
 * comparison with it is `undefined` — neither `=== true` nor `=== false`, and every check below names the one it
 * needs (`differs`/`sameAs`), so a missing stage fails the check rather than passing it.
 */
const snapshot = label => evaluate(`const E = window.__mappyExcalidrawE2E;
  const leaf = app.workspace.getLeaf('tab');
  await leaf.setViewState({ type: 'markdown', state: { file: ${JSON.stringify(MAP)} } });
  let nodes = 0;
  for (const started = Date.now(); Date.now() - started < 3000; await new Promise(resolve => setTimeout(resolve, 100))) {
    nodes = leaf.view.contentEl.querySelectorAll('.mappy-node').length;
    if (leaf.view.getViewType() !== 'mappy-map' || nodes > 0) break;
  }
  const opens = leaf.view.getViewType();
  // Read after the probe: a wrapper patchMethod left as a pass-through takes itself off the prototype on the next
  // call once nothing is above it, so the function read before the call can be one that is already gone. The probe's
  // own leaf gives the prototype (the workspace can have no recent leaf once Excalidraw closed the drawing's).
  let owner = Object.getPrototypeOf(leaf);
  leaf.detach();
  while (owner && !Object.prototype.hasOwnProperty.call(owner, 'setViewState')) owner = Object.getPrototypeOf(owner);
  const ea = window.ExcalidrawAutomate ?? null;
  const now = { svs: owner.setViewState, ea, hook: ea?.onDropHook ?? null };
  E.stages ??= {};
  const same = key => Object.fromEntries(Object.entries(E.stages).map(([name, stage]) => [name, stage[key] === now[key]]));
  const result = {
    mappy: !!app.plugins.plugins.mappy, excalidraw: !!app.plugins.plugins[${JSON.stringify(EXCALIDRAW)}],
    automate: ea !== null, hook: now.hook === null ? null : typeof now.hook,
    sameSetViewState: same('svs'), sameHook: same('hook'), sameAutomate: same('ea'),
    opens, nodes, errors: [...E.errors],
  };
  E.stages[${JSON.stringify(label)}] = now;
  return result;`);

const sameAs = (relation, label) => relation?.[label] === true;
const differs = (relation, label) => relation?.[label] === false;

/** Mappy is loaded: map notes open as maps, and an Option-drag inserts the map. */
const expectMappy = (label, state, drop) => {
  check(state.opens === 'mappy-map' && state.nodes > 0, `${label}: a mappy: true note opened as ${state.opens} (${state.nodes} nodes), not as the map`);
  if (drop) check(drop.kind === 'map', `${label}: the Option-drag inserted ${drop.kind} (${JSON.stringify(drop.texts)}), not the map`);
};
/** Mappy is not loaded: nothing of it is left in the routing or the drop. */
const expectNoMappy = (label, state, drop) => {
  check(state.opens === 'markdown', `${label}: a mappy: true note opened as ${state.opens}; the setViewState routing is still in place`);
  check(state.nodes === 0, `${label}: map nodes are drawn with Mappy disabled`);
  if (drop) check(drop.kind === 'other', `${label}: the Option-drag inserted ${drop.kind} (${JSON.stringify(drop.texts)}), not Excalidraw's own default`);
};

/** The plugins loaded when the case started: the only ones `restore` loads again. */
const loadedAtStart = await evaluate(`return ['mappy', ${JSON.stringify(EXCALIDRAW)}].filter(id => !!app.plugins.plugins[id]);`);
let restored = false;
const restore = async () => {
  if (restored) return;
  restored = true;
  record.steps.restore = await evaluate(`
    const out = {};
    for (const id of ${JSON.stringify(loadedAtStart)}) {
      if (!app.plugins.plugins[id]) await app.plugins.enablePlugin(id);
      out[id] = !!app.plugins.plugins[id];
    }
    return out;`).catch(error => ({ error: String(error) }));
};

try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  required(record, 'setup', await step('setup', makeDrawingSetup(evaluate, {
    notes: { [MAP]: mapSource('E2E-excalidraw-lifecycle-plain'), [PLAIN]: plainSource('E2E-excalidraw-lifecycle-map') },
    drawing: DRAWING,
  })));
  await step('0-start', () => snapshot('start'));

  // 1. Excalidraw disabled, Mappy on: Mappy works as usual without it.
  await step('1-excalidraw-off', async () => {
    await toggle(EXCALIDRAW, false);
    const state = await snapshot('excalidrawOff1');
    check(!state.automate, '1-excalidraw-off: ExcalidrawAutomate is still on window');
    expectMappy('1-excalidraw-off', state, null);
    return { state };
  });

  // 2. Excalidraw enabled after Mappy (a late load or a reload): Mappy hooks the new automate object and the drop
  //    works. Excalidraw's setViewState wrapper is now the outer one whatever order Obsidian started them in, which
  //    is what makes stage 3 take the "shadowed" road. The drag without Option is the control: Excalidraw's default.
  await step('2-excalidraw-on', async () => {
    await toggle(EXCALIDRAW, true);
    const state = await snapshot('excalidrawOn2');
    const drop = await drag(MAP, { modifiers: ALT, at: [0.3, 0.3] });
    const plain = await drag(MAP, { modifiers: 0, at: [0.7, 0.3] });
    check(state.automate && differs(state.sameAutomate, 'start'), '2-excalidraw-on: the reload did not bring a new ExcalidrawAutomate');
    check(state.hook === 'function', '2-excalidraw-on: the reloaded Excalidraw has no drop hook');
    check(differs(state.sameSetViewState, 'excalidrawOff1'), '2-excalidraw-on: Excalidraw did not wrap setViewState again');
    expectMappy('2-excalidraw-on', state, drop);
    check(plain.kind === 'other', `2-excalidraw-on: a drag without Option inserted ${plain.kind}, not Excalidraw's default`);
    return { state, drop, plain };
  });

  // 3. Mappy disabled under Excalidraw's wrapper: its own wrapper cannot be taken out of the chain without undoing
  //    Excalidraw's, so it has to turn into a pass-through — the outer function stays Excalidraw's, and the routing
  //    is gone all the same. Its hook leaves the drop slot.
  await step('3-mappy-off-shadowed', async () => {
    await toggle('mappy', false);
    const state = await snapshot('mappyOff3');
    const drop = await drag(MAP, { modifiers: ALT, at: [0.3, 0.5] });
    check(sameAs(state.sameSetViewState, 'excalidrawOn2'), '3-mappy-off-shadowed: disabling Mappy replaced the outer setViewState (Excalidraw\'s wrapper was undone)');
    check(differs(state.sameHook, 'excalidrawOn2'), '3-mappy-off-shadowed: the drop hook is still the one installed with Mappy loaded');
    // Nothing else hooks drops in this vault (preflight allows only mappy and Excalidraw) and Excalidraw leaves the slot
    // empty, so what Mappy chained to and has to put back is no hook at all — not a hook of its own that passes through.
    check(state.hook === null, `3-mappy-off-shadowed: the drop hook slot holds a ${state.hook}, not what was there before Mappy (none)`);
    expectNoMappy('3-mappy-off-shadowed', state, drop);
    return { state, drop };
  });

  // 4–5. Excalidraw reloaded with Mappy off: a new automate object, and nothing of Mappy's on it.
  await step('4-excalidraw-off', async () => {
    await toggle(EXCALIDRAW, false);
    const state = await snapshot('excalidrawOff4');
    check(!state.automate, '4-excalidraw-off: ExcalidrawAutomate is still on window');
    expectNoMappy('4-excalidraw-off', state, null);
    return { state };
  });
  await step('5-excalidraw-on', async () => {
    await toggle(EXCALIDRAW, true);
    const state = await snapshot('excalidrawOn5');
    const drop = await drag(MAP, { modifiers: ALT, at: [0.3, 0.7] });
    check(state.automate && differs(state.sameAutomate, 'excalidrawOn2'), '5-excalidraw-on: the reload did not bring a new ExcalidrawAutomate');
    check(state.hook === null, `5-excalidraw-on: the reloaded Excalidraw has a ${state.hook} drop hook with Mappy disabled`);
    expectNoMappy('5-excalidraw-on', state, drop);
    return { state, drop };
  });

  // 6. Mappy enabled: it hooks the reloaded Excalidraw and routes again, its wrapper on top this time.
  await step('6-mappy-on', async () => {
    await toggle('mappy', true);
    const state = await snapshot('mappyOn6');
    const drop = await drag(MAP, { modifiers: ALT, at: [0.6, 0.5] });
    check(state.hook === 'function' && differs(state.sameHook, 'excalidrawOn5'), '6-mappy-on: no new drop hook on the reloaded Excalidraw');
    check(differs(state.sameSetViewState, 'excalidrawOn5'), '6-mappy-on: setViewState is still the one without Mappy');
    expectMappy('6-mappy-on', state, drop);
    return { state, drop };
  });

  // 7. Mappy disabled with its wrapper on top: what was below comes back exactly, the hook slot too. Then on again.
  await step('7-mappy-off-on-top', async () => {
    await toggle('mappy', false);
    const state = await snapshot('mappyOff7');
    check(sameAs(state.sameSetViewState, 'excalidrawOn5'), '7-mappy-off-on-top: setViewState is not the one Excalidraw left (stage 5)');
    check(sameAs(state.sameHook, 'excalidrawOn5'), '7-mappy-off-on-top: the drop hook is not the one Excalidraw had before Mappy (stage 5)');
    expectNoMappy('7-mappy-off-on-top', state, null);
    await toggle('mappy', true);
    const again = await snapshot('mappyOn7');
    const drop = await drag(MAP, { modifiers: ALT, at: [0.6, 0.8] });
    expectMappy('7-mappy-on-again', again, drop);
    return { state, again, drop };
  });

  // Read last, after the final drop: an error the re-enabled hook threw there must count too.
  await step('errors', async () => {
    const errors = await evaluate('return [...window.__mappyExcalidrawE2E.errors];');
    check(errors.length === 0, `page errors while toggling and dropping: ${JSON.stringify(errors)}`);
    return errors;
  });

  const shot = value('--shot');
  if (shot) {
    await evaluate(`${DRAWING_LEAF} const leaf = await drawingLeaf(); leaf.view.zoomToFit(false); await new Promise(resolve => setTimeout(resolve, 1500)); return true;`);
    await cdp.screenshot(shot);
  }
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`stopped: ${error}`);
} finally {
  await restore();
  if (record.steps.restore?.error || loadedAtStart.some(id => !record.steps.restore?.[id])) {
    record.failures.push(`the plugins loaded at the start were not all re-enabled: ${JSON.stringify(record.steps.restore)}`);
  }
  if (!flag('--keep') && record.steps.setup && !record.steps.setup.error) {
    await wait(500);
    await step('clean', makeDrawingClean(evaluate, [MAP, PLAIN]));
  }
  cdp.close();
}

process.exit(await finish(record, value('--json')));
