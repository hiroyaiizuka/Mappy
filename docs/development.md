# Mappy の開発

利用者向けの説明は [README](../README.md) にあり、このファイルは開発者向けです（2026-09-26 に README の「開発」節から移した。LEV-201）。

- [製品計画・段階ごとの受入条件](product-plan.md)
- [Markdown 同期・描画の設計](architecture.md)
- [ハーネス・テスト・審査の準備](harness.md)
- [フィードバックを反映した表示・入力仕様](interaction-revision.md)
- [リリースの作り方と注意点](harness.md#リリース手順)（正本。リポジトリ本体には `main.js` を含めず、Release の添付ファイルとしてだけ配る）

Node.js は `.nvmrc` のバージョンを使用します。

```sh
npm ci
npm run check
```

`check` はメタデータ検証 → lint → テスト → 型検査 → production build → 配布物検証 → ブラウザ検証ページのビルドを実行します。Markdown の解析・原文差分、保存と競合、レイアウト、ズーム、DOM の操作も自動テスト対象です。Obsidian のモックを使った成功は実機の成功として扱いません。**公式 lint（`eslint-plugin-obsidianmd`）を通ることは、コミュニティ審査の通過を保証しません。** ベータ版のバージョンは 0.x で、タグは `manifest.version` と同じ `x.y.z`（`v` なし）です。審査要件のチェック結果は `artifacts/lev-24-readme/record.md`（git 管理外）に項目ごとに残しています。

```sh
npm run dev               # ビルド監視
npm run test:watch        # テスト監視
npm run test:coverage     # 現在のテスト対象のカバレッジ
npm run harness:prepare   # 初回専用。既知の fixture を初期化する
npm run harness:preflight # ビルド成果物と検証 Vault の一致を確認
npm run harness:browser   # Obsidian なしで map view を動かす検証ページ（http://127.0.0.1:8765/）
npm run harness:browser:capture # headless Chrome で fixture と主要操作を撮影し artifacts/ に記録
```

`dist/mappy/` に `main.js`、`manifest.json`、`styles.css` を生成します。`dist/build-info.json` は検証用のハッシュ記録です。`check` は公開や既存 Vault へのインストールを行いません。ブラウザ検証ページ（`dist/harness/`）は製品の core / layout / interaction / ui をそのまま読み込み、`obsidian` モジュールだけをモックに置き換えます。保存・リンク解決・テーマ・IME はこのページの対象外で、[検証手順](harness.md)の ③ 実機で確認します。

専用テスト Vault の試用中は `harness:prepare` を再実行せず、[更新手順](harness.md#試用中の更新)で配布物 3 ファイルだけをコピーします。試用中の Markdown と添付ファイルを上書きしないでください。

任意で `npm run hooks:install` を実行すると、このリポジトリの pre-commit に同じ品質ゲートを設定できます。CI の定義は `.github/workflows/check.yml` にあります。

plugin ID `mappy` と名前 `Mappy` は 2026-09-19 時点のコミュニティ一覧と衝突していません。最低対応バージョン `1.8.7` と `isDesktopOnly: false` は現在の宣言で、対応環境の実機確認は[README の対応環境](../README.md#対応環境)のとおりです。
