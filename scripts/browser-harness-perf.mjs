/**
 * Measure the map view's load and edit stages on the generated 10/100/500/2,000
 * node fixtures in headless Chrome, and record p50/p95 with the machine that
 * produced them (product-plan §6, LEV-13).
 *
 *   node scripts/browser-harness-perf.mjs [--chrome <path>] [--out artifacts/performance]
 *       [--repeat 10] [--keystrokes 30] [--frames 60] [--shapes headings,list,...]
 *       [--counts 10,100,500,2000] [--fixtures performance-500,...]
 *
 * Per fixture: one warm-up load, `repeat` loads in a fresh view, `repeat`
 * Markdown-side edits, `repeat` inline edits (`keystrokes` keystrokes in total,
 * each followed by Enter), and three pan and zoom runs of `frames` frames. The
 * stages come from harness/browser/measure.ts; this script only drives the page,
 * summarises and writes samples.json, summary.json and record.md. Without Chrome
 * it writes a record marking the run as not executed and exits with 2.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildBrowserHarness } from './browser-harness.mjs';
import { chromeVersion, findChrome, withHarnessPage } from './browser-harness-cdp.mjs';
import { performanceFixtureMatrix, performanceShapes } from './performance-fixtures.mjs';
import { summarize } from './perf-stats.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WINDOW = { width: 1640, height: 1000 };
const PANE = { width: 1280, height: 800 };
const FRAME_RUNS = 2;
/** One frame at 60 fps; intervals above it mean a frame was missed. */
const FRAME_BUDGET_MS = 1000 / 60 + 0.5;

const LOAD_FIELDS = [
  ['parseMs', 'parse'], ['stateMs', 'setState'], ['measureMs', '計測'], ['layoutMs', 'layoutTree'],
  ['frameMs', '配置フレーム'], ['paintMs', '次フレーム開始'], ['firstLayoutMs', '初回配置'], ['settledMs', '安定'],
];
const EDIT_FIELDS = {
  'markdown-edit': [['debounceMs', 'debounce'], ['parseMs', 'parse'], ['refreshMs', '再読込〜DOM'], ['waitMs', 'フレーム待ち'],
    ['frameMs', '配置フレーム'], ['paintMs', '次フレーム開始'], ['totalMs', '合計']],
  'inline-key': [['refreshMs', '入力ハンドラ'], ['waitMs', 'フレーム待ち'], ['frameMs', '配置フレーム'], ['paintMs', '次フレーム開始'], ['totalMs', '合計']],
  'inline-commit': [['parseMs', 'parse'], ['refreshMs', '適用〜DOM'], ['waitMs', 'フレーム待ち'], ['frameMs', '配置フレーム'],
    ['paintMs', '次フレーム開始'], ['totalMs', '合計']],
};

function parseArgs(argv) {
  const args = argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const list = name => option(name)?.split(',').map(item => item.trim()).filter(Boolean);
  const integer = (name, fallback) => {
    const value = option(name);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} needs a positive integer, got ${value}`);
    return parsed;
  };
  return {
    chrome: option('--chrome'),
    out: option('--out') ?? join('artifacts', 'performance'),
    repeat: integer('--repeat', 10),
    keystrokes: integer('--keystrokes', 30),
    frames: integer('--frames', 60),
    shapes: list('--shapes'),
    counts: list('--counts')?.map(Number),
    fixtures: list('--fixtures'),
  };
}

export function selectFixtures(options) {
  const known = new Set(performanceShapes.map(shape => shape.id));
  for (const shape of options.shapes ?? []) if (!known.has(shape)) throw new Error(`Unknown shape: ${shape}`);
  return performanceFixtureMatrix().filter(entry => (!options.shapes || options.shapes.includes(entry.shape.id))
    && (!options.counts || options.counts.includes(entry.nodeCount))
    && (!options.fixtures || options.fixtures.includes(entry.id)));
}

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function osVersion() {
  if (process.platform !== 'darwin') return `${os.type()} ${os.release()}`;
  try {
    const product = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
    const build = execFileSync('sw_vers', ['-buildVersion'], { encoding: 'utf8' }).trim();
    return `macOS ${product} (${build})`;
  } catch {
    return `${os.type()} ${os.release()}`;
  }
}

function environment(chrome, options) {
  const cpu = os.cpus()[0]?.model ?? 'unknown';
  return {
    at: new Date().toISOString(),
    os: osVersion(),
    arch: process.arch,
    cpu,
    cores: os.cpus().length,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    /** 1/5/15 minute load averages at the start: other work on the machine adds noise. */
    loadavg: os.loadavg().map(value => Number(value.toFixed(2))),
    node: process.version,
    chrome: chrome ? chromeVersion(chrome) : 'なし',
    chromePath: chrome ?? null,
    chromeFlags: '--headless=new --disable-gpu --force-device-scale-factor=1 --hide-scrollbars',
    window: WINDOW,
    pane: PANE,
    commit: git('rev-parse', '--short', 'HEAD'),
    dirty: git('status', '--porcelain') !== '',
    options: { repeat: options.repeat, keystrokes: options.keystrokes, frames: options.frames },
  };
}

const ms = value => (Number.isFinite(value) ? value.toFixed(1) : '—');
const range = summary => `${ms(summary.p50)} / ${ms(summary.p95)}`;

/** p50/p95 per field for the samples of one fixture and kind. */
function summarizeFields(samples, fields) {
  return Object.fromEntries(fields.map(([field]) => [field, summarize(samples.map(sample => sample[field]))]));
}

function summarizeFrames(samples) {
  const intervals = samples.flatMap(sample => sample.intervals);
  return { ...summarize(intervals), over: intervals.filter(value => value > FRAME_BUDGET_MS).length };
}

export function buildSummary(fixtures, samples) {
  const byFixture = id => samples.filter(sample => sample.fixture === id);
  return fixtures.map(entry => {
    const own = byFixture(entry.id);
    const kind = name => own.filter(sample => sample.kind === name);
    return {
      fixture: entry.id, nodes: entry.nodeCount, shape: entry.shape.id,
      load: summarizeFields(kind('load'), LOAD_FIELDS),
      'markdown-edit': summarizeFields(kind('markdown-edit'), EDIT_FIELDS['markdown-edit']),
      'inline-key': summarizeFields(kind('inline-key'), EDIT_FIELDS['inline-key']),
      'inline-commit': summarizeFields(kind('inline-commit'), EDIT_FIELDS['inline-commit']),
      pan: summarizeFrames(kind('pan')),
      zoom: summarizeFrames(kind('zoom')),
    };
  });
}

function table(header, rows) {
  return [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.join(' | ')} |`)];
}

export function recordMarkdown({ env, fixtures, summary, notExecuted, failures }) {
  const shapeLabel = id => performanceShapes.find(shape => shape.id === id)?.label ?? id;
  const lines = [
    '# 性能計測（ブラウザ検証ページ②、headless Chrome）',
    '',
    `- 日時: ${env.at}`,
    `- 基準端末: ${env.cpu}（${env.cores} コア、${env.memoryGb} GB）、${env.os}、${env.arch}。開始時の load average ${env.loadavg.join(' / ')}（1／5／15 分。他の作業が同時に動いていればノイズになる）`,
    `- Node: ${env.node}、Chrome: ${env.chrome}（${env.chromePath}）`,
    `- Chrome フラグ: ${env.chromeFlags}、ウィンドウ ${env.window.width}×${env.window.height}、ペイン ${env.pane.width}×${env.pane.height}、devicePixelRatio 1`,
    `- build: ${env.commit}${env.dirty ? '（未コミットの変更あり）' : ''}（\`npm run harness:browser:build\` の \`dist/harness\`。製品の src/ と core / layout / ui をそのまま読み込む）`,
    `- 繰り返し: 読み込み ${env.options.repeat} 回（ウォームアップ 1 回を除く）、Markdown 側の編集 ${env.options.repeat} 回、インライン編集 ${env.options.repeat} 回（キー入力 計 ${env.options.keystrokes} 回）、パン／ズーム各 ${FRAME_RUNS} 回 × ${env.options.frames} フレーム`,
    '- 統計: nearest-rank の p50 / p95（ms）。値は「p50 / p95」。',
    '- テーマ: harness.css の仮の CSS 変数（Obsidian のテーマではない）。画像: `sample-image.svg` の data URL（転送なし。画像の読み込み後の再配置は「安定」に含まれ、転送時間は含まれない）。',
    '',
    '## 段階の定義',
    '',
    '- 読み込み（fixture を新しい view で開く）: `parse` = parseMarkdown 単体、`setState` = 読み込み・view の parse・ノード DOM 生成、`計測` = setState 直後にノードの offsetWidth を読んだときのブラウザの style／layout（view は配置フレームの sizes() で同じ計算を払う。段階を分けるために先に読む）、`layoutTree` = 配置アルゴリズム単体（計測済みサイズで）、`配置フレーム` = view の requestAnimationFrame コールバック（sizes・layoutTree・place・線・Fit）、`次フレーム開始` = そのコールバック終了から次のフレーム開始まで（vsync 待ちと style／layout／paint。約 17 ms 以下なら 1 フレーム内に収まった）、`初回配置` = setState 開始〜配置フレーム終了、`安定` = ノード位置が 3 フレーム変わらないまで（3 フレーム分の待ちを含む）。',
    '- Markdown 側の編集（vault の modify → view）: `debounce` = 変更〜45 ms の debounce 発火、`再読込〜DOM` = 発火〜編集ノードの DOM 更新（read・parse・ノード DOM）、`フレーム待ち` = DOM 更新〜配置フレーム開始（ブラウザがフレーム前に行う style／layout を含むことがある）、`配置フレーム`、`次フレーム開始`、`合計` = 変更〜配置後の次フレーム開始（画面に出せる最初のフレーム）。Obsidian のエディタ入力は editor-change → 同じ経路。',
    '- インライン編集（マップ側、実 DOM 経由）: `キー入力` = textarea への 1 文字入力〜配置後の次フレーム開始（`入力ハンドラ` は textarea の高さ再計算）、`確定` = Enter〜改名の適用・再読込・再描画・配置後の次フレーム開始（`適用〜DOM` は apply・read・parse・ノード DOM）。',
    '- パン／ズーム: 1 フレームに 1 回 wheel（パンは deltaY 12、ズームは Ctrl＋deltaY 20）を送り、requestAnimationFrame のタイムスタンプ間隔を記録。ハンドラは transform の更新だけなので、間隔はブラウザの描画コスト。headless（--disable-gpu）の main thread の値であり、実機の GPU 合成・ラスタは含まない。',
    '',
    '## 読み込み（ms、p50 / p95）',
    '',
    ...table(['fixture', '形', 'ノード', 'n', ...LOAD_FIELDS.map(([, label]) => label)],
      summary.map(row => [row.fixture, shapeLabel(row.shape), row.nodes, row.load.parseMs.n, ...LOAD_FIELDS.map(([field]) => range(row.load[field]))])),
    '',
    '## Markdown 側の編集 → 画面反映（ms、p50 / p95）',
    '',
    ...table(['fixture', 'ノード', 'n', ...EDIT_FIELDS['markdown-edit'].map(([, label]) => label)],
      summary.map(row => [row.fixture, row.nodes, row['markdown-edit'].totalMs.n,
        ...EDIT_FIELDS['markdown-edit'].map(([field]) => range(row['markdown-edit'][field]))])),
    '',
    '## インライン編集: キー入力 → 画面反映（ms、p50 / p95）',
    '',
    ...table(['fixture', 'ノード', 'n', ...EDIT_FIELDS['inline-key'].map(([, label]) => label)],
      summary.map(row => [row.fixture, row.nodes, row['inline-key'].totalMs.n,
        ...EDIT_FIELDS['inline-key'].map(([field]) => range(row['inline-key'][field]))])),
    '',
    '## インライン編集: Enter で確定 → 画面反映（ms、p50 / p95）',
    '',
    ...table(['fixture', 'ノード', 'n', ...EDIT_FIELDS['inline-commit'].map(([, label]) => label)],
      summary.map(row => [row.fixture, row.nodes, row['inline-commit'].totalMs.n,
        ...EDIT_FIELDS['inline-commit'].map(([field]) => range(row['inline-commit'][field]))])),
    '',
    '## パン／ズーム中のフレーム間隔（ms）',
    '',
    ...table(['fixture', 'ノード', 'パン p50 / p95', 'パン 最大', `パン ${FRAME_BUDGET_MS.toFixed(1)} ms 超`, 'ズーム p50 / p95', 'ズーム 最大', `ズーム ${FRAME_BUDGET_MS.toFixed(1)} ms 超`],
      summary.map(row => [row.fixture, row.nodes, range(row.pan), ms(row.pan.max), `${row.pan.over} / ${row.pan.n}`,
        range(row.zoom), ms(row.zoom.max), `${row.zoom.over} / ${row.zoom.n}`])),
    '',
    '## 失敗',
    '',
    ...(failures.length ? failures.map(failure => `- ${failure}`) : ['- なし']),
    '',
    '## 未実施',
    '',
    ...notExecuted.map(item => `- ${item}`),
    '',
    `対象 fixture: ${fixtures.map(entry => entry.id).join(', ')}`,
    '',
  ];
  return lines.join('\n');
}

async function runFixture(page, entry, options, samples, failures) {
  const record = sample => { samples.push(sample); };
  const attempt = async (label, body) => {
    try {
      await body();
    } catch (error) {
      const message = `${entry.id} ${label}: ${error instanceof Error ? error.message : String(error)}`;
      failures.push(message);
      console.error(`FAIL ${message}`);
      // Leave the fixture in a known state for the next step.
      await page.harness(`h.measure.load(${JSON.stringify(entry.id)})`).catch(() => undefined);
    }
  };
  const started = Date.now();
  await attempt('warm-up', () => page.harness(`h.measure.load(${JSON.stringify(entry.id)})`));
  for (let index = 0; index < options.repeat; index += 1) {
    await attempt(`load ${index + 1}`, async () => { record(await page.harness(`h.measure.load(${JSON.stringify(entry.id)})`)); });
  }
  for (let index = 0; index < options.repeat; index += 1) {
    await attempt(`markdown-edit ${index + 1}`, async () => { record(await page.harness('h.measure.markdownEdit()')); });
  }
  const perCall = Math.max(1, Math.ceil(options.keystrokes / options.repeat));
  for (let index = 0; index < options.repeat; index += 1) {
    await attempt(`inline-edit ${index + 1}`, async () => {
      for (const sample of await page.harness(`h.measure.inlineEdit(${perCall})`)) record(sample);
    });
  }
  for (const kind of ['pan', 'zoom']) {
    for (let index = 0; index < FRAME_RUNS; index += 1) {
      await attempt(`${kind} ${index + 1}`, async () => { record(await page.harness(`h.measure.frames(${JSON.stringify(kind)}, ${options.frames})`)); });
    }
  }
  const own = samples.filter(sample => sample.fixture === entry.id);
  const load = summarize(own.filter(sample => sample.kind === 'load').map(sample => sample.firstLayoutMs));
  const edit = summarize(own.filter(sample => sample.kind === 'markdown-edit').map(sample => sample.totalMs));
  console.info(`${entry.id}: 初回配置 ${ms(load.p50)} / ${ms(load.p95)} ms, Markdown 編集 ${ms(edit.p50)} / ${ms(edit.p95)} ms (${((Date.now() - started) / 1000).toFixed(1)} s)`);
}

async function main() {
  const options = parseArgs(process.argv);
  const fixtures = selectFixtures(options);
  if (fixtures.length === 0) throw new Error('No fixtures selected.');
  const outRoot = resolve(root, options.out);
  const startedAt = new Date();
  const directory = join(outRoot, startedAt.toISOString().replace(/[:.]/gu, '-'));
  await mkdir(directory, { recursive: true });
  const notExecuted = [
    'Obsidian 実機での計測（E10）: このページは Obsidian の Editor・Vault・テーマを持たない。実機の入力反映は LEV-33 の計測と突き合わせる。',
    'トラックパッドのピンチ・慣性スクロール、ネイティブ IME、モバイル: headless の合成入力では計測できない。',
    'GPU 合成・ラスタを含む描画フレーム時間: headless（--disable-gpu）では main thread の間隔だけが取れる。',
  ];
  const chrome = findChrome(options.chrome);
  const env = environment(chrome, options);
  const output = await buildBrowserHarness();
  if (!chrome) {
    const record = recordMarkdown({
      env, fixtures, summary: buildSummary(fixtures, []), failures: [],
      notExecuted: ['headless Chrome が見つからないため計測は未実施。`--chrome <path>` か MAPPY_CHROME を指定して再実行する。', ...notExecuted],
    });
    await writeFile(join(directory, 'record.md'), record);
    console.error(`No Chrome found. Wrote ${relative(root, join(directory, 'record.md'))} marking the run as not executed.`);
    process.exitCode = 2;
    return;
  }
  const samples = [];
  const failures = [];
  await withHarnessPage(chrome, { output, window: WINDOW, fixture: fixtures[0].id, pane: PANE }, async page => {
    for (const entry of fixtures) await runFixture(page, entry, options, samples, failures);
  });
  const summary = buildSummary(fixtures, samples);
  await writeFile(join(directory, 'samples.json'), `${JSON.stringify({ env, samples }, null, 2)}\n`);
  await writeFile(join(directory, 'summary.json'), `${JSON.stringify({ env, summary }, null, 2)}\n`);
  await writeFile(join(directory, 'record.md'), recordMarkdown({ env, fixtures, summary, notExecuted, failures }));
  console.info(`Wrote ${relative(root, directory)} (${samples.length} samples, ${failures.length} failures).`);
  if (failures.length > 0) process.exitCode = 1;
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsScript) await main();
