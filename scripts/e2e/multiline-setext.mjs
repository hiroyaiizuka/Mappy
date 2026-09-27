/**
 * E60 (docs/harness.md): a multi-line Setext heading (a paragraph of two or more lines, then `===` / `---`) is no
 * node, as Obsidian does not read it as a heading (LEV-208, 本人の決定 2026-09-27). One-line Setext headings, a `<br>`
 * in the one line included, stay headings. The matrix is the person's operation × the shape:
 *
 *   shapes     multi-line `===` / `---`, a one-line Setext, a `<br>` in the one line, in the headings format (under a
 *              section) and in the list format (between items of a section, inside a list item)
 *   operations open the map without editing (the note is not rewritten), then F2 → Shift+Enter → Enter on the node
 *              that holds the paragraph, on the node after it and on the one-line Setext heading (LEV-202's `<br>`)
 *
 * After each, the headings the map shows (its parsed nodes and its labels) are the ones Obsidian's metadataCache lists,
 * level for level, and Obsidian's own reading view shows the paragraph as a paragraph (`---`: a rule after it).
 *
 * Usage: npm run harness:e2e:multiline-setext -- [--reload] [--json <out.json>] [--keep]
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeAfter, makeOpenStep, makePluginStep, makeSelect, refuseOpenLeaves } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const HEADINGS_NOTE = 'Fixtures/E2E-multiline-setext-headings.md';
const HEADINGS = [
  '---', 'mappy: true', '---',
  '# 前', '',
  '本文', '',
  '複数', '行の見出し', '===', '',
  '別の', '二行', '---', '',
  '一行', '---', '',
  '設<br>定', '---', '',
  '## 後', '',
].join('\n');

const LIST_NOTE = 'Fixtures/E2E-multiline-setext-list.md';
const PREVIEW_NOTE = 'Fixtures/E2E-multiline-setext-preview.md';
const LIST = [
  '---', 'mappy: true', '---',
  '## 区画', '',
  '- 項目', '  複数', '  行', '  ---',
  '- 次', '',
  '複数', '行の区画', '---', '',
  '- 最後', '',
].join('\n');

const record = createRecord(VAULT, HEADINGS_NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const after = makeAfter(evaluate);

const source = () => evaluate(`${VIEW} return await source();`);
const draft = () => evaluate(`${VIEW} return input()?.value ?? null;`);

/**
 * The headings as the map reads them (its parsed document, list items aside) and as Obsidian's metadataCache lists
 * them, once the cache has read the note's current text (it lags a write by a moment): `[level, text]` each.
 */
const headings = () => evaluate(`${VIEW}
  const text = await source();
  const map = view.document.nodes.filter(node => node.kind !== 'list').map(node => [node.level, node.title]);
  let cache = null;
  for (let tries = 0; tries < 30; tries += 1) {
    const read = app.metadataCache.getFileCache(view.file);
    const listed = (read?.headings ?? []).map(item => [item.level, item.heading]);
    cache = listed;
    if (view.document.source === text && JSON.stringify(listed) === JSON.stringify(map)) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return { map, cache, labels: nodes().map(label), mapCurrent: view.document.source === text };`);

/** The map's headings are the metadataCache's, and its labels are `labels` (in any order). */
async function agrees(name, wanted, labels) {
  const read = await headings();
  check(read.mapCurrent, `${name}: the map has not read the note's current text`);
  check(JSON.stringify(read.map) === JSON.stringify(read.cache),
    `${name}: map ${JSON.stringify(read.map)} but metadataCache ${JSON.stringify(read.cache)}`);
  check(JSON.stringify(read.map) === JSON.stringify(wanted), `${name}: map ${JSON.stringify(read.map)}, expected ${JSON.stringify(wanted)}`);
  const sorted = [...read.labels].sort();
  check(JSON.stringify(sorted) === JSON.stringify([...labels].sort()), `${name}: labels ${JSON.stringify(read.labels)}, expected ${JSON.stringify(labels)}`);
  return read;
}

/**
 * Obsidian's reading view of `text`: its blocks in order as `tag:text` (headings, paragraphs, rules, lists; `⏎` for a
 * break). Read from a copy without the frontmatter: a Markdown leaf on a `mappy: true` note whose map is open is turned
 * into the map by Mappy, so the note itself cannot be shown in preview mode beside it. The copy is deleted afterwards.
 */
const reading = text => evaluate(`
  const path = ${JSON.stringify(PREVIEW_NOTE)};
  ${refuseOpenLeaves([PREVIEW_NOTE])}
  const body = ${JSON.stringify(text)}.replace(/^---\\n[\\s\\S]*?\\n---\\n/u, '');
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing) await app.vault.modify(existing, body); else await app.vault.create(path, body);
  // A split, not a background tab: a tab that is not shown defers its rendering and has no blocks to read.
  const preview = app.workspace.getLeaf('split');
  // Leave neither the leaf nor the copy behind whatever happens: the next run refuses a leaf still on the copy.
  try {
    await preview.setViewState({ type: 'markdown', state: { file: path, mode: 'preview' } });
    let blocks = [];
    for (let tries = 0; tries < 30; tries += 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (preview.view.getViewType() !== 'markdown') throw new Error('the preview leaf is a ' + preview.view.getViewType());
      const root = preview.view.containerEl.querySelector('.markdown-preview-view');
      blocks = Array.from(root?.querySelectorAll('.markdown-preview-sizer > div > :is(h1, h2, h3, h4, h5, h6, p, hr, ul)') ?? [],
        item => item.tagName.toLowerCase() + ':' + item.innerText.trim().replace(/\\n/gu, '⏎'));
      if (blocks.length > 0) break;
    }
    const cache = (app.metadataCache.getCache(path)?.headings ?? []).map(item => [item.level, item.heading]);
    return { blocks, cache };
  } finally {
    preview.detach();
    const copy = app.vault.getAbstractFileByPath(path);
    if (copy) await app.vault.delete(copy);
    if (window.__mappyE2E) app.workspace.setActiveLeaf(window.__mappyE2E, { focus: true });
    await new Promise(resolve => setTimeout(resolve, 500));
  }`);

/** F2 on `title`, type `first`, Shift+Enter (a real key that types), `second`, Enter; what the map shows after. */
async function breakAndConfirm(title, first, second) {
  await select(title);
  await cdp.realKey('F2');
  for (let tries = 0; tries < 30 && await draft() === null; tries += 1) await wait(100);
  await cdp.insertText(first);
  await cdp.realKey('Enter', 8, '\r');
  await wait(300);
  await cdp.insertText(second);
  await wait(200);
  const before = await source();
  await cdp.realKey('Enter');
  return after(before);
}

const clean = () => evaluate(`${VIEW}
  const file = view.file;
  leaf.detach();
  if (file) await app.vault.delete(file, true);
  delete window.__mappyE2E;
  delete window.__mappyE2EBefore;
  return { removed: file?.path ?? null };`);

try {
  await step('plugin', makePluginStep(cdp, evaluate, flag));

  // Headings format: the two multi-line shapes sit under 前, so 後 (H2) is 前's child, not a child of a heading made of them.
  required(record, 'open-headings', await step('open-headings', makeOpenStep(evaluate, { note: HEADINGS_NOTE, source: HEADINGS })));
  await step('headings-unedited', async () => {
    const read = await agrees('headings-unedited', [[1, '前'], [2, '一行'], [2, '設<br>定'], [2, '後']], ['前', '一行', '設 定', '後']);
    // Opening the map is reading it: the note is what was written, byte for byte.
    check(await source() === HEADINGS, 'opening the map changed the note');
    return read;
  });
  await step('headings-reading-view', async () => {
    const { blocks } = await reading(HEADINGS);
    const want = ['h1:前', 'p:本文', 'p:複数⏎行の見出し⏎===', 'p:別の⏎二行', 'hr:', 'h2:一行', 'h2:設⏎定', 'h2:後'];
    check(JSON.stringify(blocks) === JSON.stringify(want), `reading view: ${JSON.stringify(blocks)}, expected ${JSON.stringify(want)}`);
    return { blocks };
  });
  // Editing around the paragraph rewrites only the title edited (LEV-202's `<br>`), and the map still agrees.
  await step('edit-holder', async () => {
    const before = await source();
    const result = await breakAndConfirm('前', '温泉', '旅行');
    check(result.messages.length === 0 && !result.editing, `holder: ${JSON.stringify(result.messages)}`);
    const want = before.replace('# 前\n', '# 温泉<br>旅行\n');
    check(result.source === want, `holder: unexpected source:\nexpected: ${JSON.stringify(want)}\nactual:   ${JSON.stringify(result.source)}`);
    return { ...result, agrees: await agrees('edit-holder', [[1, '温泉<br>旅行'], [2, '一行'], [2, '設<br>定'], [2, '後']], ['温泉 旅行', '一行', '設 定', '後']) };
  });
  await step('edit-one-line-setext', async () => {
    const before = await source();
    const result = await breakAndConfirm('一行', '一', '行');
    check(result.messages.length === 0 && !result.editing, `one-line Setext: ${JSON.stringify(result.messages)}`);
    const want = before.replace('\n一行\n---\n', '\n一<br>行\n---\n');
    check(result.source === want, `one-line Setext: unexpected source:\nexpected: ${JSON.stringify(want)}\nactual:   ${JSON.stringify(result.source)}`);
    return { ...result, agrees: await agrees('edit-one-line-setext', [[1, '温泉<br>旅行'], [2, '一<br>行'], [2, '設<br>定'], [2, '後']], ['温泉 旅行', '一 行', '設 定', '後']) };
  });
  await step('edit-after', async () => {
    const before = await source();
    const result = await breakAndConfirm('後', '次の', '見出し');
    check(result.messages.length === 0 && !result.editing, `after: ${JSON.stringify(result.messages)}`);
    const want = before.replace('## 後\n', '## 次の<br>見出し\n');
    check(result.source === want, `after: unexpected source:\nexpected: ${JSON.stringify(want)}\nactual:   ${JSON.stringify(result.source)}`);
    // The paragraphs were not touched by any of the three edits.
    check(result.source.includes('\n\n複数\n行の見出し\n===\n\n別の\n二行\n---\n\n'), 'the multi-line paragraphs changed');
    return { ...result, agrees: await agrees('edit-after', [[1, '温泉<br>旅行'], [2, '一<br>行'], [2, '設<br>定'], [2, '次の<br>見出し']], ['温泉 旅行', '一 行', '設 定', '次の 見出し']) };
  });
  if (!flag('--keep')) await step('clean-headings', clean);

  // List format: the multi-line `---` between the items is no H2 section; 最後 stays in 区画.
  required(record, 'open-list', await step('open-list', makeOpenStep(evaluate, { note: LIST_NOTE, source: LIST })));
  await step('list-unedited', async () => {
    const read = await agrees('list-unedited', [[2, '区画']], ['区画', '項目', '次', '最後']);
    const items = await evaluate(`${VIEW} return view.document.nodes.filter(node => node.kind === 'list').map(node => [node.title, view.document.nodes.find(parent => parent.id === node.parentId)?.title ?? null]);`);
    check(JSON.stringify(items) === JSON.stringify([['項目', '区画'], ['次', '区画'], ['最後', '区画']]), `list items: ${JSON.stringify(items)}`);
    check(await source() === LIST, 'opening the map changed the note');
    return { ...read, items };
  });
  await step('list-reading-view', async () => {
    const { blocks } = await reading(LIST);
    // Inside the item Obsidian shows a paragraph and a rule too; only the top-level blocks are listed here.
    const want = ['h2:区画', 'p:複数⏎行の区画', 'hr:'];
    const top = blocks.filter(block => !block.startsWith('ul:'));
    check(JSON.stringify(top) === JSON.stringify(want), `reading view: ${JSON.stringify(blocks)}, expected the non-list blocks ${JSON.stringify(want)}`);
    return { blocks };
  });
  await step('edit-list-item', async () => {
    const before = await source();
    const result = await breakAndConfirm('次', '次の', '項目');
    check(result.messages.length === 0 && !result.editing, `list item: ${JSON.stringify(result.messages)}`);
    const want = before.replace('- 次\n', '- 次の<br>項目\n');
    check(result.source === want, `list item: unexpected source:\nexpected: ${JSON.stringify(want)}\nactual:   ${JSON.stringify(result.source)}`);
    return { ...result, agrees: await agrees('edit-list-item', [[2, '区画']], ['区画', '項目', '次の 項目', '最後']) };
  });
  if (!flag('--keep')) await step('clean-list', clean);
} catch (error) {
  if (!(error instanceof StopCase)) throw error;
} finally {
  cdp.close();
}

process.exit(await finish(record, value('--json')));
