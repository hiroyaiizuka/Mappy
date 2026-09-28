/**
 * E62 (docs/harness.md): the indentation the map writes into a list follows the unit the list already uses, tabs or
 * spaces (LEV-225), through the real keyboard and pointer, on one note with a tab list, a space list, a tab branch,
 * a space branch, a space topic and a list that mixes the two.
 *
 * 1. Tab on 項目B (a first-level item of the tab list, no children yet) adds its first child with a tab.
 * 2. A drag of 項目A1 (a tab branch) onto 項目B1 nests it one tab deeper, no spaces.
 * 3. A drag of 項目D (a tab branch in another topic) onto 項目C (space list) writes it in spaces.
 * 4. A drag of 項目E (a space branch in another topic) onto 項目A (tab list, no children left) writes it in tabs.
 * 5. ⌥↓ on 項目X (tab) past 項目Z (4 spaces, the same width): the moved branch is written in spaces.
 * 6. A drag of the topic 空白のトピック (space list) onto 項目B1 joins it as a branch written in tabs.
 *
 * After each step the note is compared byte for byte, no list line mixes tabs and spaces, and every list item has the
 * same parent on the map as in Obsidian's metadata cache (what the reading view and the features built on the
 * cache read; LEV-195: a list that mixes the two is read one way by the map and live preview and another by these).
 * Until step 5 the lines of 混在 (mixed on purpose) are left out of that comparison.
 *
 * Usage: npm run harness:e2e:indent-unit -- [--reload] [--json <out.json>] [--keep]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, PARSE, makeSelect, makeState, makePluginStep, makeOpenStep, makeAim, makeAfter, makeAddNamed, makeMoveAlt } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const NOTE = 'Fixtures/E2E-indent-unit.md';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## タブのリスト', '',
  '- 項目A', '\t- 項目A1', '\t\t- 項目A1a', '- 項目B', '',
  '## 空白のリスト', '',
  '- 項目C', '  - 項目C1', '',
  '## タブの枝', '',
  '- 項目D', '\t- 項目D1', '',
  '## 空白の枝', '',
  '- 項目E', '  - 項目E1', '',
  '## 空白のトピック', '',
  '- 項目F', '  - 項目F1', '',
  '## 混在', '',
  '- 項目P', '\t- 項目X', '\t\t- 項目X1', '    - 項目Z', '',
].join('\n');
const MIXED = ['項目P', '項目X', '項目X1', '項目Z'];

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const state = makeState(evaluate);
const centre = makeAim(evaluate);
const after = makeAfter(evaluate);
const addNamed = makeAddNamed(cdp, evaluate);
const moveAlt = makeMoveAlt(cdp, evaluate);

/**
 * A real pointer drag from the centre of `from` to the centre of `to` (its "last child" zone), as E17 drives it. The
 * drop preview makes room in the layout and can move `to` under the pointer into an edge zone (a sibling slot), so
 * the pointer follows `to`'s centre until it stays put before the release.
 */
const drag = async (from, to) => {
  const start = await centre(from);
  const end = await centre(to);
  const before = (await state()).source;
  const mouse = (type, point, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', ...extra });
  await mouse('mouseMoved', start, { buttons: 0 });
  await mouse('mousePressed', start, { buttons: 1, clickCount: 1 });
  const steps = 16;
  for (let index = 1; index <= steps; index += 1) {
    const point = { x: start.x + (end.x - start.x) * index / steps, y: start.y + (end.y - start.y) * index / steps };
    await mouse('mouseMoved', point, { buttons: 1 });
    await wait(40);
  }
  await wait(400);
  let at = end;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const now = await centre(to);
    const settled = Math.abs(now.x - at.x) < 1 && Math.abs(now.y - at.y) < 1 && attempt > 0;
    at = now;
    await mouse('mouseMoved', { x: at.x + 1, y: at.y }, { buttons: 1 });
    await wait(400);
    if (settled) break;
  }
  await mouse('mouseReleased', { x: at.x + 1, y: at.y }, { buttons: 0, clickCount: 1 });
  return after(before);
};

/**
 * Once the metadata cache has read `text` (every list item it lists starts on a list line of `text`, as many as
 * there are): per list node on the map, its parent's line on the map and in the cache (negative for a first-level
 * item in both). A cache still on an older text after 5 s is returned as `current: false`.
 */
const readers = text => evaluate(`${VIEW} ${PARSE}
  const lines = ${JSON.stringify(text)}.split('\\n');
  const listLines = lines.flatMap((line, index) => /^[ \\t]*[-+*][ \\t]/u.test(line) ? [index] : []);
  const lineOf = offset => doc.source.slice(0, offset).split('\\n').length - 1;
  for (let waited = 0; ; waited += 100) {
    const items = app.metadataCache.getFileCache(view.file)?.listItems ?? [];
    const starts = items.map(item => item.position.start.line);
    const current = items.length === listLines.length && starts.every(line => listLines.includes(line));
    if ((current && doc.source === ${JSON.stringify(text)}) || waited > 5000) {
      const cache = new Map(items.map(item => [item.position.start.line, item.parent]));
      return { current, waited, items: doc.nodes.filter(node => node.kind === 'list').map(node => {
        const parent = byId.get(node.parentId ?? '');
        const line = lineOf(node.from);
        return { title: node.title, line, map: parent?.kind === 'list' ? lineOf(parent.from) : -1, cache: cache.get(line) ?? null };
      }) };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }`);

/** The checks every step shares: the note is `expected`, no list line mixes tabs and spaces, and the map and the cache agree on every parent. */
const checkStep = async (label, result, expected, { mixedSettled = false } = {}) => {
  check(result.messages.length === 0, `${label} showed ${JSON.stringify(result.messages)}`);
  check(result.source === expected, `${label}: unexpected note\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(result.source)}`);
  const mixedLines = result.source.split('\n').filter(line => /^(?: +\t|\t+ +)[ \t]*[-+*] /u.test(line));
  check(mixedLines.length === 0, `${label}: list lines mixing tabs and spaces: ${JSON.stringify(mixedLines)}`);
  const read = await readers(result.source);
  check(read.current, `${label}: the metadata cache did not read the note within 5 s`);
  const disagreeing = read.items.filter(item => (mixedSettled || !MIXED.includes(item.title))
    && (item.cache === null || Math.sign(item.map) !== Math.sign(item.cache) || (item.map >= 0 && item.map !== item.cache)));
  check(disagreeing.length === 0, `${label}: the map and the metadata cache disagree on the parent of ${JSON.stringify(disagreeing)}`);
  return { ...result, readers: read };
};

/** The drag must have changed the note; otherwise the rest runs on a document it was not written for. */
const landed = (result, before, name) => {
  if (result.source !== before) return;
  record.failures.push(`${name}: the step did not change the note${result.messages.length ? ` (${result.messages.join(' / ')})` : ''}`);
  record.stopped = `${name} changed nothing; the remaining steps were not run`;
  throw new StopCase(record.stopped);
};

let opened;
try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  opened = required(record, 'open', await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE })));
  check(opened.source === SOURCE, 'opening the map changed the note');
  let current = SOURCE;

  const run = (name, action, edit, options) => step(name, async () => {
    const before = current;
    const result = await action();
    landed(result, before, name);
    const expected = edit(before);
    current = result.source;
    return checkStep(name, result, expected, options);
  });

  await run('add-first-child-tab', async () => {
    await select('項目B');
    return addNamed('Tab', '項目B1');
  }, text => text.replace('- 項目B\n', '- 項目B\n\t- 項目B1\n'));

  await run('drag-tab-branch-under-new-child', () => drag('項目A1', '項目B1'),
    text => text.replace('\t- 項目A1\n\t\t- 項目A1a\n', '').replace('\t- 項目B1\n', '\t- 項目B1\n\t\t- 項目A1\n\t\t\t- 項目A1a\n'));

  await run('drag-tab-branch-into-space-list', () => drag('項目D', '項目C'),
    text => text.replace('- 項目D\n\t- 項目D1\n\n', '').replace('  - 項目C1\n', '  - 項目C1\n  - 項目D\n    - 項目D1\n'));

  await run('drag-space-branch-into-tab-list', () => drag('項目E', '項目A'),
    text => text.replace('- 項目E\n  - 項目E1\n\n', '').replace('- 項目A\n', '- 項目A\n\t- 項目E\n\t\t- 項目E1\n'));

  await run('move-tab-sibling-past-space-sibling', async () => {
    await select('項目X');
    return moveAlt('ArrowDown');
  }, text => text.replace('\t- 項目X\n\t\t- 項目X1\n    - 項目Z\n', '    - 項目Z\n    - 項目X\n      - 項目X1\n'), { mixedSettled: true });

  await run('drag-space-topic-into-tab-list', () => drag('空白のトピック', '項目B1'),
    text => text.replace('## 空白のトピック\n\n- 項目F\n  - 項目F1\n\n', '')
      .replace('\t\t\t- 項目A1a\n', '\t\t\t- 項目A1a\n\t\t- 空白のトピック\n\t\t\t- 項目F\n\t\t\t\t- 項目F1\n'), { mixedSettled: true });
} catch (error) {
  if (!(error instanceof StopCase)) throw error;
} finally {
  if (opened && !flag('--keep')) {
    await step('clean', () => evaluate(`${VIEW}
      const file = view.file;
      leaf.detach();
      if (file) await app.vault.delete(file, true);
      delete window.__mappyE2E;
      delete window.__mappyE2EBefore;
      return { removed: file?.path ?? null };`));
  }
  cdp.close();
}

process.exit(await finish(record, value('--json')));
