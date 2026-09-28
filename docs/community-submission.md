# コミュニティ公開審査の要件と英語化の方式

LEV-136（2026-09-27）。本人の決定: **コミュニティプラグインの公開審査に出す方向で進め、英語化を次の大きな柱にする。AI 機能（M9、LEV-28）は当面保留。** 本書はその前提で、審査要件と Mappy の現状の対応表（§1）と、英語化の方式の比較と推奨（§2）を記す。決定そのものは `product-plan.md` §5 M5 と §7 が正本で、本書は根拠と作業の分け方を持つ。

- 参照した公式文書（2026-09-27 に取得）: [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)、[Submission requirements for plugins](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)、[Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)、[Developer policies](https://docs.obsidian.md/community-directory/developer-policies)。公式 ESLint プラグイン `eslint-plugin-obsidianmd` 0.4.2 の規則（`node_modules` で確認）
- 前回の照合は LEV-24（2026-09-19、47 項目。`artifacts/lev-24-readme/record.md`、git 管理外）。項目の分け方の正本は `docs/harness.md`「審査要件のチェック項目」で、本書の表はそれを 0.3.8 の木（`main` の `0e8c4d1`）で照合し直し、2026-09-27 の公式文書で変わった点（提出の手順など）を足した**この時点の結果**である（例外: #2・#27・#29・#31・#32 は README の英語版〔LEV-227、#122〕が、#12・#14・#16 は LEV-241 が英語化〔LEV-226〕のあとの木〔2026-09-28、`16d8384`〕で書き直した。ほかの行は 0.3.8 の木のまま照合し直していない）。番号は本書の中だけのもの。**本書の 32 行は harness.md の項目をすべては写していない**（`version` の 4 ファイル一致、manifest の不明なキー、サンプルコードの残り、`fs`／`process` の不使用、`dist/mappy/` の 3 ファイルとサイズ、`main.js` をコミットしないこと、README の保存形式・導入・復旧・対応環境の節などは、LEV-24 から変わりうる点が無いと見て省いた）。提出の直前の再確認（LEV-228）は harness.md の全項目で行い、本書との食い違いはそこで片付ける。**表の PASS も公式 lint の通過も、審査の通過を保証しない**（審査は提出時点の公式文書と人のレビューで決まる）
- **提出の直前の再確認（LEV-228、2026-09-28、0.4.0 の木 `ff49476`）は §4。** §1 の行は §4 の結果で「結果」と「担当」を書き換え、公式文書の Community directory の 5 文書・Release の文書から増えた項目を §1.8 に足した
- 公式文書の**どれにも UI・README の言語の要件は無い**（4 文書とも、言語・英語・ローカライズへの言及なし）。英語化は審査の必須条件ではなく、一覧の読者（英語）に届けるための判断である

## 1. 審査要件と現状

結果の凡例: PASS（根拠つきで満たす）／要対応（提出前に直す）／未実施（実機や本人の確認が要る）／判断（本人が決める）。「担当」は残る作業を持つチケット。LEV-226〜228 は本書 §3 で切った LEV-136 の子、LEV-25 は既存の別チケット（対応環境の宣言と実機検証）で LEV-136 の子ではない。

### 1.1 提出の手順と必須ファイル

| # | 要件（出典） | Mappy の現状 | 結果 | 担当 |
| --- | --- | --- | --- | --- |
| 1 | リポジトリのルートに `README.md`・`LICENSE`・`manifest.json`（Submit） | 3 つとも在る。LICENSE は MIT | PASS | — |
| 2 | README は目的と使い方を説明する（Submit） | `README.md` は英語で、目的・保存形式・導入・操作・対応環境・制限・復旧・ネットワーク・ライセンスを持つ。日本語版は同じ節で `README.ja.md`（先頭で互いにリンク。LEV-227。それまでは日本語の `README.md` だけだった） | PASS（要件は言語を問わない） | LEV-227 |
| 3 | `manifest.version` と同じ `x.y.z` タグの GitHub Release に `main.js`・`manifest.json`・`styles.css` を添付（Submit） | `release.yml` が検査して添付（LEV-68）。ただし **0.x のタグは必ず pre-release になる**（`release.yml` の `0.*) prerelease="--prerelease"`） | PASS（Submit の文面は満たす）／**判断**: 公式文書は今も pre-release の可否に触れていない。一覧に載る 8,143 件で manifest の版が pre-release の Release を指すものは 0 件（§4.3）。提出する版を通常の Release にするかを本人が決める | LEV-228（本人） |
| 4 | 提出は community.obsidian.md で Obsidian アカウントに GitHub を連携して行い、自動レビューの指摘には版を上げた Release で応える（Submit） | 未提出。obsidian-releases の PR による提出（`community-plugins.json` にエントリを足す PR）は 2026-05-15 に廃止され（PR テンプレートと検証の workflow を削除）、同リポジトリの `community-plugins.json` は community.obsidian.md の一覧の 1 時間ごとのミラーになった（§4.1） | 未実施（本人の操作。手順と入力の下書きは §4.6） | LEV-228（本人） |
| 5 | `id` は公開済みの全プラグインで一意、`obsidian` を含まない（Submit・Requirements） | `mappy`。`scripts/validate-release.mjs` が形を検査。一覧との衝突は本人が 2026-09-19 に確認し、2026-09-28 に一覧（8,143 件）と削除済みの一覧（175 件）の `id`・`name` で衝突 0 を確かめた（§4.2） | PASS（提出の当日にもう一度確かめる） | LEV-228（本人） |

### 1.2 manifest

| # | 要件（出典） | Mappy の現状 | 結果 | 担当 |
| --- | --- | --- | --- | --- |
| 6 | `description`: 動詞で始める、`This is a plugin` で始めない、250 字以内、ピリオドで終わる、絵文字・特殊文字なし、固有名詞と頭字語の大文字（Requirements） | `View and edit Markdown as linked, illustrated mind maps.`（56 字、英語） | PASS | — |
| 7 | `fundingUrl` は寄付を受けるときだけ置く（Requirements） | 無し | PASS | — |
| 8 | `minAppVersion` は必要な最小版（Requirements） | `1.8.7`。型 1.8.7 で型検査が通る。1.8.7 の実機は未確認 | PASS（型）／未実施（実機） | LEV-25 |
| 9 | Node／Electron API を使うなら `isDesktopOnly: true`（Requirements） | `false`。`src/` に Node／Electron の import 0 件（ESLint で禁止）。バンドルの `require` は `obsidian`（17）・`@lezer/common`・`@lezer/highlight` だけ | PASS（コード）／未実施（モバイル実機）／判断: `false` のまま出すか `true` にするか（§4.4） | LEV-25（本人） |
| 10 | `name` に `Obsidian`・`Plugin` を含めない、`author` を置く（上の 4 文書には無い。`scripts/validate-release.mjs` の検査と LEV-24 の記録による） | `Mappy`、`Hiroya Iizuka` | PASS | — |

### 1.3 コマンド・UI 文言

| # | 要件（出典） | Mappy の現状 | 結果 | 担当 |
| --- | --- | --- | --- | --- |
| 11 | コマンド ID にプラグイン ID を前置しない（Requirements） | 10 コマンド（`create-mindmap` … `call-map`、`convert-to-list`）。前置なし | PASS | — |
| 12 | コマンド名にプラグイン名を入れない、既定ホットキーを置かない（Guidelines） | 名前は `src/i18n` の表から引き、英語（`Create new mind map` など）・日本語のどちらも `Mappy` を含まない（2026-09-28、LEV-226 のあとの木で確認）。`hotkeys` の指定 0 件 | PASS | — |
| 13 | 条件付きは `checkCallback`、無条件は `callback`（Guidelines） | LEV-24 から形は同じ | PASS | — |
| 14 | UI 文言は sentence case（Guidelines） | 0.3.8 の時点では日本語なので実質何も検査していなかった。LEV-233 で `eslint.config.mjs` に `src/i18n/en.ts` を対象とする `ui/sentence-case-locale-module` の block を足し、`npm run lint` が英語の表を検査する（`tests/tooling/i18n-lint.test.mjs`）。値を差し込む関数（27 個。通知の `exitDraftNotSaved` など）の中の文字列は規則が読まない | PASS（文字列の値は lint、関数の文言 27 個は 2026-09-28 に目で確認。§4.2） | — |
| 15 | 設定の見出しは区画が複数のときだけ、見出しに「settings」を入れない、`setHeading()` を使う（Guidelines） | 見出しなしの 4 項目（テーマ・既定レイアウト・作成先フォルダ・左下のレイアウト） | PASS | — |
| 16 | UI の言語（要件なし） | 0.3.8 の時点では UI 文言が 24 ファイルに約 200 個、すべて日本語だった。§2 の (b) を 2026-09-28 に本人が確定し、LEV-226（LEV-233・LEV-234・LEV-235、#118・#120・#121）で `src/i18n` の表へ移した: Obsidian の言語が `ja` なら日本語、それ以外は英語。`src/` の日本語の文字列は `src/i18n/ja.ts` だけ。英語の Obsidian での実機確認は E63（macOS、Obsidian 1.14.2）の面だけ（コマンド名・ボタン・ポップオーバー・右クリックメニュー・タブの題名・設定タブと、仮の名前 `Subtopic`・core の拒否の文）。通知の全文、E63 以外の操作、Windows・Linux・モバイルは未実施。0.4.0 で初めて出る | PASS（(b) で実装）／未実施（E63 以外の面の実機。LEV-228 は実機を回していない。§4.2） | LEV-25 |

### 1.4 セキュリティ・リソース・ワークスペース・Vault

| # | 要件（出典） | Mappy の現状 | 結果 | 担当 |
| --- | --- | --- | --- | --- |
| 17 | `innerHTML`／`outerHTML`／`insertAdjacentHTML` を使わない（Guidelines） | 0 件 | PASS | — |
| 18 | グローバル `app`・`workspace.activeLeaf` を使わない（Guidelines） | `activeLeaf` 0 件。`app` は引数と `this.app` だけ | PASS | — |
| 19 | ログは既定でエラーだけ（Guidelines） | `console.*` は `document-store.ts` の `console.error`（書き込みの購読者が投げた例外）1 件だけ | PASS。harness.md の項目をガイドラインに合わせて「`console.error` 以外がない」にし、`eslint.config.mjs` の `no-console`（`allow: ["error"]`）で `src/` を検査する（公式 lint の `recommended` は `warn`・`debug` も通す。`tests/tooling/console-lint.test.mjs`。LEV-228） | — |
| 20 | unload で登録を解除し、`onunload` で leaf を閉じない（Guidelines） | `register*` と `this.register` で解除。`detachLeavesOfType` なし。テストあり（LEV-24 の #31〜35） | PASS（テスト）／未実施（実機の無効化・再有効化・ペインの閉開） | LEV-25 |
| 21 | 開いたノートは Editor、背景の変更は `Vault.process`、frontmatter は `processFrontMatter`（Guidelines） | 開いた文書は Editor、閉じた文書は `Vault.process` 内で原文を照合（AGENTS.md の規約）。明示の変換・解除（`mappy`・`mappy-layout` の書き込みと削除）は `processFrontMatter`（`obsidian/frontmatter.ts`）。マップの編集に伴う `mappy-layout`・`mappy-topics` の更新は、マップ自身の編集と同じ書き込みの列に載せるため**原文範囲の差分**で書く（LEV-196。列の外で書くと、その間に計画した編集が他者の変更として拒否された） | 判断（後者はガイドラインからの意図的な逸脱）。問われたときの英語の説明は §4.5 | — |
| 22 | `WorkspaceLeaf.prototype.setViewState` の差し替え（ガイドラインに記述なし） | Excalidraw・Kanban と同じ方式。解除で元に戻り、後から包まれていても素通し（テストあり） | PASS（テスト）／審査で説明を求められうる。英語の説明は §4.5 | — |
| 23 | 正規表現の後読みを使わない（モバイル。Guidelines） | 0 件 | PASS | — |

### 1.5 スタイル

| # | 要件（出典） | Mappy の現状 | 結果 | 担当 |
| --- | --- | --- | --- | --- |
| 24 | 静的な見た目をインラインスタイルで書かない。CSS 変数を使う（Guidelines） | インラインは位置・寸法（レイアウトの結果）だけ。lint の `no-static-styles-assignment` が通る | PASS | — |
| 25 | CSS を自分の要素に限定する（Guidelines の意図） | `.mappy-*` と `.internal-embed.mappy-embed-host`（埋め込みの置き場）。`!important` は `.mappy-view { padding: 0 }` の 1 件 | PASS | — |

### 1.6 開発者ポリシー

| # | 要件（出典） | Mappy の現状 | 結果 | 担当 |
| --- | --- | --- | --- | --- |
| 26 | 難読化・動的広告・クライアント側テレメトリ・自己更新をしない（Policies） | どれも無い。本番は esbuild の標準 minify（難読化ではない） | PASS | — |
| 27 | ネットワーク利用は使う先と理由を明示する（Policies） | 自前の通信は SVG／PNG 書き出しでノートが参照する外部画像を `requestUrl` で取る 1 経路だけ（`image-export.ts`）。表示はノートの外部画像を Obsidian と同じく読む。README「Network use」（英語）と `README.ja.md`「ネットワーク利用」に同じ内容で開示（LEV-227） | PASS | —（LEV-227 で完了） |
| 28 | 支払い・アカウント・Vault 外のファイル（Policies） | どれも無い。**M9（有料の AI 機能）を入れる時点でこの行が変わる**（保留中） | PASS | — |
| 29 | LICENSE と同梱物の表示（Policies） | MIT。同梱の `@lezer/markdown`（MIT）を README（英語）と `README.ja.md` の「License／ライセンス」に表示（LEV-227） | PASS | —（LEV-227 で完了） |

### 1.7 公開の前に済ませたい品質（要件ではない）

| # | 項目 | 現状 | 担当 |
| --- | --- | --- | --- |
| 30 | 宣言した対応環境での実機確認 | macOS の Obsidian 1.14.2 だけ。Windows・Linux・モバイル・1.8.7 は未確認 | LEV-25 |
| 31 | 一覧に載せる画像（README の先頭のスクリーンショットか GIF） | LEV-227 で両方の README の先頭にテスト Vault のマップのスクリーンショット 1 枚（明色、`docs/images/mappy-map.png`）を置いた。一覧（Obsidian のプラグインの画面）が README の相対パスを解決するかは確かめていないので、`main` の raw.githubusercontent.com の絶対 URL で参照する（merge 前のブランチでは表示されない）。一覧での表示は提出準備（LEV-228）で確かめる。2026-08-07 版の Submit your plugin は、一覧のページが README の抜粋を表示し、相対リンクと画像をリポジトリに対して解決し直すと書く（絶対 URL のままでも表示される）。一覧は別に、スクリーンショット（デスクトップ 1200×800 を 5 枚まで、モバイル 900×1600 を 5 枚まで）を Edit listing で受け付ける | LEV-228（本人。提出後の一覧で見る） |
| 32 | ベータ表記と既知の制限 | LEV-227 で英語の「Known limitations」を置き、IME の項目を「日本語以外（中国語・韓国語など）の IME も未確認」まで広げた（日本語版も同じ）。表示言語を「対応環境」に足した | —（LEV-227 で完了） |

### 1.8 Community directory の自動レビュー（LEV-228 で追加）

2026-08-07 版の公式文書（Community directory の FAQ・Manage your plugin or theme・Set up and claim、Release your plugin with GitHub Actions）による。LEV-136 の 4 文書には無かった項目。自動レビューは Manifest・Releases・Source code・Build verification の 4 節で、結果は Error・Warning・Recommendation・Pass。**Error が残る間は Obsidian から導入できない。Warning は提出を止めない。**

| # | 要件（出典） | Mappy の現状 | 結果 | 担当 |
| --- | --- | --- | --- | --- |
| 33 | スキャナーはリポジトリのソースを読み、決まった名前（`tests`・`scripts`・`docs`・`i18n`・`test-vault`・`*.mjs` など）だけを除外する（FAQ） | 除外されないトップレベルのうち本体でないのは `harness/`（ブラウザ検証ページと Obsidian API のモック、9 ファイル）。公式 lint の `recommended` を当てると `src/` は 0 件、`harness/` は error 6・warning 22（`insertAdjacentHTML`、後読み、`navigator.platform` など。モックが本物の振る舞いを写すためのもの） | 要対応（スキャナーが同じ規則を当てるかは非公開。除外される置き場へ移す） | LEV-243 |
| 34 | Build verification: スキャナーは `build`（無ければ `build:plugin`、`compile`）を実行し、ビルドがコミットの内容と一致するかを見る（FAQ・Manage） | `npm run build`（型検査＋esbuild の本番ビルド）が `main.js` をルートに出す。0.4.0 の木で手元（macOS、Node 22.22.3）の `npm run build` の `main.js`・`manifest.json`・`styles.css` は Release 0.4.0 の添付（CI の Ubuntu で作ったもの）と sha256 が 3 つとも一致（§4.2） | PASS（手元で再現。スキャナーの環境での一致は提出後の結果で見る） | — |
| 35 | Release の添付物の artifact attestation（`actions/attest`）は提出時に推奨（Release your plugin with GitHub Actions） | `release.yml` は attestation を作らない | 判断（推奨であって要件ではない。入れるなら `release.yml` に `id-token: write`・`attestations: write` と `actions/attest` の手順を足す。§4.3） | LEV-228（本人） |
| 36 | 一覧の掲載情報: アイコン・短い説明と長い説明・カテゴリ・支払いの区分（Free／Optional payment／Paid）・スクリーンショット（Manage） | 未入力（提出のあとに Edit listing で本人が入れる）。支払いの区分は Free（課金・アカウント・有料サービスなし。#28） | 未実施（本人） | LEV-228（本人） |
| 37 | リポジトリ: issues が有効、GitHub がライセンスを認識する（FAQ、廃止前の検証 workflow） | `hiroyaiizuka/Mappy` は public、issues 有効、GitHub のライセンス判定は `mit` | PASS | — |
| 38 | 導入の案内（要件ではない） | README の導入は BRAT だけ（「It is not in the community plugins directory yet」）。一覧に載ったら「Community plugins から導入」を主にし、BRAT をベータの経路に回す | 一覧に載ったあとで直す | 載ったあとの版 |

## 2. 英語化の方式

### 2.1 前提（実測、2026-09-27、`0e8c4d1`）

- UI 文言: `src/` の 24 ファイルに日本語の文字列リテラル約 200 個。多いのは `ui/mindmap-view.ts`（54）、`main.ts`（36）、`core/commands.ts`（18）、`obsidian/settings-tab.ts`・`obsidian/excalidraw-bridge.ts`（14 ずつ）。core・export の例外文（約 40）も `Notice` を通って利用者に見える
- **Markdown に書き込まれる既定の文字列**が 3 つある: 新しいノードの `サブトピック`、新しいトピックの `トピック`、新規ファイルの `無題のマインドマップ`。これは UI ではなく本文になる
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

- **UI 文言の抽出と置き換え**（LEV-226。(b) を前提。**完了**: #118・#120・#121、0.4.0 に入る）: `src/i18n/` の新設、約 200 の文字列の移し替え、`getLanguage()` による選択、読み込み時の定数を使う時点の参照に変えること、`conflictMessage` の文字列比較をやめること、lint の設定（`sentence-case-locale-module`）、テスト（キーの一致・言語の選択・英語の lint）、e2e とブラウザ検証ページ（`harness/browser/`）の言語の固定、`src/main.ts` の原文を照合する `tests/tooling/popover-wording.test.mjs` の書き換え。量が多いので、層（core／obsidian／ui）で PR を分けてよい
- **README の英語版**（LEV-227。方式に依らない。**完了**: #122、0.4.0 に入る）: 英語を主にする README と日本語の README の置き方、ネットワーク利用・ライセンス・同梱物の開示、先頭の画像、既知の制限の書き直し。`scripts/validate-release.mjs` は `README.md` の `## 既知の制限` を探して無ければ失敗する（LEV-209）ので、`README.md` を英語にするなら検査も同じ PR で直す。見出しだけでなく項目の型（`versionLimit` は「x.y.z まで」だけを拾う。`scripts/version-bump.mjs` も同じ関数を使う）も英語の書き方に合わせないと、見出しが見つかって項目が 0 件のまま黙って通る。README の歯車の行を照合する `tests/tooling/popover-wording.test.mjs` も直す
- **審査要件のチェックと提出準備**（LEV-228。方式に依らない）: `docs/harness.md`「審査要件のチェック項目」の全項目と本書 §1 の全行を提出直前の木で再確認する。とくに判断の #21（frontmatter の書き方の逸脱の説明）、未実施の #4（提出）、PASS だが提出の直前に確かめ直す #5（id の一意性）、未確認の #3（pre-release のままで一覧が版を拾えるか）、harness.md と食い違う #19（`console.error`）、審査で説明を求められうる #22（prototype の差し替え）。#2 は LEV-227 が片付け、ここでは結果を確かめるだけ。#31 の一覧での画像の表示もここで確かめる。#14 の値を差し込む関数の文言 27 個（lint が読まない）を目で確かめることと、#16 の E63 以外の英語の表示（通知の全文・ほかの操作・Windows・Linux・モバイル）の実機確認はここで持つ。community.obsidian.md への提出と自動レビューへの対応も持つ。英語化の 2 本と LEV-25 の後に着手する

## 4. 提出の直前の再確認（LEV-228、2026-09-28）

対象の木は 0.4.0（`main` の `ff49476`、Release 0.4.0 は pre-release、2026-09-28T05:17:06Z 公開）。証跡は `artifacts/lev-228-submission-prep/`（git 管理外）の `record.md`。

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
| 公開審査の自動レビュー | §1.8（#33 は LEV-243、#35 と §4.3 は本人の判断） |

実機（Obsidian）はこのチケットでは起動していない。§1 の #16（E63 以外の英語の表示）と #30（Windows・Linux・モバイル・1.8.7）は未実施のまま LEV-25 に残る。

### 4.3 pre-release のままで一覧が版を拾えるか（#3）と `release.yml`

**結論: 公式の記述では決まらず、実例は 0 件。提出する版は通常の Release にするのを推奨する。**

- 公式文書: Submit your plugin は「manifest の `version` と同じタグの GitHub Release」とだけ書き、pre-release に触れない。一覧は既定ブランチの HEAD の `manifest.json` を読み、利用者の導入ではそのタグの Release から 3 ファイルを落とす（Submit your plugin、obsidian-releases の README "How community plugins are pulled"）。自動レビューは「定期的に新しい Release を確かめる」とあるが、何を新しい Release と見るか（pre-release を含むか）は書いていない
- 廃止前の検証 workflow（`validate-plugin-entry.yml`、2026-05-15 まで）は `repos.getReleaseByTag(manifest.version)` で引き、pre-release でも通っていた。今の自動レビューはこのスクリプトではなく、実装は非公開
- 実測（2026-09-28、GraphQL で全件）: 一覧の 8,143 件のうち、既定ブランチの `manifest.json` の版のタグが**通常の Release 8,123 件、pre-release 0 件、draft 0 件**（直近 8 件の Release に版のタグが無い 18 件、manifest を読めない 2 件）。pre-release を使っている作者は 333 件、版が 0.x のものは 2,736 件あるのに、掲載中の版が pre-release のものは無い。一方、版のタグが GitHub の「latest」でない通常の Release を指すものは 167 件あり、一覧が「latest release」ではなくタグで版を引いていることとは矛盾しない。0 件は「pre-release だと載らない」とも「慣習（ベータは `manifest-beta.json` や pre-release にして、manifest はふつうの Release を指す）」とも読め、どちらかは区別できない
- 選択肢（本人が決める）:
  - (a) **`release.yml` の `0.*) prerelease="--prerelease"` を外し、0.x も通常の Release にする（推奨）**。変更は 1 か所で、BRAT は通常の Release も拾う。ベータであることは README と版番号（0.x）で示す。提出する版（次の 0.4.x）から効く。0.4.0 のままで出すなら、Release 0.4.0 の pre-release の印を GitHub で外すだけでもよい（外部に見える操作なので本人が行う。版の中身は変わらない）
  - (b) 1.0.0 にして出す。`release.yml` はそのままで通常の Release になるが、「0.x はベータ」の区切りを提出の都合で動かすことになる
  - (c) pre-release のまま出し、自動レビューの Releases 節の結果で判断する。Error になれば (a) か (b) で版を上げる（公式の手順どおり、版を上げた Release で応える）。1 往復ぶん遅れうる
- (a) を選ぶなら、`harness.md`「リリース手順」・`product-plan.md` §5 M5・README の BRAT の説明（「pre-releases included」）の 0.x＝pre-release の記述も同じ PR で直す。#35 の attestation を入れるなら同じ PR で `release.yml` の `release` job に `id-token: write`・`attestations: write` と `actions/attest`（`subject-path` に 3 ファイル）を足す

### 4.4 `isDesktopOnly` とモバイル（#9、LEV-25）

要件は「Node.js・Electron の API を使うなら `true`」だけで、Mappy は使っていない（ESLint で import を禁止、バンドルの `require` は Obsidian が渡すものだけ）。したがって**どちらを選んでも要件は満たす**。決めるのは「モバイルで確かめていないものを一覧からモバイルに配るか」。

| 選択肢 | 利用者への影響 | 手間・戻しやすさ |
| --- | --- | --- |
| (A) `false` のまま（現状） | iOS・Android でも一覧から導入できる。README の Compatibility に「モバイルは未確認」と書いてある。タッチでの操作・IME・書き出しの大きさの上限（Capacitor）などで不具合があれば、モバイルの利用者が最初に踏む | 変更なし。モバイルの不具合報告に応える体制が要る |
| (B) `true` にする | モバイルでは一覧に出ない（導入できない）。デスクトップだけに配る | `manifest.json` を変え、版を上げた Release を出す（一覧は HEAD の manifest、導入は Release の manifest を読むので両方に効かせる）。あとで `false` に戻すのも版を上げるだけ |
| (C) LEV-25 でモバイルを実機で確かめてから `false` で出す | (A) と同じだが、確かめた範囲を README に書ける | 提出が LEV-25 の実機検証の分だけ遅れる |

推奨はしない（本人の判断待ち）。材料: `src/` はモバイルを意識した分岐を持つ（書き出しのキャンバスの上限を `Platform` で切り替える、後読みを使わない）が、実機で確かめた記録は無い。

### 4.5 審査で問われたときの英語の説明（#21・#22）

**#21 — why `mappy-layout` and `mappy-topics` are written as source-range edits rather than with `processFrontMatter`**

> Mappy uses `FileManager.processFrontMatter` for the explicit conversions (turning a note into a map and back: adding or removing `mappy` and `mappy-layout`). The two keys that change as a side effect of editing the map — `mappy-layout` when a layout button is pressed, and `mappy-topics` when a free topic is moved — are written through the same queue as the map's own edits to the note body: a minimal source-range edit computed against the latest revision of the file, applied through the `Editor` when the note is open and inside `Vault.process` (with the text checked against what the edit was planned on) when it isn't. We tried `processFrontMatter` for these first. Because it writes outside that queue, an edit to the body that was planned in the ~60 ms before the view re-read the file (for example, the text being typed, saved by the blur of the click on the layout button itself) was refused as a conflicting external change, and nodes whose titles repeat could not keep their identity across the re-read. Writing both kinds of change through one queue keeps them ordered and lets the plugin refuse to overwrite genuine external edits. Only these two keys, which Mappy owns, are touched this way, and the edit covers only their lines: the rest of the frontmatter is not re-serialized.

**#22 — why `WorkspaceLeaf.prototype.setViewState` is wrapped**

> Mappy opens notes marked `mappy: true` in its map view, the same way Excalidraw and Kanban open their own Markdown-based files: it wraps `WorkspaceLeaf.prototype.setViewState` and, when a leaf is asked to show such a note as `markdown`, hands it the map view type instead. The wrapper only rewrites the `type` of that state; it always calls the original method, keeps a leaf that the user deliberately switched to Markdown on Markdown (including back/forward navigation), and passes every other state through untouched. It is installed once in `onload` and removed on unload through `this.register`. Removing it restores the original method; if another plugin has wrapped the method since, Mappy's wrapper instead becomes a pass-through, so the other plugin's wrapper is not undone (the same semantics as the widely used `monkey-around` helper, without the dependency). This is covered by unit tests.

### 4.6 提出の手順と入力の下書き（本人の操作）

提出は外部への公開なので、ここまでの準備はエージェントが行い、提出は本人（またはその確認のあとのオーケストレーター）が行う。

1. 提出の当日に、`id`・`name` の衝突を一覧（`https://community.obsidian.md/assets/community-plugins.json` か obsidian-releases の `community-plugins.json`）で確かめ直す
2. §4.3 の判断に従って、提出する版の Release を用意する（通常の Release にするなら、その版から）
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
