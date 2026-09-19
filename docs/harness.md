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
| Vault 初期準備 | `npm run harness:prepare` | `check` 後、生成専用 Vault に配布物・fixture を配置。既知の fixture を初期化する。有効プラグインは mappy と、すでに有効なら Excalidraw（M6 用）だけを残す |
| 実機前確認 | `npm run harness:preflight` | root / dist / 検証 Vault の SHA256、一致する ID/version、有効プラグイン（mappy と Excalidraw（M6 用）だけを有効にする。他のプラグインが有効なら失敗） |
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
- フリートピック: 両形式で最初の見出し区画が本体・後ろの区画がトピックになり本体の原文範囲が変わらないこと、`mappy-topics` の flow／block 読み取りと引用符付きキー、そのキーだけの差し替えと frontmatter の新規作成、改名時のキー更新、複数 H2 の fixture の表示（jsdom で製品の view を起動）。`add-topic` の文書末尾への追加（両形式、末尾改行の流儀、ヘッダーなし・リストだけの文書、コードフェンスでの拒否）、`rename` に位置を添えた 1 組の差分、削除時の項目除去（同名・非トピック・最後の項目でのキー削除、追加→削除の往復）。jsdom で製品の view を起動し、空白のダブルクリック→入力→Enter／Escape、右クリックメニュー、トピックのポインタードラッグ（両レイアウト、Escape・キャンバス外での取り消し、位置未設定・Markdown 側で改名したトピック、見出し形式）、Delete→Undo→Redo、ノードの上での合流（仮ノード・`is-merging`・区画→枝・項目の除去・Undo）、ルートの矩形による snap（4 レイアウトとも: 葉の隣は末尾の子、子の列／段は位置で前後、遠ければなし、表示中のスロットの粘り、本体と自分の木は対象外。階層図は本体直下の段の左右と葉の真下、タイムラインは軸上の左右と子のないステージの森の側（偶数番目は上だけ、奇数番目は下だけ）、左右バランスは左側の葉の左隣（右隣は何もない）・左側の子の列は右辺の線・ルートの子は右列と左列それぞれの線で前後（子の前はその子の index、列の末尾は次の index がその側に配られるときだけ全体の末尾の後ろ、反対側の末尾は何もない、子 1 つのルートの空いた左側はルートの隣）。自分の仮ノードで段が中央揃えし直されても、ステージが森を避けて右へ跳んでも、表示中のスロットを保つ。`snapSlot` の境界値・森の始まる列による順位は layout のテストで固定する）、本体のドラッグ（viewport・全トピックの項目・Escape での復元）、枝を空白へ離しての切り離し（区画化・離した位置・押した場所の近くでは何もしない・Undo）で原文と `mappy-topics` を確認する。`detach` の枝→区画の変換（深い枝、トピック内の枝、仮想ルート直下の項目、末尾の項目、CRLF、フェンス、タブ、同名トピックとの衝突、見出し形式）も core で固定する。`move` の区画→枝の変換（兄弟のインデント・マーカー、子なし、末尾区画、CRLF、コードフェンス、見出し形式）と `planTopicMoves` は core のテストで固定する。
- レイアウト: 非重複、順序、枝の大きさ、折りたたみ、上下交互タイムライン、線がノード内や下線へ伸びないこと。左右バランスの振り分け（第一階層が原文順に右・左・右・左、下位はその側。右列と左列を交互に読むと原文順に戻る）・各側の列がルートの高さ中央に揃うこと・左側の鏡像（子の右辺の揃え、親の左辺から子の右辺への直角線、左の幹の開閉ボタンと左のバッジ）・片側の折りたたみで反対側が動かないこと・再展開で元に戻ること・4 桁バッジ・両側 2,000 段の一列・500 ノード混在・`uneven-branches` と 10／100／500／2,000 ノードの fixture・フリートピック（位置ありは origin＋位置、位置なしはルート中央の列）・Excalidraw 挿入との座標一致。階層図の段揃え（子の上辺 = 自分の親の下辺 + 隙間。兄弟は同じ y、画像付きの親の子だけが下がる）・原文順・親の中央揃え・直角線が段の間だけを通ること・開閉ボタンと 4 桁バッジの位置、`uneven-branches` と 10／100／500／2,000 ノードの fixture での非重複。フリートピックの指定位置（本体ルート基準）と既定配置（本体の下、重ならない最初の空き）、Fit の bounds。
- ズーム: ポインター下のワールド座標が一定、倍率上限、パン、Fit。
- 設定（M14）: `normalizeSettings` が欠損・null・旧形式・不正値を項目ごとに既定値へ戻し、未知のキーを捨てること。設定タブ（jsdom、ブラウザ検証ページのモックの `Setting`／`DropdownComponent`／`TextComponent`／`PluginSettingTab`）が 3 項目だけを出し、レイアウトの選択肢が `LAYOUT_MODES` の順であること、変更した項目だけを差し替えて保存し、Vault・frontmatter に一切書かないこと、1.13 以降向けの `getSettingDefinitions`／`getControlValue`／`setControlValue` が `display()` と同じ 3 項目を返し不正値を保存しないこと。`createMindmapFile` が既定の設定で従来と同じ frontmatter・作成先になり、既定レイアウトを新規ノートだけに書き、作成先フォルダを正規化して既存なら（大文字小文字違いでも）再利用・なければ作成・同名ファイルと `.` で始まる名前なら拒否・作成結果が空ならエラーにすること（モックの `normalizePath` は Obsidian と同じくスラッシュしか整えない）。1.13 以降の `addSettingTab → update() → 描画` の流れをモックで再現し、`settingItems` が 3 件になり `display()` に落ちないこと。`readPreferredMapLayout` が旧 `mappy-layout` を持つノートではその値、持たないノートでは設定の既定を返し、`readMapLayout`（既存ノートの表示）は設定を見ないこと。`MindmapView.setTheme()` がコンテナにだけ `theme-light`／`theme-dark` を付け外しし（body・leaf・canvas・別 view には付かない）、開く前に設定した値が `onOpen` 後も残り、「Obsidian に従う」で両方外れ、原文・frontmatter・レイアウト保存が起きないこと。styles.css のテーマ変数が `:where(.mappy-view.theme-*)` にだけあり、カスタムプロパティ以外を含まないこと。
- SVG／PNG 書き出し（M13）: 純粋部分（`tests/export/svg-document.test.ts`）は viewBox と余白、PNG の縮尺の上限（面積・一辺・希望倍率）、XML のエスケープ、スタイルの重複除去、シーン → SVG の構造（背景 → 線 → ノード → バッジの順、CDATA の終端）。DOM 部分（`tests/export/svg-capture.test.ts`、jsdom で製品の view を起動）は `foreignObject` の数と id が表示ノードと一致し座標が `LayoutResult` と一致すること、線の数、viewBox、テーマ class（body の `theme-dark`）と既定の背景色、状態クラス・開閉ボタン・`tabindex` を含まないこと、折りたたみ（枝が消え、件数バッジが `folds` の位置に出る。配置フレームが予約中でも `exportSource()` が待ってから返す）、欠落・読めない画像でノードが残り読める画像は data URL になること、タイムライン・階層図、編集中と file なしの拒否、10／100／500／2,000 ノードの完了と原文不変、画像を待つ間に DOM が壊されてもノードが欠けないこと、debounce 中の編集が書き出しに入ること、フォームフィードと `xlink:href` 付きのインライン SVG でも整形式であること、汚染された canvas が「PNG を作れません」になり probe が false を返すこと。Obsidian 側（`tests/obsidian/image-export.test.ts`）は添付パス API の有無による可否、resolver（data URL の素通し、埋め込みの link target を `readBinary`、Markdown 画像の書かれたパス、http(s) の取得と失敗時の null、PDF を読まない、`image/*` 以外の応答と応答のないホストの拒否）、`getAvailablePathForAttachment` → `vault.create` での保存とノート不変、整形式の検査、canvas のない環境で添付パスを取る前に PNG を断ること。モーダル（`tests/ui/export-modal.test.ts`）は形式の選択と PNG の無効化。
- 埋め込み（M10）: core で原文からのマップ識別（`mappy: true` の真偽値だけ。`True`／`TRUE` も cache と同じく真偽値、`"true"`・Excalidraw・未閉の frontmatter は対象外）、`#見出し` の区画解決（文書順の最初の一致、`#A#B` の入れ子、大文字小文字・空白・`:#|^` の正規化、リスト項目は対象外、ブロック参照と見つからない見出しは null）、描く木（全体は本体＋フリートピック、見出しは部分木だけ）、開いた時点の折りたたみ（ルート直下より下の全枝）、タイトルの `![[ノート]]` のリンク化。jsdom で製品の post-processor を Obsidian 風の区画に通し、閲覧モード経路（placeholder の差し替え、Obsidian が先に読み込んだ span は claim、対象外の素通し、部分木と見つからない見出しの文言、`mappy-layout` とフリートピック、原文不変、保存と別 leaf の未保存編集での再描画、読者の折りたたみの保持（一時的な文言をはさんでも）、マップでなくなった場合の文言、区画の unload でのリスナー解放、プラグイン unload での placeholder の復元とその枠を含む閲覧モードの view だけの描き直し、「マップで開く」とノード内リンクの基準、Fit の上限 1 倍、自己埋め込みとタイトル経由の循環がないこと）とライブプレビュー経路（容器の claim が 1 度だけ、区画の中の anchor が寿命を持ち枠は容器に付くこと、Obsidian のクラスの退避と復元、自分のノートの閲覧モードは対象外、通常ノートの埋め込みの中のマップは描き claim した容器の中の placeholder は描かない、未接続の区画の見直しと unload 後の拒否）を確認する。
- ハーネス: `tests/tooling/preflight.test.mjs` が一時ディレクトリに配布物と生成 Vault を組み立て、`community-plugins.json` が `["mappy"]`（生成直後）と `["mappy", "obsidian-excalidraw-plugin"]`（M6 の Vault）なら preflight が通り、他のプラグインが有効・mappy が無効・プラグイン ID の配列でない内容なら失敗すること、CLI の終了コードと表示、`prepare-test-vault.mjs` の再実行で Excalidraw が残り他のプラグインが落ちることを確認する。

Vitest の Node 環境で検証する。乱択・property-based test は、保存と復元の不変条件に効果がある場合に追加する。

### DOM とブラウザ

jsdom を導入し、製品の DOM 操作・インライン入力・キー操作を検証している。composition イベントを送るテストは変換中のキー制御を検証するもので、OS の日本語 IME で入力した結果ではない。DOM の実測サイズ、フォント、画像遅延、ポインター操作、ズームの見た目は、下記②のブラウザ検証ページと③の Obsidian 実機で確認する。

### ② ブラウザ検証ページ（Obsidian 非依存）

`harness/browser/` にあるページで、製品の `src/ui/mindmap-view.ts`・`node-renderer.ts`・`map-viewport.ts`・`map-events.ts`・`inline-editor.ts` と `core` / `layout` / `interaction` / `document-store.ts` をそのまま読み込む。`obsidian` モジュールだけを `harness/browser/obsidian.ts`（`tests/mocks/obsidian.ts` と同系統のモック。Component・ItemView・Menu・Modal・Notice・setIcon・MarkdownRenderer の最小実装）に差し替え、Obsidian が起動時に生やす DOM ヘルパー（`createDiv`、`addClass`、`event.targetNode` など）は `harness/browser/dom.ts` が同じ形で prototype に載せる。Vault・workspace・metadataCache・fileManager は `harness/browser/app.ts` のメモリ内実装で、ファイルへは何も書かない。

- 起動: `npm run harness:browser` で `dist/harness/` をビルド・監視し、`http://127.0.0.1:8765/` で配信する（`--port` で変更）。`npm run harness:browser:build` は一度だけビルドし、`dist/harness/index.html` を `file://` で直接開ける。ビルドは製品と同じ esbuild を使い、ランタイム依存を追加しない。
- fixture: `tests/fixtures/` の `heading-document`（従来の見出し形式・リンク・画像）、`roundtrip-edge-cases`（同名見出し・コードブロック・欠落画像）、`uneven-branches`（H2＋リスト、8 段の一列の枝、24 兄弟、長い日本語、リンク・画像・コードブロック、同名ノード）、`free-topics`（複数の H2: 本体＋フリートピック 3 つ、`mappy-topics` のレイアウト別位置・引用符付きキー・孤児キー、位置未設定の既定配置）と、`scripts/performance-fixtures.mjs` が生成する 10／100／500／2,000 ノード。`harness:prepare` が `test-vault/Fixtures/` に置く文書と同一で、ページ左の select か `?fixture=<id>` で切り替える。
- 埋め込み（M10、E34）: select の「埋め込み（ホストノート）」は map view ではなく、`tests/fixtures/embed-host.md`（`mappy: true` のない通常ノート）を描いた区画に製品の post-processor（`src/ui/map-embed.ts` の `MapEmbeds`）を通す。ホストは `uneven-branches`（通常マップ）、`embed-timeline`（`mappy-layout: timeline`）、`embed-hierarchy`（見出し形式・`mappy-layout: hierarchy`・同名の `### 同じ名前` が 2 つ）、`embed-hierarchy#同じ名前`（部分木）、`embed-2000`（`makeEmbedFixture()`: 均等な枝 2,000 ノードに `mappy: true` を付けた生成文書。`harness:prepare` も書く）を埋め込み、`heading-document`（`mappy: true` なし）・存在しないノート・`embed-hierarchy#^block`（ブロック参照）は Obsidian の通常の埋め込みのまま（このページは中身を描かず placeholder を出す）。`embed-host` は閲覧モード相当（ホストの区画の `.internal-embed` を差し替える経路）、`embed-host-live` はライブプレビュー相当（埋め込み先のノートを Obsidian 風の `.internal-embed.markdown-embed` 容器に描いてから、その区画を埋め込み先の sourcePath で processor に渡す経路）。`window.__mappyHarness.embeds()`（各埋め込みの種別・レイアウト・ノード・scale・文言）、`liveEmbeds()`、`disposeEmbeds()`（プラグイン無効化と同じ解放）、`putNote()`（元ノートの書き換え）を持ち、暗色はページのテーマ（`setPageTheme("dark")`、`?page-theme=dark`）で確認する。Obsidian の描画順序・ホバープレビュー・実テーマ・埋め込み内リンクの遷移は③で確認する。
- 操作: 選択（クリック・矢印キー）、開閉（分岐点の − と Space）、パン（背景ドラッグ・ホイール）、ズーム（Ctrl/⌘＋ホイール、ピンチ、右下の −／倍率／＋／全体表示）、レイアウト切替、右クリックメニュー、ペインのサイズ変更（プリセット、数値、右下の角のドラッグ。変更ごとに製品の `onResize()` を呼ぶ）、「閉じて開き直す」（`onClose`→`unload`→新しい view）、テーマ（「ページ」は body の `theme-light`／`theme-dark` で Obsidian の外観に相当、「マップ」は設定「テーマ」に相当し製品の `setTheme()` を呼ぶ。`?theme=light|dark|follow`、`?page-theme=dark` で初期値を指定。`window.__mappyHarness.setPageTheme()`／`setMapTheme()`／`themes()`）。Enter／Tab／F2／Delete と右クリックの編集、フリートピックの追加（空白のダブルクリック・右クリック）・ドラッグ移動・削除はメモリ内の文書に対して動き、`window.__mappyHarness.source()` で現在の原文を読めるが、保存経路の検証ではない。
- 時刻の記録: fixture 切替ごとに `parseMarkdown` 単体、`setState` 完了、最初の描画フレーム、位置が 3 フレーム安定するまでの経過 ms をページ左の一覧と `window.__mappyHarness.timings`、Performance タイムラインの `mappy:load:<id>` に残す。1 回分の生値で、繰り返しと p50／p95 は下記の性能計測が扱う。
- 性能計測: `node scripts/browser-harness-perf.mjs` は同じページを headless Chrome で開き、`scripts/performance-fixtures.mjs` の 10／100／500／2,000 ノード × 6 つの形（見出し形式、H2＋リストの均等な枝、深い一列の枝、多数の兄弟、長い日本語、リンク・画像）を、マップ・タイムライン・階層図・左右バランスの 4 レイアウトで計測する。fixture ごとに新しい Chrome を起動し、レイアウトごとに、新しい view での読み込み（`parse`・`setState`・ノードの計測・`layoutTree`・配置フレーム・次フレーム開始・初回配置・安定）10 回、Markdown 側の編集（`modify` → 45 ms の debounce → 再読込〜DOM → 配置フレーム → 次フレーム開始）10 回、インライン編集（キー入力 30 回と Enter の確定 10 回）、パン／ズーム各 2 回 × 60 フレーム（1 フレームに 1 wheel）を `harness/browser/measure.ts` の探針（製品の requestAnimationFrame と setTimeout を包み、編集ノードの MutationObserver で DOM 更新の時刻を取る。`src/` は触らない）で取り、nearest-rank の p50／p95 と基準端末（CPU・メモリ・OS・Node・Chrome・フラグ・load average・build）を `artifacts/performance/<日時>/record.md`（`samples.json`・`summary.json` も）に書く。`--counts`・`--shapes`・`--fixtures`・`--layouts`・`--repeat`・`--keystrokes`・`--frames` で範囲を絞り、`--gpu` で `--disable-gpu` を外して GPU ラスタで比較する。画像は data URL で転送時間を含まない。テーマは `harness.css` の仮の値で、Obsidian の Editor と Vault を持たないため、実機の値（E10、`artifacts/lev-33-realtime-verification-2026-09-18.md`）と突き合わせて読む。
- 自動撮影: `npm run harness:browser:capture` は headless Chrome（`--chrome <path>` か `MAPPY_CHROME`、既定はインストール済みの Google Chrome）を DevTools Protocol で操作し、全 fixture の Fit 表示と、`uneven-branches` での選択・矢印キー・開閉・パン・ホイール・Ctrl＋ホイール・ズームボタン・タイムライン・階層図（親ごとの段揃えと深さごとに一定の隙間、`mappy-layout: hierarchy` の書き込み、折りたたみの件数）・640×480／390×700 のサイズ変更・右クリックメニュー・内部リンククリック・F2 入力→Enter→⌘Z（メモリ内の改名と Undo）・閉じて開き直し、`performance-2000` の開閉、左右バランス（`balanced`: 第一階層が原文順に右・左・右・左、下位はその側、各側の列がルートの高さ中央、`mappy-layout: balanced` の書き込み。`balanced-collapse`: 左側の「多数の兄弟」の開閉ボタンが左の幹にあり、閉じると件数 24 がノードの左に出て右側の枝は動かない。`balanced-scene`: `window.__mappyHarness.scene()` で組み立てた Excalidraw 挿入のシーンの各ブロックが画面上のノードとルート基準で一致し、線がすべて直角。`fold-2000-balanced`: `performance-2000` を左右バランスで開き、100 節が右・左 50 ずつ、左側の「第2節」を閉じて 19 ノードが隠れ再展開で戻る）、`heading-document` を階層図にして親ごとの段（`hierarchy-rows`: 兄弟は同じ上辺、画像付きの親の子だけが下がり、文字だけの枝の隙間は画像付きの親の子と同じ長さ。`hierarchy-rows-back` で「通常マップ」に戻しキーが消える）、`uneven-branches` でテーマ（`theme-follow-light`／`theme-dark-on-light`（開き直し後も保持）／`theme-light-on-dark`／`theme-follow-dark`／`theme-back`: コンテナの class と、キャンバス背景・ノード文字・リンクの computed color、`color-scheme`、ページ背景が仮の配色どおりに切り替わること）、`free-topics` でのフリートピックの追加（空白のダブルクリック→入力→Enter）・Undo／Redo・ドラッグ移動（位置ありと位置なし、Escape での取り消し）・削除→Undo→Redo・ノードへのドラッグで合流（スロットの事前表示、区画→枝、Undo）・トピックをノードの隣に運ぶだけでスロットが出ること（`topic-snap`。ポインターは相手に乗らない。階層図では葉の真下（`topic-snap-hierarchy`）、タイムラインでは子のないステージの真上の森が始まる位置（`topic-snap-timeline`）と軸上のステージの隙間（`topic-snap-timeline-axis`）、左右バランスでは左側の葉「ふりかえる」の左隣（`topic-snap-balanced`）で同じことを確認する。レイアウトは view state で切り替えて Fit し、`mappy-layout` は書かない）・本体のドラッグ（viewport の追従と全項目の書き換え、Undo）・本体の枝を空白へドラッグして切り離し（枝→区画、離した位置、Undo）・空白の右クリックメニューを実行し、原文と `mappy-topics` の前後を比較する。SVG／PNG 書き出し（M13）は `uneven-branches` で「多数の兄弟」を閉じてから `window.__mappyHarness.export.svg()`／`png()` を呼び、SVG（`export-uneven-branches.svg`）の `foreignObject` 数・線の数・バッジ 24・画像がすべて data URL であること・欠落画像のノードが残ることを DOMParser で確かめ、その SVG を Chrome の別タブで開いて各 `foreignObject` が宣言した座標に描かれ画像が復号されることを読み取り撮影する（`export-uneven-branches-rendered.png`）。PNG（`export-uneven-branches.png`）は IHDR の寸法が SVG のサイズ × 2 に一致すること、`performance-2000-links` では SVG と PNG が完了し PNG がデスクトップのピクセル上限に収まることを記録する。埋め込み（`embed-*`、E34 のこのページ版）は `embed-host` を閲覧モード相当で読み込んで 5 つのマップと 3 つの通常の埋め込みを確認し（各マップのレイアウトが元ノートの `mappy-layout` に一致、ノードが枠内、scale ≤ 1、ホストと元ノートの原文不変）、階層図の埋め込みのルート直下の件数（4／2／1）と部分木のルート、開閉ボタンのクリック（一段だけ開いて枠に収まり直し、再クリックで戻る）、2,000 ノードの埋め込み（ルート＋13 ノードだけを描き、ホスト全体が 1 秒以内に安定）、元ノート `embed-timeline` の書き換えと復元での再描画、「閉じて開き直す」（live の数が増えない）、ページの暗色テーマ、`embed-host-live`（容器 5 つ、Obsidian の内容は非表示、通常の埋め込みは中身が見える）、解放（`disposeEmbeds()`: 枠と Component が消え、ライブプレビュー相当では容器の内容が再び見え、閲覧モード相当では placeholder が元の src で戻る）を確認する。各ケースの PASS／FAIL、時刻、全画面とペイン 2 倍のスクリーンショットを `artifacts/browser-harness/<日時>/record.md` に書く。Chrome がなければ未実施と書いた record だけを残して終了コード 2 になる。headless Chrome 153 は修飾キー付きのキー入力（⌘Z・⌘⇧Z）を CDP で繰り返すとブラウザプロセスが応答しなくなることがあるため、フリートピックのケースの Undo／Redo は右クリックメニューで行い、プロトコル呼び出しが 60 秒応答しなければ以降を FAIL として record を書いて終了する（`MAPPY_CAPTURE_TRACE=1` で呼び出しを逐次表示）。
- 対象外: 保存（Vault・Editor への書き込み。SVG／PNG 書き出しもファイルにせず文字列を返すだけで、添付設定の保存先は③）、リンク解決（クリックは通知と記録だけ）、Obsidian の配色（`harness.css` の CSS 変数は仮の値。ただし app.css と同じ構造——素の配色を `.theme-light`／`.theme-dark`、意味変数を `body` に置く——にしてあり、設定のテーマが class と変数の導き直しで切り替わることまでは確認できる。実際の配色とコミュニティテーマは③。書き出しの色もその仮の値）、Vault の画像の読み取り（このページの画像は data URL なので resolver は素通し）、日本語 IME（合成イベントは OS の変換ではない）、トラックパッドとモバイルの実入力。これらは③で確認する。

このページでの成功を Obsidian の保存・リンク解決・テーマでの成功と呼ばない。Obsidian 実機の確認（下記 E01〜E34）が E2E に相当し、このページはその代替ではない。

### Obsidian 実機の初回準備

1. まだ試用していない専用環境で `npm run harness:prepare` を実行する。生成するのはこのプロジェクト内の `test-vault/` のみ。
2. Obsidian でそのフォルダを Vault として開く。必要な初回の制限モード設定はテスト環境で行う。M6 のケース（E23〜E27・E30・E33）には Excalidraw（`obsidian-excalidraw-plugin`）をこの Vault にインストールして有効にする。
3. `npm run harness:preflight` を実行する。これはファイルと設定の検査であり、実行中プラグインが最新である証明ではない。有効プラグインは mappy と Excalidraw（M6 用）だけを有効にする。それ以外が有効なら preflight は失敗し、実機確認の条件に含めない。
4. プラグインを再読込し、対象 Vault と機能の挙動を画面で確認する。将来は表示する build ID も照合する。
5. 下記ケースを再現し、UI の状態と変更後の Markdown を両方保存する。

`harness:prepare` は既知の fixture を初期化するため、ユーザーが試用中の Vault には再実行しない。生成 fixture に書いたノードも利用者の変更として保持する。再実行した場合、`community-plugins.json` は mappy と、すでに有効なら Excalidraw だけを残して書き直す（Excalidraw の配布物と設定には触れない）。既存の Evergreens Vault や taskchute-plus の配布物は操作しない。

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
| E05 | 外部更新と map 編集を競合させる | 古い状態で上書きせず入力も復旧可能。保持した入力はマップの自動更新後にもう一度 Enter すれば更新後の文書に適用される。編集中のノードのタイトル／本文が外部で変わっていた場合、同名ノード、消えたノードでは拒否されて入力が残る（同じタイトル・本文のまま位置だけ変わったノードには適用する）。拒否のあと view 自身が再読込し、inline と本文モーダルのエラー行が「Markdown が更新されました…」に変わる |
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
| E31 | 設定タブで 3 項目を変更 → 既存ノートを開き直す → 新規マップを作成 → Obsidian の外観を明暗で切り替える → Obsidian を再起動 | 設定タブに 3 項目だけが並ぶ（1.13 以降は設定検索にも出る）。既存ノートの本文・frontmatter・表示レイアウトは変わらない。新規マップは作成先フォルダに `mappy-layout` 付きで作られ、そのレイアウトで開く。テーマの明示指定では map view のコンテナだけが明色／暗色になり、リンク・コード・画像・浮かせた UI・インライン入力が両方で読める。「Obsidian に従う」で外観に追従し、再起動後も設定が残る。コミュニティテーマでも破綻しない |
| E32 | 明色・暗色それぞれで、画像（Vault の PNG・欠落・外部 URL）と閉じた枝を含むマップを「現在のマップを SVG／PNG に書き出し」 | 添付ファイルの保存先に `<ノート名>.svg`／`.png` ができ、元ノートは不変。SVG を Obsidian 外のブラウザで開くと map view と同じ配置・折りたたみ・テーマの色で、Vault の画像が埋め込まれ、欠落画像のノードは代替テキストで残る。PNG は 2 倍の寸法。モバイルでは PNG の可否と縮尺 |
| E33 | 左右バランスを選択→Markdown へ切替→マップへ戻る→左側の枝を閉じる→「現在のマップを Excalidraw の図面に挿入」（E26・E30 の左右バランス版） | `mappy-layout: balanced` が保存され、再度そのレイアウトで開き、通常マップ選択では任意キーだけを削除する。第一階層が原文順に右・左・右・左に分かれ、左側の枝の開閉ボタンと折りたたみバッジが左に出て、本文は変わらない。挿入した要素は 1 グループで、ルートが中央、第一階層が右・左に分かれ、左側の線がルートの左辺から子の右辺への直角の折れ線になり、要素の位置がマップ表示と一致する（実機は未実施。LEV-61 で行う） |
| E34 | `Fixtures/embed-host.md` を閲覧モード・ライブプレビューで開き、`[[embed-host]]` のホバープレビューも出す。元ノート `embed-timeline` を別 leaf で編集。埋め込み内の開閉ボタン・リンク・右上の「マップで開く」。ホストを閉じる。Mappy を無効化 | 3 つの表示すべてで 5 つの `![[…]]` が読み取り専用のマップ（通常・タイムライン・階層図・`#同じ名前` の部分木＝回復する の下の最初の一致・2,000 ノードはルート＋13）になり、`heading-document`・存在しないノート・`#^block` は通常の埋め込みのまま。明色・暗色テーマで枠・線・件数バッジが読める。別 leaf の編集（未保存でも）で埋め込みが更新され、ホストと元ノートの原文は変わらない。開閉はマップ内だけで原文を変えず、リンクは元ノート基準、「マップで開く」で元ノートがマップで開く。ホストを閉じたあと DOM・イベントが残らず（DevTools のメモリ／`app.workspace` のリスナー）、2,000 ノードの埋め込みがあってもホストの入力・スクロールが止まらない。無効化で通常の見出し＋箇条書きの埋め込みに戻る |

CDP でキー操作を再現するとき、要素へ送る合成 `keydown` は Obsidian のキーマップを通らない。Obsidian の既定ホットキーと重なるキー（F2 = `workspace:edit-file-title`）は `Input.dispatchKeyEvent` の実キーでも確認する。E03〜E05 の組み合わせ（同じノートの 2 leaf・別ウィンドウ・外部変更の直後・フリートピック＋階層図・実キー）は `artifacts/lev-16-multiview/obsidian-multiview-probe.mjs` が各ステップの前後の Markdown を 4 経路（ディスク・`cachedRead`・editor・各 map の解析元）で保存してバイト比較する。

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

`test-vault/Fixtures/` には初回準備時に静的 fixture と 10/100/500/2000 ノードの文書（見出し形式と 5 つの形の H2＋リスト、計 24 ファイル）を生成する。CRLF・末尾改行なし・途中 IME のような条件は、対応するテストで明示的に作る。レイアウトの幾何テストは性能測定の代わりにしない。性能は②の `scripts/browser-harness-perf.mjs`（ブラウザでの解析・配置・描画・入力反映の p50／p95）と、実機の入力から画面反映まで（E10、LEV-33 の `obsidian-realtime-probe.mjs`）を分けて記録する。`node scripts/measure-layout.mjs` は同じ生成文書で `layoutTree` 単体の配置時間（4 モード、展開と折りたたみ、中央値・p95・最大値）を `artifacts/layout-timing/<日時>/` に記録するが、DOM 計測を含まないレイアウト単体の数値であり、§6 の実機計測の代わりにはならない。

## 公開前の追加確認

現在はローカルで試用するプロトタイプであり、README・LICENSE の存在だけで公開可能とは扱わない。製品の受入条件、実機対応、公開ライセンス、作者表記、名称・ID の重複、説明文を確認する。`manifest.version` と同じタグで必要な配布物を GitHub release に添付する。

提出時には公式ドキュメントで手順を再確認し、自動レビューの指摘を解決する。sample README と差がある場合は提出時点の公式ドキュメントを優先する。[提出手順](https://docs.obsidian.md/plugins/releasing/submit-plugin)、[提出要件](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)

コードを参考にした製品の権利表示・公開方針も確認する。今回 MarkMind と Light Mindmap の製品ソースはコピーしていない。[Developer policies](https://docs.obsidian.md/community-directory/developer-policies)
