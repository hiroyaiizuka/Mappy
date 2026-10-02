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
 *
 * Usage (see docs/harness.md 実機検証 for the Obsidian instance; CDP port 9276 or above for the M9 runs):
 *   MAPPY_E2E_PORT=9276 npm run harness:e2e:ai-fake-engine -- [--reload] [--json <out.json>] [--keep]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required, until } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep, makeOpenStep, makeAfter, makePress, makeHistory, refuseOpenLeaves } from './dom-helpers.mjs';

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
const card = () => evaluate(`${VIEW}
  const card = el.querySelector('.mappy-ai-card');
  return card && !card.hidden ? { phase: card.dataset.phase, text: card.textContent } : null;`);
const draft = () => evaluate(`${VIEW} return Array.from(el.querySelectorAll('.mappy-ai-draft'), item => item.textContent);`);
const cardButton = text => `return Array.from(el.querySelectorAll('.mappy-ai-card button')).find(item => item.textContent === ${JSON.stringify(text)});`;

/** Select 旅の計画, press the AI button, choose the fake engine and focus the request. */
const openInput = async () => {
  await select('旅の計画');
  await clickAt(`return el.querySelector('.mappy-ai-button:not([hidden])');`);
  await until(async () => (await card())?.phase === 'input', 3000, 'the input did not open');
  await evaluate(`${VIEW}
    const engine = el.querySelector('[data-ai-field="engine"]');
    engine.value = 'fake';
    el.querySelector('[data-ai-field="instruction"]').focus();
    return true;`);
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
    await clickAt(cardButton('残す'));
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
    await clickAt(cardButton('捨てる'));
    await wait(500);
    check((await draft()).length === 0 && (await card()) === null, 'discard: the draft or the card stayed');
    check(await evaluate(`${VIEW} return await source();`) === opened.source, 'discard: the note changed');
    return true;
  });

  if (!flag('--keep')) {
    await step('clean', () => evaluate(`${VIEW}
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
