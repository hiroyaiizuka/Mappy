/**
 * Time `layoutTree` alone on the generated 10/100/500/2,000 node documents.
 *
 *   node scripts/measure-layout.mjs [--runs 50] [--out artifacts/layout-timing]
 *
 * The documents are the ones `scripts/performance-fixtures.mjs` generates for the
 * test vault and the browser harness. Node sizes are estimated from the title
 * length (14px per character, wrapped at 360px) because no DOM is involved; parse
 * time is reported separately so the layout figures stay comparable across modes.
 * The result is a record.md and timings.json under artifacts/layout-timing/<timestamp>/.
 * This is a layout microbenchmark, not the input-to-screen measurement of product-plan §6.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { estimateNodeSizes, makePerformanceFixture, performanceNodeCounts } from './performance-fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modes = ['mindmap', 'timeline', 'hierarchy'];
const WARMUP = 5;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

/** Short hash, with `-dirty` when the working tree differs from it, so a record never claims a commit it did not measure. */
function commitHash() {
  try {
    const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '';
    return dirty ? `${hash}-dirty` : hash;
  } catch {
    return 'unknown';
  }
}

/** Bundle the layout and parser once so the benchmark runs the same TypeScript as the plugin. */
async function loadModules() {
  const outdir = join(root, 'dist', 'measure-layout');
  await mkdir(outdir, { recursive: true });
  await build({
    absWorkingDir: root,
    entryPoints: ['src/layout/layout.ts', 'src/core/markdown.ts'],
    outdir,
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    target: 'es2021',
    logLevel: 'silent',
  });
  const layout = await import(pathToFileURL(join(outdir, 'layout', 'layout.js')).href);
  const markdown = await import(pathToFileURL(join(outdir, 'core', 'markdown.js')).href);
  return { layoutTree: layout.layoutTree, parseMarkdown: markdown.parseMarkdown, projectMap: markdown.projectMap };
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((first, second) => first - second);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function summarize(samples) {
  return {
    runs: samples.length,
    median: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    max: Math.max(...samples),
  };
}

function time(task, runs) {
  for (let index = 0; index < WARMUP; index += 1) task();
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    task();
    samples.push(performance.now() - start);
  }
  return summarize(samples);
}

function format(value) {
  return value.toFixed(2);
}

async function main() {
  const runs = Number(option('--runs', '50'));
  if (!Number.isInteger(runs) || runs < 1) {
    console.error('Usage: node scripts/measure-layout.mjs [--runs <positive integer>] [--out <directory>]');
    process.exitCode = 1;
    return;
  }
  const outRoot = resolve(root, option('--out', join('artifacts', 'layout-timing')));
  const { layoutTree, parseMarkdown, projectMap } = await loadModules();
  const startedAt = new Date();
  const results = [];
  for (const count of performanceNodeCounts) {
    const [name, source] = makePerformanceFixture(count);
    const parse = time(() => parseMarkdown(source, name), runs);
    const doc = parseMarkdown(source, name);
    const { root: tree } = projectMap(doc);
    const sizes = estimateNodeSizes(doc.nodes);
    const expanded = new Set();
    const collapsed = new Set(tree.children.slice(0, Math.ceil(tree.children.length / 2)).map(node => node.id));
    const entry = { count, name, parse, layout: {} };
    for (const mode of modes) {
      const full = layoutTree(tree, sizes, expanded, mode);
      entry.layout[mode] = {
        nodes: full.nodes.length,
        bounds: { width: Math.round(full.bounds.width), height: Math.round(full.bounds.height) },
        expanded: time(() => layoutTree(tree, sizes, expanded, mode), runs),
        collapsed: time(() => layoutTree(tree, sizes, collapsed, mode), runs),
      };
    }
    results.push(entry);
    console.log(`${name}: parse median ${format(parse.median)} ms, ${modes.map(mode => `${mode} ${format(entry.layout[mode].expanded.median)} ms`).join(', ')}`);
  }
  const environment = {
    commit: commitHash(),
    node: process.version,
    platform: `${platform()} ${release()} ${arch()}`,
    cpu: cpus()[0]?.model ?? 'unknown',
    memoryGiB: Math.round(totalmem() / 2 ** 30),
    startedAt: startedAt.toISOString(),
    runs,
    warmup: WARMUP,
    sizes: 'estimated from title length (14px/char, max 360px), no DOM',
  };
  const directory = join(outRoot, startedAt.toISOString().replace(/[:.]/gu, '-'));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'timings.json'), `${JSON.stringify({ environment, results }, null, 2)}\n`);
  const lines = [
    '# レイアウト配置時間（layoutTree 単体）',
    '',
    `- 日時: ${environment.startedAt}`,
    `- commit: ${environment.commit}`,
    `- 端末: ${environment.cpu}、${environment.memoryGiB} GiB、${environment.platform}、Node ${environment.node}`,
    `- 条件: \`scripts/performance-fixtures.mjs\` の文書を \`parseMarkdown\` → \`projectMap\` し、ノードの大きさはタイトル長から推定（1 文字 14px、最大幅 360px。DOM 計測なし）。各ケース ${environment.warmup} 回の暖機のあと ${environment.runs} 回計測し、中央値・p95・最大値（ms）を記録。`,
    '- 折りたたみ: 第一階層の前半を閉じた状態で再配置した時間。',
    '- この計測はレイアウト単体で、product-plan §6 の「入力から画面反映まで」（解析・配置・描画・debounce を含む実機計測）ではない。',
    '',
    '| ノード数 | 解析 中央値 / p95 | モード | 表示ノード | bounds (w×h) | 展開 中央値 / p95 / 最大 | 折りたたみ 中央値 / p95 / 最大 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const entry of results) {
    for (const mode of modes) {
      const item = entry.layout[mode];
      lines.push(`| ${entry.count} | ${format(entry.parse.median)} / ${format(entry.parse.p95)} | ${mode} | ${item.nodes} | ${item.bounds.width}×${item.bounds.height} | ${format(item.expanded.median)} / ${format(item.expanded.p95)} / ${format(item.expanded.max)} | ${format(item.collapsed.median)} / ${format(item.collapsed.p95)} / ${format(item.collapsed.max)} |`);
    }
  }
  lines.push('', `生データ: \`${relative(root, join(directory, 'timings.json'))}\``, '');
  await writeFile(join(directory, 'record.md'), lines.join('\n'));
  console.log(`Wrote ${relative(root, join(directory, 'record.md'))}`);
}

await main();
