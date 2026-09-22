---
name: memory-manager
description: |
  Mappy 開発メモリ（Basic Memory, project mappy-memory）を読み書きするスキル。
  セッション開始時の corrections/lessons.md 確認、作業終了時の記録、
  カテゴリ判定、bm CLI での書き込み・検索の手順をまとめる。
  「メモリに保存」「作業ログを記録」「教訓を書く」「メモリを検索」等で起動。
---

# Memory Manager（Mappy 開発メモリ）

## 概要

Mappy 開発の知識を Basic Memory の形式で貯めるスキル。実体は Basic Memory のプロジェクト `mappy-memory`（プライマリーのチェックアウト配下の `memory/`）にある。

**`memory/` は `.gitignore` 対象なので、ワークツリーの中には存在しない。** 場所を打たずに、常に `--project mappy-memory` を付けた CLI で読み書きする。ワークツリーからでもプライマリーからでも同じ 1 か所に届く。ワークツリーの相対パス（`./memory/...`）にも、プライマリーの絶対パスにも直接書かない — 前者はディレクトリごと存在せず、後者は各自のチェックアウト位置に依存する。

`artifacts/` との役割の違い、ディレクトリ構成、Observations/Relations の正式なフォーマットは `memory/README.md` と `memory/schemas/*.md` が正本。このスキルはそれらに書き込む手順だけを扱い、内容の正はそちらに譲る。

## セッション開始時

AGENTS.md に同じコマンドが書いてある。このスキルはトリガー起動でセッション開始時には読み込まれないので、実行済みの想定で始めてよい。未実行なら今ここで実行する。

1. 蒸留された教訓を読む。

   ```sh
   bm tool read-note corrections/lessons --project mappy-memory
   ```

2. タスクに関連するノートを検索する。

   ```sh
   bm tool search-notes "{検索語}" --project mappy-memory
   ```

## カテゴリ判定

`memory/schemas/*.md` が正。この表は判定の早見表であり、frontmatter のフィールドはスキーマ側を見る。`type` の値（`{カテゴリの単数形}`）は frontmatter に必ず書く（下記「frontmatter の permalink と type」）。

| 何をした | `type` | 保存先（`--folder`） |
| --- | --- | --- |
| 実装・機能追加・リファクタリング・リリース | `event` | `events` |
| バグの調査と修正 | `bugfix` | `bugfixes` |
| 原因調査・アーキテクチャ探索・性能計測 | `investigation` | `investigations` |
| 設計決定・技術選定 | `design` | `designs` |
| `/code-review` の所見と対応 | `review` | `reviews` |
| ミスをした・失敗した | `correction` | `corrections/inbox` へ追記（下記「corrections」） |

`memory/` 直下にはファイルを置かない。必ずカテゴリのディレクトリ配下に置く。

## 書き込み

書き込みは `bm tool write-note`（新規）と `bm tool edit-note`（既存）の 2 つだけ。どちらも書いた内容をその場で検索索引に反映するので、**`bm reindex` は要らない**（`npm run harness:e2e:memory-procedure` がこれを毎回確かめる）。ファイルを直接開いて書かない — 索引が更新されないので、`search-notes` は書き換える前の内容を返し続ける（直し方は下記「索引が壊れたとき」）。

### 新しいノートを作る

本文は stdin から渡す（`--content` を省略すると stdin を読む）。`--content "$(...)"` に長い本文を詰めるより素直で、パスを 1 つも打たずに済む。

```sh
bm tool write-note --project mappy-memory \
  --title "{YYYY-MM-DD タイトル}" \
  --folder "{カテゴリ}" \
  --tags "{タグ1},{タグ2}" <<'NOTE'
---
permalink: {カテゴリ}/{英語スラッグ}
type: {カテゴリの単数形}
ticket: LEV-{番号}
---

# {タイトル}

## Observations
- [category] 内容 #tag (補足)

## Relations
- relates_to [[関連ノート]]
NOTE
```

### frontmatter の permalink と type

**この 2 行を省略しない。** どちらも既定に落ちると、書けたように見えて後から辿れない。

- `permalink:` を省くと `mappy-memory/{カテゴリ}/{タイトルのスラッグ}` になる。**プロジェクト名が前に付き**、日本語タイトルはローマ字混じりの断片（例: `2026-09-22-検証-no-to-a1-方法-ano-主-komando`）になる。`{カテゴリ}/{英語スラッグ}` の形から外れると `bm tool read-note {カテゴリ}/{スラッグ}` と他のノートからの `[[wiki link]]` の当てが外れる。明示した値は前置されずそのまま採用される。
- `type:` を省くと `note` になる（`--type` の既定値）。`bm tool search-notes --type {型}` と `bm tool schema-validate {型}` はこの値で引くので、`note` のままだと `memory/schemas/*.md` の検証からも型別の検索からも外れる。`--type` フラグでも指定できるが、frontmatter 側が優先される。置き場所を 1 つに決めて frontmatter に書く。

**MCP の `write_note()` は使わない**（パス二重化の不具合がある）。ただし **permalink の前置は MCP に固有ではなく、CLI でも同じように起きる。** 効いているのは frontmatter の `permalink:` の明示であって、CLI への切り替えではない。

> この回避策が成り立つ前提: frontmatter に `permalink` があれば、Basic Memory はそれを自動生成より優先する（0.22.1 で実測）。崩れる条件: 将来 Basic Memory が自動生成を優先する、または permalink の名前空間規則を変える。`npm run harness:e2e:memory-procedure` が毎回この前提を確かめる。

### 既存のノートに追記する

```sh
bm tool edit-note {permalink} --project mappy-memory \
  --operation append --content "{追記する本文}"
```

同じ `--title` で `write-note` をもう一度打つと、終了コード 1 と `NOTE_ALREADY_EXISTS` で終わる。

```json
{ "title": "...", "permalink": "...", "file_path": null, "action": "conflict", "error": "NOTE_ALREADY_EXISTS" }
```

**`file_path` が `null` で、何も書かれていない。** 形が成功時と同じ JSON なので成功と読み違えやすい。`action` を見る。

`--overwrite` を足すと通るが、**ノート全体が置き換わり、過去の記録は残らない。** `corrections/inbox` のように積み上げるノートに `--overwrite` を使わない。

| やりたいこと | コマンド |
| --- | --- |
| 新しいノート | `write-note` |
| 末尾に足す | `edit-note --operation append` |
| 先頭に足す | `edit-note --operation prepend` |
| 節を差し替える | `edit-note --operation replace_section --section "## 節"` |
| 語を置き換える | `edit-note --operation find_replace --find-text "旧" --content "新"` |
| 丸ごと書き直す（過去の記録を捨ててよいときだけ） | `write-note --overwrite` |

存在しない permalink に `append` すると新規作成されるが、その permalink は `mappy-memory/` を前置した形になる。新規は `write-note` で作る。

### frontmatter とチケットの対応

`ticket`（LEV-番号）をノートの frontmatter に入れる。リリース済みなら `released_in`（0.x.y）も入れる。Linear と GitHub Release から辿り直せるようにするための対応で、対象フィールドを持たないスキーマ（`design` / `correction` など）に書くときも `ticket` は追加してよい。

### 証跡は artifacts/ に残し、パスで参照する

実行条件・生データ・スクリーンショット・計測値は `artifacts/` に置く。ノートには生データを貼らず、`artifacts/{パス}` への参照として書く（ノートと証跡の二重管理を避ける）。

## 検索

```sh
bm tool search-notes "{検索語}" --project mappy-memory
bm tool search-notes --type {型} --project mappy-memory      # 型で絞る
bm tool search-notes --permalink "{カテゴリ}/*" --project mappy-memory
bm tool schema-validate {型} --project mappy-memory          # スキーマとの差分
```

## corrections

流れ（`inbox` → `lessons` → `graduated` と、そこから `lessons` を消すこと）は `memory/schemas/correction.md` が正本。ここに写さない。ワークツリーにはファイルが無いので、コマンドで読む:

```sh
bm tool read-note schemas/correction --project mappy-memory
```

書き込みの当て方だけ:

```sh
# ミスをした直後 — inbox へ追記（--overwrite を使わない）
bm tool edit-note corrections/inbox --project mappy-memory \
  --operation append --content "{何をしたか・なぜか}"

# 蒸留した 1 行を lessons へ
bm tool edit-note corrections/lessons --project mappy-memory \
  --operation append --content "{教訓 1 行}"
```

どちらも既存のノートで、`append` の当て先がある。**無い permalink へ `append` すると、エラーにならず `mappy-memory/` を前置した別のノートができる**ので、新しく作るときは `write-note` を使う。

## 索引が壊れたとき

CLI 以外でファイルを触った場合だけ、索引を作り直す。

```sh
bm reindex --search -p mappy-memory
```

既定の `bm reindex -p mappy-memory` はベクトル埋め込みの再構築を含み、未構築のときは桁違いに重い（レビュー時の実測で 120 秒のタイムアウトを超えた。構築済みなら数秒）。テキスト検索を直したいだけなら `--search` で足りる。

## 手順が壊れていないかを確かめる

```sh
npm run harness:e2e:memory-procedure
```

使い捨ての Basic Memory プロジェクトを作り、この文書のコマンドをそのまま実行して期待どおりの結果かを確かめ、最後にプロジェクトごと消す。`mappy-memory` には触らない。この文書を直したら、同じブランチでこのケースも直す。

## リファレンス

- `references/knowledge-format.md` — Basic Memory のナレッジフォーマット（出典へのリンクと mappy-memory 固有の規則）。
- `memory/README.md`、`memory/schemas/*.md` — Mappy のディレクトリ構成とスキーマの正本（このスキルからは変更しない）。
