# Mappy 開発ハーネス

- 英語で考え、日本語で報告する。
- 製品要件は `docs/product-plan.md`、設計判断は `docs/architecture.md`、検証手順は `docs/harness.md`、チケット運用は `docs/linear-workflow.md`。
- 実装前に受入条件を確認する。修正時は対象の再現ケースを先に用意する。
- 追加したテストは、修正を戻した状態で実際に落ちることを確かめ、その出力を記録に残す。戻しても通るテストは回帰テストではない。消すか、何を固定しているのかを明記する。
- 症状を直すときの再現行列は、立てた仮説からではなく**本人の操作 × 対象の形**で作る（例: 「画像を貼る」×「空のノード・同名・一意・子・トピック」）。仮説で組んだ行列は仮説の外を見ない（LEV-142 は「同名ノード」で組み、画像を貼ると必ずできる「題名が空のノード」を落とした）。
- 対症療法で出荷しない。回避策を入れるなら、根本原因のチケットを同じ版で閉じるか、**回避策が成り立つ前提と崩れる条件を PR 本文に書く**。回避策は新しい前提を持ち込む。
- 実機のケースは `scripts/e2e/` に置き `npm run harness:e2e:<名前>` で再実行できる形にする。`artifacts/` の使い捨て probe は「確認済み」の記録だけを残して次から回らない。
- 完了前に `npm run check` を実行する。失敗を無効化や広範な lint 抑制で回避しない。
- **すべての PR で、PR を作る前に `/code-review high origin/main...HEAD` を通す。**範囲を省いた素の `/code-review` を打たない。引数なしは `@{upstream}...HEAD` を見るので、`git push -u` 済みのブランチでは対象が空のまま「指摘 0 件」で通る（LEV-183 で再現）。`origin/main` はそのブランチの base に読み替える（`orca worktree create --base-branch` で切った場合。読み替えないと親ブランチのコミットまで自分の指摘として返る）。変更した場所（`src/` かどうか）で対象を絞らない。危険の所在は場所ではなく役割で、PR #76 は `src/` を 1 行も含まない変更（`scripts/e2e/` 8 件・`docs/` 2 件・`package.json` の計 11 ファイル）だったが他チケットを「実機で確認済み」と認定する側の仕組みであり、規約の対象外としてスキップしたあとに回したレビューは指摘 14 件、うち 4 件が「実行されていない run を PASS として記録しうる」種類だった。指摘は重大度を問わず同じブランチで直し、見送るものは理由を PR 本文に書く。手順の詳細は `docs/linear-workflow.md` の「ワーカーの手順」。実行するかどうかを本人に聞かない。
- **レビューの指摘を別チケットへ回す前に、本人が報告した現象と突き合わせる。**「範囲外」と判断した指摘が、報告された症状そのものだったことがある（LEV-140 → LEV-142）。回すなら、その指摘が報告の再現条件に関係しないことを PR 本文に書く。
- UI・保存経路を変更した場合は専用テスト Vault で実機確認し、実行条件・結果・証跡を `artifacts/` に残す。未実施なら明記する。モックの成功を実機の成功と呼ばない。
- `src/main.ts` は登録とライフサイクルに限定。core、layout、interaction は Obsidian に依存させない。
- Markdown が唯一の正本。閲覧でファイルを書き換えない。編集は最新 revision に対する原文範囲の差分とし、無関係な内容を再シリアライズしない。
- 開いた文書の変更は Editor 経由。閉じた文書は Vault.process 内で原文を照合。保存経路を二重に作らない。
- 内部・相対リンクの基準は元ファイル。MarkdownRenderer の Component は描画対象の寿命に合わせて解放する。
- 日本語 IME、Undo/Redo、同名見出し、外部変更、複数ビューは双方向編集の必須ケース。
- runtime はブラウザ互換。Node/Electron や個人パスを持ち込まない。公開 API と scoped CSS を使う。
- ランタイム依存を追加する前に、必要性・バンドル増分・モバイル互換性を記録する。
- 他プラグインは仕様の参考。MarkMind の非公開コードを流用しない。
- 本番 Vault をテスト対象にしない。自動準備はプロジェクト配下の `test-vault/` のみ。
- プライマリー（`projects/Mappy` のチェックアウト）は常に `main` に置く。ブランチ作業は `orca worktree create` で作った worktree で行い、プライマリーで `git checkout -b`／`git switch` を実行しない。
- 1 チケット＝1 worktree＝1 エージェント（`docs/linear-workflow.md`）。**worktree を作る前に `ListAgents` と `orca worktree list` でそのチケットの先客を確認する。いれば新しく作らず、そこにも入らない。** 共有された作業ツリーでは「自分の変更だけを戻す」が成立しない（相手の削除を自分の復元が打ち消す）。触ってしまったら、状態を保存して相手に渡す。
- 1 セッションで複数のチケットを渡り歩かない。長いセッションほど、序盤に読んだ規約が行動の直前に思い出されなくなる。
- `main.js`、`node_modules/`、`dist/`、証跡をコミットしない。公開時のライセンスと plugin ID は未確定。

## 開発メモリ

- 置き場は `memory/`（git 管理外）。`artifacts/` は 1 回の実行の証跡、`memory/` は残す知識（何をしたか・なぜか・何が壊れていたか）。
- カテゴリ: `events/`（実装・リリース）・`bugfixes/`・`investigations/`・`designs/`・`reviews/`・`corrections/`・`archive/`。`memory/` 直下には置かない。
- セッション開始時に `memory/corrections/lessons.md` を読む。
- 作業が終わったらメモリに残す。書き込みは `bm tool write-note --project mappy-memory`（ワークツリーからでも同じコマンドでプライマリーの `memory/` に入る）。検索は `bm tool search-notes "..." --project mappy-memory`。
- ミスをしたら `memory/corrections/inbox.md` に追記する。AGENTS.md やテストに仕組み化できたら `graduated.md` へ送る。
- 詳細は `.claude/skills/memory-manager/SKILL.md`。

現在はベータ（0.x）を GitHub Release ＋ BRAT で公開中（0.1.0〜0.2.1 は 2026-09-20。コミュニティ審査は未提出）。実装の存在と受入条件の達成は分けて扱い、実機テストの完成を先取りして報告しない。
