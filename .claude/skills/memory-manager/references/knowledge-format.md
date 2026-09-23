<!-- Basic Memory のナレッジフォーマットは公式ドキュメントが正本。ここには出典へのリンクと、mappy-memory 固有の規則だけを置く。書き込みの手順は SKILL.md 側。 -->

# ナレッジフォーマット（mappy-memory）

## 出典

frontmatter・Observations・Relations・permalink・スキーマの正式な定義は Basic Memory の公式ドキュメントにある。迷ったらこちらを読む。

- Knowledge Format — <https://docs.basicmemory.com/concepts/knowledge-format>
- Basic Memory 本体 — <https://github.com/basicmachines-co/basic-memory>

以前このファイルは当時のページを全文写していた。写しは置かない。理由は 2 つある。

- **古くなる。** 写しは `edit-note`・`write-note --overwrite`・`schema-validate` のいずれにも触れておらず、その欠落が「追記のしかたが書かれていない」「推奨手順が `type` を落とす」という手順書の欠陥をそのまま生んだ（LEV-184）。現行ページはすでに見出し構成から違う。
- **写した文書のライセンスを確かめていない。** Mappy は公開リポジトリ（MIT。GitHub Release ＋ BRAT で配布中）なので、他所の文書の全文を出典・版・ライセンス表記なしで同梱しない。

## 形（最小限の控え）

```markdown
---
title: Document Title
type: note
tags: [tag1, tag2]
permalink: folder/note-name
---

# Document Title

## Observations
- [category] 内容 #tag (補足)

## Relations
- relates_to [[Other Document]]
```

- Observations は `[category]` で始まるリスト項目。チェックボックス（`[ ]` / `[x]`）は Observations として扱われない。
- Relations は関係の語で始まり `[[wiki link]]` が続くリスト項目。語がそのまま関係の種類になる（`implements` / `depends_on` / `relates_to` / `extends` / `part_of` など）。
- permalink はノートの安定した識別子で、`bm tool read-note <permalink>` と他のノートからの `[[wiki link]]` の当て先になる。

## mappy-memory 固有の規則

- **permalink は `{カテゴリ}/{英語スラッグ}` にする。** カテゴリは `memory/README.md` のディレクトリ名（`events` / `bugfixes` / `investigations` / `designs` / `reviews` / `corrections` / `archive`）。例: `bugfixes/2026-09-22-paste-image-node-not-found`。
- **permalink と type は frontmatter に必ず書く。** 省略するとそれぞれ既定に落ち、permalink はプロジェクト名を前置した自動生成（日本語タイトルはローマ字混じりの断片）に、type は `note` になる。理由と実測は SKILL.md「frontmatter の permalink と type」。
- `ticket`（LEV-番号）を入れる。リリース済みなら `released_in`（0.x.y）も。
- 生データ・スクリーンショット・計測値はノートに貼らず、`artifacts/{パス}` への参照として書く。
