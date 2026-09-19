---
title: 埋め込みの検証（M10）
tags: [mappy-fixture]
---
# 埋め込みの検証

このノートは `mappy: true` を持たない通常のノートで、Mappy のマップを `![[ノート]]` で埋め込む。閲覧モード・ライブプレビュー・ホバープレビューのそれぞれで、下の埋め込みが読み取り専用のマップ（ルートと第一階層、以下は折りたたみ）として描かれ、このノートも元ノートも書き換わらないことを確認する（docs/harness.md E31）。

## 通常マップ

![[uneven-branches]]

## タイムライン（元ノートの mappy-layout に従う）

![[embed-timeline]]

## 階層図

![[embed-hierarchy]]

## 見出しの部分木（同名見出しの最初の一致）

![[embed-hierarchy#同じ名前]]

## 2,000 ノード

![[embed-2000]]

## 対象外: 通常の埋め込みのまま

`mappy: true` のないノート:

![[heading-document]]

存在しないノート:

![[存在しないノート]]

ブロック参照:

![[embed-hierarchy#^block]]
