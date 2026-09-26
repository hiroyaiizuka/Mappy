/**
 * E42 (docs/harness.md): on the timeline, the next stage's stem on a side stands clear of the previous forest
 * on that side (LEV-205). The note is tests/fixtures/timeline-stages.md: Section2's forest hangs below the axis
 * and ends in 「ビジランス効果」「ポモドーロ」, and Section4, the next stage below, raises its stem beside it.
 *
 * - The distance from the forest's right edge (its nodes and their fold controls) to Section4's stem, in layout
 *   px (screen px over the map's zoom), is `TIMELINE_STAGE_CLEARANCE` in `src/layout/layout.ts`.
 * - Opening the note as a timeline does not write it.
 *
 * Usage: npm run harness:e2e:timeline-stage-gap -- [--reload] [--json <out.json>] [--shot <out.png>] [--keep] [--clearance <px>]
 *   --clearance  the distance the installed build is expected to keep (default: TIMELINE_STAGE_CLEARANCE as this
 *                checkout's src/layout/layout.ts has it, the value `harness:prepare` builds), for a build made with another
 *                value to compare screenshots
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makePluginStep, makeOpenStep } from './dom-helpers.mjs';

const { flag, value } = parseArgs();

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The value this checkout builds; the unit tests pin it to the range the ticket asked for (LEV-205). */
// The installed plugin must be this checkout's build (`npm run harness:prepare`); the case cannot tell a stale one apart.
const shipped = (await readFile(resolve(root, 'src', 'layout', 'layout.ts'), 'utf8'))
  .match(/export const TIMELINE_STAGE_CLEARANCE\s*=\s*([\d_.]+)/u)?.[1]?.replaceAll('_', '');
const given = value('--clearance');
if (given === undefined && !shipped) throw new Error('TIMELINE_STAGE_CLEARANCE is not in src/layout/layout.ts; pass --clearance <px>');
const CLEARANCE = Number(given ?? shipped);
if (!Number.isFinite(CLEARANCE) || CLEARANCE <= 0) throw new Error(`--clearance needs a positive number of px, not ${JSON.stringify(given ?? shipped)}`);
const NOTE = 'Fixtures/E2E-timeline-stage-gap.md';
const SOURCE = await readFile(resolve(root, 'tests', 'fixtures', 'timeline-stages.md'), 'utf8');
const FOREST = ['集中が続く時間', '注意は時間とともに落ちる', 'ビジランス効果', '区切って休む', 'ポモドーロ', '環境'];
const STAGE = 'Section4: 記録する';

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);

/**
 * Closes every leaf on the note and deletes it (unless --keep). Runs even when the open step failed part way:
 * a note written or a leaf left open there would make the next run refuse to start (`refuseOpenLeaves`).
 */
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

  await step('gap', async () => {
    // Fit and the image's load re-lay the map out: measure until the image has loaded and two readings
    // 400 ms apart agree, so the gap is read off the settled map rather than a frame of the way there.
    const read = () => evaluate(`${VIEW}
      if (!el.querySelector('.mappy-node.is-timeline')) throw new Error('the map is not drawn as a timeline');
      const find = title => { const node = nth(title, 0); if (!node) throw new Error('No node ' + title); return node; };
      const stage = find(${JSON.stringify(STAGE)});
      const scale = stage.getBoundingClientRect().width / stage.offsetWidth;
      const right = Math.max(...${JSON.stringify(FOREST)}.flatMap(title => {
        const node = find(title);
        const toggle = node.querySelector(':scope > .mappy-node-toggle');
        return [node.getBoundingClientRect().right, toggle && !toggle.hidden ? toggle.getBoundingClientRect().right : -Infinity];
      }));
      const rect = stage.getBoundingClientRect();
      const images = Array.from(el.querySelectorAll('.mappy-node img'));
      return { scale, gap: (rect.left + rect.width / 2 - right) / scale, loaded: images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0) };`);
    let measured = await read();
    let settled = false;
    for (let attempt = 0; attempt < 25 && !settled; attempt += 1) {
      await wait(400);
      const next = await read();
      settled = next.loaded && measured.loaded && Math.abs(next.gap - measured.gap) < 0.1 && Math.abs(next.scale - measured.scale) < 1e-4;
      measured = next;
    }
    check(settled, `the map did not settle within 10 s (image loaded: ${measured.loaded})`);
    // Node rects are integers scaled by the zoom: a pixel of rounding is allowed.
    check(Math.abs(measured.gap - CLEARANCE) <= 1.5, `Section4's stem stands ${measured.gap.toFixed(1)} px from Section2's forest, not ${CLEARANCE}`);
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
