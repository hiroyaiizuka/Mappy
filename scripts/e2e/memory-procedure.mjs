/**
 * `.claude/skills/memory-manager/SKILL.md` と AGENTS.md の開発メモリの箇条書き（`bm tool` を含む行）に
 * 書かれた bm CLI の手順を、書かれたとおりに実行して期待どおりに動くかを確かめるケース
 * （docs/harness.md「開発メモリの手順」）。
 *
 * 手順書は `src/` を 1 行も含まないが、次のセッションのエージェントが従う側の仕組みなので、壊れたまま
 * merge されると毎セッション効き続ける（LEV-184 は PR #74 がそれで 15 件の欠陥を通した）。`artifacts/` に
 * 「確認済み」と書くだけの使い捨て probe にせず、ここに置いて `npm run harness:e2e:memory-procedure` で
 * 誰でも同じ手順を再実行できるようにする（AGENTS.md）。
 *
 * **`mappy-memory` には触らない。** 使い捨ての Basic Memory プロジェクトを毎回作り、最後にノートごと消す。
 * プロジェクト名にはプロセス ID と乱数を混ぜ、既存のプロジェクトと衝突しないようにする。
 *
 * Usage: npm run harness:e2e:memory-procedure -- [--json <path>] [--keep]
 *   --json  結果の JSON を書き出す
 *   --keep  後片付けをせず、使い捨てプロジェクトを残す（失敗を手で追うとき）
 *
 * 終了コード: 0 = PASS、1 = FAIL、2 = 実行できなかった（bm CLI が無い等。PASS として記録しない）
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecord, finish, makeCheck, makeStep, parseArgs } from './case-runner.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const { flag, value } = parseArgs();
const jsonPath = value('--json');
const keep = flag('--keep');

const PROJECT = `mappy-memory-probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

const BM_TIMEOUT_MS = 120_000;

// 端末の Ctrl-C は前面のプロセスグループ全体に届く。子（bm・sh）はその場で止まるが、node の SIGINT ハンドラーは
// イベントループが回るまで動かず、このファイルは同期の spawnSync を続けるので、残りのステップを最後まで走らせて
// しまう。子の終わり方（signal）を見て、その場で中断の片付けに入る。
// 時間切れ（error が ETIMEDOUT で signal が SIGTERM）は中断ではないので除く。
// bm は Typer 製で、Ctrl-C（KeyboardInterrupt）ではシグナルで死なず終了コード 130 で終わる。シェルもその終了コードを
// そのまま返す。シグナルでの終了と、128＋番号（130 = SIGINT、143 = SIGTERM）の終了コードの両方を中断と見る。
const INTERRUPT_STATUS = { 130: 'SIGINT', 143: 'SIGTERM' };
// 片付けの本体（onInterrupt）は record・root などを使うので、それらを作った後で登録する。登録前に中断されたら、
// 片付けるものが無いのでここで終える。
let interruptHandler = null;
// 後片付けに入ったら、子の終わり方から中断に入らない。onInterrupt が二重に片付けて finally の残りを飛ばさないよう、
// 後片付けは最後まで進め、失敗はそのまま check に残す。
let cleaningUp = false;
const stopIfInterrupted = result => {
  if (result.error || cleaningUp) return;
  const signal = result.signal === 'SIGINT' || result.signal === 'SIGTERM' ? result.signal : INTERRUPT_STATUS[result.status];
  if (!signal) return;
  if (interruptHandler) return interruptHandler(signal);
  console.error(`\n${signal} で中断した。このケースは実行していない。`);
  process.exit(2);
};

/**
 * bm を 1 回呼ぶ。`input` を渡すと stdin から本文を流す（SKILL.md の heredoc と同じ経路）。
 * `--local` を必ず付ける: cloud モードが有効な端末では既定でクラウド側へ流れ、ローカルの一時
 * ディレクトリにファイルが現れず「手順書が壊れている」という誤った FAIL になる。後片付けの
 * `project remove --delete-notes` がクラウドのプロジェクトに当たるのも防ぐ。
 */
function bm(args, input) {
  // 認証待ちやロックで止まってもハーネスごと固まらないよう時間を切る。
  const result = spawnSync('bm', [...args, '--local'], { input, encoding: 'utf8', timeout: BM_TIMEOUT_MS });
  stopIfInterrupted(result);
  // 時間切れで止まるのは bm 本体だけで、孫が残ってロックを握り続けることがある。runSh と同じく、この実行に固有な
  // 使い捨てプロジェクトの名前を引数に持つプロセスを止める。
  if (result.error?.code === 'ETIMEDOUT') spawnSync('pkill', ['-f', PROJECT]);
  if (result.error) throw new Error(`bm ${args.join(' ')}: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * bm の出力から JSON を読む。失敗時は "Error: NOTE_ALREADY_EXISTS" のような行が JSON の前に付くので、
 * 最初の { から読む。JSON でなければ null（throw せず、呼び出し側の status / stderr の check に届かせる）。
 */
function parseBmJson(stdout) {
  const at = (stdout ?? '').indexOf('{');
  if (at === -1) return null;
  try { return JSON.parse(stdout.slice(at)); } catch { return null; }
}

/** bm の JSON 出力を読む。conflict のように終了コードが 0 でない回も JSON を返すので status も渡す。 */
function bmJson(args, input) {
  const run = bm(args, input);
  return { ...run, json: parseBmJson(run.stdout) };
}

// bm が無い端末（新しいクローン・CI）では「手順書が壊れている」ではなく「実行していない」で終わる。
// spawn 自体が失敗する ENOENT も含めてここで拾わないと、bm() の throw がそのまま終了コード 1 になり、
// FAIL と見分けが付かなくなる（docs/harness.md「開発メモリの手順」が終了コード 2 を約束している）。
let version;
try {
  // `bm --version` はトップレベルのフラグしか受けないので、ここだけ --local を付けずに呼ぶ。
  const probe = spawnSync('bm', ['--version'], { encoding: 'utf8', timeout: BM_TIMEOUT_MS });
  if (probe.error) throw new Error(probe.error.message);
  if (probe.status !== 0) throw new Error(probe.stderr || `終了コード ${probe.status}`);
  version = (probe.stdout ?? '').trim();
} catch (error) {
  console.error(`bm CLI を実行できない（${error.message}）。このケースは実行していない。`);
  process.exit(2);
}

// 一時ディレクトリを作る前に、実行できる環境かを確かめる。ここで終えれば片付けるものが無い。
// 身代わりの bm（下記）が exec する本物の場所。解決できないまま進むと、手順書のステップが無関係な exec エラーで
// 落ちる。
const realBm = (spawnSync('sh', ['-c', 'command -v bm'], { encoding: 'utf8', timeout: BM_TIMEOUT_MS }).stdout ?? '').trim();
if (!realBm.startsWith('/')) {
  console.error(`bm の場所を解決できない（command -v bm: ${JSON.stringify(realBm)}）。このケースは実行していない。`);
  process.exit(2);
}
// 手順書のコマンドを流すシェル。エージェントの Bash ツールは本人のシェル（この端末では zsh）で動き、macOS の
// `sh` は bash 3.2 で読み方が違う。どちらでも同じ結果になることを見る。片方でも無ければ、
// 手順書のブロックを回さないまま PASS を記録しないよう、実行していない（終了コード 2）で終える。
// zsh の無い端末（Linux の CI など）では、このケースは常に「実行していない」になる。
const SHELLS = ['sh', 'zsh'];
// zsh は -c でも利用者の起動ファイル（~/.zshenv）を読み、PATH を書き換えて身代わりを外しうるので -f で読ませない。
// -f でもシステムの /etc/zshenv は読まれる。そこで PATH が変わって身代わりが外れた場合は、
// shim-refuses-other-projects が「止めるべき呼び出しを通した」で落とす。
const shellArgs = (shell, script) => (shell === 'zsh' ? ['-f', '-c', script] : ['-c', script]);
// 既定のプロジェクトを決める変数は外す。身代わりが --project を必須にするので効かないが、念のため。
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^BASIC_MEMORY_.*PROJECT/i.test(key)));
// 実際に使う起動のしかた（引数・環境）と同じ形で確かめる。
const missingShells = SHELLS.filter(shell => spawnSync(shell, shellArgs(shell, 'exit 0'), { timeout: 10_000, env: baseEnv }).status !== 0);
if (missingShells.length > 0) {
  console.error(`${missingShells.join('・')} を起動できない。手順書のブロックをこのシェルで確かめられないので、このケースは実行していない。`);
  process.exit(2);
}

// 後片付けの検証に使う。使い捨てプロジェクトを消すついでに他のプロジェクトまで消していないことを見るが、
// mappy-memory が登録されていない端末で FAIL にしないよう、「元々あったか」を先に記録しておく。
// 一覧そのものが読めなかった場合に false へ倒すと、行き過ぎた後片付けの検知が黙って消えるので、
// 「読めなかった」を第 3 の状態として持つ（後片付けの側でそれを FAIL にする）。
// bm() は時間切れで throw する。ここは try の外なので、捕まえないと FAIL（終了コード 1）に見えて JSON も残らない。
let projectsBefore;
try {
  projectsBefore = bmJson(['tool', 'list-projects']);
} catch (error) {
  console.error(`bm tool list-projects を実行できない（${error.message}）。このケースは実行していない。`);
  process.exit(2);
}
const listedBefore = projectsBefore.status === 0 && projectsBefore.json !== null;
const hadMappyMemory = listedBefore
  ? (projectsBefore.json.projects ?? []).some(item => item.name === 'mappy-memory')
  : null;

const root = mkdtempSync(join(tmpdir(), 'mappy-memory-probe-'));
const record = createRecord(root, PROJECT);
record.bmVersion = version;
record.hadMappyMemory = hadMappyMemory;
const runStep = makeStep(record);
// node だけに届いたシグナル（CI のキャンセル、`kill <pid>`）は、イベントループが回るまでハンドラーが動かない。
// ステップはどれも同期の spawnSync なので、ステップの合間に 1 回ループを回して、届いていれば中断に入る。
// 1 つのステップの途中で届いた分は、そのステップが終わるまで待つ。
const step = async (name, fn) => {
  await new Promise(resolve => setImmediate(resolve));
  return runStep(name, fn);
};
const check = makeCheck(record);

const notePath = name => join(root, name);
/** frontmatter だけを返す。取れなければ空文字（本文全体を返すと、本文中の `type: event` で check が通る）。 */
const frontmatterOf = file => {
  const text = readFileSync(file, 'utf8');
  if (!text.startsWith('---\n')) return '';
  const end = text.indexOf('\n---', 4);
  return end === -1 ? '' : text.slice(0, end + 4);
};

const SKILL_PATH = join(repoRoot, '.claude/skills/memory-manager/SKILL.md');
/** SKILL.md の sh コードブロック。実行するケースと `\n` の検査が同じ集合を見るよう、抜き出し方を 1 つにする。 */
const shBlocks = text => [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map(match => match[1]);
const count = (text, needle) => text.split(needle).length - 1;
const said = run => `${run.stdout}${run.stderr}`;
/** 使い捨てプロジェクトに write-note を打つ。`extra` は `--type`・`--overwrite`・`--tags` など。 */
const writeNoteWith = (extra, title, folder, body) => bmJson(
  ['tool', 'write-note', '--project', PROJECT, '--title', title, '--folder', folder, ...extra],
  body,
);
/** search-notes の結果の permalink の一覧。 */
const permalinksOf = out => (out.json?.results ?? []).map(item => item.permalink);

/**
 * 手順書のコマンドを実行するときの身代わりの `bm`。`PATH` の先頭に置き、`tool` のサブコマンドで、使い捨て
 * プロジェクトを `--project` と `--local` で 1 回だけ指し、`mappy-memory` そのものを引数に持たない呼び出しだけを
 * 本物へ渡し、それ以外は終了コード 97 で止める。抜き出したコマンドの
 * 文字列を検査するだけでは、環境変数や書き方の違いで本物の mappy-memory に当たる形を網羅できない
 * 。`basic-memory` の名前で呼ぶ形も同じく止める。
 */
const shimDir = mkdtempSync(join(tmpdir(), 'mappy-memory-shim-'));
writeFileSync(join(shimDir, 'bm'), [
  '#!/bin/sh',
  '# memory-procedure.mjs が作る身代わり。使い捨てプロジェクト以外への呼び出しを本物へ渡さない。',
  "projects=0; ok=0; state=0",
  '# project の登録・削除などは手順書の対象外。tool のサブコマンドだけを通す。',
  '[ "$1" = tool ] || { echo "memory-procedure shim: bm $1 は使えない" >&2; exit 97; }',
  '# `--project <使い捨て> --local` がこの順に連続して 1 回だけ並ぶことを求める。値として渡した `--local` は',
  '# この並びにならないので local と数えない。値を取るオプションを列挙しないので、値が偶然フラグの形',
  '# （`-p…`・`--cloud`・`mappy-memory`）でも止める側に倒れる（本物へは渡らない）。',
  'for arg in "$@"; do',
  '  case "$arg" in',
  '    --project-id|--project-id=*|--project=*|--cloud|-p*) echo "memory-procedure shim: $arg は使えない" >&2; exit 97 ;;',
  '    mappy-memory) echo "memory-procedure shim: 引数に mappy-memory がある" >&2; exit 97 ;;',
  '    --project) projects=$((projects + 1)) ;;',
  '  esac',
  '  if [ "$state" = 2 ]; then',
  '    [ "$arg" = --local ] && ok=1; state=0',
  '  elif [ "$state" = 1 ]; then',
  `    if [ "$arg" = '${PROJECT}' ]; then state=2; else state=0; fi`,
  '  elif [ "$arg" = --project ]; then',
  '    state=1',
  '  fi',
  'done',
  'if [ "$projects" != 1 ] || [ "$ok" != 1 ]; then',
  '  echo "memory-procedure shim: 使い捨てプロジェクト以外への呼び出しを止めた: $*" >&2; exit 97',
  'fi',
  `exec '${realBm}' "$@"`,
  '',
].join('\n'), { mode: 0o755 });
writeFileSync(join(shimDir, 'basic-memory'), '#!/bin/sh\necho "memory-procedure shim: basic-memory は使えない" >&2\nexit 97\n', { mode: 0o755 });
const shEnv = { ...baseEnv, PATH: `${shimDir}:${process.env.PATH ?? ''}` };

/**
 * 手順書のコマンドをシェルで実行する。bm が認証やロックで止まってもハーネスごと固まらないよう時間を切り、
 * sh 自体を起動できなかったときも原因が失敗メッセージに出るようにする。
 */
const runSh = (script, shell = 'sh') => {
  // 複数のコマンドからなるブロック（lessons の read-note と edit-note）で、前のコマンドの失敗が最後のコマンドの
  // 成功に隠れないよう、最初の失敗で止める。
  const run = spawnSync(shell, shellArgs(shell, `set -e\n${script}`), { encoding: 'utf8', timeout: BM_TIMEOUT_MS, env: shEnv });
  stopIfInterrupted(run);
  // 時間切れで止まるのは sh だけで、孫の bm は残ってロックを握り続ける。使い捨てプロジェクトの名前は
  // この実行に固有なので、その名前を引数に持つプロセスだけを止める。
  if (run.error?.code === 'ETIMEDOUT') spawnSync('pkill', ['-f', PROJECT]);
  return { ...run, why: run.error ? String(run.error) : (run.stderr || run.stdout) };
};

// 差し込み口に入れる本文。シェルが展開しうる文字を並べ、手順書の渡し方がそれを素通しするかを見る。
// 対になっていない文字も入れる。対の文字だけだと、bash 3.2 がコマンド置換の中の heredoc を読み違える形を
// 見逃した。`'` は手順書の規則どおり `'\''` にして差し込む。
const TRICKY = "`append と $HOME と \"二重 と 1) と it's と \\n";
const trickyInSingleQuotes = TRICKY.replaceAll("'", () => "'\\''");

/**
 * SKILL.md のコードブロックのうち `select` を含むものを 1 つ抜き出し、`replacements` の順に差し替え、
 * project を使い捨てのものに差し替えて返す。差し替えが効いたことを正の条件で確かめ、それ以外は null を返して
 * 実行させない。実行時は runSh の身代わりの bm も同じ条件で止めるので、ここは早く・分かりやすく
 * 落とすための 1 段目。`stale` は差し替え後に残っていてはいけない当て先（本物の permalink）。
 */
const documentedScript = (select, replacements, stale) => {
  const blocks = shBlocks(readFileSync(SKILL_PATH, 'utf8')).filter(block => block.includes(select));
  check(blocks.length === 1, `SKILL.md に「${select}」を含むコードブロックが 1 つでない: ${blocks.length} 個`);
  if (blocks.length !== 1) return null;
  const absent = replacements.filter(([from]) => !blocks[0].includes(from)).map(([from]) => from);
  let script = blocks[0];
  for (const [from, to] of replacements) script = script.replaceAll(from, () => to);
  script = script.replaceAll('--project mappy-memory', `--project ${PROJECT} --local`);
  const rest = script.replaceAll(PROJECT, '');
  // 呼び出しの数は、行頭が `#` の行（sh のコメントと、本文の見出し）を除いて数える。
  const code = script.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
  const calls = count(code, 'bm ');
  const problems = [
    absent.length > 0 && `差し替える箇所が無い: ${absent.join(', ')}`,
    calls === 0 && 'bm の呼び出しが無い',
    count(code, `--project ${PROJECT} --local`) !== calls && `bm の呼び出し ${calls} 個のうち、使い捨てプロジェクトへ向いていないものがある`,
    /mappy-memory/.test(rest) && 'mappy-memory が残っている',
    /(^|\s)-p|--project=|--project-id|--cloud/.test(script) && '--project 以外の形で project を指定している（--project-id は --project より優先される）',
    /basic-memory|BASIC_MEMORY/.test(rest) && 'bm 以外の名前か環境変数で Basic Memory を指している',
    count(code, 'tool ') !== count(code, 'bm tool ') && 'bm tool 以外の形で tool を呼んでいる',
    stale && stale.test(script) && `当て先が ${stale.source} のまま`,
  ].filter(Boolean);
  check(problems.length === 0, `抜き出したコマンドを使い捨てプロジェクトへ向けられない（${problems.join(' / ')}）: ${script}`);
  return problems.length === 0 ? script : null;
};

let added = false;
/** 使い捨てプロジェクトが bm に登録されているか（project add の途中で止まったときに使う）。 */
const isRegistered = () => (spawnSync('bm', ['tool', 'list-projects', '--local'], { encoding: 'utf8', timeout: BM_TIMEOUT_MS }).stdout ?? '').includes(PROJECT);
// project add の最中に中断されると、bm が登録を終えていても added はまだ false。そのときは一覧で確かめて消す。
let adding = false;

// Ctrl-C で中断しても、使い捨てプロジェクトを bm のグローバル設定に残さない。finally は届かない。
// 子の終わり方から呼ぶ経路（stopIfInterrupted）と、node 自身へのシグナルの経路があるので、1 回だけ動かす。
let interruptHandled = false;
const onInterrupt = signal => {
  if (interruptHandled) return;
  interruptHandled = true;
  // 片付けが成功したかを確かめてから言う。失敗したら消し方を出す。
  const registered = added || (adding && isRegistered());
  const removed = registered && !keep
    ? spawnSync('bm', ['project', 'remove', PROJECT, '--delete-notes', '--local'], { encoding: 'utf8', timeout: BM_TIMEOUT_MS })
    : null;
  if (!keep && existsSync(root)) rmSync(root, { recursive: true, force: true });
  rmSync(shimDir, { recursive: true, force: true });
  // --keep と、プロジェクトを作る前の中断を「片付けた」と言わない。
  const outcome = keep
    ? `--keep なので残した（${root}）。手で消す: bm project remove ${PROJECT} --delete-notes --local`
    : !registered ? 'プロジェクトを作る前だった。一時ディレクトリは消した。'
      : removed.status === 0 ? '使い捨てプロジェクトは片付けた。'
        : `使い捨てプロジェクトを消せなかった。手で消す: bm project remove ${PROJECT} --delete-notes --local`;
  if (jsonPath) {
    record.passed = false;
    record.failures.push(`${signal} で中断した（実行していない）`);
    record.interrupted = { signal, keep, registered, projectRemoved: removed === null ? null : removed.status === 0 };
    try { writeFileSync(jsonPath, `${JSON.stringify(record, null, 2)}\n`); } catch { /* 書けなくても終了コード 2 で終える */ }
  }
  console.error(`\n${signal} で中断した。${outcome}`);
  process.exit(2);
};
interruptHandler = onInterrupt;
process.on('SIGINT', () => onInterrupt('SIGINT'));
process.on('SIGTERM', () => onInterrupt('SIGTERM'));

try {
  // 0. 手順書の文面の検査。bm を使わないので最初に回し、文面だけの壊れ方をすぐ落とす。
  //    ここより後は bm の挙動しか見ておらず、手順書を旧「方法A」に書き戻しても全部 PASS する。
  //    手順書の側にも当て、書いてあるはずの形が消えていないことを確かめる（レビュー指摘）。
  await step('documents-still-say-it', () => {
    const skill = readFileSync(SKILL_PATH, 'utf8');
    const agents = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');
    const missing = [];
    const want = (text, needle, where) => { if (!text.includes(needle)) missing.push(`${where}: ${needle}`); };
    want(skill, 'permalink: {カテゴリ}/{英語スラッグ}', 'SKILL.md');
    want(skill, 'type: {カテゴリの単数形}', 'SKILL.md');
    want(skill, '--operation append', 'SKILL.md');
    want(skill, '--overwrite', 'SKILL.md');
    // corrections は append ではなく行頭の `## Relations` の前に差し込む（LEV-192。旧手順は replace_section で重複した）。
    // 実際の改行を含む目印そのものは、documented-inbox-entry がコードブロックを実行して確かめる。
    want(skill, "--operation find_replace --find-text '\n## Relations\n'", 'SKILL.md');
    want(agents, 'bm tool read-note corrections/lessons --project mappy-memory', 'AGENTS.md');
    want(agents, 'bm tool edit-note corrections/inbox --project mappy-memory --operation find_replace', 'AGENTS.md');
    want(agents, '**行頭の** `## Relations`', 'AGENTS.md');
    // --overwrite が当たるのはタイトルから決まるパスだけで、既存の書き換えは edit-note（LEV-192）。
    want(skill, '{folder}/{title}.md', 'SKILL.md');
    want(agents, '{folder}/{title}.md', 'AGENTS.md');
    want(skill, '`write-note` は新規専用', 'SKILL.md');
    want(agents, '`write-note` は新規専用', 'AGENTS.md');
    want(agents, '過去の記録が消え', 'AGENTS.md');
    // inbox の `## 未蒸留` を replace_section で狙う旧手順は、既存のエントリを重複させる（LEV-192）。
    // クォートの種類や `=` 付きを問わない。
    const sectionUnprocessed = /--section[ =]["']?## 未蒸留/;
    check(!sectionUnprocessed.test(skill), 'SKILL.md に inbox への replace_section が戻っている（LEV-192）');
    check(!sectionUnprocessed.test(agents), 'AGENTS.md に inbox への replace_section が戻っている（LEV-192）');
    // bm は引数の `\n` を改行にしないので、コマンドに書くと見出しが 1 行に潰れる（LEV-192）。
    // 引数の形（--content / --find-text、クォートの種類、`=` 付き）を問わず、コマンドの中に `\n` が無いことを見る。
    // コマンド = SKILL.md の sh ブロックと、bm のサブコマンドを含むインラインコード。説明文の `\n` は対象外。
    const commandsOf = text => [
      ...shBlocks(text),
      // インラインコードは CommonMark と同じく「同じ長さのバッククォートの並びで閉じる」で切り出す。
      // `` `x` `` の中のバッククォートで組み違えると、その後ろのコマンドを見落とす。
      // コードブロックは上で見ているので、先に取り除く（```` ``` ```` をインラインの区切りと読み違えないように）。
      // CommonMark のコードスパンは段落をまたがないので、空行の手前で打ち切る。
      ...[...text.replace(/^```[\s\S]*?^```/gm, '').matchAll(/(?<!`)(`+)(?!`)((?:(?!\n[ \t]*\n)[\s\S])*?[^`])\1(?!`)/g)].map(match => match[2])
        // サブコマンド名を含まない断片（`--title "…" --overwrite` など）も、長いオプションがあればコマンドとして見る。
        .filter(span => /edit-note|write-note|search-notes|(^|\s)--[a-z]/.test(span)),
    ];
    const commands = [...commandsOf(skill).map(c => ['SKILL.md', c]), ...commandsOf(agents).map(c => ['AGENTS.md', c])];
    const escaped = commands
      .filter(([, command]) => command.includes('\\n'));
    check(escaped.length === 0, `コマンドの中に \\n が戻っている（改行にならない）: ${escaped.map(([where, command]) => `${where}: ${command.slice(0, 80)}`).join(' / ')}`);
    // 前提と崩れる条件（AGENTS.md「回避策が成り立つ前提と崩れる条件を書く」）。
    want(skill, 'この手順が成り立つ前提', 'SKILL.md');
    want(skill, "--operation find_replace --find-text '\n## 手順\n'", 'SKILL.md');
    // 本文を二重引用符やコマンド置換の heredoc で渡す形は、シェルが本文を書き換える。
    // 対象は corrections に限らない。一般の追記手順も同じ危険がある。
    // 空白の数や行の継続（`\` ＋改行）を挟んでも拾う。
    const doubleQuoted = commands
      // `--content='…'` は安全なので拾わない。`--section` も同じ危険があるので見る。
      .filter(([, command]) => /--(content|find-text|section|title|folder|tags|permalink)(\s|\\\n)*(=\s*)?"|search-notes "|\$\(cat/.test(command));
    check(doubleQuoted.length === 0, `本文か目印を二重引用符かコマンド置換で渡すコマンドが戻っている: ${doubleQuoted.map(([where, command]) => `${where}: ${command.slice(0, 80)}`).join(' / ')}`);
    check(missing.length === 0, `手順書から必須の記述が消えている: ${missing.join(' / ')}`);
    // 旧「方法B」の heredoc をファイルへ書く形は、フック拒否を踏むので戻さない（LEV-184 指摘 6）。
    // 相対パス宛（`cat > memory/...`）も同じなので、リダイレクト先を問わず見る。
    check(!/cat >[^>]/.test(skill), 'SKILL.md にファイルへの heredoc 書き込みが戻っている（LEV-184 指摘 6）');
    // 公開リポジトリなので個人の絶対パスを置かない（LEV-184 指摘 7）。
    check(!skill.includes('/Users/'), 'SKILL.md に個人の絶対パスが戻っている（LEV-184 指摘 7）');
    return { missing };
  });
  await step('project-add', () => {
    adding = true;
    const run = bm(['project', 'add', PROJECT, root]);
    added = run.status === 0;
    adding = false;
    check(added, `使い捨てプロジェクトを作れない: ${run.stderr || run.stdout}`);
    return { status: run.status, path: root };
  });
  if (!added) throw new Error('プロジェクトを作れなかったので以降は実行しない');

  // 1. permalink と type を省いた write-note が、何を既定に落とすか（SKILL.md「frontmatter の permalink と type」）。
  //    日本語タイトルなのでスラッグ崩れと前置が同時に起きる。原因の切り分けはステップ 1b で行う。
  let droppedPermalink = '';
  await step('defaults-drop-permalink-and-type', () => {
    const title = '2026-09-22 既定の確認';
    const out = writeNoteWith(['--tags', 'probe'], title, 'events', '# 既定の確認\n\n## Observations\n- [tech] permalink と type を省いた #probe\n',
    );
    droppedPermalink = out.json?.permalink ?? '';
    const file = notePath(`events/${title}.md`);
    const front = existsSync(file) ? frontmatterOf(file) : '';
    // 意図した英語スラッグでは引けない ＝ 日本語タイトルのノートは permalink を予測できない。
    const guess = bmJson(['tool', 'read-note', 'events/2026-09-22-defaults', '--project', PROJECT]);
    check(out.status === 0, `write-note が失敗した: ${out.stderr}`);
    check(droppedPermalink.startsWith(`${PROJECT}/`), `permalink にプロジェクト名が前置されなかった: ${droppedPermalink}`);
    check(/^type: note$/m.test(front), `type が既定の note にならなかった: ${front}`);
    // 引けなかったことを見る前に、read-note 自体が答えを返したことを確かめる（JSON が無ければ何も確かめていない）。
    check(guess.status === 0 && guess.json !== null, `予測した英語スラッグの read-note が答えを返さなかった: [${guess.status}] ${guess.stderr}`);
    check(guess.json?.permalink == null, `予測した英語スラッグで引けてしまった（スラッグは崩れていない）: ${guess.json?.permalink}`);
    return { permalink: droppedPermalink, type: front.match(/^type: (.+)$/m)?.[1] };
  });

  // 1b. 原因の切り分け（レビュー指摘）。前置「だけ」なら read-note と [[wiki link]] は当たり、
  //     外れるのは --permalink のグロブだけ。手順書はこの 2 つを別々の理由として書いている。
  await step('prefix-alone-does-not-break-read-note', () => {
    const out = writeNoteWith([], 'Probe Ascii Title', 'events', '# Probe Ascii Title\n\n## Observations\n- [tech] permalink だけ省いた #probe\n',
    );
    // 対照。グロブが何も拾わなくなった場合に「前置を外している」と読み違えないよう、拾う側も同じ回で作る。
    const target = writeNoteWith([], 'Probe Glob Target', 'events', '---\npermalink: events/probe-glob-target\n---\n\n# Probe Glob Target\n',
    );
    const permalink = out.json?.permalink ?? '';
    const byWish = bmJson(['tool', 'read-note', 'events/probe-ascii-title', '--project', PROJECT]);
    const glob = bmJson(['tool', 'search-notes', '--permalink', 'events/*', '--project', PROJECT]);
    const globHits = permalinksOf(glob);
    check(permalink === `${PROJECT}/events/probe-ascii-title`, `前置された permalink にならなかった: ${permalink}`);
    check(byWish.json?.permalink === permalink, `前置されただけのノートが {カテゴリ}/{スラッグ} で読めない: ${byWish.stderr}`);
    check(target.json?.permalink === 'events/probe-glob-target', `対照ノートを作れなかった: ${target.stderr}`);
    check(globHits.includes('events/probe-glob-target'), `--permalink "events/*" が前置なしのノートを拾わない: ${globHits.join(', ')}`);
    check(!globHits.includes(permalink), `--permalink "events/*" が前置されたノートを拾った: ${globHits.join(', ')}`);
    return { permalink, readBy: byWish.json?.permalink, globHits };
  });

  // 1c. 手順書のコマンドを実行する前に、身代わりの bm が使い捨てプロジェクト以外への呼び出しを止めることを確かめる。
  //     止めるべき呼び出しは本物に届かない。万一届いても、存在しないノートの read-note（読むだけ）にしてある。
  await step('shim-refuses-other-projects', () => {
    const probe = 'events/shim-probe-not-a-note';
    const refused = [
      `bm tool read-note ${probe} --project mappy-memory --local`,
      `bm tool read-note ${probe} --project ${PROJECT}`,
      `bm tool read-note ${probe} -p ${PROJECT} --local`,
      `bm tool read-note ${probe} --project=${PROJECT} --local`,
      `bm tool read-note ${probe} --project ${PROJECT} --project mappy-memory --local`,
      `bm tool read-note ${probe} --project-id 00000000 --project ${PROJECT} --local`,
      `bm tool read-note ${probe} --project ${PROJECT} --local --cloud`,
      `basic-memory tool read-note ${probe}`,
      `bm project list --project ${PROJECT} --local`,
      `bm tool read-note mappy-memory --project ${PROJECT} --local`,
      `bm tool read-note ${probe} --project ${PROJECT} --local -pother`,
      // 値として渡した `--local` は local フラグにならない。
      `bm tool edit-note ${probe} --project ${PROJECT} --operation append --content --local`,
      `bm tool search-notes x --project ${PROJECT} --page --local`,
      `bm tool read-note ${probe} --local --project ${PROJECT}`,
    ];
    // 手順書のブロックを流すすべてのシェルで確かめる。
    const results = {};
    for (const shell of SHELLS) {
      const runs = refused.map(command => [command, runSh(command, shell)]);
      const passed = runSh(`bm tool read-note ${probe} --project ${PROJECT} --local`, shell);
      const leaks = runs.filter(([, run]) => run.status !== 97).map(([command, run]) => `[${run.status}] ${command}`);
      check(leaks.length === 0, `[${shell}] 身代わりの bm が止めるべき呼び出しを通した: ${leaks.join(' / ')}`);
      // 本物の bm に届いたことを見る。97 以外なら良い、では exec の失敗（126/127）も通る。
      check(passed.status === 0 && parseBmJson(passed.stdout) !== null, `[${shell}] 身代わりの bm が使い捨てプロジェクトへの呼び出しを本物へ渡さなかった: [${passed.status}] ${passed.why}`);
      results[shell] = { refused: runs.map(([, run]) => run.status), passed: passed.status };
    }
    return results;
  });

  // 2. SKILL.md の推奨手順そのもの（stdin + frontmatter の permalink / type）。「新しいノートを作る」の
  //    コードブロックを抜き出し、差し込み口だけを埋めてシェルで実行する。
  await step('documented-write-note', () => {
    // タイトルにもシェルが展開しうる文字を入れる（ファイル名に使えない `/` と `:` は除く）。本文には TRICKY を入れる。
    const title = "2026-09-22 推奨 `x $HOME \"q 1) it's";
    const script = documentedScript('bm tool write-note --project mappy-memory', [
      ['{YYYY-MM-DD タイトル}', title.replaceAll("'", () => "'\\''")],
      ['{カテゴリの単数形}', 'event'],
      ['{英語スラッグ}', 'probe-documented-write'],
      ['{カテゴリ}', 'events'],
      ['{タグ1},{タグ2}', 'probe,mappy'],
      ['{番号}', '184'],
      ['- [category] 内容', `- [tech] PROBEWRITETOKEN ${TRICKY}`],
    ]);
    if (script === null) return { script };
    const results = {};
    // bm はタイトルの記号をファイル名から落とすので、ファイルの場所は bm が返す file_path から引く。
    let file = '';
    for (const [index, shell] of SHELLS.entries()) {
      // 同じタイトルの 2 回目は NOTE_ALREADY_EXISTS になるので、前のシェルで作ったノートを消してから打つ。
      // 最後のシェルで作ったノートは、下の indexed-without-reindex・search-by-type が使う。
      // 前のシェルで作れていなければ（その失敗は記録済み）、消すものは無い。
      if (index > 0 && file !== '' && existsSync(file)) {
        const removed = bm(['tool', 'delete-note', 'events/probe-documented-write', '--project', PROJECT]);
        check(removed.status === 0 && !existsSync(file), `[${shell}] 前のシェルで作ったノートを消せなかった: ${removed.stderr}`);
      }
      const run = runSh(script, shell);
      const json = parseBmJson(run.stdout);
      file = json?.file_path ? notePath(json.file_path) : '';
      const written = file !== '' && existsSync(file);
      const front = written ? frontmatterOf(file) : '';
      check(run.status === 0, `[${shell}] heredoc 版の write-note が失敗した: ${run.why}`);
      check(json?.permalink === 'events/probe-documented-write', `[${shell}] permalink が明示した値にならなかった: ${json?.permalink}`);
      check(json?.title === title, `[${shell}] タイトルがシェルに書き換えられた（引数のシングルクォートが素通しされない）: ${JSON.stringify(json?.title)}`);
      check(written && readFileSync(file, 'utf8').includes(`PROBEWRITETOKEN ${TRICKY}`), `[${shell}] 本文が heredoc の中で書き換えられた`);
      check(/^type: event$/m.test(front), `[${shell}] type が event にならなかった: ${front}`);
      results[shell] = { permalink: json?.permalink, action: json?.action };
    }
    return results;
  });

  // 3. reindex 無しで、書いた直後に読めて検索できること（SKILL.md「書き込み」の「bm reindex は要らない」）。
  await step('indexed-without-reindex', () => {
    const read = bmJson(['tool', 'read-note', 'events/probe-documented-write', '--project', PROJECT]);
    const found = bmJson(['tool', 'search-notes', 'PROBEWRITETOKEN', '--project', PROJECT]);
    const hits = permalinksOf(found);
    check(read.json?.permalink === 'events/probe-documented-write', `{カテゴリ}/{スラッグ} で read-note できない: ${read.stderr}`);
    check(hits.includes('events/probe-documented-write'), `reindex 無しで検索に出ない: ${hits.join(', ')}`);
    return { read: read.json?.permalink, hits };
  });

  // 4. type を明示したノートだけが --type で引けること（指摘 3 の回帰）。
  await step('search-by-type', () => {
    const out = bmJson(['tool', 'search-notes', '--type', 'event', '--project', PROJECT]);
    const hits = permalinksOf(out);
    check(hits.includes('events/probe-documented-write'), `type: event のノートが --type event で出ない: ${hits.join(', ')}`);
    // permalink の形ではなく、ステップ 1 で type を落としたノートそのものが混ざっていないかを見る。
    // ステップ 1 で permalink を取れなかったら、否定側の検査は空文字の検査になって何も確かめない。飛ばしたことを残す。
    check(droppedPermalink !== '', 'ステップ 1 のノートの permalink が取れていないので、type を落としたノートが混ざらないことを確かめられない');
    if (droppedPermalink !== '') check(!hits.includes(droppedPermalink), `type を落としたノート（${droppedPermalink}）が --type event に混ざった: ${hits.join(', ')}`);
    return { hits };
  });

  // 5. 積み上げるノート: 2 回目の write-note は何も書かず、--overwrite は過去の記録を消し、append は残す。
  await step('inbox-create', () => {
    const out = writeNoteWith(['--type', 'correction'], 'Correction Inbox', 'corrections', '---\npermalink: corrections/inbox\n---\n\n# Correction Inbox\n\n## 2026-09-20\n- 既存の記録1\n',
    );
    check(out.status === 0, `inbox を作れない: ${out.stderr}`);
    return { permalink: out.json?.permalink, action: out.json?.action };
  });

  await step('second-write-note-writes-nothing', () => {
    const before = readFileSync(notePath('corrections/Correction Inbox.md'), 'utf8');
    const out = writeNoteWith(['--type', 'correction'], 'Correction Inbox', 'corrections', '---\npermalink: corrections/inbox\n---\n\n# Correction Inbox\n\n## 2026-09-22\n- 新しい記録2\n',
    );
    const after = readFileSync(notePath('corrections/Correction Inbox.md'), 'utf8');
    check(out.status !== 0, '2 回目の write-note が終了コード 0 で通った');
    check(out.json?.action === 'conflict', `action が conflict でない: ${out.json?.action}`);
    check(out.json?.file_path === null, `file_path が null でない: ${out.json?.file_path}`);
    check(before === after, '2 回目の write-note がノートを書き換えた');
    return { status: out.status, action: out.json?.action, error: out.json?.error };
  });

  await step('overwrite-loses-history', () => {
    const out = writeNoteWith(['--type', 'correction', '--overwrite'], 'Correction Inbox', 'corrections', '---\npermalink: corrections/inbox\n---\n\n# Correction Inbox\n\n## 2026-09-22\n- 新しい記録2\n',
    );
    const text = readFileSync(notePath('corrections/Correction Inbox.md'), 'utf8');
    check(out.status === 0, `--overwrite が失敗した: ${out.stderr}`);
    check(!text.includes('既存の記録1'), '--overwrite が過去の記録を残した（SKILL.md の警告が古い）');
    return { action: out.json?.action, keptHistory: text.includes('既存の記録1') };
  });

  await step('append-keeps-history', () => {
    // 下準備。ここが失敗すると、下の「append が過去の記録を消した」が事実と違う理由で落ちる。
    const restored = writeNoteWith(['--type', 'correction', '--overwrite'], 'Correction Inbox', 'corrections', '---\npermalink: corrections/inbox\n---\n\n# Correction Inbox\n\n## 2026-09-20\n- 既存の記録1\n',
    );
    check(restored.status === 0, `下準備（過去の記録を書き戻す --overwrite）が失敗した: ${restored.stderr}`);
    const out = bmJson([
      'tool', 'edit-note', 'corrections/inbox', '--project', PROJECT,
      '--operation', 'append', '--content', '\n## 2026-09-22\n- 新しい記録2 PROBEAPPENDTOKEN\n',
    ]);
    const text = readFileSync(notePath('corrections/Correction Inbox.md'), 'utf8');
    const found = bmJson(['tool', 'search-notes', 'PROBEAPPENDTOKEN', '--project', PROJECT]);
    const hits = permalinksOf(found);
    check(out.status === 0, `edit-note --operation append が失敗した: ${out.stderr}`);
    check(text.includes('既存の記録1'), 'append が過去の記録を消した');
    check(text.includes('新しい記録2'), 'append した内容が入っていない');
    check(hits.includes('corrections/inbox'), `append の直後に reindex 無しで検索に出ない: ${hits.join(', ')}`);
    return { operation: out.json?.operation, keptHistory: text.includes('既存の記録1'), hits };
  });

  // 6. 未作成の permalink への append は、エラーにならず「プロジェクト名を前置したノート」を黙って作る。
  //    AGENTS.md と SKILL.md が「無ければ write-note で作る」と書いている根拠。
  await step('append-to-missing-creates-prefixed-note', () => {
    const out = bmJson([
      'tool', 'edit-note', 'corrections/not-created-yet', '--project', PROJECT,
      '--operation', 'append', '--content', '追記\n',
    ]);
    check(out.json?.fileCreated === true, `未作成の permalink への append が新規作成にならなかった: ${JSON.stringify(out.json)}`);
    check(
      out.json?.permalink === `${PROJECT}/corrections/not-created-yet`,
      `未作成の permalink への append がプロジェクト名を前置しなかった: ${out.json?.permalink}`,
    );
    bm(['tool', 'delete-note', `${PROJECT}/corrections/not-created-yet`, '--project', PROJECT]);
    // replace_section は append と違い、find_replace と同じく Entity not found で止まり、何も作らない。
    // 以前の手順書は「append や replace_section は作る」と書いていたが、ケースを足したら違った。
    const section = bmJson([
      'tool', 'edit-note', 'corrections/not-created-for-section', '--project', PROJECT,
      '--operation', 'replace_section', '--section', '## 未蒸留', '--content', '追記\n',
    ]);
    const sectionSaid = said(section);
    const sectionLeaked = bmJson(['tool', 'read-note', `${PROJECT}/corrections/not-created-for-section`, '--project', PROJECT]);
    check(section.status === 1 && sectionSaid.includes('Entity not found'), `未作成の permalink への replace_section が「Entity not found」の終了コード 1 で止まらなかった（手順書が古い）: [${section.status}] ${sectionSaid}`);
    check(sectionLeaked.status === 0 && sectionLeaked.json !== null, `作られていないことを確かめる read-note が答えを返さなかった: [${sectionLeaked.status}] ${sectionLeaked.stderr}`);
    check(!existsSync(notePath('corrections/not-created-for-section.md')) && sectionLeaked.json?.file_path == null, '未作成の permalink への replace_section がノートを作った（手順書が古い）');
    return { permalink: out.json?.permalink, fileCreated: out.json?.fileCreated, sectionStatus: section.status };
  });

  // 6b. 手順書は `--content '{追記する本文}'` と書いており、先頭に改行を置かせていない。積み上げるノートは
  //     この形で何度も呼ばれるので、append が自分で改行を入れることに寄りかかっている。続けて 2 回打って
  //     別の行に入ることを固定する（append の癖そのものの固定。corrections には append を使わない —— 6c）。
  await step('repeated-append-does-not-glue-lines', () => {
    const write = content => bmJson([
      'tool', 'edit-note', 'corrections/inbox', '--project', PROJECT,
      '--operation', 'append', '--content', content,
    ]);
    const first = write('- 追記A');
    const second = write('- 追記B');
    const text = readFileSync(notePath('corrections/Correction Inbox.md'), 'utf8');
    check(first.status === 0 && second.status === 0, `連続した append が失敗した: ${first.stderr} / ${second.stderr}`);
    check(/^- 追記A$/m.test(text), `1 回目の追記が単独の行にならなかった: ${JSON.stringify(text.slice(-80))}`);
    check(/^- 追記B$/m.test(text), `2 回目の追記が前の行に癒着した: ${JSON.stringify(text.slice(-80))}`);
    return { tail: text.slice(-40) };
  });

  // 6c. 実物の corrections/inbox・lessons は末尾が `## Relations` で、追記先の節はその上にある。
  //     append は必ずファイル末尾に足すので、この形のノートでは Relations の後ろに落ちる。
  //     手順書が corrections に append を禁じている理由と、lessons に replace_section を使わない理由を固定する。
  const inboxShape = [
    '---', 'permalink: corrections/shape', '---', '',
    '# Correction Inbox', '', '## 未蒸留', '', '### 2026-09-20 既存のミス', '- 内容', '',
    '## Relations', '- distilled_into [[Correction Lessons]]', '',
  ].join('\n');
  await step('append-lands-after-relations-flat-replace-section-wipes', () => {
    const shapeFile = notePath('corrections/Correction Shape.md');
    // (a) append はファイル末尾 ＝ Relations の後ろ。inbox の形（`###` で区切られた節）への replace_section は 6d で固定する。
    const made = writeNoteWith(['--type', 'correction'], 'Correction Shape', 'corrections', inboxShape,
    );
    check(made.status === 0, `下準備 (a)（inbox の形のノート）を作れなかった: ${made.stderr}`);
    const appendRun = bmJson(['tool', 'edit-note', 'corrections/shape', '--project', PROJECT, '--operation', 'append', '--content', '### 2026-09-22 新しいミス']);
    check(appendRun.status === 0, `(a) の append が失敗した: ${appendRun.stderr}`);
    const appended = readFileSync(shapeFile, 'utf8');
    const afterRelations = appended.indexOf('### 2026-09-22 新しいミス') > appended.indexOf('## Relations');
    check(afterRelations, 'append が Relations より前に入った（手順書が corrections に append を禁じている理由が消えている）');

    // (b) 節の中身が平らなリスト（lessons の形）だと replace_section は節ごと置き換える。
    //     手順書が「lessons には使わない」と書いている根拠。
    const flatMade = writeNoteWith(['--type', 'correction'], 'Correction Flat', 'corrections', '---\npermalink: corrections/flat\n---\n\n# Correction Flat\n\n## 道具の癖\n\n1. 既存の教訓1\n2. 既存の教訓2\n\n## Relations\n- originated_from [[Correction Inbox]]\n',
    );
    check(flatMade.status === 0, `下準備 (b)（lessons の形のノート）を作れなかった: ${flatMade.stderr}`);
    const flatRun = bmJson([
      'tool', 'edit-note', 'corrections/flat', '--project', PROJECT,
      '--operation', 'replace_section', '--section', '## 道具の癖', '--content', '3. 新しい教訓3',
    ]);
    check(flatRun.status === 0, `(b) の replace_section が失敗した: ${flatRun.stderr}`);
    const flat = readFileSync(notePath('corrections/Correction Flat.md'), 'utf8');
    check(!flat.includes('既存の教訓1'), 'replace_section が平らなリストを残した（手順書の警告が古い）');
    return { afterRelations, flatKeptHistory: flat.includes('既存の教訓1') };
  });

  // 6d. 実物の inbox と同じ形（見出しの直後に空行なしで `###` が続き、既存が 2 件）で、`## 未蒸留` への
  //     書き込みがどうなるかを固定する（LEV-192）。旧手順の「replace_section で入れる」は、置き換わるのが
  //     見出しから最初の `###` の手前まで（空の範囲）なので、既存＋新規の全文を渡すと既存が必ず重複する。
  //     2026-09-23 に 2 回、実際に重複した。
  const realInbox = [
    '---', 'permalink: corrections/real-inbox', '---', '',
    '# Correction Real Inbox', '', 'ミスをした直後にここへ書く。', '', '## 未蒸留',
    '### 2026-09-20 既存A', '- 内容A', '', '### 2026-09-21 既存B', '- 内容B', '',
    '## Relations', '- distilled_into [[Correction Lessons]]', '',
  ].join('\n');
  // エントリの本文が見出しを引用している形。この手順についての記録は自然にこうなる。
  // 見出しで始まるだけの行（`## Relations の…`）も入れる。手順書は、目印がそれだけの行にしか当たらないと書いている。
  const quotingInbox = realInbox.replace('- 内容A', '- 内容A: 末尾が `## Relations` なので append は後ろに落ちる\n## Relations の書き方は SKILL.md を見る');
  // 手順書の目印そのもの（改行＋見出し＋改行）。(c')・(d)・(f) もこれで打つ。
  const MARK = '\n## Relations\n';
  const realInboxFile = notePath('corrections/Correction Real Inbox.md');
  const resetRealInbox = (content = realInbox) => writeNoteWith(['--type', 'correction', '--overwrite'], 'Correction Real Inbox', 'corrections', content,
  );
  const editRealInbox = args => bmJson(['tool', 'edit-note', 'corrections/real-inbox', '--project', PROJECT, ...args]);

  await step('inbox-replace-section-duplicates-find-replace-does-not', () => {
    // (a) 旧手順を踏んだ回と同じ: 既存＋新規の全文を replace_section に渡す → 既存が重複する。
    check(resetRealInbox().status === 0, '下準備 (a)（inbox の形のノート）を作れなかった');
    const fullRun = editRealInbox([
      '--operation', 'replace_section', '--section', '## 未蒸留',
      '--content', '### 2026-09-20 既存A\n- 内容A\n\n### 2026-09-21 既存B\n- 内容B\n\n### 2026-09-23 新C\n- 内容C',
    ]);
    const full = readFileSync(realInboxFile, 'utf8');
    check(fullRun.status === 0, `(a) の replace_section が失敗した: ${said(fullRun)}`);
    check(count(full, '### 2026-09-20 既存A') === 2, `全文の replace_section で既存が重複しなかった（手順書の警告が古い）: ${count(full, '### 2026-09-20 既存A')} 回`);

    // (b) 新しい 1 件だけを replace_section に渡す → 重複はしないが、節の先頭（既存の前）に入り、
    //     既存の `###` との間の空行も落ちる。inbox は古い順に積んでいるので採らない（手順書が find_replace に
    //     一本化している理由）。
    check(resetRealInbox().status === 0, '下準備 (b)（inbox の形のノート）を作れなかった');
    const singleRun = editRealInbox(['--operation', 'replace_section', '--section', '## 未蒸留', '--content', '### 2026-09-23 新C\n- 内容C']);
    const single = readFileSync(realInboxFile, 'utf8');
    check(singleRun.status === 0, `(b) の replace_section が失敗した: ${said(singleRun)}`);
    check(count(single, '### 2026-09-20 既存A') === 1, '新しい 1 件だけの replace_section で既存が重複・消失した');
    check(single.indexOf('### 2026-09-23 新C') < single.indexOf('### 2026-09-20 既存A'), '新しい 1 件だけの replace_section が既存の前に入らなかった（find_replace に一本化した理由が消えている）');
    check(single.includes('- 内容C\n### 2026-09-20 既存A'), `新しい 1 件だけの replace_section が既存との間の空行を落とさなかった（手順書の記述が古い）: ${JSON.stringify(single.slice(single.indexOf('- 内容C'), single.indexOf('- 内容C') + 30))}`);

    // (c) 本文が見出しを引用していると、`## Relations` だけの目印は 2 か所に当たり、終了コード 1 で何も書かずに
    //     止まる（--expected-replacements の既定 1）。手順書が「行頭の」目印（改行＋見出し）を使う理由。
    check(resetRealInbox(quotingInbox).status === 0, '下準備 (c)（本文が見出しを引用する inbox）を作れなかった');
    const before = readFileSync(realInboxFile, 'utf8');
    const ambiguous = editRealInbox(['--operation', 'find_replace', '--find-text', '## Relations', '--content', '### 2026-09-23 新C\n\n## Relations']);
    check(ambiguous.status === 1 && said(ambiguous).includes('Expected 1 occurrences'), `2 か所に当たる find_replace が「Expected 1 occurrences」の終了コード 1 で止まらなかった: [${ambiguous.status}] ${said(ambiguous)}`);
    check(readFileSync(realInboxFile, 'utf8') === before, '2 か所に当たる find_replace がノートを書き換えた');

    // (c') 手順書の目印（行頭の見出し）そのものが 2 か所・0 か所に当たる形。手順書は両方とも「何も書かずに止まる」と
    //      書いているので、それぞれのメッセージと終了コード 1 を固定する。
    for (const [label, content, message] of [
      ['2 か所', realInbox.replace('- 内容A', '- 内容A\n## Relations'), 'Expected 1 occurrences'],
      ['0 か所', realInbox.slice(0, realInbox.indexOf(MARK) + 1), 'Text to replace not found'],
    ]) {
      check(resetRealInbox(content).status === 0, `下準備 (c')（行頭の目印が ${label}）を作れなかった`);
      const kept = readFileSync(realInboxFile, 'utf8');
      const run = editRealInbox(['--operation', 'find_replace', '--find-text', MARK, '--content', '\n### 2026-09-23 新C\n\n## Relations\n']);
      check(run.status === 1 && said(run).includes(message), `行頭の目印が ${label} の find_replace が「${message}」の終了コード 1 で止まらなかった: [${run.status}] ${said(run)}`);
      check(readFileSync(realInboxFile, 'utf8') === kept, `行頭の目印が ${label} の find_replace がノートを書き換えた`);
    }

    // (d) `--content` の `\n` は改行にならず、2 文字のまま入る。手順書が引用符の中で実際に改行させる理由。
    check(resetRealInbox().status === 0, '下準備 (d)（inbox の形のノート）を作れなかった');
    const escaped = editRealInbox(['--operation', 'find_replace', '--find-text', MARK, '--content', '\n### 2026-09-23 新C\\n\\n## Relations\n']);
    const escapedText = readFileSync(realInboxFile, 'utf8');
    check(escaped.status === 0, `(d) の find_replace が失敗した: ${said(escaped)}`);
    check(escapedText.includes('### 2026-09-23 新C\\n\\n## Relations'), `--content の \\n が改行として解釈された（手順書の警告が古い）: ${JSON.stringify(escapedText.slice(-80))}`);
    check(!/^## Relations$/m.test(escapedText), '--content の \\n を使った書き込みで行頭の ## Relations が残った（手順書の警告が古い）');

    // (e) append と違い、無い permalink への find_replace はエラーで止まり、何も作らない（replace_section も同じ。
    //     ステップ 6。手順書が「find_replace は当て先を間違えても黙って別のノートを作らない」と書く根拠）。
    const missing = bmJson([
      'tool', 'edit-note', 'corrections/not-created-for-find', '--project', PROJECT,
      '--operation', 'find_replace', '--find-text', '## Relations', '--content', '### 2026-09-23 新C\n\n## Relations',
    ]);
    const leaked = bmJson(['tool', 'read-note', `${PROJECT}/corrections/not-created-for-find`, '--project', PROJECT]);
    check(missing.status === 1 && said(missing).includes('Entity not found'), `無い permalink への find_replace が「Entity not found」の終了コード 1 で止まらなかった: [${missing.status}] ${said(missing)}`);
    check(leaked.status === 0 && leaked.json !== null, `作られていないことを確かめる read-note が答えを返さなかった: [${leaked.status}] ${leaked.stderr}`);
    check(!existsSync(notePath('corrections/not-created-for-find.md')) && leaked.json?.file_path == null, '無い permalink への find_replace がノートを作った');

    // (f) 手順の前提が崩れた形: `## 未蒸留` と `## Relations` の間に別の節があると、目印は 1 か所に当たるので
    //     止まらず、その別の節の末尾へ終了コード 0 で黙って入る（手順書が前提と崩れる条件を書く根拠）。
    check(resetRealInbox(realInbox.replace(MARK, '\n## 蒸留済み\n- 済んだもの\n\n## Relations\n')).status === 0, '下準備 (f)（間に節がある inbox）を作れなかった');
    const shifted = editRealInbox(['--operation', 'find_replace', '--find-text', MARK, '--content', '\n### 2026-09-23 新C\n- 内容C\n\n## Relations\n']);
    const shiftedText = readFileSync(realInboxFile, 'utf8');
    check(shifted.status === 0, `(f) の find_replace が止まった（手順書の「黙って入る」が古い）: ${said(shifted)}`);
    check(shiftedText.indexOf('### 2026-09-23 新C') > shiftedText.indexOf('## 蒸留済み'), '(f) で新しいエントリが間の節より前に入った（手順書の「別の節の末尾へ黙って入る」が古い）');

    // (g) もう 1 つの前提: `## Relations` の直前に空行がある。無いと目印の改行が前のエントリの行末に当たり、
    //     新しいエントリが空行なしで前のエントリに続く。
    check(resetRealInbox(realInbox.replace('- 内容B\n\n## Relations', '- 内容B\n## Relations')).status === 0, '下準備 (g)（Relations の直前に空行が無い inbox）を作れなかった');
    const glued = editRealInbox(['--operation', 'find_replace', '--find-text', MARK, '--content', '\n### 2026-09-23 新C\n- 内容C\n\n## Relations\n']);
    check(glued.status === 0 && readFileSync(realInboxFile, 'utf8').includes('- 内容B\n### 2026-09-23 新C'), `(g) で新しいエントリが空行なしで前のエントリに続かなかった（手順書の前提の記述が古い）: ${said(glued)}`);
    return { fullDuplicates: count(full, '### 2026-09-20 既存A'), ambiguousStatus: ambiguous.status, missingStatus: missing.status };
  });

  // 6e. SKILL.md の「ミスをした直後」のコードブロックを抜き出して、書かれたとおりに実行する（LEV-192）。
  //     当て先と project だけを差し替え、`{…}` の差し込み口はそのまま文字として入れる。本文が見出しを引用して
  //     いる inbox に対して、既存が重複も消失もせず、新しい 1 件が既存の後ろ・Relations の前に空行で区切られて
  //     入ることを見る。
  /** 各見出しがそれだけの行としてちょうど 1 回ずつある。 */
  const headingsAppearOnce = (text, headings) => headings.every(h => text.split('\n').filter(line => line === h).length === 1);

  await step('documented-inbox-entry', () => {
    const script = documentedScript('edit-note corrections/inbox ', [
      ['corrections/inbox ', 'corrections/real-inbox '],
      ['{何をしたか・なぜか}', trickyInSingleQuotes],
    ], /corrections\/inbox(?![\w-])/);
    if (script === null) return { script };
    const statuses = {};
    for (const shell of SHELLS) {
      check(resetRealInbox(quotingInbox).status === 0, `[${shell}] 下準備（本文が見出しを引用する inbox）を作れなかった`);
      const run = runSh(script, shell);
      statuses[shell] = run.status;
      const text = readFileSync(realInboxFile, 'utf8');
      const heading = text.match(/^### \{[^\n]*$/m)?.[0] ?? '';
      const at = needle => text.indexOf(needle);
      check(run.status === 0, `[${shell}] 手順書のコマンドが失敗した: ${run.why}`);
      check(count(text, '### 2026-09-20 既存A') === 1 && count(text, '### 2026-09-21 既存B') === 1, `[${shell}] 手順書どおりの書き込みで既存のエントリが重複・消失した`);
      check(text.includes('末尾が `## Relations` なので append は後ろに落ちる\n## Relations の書き方は SKILL.md を見る'), `[${shell}] 手順書どおりの書き込みが、見出しを引用した本文を書き換えた`);
      check(heading !== '' && count(text, heading) === 1, `[${shell}] 新しいエントリが 1 回だけ入っていない: ${JSON.stringify(heading)}`);
      check(at(heading) > at('### 2026-09-21 既存B'), `[${shell}] 新しいエントリが既存の後ろに入らない（inbox は古い順に積む）`);
      check(at(heading) < at(MARK), `[${shell}] 新しいエントリが Relations の後ろに入った`);
      check(/- 内容B\n\n### \{/.test(text), `[${shell}] 既存のエントリと新しいエントリの間に空行が無い`);
      check(text.includes(`- ${TRICKY}\n`), `[${shell}] 差し込み口の本文がシェルに書き換えられた（バッククォート・$・引用符・括弧が素通しされない）: ${JSON.stringify(text.slice(at(heading), at(MARK)))}`);
      check(/\n\n## Relations\n- distilled_into \[\[Correction Lessons\]\]/.test(text), `[${shell}] Relations の手前の空行か Relations 自体が崩れた`);
    }
    return { shells: SHELLS, statuses };
  });

  // 6e'. lessons のコードブロックも同じように実行する。実物と同じく、節の見出しの直前に
  //      空行を置かない番号付きリストで、教訓の本文が `## 手順` を引用し、`## 手順書…` で始まる行もある形。
  await step('documented-lessons-entry', () => {
    const lessons = [
      '---', 'permalink: corrections/real-lessons', '---', '',
      '# Correction Real Lessons', '', '蒸留した教訓。', '',
      '## 道具の癖', '## 手順書の置き場は下', '1. **教訓1** — `## 手順` の前に差し込む', '2. **教訓2**',
      '## 手順', '3. **教訓3**',
      '## 報告', '4. **教訓4**',
      '## Relations', '- originated_from [[Correction Inbox]]', '',
    ].join('\n');
    const lessonsFile = notePath('corrections/Correction Real Lessons.md');
    const sections = ['## 道具の癖', '## 手順', '## 報告', '## Relations'];
    const script = documentedScript('edit-note corrections/lessons ', [
      ['corrections/lessons ', 'corrections/real-lessons '],
      ['{教訓 1 行}', trickyInSingleQuotes],
    ], /corrections\/lessons(?![\w-])/);
    if (script === null) return { script };
    // 最後の節（`## 報告`）に足すときは、手順書の指示どおり目印と本文の最後の見出しを両方 `## Relations` に変える
    // 。確かめ済みのスクリプトから作る。
    const marks = count(script, '## 手順');
    check(marks === 2, `lessons のブロックの ## 手順 が目印と本文の 2 か所でない: ${marks} か所`);
    // 数が違うまま差し替えて回すと、無関係な場所で落ちて本当の原因が埋もれる。
    if (marks !== 2) return { marks };
    const last = script.replaceAll('## 手順', '## Relations');
    const statuses = {};
    for (const shell of SHELLS) {
      const made = writeNoteWith(['--type', 'correction', '--overwrite'], 'Correction Real Lessons', 'corrections', lessons,
      );
      check(made.status === 0, `[${shell}] 下準備（lessons の形のノート）を作れなかった: ${made.stderr}`);
      const run = runSh(script, shell);
      const text = readFileSync(lessonsFile, 'utf8');
      check(run.status === 0, `[${shell}] 手順書のコマンドが失敗した: ${run.why}`);
      check(text.includes(`2. **教訓2**\n{N}. **${TRICKY}**\n## 手順\n3. **教訓3**`), `[${shell}] 新しい教訓が ## 手順 の直前に、差し込み口の本文のまま入らなかった: ${JSON.stringify(text.slice(text.indexOf('## 道具の癖'), text.indexOf('## 報告')))}`);
      check(count(text, `{N}. **${TRICKY}**`) === 1, `[${shell}] 新しい教訓が 1 回だけ入っていない`);
      check(text.includes('## 手順書の置き場は下\n1. **教訓1** — `## 手順` の前に差し込む'), `[${shell}] 手順書どおりの書き込みが、見出しを引用した本文か見出しで始まる行を書き換えた`);
      check(headingsAppearOnce(text, sections), `[${shell}] 節の見出しが重複・消失した`);

      const lastRun = runSh(last, shell);
      const lastText = readFileSync(lessonsFile, 'utf8');
      check(lastRun.status === 0, `[${shell}] 最後の節へ足す手順書のコマンドが失敗した: ${lastRun.why}`);
      check(lastText.includes(`4. **教訓4**\n{N}. **${TRICKY}**\n## Relations\n- originated_from`), `[${shell}] 最後の節に足した教訓が ## Relations の直前に入らなかった: ${JSON.stringify(lastText.slice(lastText.indexOf('## 報告')))}`);
      check(headingsAppearOnce(lastText, sections), `[${shell}] 最後の節へ足したあと節の見出しが重複・消失した`);
      statuses[shell] = [run.status, lastRun.status];
    }
    // 前提が崩れた形: `## 道具の癖` と `## 手順` の間に別の節があると、目印は 1 か所に当たるので止まらず、
    // その別の節の末尾へ終了コード 0 で黙って入る（手順書が lessons の前提と崩れる条件を書く根拠）。
    check(writeNoteWith(['--type', 'correction', '--overwrite'], 'Correction Real Lessons', 'corrections',
      lessons.replace('2. **教訓2**\n## 手順', '2. **教訓2**\n## 追加の節\n9. **別の教訓**\n## 手順')).status === 0, '下準備（間に節がある lessons）を作れなかった');
    const shifted = runSh(script);
    const shiftedText = readFileSync(lessonsFile, 'utf8');
    check(shifted.status === 0 && shiftedText.includes(`9. **別の教訓**\n{N}. **${TRICKY}**\n## 手順`), `間に節がある lessons で、新しい教訓がその節の末尾へ黙って入らなかった（手順書の前提の記述が古い）: ${shifted.why}`);
    return { shells: SHELLS, statuses };
  });

  // 6f. ファイル名とタイトルが違うノート（実物の corrections/inbox・lessons・graduated はどれも
  //     `inbox.md` に `title: Correction Inbox`）へ write-note --overwrite を打つと、既存は変わらず
  //     `{folder}/{title}.md` の新しいノートができる（LEV-192。2026-09-23 に実際に踏んだ）。
  //     write-note は --title でタイトルを決めるので、作ってから frontmatter の title だけを差し替えて実物の形にする。
  await step('overwrite-with-different-filename-creates-another-note', () => {
    const made = writeNoteWith(['--type', 'correction'], 'inbox', 'shaped', '---\npermalink: shaped/inbox\n---\n\n# Correction Inbox\n\n- 既存の記録1\n',
    );
    const retitled = bmJson([
      'tool', 'edit-note', 'shaped/inbox', '--project', PROJECT,
      '--operation', 'find_replace', '--find-text', 'title: inbox', '--content', 'title: Correction Inbox',
    ]);
    const existing = notePath('shaped/inbox.md');
    const read = bmJson(['tool', 'read-note', 'shaped/inbox', '--project', PROJECT]);
    check(made.status === 0 && retitled.status === 0, `下準備（ファイル名とタイトルが違うノート）を作れなかった: ${made.stderr} / ${retitled.stderr}`);
    check(read.json?.title === 'Correction Inbox' && read.json?.file_path === 'shaped/inbox.md', `下準備のノートが実物の形になっていない: ${JSON.stringify(read.json)}`);
    const before = readFileSync(existing, 'utf8');
    // 2026-09-23 に打ったのと同じ形: タイトルを指定し、全文（permalink 付き）を --overwrite で渡す。
    const out = writeNoteWith(['--type', 'correction', '--overwrite'], 'Correction Inbox', 'shaped', '---\npermalink: shaped/inbox\n---\n\n# Correction Inbox\n\n- 書き直した全文\n',
    );
    const other = notePath('shaped/Correction Inbox.md');
    check(out.status === 0, `--overwrite が失敗した: ${out.stderr}`);
    check(readFileSync(existing, 'utf8') === before, '--overwrite がファイル名の違う既存のノートを書き換えた（手順書の警告が古い）');
    check(existsSync(other), '--overwrite が {folder}/{title}.md の新しいノートを作らなかった（手順書の警告が古い）');
    // 手順書は 2026-09-23 の実例として permalink `corrections/inbox-1` を挙げている。その形も固定する。
    check(out.json?.permalink === 'shaped/inbox-1', `新しいノートの permalink が {既存}-1 にならなかった（手順書の実例が古い）: ${out.json?.permalink}`);
    check(bmJson(['tool', 'read-note', 'shaped/inbox', '--project', PROJECT]).json?.file_path === 'shaped/inbox.md', '--overwrite のあと shaped/inbox が既存のファイルを指さなくなった');
    // 既存と同じ permalink が返ったとき（bm の挙動が変わったとき）に下準備のノートを消さない。
    if (out.json?.permalink && out.json.permalink !== 'shaped/inbox') {
      const removed = bm(['tool', 'delete-note', out.json.permalink, '--project', PROJECT]);
      // 残ったままだと、下の frontmatter 無しの --overwrite がこのファイルに当たり、原因と違う FAIL になる。
      check(removed.status === 0 && !existsSync(other), `下準備（誤って作られたノート）を消せなかった: ${removed.stderr}`);
    }

    // 本文に frontmatter の permalink が無ければ、衝突の回避ではなくタイトルのスラッグ（前置あり）になる。
    const bare = writeNoteWith(['--type', 'correction', '--overwrite'], 'Correction Inbox', 'shaped', '# Correction Inbox\n\n- 書き直した全文\n',
    );
    check(bare.status === 0, `frontmatter 無しの --overwrite が失敗した: ${bare.stderr}`);
    check(readFileSync(existing, 'utf8') === before, 'frontmatter 無しの --overwrite がファイル名の違う既存のノートを書き換えた');
    check(bare.json?.permalink === `${PROJECT}/shaped/correction-inbox`, `frontmatter 無しの新しいノートの permalink が {project}/{folder}/{title のスラッグ} にならなかった（手順書が古い）: ${bare.json?.permalink}`);
    if (bare.json?.permalink && bare.json.permalink !== 'shaped/inbox') bm(['tool', 'delete-note', bare.json.permalink, '--project', PROJECT]);
    return { createdPermalink: out.json?.permalink, createdFile: out.json?.file_path, barePermalink: bare.json?.permalink };
  });

} catch (error) {
  record.failures.push(String(error));
} finally {
  // ここから先は後片付けそのもの。遅れて届いたシグナルで onInterrupt が二重に片付け、終わった記録を
  // 「中断」で上書きしないよう、既定の動作（その場で終了）に戻す。
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  cleaningUp = true;
  // project add が時間切れで throw した場合、bm が登録だけ済ませていることがある。一覧で確かめて消す対象に入れる。
  if (!added && adding) added = isRegistered();
  // 身代わりの bm は --keep でも残さない（手で追うときは本物の bm を使う）。
  rmSync(shimDir, { recursive: true, force: true });
  if (keep) {
    console.log(added
      ? `--keep: ${PROJECT}（${root}）を残した。手で消す: bm project remove ${PROJECT} --delete-notes --local`
      : `--keep: プロジェクトは作られていない。一時ディレクトリだけ残した: ${root}`);
  } else {
    // プロジェクトを作れなかった経路でも一時ディレクトリは残るので、後片付けは add の成否と分ける。
    // bm() は spawn 失敗で throw する。finally の中で外へ抜けると rmSync も finish() も走らず、
    // 使い捨てのディレクトリとプロジェクトが残ったまま、JSON も書かれずに終わる。ここで捕まえる。
    if (added) {
      try {
        const removed = bm(['project', 'remove', PROJECT, '--delete-notes']);
        check(removed.status === 0, `使い捨てプロジェクトを消せなかった（手で消す: bm project remove ${PROJECT} --delete-notes --local）`);
        const listed = bmJson(['tool', 'list-projects']);
        // 一覧が読めないまま names を空配列にすると、消し損ねを見逃したまま PASS する。
        check(listed.status === 0 && listed.json !== null, `後片付けの確認ができない（bm tool list-projects が読めない）: ${listed.stderr}`);
        if (listed.json) {
          const names = (listed.json.projects ?? []).map(item => item.name);
          check(!names.includes(PROJECT), `使い捨てプロジェクトが残っている: ${PROJECT}`);
          // 実行前の一覧が読めていた場合だけ、他のプロジェクトを巻き込んでいないかを見る。
          // hadMappyMemory === null（読めなかった）を「無かった」と同じ扱いにすると、検知が黙って消える。
          check(hadMappyMemory !== null, '実行前のプロジェクト一覧を読めなかったので、行き過ぎた後片付けを検知できない');
          if (hadMappyMemory === true) check(names.includes('mappy-memory'), 'mappy-memory がプロジェクト一覧から消えた（後片付けが行き過ぎた）');
        }
        record.steps['project-remove'] = { status: removed.status, dirLeftByBm: existsSync(root) };
      } catch (error) {
        record.steps['project-remove'] = { error: String(error) };
        check(false, `後片付けの bm 呼び出しが失敗した（手で消す: bm project remove ${PROJECT} --delete-notes --local）: ${error}`);
      }
    }
    // root は毎回 mkdtempSync が作った一時ディレクトリ。bm が残した場合も、add が失敗した場合もここで消す。
    try {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
      check(!existsSync(root), `使い捨てのディレクトリを消せなかった: ${root}`);
    } catch (error) {
      check(false, `使い捨てのディレクトリを消せなかった（手で消す: ${root}）: ${error}`);
    }
  }
}

process.exit(await finish(record, jsonPath));
