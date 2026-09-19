# Mappy 開発ハーネス

- 英語で考え、日本語で報告する。
- 製品要件は `docs/product-plan.md`、設計判断は `docs/architecture.md`、検証手順は `docs/harness.md`、チケット運用は `docs/linear-workflow.md`。
- 実装前に受入条件を確認する。修正時は対象の再現ケースを先に用意する。
- 完了前に `npm run check` を実行する。失敗を無効化や広範な lint 抑制で回避しない。
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
- `main.js`、`node_modules/`、`dist/`、証跡をコミットしない。公開時のライセンスと plugin ID は未確定。

現在は H0（ハーネス先行）。マップ機能と実機テストの完成を先取りして報告しない。
