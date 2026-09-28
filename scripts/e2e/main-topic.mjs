/**
 * E69 (docs/harness.md, LEV-250): the provisional name of a new node by the depth it lands at, on the real Obsidian, in
 * Japanese and in English. A node added right under a root of the map (Tab on the body root, Enter on a node of the
 * first level) is written as 「メイントピック」／`Main topic`; one further down (Tab on a first-level node, Enter on a
 * deeper one) as 「サブトピック」／`Subtopic`, as before; one that is a root itself (the first section of an empty note, a
 * section after a list with no heading) as 「トピック」／`Topic`, as the empty canvas names one. The person's report was the timeline: the row of stages right of
 * the root read `Subtopic` where MarkMind reads `Main topic`.
 *
 * Rows: the operation (real keys on a real click's selection) × the note (a list under an H2 body root, headings under
 * an H1, a free topic after the body, a list with no heading under the file-name root) × the layout (timeline, the
 * report's, and mindmap) × the language (the test Obsidian's Japanese, then English switched as E63 does, then back). Each row opens the fixture afresh, adds, checks the draft holds the expected name
 * selected, presses Enter on it untouched and compares the whole note with what the row expects.
 *
 * The names are written out here, not read from src/i18n: the case must fail if the table changes them by accident.
 * The context menu's 子／兄弟を追加 is not a row: on macOS Obsidian shows a native menu, outside the page (E63 turns
 * the setting off to read it); it runs the same method as Tab／Enter, and tests/ui/mindmap-view-main-topic.test.ts has
 * its rows.
 *
 * Usage: npm run harness:e2e:main-topic -- [--reload] [--json <out.json>] [--shot <out.png>] [--keep]
 *   --shot  writes <out>.png (Japanese timeline after Enter on a stage) and <out>-en.png (the same in English)
 *   --keep  leave the notes in the vault
 */
import { LANGUAGE, VAULT, connect, wait } from './cdp.mjs';
import { switchLanguage } from './language.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep, makeOpenStep, makeDeleteNote } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const LIST_NOTE = 'Fixtures/E2E-main-topic.md';
const HEADINGS_NOTE = 'Fixtures/E2E-main-topic-headings.md';
const LIST = ['---', 'mappy: true', '---', '## 旅の計画', '', '- 温泉旅行', '  - 予約', '- 持ち物', ''].join('\n');
const HEADINGS = ['---', 'mappy: true', '---', '# 旅の計画', '', '## 温泉旅行', '', '本文', '', '## 持ち物', ''].join('\n');
const TOPIC = `${LIST}\n## 別の話\n\n- 項目\n`;
const NO_HEADING = ['---', 'mappy: true', '---', '- 温泉旅行', '  - 予約', ''].join('\n');
const EMPTY = ['---', 'mappy: true', '---', ''].join('\n');
const ROOT = 'E2E-main-topic';
const NAMES = { ja: { main: 'メイントピック', sub: 'サブトピック', topic: 'トピック' }, en: { main: 'Main topic', sub: 'Subtopic', topic: 'Topic' } };
const LAYOUTS = ['timeline', 'mindmap'];

/** Each row: the note, the node selected, the key, the depth it lands at and the note it leaves (given the names). */
const ROWS = [
  { id: 'list-root-tab', note: LIST_NOTE, source: LIST, target: '旅の計画', key: 'Tab', depth: 'main', written: n => LIST.replace('- 持ち物\n', `- 持ち物\n- ${n}\n`) },
  { id: 'list-first-enter', note: LIST_NOTE, source: LIST, target: '温泉旅行', key: 'Enter', depth: 'main', written: n => LIST.replace('  - 予約\n', `  - 予約\n- ${n}\n`) },
  { id: 'list-first-tab', note: LIST_NOTE, source: LIST, target: '持ち物', key: 'Tab', depth: 'sub', written: n => LIST.replace('- 持ち物\n', `- 持ち物\n  - ${n}\n`) },
  { id: 'list-deep-enter', note: LIST_NOTE, source: LIST, target: '予約', key: 'Enter', depth: 'sub', written: n => LIST.replace('  - 予約\n', `  - 予約\n  - ${n}\n`) },
  { id: 'headings-root-tab', note: HEADINGS_NOTE, source: HEADINGS, target: '旅の計画', key: 'Tab', depth: 'main', written: n => `${HEADINGS}\n## ${n}\n` },
  { id: 'headings-h2-enter', note: HEADINGS_NOTE, source: HEADINGS, target: '温泉旅行', key: 'Enter', depth: 'main', written: n => HEADINGS.replace('本文\n', `本文\n\n## ${n}\n`) },
  { id: 'topic-root-tab', note: LIST_NOTE, source: TOPIC, target: '別の話', key: 'Tab', depth: 'main', written: n => `${TOPIC}- ${n}\n` },
  { id: 'topic-first-tab', note: LIST_NOTE, source: TOPIC, target: '項目', key: 'Tab', depth: 'sub', written: n => `${TOPIC}  - ${n}\n` },
  { id: 'no-heading-first-enter', note: LIST_NOTE, source: NO_HEADING, target: '温泉旅行', key: 'Enter', depth: 'main', written: n => `${NO_HEADING}- ${n}\n` },
  { id: 'no-heading-first-tab', note: LIST_NOTE, source: NO_HEADING, target: '温泉旅行', key: 'Tab', depth: 'sub', written: n => NO_HEADING.replace('  - 予約\n', `  - 予約\n  - ${n}\n`) },
  // A node that is a root itself is named as the empty canvas names one: the first section of an empty note, a section after a list.
  { id: 'empty-root-tab', note: LIST_NOTE, source: EMPTY, target: ROOT, key: 'Tab', depth: 'topic', written: n => `${EMPTY}\n## ${n}\n` },
  { id: 'no-heading-root-tab', note: LIST_NOTE, source: NO_HEADING, target: ROOT, key: 'Tab', depth: 'topic', written: n => `${NO_HEADING}\n## ${n}\n` },
  { id: 'headings-h2-tab', note: HEADINGS_NOTE, source: HEADINGS, target: '温泉旅行', key: 'Tab', depth: 'sub', written: n => HEADINGS.replace('本文\n', `本文\n\n### ${n}\n`) },
];

if (LANGUAGE !== 'ja') throw new Error('E69 starts from the Japanese test Obsidian (MAPPY_E2E_LANGUAGE unset or ja); it switches to English itself.');

const record = createRecord(VAULT, LIST_NOTE);
let cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);

/** The stored `language` key as this run found it, put back at the end. */
const storedAtStart = await cdp.evaluate("localStorage.getItem('language')");
const detachMaps = () => evaluate('app.workspace.getLeavesOfType("mappy-map").forEach(leaf => leaf.detach()); await new Promise(resolve => setTimeout(resolve, 300)); return true;');

/** Every row in every layout, in the app's language now; `shot` is taken after the first timeline row. */
async function rows(language, shot) {
  const names = NAMES[language];
  for (const layout of LAYOUTS) {
    for (const row of ROWS) {
      const name = names[row.depth];
      const label = `${language}/${layout}/${row.id}`;
      const result = await step(label, async () => {
        await detachMaps();
        await makeOpenStep(evaluate, { note: row.note, source: row.source, layout })();
        // A new connection after a language switch: the select helper holds the one it was made with.
        await makeSelect(cdp, evaluate)(row.target);
        await cdp.realKey(row.key, 0, row.key === 'Enter' ? '\r' : undefined);
        await wait(600);
        const draft = await evaluate(`${VIEW} const box = input(); return box ? { value: box.value, selected: box.selectionStart === 0 && box.selectionEnd === box.value.length } : null;`);
        await cdp.realKey('Enter', 0, '\r');
        await wait(800);
        const written = await evaluate(`${VIEW} return { editing: !!input(), source: await source() };`);
        if (shot && layout === 'timeline' && row.id === 'list-first-enter') await cdp.screenshot(shot);
        return { draft, ...written };
      });
      check(result?.draft?.value === name && result.draft.selected, `${label}: the draft is ${JSON.stringify(result?.draft)}, not 「${name}」 selected`);
      check(result?.editing === false, `${label}: Enter on the untouched draft did not close it`);
      check(result?.source === row.written(name), `${label}: the note is ${JSON.stringify(result?.source)}, not ${JSON.stringify(row.written(name))}`);
    }
  }
}

const cleanList = makeDeleteNote(evaluate, LIST_NOTE);
const cleanHeadings = makeDeleteNote(evaluate, HEADINGS_NOTE);
let exitCode = 1;
try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  await rows('ja', value('--shot'));
  required(record, 'to-en', await step('to-en', async () => { cdp = await switchLanguage(cdp, 'en'); return cdp.evaluate('window.moment.locale()'); }));
  const shot = value('--shot');
  await rows('en', shot && `${shot.replace(/\.png$/u, '')}-en.png`);
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`unexpected: ${error}`);
} finally {
  // Whatever happened, the test Obsidian goes back to Japanese with the stored key as it was (as E63 does).
  if (cdp.closed) cdp = await connect({ language: null }).catch(() => cdp);
  if (cdp.closed) record.failures.push('the window could not be reached to put its language back: check it by hand');
  else {
    const now = await cdp.evaluate("[window.moment?.locale?.() ?? null, localStorage.getItem('language')]").catch(() => [null, null]);
    if (now[0] !== 'ja' || now[1] !== storedAtStart) await step('restore', async () => { cdp = await switchLanguage(cdp, storedAtStart, 'ja'); return true; });
  }
  if (!cdp.closed) {
    await detachMaps().catch(() => null);
    if (!flag('--keep')) { await step('clean', cleanList); await step('clean-headings', cleanHeadings); }
  }
  exitCode = await finish(record, value('--json'));
  cdp.close();
}
process.exit(exitCode);
