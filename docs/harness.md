# ハーネスと検証手順

## 現在の範囲

AI エージェントと人間が同じ条件で開発・検証するため、自動検査、テスト用データ、専用 Vault、Obsidian 非依存のブラウザ検証ページ、成果物一致の確認、実装時の規約を用意している。製品 UI は試作段階で、Markdown parser・保存・レイアウト・DOM 操作の回帰テストを実装済み。専用 Obsidian 環境での確認を進めている。

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
| ブラウザ検証ページ | `npm run harness:browser` | Obsidian なしで製品の map view を動かす。表示崩れ、ポインター操作、ズーム、ペインサイズ（下記②） |
| ブラウザ撮影 | `npm run harness:browser:capture` | headless Chrome で fixture 表示と主要操作を実行し、スクリーンショットと時刻を `artifacts/browser-harness/` に記録 |

まとめて実行するコマンドは `npm run check`（ブラウザ検証ページのビルドまで含む。撮影は含まない）。ローカルと GitHub Actions で同じコマンドを使う。CI は成果物を artifact に保存するだけで、公開を行わない。Git hook は任意の `npm run hooks:install` で有効にする。

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
- フリートピック: 両形式で最初の見出し区画が本体・後ろの区画がトピックになり本体の原文範囲が変わらないこと、`mappy-topics` の flow／block 読み取りと引用符付きキー、そのキーだけの差し替えと frontmatter の新規作成、改名時のキー更新、複数 H2 の fixture の表示（jsdom で製品の view を起動）。`add-topic` の文書末尾への追加（両形式、末尾改行の流儀、ヘッダーなし・リストだけの文書、コードフェンスでの拒否）、`rename` に位置を添えた 1 組の差分、削除時の項目除去（同名・非トピック・最後の項目でのキー削除、追加→削除の往復）。jsdom で製品の view を起動し、空白のダブルクリック→入力→Enter／Escape、右クリックメニュー、トピックのポインタードラッグ（両レイアウト、Escape・キャンバス外での取り消し、位置未設定・Markdown 側で改名したトピック、見出し形式）、Delete→Undo→Redo、ノードの上での合流（仮ノード・`is-merging`・区画→枝・項目の除去・Undo）、ルートの矩形による snap（3 レイアウトとも: 葉の隣は末尾の子、子の列／段は位置で前後、遠ければなし、表示中のスロットの粘り、本体と自分の木は対象外。階層図は本体直下の段の左右と葉の真下、タイムラインは軸上の左右と子のないステージの森の側（偶数番目は上だけ、奇数番目は下だけ）。自分の仮ノードで段が中央揃えし直されても、ステージが森を避けて右へ跳んでも、表示中のスロットを保つ。`snapSlot` の境界値・森の始まる列による順位は layout のテストで固定する）、本体のドラッグ（viewport・全トピックの項目・Escape での復元）、枝を空白へ離しての切り離し（区画化・離した位置・押した場所の近くでは何もしない・Undo）で原文と `mappy-topics` を確認する。`detach` の枝→区画の変換（深い枝、トピック内の枝、仮想ルート直下の項目、末尾の項目、CRLF、フェンス、タブ、同名トピックとの衝突、見出し形式）も core で固定する。`move` の区画→枝の変換（兄弟のインデント・マーカー、子なし、末尾区画、CRLF、コードフェンス、見出し形式）と `planTopicMoves` は core のテストで固定する。
- レイアウト: 非重複、順序、枝の大きさ、折りたたみ、上下交互タイムライン、線がノード内や下線へ伸びないこと。階層図の段揃え（子の上辺 = 自分の親の下辺 + 隙間。兄弟は同じ y、画像付きの親の子だけが下がる）・原文順・親の中央揃え・直角線が段の間だけを通ること・開閉ボタンと 4 桁バッジの位置、`uneven-branches` と 10／100／500／2,000 ノードの fixture での非重複。フリートピックの指定位置（本体ルート基準）と既定配置（本体の下、重ならない最初の空き）、Fit の bounds。
- ズーム: ポインター下のワールド座標が一定、倍率上限、パン、Fit。

Vitest の Node 環境で検証する。乱択・property-based test は、保存と復元の不変条件に効果がある場合に追加する。

### DOM とブラウザ

jsdom を導入し、製品の DOM 操作・インライン入力・キー操作を検証している。composition イベントを送るテストは変換中のキー制御を検証するもので、OS の日本語 IME で入力した結果ではない。DOM の実測サイズ、フォント、画像遅延、ポインター操作、ズームの見た目は、下記②のブラウザ検証ページと③の Obsidian 実機で確認する。

### ② ブラウザ検証ページ（Obsidian 非依存）

`harness/browser/` にあるページで、製品の `src/ui/mindmap-view.ts`・`node-renderer.ts`・`map-viewport.ts`・`map-events.ts`・`inline-editor.ts` と `core` / `layout` / `interaction` / `document-store.ts` をそのまま読み込む。`obsidian` モジュールだけを `harness/browser/obsidian.ts`（`tests/mocks/obsidian.ts` と同系統のモック。Component・ItemView・Menu・Modal・Notice・setIcon・MarkdownRenderer の最小実装）に差し替え、Obsidian が起動時に生やす DOM ヘルパー（`createDiv`、`addClass`、`event.targetNode` など）は `harness/browser/dom.ts` が同じ形で prototype に載せる。Vault・workspace・metadataCache・fileManager は `harness/browser/app.ts` のメモリ内実装で、ファイルへは何も書かない。

- 起動: `npm run harness:browser` で `dist/harness/` をビルド・監視し、`http://127.0.0.1:8765/` で配信する（`--port` で変更）。`npm run harness:browser:build` は一度だけビルドし、`dist/harness/index.html` を `file://` で直接開ける。ビルドは製品と同じ esbuild を使い、ランタイム依存を追加しない。
- fixture: `tests/fixtures/` の `heading-document`（従来の見出し形式・リンク・画像）、`roundtrip-edge-cases`（同名見出し・コードブロック・欠落画像）、`uneven-branches`（H2＋リスト、8 段の一列の枝、24 兄弟、長い日本語、リンク・画像・コードブロック、同名ノード）、`free-topics`（複数の H2: 本体＋フリートピック 3 つ、`mappy-topics` のレイアウト別位置・引用符付きキー・孤児キー、位置未設定の既定配置）と、`scripts/performance-fixtures.mjs` が生成する 10／100／500／2,000 ノード。`harness:prepare` が `test-vault/Fixtures/` に置く文書と同一で、ページ左の select か `?fixture=<id>` で切り替える。
- 操作: 選択（クリック・矢印キー）、開閉（分岐点の − と Space）、パン（背景ドラッグ・ホイール）、ズーム（Ctrl/⌘＋ホイール、ピンチ、右下の −／倍率／＋／全体表示）、レイアウト切替、右クリックメニュー、ペインのサイズ変更（プリセット、数値、右下の角のドラッグ。変更ごとに製品の `onResize()` を呼ぶ）、「閉じて開き直す」（`onClose`→`unload`→新しい view）。Enter／Tab／F2／Delete と右クリックの編集、フリートピックの追加（空白のダブルクリック・右クリック）・ドラッグ移動・削除はメモリ内の文書に対して動き、`window.__mappyHarness.source()` で現在の原文を読めるが、保存経路の検証ではない。
- 時刻の記録: fixture 切替ごとに `parseMarkdown` 単体、`setState` 完了、最初の描画フレーム、位置が 3 フレーム安定するまでの経過 ms をページ左の一覧と `window.__mappyHarness.timings`、Performance タイムラインの `mappy:load:<id>` に残す。1 回分の生値で、繰り返しと p50／p95 は下記の性能計測が扱う。
- 性能計測: `node scripts/browser-harness-perf.mjs` は同じページを headless Chrome で開き、`scripts/performance-fixtures.mjs` の 10／100／500／2,000 ノード × 6 つの形（見出し形式、H2＋リストの均等な枝、深い一列の枝、多数の兄弟、長い日本語、リンク・画像）を、マップ・タイムライン・階層図の 3 レイアウトで計測する。fixture ごとに新しい Chrome を起動し、レイアウトごとに、新しい view での読み込み（`parse`・`setState`・ノードの計測・`layoutTree`・配置フレーム・次フレーム開始・初回配置・安定）10 回、Markdown 側の編集（`modify` → 45 ms の debounce → 再読込〜DOM → 配置フレーム → 次フレーム開始）10 回、インライン編集（キー入力 30 回と Enter の確定 10 回）、パン／ズーム各 2 回 × 60 フレーム（1 フレームに 1 wheel）を `harness/browser/measure.ts` の探針（製品の requestAnimationFrame と setTimeout を包み、編集ノードの MutationObserver で DOM 更新の時刻を取る。`src/` は触らない）で取り、nearest-rank の p50／p95 と基準端末（CPU・メモリ・OS・Node・Chrome・フラグ・load average・build）を `artifacts/performance/<日時>/record.md`（`samples.json`・`summary.json` も）に書く。`--counts`・`--shapes`・`--fixtures`・`--layouts`・`--repeat`・`--keystrokes`・`--frames` で範囲を絞り、`--gpu` で `--disable-gpu` を外して GPU ラスタで比較する。画像は data URL で転送時間を含まない。テーマは `harness.css` の仮の値で、Obsidian の Editor と Vault を持たないため、実機の値（E10、`artifacts/lev-33-realtime-verification-2026-09-18.md`）と突き合わせて読む。
- 自動撮影: `npm run harness:browser:capture` は headless Chrome（`--chrome <path>` か `MAPPY_CHROME`、既定はインストール済みの Google Chrome）を DevTools Protocol で操作し、全 fixture の Fit 表示と、`uneven-branches` での選択・矢印キー・開閉・パン・ホイール・Ctrl＋ホイール・ズームボタン・タイムライン・階層図（親ごとの段揃えと深さごとに一定の隙間、`mappy-layout: hierarchy` の書き込み、折りたたみの件数）・640×480／390×700 のサイズ変更・右クリックメニュー・内部リンククリック・F2 入力→Enter→⌘Z（メモリ内の改名と Undo）・閉じて開き直し、`performance-2000` の開閉、`heading-document` を階層図にして親ごとの段（`hierarchy-rows`: 兄弟は同じ上辺、画像付きの親の子だけが下がり、文字だけの枝の隙間は画像付きの親の子と同じ長さ。`hierarchy-rows-back` で「マップ」に戻しキーが消える）、`free-topics` でのフリートピックの追加（空白のダブルクリック→入力→Enter）・Undo／Redo・ドラッグ移動（位置ありと位置なし、Escape での取り消し）・削除→Undo→Redo・ノードへのドラッグで合流（スロットの事前表示、区画→枝、Undo）・トピックをノードの隣に運ぶだけでスロットが出ること（`topic-snap`。ポインターは相手に乗らない。階層図では葉の真下（`topic-snap-hierarchy`）、タイムラインでは子のないステージの真上の森が始まる位置（`topic-snap-timeline`）と軸上のステージの隙間（`topic-snap-timeline-axis`）で同じことを確認する。レイアウトは view state で切り替えて Fit し、`mappy-layout` は書かない）・本体のドラッグ（viewport の追従と全項目の書き換え、Undo）・本体の枝を空白へドラッグして切り離し（枝→区画、離した位置、Undo）・空白の右クリックメニューを実行し、原文と `mappy-topics` の前後を比較する。各ケースの PASS／FAIL、時刻、全画面とペイン 2 倍のスクリーンショットを `artifacts/browser-harness/<日時>/record.md` に書く。Chrome がなければ未実施と書いた record だけを残して終了コード 2 になる。headless Chrome 153 は修飾キー付きのキー入力（⌘Z・⌘⇧Z）を CDP で繰り返すとブラウザプロセスが応答しなくなることがあるため、フリートピックのケースの Undo／Redo は右クリックメニューで行い、プロトコル呼び出しが 60 秒応答しなければ以降を FAIL として record を書いて終了する（`MAPPY_CAPTURE_TRACE=1` で呼び出しを逐次表示）。
- 対象外: 保存（Vault・Editor への書き込み）、リンク解決（クリックは通知と記録だけ）、テーマ（`harness.css` の CSS 変数は仮の値）、日本語 IME（合成イベントは OS の変換ではない）、トラックパッドとモバイルの実入力。これらは③で確認する。

このページでの成功を Obsidian の保存・リンク解決・テーマでの成功と呼ばない。Obsidian 実機の確認（下記 E01〜E30）が E2E に相当し、このページはその代替ではない。

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
| E26 | タイムライン／階層図を選択→Markdown へ切替→マップへ戻る | `mappy-layout: timeline`／`hierarchy` が保存され、再度そのレイアウトで開く。通常マップ選択では任意キーだけを削除する |
| E27 | Mappy ノートを Excalidraw の「as embeddable」「as image」で挿入 | 新しく作られた Mappy 埋め込みの外枠が透明。通常ノート・既存要素・内容・リンクは変えない |
| E28 | Enter／Tab で空ノードを追加し、長い文字列を入力 | 入力欄は約 10 文字幅（旧幅の約半分）で折り返し、入力・補完・保存は従来どおり動く |
| E29 | 空白をダブルクリックしてフリートピックを追加→本体のノードへドラッグして合流→Undo→Mappy 以外（通常の Markdown 編集・閲覧モード、Mappy 無効）で開く | 文書末尾に最上位区画が追加され、合流で区画がリストの枝に変わり、Undo で元の区画と位置に戻る。本体のノード・本文・他の frontmatter は変わらず、Mappy 以外では通常の見出しと箇条書きとして読める |
| E30 | 階層図のマップをアクティブにして「現在のマップを Excalidraw の図面に挿入」 | 挿入した要素が 1 グループで、ルートが上・第一階層が同じ段・線が直角の折れ線。E27 の外枠透明化とは別のケース |

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

`test-vault/Fixtures/` には初回準備時に静的 fixture と 10/100/500/2000 ノードの文書（見出し形式と 5 つの形の H2＋リスト、計 24 ファイル）を生成する。CRLF・末尾改行なし・途中 IME のような条件は、対応するテストで明示的に作る。レイアウトの幾何テストは性能測定の代わりにしない。性能は②の `scripts/browser-harness-perf.mjs`（ブラウザでの解析・配置・描画・入力反映の p50／p95）と、実機の入力から画面反映まで（E10、LEV-33 の `obsidian-realtime-probe.mjs`）を分けて記録する。`node scripts/measure-layout.mjs` は同じ生成文書で `layoutTree` 単体の配置時間（3 モード、展開と折りたたみ、中央値・p95・最大値）を `artifacts/layout-timing/<日時>/` に記録するが、DOM 計測を含まないレイアウト単体の数値であり、§6 の実機計測の代わりにはならない。

## 公開前の追加確認

現在はローカルで試用するプロトタイプであり、README・LICENSE の存在だけで公開可能とは扱わない。製品の受入条件、実機対応、公開ライセンス、作者表記、名称・ID の重複、説明文を確認する。`manifest.version` と同じタグで必要な配布物を GitHub release に添付する。

提出時には公式ドキュメントで手順を再確認し、自動レビューの指摘を解決する。sample README と差がある場合は提出時点の公式ドキュメントを優先する。[提出手順](https://docs.obsidian.md/plugins/releasing/submit-plugin)、[提出要件](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)

コードを参考にした製品の権利表示・公開方針も確認する。今回 MarkMind と Light Mindmap の製品ソースはコピーしていない。[Developer policies](https://docs.obsidian.md/community-directory/developer-policies)
