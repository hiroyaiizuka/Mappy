---
mappy: true
tags:
  - fixture
mappy-topics:
  参考資料: { mindmap: [-360, 200], timeline: [0, 260] }
  "補足: 用語": { mindmap: [560, -140] }
  消えた見出し: { mindmap: [0, 0] }
---
最初の H2 より前の文章は本体の前書きとして保持する。

## 講座の本体

本体の説明文。2 つ目以降の H2 はフリートピックになる。

- 回復する
  参考: [[heading-document#回復する|回復]]
  - 休息の取り方
  - 睡眠
- 記録する
  - ふりかえる
- 習慣化する

## 参考資料

位置は frontmatter の `mappy-topics` にあり、本文には何も書かない。

- [[heading-document|講座ノート]]
- ![[sample-image.svg]]
- [外部の資料](https://example.com)

## 補足: 用語

見出しに `:` を含むため、キーは引用符付きで保存する。

- 用語 A
  - 用語 A の説明
- 用語 B

## 位置のないトピック

`mappy-topics` に項目がないので、本体の下の既定位置に置く。

- 既定位置
