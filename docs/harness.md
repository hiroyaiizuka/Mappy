# ハーネスと検証手順

## 現在の範囲

AI エージェントと人間が同じ条件で開発・検証するため、自動検査、テスト用データ、専用 Vault、成果物一致の確認、実装時の規約を用意している。製品 UI は試作段階で、Markdown parser・保存・レイアウト・DOM 操作の回帰テストを実装済み。専用 Obsidian 環境での確認を進めている。

件数・バンドルサイズ・実機の PASS/FAIL をこの文書に固定せず、実行日時とビルドのハッシュを付けた `artifacts/` の記録で追う。GitHub 上の CI、ネイティブ IME、モバイル、性能計測、長時間利用の検証は、個別の証跡が揃うまで未完了として扱う。

| ゲート | コマンド / 設定 | 検出するもの |
| --- | --- | --- |
| メタデータ | `npm run validate` | manifest/package/lock/versions の不整合、必須文書の欠落 |
| lint | `npm run lint` | 製品ソースの公式 Obsidian 推奨ルール、型情報付き ESLint、JSON 構文 |
| 型検査 | `npm run typecheck` | strict、未処理の戻り、添字の undefined、型不整合 |
| 単体・DOM テスト | `npm test` | ハーネス検証器、Markdown と原文差分、保存・競合、配置・ズーム、操作 |
| production bundle | `npm run build` | ブラウザ互換 CJS バンドル。Obsidian 提供 API は external |
| 配布物 | `npm run package` | `dist/mappy/` の必要ファイルと元ビルドとの一致 |
| Vault 初期準備 | `npm run harness:prepare` | `check` 後、生成専用 Vault に配布物・fixture を配置。既知の fixture を初期化する |
| 実機前確認 | `npm run harness:preflight` | root / dist / 検証 Vault の SHA256、一致する ID/version、有効プラグイン |

まとめて実行するコマンドは `npm run check`。ローカルと GitHub Actions で同じコマンドを使う。CI は成果物を artifact に保存するだけで、公開を行わない。Git hook は任意の `npm run hooks:install` で有効にする。

## lint の対象を明確にする

`eslint-plugin-obsidianmd` の recommended は `src/**/*.ts` に適用する。推奨ルールを手書きでコピーしない。CLI やテスト準備スクリプトは Node 上で動くため別の ESLint 設定にし、モバイル禁止ルールを製品コードから外さない。

`manifest.json` は JSON lint と独立した `validate-release.mjs` の両方で検証する。設定に manifest ルール名があるだけでは、対象ファイルへ適用されている保証にならない。今回の独立検証をテストで確認する。LICENSE は存在を確認するが、公開ライセンスの適否を自動判定するものではない。

`--max-warnings 0` はこのプロジェクトの品質基準。lint の通過は、コミュニティの公開審査通過を保証しない。[公式 lint](https://github.com/obsidianmd/eslint-plugin)

Obsidian API 型は、現在の lint パッケージの peer dependency と初期最小対応バージョンに合わせ `1.8.7` を固定した。新 API の採用時は API 型、manifest.minAppVersion、versions.json、実機の互換性を一緒に更新する。ESLint 9 は現公式 sample と plugin の互換系列を採用している。依存更新では警告・サポート状況を確認し、単に最新 major へ飛ばさない。

## 既存 TaskChute Plus から引き継いだ点

参考元: `/Users/hiroyaiizuka/Desktop/Evergreens/.obsidian/plugins/taskchute-plus`。

| 参考ファイル | 採用した考え方 | Mappy での変更 |
| --- | --- | --- |
| `AGENTS.md` | 実装後に lint・test・build、実機検証 | 一つの check と段階ごとの受入条件に集約 |
| `eslint.config.mjs` | Obsidian と型情報を使う lint | 現行 recommended を読み込み、ルール一覧の手書き複製を避ける |
| `jest.config.js` / Obsidian mock | ロジックと DOM をアプリなしで検証 | 新規プロジェクトは Vitest。実機との境界を明示 |
| `.husky/pre-commit` | commit 前の品質ゲート | 個人の Node 絶対パスを使わない任意 hook |
| `.kiro/steering/` | 仕様と受入条件を文書化 | `docs/` と短い AGENTS.md にまとめる |
| 外側の `Evergreens/.agents/skills/obsidian-e2e-tester/` | 起動前の配布物一致・ケース別証跡 | 専用 test-vault と SHA256。既存アプリの終了や他プラグイン設定を変更しない |

既存ソースは調査のみ。既存プラグインの型チェック不足、manifest が lint 対象外になる設定、公開後のビルドなどは新規構成へ持ち込まない。

## テスト階層

### 自動ロジックテスト

- Markdown: 本文/frontmatter/コメント/リンク/画像/空行/改行コードの保全、同名ノード、コード中の `#` / `-`、Setext、従来形式の深さ飛び、リストの2/4スペース・タブと深い入れ子。
- コマンド: 改名/挿入/移動/削除で対象範囲だけ変化。子孫と継続本文を含む移動、従来見出しの六段階上限、深いリスト、旧形式の明示変換、原文不一致時の拒否。
- 保存: 未保存エディタの優先、Vault.process 内の原文照合、外部更新、複数ビュー、Undo/Redo と履歴破棄。
- レイアウト: 非重複、順序、枝の大きさ、折りたたみ、上下交互タイムライン、線がノード内や下線へ伸びないこと。
- ズーム: ポインター下のワールド座標が一定、倍率上限、パン、Fit。

Vitest の Node 環境で検証する。乱択・property-based test は、保存と復元の不変条件に効果がある場合に追加する。

### DOM とブラウザ

jsdom を導入し、製品の DOM 操作・インライン入力・キー操作を検証している。composition イベントを送るテストは変換中のキー制御を検証するもので、OS の日本語 IME で入力した結果ではない。DOM の実測サイズ、フォント、画像遅延、ポインター操作、ズームの見た目は実ブラウザ／Obsidian で確認する。

Obsidian に依存しないブラウザ検証ページは未実装。追加する場合は製品の core / layout / interaction を読み込んで同じ実装を動かし、10／100／500／2,000 ノードの描画・入力反映時間を記録する場とする。モックで成功することを Obsidian の保存・リンク解決・テーマでの成功と呼ばない。Obsidian 実機の確認（下記 E01〜E28）が E2E に相当し、このページはその代替ではない。

### Obsidian 実機の初回準備

1. まだ試用していない専用環境で `npm run harness:prepare` を実行する。生成するのはこのプロジェクト内の `test-vault/` のみ。
2. Obsidian でそのフォルダを Vault として開く。必要な初回の制限モード設定はテスト環境で行う。
3. `npm run harness:preflight` を実行する。これはファイルと設定の検査であり、実行中プラグインが最新である証明ではない。
4. プラグインを再読込し、対象 Vault と機能の挙動を画面で確認する。将来は表示する build ID も照合する。
5. 下記ケースを再現し、UI の状態と変更後の Markdown を両方保存する。

`harness:prepare` は既知の fixture を初期化するため、ユーザーが試用中の Vault には再実行しない。生成 fixture に書いたノードも利用者の変更として保持する。既存の Evergreens Vault や taskchute-plus の配布物は操作しない。

### 試用中の更新

製品コードを変更したら、配布物だけを更新する。作業ディレクトリがこのプロジェクトであることと、実機の Vault がこのプロジェクトの `test-vault/` であることを確認する。

```sh
npm run check
cp dist/mappy/main.js dist/mappy/manifest.json dist/mappy/styles.css test-vault/.obsidian/plugins/mappy/
npm run harness:preflight
```

その後、専用 Obsidian 環境で Mappy だけを再読込して対象画面を開き直す。`preflight` の成功だけでは実行中コードの更新は確認できないので、新しい表示・操作も確認する。Markdown、添付ファイル、workspace 設定や他のプラグインはコピーしない。再現用ノートが必要なら専用 Vault 内に別名で作り、既存ノートを上書きしない。

画面変更の証跡には、通常マップ／タイムラインのスクリーンショット、折りたたみと件数、インライン入力・リンク候補、操作前後の Markdown を含める。試用中のユーザー入力がある場合は、検証時の変更と区別して記録する。

| ID | 実機ケース | 期待する結果 |
| --- | --- | --- |
| E01 | 分割で日本語見出しを入力 | 変換確定で余計なノードが増えずマップへ反映 |
| E02 | map で Enter/Tab/F2/Delete | フォーカス範囲内だけに作用し本文・子孫を保持 |
| E03 | 編集→Undo→Redo→表裏切替 | 文書とマップが同じ内容、履歴の二重適用なし |
| E04 | 同名ノードの片方を移動 | 正しい本文・子孫だけが移動 |
| E05 | 外部更新と map 編集を競合させる | 古い状態で上書きせず入力も復旧可能 |
| E06 | 内部/外部/別名/見出し/ブロックリンク | 元ファイル基準の正しい遷移 |
| E07 | 画像追加、遅延、欠落、サイズ指定 | 添付設定に従う、重なりと表示位置の飛びを抑える |
| E08 | ピンチ/ホイール/パン/Fit | 意図した中心でズーム、通常エディタへ干渉しない |
| E09 | 開閉50回・再読込・別ウィンドウ | 多重イベント、残留DOM、継続的なメモリ増加なし |
| E10 | 500/2000ノードとタイムライン | 性能指標を記録、内容欠落なし |
| E11 | モバイルと明暗テーマ | タッチ、フォーカス、文字・リンク・画像を操作可能 |
| E12 | H2＋リストと、従来の H2→H3→H4 をそれぞれ表示 | 各形式の実際の深さに従う。ルートは濃い面、第一階層は枠付き、下位は平文で下線なし |
| E13 | 分岐点にホバー→多段の枝を閉じる→再展開 | 分岐点で丸い − を表示。閉じると全非表示子孫の件数を示し、3・4桁の数字も別の線やノードと重ならない |
| E14 | 空ノードの追加→テキスト入力 | 追加モーダルとプレースホルダーがなく、その場で入力できる |
| E15 | `[[` / `![[`→ノート・別名・PNG・SVG・PDF 候補→Enter/Tab | 候補選択で余計な保存・子追加をせず、周囲の入力・拡張子・埋め込み記号とリンク先を保持 |
| E16 | 全面キャンバス・浮かせた UI・右クリックの操作 | 操作専用の帯を割かず、左下はレイアウト、右上は Markdown、右下はズーム |
| E17 | Markdown のリストをインデント・アウトデント | 階層へ即時反映し、6段階を超える枝も追加・編集できる |
| E18 | 旧見出し形式→「リスト形式に変更」→Undo | 自動変換せず、明示操作で同じタイトル・構造を保って変換・復元 |
| E19 | 子リストの前後に親の本文がある項目を編集・移動 | 子を動かしても親の後続文章を持ち去らず、本文・画像追加で既存の枝が変わらない |
| E20 | 「マップと Markdown を切り替え」を同じ leaf で往復 | 未保存内容と選択位置を保ち、Markdown 側は選択ノードの行にカーソル |
| E21 | 通常ノート→「このノートをマインドマップ化」→解除、新規マップ作成 | 通常ノートは変換前にマップで開けない。変換で `mappy: true`、解除で Mappy のキーだけが消える。新規マップは H2 ルートを持つ |
| E22 | トグルで Markdown にした leaf で同じノートを開き直す | Markdown のまま。別 leaf や別ノートには影響しない |
| E23 | Excalidraw で Option を押して `.md` をドロップ／修飾なし／Shift | Option だけがマップ要素を挿入し、他は Excalidraw 既定（リンク・画像）のまま |
| E24 | Excalidraw の対話フレームに `mappy: true` のノートを挿入 | Mappy のビューがライブ表示され、線・枠・リンクが見える。通常ノートは Markdown のまま |
| E25 | Mappy 無効化→Excalidraw 再読込→Mappy 有効化 | 無効時はフックと差し替えが外れ、有効化後にドロップが再び効く |
| E26 | タイムラインを選択→Markdown へ切替→マップへ戻る | `mappy-layout: timeline` が保存され、再度タイムラインで開く。通常マップ選択では任意キーだけを削除する |
| E27 | Mappy ノートを Excalidraw の「as embeddable」「as image」で挿入 | 新しく作られた Mappy 埋め込みの外枠が透明。通常ノート・既存要素・内容・リンクは変えない |
| E28 | Enter／Tab で空ノードを追加し、長い文字列を入力 | 入力欄は旧幅の約 75% を上限にし、入力・補完・保存は従来どおり動く |

記録テンプレート:

```text
Case ID / 日時:
OS / Obsidian version / Vault / build hash:
入力 fixture / 前提:
操作:
期待する UI / Markdown:
実測 / PASS・FAIL・未実施:
スクリーンショット / 前後の Markdown / 性能記録:
```

`test-vault/Fixtures/` には初回準備時に静的 fixture と 10/100/500/2000 見出しの文書を生成する。CRLF・末尾改行なし・途中 IME のような条件は、対応するテストで明示的に作る。レイアウトの幾何テストは性能測定の代わりにしない。性能は実機の入力から画面反映までを別途測定する。

## 公開前の追加確認

現在はローカルで試用するプロトタイプであり、README・LICENSE の存在だけで公開可能とは扱わない。製品の受入条件、実機対応、公開ライセンス、作者表記、名称・ID の重複、説明文を確認する。`manifest.version` と同じタグで必要な配布物を GitHub release に添付する。

提出時には公式ドキュメントで手順を再確認し、自動レビューの指摘を解決する。sample README と差がある場合は提出時点の公式ドキュメントを優先する。[提出手順](https://docs.obsidian.md/plugins/releasing/submit-plugin)、[提出要件](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)

コードを参考にした製品の権利表示・公開方針も確認する。今回 MarkMind と Light Mindmap の製品ソースはコピーしていない。[Developer policies](https://docs.obsidian.md/community-directory/developer-policies)
