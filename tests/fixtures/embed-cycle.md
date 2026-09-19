---
mappy: true
tags: [mappy-fixture]
---
## 循環の相手

`embed-nodes` がこのノートを呼び出し、このノートも `embed-nodes` を呼び出す。どちらを開いても、呼び出したマップの中の呼び出しはリンクのまま描かれ、描画が止まらない（docs/harness.md E35）。

- ![[embed-nodes]]
- 自分自身はリンク
  - ![[embed-cycle]]
- 葉
