/**
 * The AI runner case (LEV-270; its row in docs/harness.md comes with the docs catch-up on main): the AI runner in the test Obsidian, starting the real claude, codex and yt-dlp from
 * Electron (docs/architecture.md §11.3). Each run uses the person's own CLI login and so their subscription's usage:
 * the default set is small, and the larger sets run only when asked for.
 *
 * The runner is loaded as a plugin of its own (ai-runner-plugin.mjs, built here into the test vault) because Mappy's
 * `main.ts` does not wire it yet (§11.8); the code it runs is src/ai as it is. After every run the case looks with `ps`
 * for anything left in the run's process groups or naming its temporary directory, and checks the directory is gone.
 *
 * Runs (each a check; a run that fails its check fails the case):
 *   default   claude and codex each answer a small question (an outline); each is cancelled mid-run (cancelled, nothing
 *             left); a Japanese and an English PDF of the vault are read through pdf.js and summarized
 *   --youtube <url>        one summary of a video through yt-dlp (needs --ytdlp or yt-dlp in a known place)
 *   --repeat <n>           the same material n times per engine; counts the shapes that break the contract
 *   --material <youtube|pdf>  what --repeat uses (default pdf; youtube needs --youtube)
 *   --long <url>           a long video (an hour or more) once per engine: time to the first output, longest silence, total
 *   --only <claude|codex>  one engine
 *   --no-default           leave out the default set
 *
 * Usage: npm run harness:e2e:ai-runner -- [--ytdlp <path>] [--youtube <url>] [--repeat 5] [--long <url>] [--json <out.json>]
 * Needs MAPPY_E2E_PORT pointing at the test Obsidian (docs/harness.md 実機検証), macOS, and both CLIs logged in.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { VAULT, connect } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, until } from './case-runner.mjs';

const { flag, value } = parseArgs();
const PLUGIN = 'mappy-ai-probe';
const PDF_JA = 'lev-270/ja.pdf';
const PDF_EN = 'lev-270/bash-article.pdf';
const engines = value('--only') ? [value('--only')] : ['claude', 'codex'];

const record = createRecord(VAULT, null);
const step = makeStep(record);
const check = makeCheck(record);

const base = { template: 'summary', instruction: '', depth: 2, webSearch: false, context: { ancestors: ['AI runner'], title: '要約', body: '' }, materials: [] };

async function install() {
  const dir = join(VAULT, '.obsidian', 'plugins', PLUGIN);
  await mkdir(dir, { recursive: true });
  await build({
    entryPoints: [new URL('./ai-runner-plugin.mjs', import.meta.url).pathname], outfile: join(dir, 'main.js'),
    bundle: true, platform: 'browser', format: 'cjs', target: 'es2021', external: ['obsidian'], logLevel: 'warning',
  });
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify({
    id: PLUGIN, name: 'Mappy AI runner probe (LEV-270)', version: '0.0.0', minAppVersion: '1.8.7', description: 'Test only', author: 'Mappy', isDesktopOnly: true,
  })}\n`);
}

/** A short Japanese document over two pages: pdf.js gives its CJK characters in compatibility forms (artifacts/lev-270). */
const JAPANESE_HTML = '<html><head><meta charset="utf-8"></head><body><h1>日本語の PDF のテスト</h1>'
  + '<p>これは pdf.js のテキスト抽出を確かめるための日本語の文書です。マインドマップは考えを枝分かれで整理する方法です。</p>'
  + '<p style="page-break-before:always">二ページ目: 中心のテーマから枝を伸ばし、関連する考えを近くに置きます。</p></body></html>';

/**
 * The two PDFs, made when missing: the Japanese one printed by Electron in the test Obsidian (a hidden window, so
 * nothing outside the app is needed), the English one copied from the bash article macOS ships (11 pages).
 */
async function ensurePdfs() {
  const made = [];
  if (!existsSync(join(VAULT, PDF_JA))) {
    await connection.evaluate(`(async () => {
      const { BrowserWindow } = require('electron').remote;
      const window = new BrowserWindow({ show: false });
      try {
        await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(${JSON.stringify(JAPANESE_HTML)}));
        const pdf = await window.webContents.printToPDF({});
        if (!app.vault.getAbstractFileByPath('lev-270')) await app.vault.createFolder('lev-270');
        await app.vault.createBinary(${JSON.stringify(PDF_JA)}, pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength));
      } finally { window.destroy(); }
    })()`);
    made.push(PDF_JA);
  }
  if (!existsSync(join(VAULT, PDF_EN))) {
    await mkdir(join(VAULT, 'lev-270'), { recursive: true });
    await writeFile(join(VAULT, PDF_EN), await readFile('/usr/share/doc/bash/article.pdf'));
    made.push(PDF_EN);
  }
  return { made };
}

/** What `ps` still shows of a run: its process groups, or anything naming its temporary directories. */
function leftovers(processes) {
  const groups = new Set(processes.map(process => process.pid));
  const dirs = processes.map(process => process.cwd);
  return execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf8' }).split('\n').filter(Boolean)
    .map(line => line.trim().split(/\s+/u))
    .filter(([, pgid, ...command]) => groups.has(Number(pgid)) || dirs.some(dir => command.join(' ').includes(dir)))
    .map(fields => fields.join(' ').slice(0, 200));
}

function shape(result) {
  if (result?.kind !== 'outline') return { kind: result?.kind ?? 'none', reason: result?.reason ?? null };
  const depth = items => items.reduce((max, item) => Math.max(max, 1 + depth(item.children)), 0);
  const long = items => items.reduce((count, item) => count + (item.text.length > 60 ? 1 : 0) + long(item.children), 0);
  const top = result.items.length;
  return { kind: 'outline', top, depth: depth(result.items), dropped: result.dropped, longItems: long(result.items), broken: result.dropped > 0 || top < 3 || top > 7 };
}

let connection;
let serial = 0;
/** `cancelAfterStartMs`: cancel that long after the runner reported `starting` (the CLI is being started), not before. */
async function run(name, request, { cancelAfterStartMs = 0, timeoutMs = 16 * 60_000 } = {}) {
  const id = `${name}-${++serial}`;
  await connection.evaluate(`__mappyAiProbe.start(${JSON.stringify(id)}, ${JSON.stringify(request)}, ${cancelAfterStartMs})`);
  const outcome = await until(async () => {
    const state = await connection.evaluate(`__mappyAiProbe.results[${JSON.stringify(id)}]`);
    return state && !state.running ? state : null;
  }, timeoutMs, `${name} did not finish`);
  if (outcome.error) throw new Error(outcome.error);
  await new Promise(resolve => { setTimeout(resolve, 1500); });
  const left = leftovers(outcome.processes);
  const kept = outcome.processes.map(process => process.cwd).filter(dir => existsSync(dir));
  check(left.length === 0, `${name}: processes left after the run: ${left.join(' | ')}`);
  check(kept.length === 0, `${name}: temporary directories left: ${kept.join(', ')}`);
  const { result } = outcome;
  return {
    ms: outcome.ms, shape: shape(result), started: outcome.processes.map(process => process.file.split('/').pop()), stages: [...new Set(outcome.progress.map(step => step.stage))], gaps: outcome.gaps, left, kept,
    text: result.kind === 'outline' ? result.raw : result.kind === 'failed' ? `${result.reason}: ${result.detail}`.slice(0, 600) : result.reason ?? null,
  };
}

const youtube = value('--youtube');
const long = value('--long');
const repeat = Number(value('--repeat') ?? 0);
const materialFor = kind => kind === 'youtube'
  ? [{ kind: 'youtube', label: youtube, text: '' }]
  : [{ kind: 'pdf', label: PDF_JA, text: '' }];

try {
  await step('install the probe plugin', async () => {
    await install();
    connection = await connect();
    const ytdlp = value('--ytdlp') ?? '';
    return connection.evaluate(`(async () => {
      localStorage.setItem('mappy-ai-paths', JSON.stringify({ claude: '', codex: '', 'yt-dlp': ${JSON.stringify(ytdlp)} }));
      await app.plugins.setEnable(true);
      await app.plugins.loadManifests();
      if (app.plugins.enabledPlugins.has(${JSON.stringify(PLUGIN)})) await app.plugins.disablePlugin(${JSON.stringify(PLUGIN)});
      await app.plugins.enablePlugin(${JSON.stringify(PLUGIN)});
      return { availability: globalThis.__mappyAiProbe?.availability() ?? null, platform: navigator.platform };
    })()`);
  });
  check(record.steps['install the probe plugin']?.availability === 'available', 'the runner is not available in the test Obsidian');
  await step('the PDFs in the vault', () => ensurePdfs());

  // The default set; --no-default leaves it out (to spend the runs on --repeat or --long only).
  if (!flag('--no-default')) for (const engine of engines) {
    const small = await step(`${engine}: a small question`, () => run(`${engine}-small`, {
      ...base, engine, template: 'brainstorm', instruction: 'マインドマップを使うと何がよいか、観点を挙げて', context: { ancestors: ['AI runner'], title: 'マインドマップ', body: '' },
    }));
    check(small?.shape?.kind === 'outline', `${engine}: the small question did not give an outline (${small?.text})`);
    const cancel = await step(`${engine}: cancelled mid-run`, () => run(`${engine}-cancel`, { ...base, engine, materials: [{ kind: 'pdf', label: PDF_EN, text: '' }] }, { cancelAfterStartMs: 2_000 }));
    check(cancel?.shape?.kind === 'cancelled', `${engine}: the cancelled run reported ${cancel?.shape?.kind}`);
    // The point is stopping a running CLI and its group: a cancel that came before the spawn would pass trivially.
    check((cancel?.started?.length ?? 0) > 0, `${engine}: the cancelled run started no process`);
  }
  if (!flag('--no-default')) for (const [engine, pdf] of [[engines[0], PDF_JA], [engines[engines.length - 1], PDF_EN]]) {
    const read = await step(`${engine}: summary of ${pdf}`, () => run(`${engine}-pdf`, { ...base, engine, materials: [{ kind: 'pdf', label: pdf, text: '' }] }));
    check(read?.shape?.kind === 'outline', `${engine}: ${pdf} did not give an outline (${read?.text})`);
  }
  if (youtube && !flag('--no-default')) {
    const video = await step(`${engines[0]}: summary of ${youtube}`, () => run(`${engines[0]}-youtube`, { ...base, engine: engines[0], materials: materialFor('youtube') }));
    check(video?.shape?.kind === 'outline', `the video did not give an outline (${video?.text})`);
    check(video?.stages?.includes('material'), 'the video run did not report the material stage');
  }
  if (repeat > 0) {
    const kind = value('--material') ?? 'pdf';
    if (kind === 'youtube' && !youtube) throw new Error('--material youtube needs --youtube <url>');
    for (const engine of engines) {
      const shapes = [];
      for (let i = 0; i < repeat; i++) {
        const one = await step(`${engine}: stability ${i + 1}/${repeat} (${kind})`, () => run(`${engine}-repeat`, { ...base, engine, materials: materialFor(kind) }));
        shapes.push(one?.shape ?? { kind: 'error' });
        // A shape that bends the contract is counted below; a run that gave no outline at all fails the case.
        check(one?.shape?.kind === 'outline', `${engine}: stability ${i + 1} did not give an outline (${one?.text ?? one?.error})`);
      }
      record.steps[`${engine}: stability summary`] = {
        runs: shapes.length, broken: shapes.filter(item => item.kind !== 'outline' || item.broken).length,
        dropped: shapes.reduce((sum, item) => sum + (item.dropped ?? 0), 0), shapes,
      };
      console.log(`${engine}: stability summary`, JSON.stringify(record.steps[`${engine}: stability summary`]));
    }
  }
  if (long) {
    for (const engine of engines) {
      const read = await step(`${engine}: long video`, () => run(`${engine}-long`, { ...base, engine, materials: [{ kind: 'youtube', label: long, text: '' }] }));
      check(read?.shape?.kind === 'outline', `${engine}: the long video did not give an outline (${read?.text ?? read?.error})`);
    }
  }
} catch (error) {
  record.failures.push(String(error));
} finally {
  if (connection && !flag('--keep')) {
    await connection.evaluate(`app.plugins.disablePlugin(${JSON.stringify(PLUGIN)})`).catch(() => undefined);
  }
}
process.exit(await finish(record, value('--json')));
