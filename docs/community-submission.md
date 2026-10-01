# コミュニティ公開審査の要件と英語化の方式

LEV-136（2026-09-27）。本人の決定: **コミュニティプラグインの公開審査に出す方向で進め、英語化を次の大きな柱にする。AI 機能（M9、LEV-28）は当面保留。**（この保留は 2026-10-01 に本人が解いた。`product-plan.md` §5 M9） 本書はその前提で、審査要件と Mappy の現状の対応表（§1）と、英語化の方式の比較と推奨（§2）を記す。決定そのものは `product-plan.md` §5 M5 と §7 が正本で、本書は根拠と作業の分け方を持つ。

- 参照した公式文書（2026-09-27 に取得）: [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)、[Submission requirements for plugins](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)、[Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)、[Developer policies](https://docs.obsidian.md/community-directory/developer-policies)。公式 ESLint プラグイン `eslint-plugin-obsidianmd` 0.4.2 の規則（`node_modules` で確認）
- 前回の照合は LEV-24（2026-09-19、47 項目。`artifacts/lev-24-readme/record.md`、git 管理外）。項目の分け方の正本は `docs/harness.md`「審査要件のチェック項目」で、本書の表はそれを 0.3.8 の木（`main` の `0e8c4d1`）で照合し直し、2026-09-27 の公式文書で変わった点（提出の手順など）を足した**この時点の結果**である（例外: #2・#27・#29・#31・#32 は README の英語版〔LEV-227、#122〕が、#12・#14・#16 は LEV-241 が英語化〔LEV-226〕のあとの木〔2026-09-28、`16d8384`〕で書き直した。ほかの行は 0.3.8 の木のまま照合し直していない）。番号は本書の中だけのもの。**§1.1〜1.7 の 32 行は harness.md の項目をすべては写していない**（§1.8 の 6 行は LEV-228 が足した。§1.1〜1.7 は、`version` の 4 ファイル一致、manifest の不明なキー、サンプルコードの残り、`fs`／`process` の不使用、`dist/mappy/` の 3 ファイルとサイズ、`main.js` をコミットしないこと、README の保存形式・導入・復旧・対応環境の節などを、LEV-24 から変わりうる点が無いと見て省いた）。提出の直前の再確認（LEV-228）は harness.md の全項目で行い、本書との食い違いはそこで片付ける。**表の PASS も公式 lint の通過も、審査の通過を保証しない**（審査は提出時点の公式文書と人のレビューで決まる）
- **提出の直前の再確認（LEV-228、2026-09-28、0.4.0 の木 `ff49476`）は §4。** §1 の行は §4 の結果で「結果」と「担当」を書き換え、LEV-136 が読んでいなかった Community directory の 3 文書（FAQ・Manage your plugin or theme・Set up and claim）と Release your plugin with GitHub Actions から増えた項目を §1.8 に足した
- **0.4.1 の自動レビューの結果と対応（LEV-253）は §4.7。** §1.8 に #39（CSS lint）・#40（Vault の列挙）を足した
- **本人の決定（2026-09-28）と提出する版（LEV-249）:** #3 は §4.3 の (a)（0.x も通常の Release）、#9 は §4.4 の (B)（`isDesktopOnly: true`）、#35 は入れる。3 つとも 0.4.1 から効き、提出した版は 0.4.1（LEV-249・LEV-250 の merge のあとの `e1978e2` に tag を打って 2026-09-28 に公開し、提出して一覧に載った。本人の報告）。§4 の結果（0.4.0 の木）は 0.4.1 の木で取り直す予定だった（§4.6 の 2）が、取り直しの記録は無い（§3。スキャナーの Build verification は 0.4.1 で Pass。§4.7）
- 公式文書の**どれにも UI・README の言語の要件は無い**（4 文書とも、言語・英語・ローカライズへの言及なし）。英語化は審査の必須条件ではなく、一覧の読者（英語）に届けるための判断である

## 1. 審査要件と現状

結果の凡例: PASS（根拠つきで満たす）／要対応（提出前に直す）／未実施（実機や本人の確認が要る）／判断（本人が決める）。「担当」は残る作業を持つチケット。LEV-226〜228 は本書 §3 で切った LEV-136 の子、LEV-25 は既存の別チケット（対応環境の宣言と実機検証）で LEV-136 の子ではない。

### 1.1 提出の手順と必須ファイル

| # | 要件（出典） | Mappy の現状 | 結果 | 担当 |
| --- | --- | --- | --- | --- |
| 1 | リポジトリのルートに `README.md`・`LICENSE`・`manifest.json`（Submit） | 3 つとも在る。LICENSE は MIT | PASS | — |
| 2 | README は目的と使い方を説明する（Submit） | `README.md` は英語で、目的・保存形式・導入・操作・対応環境・制限・復旧・ネットワーク・ライセンスを持つ。日本語版は同じ節で `README.ja.md`（先頭で互いにリンク。LEV-227。それまでは日本語の `README.md` だけだった） | PASS（要件は言語を問わない） | LEV-227 |
| 3 | `manifest.version` と同じ `x.y.z` タグの GitHub Release に `main.js`・`manifest.json`・`styles.css` を添付（Submit） | `release.yml` が検査して添付（LEV-68）。0.4.0 までは **0.x のタグが必ず pre-release になっていた**（`0.*) prerelease="--prerelease"`）。2026-09-28 の本人決定（§4.3 の (a)）で LEV-249 がこの分岐を外し、0.4.1 から 0.x も通常の Release（`tests/tooling/release-workflow.test.mjs` が `--prerelease` の無いことを検査） | PASS（Submit の文面は満たす）／決定済み（§4.3 の (a)。公式文書は今も pre-release の可否に触れておらず、一覧 8,143 件で掲載版が pre-release のものは 0 件。0.4.1 の Release は `gh release view 0.4.1 --json isPrerelease` が `false`〔LEV-254 が 2026-09-28 に確認〕） | LEV-249 |
| 4 | 提出は community.obsidian.md で Obsidian アカウントに GitHub を連携して行い、自動レビューの指摘には版を上げた Release で応える（Submit） | 0.4.1 を提出し、一覧に載った（本人の報告、2026-09-28。一覧のミラーに `mappy` が在ることは 2026-09-29 の取得で確かめた〔LEV-259〕）。自動レビューの結果は §4.7。obsidian-releases の `community-plugins.json` には、LEV-254 が 2026-09-28 に取得した時点（8,162 件）で `mappy` はまだ無く、LEV-259 が 2026-09-29 に取得した時点では在る。obsidian-releases の PR による提出（`community-plugins.json` にエントリを足す PR）は 2026-05-15 に廃止され（PR テンプレートと検証の workflow を削除）、同リポジトリの `community-plugins.json` は community.obsidian.md の一覧の 1 時間ごとのミラーになった（§4.1） | 未実施（後半。提出は 0.4.1 で済んだ〔本人の報告〕。指摘への版を上げた Release は 0.4.2〔2026-09-28 に公開〕で、その再走査の結果の記録はまだ無い。0.4.3〔2026-09-29 に公開〕は指摘への対応を足した版ではないが、その走査の結果も同じ §4.7 に版の小見出しで記録し、§4.6 の 2 の tag と HEAD の判別に使う〔LEV-262、2026-09-29〕。0.4.4〔2026-09-29 に公開〕・0.4.5〔LEV-264 の merge のあと、product-plan.md §5 M5 の 0.4.5 の段落にある tag の前の条件を満たしてから tag を打って公開する予定〕も同じ〔LEV-264〕。手順は §4.6） | LEV-228（本人） |
| 5 | `id` は公開済みの全プラグインで一意、`obsidian` を含まない（Submit・Requirements） | `mappy`。`scripts/validate-release.mjs` が形を検査。一覧との衝突は本人が 2026-09-19 に確認し、2026-09-28 に一覧（8,143 件）と削除済みの一覧（175 件）の `id`・`name` で衝突 0 を確かめた（§4.2） | PASS（提出の当日にもう一度確かめる。0.4.1 の提出の当日に確かめたかは記録が無い） | LEV-228（本人） |

### 1.2 manifest

| # | 要件（出典） | Mappy の現状 | 結果 | 担当 |
| --- | --- | --- | --- | --- |
| 6 | `description`: 動詞で始める、`This is a plugin` で始めない、250 字以内、ピリオドで終わる、絵文字・特殊文字なし、固有名詞と頭字語の大文字（Requirements） | `View and edit Markdown as linked, illustrated mind maps.`（56 字、英語） | PASS | — |
| 7 | `fundingUrl` は寄付を受けるときだけ置く（Requirements） | 無し | PASS | — |
| 8 | `minAppVersion` は必要な最小版（Requirements） | `1.8.7`。型 1.8.7 で型検査が通る。1.8.7 の実機は未確認 | PASS（型）／未実施（実機） | LEV-25 |
| 9 | Node／Electron API を使うなら `isDesktopOnly: true`（Requirements） | 0.4.0 までは `false`。2026-09-28 の本人決定（§4.4 の (B)）で LEV-249 が `true` にし、0.4.1 からデスクトップ専用（両方の README の「対応環境」のモバイルの行も合わせ、`tests/tooling/desktop-only.test.mjs` が manifest と行の一致を検査する）。`src/` に Node／Electron の import 0 件（ESLint で禁止）。公式 lint の `recommended` は manifest を読み、`isDesktopOnly: true` では `no-nodejs-modules` を切り、後読みを報告せず、Node の global を足すので、`eslint.config.mjs` が `src/` でその 3 つを manifest に依らず有効に戻す（LEV-249。`tests/tooling/mobile-lint.test.mjs`）。バンドルの `require` は `obsidian`（0.3.8 で 17、0.4.0 で 18）・`@lezer/common`・`@lezer/highlight` だけ | PASS（コード）／決定済み（(B)。要件はどちらでも満たす）／未実施（モバイル実機。確かめたら版を上げて `false` に戻す） | LEV-25 |
| 10 | `name` に `Obsidian`・`Plugin` を含めない、`author` を置く（上の 4 文書には無い。`scripts/validate-release.mjs` の検査と LEV-24 の記録による） | `Mappy`、`Hiroya Iizuka` | PASS | — |

### 1.3 コマンド・UI 文言

| # | 要件（出典） | Mappy の現状 | 結果 | 担当 |
| --- | --- | --- | --- | --- |
| 11 | コマンド ID にプラグイン ID を前置しない（Requirements） | 10 コマンド（`create-mindmap` … `call-map`、`convert-to-list`）。前置なし | PASS | — |
| 12 | コマンド名にプラグイン名を入れない、既定ホットキーを置かない（Guidelines） | 名前は `src/i18n` の表から引き、英語（`Create new mind map` など）・日本語のどちらも `Mappy` を含まない（2026-09-28、LEV-226 のあとの木で確認）。`hotkeys` の指定 0 件 | PASS | — |
| 13 | 条件付きは `checkCallback`、無条件は `callback`（Guidelines） | LEV-24 から形は同じ | PASS | — |
| 14 | UI 文言は sentence case（Guidelines） | 0.3.8 の時点では日本語なので実質何も検査していなかった。LEV-233 で `eslint.config.mjs` に `src/i18n/en.ts` を対象とする `ui/sentence-case-locale-module` の block を足し、`npm run lint` が英語の表を検査する（`tests/tooling/i18n-lint.test.mjs`）。値を差し込む関数（27 個。通知の `exitDraftNotSaved` など）の中の文字列は規則が読まない | PASS（文字列の値は lint、関数の文言 27 個は 2026-09-28 に目で確認。§4.2） | — |
| 15 | 設定の見出しは区画が複数のときだけ、見出しに「settings」を入れない、`setHeading()` を使う（Guidelines） | 見出しなしの 4 項目（テーマ・既定レイアウト・作成先フォルダ・左下のレイアウト） | PASS | — |
| 16 | UI の言語（要件なし） | 0.3.8 の時点では UI 文言が 24 ファイルに約 200 個、すべて日本語だった。§2 の (b) を 2026-09-28 に本人が確定し、LEV-226（LEV-233・LEV-234・LEV-235、#118・#120・#121）で `src/i18n` の表へ移した: Obsidian の言語が `ja` なら日本語、それ以外は英語。`src/` の日本語の文字列は `src/i18n/ja.ts` だけ。英語の Obsidian での実機確認は E63（macOS、Obsidian 1.14.2）の面だけ（コマンド名・ボタン・ポップオーバー・右クリックメニュー・タブの題名・設定タブと、仮の名前 `Subtopic`・core の拒否の文）。通知の全文、E63 以外の操作、Windows・Linux・モバイルは未実施。0.4.0 で初めて出る | PASS（(b) で実装）／未実施（E63 以外の面の実機。2026-09-28 の再確認〔§4〕では実機を回していない。提出の前に回すかは本人が決める） | LEV-228 |

### 1.4 セキュリティ・リソース・ワークスペース・Vault

| # | 要件（出典） | Mappy の現状 | 結果 | 担当 |
| --- | --- | --- | --- | --- |
| 17 | `innerHTML`／`outerHTML`／`insertAdjacentHTML` を使わない（Guidelines） | 0 件 | PASS | — |
| 18 | グローバル `app`・`workspace.activeLeaf` を使わない（Guidelines） | `activeLeaf` 0 件。`app` は引数と `this.app` だけ | PASS | — |
| 19 | ログは既定でエラーだけ（Guidelines） | `console.*` は `document-store.ts` の `console.error`（書き込みの購読者が投げた例外）1 件だけ | PASS。harness.md の項目をガイドラインに合わせて「`console.error` 以外がない」にし、`eslint.config.mjs` の `no-console`（`allow: ["error"]`）で `src/` を検査する（公式 lint の `recommended` は `warn`・`debug` も通す。`tests/tooling/console-lint.test.mjs`。LEV-228）。lint は `console.x(...)` の形しか読まないので、再確認では grep（`console\.`）も回す（`window.console.warn(...)` などは lint を通る） | — |
| 20 | unload で登録を解除し、`onunload` で leaf を閉じない（Guidelines） | `register*` と `this.register` で解除。`detachLeavesOfType` なし。テストあり（LEV-24 の #31〜35） | PASS（テスト）／未実施（実機の無効化・再有効化・ペインの閉開） | LEV-25 |
| 21 | 開いたノートは Editor、背景の変更は `Vault.process`、frontmatter は `processFrontMatter`（Guidelines） | 開いた文書は Editor、閉じた文書は `Vault.process` 内で原文を照合（AGENTS.md の規約）。明示の変換・解除（`mappy`・`mappy-layout` の書き込みと削除）は `processFrontMatter`（`obsidian/frontmatter.ts`）。マップの編集に伴う `mappy-layout`・`mappy-topics` の更新は、マップ自身の編集と同じ書き込みの列に載せるため**原文範囲の差分**で書く（LEV-196。列の外で書くと、その間に計画した編集が他者の変更として拒否された） | 判断（後者はガイドラインからの意図的な逸脱）。問われたときの英語の説明は §4.5 | — |
| 22 | `WorkspaceLeaf.prototype.setViewState` の差し替え（ガイドラインに記述なし） | Excalidraw・Kanban と同じ方式。解除で元に戻り、後から包まれていても素通し（テストあり） | PASS（テスト）／審査で説明を求められうる。英語の説明は §4.5 | — |
| 23 | 正規表現の後読みを使わない（モバイル。Guidelines） | 0 件 | PASS | — |

### 1.5 スタイル

| # | 要件（出典） | Mappy の現状 | 結果 | 担当 |
| --- | --- | --- | --- | --- |
| 24 | 静的な見た目をインラインスタイルで書かない。CSS 変数を使う（Guidelines） | インラインは位置・寸法（レイアウトの結果）だけ。lint の `no-static-styles-assignment` が通る | PASS | — |
| 25 | CSS を自分の要素に限定する（Guidelines の意図） | `.mappy-*` と `.internal-embed.mappy-embed-host`（埋め込みの置き場）。0.4.1 までは `!important` が `.mappy-view { padding: 0 }` の 1 件あり、自動レビューの CSS lint が Warning にした（#39）。LEV-253 で詳細度に置き換えた | PASS | — |

### 1.6 開発者ポリシー

| # | 要件（出典） | Mappy の現状 | 結果 | 担当 |
| --- | --- | --- | --- | --- |
| 26 | 難読化・動的広告・クライアント側テレメトリ・自己更新をしない（Policies） | どれも無い。本番は esbuild の標準 minify（難読化ではない） | PASS | — |
| 27 | ネットワーク利用は使う先と理由を明示する（Policies） | 自前の通信は SVG／PNG 書き出しでノートが参照する外部画像を `requestUrl` で取る 1 経路だけ（`image-export.ts`）。表示はノートの外部画像を Obsidian と同じく読む。README「Network use」（英語）と `README.ja.md`「ネットワーク利用」に同じ内容で開示（LEV-227）。**M9（AI 機能）を main へ入れる時点で、ライセンスの登録・リフレッシュの通信と、起動した CLI（Claude Code / Codex）がノートの内容を Anthropic・OpenAI へ送ることをこの行と README に足す**（`feature/ai` で開発中。§5 M9） | PASS | —（LEV-227 で完了） |
| 28 | 支払い・アカウント・Vault 外のファイル（Policies） | どれも無い。**M9（有料の AI 機能）を入れる時点でこの行が変わる**（2026-10-01 に保留を解き `feature/ai` で開発する。アカウント・支払い〔Optional payment〕・デバイス ID の送信と、起動した CLI が Vault の外のファイルを読みうることが加わる。main へのマージは最後〔LEV-272〕で、それまで main の配布物は変わらない） | PASS | — |
| 29 | LICENSE と同梱物の表示（Policies） | MIT。同梱の `@lezer/markdown`（MIT）を README（英語）と `README.ja.md` の「License／ライセンス」に表示（LEV-227） | PASS | —（LEV-227 で完了） |

### 1.7 公開の前に済ませたい品質（要件ではない）

| # | 項目 | 現状 | 担当 |
| --- | --- | --- | --- |
| 30 | 宣言した対応環境での実機確認 | macOS の Obsidian 1.14.2 だけ。Windows・Linux・モバイル・1.8.7 は未確認 | LEV-25 |
| 31 | 一覧に載せる画像（README の先頭のスクリーンショットか GIF） | LEV-227 で両方の README の先頭にテスト Vault のマップのスクリーンショット 1 枚（明色、`docs/images/mappy-map.png`）を置いた。一覧（Obsidian のプラグインの画面）が README の相対パスを解決するかは確かめていないので、`main` の raw.githubusercontent.com の絶対 URL で参照する（merge 前のブランチでは表示されない）。一覧での表示は提出準備（LEV-228）で確かめる。2026-08-07 版の Submit your plugin は、一覧のページが README の抜粋を表示し、相対リンクと画像をリポジトリに対して解決し直すと書く（絶対 URL のままでも表示される）。一覧は別に、スクリーンショット（デスクトップ 1200×800 を 5 枚まで、モバイル 900×1600 を 5 枚まで）を Edit listing で受け付ける | LEV-228（本人。提出後の一覧で見る） |
| 32 | ベータ表記と既知の制限 | LEV-227 で英語の「Known limitations」を置き、IME の項目を「日本語以外（中国語・韓国語など）の IME も未確認」まで広げた（日本語版も同じ）。表示言語を「対応環境」に足した | —（LEV-227 で完了） |

### 1.8 Community directory の自動レビュー（LEV-228 で追加）

公式文書の Community directory の FAQ・Manage your plugin or theme・Set up and claim（いずれも 2026-08-07 版）と Release your plugin with GitHub Actions（2026-07-29 版）による。LEV-136 の 4 文書には無かった項目。自動レビューは Manifest・Releases・Source code・Build verification の 4 節で、結果は Error・Warning・Recommendation・Pass。**Error が残る間は Obsidian から導入できない。Warning は提出を止めない。**

| # | 要件（出典） | Mappy の現状 | 結果 | 担当 |
| --- | --- | --- | --- | --- |
| 33 | スキャナーはリポジトリのソースを読み、決まった名前（`tests`・`scripts`・`docs`・`i18n`・`test-vault`・`*.mjs` など）だけを除外する（FAQ） | LEV-228 の時点では、除外されないトップレベルのうち本体でないコードが `harness/`（ブラウザ検証ページと Obsidian API のモック、9 ファイル。公式 lint の `recommended` で error 6・warning 22。`insertAdjacentHTML`、後読み、`navigator.platform` など、モックが本物の振る舞いを写すためのもの）と `vitest.config.ts`（0 件。`.ts` なので `*.mjs` などの除外に当たらない）だった。LEV-243 で前者を `tests/browser-harness/` へ、後者を `vitest.config.mts`（FAQ の一覧は `*.cjs, *.mjs, *.cts, *.mts` を挙げる）へ移した（2026-09-28）。移したあとの木（2026-09-28）で除外されないコードは `src/` と `styles.css` だけで、`src/` に公式 lint の `recommended` だけを当てて error 0・warning 0（移した先は同じ設定で従来どおり error 6・warning 22。`src/` は `npm run lint` でも同じ `recommended` を通っている）。FAQ は下の階層の名前も除外するかを書いていないので、ディレクトリ名はトップレベルにあるときだけ除外と読む（`src/i18n/` も読まれる側に数える）。`tests/tooling/scan-scope.test.mjs` が、作業ツリーのうち git 管理下と未追跡（リポジトリの ignore 以外）のファイルで、除外されないコードが `src/` と `styles.css` だけであることを検査する | PASS（スキャナーが同じ規則を当てるかは非公開。除外の一覧は FAQ の 2026-08-07 版の写しで、FAQ が変われば手で取り直す） | LEV-243 |
| 34 | Build verification: スキャナーは `build`（無ければ `build:plugin`、`compile`）を実行し、ビルドがコミットの内容と一致するかを見る（FAQ・Manage） | `npm run build`（型検査＋esbuild の本番ビルド）が `main.js` をルートに出す。0.4.0 の木で手元（macOS、Node 22.22.3）の `npm run build` の `main.js`・`manifest.json`・`styles.css` は Release 0.4.0 の添付（CI の Ubuntu で作ったもの）と sha256 が 3 つとも一致（§4.2） | PASS（0.4.0 の木で手元で再現）／スキャナーの結果は 0.4.1 で Pass（`main.js` が byte-for-byte で一致。§4.7）。提出する木（0.4.1）での手元の取り直しは記録が無い | LEV-228（本人） |
| 35 | Release の添付物の artifact attestation（`actions/attest`）は提出時に推奨（Release your plugin with GitHub Actions） | 0.4.0 までの `release.yml` は attestation を作らなかった。2026-09-28 の本人決定で LEV-249 が `release` job の後に `attest` job を足した: `id-token: write`・`attestations: write`・`artifact-metadata: write` と `actions/attest`（v4.2.2 を commit の SHA で固定。`subject-path` に添付の 3 ファイル。公式の Release your plugin with GitHub Actions〔2026-07-29 版〕と同じ action。公式の例は Release の前に attest するが、失敗で Release が止まらないように後ろの別 job にした）。形は `tests/tooling/release-workflow.test.mjs` が検査する | 決定済み（入れる。0.4.1 から）／未実施（PR・`workflow_dispatch` の dry-run は `release`・`attest` job を動かさないので、attestation が作られるかは 0.4.1 の tag の run で `gh attestation verify` を当てて初めて分かる。harness.md「リリース手順」4） | LEV-249 |
| 36 | 一覧の掲載情報: アイコン・短い説明と長い説明・カテゴリ・支払いの区分（Free／Optional payment／Paid）・スクリーンショット（Manage） | 提出のあとに Edit listing で本人が入れる。支払いの区分は Free（課金・アカウント・有料サービスなし。#28）。**M9 を main へ入れて出す版では Optional payment に変える**（2026-10-01 の本人決定。product-plan §5 M9）。0.4.1 の提出・掲載のあとに入れたかは記録が無い（2026-09-28、LEV-254） | 未実施（本人。入っていれば確かめて PASS にするだけ） | LEV-228（本人） |
| 37 | リポジトリ: issues が有効、GitHub がライセンスを認識する（FAQ、廃止前の検証 workflow） | `hiroyaiizuka/Mappy` は public、issues 有効、GitHub のライセンス判定は `mit` | PASS | — |
| 38 | 導入の案内（要件ではない） | 0.4.1 までは README の導入が BRAT だけで「It is not in the community plugins directory yet」と書き、LEV-254（0.4.2）は「0.4.1 で一覧にも提出した。下の手順はそれに依らない」に変えただけだった。一覧のミラー `community-plugins.json` に `mappy` が在ることを 2026-09-29 の取得で確かめ（`gh api repos/obsidianmd/obsidian-releases/contents/community-plugins.json`）、本人の決定（同日「コミュニティプラグインができたから README に BRAT のことは書かなくて大丈夫」）で LEV-259 が両方の README の導入をコミュニティプラグインからと手動の 2 つに書き換え、BRAT の記述を外した。BRAT で入れた利用者への移行の案内（同じ `.obsidian/plugins/mappy/` を BRAT と Obsidian の更新の両方が扱う）は書いていない。手順の画面の名前（制限モード・閲覧・インストール・有効化）は本人の Publish の導入のページ（スクリーンショット付き）に合わせたもので、一覧からの導入と更新を専用テスト Vault の実機で確かめた記録は無い | README は済み（LEV-259）。一覧からの導入・更新の実機確認は未実施 | LEV-259 の merge（一覧と GitHub は既定ブランチの README を表示するので、版を待たない） |
| 39 | 自動レビューの CSS lint: `!important` を避け、詳細度か CSS 変数で上書きする（0.4.1 の結果、Warning） | 0.4.1 の `styles.css:17`（`.mappy-view` の `padding: 0 !important`）。LEV-253 で `.workspace-leaf-content .view-content.mappy-view { padding: 0 }`（詳細度 0,3,0。app.css 1.14.2 の `.workspace-leaf-content .view-content`〔0,2,0〕に勝つ。Obsidian 自身の view と同じ打ち消し方）に置き換え、`styles.css` から `!important` を無くした（コメントの中の語も言い換えた）。`tests/tooling/ui-css.test.mjs` が不在と詳細度を検査する。見た目は実機 E70 で確かめる（§4.7） | 対応済み（main）／スキャナーの判定は次の版の Release で見る | LEV-253 |
| 40 | 自動レビューの Behavior: Vault の列挙（`vault.getFiles`・`getMarkdownFiles` など）はすべてのファイルパスを読める（0.4.1 の結果、Recommendation） | 0.4.1 では 3 か所。`src/obsidian/map-files.ts` の作成先フォルダの解決（大文字小文字を無視するための `getAllLoadedFiles().find(...)`）は LEV-253 でルートから各フォルダの `children` をたどる形に変え、列挙をやめた（`metadataCache.getFirstLinkpathDest` はノートをリンクで引くものでフォルダを引けないので使わない）。残る 2 か所は機能が全ファイルを候補にするので残す: `src/ui/link-suggest.ts` の `getFiles`（`[[`／`![[` の候補）と `src/obsidian/map-search.ts` の `getMarkdownFiles`（呼び出すマップの検索）。両方の README の「ネットワーク利用」に、一覧は手元で読むだけで外に送らないと書いた。`tests/tooling/vault-enumeration.test.mjs` が `src/` の列挙の API（Vault の一覧・`recurseChildren`・metadataCache の表・`adapter.list`）の参照をこの 2 か所に固定する（`TFolder.children` を根から手で走査する書き方は見えないのでレビューで見る） | 一部対応（Recommendation は残る見込み。機能上要る） | LEV-253 |

## 2. 英語化の方式

### 2.1 前提（実測、2026-09-27、`0e8c4d1`）

- UI 文言: `src/` の 24 ファイルに日本語の文字列リテラル約 200 個。多いのは `ui/mindmap-view.ts`（54）、`main.ts`（36）、`core/commands.ts`（18）、`obsidian/settings-tab.ts`・`obsidian/excalidraw-bridge.ts`（14 ずつ）。core・export の例外文（約 40）も `Notice` を通って利用者に見える
- **Markdown に書き込まれる既定の文字列**（今の一覧は `docs/architecture.md` §9e）: 新しいノードの `サブトピック`、ルートの直下に足すノードの `メイントピック`（LEV-250）、新しいトピックの `トピック`、新しいマップのルートの見出しの `中心トピック`（LEV-255）の 4 つ。これは UI ではなく本文になる。新規ファイルの `無題のマインドマップ` はファイル名にだけ使う（2026-09-27 の調査時点では、この 3 つ目として本文の見出しにも書いていた）
- 保存値は言語に依存しない: 設定は `follow`・`light`・`dark`、レイアウトは `mindmap` などの id を保存し、日本語はラベルにしか使っていない（`THEME_LABELS`・`LAYOUT_LABELS`。LEV-233・LEV-234 以降は `layoutLabel()`・`themeLabel()`）。言語を切り替えても既存の設定とノートは読める
- バンドル: 本番の `main.js` は 239,762 B。esbuild の既定（`charset: ascii`）で非 ASCII の文字はすべて `\uXXXX`（1 字 6 B）に書かれる。その数は 3,454、うち CJK と仮名（U+3000〜U+9FFF）が 3,430 で約 20.6 KB（バンドルの約 8.6%）。全角の括弧・斜線（U+FF08 など）を足すと 3,444
- Obsidian API 1.8.7（`minAppVersion` と同じ）に `getLanguage()`（アプリの言語の ISO コード、既定 `en`）がある。公式 lint には `prefer-get-language`（`localStorage.getItem('language')` を使わせない）（recommended に入っている）と、英語のロケールファイル（`**/en.ts`・`**/en/*.ts` など）の文字列に sentence case を強いる `ui/sentence-case-locale-module` がある。**後者は `configs.recommendedWithLocalesEn` にだけ入っていて、Mappy の `eslint.config.mjs` が使う `configs.recommended` には入っていない**。(b) で英語の表を検査させるには、設定を `recommendedWithLocalesEn` に切り替えるか、`src/i18n/en.ts` に当たる block を足す（2026-09-27 の時点の記述。LEV-233 で block を足した。§1 の #14）
- テストの結合: `tests/` と `scripts/e2e/` に日本語の文言を照合する箇所が多い（代表的な 5 語だけで 18 ファイル）。e2e はテスト用 Obsidian の画面の文言を読むので、その Obsidian の言語が結果を左右する

### 2.2 比較

| 観点 | (a) 英語に一本化 | (b) 文言テーブル＋ `getLanguage()` で切り替え | (c) 日本語のまま出す |
| --- | --- | --- | --- |
| 本人の日常使用 | 英語になる（毎日の操作が遅くなる、と本人） | 日本語のまま（Obsidian を日本語で使っている限り） | 日本語のまま |
| 公開の読者 | 英語 | 英語（日本語以外の言語はすべて英語に落ちる） | 日本語が読めない読者には使えない |
| 審査 | 要件は無いが、英語の一覧に日本語 UI という指摘を受けにくい | 同左。lint の設定を足せば `sentence-case-locale-module` が英語の表を検査する | 要件違反ではないが、sentence case などの文言規則が事実上検査されない。差し戻し・低評価の恐れ（推測。根拠となる公式の記述は無い） |
| バンドル増分 | 約 −10〜14 KB（日本語 20.6 KB → 英語 約 7〜10 KB の見積もり。英語は 1 字 1 B で、日本語 1 字に英語 2〜3 字） | 約 +15〜22 KB（英語の表 約 7〜10 KB ＋ キー約 200 個 × 平均 15 字前後が `en`・`ja`・呼び出し側の 3 か所に残る分 約 9〜11 KB。esbuild の minify はプロパティ名を縮めない。現在の約 6〜9%） | 0 |
| ランタイム依存 | なし | なし（自前の数十行。i18next などは入れない） | なし |
| 保守 | 文言は 1 か所に 1 つ。追加の手間なし | 文言を足すたびに 2 言語を書く。**キーの欠けは型で止める**（`ja` を `Record<keyof typeof en, string>` の型にする）。訳の質は機械では見ない | なし |
| テスト | 日本語を照合するテスト・e2e を英語に書き換える（大量） | 既存のテストの日本語の期待値はそのまま使える（テスト環境の言語を `ja` にする）が、文言の定数を関数にする分、それを import する 15 ファイルの参照は直す。英語の表・切り替え・キーの一致を足す。e2e は起動する Obsidian の言語を `ja` に固定するか、照合を文言に依らない形（id・属性）へ移す | 変更なし |
| Markdown に書く既定文字列（`サブトピック` など） | 英語になる | UI と同じ言語に従う（日本語の Obsidian では従来どおり） | 日本語のまま |
| 戻しやすさ | 日本語 UI に戻すには (b) と同じ作業が要る | (a) には英語の表だけ残せば済む | — |

### 2.3 推奨: (b)（2026-09-28 に本人が (b) で確定）

(b) を推奨する（オーケストレーターの推奨と同じ）。理由:

1. **本人の日常使用を変えずに公開を英語にできる唯一の案**。(a) は本人の操作を遅くし、(c) は一覧の読者に届かない
2. コストが許容できる: 増分は約 6〜9%（+15〜22 KB の見積もり。キーを短くすれば減る）、ランタイム依存なし、`getLanguage()` は `minAppVersion` 1.8.7 の型にあるので最小版を上げない。公式 lint に英語の表を検査する規則がある（有効にする設定を 1 つ足す。§2.1）
3. 既存のテストの日本語の期待値をそのまま使える（テスト環境を `ja` に置く）。ただし読み込み時の文言の定数を関数にする分、それを import する `tests/`・`scripts/` の 15 ファイルの参照は書き換える（architecture.md §9e）。(a) は言語を切り替えないので参照の書き換えは要らないが、日本語の期待値をすべて英語へ書き換える

実装の形（(b) が確定したときの設計の決まり）は **`docs/architecture.md` §9e** に置いた: `src/i18n/` の置き場と層、`ja` の型、読み込み時に決まる文言の定数を使う時点の参照に変えること（該当する定数の一覧）、`conflictMessage` の文字列比較をやめること、Markdown に書く既定の文字列、lint の設定、テスト。

(b) を選ばない場合: (a) なら同じ子チケットの「表」を `en` だけにし、テストの照合を英語へ直す作業が増える。(c) なら子チケットは README の英語版と提出準備だけになる。

## 3. 子チケット（LEV-136 の子）

方式に依らない形で切り、(b) に依るものはそう明記する。

- **UI 文言の抽出と置き換え**（LEV-226。(b) を前提。**完了**: #118・#120・#121、0.4.0 に入る）: `src/i18n/` の新設、約 200 の文字列の移し替え、`getLanguage()` による選択、読み込み時の定数を使う時点の参照に変えること、`conflictMessage` の文字列比較をやめること、lint の設定（`sentence-case-locale-module`）、テスト（キーの一致・言語の選択・英語の lint）、e2e とブラウザ検証ページ（当時の `harness/browser/`。LEV-243 で `tests/browser-harness/` へ移した）の言語の固定、`src/main.ts` の原文を照合する `tests/tooling/popover-wording.test.mjs` の書き換え。量が多いので、層（core／obsidian／ui）で PR を分けてよい
- **README の英語版**（LEV-227。方式に依らない。**完了**: #122、0.4.0 に入る）: 英語を主にする README と日本語の README の置き方、ネットワーク利用・ライセンス・同梱物の開示、先頭の画像、既知の制限の書き直し。`scripts/validate-release.mjs` は `README.md` の `## 既知の制限` を探して無ければ失敗する（LEV-209）ので、`README.md` を英語にするなら検査も同じ PR で直す。見出しだけでなく項目の型（`versionLimit` は「x.y.z まで」だけを拾う。`scripts/version-bump.mjs` も同じ関数を使う）も英語の書き方に合わせないと、見出しが見つかって項目が 0 件のまま黙って通る。README の歯車の行を照合する `tests/tooling/popover-wording.test.mjs` も直す
- **審査要件のチェックと提出準備**（LEV-228。方式に依らない）: `docs/harness.md`「審査要件のチェック項目」の全項目と本書 §1 の全行を提出直前の木で再確認する。とくに判断の #21（frontmatter の書き方の逸脱の説明）、未実施の #4（提出）、PASS だが提出の直前に確かめ直す #5（id の一意性）、未確認の #3（pre-release のままで一覧が版を拾えるか）、harness.md と食い違う #19（`console.error`）、審査で説明を求められうる #22（prototype の差し替え）。**2026-09-28 の再確認（§4）のあと**: #19 は片付いた（lint で検査）、#33 は LEV-243 が片付けた（`tests/tooling/scan-scope.test.mjs` で検査）、#3 は実測したうえで本人の判断に回した、#21・#22 は英語の説明を用意した、#14 の 27 個は目で確かめた。残るのは本人の判断（#3・#9・#35。2026-09-28 に決まり、LEV-249 が 0.4.1 に入れた）、#16 の実機、#4 の提出、#36 の掲載情報と、提出する木（0.4.1）での #5・#34 の取り直し（**その後**: #4 は 0.4.1 で提出した〔本人の報告〕。#34 はスキャナーの結果が Pass〔§4.7〕。#5・#36 と #34 の手元の取り直しは記録が無い。LEV-254）。LEV-25 の完了を待たずに再確認に着手した（#9 は判断の材料を §4.4 に置いた）。#2 は LEV-227 が片付け、ここでは結果を確かめるだけ。#31 の一覧での画像の表示もここで確かめる。#14 の値を差し込む関数の文言 27 個（lint が読まない）を目で確かめること（2026-09-28 に済んだ）と、#16 の E63 以外の英語の表示（通知の全文・ほかの操作・Windows・Linux・モバイル）の実機確認はここで持つ。community.obsidian.md への提出と自動レビューへの対応も持つ。英語化の 2 本と LEV-25 の後に着手する

## 4. 提出の直前の再確認（LEV-228、2026-09-28）

対象の木は 0.4.0 の tag（`ff49476`、Release 0.4.0 は pre-release、2026-09-28T05:17:06Z 公開）。**この結果は提出する木には引き継げない**: `main` は 0.4.0 のあとも `src/` が変わっており（LEV-237・LEV-239 など）、`manifest.json` は 0.4.0 のまま。スキャナーが HEAD をビルドして Release 0.4.0 の添付と照らせば #34 は一致しない（どの木をビルドするかは公式文書に無い）。提出は、提出する木で新しい版を切った直後（HEAD＝その版の tag）に行い、§4.2 の数値・#34 の sha256・#5 の衝突をその木で取り直す（§4.6 の 2）。証跡は `artifacts/lev-228-submission-prep/`（git 管理外）の `record.md`。

### 4.1 公式文書の版と、LEV-136 から変わった点

- 取得元は公式文書の原文リポジトリ `obsidianmd/obsidian-developer-docs`（`main` の `c56c7e7`、2026-08-10）。Submit your plugin・Submission requirements・Developer policies と Community directory の各文書の最終更新は 2026-08-07（#258 "Community directory update"）、Plugin guidelines は 2025-06-23、Release your plugin with GitHub Actions は 2026-07-29（attestation の手順を追加）。**どれも LEV-136 の取得（2026-09-27）より前で、LEV-136 が照合した 4 文書の要件は変わっていない。** LEV-136 が読んでいなかった Community directory の FAQ・Manage your plugin or theme・Set up and claim と Release の文書から、§1.8 の 6 行を足した
- **obsidian-releases の PR による提出は廃止されている。** 2026-05-15 のコミット `d4f0694`（"remove PR templates & validation actions"）で PR テンプレートと `validate-plugin-entry.yml` などが消え、`community-plugins.json` は `mirror-community-json.yml` が community.obsidian.md の `assets/community-plugins.json` を 1 時間ごとに写すミラーになった。README の "Submit your plugin" も公式文書を指すだけ。**提出は community.obsidian.md のフォームで行い、obsidian-releases に PR は出さない**（出しても一覧には入らない）
- 一覧に載った説明には、ミラーでは ` - This plugin has not been manually reviewed by Obsidian staff.` が後ろに付く例がある（最後尾のエントリなど。人のレビューの前に自動レビューで載ることを示す。付け方の規則は公式文書に無い）
- 提出したあとは、Edit listing（アイコン・説明・カテゴリ・支払いの区分・スクリーンショット）、Review branch（リリース前にブランチ・タグ・コミットを走査）、Request review／Check for new releases（再走査）、Action required notifications（掲載を続けるために要る対応のメール）が使える

### 4.2 harness.md「審査要件のチェック項目」の全項目

| 区分 | 結果（0.4.0 の木） |
| --- | --- |
| manifest | `id` `mappy` は一覧 8,143 件（ミラーの 2026-09-28T03:39Z の時点）と削除済み 175 件のどちらの `id`・`name` とも衝突なし、`obsidian`・`plugin` を含まない。`version` は `manifest.json`・`versions.json`・`package.json`・`package-lock.json` とも `0.4.0`（`npm run validate` 通過）。キーは `id,name,version,minAppVersion,description,author,isDesktopOnly` で、廃止前の検証 workflow の許容（それに `authorUrl`・`fundingUrl`・`helpUrl`）の中。`fundingUrl` なし。`isDesktopOnly` は §4.4 |
| コマンド・UI | 公式 lint の `recommended` が `src/` で 0 件（`npm run lint`）。英語の表の値を差し込む関数 27 個（`src/i18n/en.ts`）を目で確認し、すべて sentence case で、大文字で始まる語は固有名詞（Excalidraw・Obsidian・SVG・Markdown）だけ。サンプルコードの残りなし |
| ログ・互換 | `console.*` は `src/` も `dist/mappy/main.js` も `console.error` の 1 件だけ（ガイドラインどおり。項目の文面を合わせ、lint で検査するようにした）。`node:*`・`electron`・`fs`・`process` なし。バンドルの `require` は `obsidian`（18）・`@lezer/common`・`@lezer/highlight`。後読み 0 件 |
| ネットワーク | README「Network use」と `README.ja.md`「ネットワーク利用」（LEV-227）。変化なし |
| ライフサイクル | テストは `npm test` に含まれる。`detachLeavesOfType` なし。実機の E09・E25・E34 はこのチケットでは回していない（LEV-25） |
| 依存・配布物 | ランタイム依存は `@lezer/markdown` 1.7.2（MIT、README に表示）だけ。`dist/mappy/` は `main.js` 263,409 B・`manifest.json` 221 B・`styles.css` 25,399 B。`main.js`・`dist/`・`build-meta.json` はコミットされていない。Release 0.4.0 の添付 3 つは `npm run build` の出力と sha256 が一致（#34） |
| README・LICENSE | 英語の `README.md` に What it does・Storage format・Installation・Basic usage・Compatibility・Known limitations・Troubleshooting・Network use・License がある。LICENSE は MIT で GitHub が認識する |
| 公開審査の自動レビュー | §1.8（#33 は LEV-243 で PASS、#35 と §4.3 は本人の判断） |

実機（Obsidian）はこの再確認では起動していない。§1 の #16（E63 以外の英語の表示。通知の全文など）は LEV-228 に未実施のまま残り、#30（Windows・Linux・モバイル・1.8.7）は LEV-25 に残る。

### 4.3 pre-release のままで一覧が版を拾えるか（#3）と `release.yml`

**結論: 公式の記述では決まらず、実例は 0 件。提出する版は通常の Release にするのを推奨する。**

- 公式文書: Submit your plugin は「manifest の `version` と同じタグの GitHub Release」とだけ書き、pre-release に触れない。一覧は既定ブランチの HEAD の `manifest.json` を読み、利用者の導入ではそのタグの Release から 3 ファイルを落とす（Submit your plugin、obsidian-releases の README "How community plugins are pulled"）。自動レビューは「定期的に新しい Release を確かめる」とあるが、何を新しい Release と見るか（pre-release を含むか）は書いていない
- 廃止前の検証 workflow（`validate-plugin-entry.yml`、2026-05-15 まで）は `repos.getReleaseByTag(manifest.version)` で引き、pre-release でも通っていた。今の自動レビューはこのスクリプトではなく、実装は非公開
- 実測（2026-09-28、GraphQL で全件）: 一覧の 8,143 件のうち、既定ブランチの `manifest.json` の版のタグが**通常の Release 8,123 件、pre-release 0 件、draft 0 件**（直近 8 件の Release に版のタグが無い 18 件、manifest を読めない 2 件）。pre-release を使っている作者は 333 件、版が 0.x のものは 2,736 件あるのに、掲載中の版が pre-release のものは無い。一方、版のタグが GitHub の「latest」でない通常の Release を指すものは 167 件あり、一覧が「latest release」ではなくタグで版を引いていることとは矛盾しない。0 件は「pre-release だと載らない」とも「慣習（ベータは `manifest-beta.json` や pre-release にして、manifest はふつうの Release を指す）」とも読め、どちらかは区別できない
- 選択肢（本人が決める）:
  - (a) **`release.yml` の `0.*) prerelease="--prerelease"` を外し、0.x も通常の Release にする（推奨）**。変更は 1 か所で、BRAT は通常の Release も拾う。ベータであることは README と版番号（0.x）で示す。提出する版（次の 0.4.x）から効く。既存の Release 0.4.0 の pre-release の印を外すだけで済ませることはしない: `main` は 0.4.0 のあとも `src/` が変わっているので、提出は新しい版を切った直後に行う（§4 の冒頭）
  - (b) 1.0.0 にして出す。`release.yml` はそのままで通常の Release になるが、「0.x はベータ」の区切りを提出の都合で動かすことになる
  - (c) pre-release のまま出し、自動レビューの Releases 節の結果で判断する。Error になれば (a) か (b) で版を上げる（公式の手順どおり、版を上げた Release で応える）。1 往復ぶん遅れうる
- **決定（2026-09-28、本人）: (a)。** LEV-249 が `release.yml` の分岐を外し、#35 の attestation も同じ PR で入れた。0.4.1 から効く。0.4.0 までの Release は pre-release のまま残す
- (a) を選ぶなら、`harness.md`「リリース手順」・`product-plan.md` §5 M5・README の BRAT の説明（「pre-releases included」）の 0.x＝pre-release の記述も同じ PR で直す。#35 の attestation を入れるなら同じ PR で `release.yml` の `release` job に `id-token: write`・`attestations: write` と `actions/attest`（`subject-path` に 3 ファイル）を足す

### 4.4 `isDesktopOnly` とモバイル（#9、LEV-25）

要件は「Node.js・Electron の API を使うなら `true`」だけで、Mappy は使っていない（ESLint で import を禁止、バンドルの `require` は Obsidian が渡すものだけ）。したがって**どちらを選んでも要件は満たす**。決めるのは「モバイルで確かめていないものを一覧からモバイルに配るか」。

| 選択肢 | 利用者への影響 | 手間・戻しやすさ |
| --- | --- | --- |
| (A) `false` のまま（現状） | iOS・Android でも一覧から導入できる。README の Compatibility に「モバイルは未確認」と書いてある。タッチでの操作・IME・書き出しの大きさの上限（Capacitor）などで不具合があれば、モバイルの利用者が最初に踏む | 変更なし。モバイルの不具合報告に応える体制が要る |
| (B) `true` にする | モバイルでは一覧に出ない（導入できない）。デスクトップだけに配る | `manifest.json` を変え、版を上げた Release を出す（一覧は HEAD の manifest、導入は Release の manifest を読むので両方に効かせる）。あとで `false` に戻すのも版を上げるだけ |
| (C) LEV-25 でモバイルを実機で確かめてから `false` で出す | (A) と同じだが、確かめた範囲を README に書ける | 提出が LEV-25 の実機検証の分だけ遅れる |

推奨はしない（本人の判断待ち）。材料: `src/` はモバイルを意識した分岐を持つ（書き出しのキャンバスの上限を `Platform` で切り替える、後読みを使わない）が、実機で確かめた記録は無い。

**決定（2026-09-28、本人）: (B)。** LEV-249 が `manifest.json` の `isDesktopOnly` を `true` にし、両方の README の「対応環境」のモバイルの行を「今は使えない（デスクトップ専用）」に直した。0.4.1 から効く。モバイルは LEV-25 で実機を確かめてから、版を上げて `false` に戻す（そのときは README の行も戻す。`tests/tooling/desktop-only.test.mjs` が片方だけの変更で落ちる）。

### 4.5 審査で問われたときの英語の説明（#21・#22）

**#21 — why `mappy-layout` and `mappy-topics` are written as source-range edits rather than with `processFrontMatter`**

> Mappy uses `FileManager.processFrontMatter` for the explicit conversions: turning a note into a map (setting `mappy`, and `mappy-layout` unless the layout is the default mind map) and back (removing `mappy`, `mappy-layout` and `mappy-topics`). The two keys that change as a side effect of editing the map — `mappy-layout` when a layout button is pressed, and `mappy-topics` (the positions of free topics) when a free topic is moved, added, renamed, detached or deleted — are written through the same queue as the map's own edits to the note body: a minimal source-range edit computed against the latest revision of the file, applied through the `Editor` when the note is open and inside `Vault.process` (with the text checked against what the edit was planned on) when it isn't. `mappy-topics` has been written this way from the start, since its entries change in the same edit as the topics they belong to (so one Undo restores both). `mappy-layout` was first written with `processFrontMatter`. Because that writes outside the queue, an edit to the body that was planned in the ~60 ms before the view re-read the file (for example, the text being typed, saved by the blur of the click on the layout button itself) was refused as a conflicting external change, and nodes whose titles repeat could not keep their identity across the re-read. Writing both kinds of change through one queue keeps them ordered and lets the plugin refuse to overwrite genuine external edits. Only these two keys, which Mappy owns, are touched this way, and the edit covers only their lines: the rest of the frontmatter is not re-serialized.

**#22 — why `WorkspaceLeaf.prototype.setViewState` is wrapped**

> Mappy opens notes marked `mappy: true` in its map view, the same way Excalidraw and Kanban open their own Markdown-based files: it wraps `WorkspaceLeaf.prototype.setViewState` and, when a leaf is asked to show such a note as `markdown`, hands it the map view type instead. The wrapper only ever changes the `type` of the state, between `markdown` and the map view: a map note asked for as `markdown` gets the map view, and a request for the map view on a note that is no longer a map falls back to `markdown`, unless Mappy itself asked for the map view on that leaf (its own "open as map" command). It always calls the original method, keeps a leaf that the user deliberately switched to Markdown on Markdown (including back/forward navigation), and passes every other state through untouched. It is installed once in `onload` and removed on unload through `this.register`. Removing it restores the original method; if another plugin has wrapped the method since, Mappy's wrapper instead becomes a pass-through, so the other plugin's wrapper is not undone (the same semantics as the widely used `monkey-around` helper, without the dependency). This is covered by unit tests.

### 4.6 提出の手順と入力の下書き（本人の操作）

提出は外部への公開なので、ここまでの準備はエージェントが行い、提出は本人（またはその確認のあとのオーケストレーター）が行う。

1. 提出の当日に、`id`・`name` の衝突を一覧（`https://community.obsidian.md/assets/community-plugins.json` か obsidian-releases の `community-plugins.json`）で確かめ直す
2. 提出する版（0.4.1。§4.3 の (a) で通常の Release、§4.4 の (B)、#35 の attestation つき）を切り、その Release を用意する。attestation は Release の後の `attest` job が作るので、`release.yml` の run が `attest` job まで成功したことと、3 ファイルの `gh attestation verify` を確かめてから提出する（失敗していれば `gh run rerun <run-id> --failed`。harness.md「リリース手順」4）。版を切ったら、提出までの間に `main` へ別の変更を入れない（HEAD をその版の tag に揃えておく）。**掲載のあとも同じ問題が続く**: スキャナーは Release のたびと Request review・Check for new releases で走査し、どの木をビルドするか（Release の tag か既定ブランチの HEAD か）は公式文書に無い。HEAD なら、次の Release までに `main` へ入った `src/` の変更で Build verification が合わなくなりうる。提出後の最初の自動レビューで、どの木をビルドしたかを結果から読み取り、HEAD なら「`src/` を変えたら版を切るまで既定ブランチに入れない」か「リリース用のブランチを既定にする」かを決める（本人）。**0.4.1 の自動レビュー（§4.7）では判別できなかった**: 結果が出た時点（LEV-253 の起票 2026-09-28T10:53Z）の `main` の HEAD は 0.4.1 の tag と同じ `e1978e2` で（次の merge の LEV-251 は 10:57Z）、どちらをビルドしても同じ結果になる。**0.4.2 では判別できうる**: HEAD は 0.4.2 の tag（`92c0b68`。commit は 2026-09-28T14:23Z、Release の公開は 14:27Z）と同じまま、2026-09-29T00:58Z に `src/` を変える #140（LEV-255）が入った。0.4.2 の走査がそれより後、0.4.3 の tag より前にコードを取ったなら、Build verification が合わなければ HEAD を、Pass なら tag をビルドしている。結果に出るのは報告の時刻で、コードを取った時刻ではないので、報告が 00:58Z に近い Pass は判別に使わない（合わない結果は、報告の時刻に依らず HEAD をビルドした証拠になる）。00:58Z より前の結果は 0.4.1 と同じく判別できない。0.4.3 の tag（02:24Z）のあとにコードを取った 0.4.2 の走査も、HEAD をビルドしていれば 0.4.3 以降の `main.js` になって合わないので、合わない結果は同じく HEAD の証拠になる。**0.4.3 でも判別できうる**: HEAD は 0.4.3 の tag（`9354556`。commit は 2026-09-29T02:24Z、Release の公開は 02:28Z）と同じまま、08:33Z に `src/` を変える #144（LEV-252）が入った（続けて #145〔LEV-246〕も `src/` を変えた。#146〔LEV-213〕は添付の `styles.css` を変えた。Build verification が `main.js` のほかに `styles.css` も比べるかは記録が無く〔0.4.1 の Pass は `main.js` の一致だけを示す〕、09:16Z より後にコードを取った走査で `styles.css` だけが合わない形もありうる）。0.4.3 の走査が 08:33Z より後、0.4.4 の tag より前にコードを取ったなら、0.4.2 と同じ読み方で判別できる（報告が 08:33Z に近い Pass は使わない）。Release・Request review・Check for new releases のどれで走った走査でも、コードを取ったのが窓の中なら使える（Release のときの走査がいつコードを取ったかは記録が無い）。**0.4.4 でも判別できうる**: HEAD は 0.4.4 の tag（`0514e32`。commit は 2026-09-29T10:03Z、Release の公開は 10:07Z）と同じまま、2026-09-30T02:02Z に `src/` を変える #148（LEV-141）が入った（続けて #151〔LEV-260〕・#150〔LEV-223〕・#149〔LEV-238〕・#153〔LEV-265、2026-10-01T01:49Z〕も `src/` を変えた）。0.4.4 の走査が 02:02Z より後、0.4.5 の tag より前にコードを取ったなら、0.4.2 と同じ読み方で判別できる（報告が 02:02Z に近い Pass は使わない）。0.4.2 と同じく、次の版の tag のあとにコードを取った走査も、HEAD をビルドしていれば新しい `main.js` になって合わないので、合わない結果は HEAD の証拠になる（0.4.3 の走査なら 0.4.4 の tag〔2026-09-29T10:03Z〕のあと、0.4.4 の走査なら 0.4.5 の tag のあと）。LEV-264 の時点で 0.4.2〜0.4.4 とも結果の記録は無い。その木で §4.2 を取り直す: `npm run validate`・`npm run lint`、`npm run build` の 3 ファイルと Release の添付の sha256、`dist/mappy/` のサイズ
3. community.obsidian.md に Obsidian アカウントでサインインし、Profile の GitHub で Connect（`hiroyaiizuka` を連携）。Action required notifications を有効にする
4. Plugins → New plugin: GitHub repository URL `https://github.com/hiroyaiizuka/Mappy`、Owner は本人。Developer policies に同意し、保守を続けること（続けられなければ移譲か削除）を確認して Submit
5. 自動レビューの結果（Manifest・Releases・Source code・Build verification）を記録する。Error は版を上げた Release で応える（Request review で再走査）。Warning は提出を止めないが、直せるものは直す
6. Edit listing: 短い説明（manifest と同じ `View and edit Markdown as linked, illustrated mind maps.`）、長い説明（README の What it does）、カテゴリ、支払いの区分は Free、スクリーンショット（デスクトップ 1200×800。`docs/images/mappy-map.png` を元に作る）

一覧のエントリ（ミラーの `community-plugins.json` に現れる形。manifest から作られる。PR には使わない）:

```json
{
  "id": "mappy",
  "name": "Mappy",
  "author": "Hiroya Iizuka",
  "description": "View and edit Markdown as linked, illustrated mind maps.",
  "repo": "hiroyaiizuka/Mappy"
}
```

### 4.7 自動レビューの結果と対応（0.4.1 は LEV-253、2026-09-28。0.4.2 以降は版の小見出しを足す）

0.4.1（`e1978e2`、通常の Release、2026-09-28T10:00:01Z 公開）を提出したあとの自動レビューの結果（本人が Linear に貼ったもの）。

| 節 | 結果 | 対応 |
| --- | --- | --- |
| Releases・Network requests・Dependencies・Code obfuscation・Build verification（`main.js` が byte-for-byte で一致） | Pass | — |
| CSS lint | Warning: `Avoid !important — override styles by increasing selector specificity or using CSS variables instead.`（`styles.css:17`） | #39。詳細度に置き換えた |
| Behavior | Recommendation: `Vault Enumeration: Enumerates all files in the vault (vault.getFiles, getMarkdownFiles, etc.). Gives the plugin access to every file path in the vault.` | #40。作成先フォルダの解決から列挙を外し、補完と検索の 2 か所は残して README に書いた |

- Build verification の Pass は、スキャナーのビルドが tag の木と一致したことしか言えない（HEAD も同じ木だった。§4.6 の 2）
- 直した結果は、版を上げた Release を出して Request review で再走査するまで一覧の結果に出ない（§4.6 の 5）。LEV-253 は版を切らない。対応は 0.4.2 に入った（LEV-254 の merge のあとに tag を打ち、2026-09-28T14:27:09Z に公開。再走査の結果はこの節に版の小見出しを足して書き、0.4.1 の表は書き換えない。LEV-264 の時点で 0.4.2〜0.4.4 とも記録は無い）。merge すると `main` の HEAD が 0.4.1 の tag から離れるので、スキャナーが HEAD をビルドする場合は次の Release まで Build verification が合わなくなりうる（§4.6 の 2 の論点がそのまま効く）。

## 5. M9（AI 機能）を入れる版の開示（LEV-267、2026-10-01）

M9（`product-plan.md` §5 M9）を main へ入れて出す版で、README（英語）と `README.ja.md` に書く項目。規約の結論（白・グレー・黒）は `product-plan.md` §5 M9「規約の確認の結論」が正本で、本節は実装のときに使う一覧を持つ。M9 が main へ入るとき、§1.6 の #26（client-side telemetry・自己更新が無いこと。デバイス ID の送信と CLI を入れないことを足す）・#27・#28、§1.8 の #36、harness.md「審査要件のチェック項目」の「ネットワーク」の行（今は「自前のサーバー・テレメトリ・送信・アカウント・課金・広告なし」）を直す。それまでは変えない。

- 参照した一次資料（2026-10-01 に取得）: `obsidianmd/obsidian-developer-docs` の commit `c56c7e77`（2026-08-10）の `en/Community directory/` 配下の Developer policies・Submission requirements for plugins・Frequently asked questions（公開ページは [Developer policies](https://docs.obsidian.md/community-directory/developer-policies) など。2026-09-27 の §1 と同じ文書で、置き場所が `en/Community directory/` に移っている）、`obsidianmd/eslint-plugin` の commit `d7e22396` と手元の `eslint-plugin-obsidianmd` 0.4.2（`node_modules`）。
- Developer policies の README 開示（原文 "The following are only allowed if clearly indicated in your README"）のうち M9 で該当するのは、Payment is required for full access・An account is required for full access・Network use（"Clearly explain which remote services are used and why they're needed"）・Accessing files outside of Obsidian vaults（"Clearly explain why this is needed"）の 4 つ。Server-side telemetry（"Link to a privacy policy..."）は、デバイス ID をサーバーに残す点が近いので、該当しない前提でもプライバシーポリシーを置く（下の #45）。

| # | 項目（根拠） | 書くこと | 実装で守ること |
| --- | --- | --- | --- |
| 41 | 支払い（Payment is required for full access。一覧の区分は FAQ の "Optional payment: ... if you lock certain features behind payment"） | 有料なのは AI 機能だけで、マップの表示・編集・書き出しなど他の機能は無料のまま使えること。購入先（UTAGE のページ）と価格の案内先。返金の扱い（決めたら） | 一覧の支払いの区分を Optional payment に変える（#36）。購入先は `fundingUrl` に入れない（Submission requirements "Only use `fundingUrl` to link to services for financial support"） |
| 42 | アカウント（An account is required for full access） | AI 機能は、本人が自分で入れて認証した Claude Code CLI または Codex CLI を使い（API キーでの認証を先に案内し、サブスクのログインは「本人の CLI のログインのまま」と書く。product-plan §5 M9「規約の確認の結論」。API キーでも動くようにしておく）、その利用は本人の Anthropic・OpenAI のアカウントと規約・プランの上限に従うこと。Mappy はログインも API キーも扱わないこと。ライセンスの購入に UTAGE での登録（メールアドレス）が要ること | Mappy は CLI の認証情報（`~/.claude`・キーチェーン・`~/.codex/auth.json`）を読まない |
| 43 | ネットワーク（Network use） | M9 で増える Mappy 自身の通信先はライセンスサーバー（Cloudflare Workers のドメインを書く。2026-10-01 時点の案。入口〔URL・PDF の要約など〕で Mappy 自身が取得するものが出るかは段階 0 LEV-268 と設計 LEV-269 で決まるので、決まったら足す）で、通信するのはライセンスコードの登録とトークンのリフレッシュのときだけ。送るのはライセンスコード・デバイス ID（ランダムな ID）・リフレッシュシークレット、受け取るのは署名付きのトークン。無料状態では AI 機能がライセンスサーバーにも CLI にも触れないこと。例外は本人がライセンスコードを入れて登録する操作で、そのときコードとデバイス ID を送ること（product-plan §5 M9 の例外と同じ。既存の外部画像の取得〔表示と SVG／PNG 書き出し。#27〕は無料状態でも従来どおり行うので、「どこにも通信しない」とは書かない）。AI 機能の実行中は、起動した CLI がプロンプトとノートの内容を Anthropic・OpenAI へ送ること（Mappy 自身は送らない）。既存の「Network use」（#27）に足す | 通信は `requestUrl` で行う（公式 lint の `no-restricted-globals` が `fetch` を warn にする）。利用状況・起動回数・バージョンなどを送らない（client-side telemetry の禁止） |
| 44 | Vault の外のファイル（Accessing files outside of Obsidian vaults） | Mappy が外部プログラム（CLI）を子プロセスで起動すること、CLI の場所を探すこと、起動した CLI は端末で使うときと同じ権限で動き Vault の外のファイルを読みうること。Mappy が渡す作業ディレクトリと、CLI に与える権限（読み取り専用にするなら、その方法）。設計 LEV-269 で決めた内容を書く | CLI を自動でインストール・更新しない（Developer policies "Install or update themselves or their dependencies" の禁止。Copilot は Codex のアダプタを本人の操作で入れる形を取っているが、Mappy は入れない） |
| 45 | デバイス ID とプライバシーポリシー（client-side telemetry の禁止と Server-side telemetry の開示。telemetry の定義は公式文書に無い） | デバイス ID はランダムに作った ID で、ライセンスの台数管理と不正利用の防止だけに使い、追跡・分析に使わないこと。サーバーに残るもの（ライセンスコード・デバイス ID・リフレッシュシークレット、購入時に UTAGE が持つメールアドレスなどの読者情報）と保持期間。中身は鍵の仕組みを作るエンジニアの D1 と UTAGE の項目に合わせて書く。プライバシーポリシーへのリンク | デバイス ID はハードウェア由来の値にしない。前例: Copilot の README "Hosted feature requests include a randomly generated UUID for service delivery, license abuse prevention, and rate limiting. It is not used for tracking, profiling, or analytics." |
| 46 | デスクトップ専用 | AI 機能は CLI を子プロセスとして起動する（Node の API が要る。どの API をどこまで使うかは設計 LEV-269 で決める）ので、デスクトップでしか動かないこと（manifest は既に `isDesktopOnly: true`。#9・§4.4） | Submission requirements "If your plugin uses any of these APIs, you **must** set `isDesktopOnly` to `true`"。`isDesktopOnly` を外す判断をするときは AI 機能をモバイルで無効にする |
| 47 | ソースの公開と鍵の確認 | プラグインのコードは鍵の確認を含めてすべて公開（MIT）で、ライセンスサーバーのコードは非公開であること（Close sourced code の開示は "case by case"。前例: Copilot の README "The Copilot plugin frontend is fully open source. The backend services that support hosted features are closed source and proprietary."） | 鍵の確認を難読化しない（Developer policies "Obfuscate code to hide its purpose" の禁止） |
| 48 | 名称（Anthropic の Claude Code 法務文書） | "runs Claude Code" のように平文で説明するのはよいが、機能名・ロゴに「Claude Code」を使わず、Anthropic・OpenAI の提携や推奨を示唆しない | 機能名は Mappy 側の名前にする |

審査 bot（公式 lint の `recommended`）で M9 に関係するもの（`eslint-plugin-obsidianmd` 0.4.2 の `dist/lib/index.js` と、上流 `d7e22396` の `lib/index.ts` で確かめた）:

- 審査 bot の `recommended` では、`obsidianmd/no-nodejs-modules` は `manifest && manifest.isDesktopOnly ? "off" : "warn"` で、`isDesktopOnly: true` なら無効。`child_process` を名指しする規則は無い。**ただし Mappy 自身の `eslint.config.mjs` は `src/**/*.ts` でこの規則を manifest によらず `error` に戻し、`node:*`・`electron` の import も禁じている**（LEV-249。`tests/tooling/mobile-lint.test.mjs` が固定）。審査 bot が通しても、今の `src/` に `child_process` を入れると `npm run check` が落ちる。どこまで解禁するか（AGENTS.md「runtime はブラウザ互換」の例外と、この lint 設定・テストの直し方）は設計 LEV-269 で決める。
- `no-restricted-globals` は `fetch`（`requestUrl` を使え）と `localStorage`（"Prefer `App#saveLocalStorage` / `App#loadLocalStorage`"）を warn にし、`eslint-comments/no-restricted-disable` がこれらの規則のコメントでの無効化を error にする。保存先の選択肢は product-plan §5 M9 のとおり `app.saveLocalStorage`（Vault ごと）か `window.localStorage` で（本人決定は Local Storage）、`no-restricted-globals` が捕まえるのは素の `localStorage` だけで、`window.localStorage` は lint を通る（2026-10-01、同じ規則を ESLint に当てて確かめた）。通っても公式の推奨（"Prefer `App#saveLocalStorage` / `App#loadLocalStorage`"）からは外れるので、審査で問われうる。素の `localStorage` は Warning になり、コメントでの無効化は error。選ぶのは設計 LEV-269。参考: 公式 API には `app.secretStorage`（`SecretStorage`）もあるが 1.11.4 からで、Mappy の `minAppVersion`（1.8.7）のままでは 1.8.7〜1.11.3 で未定義になる。使うなら `minAppVersion` を上げる（Submission requirements の #8）か、無いときの扱いを決める必要があり、本人決定（Local Storage）からも外れるので本人の判断が要る。
- 規則で検出されないもの（ネットワークの先・テレメトリ・外部プログラムの実行）は README の開示と人のレビューで見られる。
