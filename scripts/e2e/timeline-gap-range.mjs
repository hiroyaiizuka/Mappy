/**
 * E61 (docs/harness.md): on the timeline, the next stage's stem on a side stands the stage clearance past the part
 * of the previous forest on that side within the height the next stage reaches, and only the envelope clearance
 * past the parts beyond it (LEV-210). The note is tests/fixtures/timeline-gap-range.md: above the axis, 段階1's
 * forest ends in the deep branch 「文献を集める」 two rows further out than 段階3's single child; below it,
 * 段階2's branch 「機材」 ends in a long sentence two rows further out than 段階4's single child.
 *
 * For each side, in layout px (screen px over the map's zoom), from the next stage's stem:
 * - the near branch (the row the next stage's child is beside) is at least `TIMELINE_STAGE_CLEARANCE` away;
 * - the far branch is at least `TIMELINE_ENVELOPE_CLEARANCE` away and nearer than `TIMELINE_STAGE_CLEARANCE`
 *   (the envelope rule of LEV-205 kept it exactly `TIMELINE_STAGE_CLEARANCE` away);
 * - one of the two is at its minimum: the stem stands no further right than they require.
 * Opening the note as a timeline does not write it.
 *
 * Usage: npm run harness:e2e:timeline-gap-range -- [--reload] [--json <out.json>] [--shot <out.png>] [--keep]
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required, layoutConstant } from './case-runner.mjs';
import { VIEW, makePluginStep, makeOpenStep } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The installed plugin must be this checkout's build (`npm run harness:prepare`); the case cannot tell a stale one apart.
// The values follow the source: the unit tests pin them, and the far-branch check (nearer than the stage clearance)
// is what fails on the envelope rule whatever the values are.
const STAGE_CLEARANCE = await layoutConstant('TIMELINE_STAGE_CLEARANCE');
const ENVELOPE_CLEARANCE = await layoutConstant('TIMELINE_ENVELOPE_CLEARANCE');
const NOTE = 'Fixtures/E2E-timeline-gap-range.md';
const SOURCE = await readFile(resolve(root, 'tests', 'fixtures', 'timeline-gap-range.md'), 'utf8');
const SIDES = [
  { side: 'upper', stage: '段階3: 書く', near: ['問いを決める'], far: ['文献を集める', '年代順に読む', '未解決の問い'] },
  { side: 'lower', stage: '段階4: 出す', near: ['予算を見積もる'], far: ['機材', '計算機を選ぶ', '解析用の計算機と保存用のディスクを選び、三社から見積もりを取る'] },
];
/** Node rects are integers scaled by the zoom: a pixel of rounding is allowed. */
const TOLERANCE = 1.5;

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);

/** Closes every leaf on the note and deletes it (unless --keep), even when the open step failed part way. */
const clean = () => step('clean', () => evaluate(`
  const path = ${JSON.stringify(NOTE)};
  app.workspace.iterateAllLeaves(item => {
    const state = item.getViewState();
    if (item.view?.file?.path === path || state.state?.file === path) item.detach();
  });
  const file = app.vault.getAbstractFileByPath(path);
  const remove = ${JSON.stringify(!flag('--keep'))};
  if (file && remove) await app.vault.delete(file, true);
  delete window.__mappyE2E;
  delete window.__mappyE2EBefore;
  return { removed: file && remove ? path : null };`));

try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  required(record, 'open', await step('open', makeOpenStep(evaluate, { note: NOTE, source: SOURCE, layout: 'timeline' })));

  await step('gaps', async () => {
    // Fit re-lays the map out: measure until two readings 400 ms apart agree.
    const read = () => evaluate(`${VIEW}
      if (!el.querySelector('.mappy-node.is-timeline')) throw new Error('the map is not drawn as a timeline');
      const find = title => { const node = nth(title, 0); if (!node) throw new Error('No node ' + title); return node; };
      const right = titles => Math.max(...titles.flatMap(title => {
        const node = find(title);
        const toggle = node.querySelector(':scope > .mappy-node-toggle');
        return [node.getBoundingClientRect().right, toggle && !toggle.hidden ? toggle.getBoundingClientRect().right : -Infinity];
      }));
      const sides = ${JSON.stringify(SIDES)};
      const first = find(sides[0].stage);
      const scale = first.getBoundingClientRect().width / first.offsetWidth;
      return { scale, sides: sides.map(entry => {
        const rect = find(entry.stage).getBoundingClientRect();
        const stem = rect.left + rect.width / 2;
        return { side: entry.side, near: (stem - right(entry.near)) / scale, far: (stem - right(entry.far)) / scale };
      }) };`);
    let measured = await read();
    let settled = false;
    for (let attempt = 0; attempt < 25 && !settled; attempt += 1) {
      await wait(400);
      const next = await read();
      settled = Math.abs(next.scale - measured.scale) < 1e-4
        && next.sides.every((entry, index) => Math.abs(entry.near - measured.sides[index].near) < 0.1 && Math.abs(entry.far - measured.sides[index].far) < 0.1);
      measured = next;
    }
    check(settled, 'the map did not settle within 10 s');
    for (const { side, near, far } of measured.sides) {
      check(near >= STAGE_CLEARANCE - TOLERANCE, `${side}: the near branch is ${near.toFixed(1)} px from the next stem, under ${STAGE_CLEARANCE}`);
      check(far >= ENVELOPE_CLEARANCE - TOLERANCE, `${side}: the far branch is ${far.toFixed(1)} px from the next stem, under ${ENVELOPE_CLEARANCE}`);
      check(far < STAGE_CLEARANCE - TOLERANCE, `${side}: the far branch is ${far.toFixed(1)} px from the next stem: the clearance is still taken from the whole forest`);
      const slack = Math.min(near - STAGE_CLEARANCE, far - ENVELOPE_CLEARANCE);
      check(Math.abs(slack) <= TOLERANCE, `${side}: the stem stands ${slack.toFixed(1)} px further right than the forest requires`);
    }
    const shot = value('--shot');
    if (shot) measured.shot = await cdp.screenshot(shot);
    return measured;
  });

  await step('unchanged', async () => {
    const source = await evaluate(`${VIEW} return source();`);
    check(source === SOURCE, 'opening the note as a timeline changed it');
    return { same: source === SOURCE };
  });
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(String(error));
} finally {
  await clean();
  cdp.close();
}

process.exit(await finish(record, value('--json')));
