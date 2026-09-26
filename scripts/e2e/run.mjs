/**
 * Runs the real-Obsidian e2e cases (docs/harness.md 実機検証) registered below, one Obsidian instance
 * at a time (only one to drive: docs/linear-workflow.md「Obsidian 実機は1台なので、実機を使うチケットは
 * 同時に1本にする」), each case connecting to it in turn.
 *
 * Each case stays a standalone script (`node scripts/e2e/<file>.mjs`, wired to its own
 * `npm run harness:e2e:<name>`) run here as its own child process, not imported into this one: a case
 * that hangs or crashes mid-CDP-call then only takes down its own process and connection, not the run's
 * (or the next case's). This file only sequences them and points `--json`/`--shot` at per-case paths so
 * a full run does not have every case overwrite the same file.
 *
 * Usage: npm run harness:e2e -- [--case <name>] [--reload] [--json <dir>] [--shot <dir>] [--keep]
 *   --case   run only the named case (see CASES below) instead of all of them; no `summary.json` then,
 *            since it would otherwise silently replace a previous full run's summary with one case's
 *   --json   directory to write <case>.json into (and, for a full run, a summary.json)
 *   --shot   directory to write <case>.png into, for cases that take one
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const CASES = [
  { name: 'add-delete', file: 'add-delete.mjs', description: 'E02 兄弟・子の追加と削除', shot: false },
  { name: 'delete-selection', file: 'delete-selection.mjs', description: 'E41 削除後の選択（上の兄弟→下の兄弟→親）と Undo', shot: false },
  { name: 'undo-redo', file: 'undo-redo.mjs', description: 'E03 Undo/Redo と表裏切替', shot: false },
  { name: 'deep-branches', file: 'deep-branches.mjs', description: 'E17 7 段以上の枝の追加・移動・インデント', shot: false },
  { name: 'convert-to-list', file: 'convert-to-list.mjs', description: 'E18 旧見出し形式→リスト形式→Undo', shot: false },
  { name: 'move-parent-text', file: 'move-parent-text.mjs', description: 'E19 親本文を挟む移動', shot: false },
  { name: 'paste', file: 'paste-image.mjs', description: 'E37 画像の貼り付け', shot: true },
  { name: 'layout-switch', file: 'layout-switch.mjs', description: 'E39 レイアウトボタンと同時の編集・折りたたみ', shot: false },
  { name: 'undo-ids', file: 'undo-ids.mjs', description: 'E47 Undo/Redo の前後の同名・空題名ノードの折りたたみと選択', shot: false },
  { name: 'embed-own-writes', file: 'embed-own-writes.mjs', description: 'E55 マップのタブの編集・切替・Undo/Redo の前後で埋め込みの同名・空題名ノードの折りたたみ', shot: false },
  { name: 'line-break', file: 'line-break.mjs', description: 'E40 ノード内の改行（Shift+Enter → <br>）', shot: true },
  { name: 'new-node', file: 'new-node-input.mjs', description: 'E43 新しいノードの入力欄（外形・仮の名前・Escape での取り消し）', shot: false },
  { name: 'excalidraw-frame', file: 'excalidraw-frame.mjs', description: 'E24 Excalidraw の対話フレームでのライブ表示', shot: true },
  { name: 'excalidraw-lifecycle', file: 'excalidraw-lifecycle.mjs', description: 'E25 Mappy 無効化→Excalidraw 再読込→Mappy 有効化', shot: true },
  { name: 'timeline-stage-gap', file: 'timeline-stage-gap.mjs', description: 'E42 タイムラインの同じ側のステージの間隔', shot: true },
  { name: 'timeline-large', file: 'timeline-large.mjs', description: 'E45 長文・画像・深い枝が混在する大規模タイムライン', shot: true },
  { name: 'theme', file: 'theme.mjs', description: 'E48 明色・暗色テーマ × テーマ設定（従う／明色／暗色）のコントラストと色', shot: true },
  { name: 'drag-viewport', file: 'drag-viewport.mjs', description: 'E49 フリーツリーのドラッグ中のホイール・ズーム／全体表示と保存位置', shot: false },
  { name: 'popout', file: 'popout.mjs', description: 'E50 別ウィンドウでの描画・キー操作・移動・閉じたあとの残留', shot: true },
  { name: 'view-lifecycle', file: 'view-lifecycle.mjs', description: 'E51 開閉 50 回・プラグイン再読込・ウィンドウ再読込の残留と多重イベント', shot: false },
  { name: 'drop-flicker', file: 'drop-flicker.mjs', description: 'E53 フリーツリーを離した直後、保存後の原文が描かれるまでのフレーム', shot: false },
  { name: 'own-write-flicker', file: 'own-write-flicker.mjs', description: 'E54 自分の書き込み（改名・追加・キー移動・⌘Z／⌘⇧Z・スロットへのドロップ・切り離し）のあと、書き込み前の原文が描かれないこと', shot: false },
  { name: 'window-blur-draft', file: 'window-blur-draft.mjs', description: 'E56 下書きの途中でウィンドウのフォーカスが外れて戻ったあとの Enter・押下', shot: false },
  { name: 'node-tooltip', file: 'node-tooltip.mjs', description: 'E57 ノード・入力欄・埋め込みのノードに乗せても吹き出しが出ない（ボタンには出る）', shot: true },
  { name: 'reread-own-writes', file: 'reread-own-writes.mjs', description: 'E58 変わらない原文の再読込の最中に記録された書き込み（このマップのボタン・⌥↑・⌘Z、別のマップのボタン・移動・⌘Z）× Markdown エディタの有無で、空題名・同名の折りたたみが保たれること', shot: false },
];

const args = process.argv.slice(2);
let caseName; let jsonDir; let shotDir;
const passthrough = [];
try {
  for (let i = 0; i < args.length; i += 1) {
    const isFlagValue = name => {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value`);
      return next;
    };
    if (args[i] === '--case') { caseName = isFlagValue('--case'); i += 1; continue; }
    if (args[i] === '--json') { jsonDir = isFlagValue('--json'); i += 1; continue; }
    if (args[i] === '--shot') { shotDir = isFlagValue('--shot'); i += 1; continue; }
    passthrough.push(args[i]);
  }
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

const targets = caseName ? CASES.filter(item => item.name === caseName) : CASES;
if (caseName && targets.length === 0) {
  console.error(`Unknown case "${caseName}". Known: ${CASES.map(item => item.name).join(', ')}`);
  process.exit(2);
}

if (jsonDir) await mkdir(jsonDir, { recursive: true });
if (shotDir) await mkdir(shotDir, { recursive: true });

const run = testCase => new Promise(resolve => {
  const caseArgs = [...passthrough];
  if (jsonDir) caseArgs.push('--json', join(jsonDir, `${testCase.name}.json`));
  if (shotDir && testCase.shot) caseArgs.push('--shot', join(shotDir, `${testCase.name}.png`));
  console.log(`\n=== ${testCase.name}: ${testCase.description} ===`);
  const child = spawn(process.execPath, [join(here, testCase.file), ...caseArgs], { stdio: 'inherit' });
  child.on('exit', code => resolve(code ?? 1));
  child.on('error', error => { console.error(error); resolve(1); });
});

const startedAt = new Date().toISOString();
const results = [];
for (const testCase of targets) {
  // A stale <case>.json from an earlier run in the same --json dir must not be mistaken for this run's
  // result if the case dies before it calls `finish()` (case-runner.mjs) — delete it first, so a crash
  // leaves no file rather than an old, possibly green, one.
  if (jsonDir) await rm(join(jsonDir, `${testCase.name}.json`), { force: true });
  // Cases share the one Obsidian window and must not overlap.
  const exitCode = await run(testCase);
  results.push({ name: testCase.name, description: testCase.description, exitCode, passed: exitCode === 0 });
}

const passed = results.every(result => result.passed);
// Only a full run (no --case) writes summary.json: a single-case run must not silently replace a
// previous full run's summary with just that one case's result under the same name.
if (jsonDir && !caseName) {
  const summary = { startedAt, passed, results };
  for (const result of summary.results) {
    try {
      result.record = JSON.parse(await readFile(join(jsonDir, `${result.name}.json`), 'utf8'));
    } catch {
      // The case did not write its own JSON (it failed before `finish()`, or never ran); the exit code stands.
    }
  }
  await writeFile(join(jsonDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

console.log(`\n${passed ? 'PASS' : 'FAIL'}: ${results.map(result => `${result.name}=${result.passed ? 'PASS' : 'FAIL'}`).join(' ')}`);
process.exit(passed ? 0 : 1);
