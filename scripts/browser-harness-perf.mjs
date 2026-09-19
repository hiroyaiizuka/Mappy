/**
 * Measure the map view's load and edit stages on the generated 10/100/500/2,000
 * node fixtures in headless Chrome, and record p50/p95 with the machine that
 * produced them (product-plan §6, LEV-13).
 *
 *   node scripts/browser-harness-perf.mjs [--chrome <path>] [--out artifacts/performance]
 *       [--repeat 10] [--keystrokes 30] [--frames 60] [--shapes headings,list,...]
 *       [--counts 10,100,500,2000] [--fixtures performance-500,...]
 *       [--layouts mindmap,timeline,hierarchy,balanced] [--gpu]
 *
 * `--gpu` drops --disable-gpu so Chrome rasterises on the GPU like Electron does;
 * the default software rendering makes raster costs show up as frame delays.
 *
 * Per fixture, in its own headless Chrome, and per layout: one warm-up load,
 * `repeat` loads in a fresh view, `repeat` Markdown-side edits, `repeat` inline
 * edits (`keystrokes` keystrokes in total, each followed by Enter), and two pan
 * and zoom runs of `frames` frames. The stages come from harness/browser/measure.ts;
 * this script only drives the page, summarises and writes samples.json,
 * summary.json and record.md. Without Chrome it writes a record marking the run
 * as not executed and exits with 2.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildBrowserHarness } from './browser-harness.mjs';
import { CdpClosedError, chromeFlags, chromeVersion, findChrome, withHarnessPage } from './browser-harness-cdp.mjs';
import { performanceFixtureMatrix, performanceShapes } from './performance-fixtures.mjs';
import { summarize } from './perf-stats.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WINDOW = { width: 1640, height: 1000 };
const PANE = { width: 1280, height: 800 };
const FRAME_RUNS = 2;
/** One frame at 60 fps; intervals above it mean a frame was missed. */
const FRAME_BUDGET_MS = 1000 / 60 + 0.5;
/** The product's layouts (src/core/layout-mode.ts LAYOUT_MODES), in the order the record lists them. */
export const LAYOUTS = ['mindmap', 'timeline', 'hierarchy', 'balanced'];
const LAYOUT_LABELS = { mindmap: 'マップ', timeline: 'タイムライン', hierarchy: '階層図', balanced: '左右バランス' };

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
    layouts: list('--layouts'),
    gpu: args.includes('--gpu'),
  };
}

export function selectFixtures(options) {
  const known = new Set(performanceShapes.map(shape => shape.id));
  for (const shape of options.shapes ?? []) if (!known.has(shape)) throw new Error(`Unknown shape: ${shape}`);
  return performanceFixtureMatrix().filter(entry => (!options.shapes || options.shapes.includes(entry.shape.id))
    && (!options.counts || options.counts.includes(entry.nodeCount))
    && (!options.fixtures || options.fixtures.includes(entry.id)));
}

/** The layouts to measure, in LAYOUTS order whatever the option's order. */
export function selectLayouts(options) {
  for (const layout of options.layouts ?? []) if (!LAYOUTS.includes(layout)) throw new Error(`Unknown layout: ${layout}`);
  return LAYOUTS.filter(layout => !options.layouts || options.layouts.includes(layout));
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
    chromeFlags: chromeFlags(WINDOW, { gpu: options.gpu }).join(' '),
    gpu: options.gpu,
    window: WINDOW,
    pane: PANE,
    commit: git('rev-parse', '--short', 'HEAD'),
    dirty: git('status', '--porcelain') !== '',
    options: { repeat: options.repeat, keystrokes: options.keystrokes, frames: options.frames, layouts: selectLayouts(options) },
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
  return {
    ...summarize(intervals), over: intervals.filter(value => value > FRAME_BUDGET_MS).length,
    handler: summarize(samples.flatMap(sample => sample.handlerMs ?? [])),
  };
}

/**
 * One row per fixture × layout, fixtures in matrix order and layouts in LAYOUTS
 * order, so the record reads count by count within a shape. Samples without a
 * `mode` (records from before the layout dimension) count as the mind map.
 */
export function buildSummary(fixtures, samples, layouts = LAYOUTS) {
  const rows = [];
  for (const entry of fixtures) {
    for (const layout of layouts) {
      const own = samples.filter(sample => sample.fixture === entry.id && (sample.mode ?? 'mindmap') === layout);
      const kind = name => own.filter(sample => sample.kind === name);
      rows.push({
        fixture: entry.id, nodes: entry.nodeCount, shape: entry.shape.id, layout,
        load: summarizeFields(kind('load'), LOAD_FIELDS),
        'markdown-edit': summarizeFields(kind('markdown-edit'), EDIT_FIELDS['markdown-edit']),
        'inline-key': summarizeFields(kind('inline-key'), EDIT_FIELDS['inline-key']),
        'inline-commit': summarizeFields(kind('inline-commit'), EDIT_FIELDS['inline-commit']),
        pan: summarizeFrames(kind('pan')),
        zoom: summarizeFrames(kind('zoom')),
      });
    }
  }
  return rows;
}

/** The worst p95 across the shapes of one node count, so §6's targets can be read off one line per layout. */
function worst(summary, nodes, layout, pick) {
  const values = summary.filter(row => row.nodes === nodes && row.layout === layout).map(pick).filter(Number.isFinite);
  return values.length ? Math.max(...values) : NaN;
}

/**
 * Per layout: the stages product-plan §6 asks about, taken as the worst p95 over
 * every shape at the node count the target names (500 for edits, 2,000 for load
 * and frames). Frames are counted, not timed: over-budget frames / all frames.
 */
export function highlights(summary, layouts = LAYOUTS) {
  return layouts.map(layout => {
    const frames = kind => {
      const rows = summary.filter(row => row.nodes === 2000 && row.layout === layout);
      return { over: rows.reduce((sum, row) => sum + row[kind].over, 0), n: rows.reduce((sum, row) => sum + row[kind].n, 0) };
    };
    return {
      layout,
      markdownEdit500: worst(summary, 500, layout, row => row['markdown-edit'].totalMs.p95),
      inlineKey500: worst(summary, 500, layout, row => row['inline-key'].totalMs.p95),
      inlineCommit500: worst(summary, 500, layout, row => row['inline-commit'].totalMs.p95),
      markdownEdit2000: worst(summary, 2000, layout, row => row['markdown-edit'].totalMs.p95),
      firstLayout2000: worst(summary, 2000, layout, row => row.load.firstLayoutMs.p95),
      settled2000: worst(summary, 2000, layout, row => row.load.settledMs.p95),
      pan2000: frames('pan'),
      zoom2000: frames('zoom'),
    };
  });
}

function table(header, rows) {
  return [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.join(' | ')} |`)];
}

export function recordMarkdown({ env, fixtures, summary, notExecuted, failures }) {
  const shapeLabel = id => performanceShapes.find(shape => shape.id === id)?.label ?? id;
  const layoutLabel = id => LAYOUT_LABELS[id] ?? id;
  const layouts = env.options.layouts ?? LAYOUTS;
  const frames = ({ over, n }) => (n ? `${over} / ${n}` : '—');
  const lines = [
    '# 性能計測（ブラウザ検証ページ②、headless Chrome）',
    '',
    `- 日時: ${env.at}`,
    `- 基準端末: ${env.cpu}（${env.cores} コア、${env.memoryGb} GB）、${env.os}、${env.arch}。開始時の load average ${env.loadavg.join(' / ')}（1／5／15 分。他の作業が同時に動いていればノイズになる）`,
    `- Node: ${env.node}、Chrome: ${env.chrome}（${env.chromePath}）`,
    `- Chrome フラグ: ${env.chromeFlags}、ウィンドウ ${env.window.width}×${env.window.height}、ペイン ${env.pane.width}×${env.pane.height}、devicePixelRatio 1`,
    `- build: ${env.commit}${env.dirty ? '（未コミットの変更あり）' : ''}（\`npm run harness:browser:build\` の \`dist/harness\`。製品の src/ と core / layout / ui をそのまま読み込む）`,
    `- 繰り返し: fixture ごとに新しい headless Chrome で、レイアウト（${layouts.map(layoutLabel).join('・')}）ごとに読み込み ${env.options.repeat} 回（ウォームアップ 1 回を除く）、Markdown 側の編集 ${env.options.repeat} 回、インライン編集 ${env.options.repeat} 回（キー入力 計 ${env.options.keystrokes} 回）、パン／ズーム各 ${FRAME_RUNS} 回 × ${env.options.frames} フレーム`,
    '- 統計: nearest-rank の p50 / p95（ms）。値は「p50 / p95」。',
    '- テーマ: harness.css の仮の CSS 変数（Obsidian のテーマではない）。画像: `sample-image.svg` の data URL（転送なし。画像の読み込み後の再配置は「安定」に含まれ、転送時間は含まれない）。',
    '',
    '## 要点（§6 の目標に対応。各ノード数の全ての形のうち最も遅い p95、ms）',
    '',
    ...table(['レイアウト', '500: Markdown 編集 合計', '500: キー入力 合計', '500: Enter 確定 合計', '2,000: Markdown 編集 合計', '2,000: 初回配置', '2,000: 安定',
      `2,000: パン ${FRAME_BUDGET_MS.toFixed(1)} ms 超`, `2,000: ズーム ${FRAME_BUDGET_MS.toFixed(1)} ms 超`],
      highlights(summary, layouts).map(row => [layoutLabel(row.layout), ms(row.markdownEdit500), ms(row.inlineKey500), ms(row.inlineCommit500),
        ms(row.markdownEdit2000), ms(row.firstLayout2000), ms(row.settled2000), frames(row.pan2000), frames(row.zoom2000)])),
    '',
    '## 段階の定義',
    '',
    '- 読み込み（fixture を新しい view で開く）: `parse` = parseMarkdown 単体、`setState` = 読み込み・view の parse・ノード DOM 生成、`計測` = setState 直後にノードの offsetWidth を読んだときのブラウザの style／layout（view は配置フレームの sizes() で同じ計算を払う。段階を分けるために先に読む）、`layoutTree` = 配置アルゴリズム単体（計測済みサイズで）、`配置フレーム` = view の requestAnimationFrame コールバック（sizes・layoutTree・place・線・Fit）、`次フレーム開始` = そのコールバック終了から次のフレーム開始まで（vsync 待ちと style／layout／paint。約 17 ms 以下なら 1 フレーム内に収まった）、`初回配置` = setState 開始〜配置フレーム終了、`安定` = ノード位置が 3 フレーム変わらないまで（3 フレーム分の待ちを含む）。',
    '- Markdown 側の編集（vault の modify → view）: `debounce` = 変更〜45 ms の debounce 発火、`再読込〜DOM` = 発火〜編集ノードの DOM 更新（read・parse・ノード DOM）、`フレーム待ち` = DOM 更新〜配置フレーム開始（ブラウザがフレーム前に行う style／layout を含むことがある）、`配置フレーム`、`次フレーム開始`、`合計` = 変更〜配置後の次フレーム開始（画面に出せる最初のフレーム）。Obsidian のエディタ入力は editor-change → 同じ経路。',
    '- インライン編集（マップ側、実 DOM 経由）: `キー入力` = textarea への 1 文字入力〜配置後の次フレーム開始（`入力ハンドラ` は textarea の高さ再計算）、`確定` = Enter〜改名の適用・再読込・再描画・配置後の次フレーム開始（`適用〜DOM` は apply・read・parse・ノード DOM）。',
    '- パン／ズーム: 1 フレームに 1 回 wheel（パンは deltaY 12、ズームは Ctrl＋deltaY 20）を送り、requestAnimationFrame のタイムスタンプ間隔と、wheel ハンドラ（transform の更新）の同期時間を記録。間隔からハンドラを引いた残りはブラウザの合成・ラスタで、既定のソフトウェア描画では GPU 描画より重く出る。',
    '',
    '## 読み込み（ms、p50 / p95）',
    '',
    ...table(['fixture', '形', 'ノード', 'レイアウト', 'n', ...LOAD_FIELDS.map(([, label]) => label)],
      summary.map(row => [row.fixture, shapeLabel(row.shape), row.nodes, layoutLabel(row.layout), row.load.parseMs.n,
        ...LOAD_FIELDS.map(([field]) => range(row.load[field]))])),
    '',
    '## Markdown 側の編集 → 画面反映（ms、p50 / p95）',
    '',
    ...table(['fixture', 'ノード', 'レイアウト', 'n', ...EDIT_FIELDS['markdown-edit'].map(([, label]) => label)],
      summary.map(row => [row.fixture, row.nodes, layoutLabel(row.layout), row['markdown-edit'].totalMs.n,
        ...EDIT_FIELDS['markdown-edit'].map(([field]) => range(row['markdown-edit'][field]))])),
    '',
    '## インライン編集: キー入力 → 画面反映（ms、p50 / p95）',
    '',
    ...table(['fixture', 'ノード', 'レイアウト', 'n', ...EDIT_FIELDS['inline-key'].map(([, label]) => label)],
      summary.map(row => [row.fixture, row.nodes, layoutLabel(row.layout), row['inline-key'].totalMs.n,
        ...EDIT_FIELDS['inline-key'].map(([field]) => range(row['inline-key'][field]))])),
    '',
    '## インライン編集: Enter で確定 → 画面反映（ms、p50 / p95）',
    '',
    ...table(['fixture', 'ノード', 'レイアウト', 'n', ...EDIT_FIELDS['inline-commit'].map(([, label]) => label)],
      summary.map(row => [row.fixture, row.nodes, layoutLabel(row.layout), row['inline-commit'].totalMs.n,
        ...EDIT_FIELDS['inline-commit'].map(([field]) => range(row['inline-commit'][field]))])),
    '',
    '## パン／ズーム中のフレーム間隔（ms）',
    '',
    ...table(['fixture', 'ノード', 'レイアウト', 'パン p50 / p95', 'パン 最大', `パン ${FRAME_BUDGET_MS.toFixed(1)} ms 超`, 'パン ハンドラ p95',
      'ズーム p50 / p95', 'ズーム 最大', `ズーム ${FRAME_BUDGET_MS.toFixed(1)} ms 超`, 'ズーム ハンドラ p95'],
      summary.map(row => [row.fixture, row.nodes, layoutLabel(row.layout), range(row.pan), ms(row.pan.max), frames(row.pan), ms(row.pan.handler.p95),
        range(row.zoom), ms(row.zoom.max), frames(row.zoom), ms(row.zoom.handler.p95)])),
    '',
    '## 失敗',
    '',
    ...(failures.length ? failures.map(failure => `- ${failure}`) : ['- なし']),
    '',
    '## 未実施',
    '',
    ...notExecuted.map(item => `- ${item}`),
    '',
    `対象 fixture: ${fixtures.map(entry => entry.id).join(', ')}。レイアウト: ${layouts.join(', ')}`,
    '',
  ];
  return lines.join('\n');
}

/** Every stage of one fixture in one layout; the page's view is opened in that layout for each load. */
async function runLayout(page, entry, layout, options, samples, failures) {
  const record = sample => { samples.push(sample); };
  const load = `h.measure.load(${JSON.stringify(entry.id)}, ${JSON.stringify(layout)})`;
  const attempt = async (label, body) => {
    try {
      await body();
    } catch (error) {
      // A dead Chrome cannot record anything more; let the run fail instead of logging every step as a failure.
      if (error instanceof CdpClosedError) throw error;
      const message = `${entry.id} ${layout} ${label}: ${error instanceof Error ? error.message : String(error)}`;
      failures.push(message);
      console.error(`FAIL ${message}`);
      // Leave the fixture in a known state for the next step.
      await page.harness(load).catch(() => undefined);
    }
  };
  const started = Date.now();
  await attempt('warm-up', () => page.harness(load));
  for (let index = 0; index < options.repeat; index += 1) {
    await attempt(`load ${index + 1}`, async () => { record(await page.harness(load)); });
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
  const own = samples.filter(sample => sample.fixture === entry.id && sample.mode === layout);
  const first = summarize(own.filter(sample => sample.kind === 'load').map(sample => sample.firstLayoutMs));
  const edit = summarize(own.filter(sample => sample.kind === 'markdown-edit').map(sample => sample.totalMs));
  console.info(`${entry.id} ${layout}: 初回配置 ${ms(first.p50)} / ${ms(first.p95)} ms, Markdown 編集 ${ms(edit.p50)} / ${ms(edit.p95)} ms (${((Date.now() - started) / 1000).toFixed(1)} s)`);
}

async function runFixture(page, entry, layouts, options, samples, failures) {
  for (const layout of layouts) await runLayout(page, entry, layout, options, samples, failures);
}

async function main() {
  const options = parseArgs(process.argv);
  const fixtures = selectFixtures(options);
  if (fixtures.length === 0) throw new Error('No fixtures selected.');
  const layouts = selectLayouts(options);
  if (layouts.length === 0) throw new Error('No layouts selected.');
  const outRoot = resolve(root, options.out);
  const startedAt = new Date();
  const directory = join(outRoot, startedAt.toISOString().replace(/[:.]/gu, '-'));
  await mkdir(directory, { recursive: true });
  const notExecuted = [
    'Obsidian 実機での計測（E10）: このページは Obsidian の Editor・Vault・テーマを持たない。実機の入力反映は LEV-33 の計測と突き合わせる。',
    'トラックパッドのピンチ・慣性スクロール、ネイティブ IME、モバイル: headless の合成入力では計測できない。',
    options.gpu
      ? 'GPU ラスタ（--gpu）: headless でも GPU を使うが、実機の Electron・ディスプレイ・スケール係数とは異なる。'
      : 'GPU 合成・ラスタを含む描画フレーム時間: 既定（--disable-gpu）ではソフトウェア描画で、ラスタの重さがフレーム待ちに現れる。--gpu で再実行して比較する。',
  ];
  const chrome = findChrome(options.chrome);
  const env = environment(chrome, options);
  const output = await buildBrowserHarness();
  if (!chrome) {
    const record = recordMarkdown({
      env, fixtures, summary: buildSummary(fixtures, [], layouts), failures: [],
      notExecuted: ['headless Chrome が見つからないため計測は未実施。`--chrome <path>` か MAPPY_CHROME を指定して再実行する。', ...notExecuted],
    });
    await writeFile(join(directory, 'record.md'), record);
    console.error(`No Chrome found. Wrote ${relative(root, join(directory, 'record.md'))} marking the run as not executed.`);
    process.exitCode = 2;
    return;
  }
  const samples = [];
  const failures = [];
  // One fresh Chrome per fixture: every fixture starts from the same state, and a
  // crash (the DevTools socket closing) costs that fixture's remaining steps, not the run.
  for (const entry of fixtures) {
    try {
      await withHarnessPage(chrome, { output, window: WINDOW, fixture: entry.id, pane: PANE, gpu: options.gpu },
        page => runFixture(page, entry, layouts, options, samples, failures));
    } catch (error) {
      const message = `${entry.id}: Chrome の接続が切れたため以降の手順を中止 — ${error instanceof Error ? error.message : String(error)}`;
      failures.push(message);
      console.error(`FAIL ${message}`);
    }
  }
  const summary = buildSummary(fixtures, samples, layouts);
  await writeFile(join(directory, 'samples.json'), `${JSON.stringify({ env, samples }, null, 2)}\n`);
  await writeFile(join(directory, 'summary.json'), `${JSON.stringify({ env, summary }, null, 2)}\n`);
  await writeFile(join(directory, 'record.md'), recordMarkdown({ env, fixtures, summary, notExecuted, failures }));
  console.info(`Wrote ${relative(root, directory)} (${samples.length} samples, ${failures.length} failures).`);
  if (failures.length > 0) process.exitCode = 1;
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsScript) await main();
