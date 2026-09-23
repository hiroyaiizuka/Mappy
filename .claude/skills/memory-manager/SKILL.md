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

- `permalink:` を省くと `mappy-memory/{カテゴリ}/{タイトルのスラッグ}` になる。明示した値は前置されずそのまま採用される。省略が壊すものは 2 つあり、**原因が別**なので分けて覚える。
  - **プロジェクト名の前置**は `bm tool search-notes --permalink "{カテゴリ}/*"` を外す（前置された分が結果から漏れる）。一方 `bm tool read-note {カテゴリ}/{スラッグ}` と `[[wiki link]]` は**前置されていても当たる** —— どちらもタイトル経由の解決が効くため（Basic Memory 0.22.1 で実測）。
  - **日本語タイトルのスラッグ崩れ**は当てを完全に外す。`2026-09-22 検証ノート` が `2026-09-22-検証-no-to` のようなローマ字混じりの断片になり、**書いた本人にも予測できない**ので、意図した `{カテゴリ}/{英語スラッグ}` では `read-note` も `[[wiki link]]` も空振りする。
- `type:` を省くと `note` になる（`--type` の既定値）。`bm tool search-notes --type {型}` と `bm tool schema-validate {型}` はこの値で引くので、`note` のままだと `memory/schemas/*.md` の検証からも型別の検索からも外れる。`--type` フラグでも指定できるが、frontmatter 側が優先される。置き場所を 1 つに決めて frontmatter に書く。

**MCP の `write_note()` は使わない**（パス二重化の不具合がある）。ただし **permalink の前置は MCP に固有ではなく、CLI でも同じように起きる。** 効いているのは frontmatter の `permalink:` の明示であって、CLI への切り替えではない。

> この回避策が成り立つ前提: frontmatter に `permalink` があれば、Basic Memory はそれを自動生成より優先する（0.22.1 で実測）。崩れる条件: 将来 Basic Memory が自動生成を優先する、または permalink の名前空間規則を変える。`npm run harness:e2e:memory-procedure` が毎回この前提を確かめる。

### 既存のノートに追記する

```sh
bm tool edit-note {permalink} --project mappy-memory \
  --operation append --content '{追記する本文}'
```

本文は**シングルクォート**で囲む。中はシェルが何も展開しないので、本文のバッククォート・`$`・`"` はそのまま入る。**本文に `'` を書くときだけ `'\''` と書く**。二重引用符で囲むと、`` `leaf.setViewState` `` のようなコードの語や `$HOME` がシェルに展開され、**終了コード 0 のまま黙って消える・化ける**（下記「corrections」も同じ）。

`append` は行の継ぎ目の改行を自分で入れるので、`--content` の先頭に改行を置かなくても前の行に癒着しない（続けて何度打っても別々の行に入る。`npm run harness:e2e:memory-procedure` の `repeated-append-does-not-glue-lines` が固定している）。日付の見出しなどで区切りたいときだけ、先頭に空行を 1 つ足す。

同じ `--title` で `write-note` をもう一度打つと、終了コード 1 と `NOTE_ALREADY_EXISTS` で終わる。

```json
{ "title": "...", "permalink": "...", "file_path": null, "action": "conflict", "error": "NOTE_ALREADY_EXISTS" }
```

**`file_path` が `null` で、何も書かれていない。** 形が成功時と同じ JSON なので成功と読み違えやすい。`action` を見る。

**既存のノートを書き換えるときは、必ず permalink を指定する `edit-note` を使う。`write-note` は新規専用。** `--overwrite` を足すと通るが、当たるのは `--folder` と `--title` から決まるパス `{folder}/{title}.md` のファイルだけで、permalink でも frontmatter の `title` でも探さない。

- そのパスにファイルがあれば、**ノート全体が置き換わり、過去の記録は残らない。**
- 無ければ（ファイル名とタイトルが違うノート）、**既存のノートは変わらず、`{title}.md` という別のノートが作られる。** `corrections/` の 3 つはどれもこの形（`inbox.md` に `Correction Inbox`、`lessons.md` に `Correction Lessons`、`graduated.md` に `Correction Graduated`）で、`--title "Correction Inbox" --folder corrections --overwrite` は `corrections/Correction Inbox.md` を新しく作る。新しいノートの permalink は渡した本文で変わり、frontmatter に `permalink: corrections/inbox` を書いていれば衝突を避けて `corrections/inbox-1`（2026-09-23 に実際に踏んだ形）、書いていなければ `mappy-memory/corrections/correction-inbox` になる（`npm run harness:e2e:memory-procedure` の `overwrite-with-different-filename-creates-another-note` が両方を固定している）。

| やりたいこと | コマンド |
| --- | --- |
| 新しいノート | `write-note` |
| ファイル末尾に足す | `edit-note --operation append`（末尾が `## Relations` のノートではその後ろに落ちる） |
| ファイル先頭に足す | `edit-note --operation prepend` |
| 節を差し替える | `edit-note --operation replace_section --section "## 節"`（見出しから**次の見出し（レベルを問わない）まで**を置き換える。節の中身が平らなリストなら全部消え、`###` で始まる節なら最初の `###` の手前しか置き換わらない） |
| 目印の前に差し込む・語を置き換える | `edit-note --operation find_replace --find-text '目印' --content '新しい本文と目印'`（目印が 1 か所に当たらないと終了コード 1 で何も書かない。シングルクォートで囲み、改行はその中で実際に改行して渡す —— `\n` と書いても改行にならず、その 2 文字がそのまま入る。本文の `'` は `'\''` と書く。下記「corrections」） |
| 丸ごと書き直す（過去の記録を捨ててよいときだけ） | `write-note --overwrite`。ファイル名が `{folder}/{title}.md` のノートにしか当たらない（上記） |

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

**`append` を使わない。** `inbox` も `lessons` も末尾が `## Relations` で、書き足したい節はその上にある。`append` は必ず**ファイル末尾**に足すので、ミスの記録が Relations の後ろに落ちて、節の構造も蒸留の動線も崩れる。

```sh
# ミスをした直後 — inbox の「## 未蒸留」の末尾（行頭の ## Relations の直前）に 1 件足す
bm tool edit-note corrections/inbox --project mappy-memory \
  --operation find_replace --find-text '
## Relations
' --content '
### {YYYY-MM-DD 見出し}
- {何をしたか・なぜか}

## Relations
'
```

形をそのまま写す。

- `--find-text` と `--content` は**シングルクォートで囲み、開いた直後と閉じる直前で改行する**。目印は「改行＋`## Relations`＋改行」、つまり**それだけが書かれた行**の `## Relations` 見出しで、エントリの本文に `` `## Relations` `` と書いてあっても、`## Relations の…` で始まる行があっても当たらない。`\n` と書いても改行にはならない（bm は引数の `\n` を解釈しない）ので、見出しが前の行に潰れて Relations の節が壊れる。
- シングルクォートの中はシェルが何も展開しないので、本文のバッククォート・`$`・`"`・`)` はそのまま入る。**本文に `'` を書くときだけ `'\''` と書く**（`it's` → `it'\''s`）。二重引用符で囲むと、本文のバッククォートや `$` がシェルに展開され、`` `append` `` のような語が**終了コード 0 のまま黙って消える**。`"$(cat <<'EOF' … EOF)"` の形も使わない —— macOS の `/bin/sh`（bash 3.2）はコマンド置換の中の heredoc を読み違え、対になっていない `)` や `'` で本文が壊れるか構文エラーになる。

`--content` には**新しい 1 件と `## Relations` だけ**を渡す。既存のエントリを含めない。`## 未蒸留` は `inbox` の最後の節なので、行頭の `## Relations` の前に差し込めば節の末尾に古い順で積まれ、既存のエントリとの間の空行も保たれる（`documented-inbox-entry` が、本文に `` `## Relations` `` を含む inbox に対して、差し込み口に対になっていないバッククォート・`$`・`"`・`)`・`'` を入れたこのコードブロックを `sh` でそのまま実行して確かめている）。

目印が 1 か所に当たらないときは、終了コード 1 で**何も書かずに止まる**。行頭の `## Relations` が 2 つあれば `Error: Expected 1 occurrences …`、無ければ `Error: Text to replace not found …`。打ち直す前に `read-note` で inbox の形が崩れていないかを見る。

> この手順が成り立つ前提: `## 未蒸留` が inbox の最後の節で、その次の見出しが行頭の `## Relations` であること（2026-09-23 時点の実物はこの形）。崩れる条件: `## 未蒸留` と `## Relations` の間に別の節が足される —— そのときも目印は 1 か所に当たるので、**止まらずに、その別の節の末尾へ黙って入る**（`inbox-replace-section-duplicates-find-replace-does-not` の (f) が固定している）。打つ前に `read-note` で `## 未蒸留` の次の見出しが `## Relations` であることを見る。inbox に節を足す変更をしたら、同じ変更でこの手順とケースを直す。

**`## 未蒸留` に `replace_section` を使わない。** `replace_section` は見出しから次の見出し（レベルを問わない）までを置き換えるので、`## 未蒸留` の直後に `###` のエントリが続く `inbox` では、置き換わるのは見出しと最初の `###` の間の空の範囲だけ。既存＋新規の全文を渡すと既存のエントリが必ず重複する（2026-09-23 に 2 回重複した）。新しい 1 件だけを渡せば重複はしないが、節の先頭（既存の前）に入って並びが逆になり、既存との間の空行も落ちる（どちらも `inbox-replace-section-duplicates-find-replace-does-not` が固定している）。

**`lessons` に `replace_section` を使わない。** `## 道具の癖`・`## 手順`・`## 報告` の中身は番号付きの平らなリストで、次の見出しまでの全部が消える。蒸留した 1 行を足すときは、`read-note` で今の中身を読み、`find_replace` で並びの目印の前に差し込む。

```sh
bm tool read-note corrections/lessons --project mappy-memory   # 今の並びと番号を見る
bm tool edit-note corrections/lessons --project mappy-memory \
  --operation find_replace --find-text '
## 手順
' --content '
{N}. **{教訓 1 行}**
## 手順
'
```

inbox と同じく、`--find-text` と `--content` はシングルクォートで囲んで開いた直後と閉じる直前で改行し、本文の `'` だけ `'\''` と書く。目印はそれだけが書かれた行の `## 手順` 見出しで、教訓の本文に `` `## 手順` `` と書いてあっても、`## 手順書…` で始まる行があっても当たらない。`lessons` の節は見出しの直前に空行を置かない形なので、`--content` も空行を挟まない（`documented-lessons-entry` がこのコードブロックをそのまま実行して確かめている）。

- **足す節によって、`--find-text` の見出しと `--content` の最後の行の見出しを同じものに変える。** `## 道具の癖` に足すなら両方 `## 手順`（上のブロックのまま）、`## 手順` に足すなら両方 `## 報告`、`## 報告` に足すなら両方 `## Relations`。`--find-text` だけを変えると、目印の見出しが別の見出しに置き換わり、節が重複・消失したまま終了コード 0 で終わる。
- **`{N}` は、どの節に足すときも lessons 全体で最大の番号＋1**。番号は並び順ではなく教訓を指す名前で、inbox などが「lessons 12」のように番号で参照しているので、既存の番号を振り直さない（節の途中に大きい番号が入ってよい）。

**無い permalink へ `append` や `replace_section` を打つと、エラーにならず `mappy-memory/` を前置した別のノートができる**ので、当て先が在ることを `read-note` で確かめてから打つ。`find_replace` は `Error: Entity not found`（終了コード 1）で止まり、何も作らない。新しく作るときは `write-note`。

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

使い捨ての Basic Memory プロジェクトを作り、この文書のコマンドをそのまま実行して期待どおりの結果かを確かめ、最後にプロジェクトごと消す。`mappy-memory` には触らない。

固定しているのは 2 つ。**bm CLI の挙動**（permalink・type の既定、`--overwrite` と `append` の違い、ファイル名とタイトルが違うノートへの `--overwrite`、`inbox` の形の節への `replace_section` と `find_replace`、`reindex` 無しで索引に入ること）と、**この文書に必須の記述が残っていること**（`permalink: {カテゴリ}/{英語スラッグ}`・`type: {カテゴリの単数形}`・`--operation append`・`--overwrite`・`{folder}/{title}.md`・inbox の行頭の `## Relations` を目印にした `find_replace` の各記述、`## 未蒸留` を狙う `replace_section` の指定とファイルへの heredoc 書き込みと個人の絶対パスが戻っていないこと）。corrections の 2 つのコードブロック（inbox の「ミスをした直後」と lessons への差し込み）は、抜き出して、差し込み口に対になっていないバッククォート・`$`・`"`・`)`・`'` を入れ、使い捨てプロジェクトで `sh` からそのまま実行する。書いた説明文が正しいかまでは見ないので、この文書を直したら同じブランチでケースの側も直す。

## リファレンス

- `references/knowledge-format.md` — Basic Memory のナレッジフォーマット（出典へのリンクと mappy-memory 固有の規則）。
- `memory/README.md`、`memory/schemas/*.md` — Mappy のディレクトリ構成とスキーマの正本（このスキルからは変更しない）。
