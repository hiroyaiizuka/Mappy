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
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecord, finish, makeCheck, makeStep, parseArgs } from './case-runner.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const { flag, value } = parseArgs();
const jsonPath = value('--json');
const keep = flag('--keep');

const PROJECT = `mappy-memory-probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * bm を 1 回呼ぶ。`input` を渡すと stdin から本文を流す（SKILL.md の heredoc と同じ経路）。
 * `--local` を必ず付ける: cloud モードが有効な端末では既定でクラウド側へ流れ、ローカルの一時
 * ディレクトリにファイルが現れず「手順書が壊れている」という誤った FAIL になる。後片付けの
 * `project remove --delete-notes` がクラウドのプロジェクトに当たるのも防ぐ。
 */
function bm(args, input) {
  const result = spawnSync('bm', [...args, '--local'], { input, encoding: 'utf8' });
  if (result.error) throw new Error(`bm ${args.join(' ')}: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** bm の JSON 出力を読む。conflict のように終了コードが 0 でない回も JSON を返すので status も渡す。 */
function bmJson(args, input) {
  const run = bm(args, input);
  // 失敗時は "Error: NOTE_ALREADY_EXISTS" のような行が JSON の前に付く。最初の { から読む。
  const at = run.stdout.indexOf('{');
  let json = null;
  if (at !== -1) { try { json = JSON.parse(run.stdout.slice(at)); } catch { json = null; } }
  return { ...run, json };
}

// bm が無い端末（新しいクローン・CI）では「手順書が壊れている」ではなく「実行していない」で終わる。
// spawn 自体が失敗する ENOENT も含めてここで拾わないと、bm() の throw がそのまま終了コード 1 になり、
// FAIL と見分けが付かなくなる（docs/harness.md「開発メモリの手順」が終了コード 2 を約束している）。
let version;
try {
  // `bm --version` はトップレベルのフラグしか受けないので、ここだけ --local を付けずに呼ぶ。
  const probe = spawnSync('bm', ['--version'], { encoding: 'utf8' });
  if (probe.error) throw new Error(probe.error.message);
  if (probe.status !== 0) throw new Error(probe.stderr || `終了コード ${probe.status}`);
  version = (probe.stdout ?? '').trim();
} catch (error) {
  console.error(`bm CLI を実行できない（${error.message}）。このケースは実行していない。`);
  process.exit(2);
}

// 後片付けの検証に使う。使い捨てプロジェクトを消すついでに他のプロジェクトまで消していないことを見るが、
// mappy-memory が登録されていない端末で FAIL にしないよう、「元々あったか」を先に記録しておく。
// 一覧そのものが読めなかった場合に false へ倒すと、行き過ぎた後片付けの検知が黙って消えるので、
// 「読めなかった」を第 3 の状態として持つ（後片付けの側でそれを FAIL にする）。
const projectsBefore = bmJson(['tool', 'list-projects']);
const listedBefore = projectsBefore.status === 0 && projectsBefore.json !== null;
const hadMappyMemory = listedBefore
  ? (projectsBefore.json.projects ?? []).some(item => item.name === 'mappy-memory')
  : null;

const root = mkdtempSync(join(tmpdir(), 'mappy-memory-probe-'));
const record = createRecord(root, PROJECT);
record.bmVersion = version;
record.hadMappyMemory = hadMappyMemory;
const step = makeStep(record);
const check = makeCheck(record);

const notePath = name => join(root, name);
/** frontmatter だけを返す。取れなければ空文字（本文全体を返すと、本文中の `type: event` で check が通る）。 */
const frontmatterOf = file => {
  const text = readFileSync(file, 'utf8');
  if (!text.startsWith('---\n')) return '';
  const end = text.indexOf('\n---', 4);
  return end === -1 ? '' : text.slice(0, end + 4);
};

let added = false;

// Ctrl-C で中断しても、使い捨てプロジェクトを bm のグローバル設定に残さない。finally は届かない。
const onInterrupt = signal => {
  if (added && !keep) { spawnSync('bm', ['project', 'remove', PROJECT, '--delete-notes'], { encoding: 'utf8' }); }
  if (!keep && existsSync(root)) rmSync(root, { recursive: true, force: true });
  console.error(`\n${signal} で中断した。使い捨てプロジェクトは片付けた。`);
  process.exit(2);
};
process.on('SIGINT', () => onInterrupt('SIGINT'));
process.on('SIGTERM', () => onInterrupt('SIGTERM'));

try {
  await step('project-add', () => {
    const run = bm(['project', 'add', PROJECT, root]);
    added = run.status === 0;
    check(added, `使い捨てプロジェクトを作れない: ${run.stderr || run.stdout}`);
    return { status: run.status, path: root };
  });
  if (!added) throw new Error('プロジェクトを作れなかったので以降は実行しない');

  // 1. permalink と type を省いた write-note が、何を既定に落とすか（SKILL.md「frontmatter の permalink と type」）。
  //    日本語タイトルなのでスラッグ崩れと前置が同時に起きる。原因の切り分けはステップ 1b で行う。
  let droppedPermalink = '';
  await step('defaults-drop-permalink-and-type', () => {
    const title = '2026-09-22 既定の確認';
    const out = bmJson(
      ['tool', 'write-note', '--project', PROJECT, '--title', title, '--folder', 'events', '--tags', 'probe'],
      '# 既定の確認\n\n## Observations\n- [tech] permalink と type を省いた #probe\n',
    );
    droppedPermalink = out.json?.permalink ?? '';
    const file = notePath(`events/${title}.md`);
    const front = existsSync(file) ? frontmatterOf(file) : '';
    // 意図した英語スラッグでは引けない ＝ 日本語タイトルのノートは permalink を予測できない。
    const guess = bmJson(['tool', 'read-note', 'events/2026-09-22-defaults', '--project', PROJECT]);
    check(out.status === 0, `write-note が失敗した: ${out.stderr}`);
    check(droppedPermalink.startsWith(`${PROJECT}/`), `permalink にプロジェクト名が前置されなかった: ${droppedPermalink}`);
    check(/^type: note$/m.test(front), `type が既定の note にならなかった: ${front}`);
    check(guess.json?.permalink == null, `予測した英語スラッグで引けてしまった（スラッグは崩れていない）: ${guess.json?.permalink}`);
    return { permalink: droppedPermalink, type: front.match(/^type: (.+)$/m)?.[1] };
  });

  // 1b. 原因の切り分け（レビュー指摘）。前置「だけ」なら read-note と [[wiki link]] は当たり、
  //     外れるのは --permalink のグロブだけ。手順書はこの 2 つを別々の理由として書いている。
  await step('prefix-alone-does-not-break-read-note', () => {
    const out = bmJson(
      ['tool', 'write-note', '--project', PROJECT, '--title', 'Probe Ascii Title', '--folder', 'events'],
      '# Probe Ascii Title\n\n## Observations\n- [tech] permalink だけ省いた #probe\n',
    );
    // 対照。グロブが何も拾わなくなった場合に「前置を外している」と読み違えないよう、拾う側も同じ回で作る。
    const target = bmJson(
      ['tool', 'write-note', '--project', PROJECT, '--title', 'Probe Glob Target', '--folder', 'events'],
      '---\npermalink: events/probe-glob-target\n---\n\n# Probe Glob Target\n',
    );
    const permalink = out.json?.permalink ?? '';
    const byWish = bmJson(['tool', 'read-note', 'events/probe-ascii-title', '--project', PROJECT]);
    const glob = bmJson(['tool', 'search-notes', '--permalink', 'events/*', '--project', PROJECT]);
    const globHits = (glob.json?.results ?? []).map(item => item.permalink);
    check(permalink === `${PROJECT}/events/probe-ascii-title`, `前置された permalink にならなかった: ${permalink}`);
    check(byWish.json?.permalink === permalink, `前置されただけのノートが {カテゴリ}/{スラッグ} で読めない: ${byWish.stderr}`);
    check(target.json?.permalink === 'events/probe-glob-target', `対照ノートを作れなかった: ${target.stderr}`);
    check(globHits.includes('events/probe-glob-target'), `--permalink "events/*" が前置なしのノートを拾わない: ${globHits.join(', ')}`);
    check(!globHits.includes(permalink), `--permalink "events/*" が前置されたノートを拾った: ${globHits.join(', ')}`);
    return { permalink, readBy: byWish.json?.permalink, globHits };
  });

  // 2. SKILL.md の推奨手順そのもの（stdin + frontmatter の permalink / type）。
  //    heredoc の構文自体が通ることを見るため、この回だけシェル経由で実行する。
  await step('documented-write-note', () => {
    const script = [
      `bm tool write-note --project ${PROJECT} \\`,
      `  --title "2026-09-22 推奨手順の確認" \\`,
      `  --folder "events" \\`,
      `  --tags "probe,mappy" <<'NOTE'`,
      '---',
      'permalink: events/probe-documented-write',
      'type: event',
      'ticket: LEV-184',
      '---',
      '',
      '# 推奨手順の確認',
      '',
      '## Observations',
      '- [tech] PROBEWRITETOKEN を含む #probe',
      'NOTE',
    ].join('\n');
    const run = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
    const at = (run.stdout ?? '').indexOf('{');
    // JSON でなくても throw せず、下の status / stderr を出す check に到達させる。
    let json = null;
    if (at !== -1) { try { json = JSON.parse(run.stdout.slice(at)); } catch { json = null; } }
    const file = notePath('events/2026-09-22 推奨手順の確認.md');
    const front = existsSync(file) ? frontmatterOf(file) : '';
    check(run.status === 0, `heredoc 版の write-note が失敗した: ${run.stderr}`);
    check(json?.permalink === 'events/probe-documented-write', `permalink が明示した値にならなかった: ${json?.permalink}`);
    check(/^type: event$/m.test(front), `type が event にならなかった: ${front}`);
    return { permalink: json?.permalink, action: json?.action };
  });

  // 3. reindex 無しで、書いた直後に読めて検索できること（SKILL.md「書き込み」の「bm reindex は要らない」）。
  await step('indexed-without-reindex', () => {
    const read = bmJson(['tool', 'read-note', 'events/probe-documented-write', '--project', PROJECT]);
    const found = bmJson(['tool', 'search-notes', 'PROBEWRITETOKEN', '--project', PROJECT]);
    const hits = (found.json?.results ?? []).map(item => item.permalink);
    check(read.json?.permalink === 'events/probe-documented-write', `{カテゴリ}/{スラッグ} で read-note できない: ${read.stderr}`);
    check(hits.includes('events/probe-documented-write'), `reindex 無しで検索に出ない: ${hits.join(', ')}`);
    return { read: read.json?.permalink, hits };
  });

  // 4. type を明示したノートだけが --type で引けること（指摘 3 の回帰）。
  await step('search-by-type', () => {
    const out = bmJson(['tool', 'search-notes', '--type', 'event', '--project', PROJECT]);
    const hits = (out.json?.results ?? []).map(item => item.permalink);
    check(hits.includes('events/probe-documented-write'), `type: event のノートが --type event で出ない: ${hits.join(', ')}`);
    // permalink の形ではなく、ステップ 1 で type を落としたノートそのものが混ざっていないかを見る。
    check(!hits.includes(droppedPermalink), `type を落としたノート（${droppedPermalink}）が --type event に混ざった: ${hits.join(', ')}`);
    return { hits };
  });

  // 5. 積み上げるノート: 2 回目の write-note は何も書かず、--overwrite は過去の記録を消し、append は残す。
  await step('inbox-create', () => {
    const out = bmJson(
      ['tool', 'write-note', '--project', PROJECT, '--title', 'Correction Inbox', '--folder', 'corrections', '--type', 'correction'],
      '---\npermalink: corrections/inbox\n---\n\n# Correction Inbox\n\n## 2026-09-20\n- 既存の記録1\n',
    );
    check(out.status === 0, `inbox を作れない: ${out.stderr}`);
    return { permalink: out.json?.permalink, action: out.json?.action };
  });

  await step('second-write-note-writes-nothing', () => {
    const before = readFileSync(notePath('corrections/Correction Inbox.md'), 'utf8');
    const out = bmJson(
      ['tool', 'write-note', '--project', PROJECT, '--title', 'Correction Inbox', '--folder', 'corrections', '--type', 'correction'],
      '---\npermalink: corrections/inbox\n---\n\n# Correction Inbox\n\n## 2026-09-22\n- 新しい記録2\n',
    );
    const after = readFileSync(notePath('corrections/Correction Inbox.md'), 'utf8');
    check(out.status !== 0, '2 回目の write-note が終了コード 0 で通った');
    check(out.json?.action === 'conflict', `action が conflict でない: ${out.json?.action}`);
    check(out.json?.file_path === null, `file_path が null でない: ${out.json?.file_path}`);
    check(before === after, '2 回目の write-note がノートを書き換えた');
    return { status: out.status, action: out.json?.action, error: out.json?.error };
  });

  await step('overwrite-loses-history', () => {
    const out = bmJson(
      ['tool', 'write-note', '--project', PROJECT, '--title', 'Correction Inbox', '--folder', 'corrections', '--type', 'correction', '--overwrite'],
      '---\npermalink: corrections/inbox\n---\n\n# Correction Inbox\n\n## 2026-09-22\n- 新しい記録2\n',
    );
    const text = readFileSync(notePath('corrections/Correction Inbox.md'), 'utf8');
    check(out.status === 0, `--overwrite が失敗した: ${out.stderr}`);
    check(!text.includes('既存の記録1'), '--overwrite が過去の記録を残した（SKILL.md の警告が古い）');
    return { action: out.json?.action, keptHistory: text.includes('既存の記録1') };
  });

  await step('append-keeps-history', () => {
    // 下準備。ここが失敗すると、下の「append が過去の記録を消した」が事実と違う理由で落ちる。
    const restored = bmJson(
      ['tool', 'write-note', '--project', PROJECT, '--title', 'Correction Inbox', '--folder', 'corrections', '--type', 'correction', '--overwrite'],
      '---\npermalink: corrections/inbox\n---\n\n# Correction Inbox\n\n## 2026-09-20\n- 既存の記録1\n',
    );
    check(restored.status === 0, `下準備（過去の記録を書き戻す --overwrite）が失敗した: ${restored.stderr}`);
    const out = bmJson([
      'tool', 'edit-note', 'corrections/inbox', '--project', PROJECT,
      '--operation', 'append', '--content', '\n## 2026-09-22\n- 新しい記録2 PROBEAPPENDTOKEN\n',
    ]);
    const text = readFileSync(notePath('corrections/Correction Inbox.md'), 'utf8');
    const found = bmJson(['tool', 'search-notes', 'PROBEAPPENDTOKEN', '--project', PROJECT]);
    const hits = (found.json?.results ?? []).map(item => item.permalink);
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
    return { permalink: out.json?.permalink, fileCreated: out.json?.fileCreated };
  });

  // 6b. 手順書は `--content "{追記する本文}"` と書いており、先頭に改行を置かせていない。積み上げるノートは
  //     この形で何度も呼ばれるので、append が自分で改行を入れることに寄りかかっている。前の行に癒着すると
  //     corrections/inbox が 1 行に潰れるため、続けて 2 回打って別の行に入ることを固定する。
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
  //     手順書が corrections に replace_section を指定している理由なので、両方の挙動を固定する。
  const inboxShape = [
    '---', 'permalink: corrections/shape', '---', '',
    '# Correction Inbox', '', '## 未蒸留', '', '### 2026-09-20 既存のミス', '- 内容', '',
    '## Relations', '- distilled_into [[Correction Lessons]]', '',
  ].join('\n');
  await step('append-lands-after-relations-replace-section-does-not', () => {
    const shapeFile = notePath('corrections/Correction Shape.md');
    const write = (content, extra = []) => bmJson(
      ['tool', 'write-note', '--project', PROJECT, '--title', 'Correction Shape', '--folder', 'corrections', '--type', 'correction', ...extra],
      content,
    );
    // (a) append はファイル末尾 ＝ Relations の後ろ。
    write(inboxShape);
    bmJson(['tool', 'edit-note', 'corrections/shape', '--project', PROJECT, '--operation', 'append', '--content', '### 2026-09-22 新しいミス']);
    const appended = readFileSync(shapeFile, 'utf8');
    const afterRelations = appended.indexOf('### 2026-09-22 新しいミス') > appended.indexOf('## Relations');
    check(afterRelations, 'append が Relations より前に入った（手順書が replace_section を指定している理由が消えている）');

    // (b) replace_section は節の中、既存の ### を残したまま先頭に入る。
    write(inboxShape, ['--overwrite']);
    bmJson([
      'tool', 'edit-note', 'corrections/shape', '--project', PROJECT,
      '--operation', 'replace_section', '--section', '## 未蒸留', '--content', '### 2026-09-22 新しいミス\n- 内容',
    ]);
    const replaced = readFileSync(shapeFile, 'utf8');
    const at = needle => replaced.indexOf(needle);
    check(at('### 2026-09-22 新しいミス') > at('## 未蒸留'), 'replace_section が節の外へ入った');
    check(at('### 2026-09-22 新しいミス') < at('## Relations'), 'replace_section が Relations の後ろへ入った');
    check(at('### 2026-09-20 既存のミス') !== -1, 'replace_section が節の中の既存の項目を消した');
    check(at('- distilled_into [[Correction Lessons]]') !== -1, 'replace_section が Relations を壊した');

    // (c) 節の中身が平らなリスト（lessons の形）だと replace_section は節ごと置き換える。
    //     手順書が「lessons には使わない」と書いている根拠。
    bmJson(
      ['tool', 'write-note', '--project', PROJECT, '--title', 'Correction Flat', '--folder', 'corrections', '--type', 'correction'],
      '---\npermalink: corrections/flat\n---\n\n# Correction Flat\n\n## 道具の癖\n\n1. 既存の教訓1\n2. 既存の教訓2\n\n## Relations\n- originated_from [[Correction Inbox]]\n',
    );
    bmJson([
      'tool', 'edit-note', 'corrections/flat', '--project', PROJECT,
      '--operation', 'replace_section', '--section', '## 道具の癖', '--content', '3. 新しい教訓3',
    ]);
    const flat = readFileSync(notePath('corrections/Correction Flat.md'), 'utf8');
    check(!flat.includes('既存の教訓1'), 'replace_section が平らなリストを残した（手順書の警告が古い）');
    return { afterRelations, flatKeptHistory: flat.includes('既存の教訓1') };
  });

  // 7. ここまでは bm の挙動しか見ておらず、手順書を旧「方法A」に書き戻しても全部 PASS する。
  //    手順書の側にも当て、書いてあるはずの形が消えていないことを確かめる（レビュー指摘）。
  await step('documents-still-say-it', () => {
    const skill = readFileSync(join(repoRoot, '.claude/skills/memory-manager/SKILL.md'), 'utf8');
    const agents = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');
    const missing = [];
    const want = (text, needle, where) => { if (!text.includes(needle)) missing.push(`${where}: ${needle}`); };
    want(skill, 'permalink: {カテゴリ}/{英語スラッグ}', 'SKILL.md');
    want(skill, 'type: {カテゴリの単数形}', 'SKILL.md');
    want(skill, '--operation append', 'SKILL.md');
    want(skill, '--overwrite', 'SKILL.md');
    // corrections は append ではなく節を狙う（レビュー 3 回目の指摘 1・2）。
    want(skill, '--operation replace_section --section "## 未蒸留"', 'SKILL.md');
    want(agents, 'bm tool read-note corrections/lessons --project mappy-memory', 'AGENTS.md');
    want(agents, '--section "## 未蒸留"', 'AGENTS.md');
    check(missing.length === 0, `手順書から必須の記述が消えている: ${missing.join(' / ')}`);
    // 旧「方法B」の heredoc をファイルへ書く形は、フック拒否を踏むので戻さない（LEV-184 指摘 6）。
    // 相対パス宛（`cat > memory/...`）も同じなので、リダイレクト先を問わず見る。
    check(!/cat >[^>]/.test(skill), 'SKILL.md にファイルへの heredoc 書き込みが戻っている（LEV-184 指摘 6）');
    // 公開リポジトリなので個人の絶対パスを置かない（LEV-184 指摘 7）。
    check(!skill.includes('/Users/'), 'SKILL.md に個人の絶対パスが戻っている（LEV-184 指摘 7）');
    return { missing };
  });
} catch (error) {
  record.failures.push(String(error));
} finally {
  if (keep) {
    console.log(added
      ? `--keep: ${PROJECT}（${root}）を残した。手で消す: bm project remove ${PROJECT} --delete-notes`
      : `--keep: プロジェクトは作られていない。一時ディレクトリだけ残した: ${root}`);
  } else {
    // プロジェクトを作れなかった経路でも一時ディレクトリは残るので、後片付けは add の成否と分ける。
    // bm() は spawn 失敗で throw する。finally の中で外へ抜けると rmSync も finish() も走らず、
    // 使い捨てのディレクトリとプロジェクトが残ったまま、JSON も書かれずに終わる。ここで捕まえる。
    if (added) {
      try {
        const removed = bm(['project', 'remove', PROJECT, '--delete-notes']);
        check(removed.status === 0, `使い捨てプロジェクトを消せなかった（手で消す: bm project remove ${PROJECT} --delete-notes）`);
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
        check(false, `後片付けの bm 呼び出しが失敗した（手で消す: bm project remove ${PROJECT} --delete-notes）: ${error}`);
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
