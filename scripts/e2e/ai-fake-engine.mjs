/**
 * The map's AI, 案 A, on the real Obsidian with the fake engine (LEV-271, docs/architecture.md §11.5): no CLI, no
 * license server. Needs a build with the development unlock (`MAPPY_AI_DEV_UNLOCK`, §11.6: `npm run
 * harness:prepare:ai-dev`, LEV-273) whose `src/main.ts` gives the view `AiServices` with `fakeRunner` (the wiring the
 * third of LEV-270／271／273 to merge adds, §11.8). Without them the case stops at `ai-ready` and says so: a release
 * build has no AI button to press, which is what `harness:e2e:ai-free-state` (LEV-273) checks instead.
 *
 * The rows are the user's operations on one list item (操作 × 対象 is the vitest file's, tests/ui/mindmap-view-ai.test.ts):
 *   ime      the AI button → a request typed through the IME (`Input.imeSetComposition`) → ⌘↵ while composing: no run;
 *            the reading confirmed → ⌘↵: the run starts (E01's required case on the input).
 *   draft    the fake engine's progress, then the dotted draft under the node; the note unchanged, nothing in
 *            `localStorage` under a `mappy` key.
 *   keep     残す: one write; ⌘Z takes all of it back, ⌘⇧Z brings it back.
 *   discard  a second run → 捨てる: the note unchanged.
 * LEV-307 (⌘↵ against Obsidian's default Mod+Enter, which its keymap ran at the window's capture phase before the card
 * heard the key). The fake engine's `run` is counted in the page, and Obsidian's default is seen by the `open-link`
 * event it sends to the focus. ⌘ is ⌘ (modifiers 4), never Ctrl+Enter in its place:
 *   keys-once   the input open, the focus in the request → ⌘↵: exactly one run, Obsidian's default not run.
 *   keys-ime    ⌘↵ during a composition: no run, the reading still there; it is confirmed and a second composition
 *               converts as usual (the request holds both); ⌘↵ then: exactly one run.
 *   keys-scope  the input open but the focus on the map → ⌘↵: no run, Obsidian's default runs, the input's scope is
 *               off the keymap; the card closed (Escape) → ⌘↵: the same.
 *
 * Usage (see docs/harness.md 実機検証 for the Obsidian instance; CDP port 9276 or above for the M9 runs):
 *   MAPPY_E2E_PORT=9276 npm run harness:e2e:ai-fake-engine -- [--reload] [--json <out.json>] [--keep]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required, until } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep, makeOpenStep, makeAfter, makePress, makeHistory, makeAiCard, refuseOpenLeaves } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-ai-fake-engine.md';
const SOURCE = ['---', 'mappy: true', '---', '## AI', '', '- 旅の計画', '  - 予約', '- 持ち物', ''].join('\n');

const record = createRecord(VAULT, NOTE);
const cdp = await connect({ build: 'ai-dev' });
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const after = makeAfter(evaluate);

const press = makePress(cdp, evaluate);
const history = makeHistory(cdp, evaluate);
/** A real click at the centre of what `locate` returns, only once it is the topmost element there (`makePress`). */
const clickAt = locate => press(`const node = (() => { ${locate} })();`);
const ai = makeAiCard(cdp, evaluate);
const { card, draft } = ai;

/** Select 旅の計画, press the AI button, focus the request and choose the fake engine. */
const openInput = async () => {
  await ai.open('旅の計画');
  await evaluate(`${VIEW} el.querySelector('[data-ai-field="engine"]').value = 'fake'; return true;`);
};

try {
  await step('plugin', makePluginStep(cdp, evaluate, flag));
  const opened = required(record, 'open', await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE })));
  required(record, 'ai-ready', await step('ai-ready', async () => {
    const ready = await evaluate(`${VIEW} return { services: !!view.aiServices, fake: !!view.aiServices?.fakeRunner };`);
    if (!ready.fake) throw new Error(`this build gives the map no fake engine (${JSON.stringify(ready)}): install the development unlock build (LEV-273) with the AI wired in src/main.ts`);
    return ready;
  }));

  await step('ime', async () => {
    await openInput();
    await cdp.send('Input.imeSetComposition', { text: 'ひろげて', selectionStart: 4, selectionEnd: 4 });
    await cdp.realKey('Enter', 4);
    await wait(500);
    check((await card())?.phase === 'input', 'ime: ⌘↵ during the composition started a run');
    await cdp.insertText('広げて');
    await wait(200);
    await cdp.realKey('Enter', 4);
    await until(async () => (await card())?.phase === 'running' || (await card())?.phase === 'draft', 3000, 'ime: ⌘↵ after the composition did not run');
    return { card: await card() };
  });

  await step('draft', async () => {
    await until(async () => (await card())?.phase === 'draft', 15000, 'draft: the fake engine did not answer');
    const labels = await draft();
    check(labels.length > 0, 'draft: no dotted nodes');
    const text = await evaluate(`${VIEW} return await source();`);
    check(text === opened.source, 'draft: the note changed while the draft was shown');
    const stored = await evaluate(`return Object.keys(window.localStorage).filter(key => /mappy/iu.test(key) && /draft|ai-result/iu.test(key));`);
    check(stored.length === 0, `draft: stored in localStorage: ${JSON.stringify(stored)}`);
    return { labels };
  });

  await step('keep', async () => {
    const labels = await draft();
    await press(ai.button('残す'));
    const kept = await after(opened.source);
    check(labels.every(label => kept.source.includes(label)), `keep: the draft was not written:\n${kept.source}`);
    check((await draft()).length === 0, 'keep: the dotted nodes stayed');
    // ⌘Z／⌘⇧Z with the focus put back in the canvas first (`makeHistory`): a chord outside it reaches macOS.
    const undone = await history('undo');
    check(undone.source === opened.source, `keep: ⌘Z did not take all of it back:\n${undone.source}`);
    const redone = await history('redo');
    check(redone.source === kept.source, `keep: ⌘⇧Z did not bring it back:\n${redone.source}`);
    // Back to the fixture for the next row.
    await history('undo');
    return { added: kept.source.split('\n').length - opened.source.split('\n').length };
  });

  await step('discard', async () => {
    await openInput();
    await cdp.insertText('捨てる案');
    await cdp.realKey('Enter', 4);
    await until(async () => (await card())?.phase === 'draft', 15000, 'discard: the fake engine did not answer');
    await press(ai.button('捨てる'));
    await wait(500);
    check((await draft()).length === 0 && (await card()) === null, 'discard: the draft or the card stayed');
    check(await evaluate(`${VIEW} return await source();`) === opened.source, 'discard: the note changed');
    return true;
  });

  // LEV-307: the fake engine's runs and Obsidian's default Mod+Enter, counted in the page (undone in `clean`).
  await evaluate(`${VIEW}
    const runner = view.aiServices.fakeRunner;
    // A wrapper an earlier run left (--keep) is of the runner before a --reload: undone, then this runner wrapped.
    const left = window.__mappyE2EKeys;
    if (left && left.runner !== runner) {
      left.runner.run = left.run;
      document.removeEventListener('open-link', left.onLink, true);
      delete window.__mappyE2EKeys;
    }
    if (!window.__mappyE2EKeys) {
      const run = runner.run;
      const keys = window.__mappyE2EKeys = { runs: 0, defaults: 0, runner, run };
      runner.run = (...args) => { keys.runs += 1; return run.apply(runner, args); };
      keys.onLink = () => { keys.defaults += 1; };
      document.addEventListener('open-link', keys.onLink, true);
    }
    return true;`);
  const counts = () => evaluate(`return { runs: window.__mappyE2EKeys.runs, defaults: window.__mappyE2EKeys.defaults };`);
  /** Whether the keymap's current scope on this window is the input's (`AiController.keys`). */
  const inputScope = () => evaluate(`${VIEW} return app.keymap.getWindowStack(window).scope === view.ai?.keys;`);
  const request = () => evaluate(`${VIEW} return el.querySelector('[data-ai-field="instruction"]')?.value ?? null;`);
  /** 捨てる on the draft the row's run left, so the next row starts from the note as it was. */
  const discardDraft = async row => {
    await until(async () => (await card())?.phase === 'draft', 15000, `${row}: the fake engine did not answer`);
    await press(ai.button('捨てる'));
    await wait(500);
    check(await evaluate(`${VIEW} return await source();`) === opened.source, `${row}: the note changed`);
  };

  await step('keys-once', async () => {
    // What the input's scope goes over (its parent is the view's scope, `AiController.keys`): the workspace's scope
    // with the map's leaf active, which hands the keys to the view's.
    await select('旅の計画');
    const under = await evaluate(`${VIEW} return { workspace: app.keymap.getWindowStack(window).scope === app.workspace.scope, active: app.workspace.activeLeaf?.view === view };`);
    check(under.workspace && under.active, `keys-once: before the input, the keymap's scope is not the workspace's with the map active: ${JSON.stringify(under)}`);
    await openInput();
    await cdp.insertText('一回だけ');
    check(await inputScope(), 'keys-once: the input\'s scope is not on the keymap with the focus in the request');
    const stack = await evaluate(`${VIEW} const stack = app.keymap.getWindowStack(window); return { under: stack.prevScopes.at(-1) === app.workspace.scope, copies: stack.prevScopes.filter(scope => scope === view.ai?.keys).length };`);
    check(stack.under && stack.copies === 0, `keys-once: the input's scope is not once over the workspace's: ${JSON.stringify(stack)}`);
    const before = await counts();
    await cdp.realKey('Enter', 4);
    await wait(800);
    const now = await counts();
    check(now.runs - before.runs === 1, `keys-once: ⌘↵ ran ${now.runs - before.runs} times`);
    check(now.defaults === before.defaults, 'keys-once: Obsidian\'s Mod+Enter ran as well');
    await discardDraft('keys-once');
    // `defaults` is read with keys-scope's, where the same count must go up by one per ⌘↵ off the input.
    return { under, stack, runs: now.runs - before.runs, defaults: now.defaults - before.defaults };
  });

  await step('keys-ime', async () => {
    await openInput();
    await cdp.send('Input.imeSetComposition', { text: 'かくてい', selectionStart: 4, selectionEnd: 4 });
    const before = await counts();
    await cdp.realKey('Enter', 4);
    await wait(500);
    const composing = await counts();
    check(composing.runs === before.runs, 'keys-ime: ⌘↵ during the composition ran');
    check((await card())?.phase === 'input', 'keys-ime: the input closed during the composition');
    const reading = await request();
    check(reading?.includes('かくてい') ?? false, `keys-ime: the reading went with ⌘↵: ${JSON.stringify(reading)}`);
    await cdp.insertText('確定');
    await wait(200);
    // The IME still converts after it: a second composition, confirmed.
    await cdp.send('Input.imeSetComposition', { text: 'つづき', selectionStart: 3, selectionEnd: 3 });
    await cdp.insertText('続き');
    await wait(200);
    const typed = await request();
    check(typed === '確定続き', `keys-ime: the request after two conversions is ${JSON.stringify(typed)}`);
    await cdp.realKey('Enter', 4);
    await wait(800);
    const now = await counts();
    check(now.runs - composing.runs === 1, `keys-ime: ⌘↵ after the composition ran ${now.runs - composing.runs} times`);
    check(now.defaults === before.defaults, 'keys-ime: Obsidian\'s Mod+Enter ran');
    await discardDraft('keys-ime');
    return { typed, runs: now.runs - before.runs, defaults: now.defaults - before.defaults };
  });

  await step('keys-scope', async () => {
    await openInput();
    await cdp.insertText('外');
    const before = await counts();
    // The focus back on the map with the input still open: a real click on the node.
    await select('旅の計画');
    const onMap = await inputScope();
    check(!onMap, 'keys-scope: the input\'s scope stayed on the keymap with the focus on the map');
    await cdp.realKey('Enter', 4);
    await wait(500);
    const mapped = await counts();
    check(mapped.runs === before.runs, 'keys-scope: ⌘↵ on the map ran the AI');
    check(mapped.defaults - before.defaults === 1, `keys-scope: Obsidian's Mod+Enter ran ${mapped.defaults - before.defaults} times on the map`);
    const phase = (await card())?.phase ?? null;
    check(phase === 'input', `keys-scope: the input did not stay open with the focus on the map (${phase})`);
    // The card closed (Escape from the request), the key is Obsidian's again.
    await clickAt(`return el.querySelector('[data-ai-field="instruction"]');`);
    check(await inputScope(), 'keys-scope: the input\'s scope did not come back with the focus');
    await cdp.realKey('Escape');
    await wait(300);
    check((await card()) === null, 'keys-scope: the card did not close');
    check(!(await inputScope()), 'keys-scope: the input\'s scope stayed on the keymap after the card closed');
    await cdp.realKey('Enter', 4);
    await wait(500);
    const closed = await counts();
    check(closed.runs === before.runs, 'keys-scope: ⌘↵ after the card closed ran the AI');
    check(closed.defaults - mapped.defaults === 1, `keys-scope: Obsidian's Mod+Enter ran ${closed.defaults - mapped.defaults} times after the card closed`);
    check(await evaluate(`${VIEW} return await source();`) === opened.source, 'keys-scope: the note changed');
    return { phaseAfterClick: phase, runs: closed.runs - before.runs, defaults: closed.defaults - before.defaults };
  });

  if (!flag('--keep')) {
    await step('clean', () => evaluate(`${VIEW}
      const keys = window.__mappyE2EKeys;
      if (keys) {
        keys.runner.run = keys.run;
        document.removeEventListener('open-link', keys.onLink, true);
        delete window.__mappyE2EKeys;
      }
      const file = view.file;
      leaf.detach();
      ${refuseOpenLeaves([NOTE])}
      if (file) await app.vault.delete(file, true);
      delete window.__mappyE2E;
      delete window.__mappyE2EBefore;
      return { removed: file?.path ?? null };`));
  }
} catch (error) {
  if (!(error instanceof StopCase)) throw error;
} finally {
  cdp.close();
}

process.exit(await finish(record, value('--json')));
