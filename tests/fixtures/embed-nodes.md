---
mappy: true
tags: [mappy-fixture]
---
## 呼び出しの検証

このノートは `mappy: true` を持つマップで、ノードのテキストが `![[マップノート]]` だけの項目を持つ。map view の中でそのノードが読み取り専用のマップ（ルートと第一階層、以下は折りたたみ）として描かれ、このノートも呼び出したノートも書き換わらないことを確認する（docs/harness.md E35）。

- 呼び出したマップ
  - ![[embed-timeline]]
  - ![[embed-hierarchy#同じ名前]]
  - ![[embed-2000]]
- 同じマップをもう一度
  - ![[embed-timeline]]
- 循環（embed-cycle はこのノートを呼び出す）
  - ![[embed-cycle]]
- リンクのまま
  - ![[embed-nodes]]
  - 文中の ![[embed-timeline]] はリンク
  - ![[heading-document]]
  - ![[存在しないノート]]
  - ![[embed-hierarchy#^block]]
  - ![[sample-image.svg]]
