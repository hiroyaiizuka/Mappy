/**
 * `.claude/skills/memory-manager/SKILL.md` と AGENTS.md「開発メモリ」に書かれた bm CLI の手順を、
 * 書かれたとおりに実行して期待どおりに動くかを確かめるケース（docs/harness.md「開発メモリの手順」）。
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
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecord, finish, makeCheck, makeStep, parseArgs } from './case-runner.mjs';

const { flag, value } = parseArgs();
const jsonPath = value('--json');
const keep = flag('--keep');

const PROJECT = `mappy-memory-probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/** bm を 1 回呼ぶ。`input` を渡すと stdin から本文を流す（SKILL.md の heredoc と同じ経路）。 */
function bm(args, input) {
  const result = spawnSync('bm', args, { input, encoding: 'utf8' });
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

const probe = bm(['--version']);
if (probe.status !== 0) {
  console.error('bm CLI を実行できない（Basic Memory 未インストール）。このケースは実行していない。');
  process.exit(2);
}
const version = probe.stdout.trim();

const root = mkdtempSync(join(tmpdir(), 'mappy-memory-probe-'));
const record = createRecord(root, PROJECT);
record.bmVersion = version;
const step = makeStep(record);
const check = makeCheck(record);

const notePath = name => join(root, name);
const frontmatterOf = file => {
  const text = readFileSync(file, 'utf8');
  const end = text.indexOf('\n---', 4);
  return text.slice(0, end === -1 ? text.length : end + 4);
};

let added = false;
try {
  await step('project-add', () => {
    const run = bm(['project', 'add', PROJECT, root]);
    added = run.status === 0;
    check(added, `使い捨てプロジェクトを作れない: ${run.stderr || run.stdout}`);
    return { status: run.status, path: root };
  });
  if (!added) throw new Error('プロジェクトを作れなかったので以降は実行しない');

  // 1. permalink と type を省いた write-note が、何を既定に落とすか（SKILL.md「frontmatter の permalink と type」）。
  await step('defaults-drop-permalink-and-type', () => {
    const title = '2026-09-22 既定の確認';
    const out = bmJson(
      ['tool', 'write-note', '--project', PROJECT, '--title', title, '--folder', 'events', '--tags', 'probe'],
      '# 既定の確認\n\n## Observations\n- [tech] permalink と type を省いた #probe\n',
    );
    const permalink = out.json?.permalink ?? '';
    const file = notePath(`events/${title}.md`);
    const front = existsSync(file) ? frontmatterOf(file) : '';
    check(out.status === 0, `write-note が失敗した: ${out.stderr}`);
    check(permalink.startsWith(`${PROJECT}/`), `permalink にプロジェクト名が前置されなかった: ${permalink}`);
    check(/^type: note$/m.test(front), `type が既定の note にならなかった: ${front}`);
    return { permalink, type: front.match(/^type: (.+)$/m)?.[1] };
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
    const json = at === -1 ? null : JSON.parse(run.stdout.slice(at));
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
    check(!hits.some(hit => hit.startsWith(`${PROJECT}/`)), `type を落としたノートが --type event に混ざった: ${hits.join(', ')}`);
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
    bmJson(
      ['tool', 'write-note', '--project', PROJECT, '--title', 'Correction Inbox', '--folder', 'corrections', '--type', 'correction', '--overwrite'],
      '---\npermalink: corrections/inbox\n---\n\n# Correction Inbox\n\n## 2026-09-20\n- 既存の記録1\n',
    );
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
} catch (error) {
  record.failures.push(String(error));
} finally {
  if (added && !keep) {
    const removed = bm(['project', 'remove', PROJECT, '--delete-notes']);
    record.steps['project-remove'] = { status: removed.status };
    check(removed.status === 0, `使い捨てプロジェクトを消せなかった（手で消す: bm project remove ${PROJECT} --delete-notes）`);
    const listed = bmJson(['tool', 'list-projects']);
    const names = (listed.json?.projects ?? []).map(item => item.name);
    check(!names.includes(PROJECT), `使い捨てプロジェクトが残っている: ${PROJECT}`);
    check(!existsSync(root), `使い捨てのディレクトリが残っている: ${root}`);
    check(names.includes('mappy-memory'), 'mappy-memory がプロジェクト一覧から消えた（後片付けが行き過ぎた）');
  } else if (keep) {
    console.log(`--keep: ${PROJECT}（${root}）を残した。手で消す: bm project remove ${PROJECT} --delete-notes`);
  }
}

process.exit(await finish(record, jsonPath));
