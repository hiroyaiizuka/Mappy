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
  //     手順書が corrections に append を禁じている理由と、lessons に replace_section を使わない理由を固定する。
  const inboxShape = [
    '---', 'permalink: corrections/shape', '---', '',
    '# Correction Inbox', '', '## 未蒸留', '', '### 2026-09-20 既存のミス', '- 内容', '',
    '## Relations', '- distilled_into [[Correction Lessons]]', '',
  ].join('\n');
  await step('append-lands-after-relations-flat-replace-section-wipes', () => {
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
    check(afterRelations, 'append が Relations より前に入った（手順書が corrections に append を禁じている理由が消えている）');

    // (b) inbox の形（`###` で区切られた節）への replace_section は、下の 6d で固定する。

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
  // エントリの本文が見出しを引用している形。この手順についての記録は自然にこうなる（レビュー指摘）。
  const quotingInbox = realInbox.replace('- 内容A', '- 内容A: 末尾が `## Relations` なので append は後ろに落ちる');
  const realInboxFile = notePath('corrections/Correction Real Inbox.md');
  const resetRealInbox = (content = realInbox) => bmJson(
    ['tool', 'write-note', '--project', PROJECT, '--title', 'Correction Real Inbox', '--folder', 'corrections', '--type', 'correction', '--overwrite'],
    content,
  );
  const editRealInbox = args => bmJson(['tool', 'edit-note', 'corrections/real-inbox', '--project', PROJECT, ...args]);
  const count = (text, needle) => text.split(needle).length - 1;
  const said = run => `${run.stdout}${run.stderr}`;

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

    // (d) `--content` の `\n` は改行にならず、2 文字のまま入る。手順書が引用符の中で実際に改行させる理由（レビュー指摘）。
    check(resetRealInbox().status === 0, '下準備 (d)（inbox の形のノート）を作れなかった');
    const escaped = editRealInbox(['--operation', 'find_replace', '--find-text', '\n## Relations', '--content', '\n### 2026-09-23 新C\\n\\n## Relations']);
    const escapedText = readFileSync(realInboxFile, 'utf8');
    check(escaped.status === 0, `(d) の find_replace が失敗した: ${said(escaped)}`);
    check(escapedText.includes('### 2026-09-23 新C\\n\\n## Relations'), `--content の \\n が改行として解釈された（手順書の警告が古い）: ${JSON.stringify(escapedText.slice(-80))}`);
    check(!/^## Relations$/m.test(escapedText), '--content の \\n を使った書き込みで行頭の ## Relations が残った（手順書の警告が古い）');

    // (e) append・replace_section と違い、無い permalink への find_replace はエラーで止まり、何も作らない
    //     （ステップ 6 と対。手順書が「find_replace は当て先を間違えても黙って別のノートを作らない」と書く根拠）。
    const missing = bmJson([
      'tool', 'edit-note', 'corrections/not-created-for-find', '--project', PROJECT,
      '--operation', 'find_replace', '--find-text', '## Relations', '--content', '### 2026-09-23 新C\n\n## Relations',
    ]);
    const leaked = bmJson(['tool', 'read-note', `${PROJECT}/corrections/not-created-for-find`, '--project', PROJECT]);
    check(missing.status === 1 && said(missing).includes('Entity not found'), `無い permalink への find_replace が「Entity not found」の終了コード 1 で止まらなかった: [${missing.status}] ${said(missing)}`);
    check(!existsSync(notePath('corrections/not-created-for-find.md')) && leaked.json?.file_path == null, '無い permalink への find_replace がノートを作った');
    return { fullDuplicates: count(full, '### 2026-09-20 既存A'), ambiguousStatus: ambiguous.status, missingStatus: missing.status };
  });

  // 6e. SKILL.md の「ミスをした直後」のコードブロックを抜き出して、書かれたとおりに実行する（LEV-192）。
  //     当て先と project だけを差し替え、`{…}` の差し込み口はそのまま文字として入れる。本文が見出しを引用して
  //     いる inbox に対して、既存が重複も消失もせず、新しい 1 件が既存の後ろ・Relations の前に空行で区切られて
  //     入ることを見る。
  await step('documented-inbox-entry', () => {
    check(resetRealInbox(quotingInbox).status === 0, '下準備（本文が見出しを引用する inbox）を作れなかった');
    const skill = readFileSync(join(repoRoot, '.claude/skills/memory-manager/SKILL.md'), 'utf8');
    const blocks = [...skill.matchAll(/```sh\n([\s\S]*?)```/g)].map(match => match[1])
      .filter(block => block.includes('edit-note corrections/inbox'));
    check(blocks.length === 1, `SKILL.md に inbox へ書くコードブロックが 1 つでない: ${blocks.length} 個`);
    if (blocks.length !== 1) return { blocks: blocks.length };
    const script = blocks[0]
      .replaceAll('edit-note corrections/inbox', 'edit-note corrections/real-inbox')
      .replaceAll('--project mappy-memory', `--project ${PROJECT} --local`);
    // 置き換えが効いたことを正の条件で確かめ、それ以外は実行しない（レビュー指摘）。`-p mappy-memory` や
    // `--project=…` や project の省略に書き換えられると、置き換えが空振りして本物の mappy-memory に当たる。
    // 使い捨てプロジェクトの名前も mappy-memory で始まるので、その名前を消してから残りを見る。
    const rest = script.replaceAll(PROJECT, '');
    const problems = [
      count(script, 'bm ') !== 1 && `bm の呼び出しが 1 つでない（${count(script, 'bm ')} 個）`,
      count(script, `--project ${PROJECT} --local`) !== 1 && '使い捨てプロジェクトへの --project が 1 つでない',
      /mappy-memory/.test(rest) && 'mappy-memory が残っている',
      /(^|\s)-p(\s|=)|--project=/.test(script) && '--project 以外の形で project を指定している',
      /corrections\/inbox(?![\w-])/.test(script) && '当て先が corrections/inbox のまま',
    ].filter(Boolean);
    check(problems.length === 0, `抜き出したコマンドを使い捨てプロジェクトへ向けられない（${problems.join(' / ')}）: ${script}`);
    if (problems.length > 0) return { script, problems };
    const run = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
    const text = readFileSync(realInboxFile, 'utf8');
    const heading = text.match(/^### \{[^\n]*$/m)?.[0] ?? '';
    const at = needle => text.indexOf(needle);
    check(run.status === 0, `手順書のコマンドが失敗した: ${run.stderr || run.stdout}`);
    check(count(text, '### 2026-09-20 既存A') === 1 && count(text, '### 2026-09-21 既存B') === 1, '手順書どおりの書き込みで既存のエントリが重複・消失した');
    check(text.includes('末尾が `## Relations` なので append は後ろに落ちる'), '手順書どおりの書き込みが、見出しを引用した本文を書き換えた');
    check(heading !== '' && count(text, heading) === 1, `新しいエントリが 1 回だけ入っていない: ${JSON.stringify(heading)}`);
    check(at(heading) > at('### 2026-09-21 既存B'), '新しいエントリが既存の後ろに入らない（inbox は古い順に積む）');
    check(at(heading) < at('\n## Relations\n'), '新しいエントリが Relations の後ろに入った');
    check(/- 内容B\n\n### \{/.test(text), '既存のエントリと新しいエントリの間に空行が無い');
    check(/\n\n## Relations\n- distilled_into \[\[Correction Lessons\]\]/.test(text), 'Relations の手前の空行か Relations 自体が崩れた');
    return { heading, status: run.status };
  });

  // 6f. ファイル名とタイトルが違うノート（実物の corrections/inbox・lessons・graduated はどれも
  //     `inbox.md` に `title: Correction Inbox`）へ write-note --overwrite を打つと、既存は変わらず
  //     `{folder}/{title}.md` の新しいノートができる（LEV-192。2026-09-23 に実際に踏んだ）。
  //     write-note は --title でタイトルを決めるので、作ってから frontmatter の title だけを差し替えて実物の形にする。
  await step('overwrite-with-different-filename-creates-another-note', () => {
    const made = bmJson(
      ['tool', 'write-note', '--project', PROJECT, '--title', 'inbox', '--folder', 'shaped', '--type', 'correction'],
      '---\npermalink: shaped/inbox\n---\n\n# Correction Inbox\n\n- 既存の記録1\n',
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
    const out = bmJson(
      ['tool', 'write-note', '--project', PROJECT, '--title', 'Correction Inbox', '--folder', 'shaped', '--type', 'correction', '--overwrite'],
      '---\npermalink: shaped/inbox\n---\n\n# Correction Inbox\n\n- 書き直した全文\n',
    );
    const other = notePath('shaped/Correction Inbox.md');
    check(out.status === 0, `--overwrite が失敗した: ${out.stderr}`);
    check(readFileSync(existing, 'utf8') === before, '--overwrite がファイル名の違う既存のノートを書き換えた（手順書の警告が古い）');
    check(existsSync(other), '--overwrite が {folder}/{title}.md の新しいノートを作らなかった（手順書の警告が古い）');
    // 手順書は 2026-09-23 の実例として permalink `corrections/inbox-1` を挙げている。その形も固定する。
    check(out.json?.permalink === 'shaped/inbox-1', `新しいノートの permalink が {既存}-1 にならなかった（手順書の実例が古い）: ${out.json?.permalink}`);
    check(bmJson(['tool', 'read-note', 'shaped/inbox', '--project', PROJECT]).json?.file_path === 'shaped/inbox.md', '--overwrite のあと shaped/inbox が既存のファイルを指さなくなった');
    if (out.json?.permalink) bm(['tool', 'delete-note', out.json.permalink, '--project', PROJECT]);
    return { createdPermalink: out.json?.permalink, createdFile: out.json?.file_path };
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
    // corrections は append ではなく行頭の `## Relations` の前に差し込む（LEV-192。旧手順は replace_section で重複した）。
    // 実際の改行を含む目印そのものは、documented-inbox-entry がコードブロックを実行して確かめる。
    want(skill, '--operation find_replace --find-text "\n## Relations"', 'SKILL.md');
    want(agents, 'bm tool read-note corrections/lessons --project mappy-memory', 'AGENTS.md');
    want(agents, 'edit-note corrections/inbox --operation find_replace', 'AGENTS.md');
    want(agents, '**行頭の** `## Relations`', 'AGENTS.md');
    // --overwrite が当たるのはタイトルから決まるパスだけで、既存の書き換えは edit-note（LEV-192）。
    want(skill, '{folder}/{title}.md', 'SKILL.md');
    want(agents, '{folder}/{title}.md', 'AGENTS.md');
    want(skill, '`write-note` は新規専用', 'SKILL.md');
    want(agents, '`write-note` は新規専用', 'AGENTS.md');
    check(missing.length === 0, `手順書から必須の記述が消えている: ${missing.join(' / ')}`);
    // inbox の `## 未蒸留` を replace_section で狙う旧手順は、既存のエントリを重複させる（LEV-192）。
    check(!skill.includes('--section "## 未蒸留"'), 'SKILL.md に inbox への replace_section が戻っている（LEV-192）');
    check(!agents.includes('--section "## 未蒸留"'), 'AGENTS.md に inbox への replace_section が戻っている（LEV-192）');
    // `--content "…\n…"` は改行にならず、見出しが 1 行に潰れる（LEV-192 レビュー指摘）。
    const escapedContent = /--content "[^"]*\\n/;
    check(!escapedContent.test(skill), 'SKILL.md の --content に \\n が戻っている（改行にならない）');
    check(!escapedContent.test(agents), 'AGENTS.md の --content に \\n が戻っている（改行にならない）');
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
