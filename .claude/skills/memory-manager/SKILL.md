---
name: memory-manager
description: |
  Mappy 開発メモリ（Basic Memory, project mappy-memory）を読み書きするスキル。
  セッション開始時の corrections/lessons.md 確認、作業終了時の記録、
  カテゴリ判定、bm CLI での書き込み・検索の手順をまとめる。
  「メモリに保存」「作業ログを記録」「教訓を書く」「メモリを検索」等で起動。
---

<!-- ~/Desktop/Evergreens/.obsidian/plugins/taskchute-plus/.agents/skills/memory-manager（非公開・参考のみ）の構造を Mappy 向けに書き直したもの。-->

# Memory Manager（Mappy 開発メモリ）

## 概要

Mappy 開発の知識を Basic Memory の形式で貯めるスキル。実体はプライマリーの `memory/`（`/Users/hiroyaiizuka/orca/projects/Mappy/memory/`、Basic Memory のプロジェクト名は `mappy-memory`）にある。

**`memory/` は `.gitignore` 対象なので、ワークツリーの中には存在しない。** ワークツリーのエージェントも `--project mappy-memory` を付けた CLI で読み書きすれば、常にプライマリーの `memory/` に届く。ワークツリーの相対パス（`./memory/...`）には書かない — そこにはディレクトリごと存在しない。

`artifacts/` との役割の違い、ディレクトリ構成、Observations/Relations の正式なフォーマットは `memory/README.md` と `memory/schemas/*.md` が正本。このスキルはそれらに書き込む手順だけを扱い、内容の正はそちらに譲る。

## セッション開始時

1. `memory/corrections/lessons.md` を読む（蒸留された教訓。読んでも直前の判断で忘れやすいので、実際に思い出す用途で使う）。

   ```sh
   bm tool read-note corrections/lessons --project mappy-memory
   ```

2. タスクに関連するノートを検索する。

   ```sh
   bm tool search-notes "{検索語}" --project mappy-memory
   ```

## カテゴリ判定

`memory/schemas/*.md` が正。この表は判定の早見表であり、frontmatter のフィールドはスキーマ側を見る。

| 何をした | カテゴリ | 保存先 |
| --- | --- | --- |
| 実装・機能追加・リファクタリング・リリース | event | `events/` |
| バグの調査と修正 | bugfix | `bugfixes/` |
| 原因調査・アーキテクチャ探索・性能計測 | investigation | `investigations/` |
| 設計決定・技術選定 | design | `designs/` |
| `/code-review` の所見と対応 | review | `reviews/` |
| ミスをした・失敗した | correction | `corrections/inbox.md` に追記 |

`memory/` 直下にはファイルを置かない。必ずカテゴリのディレクトリ配下に置く。

## 書き込み

### 方法A: CLI（推奨。ノート作成と検索インデックス更新を同時に行う）

```sh
bm tool write-note --project mappy-memory \
  --title "{YYYY-MM-DD タイトル}" \
  --folder "{カテゴリ}" \
  --tags "{タグ1},{タグ2}" \
  --content "{本文（Observations・Relations を含む Markdown）}"
```

**日本語タイトルは permalink の自動生成が崩れる**（ローマ字混じりの断片になる）。`--content` の frontmatter に `permalink: {カテゴリ}/{英語スラッグ}` を明示すると、それが優先されて正しい permalink になる。

```sh
bm tool write-note --project mappy-memory \
  --title "{YYYY-MM-DD タイトル}" \
  --folder "{カテゴリ}" \
  --tags "{タグ1},{タグ2}" \
  --content "$(cat <<'EOF'
---
permalink: {カテゴリ}/{英語スラッグ}
ticket: LEV-{番号}
---

# {タイトル}

## Observations
- [category] 内容 #tag
EOF
)"
```

### 方法B: heredoc + reindex（長い本文など `--content` に収まらない場合）

```sh
cat > "/Users/hiroyaiizuka/orca/projects/Mappy/memory/{カテゴリ}/{YYYY-MM-DD タイトル}.md" << 'MEMO_EOF'
---
title: {タイトル}
type: {カテゴリ}
tags: [tag1, tag2]
ticket: LEV-{番号}
permalink: {カテゴリ}/{ファイル名（拡張子なし）}
---

# {タイトル}

## Observations
- [category] 内容 #tag (補足)

## Relations
- relates_to [[関連ノート]]
MEMO_EOF

bm reindex --project mappy-memory
```

heredoc のパスは常にプライマリーのフルパス（`/Users/hiroyaiizuka/orca/projects/Mappy/memory/...`）を使う。ワークツリーの相対パスに書いても `mappy-memory` プロジェクトには反映されない。

**MCP の `write_note()` は使わない** — パス二重化の不具合がある。書き込みは常に CLI（`bm tool write-note`）か、heredoc + `bm reindex` のどちらかにする。

### frontmatter とチケットの対応

`ticket`（LEV-番号）をノートの frontmatter に入れる。リリース済みなら `released_in`（0.x.y）も入れる。Linear と GitHub Release から辿り直せるようにするための対応で、対象フィールドを持たないスキーマ（`design` / `correction` など）に書くときも `ticket` は追加してよい。

### 証跡は artifacts/ に残し、パスで参照する

実行条件・生データ・スクリーンショット・計測値は `artifacts/` に置く。ノートには生データを貼らず、`artifacts/{パス}` への参照として書く（ノートと証跡の二重管理を避ける）。

## 検索

```sh
bm tool search-notes "{検索語}" --project mappy-memory
```

## corrections の 4 層フロー

1. `inbox.md` — ミスをした直後に追記する。
2. `lessons.md` — セッション開始時に inbox を確認し、1 行に蒸留して移す。毎セッション読む。
3. `graduated.md` — AGENTS.md・テスト・lint・CI に仕組み化できたら移す。
4. 仕組み化したら `lessons.md` から消す（`graduated.md` に記録済みのため）。

## リファレンス

- `references/knowledge-format.md` — Basic Memory 公式のナレッジフォーマット定義（Observations・Relations・Frontmatter・Permalink の正式な書き方）。
- `memory/README.md`、`memory/schemas/*.md` — Mappy のディレクトリ構成とスキーマの正本（このスキルからは変更しない）。
