# コミュニティ公開審査の要件と英語化の方式

LEV-136（2026-09-27）。本人の決定: **コミュニティプラグインの公開審査に出す方向で進め、英語化を次の大きな柱にする。AI 機能（M9、LEV-28）は当面保留。** 本書はその前提で、審査要件と Mappy の現状の対応表（§1）と、英語化の方式の比較と推奨（§2）を記す。決定そのものは `product-plan.md` §5 M5 と §7 が正本で、本書は根拠と作業の分け方を持つ。

- 参照した公式文書（2026-09-27 に取得）: [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)、[Submission requirements for plugins](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)、[Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)、[Developer policies](https://docs.obsidian.md/community-directory/developer-policies)。公式 ESLint プラグイン `eslint-plugin-obsidianmd` 0.4.2 の規則（`node_modules` で確認）
- 前回の照合は LEV-24（2026-09-19、47 項目。`artifacts/lev-24-readme/record.md`、git 管理外）。項目の分け方の正本は `docs/harness.md`「審査要件のチェック項目」で、本書の表はそれを 0.3.8 の木（`main` の `0e8c4d1`）で照合し直し、2026-09-27 の公式文書で変わった点（提出の手順など）を足した**この時点の結果**である。番号は本書の中だけのもの。**本書の 32 行は harness.md の項目をすべては写していない**（`version` の 4 ファイル一致、manifest の不明なキー、サンプルコードの残り、`fs`／`process` の不使用、`dist/mappy/` の 3 ファイルとサイズ、`main.js` をコミットしないこと、README の保存形式・導入・復旧・対応環境の節などは、LEV-24 から変わりうる点が無いと見て省いた）。提出の直前の再確認（LEV-228）は harness.md の全項目で行い、本書との食い違いはそこで片付ける。**表の PASS も公式 lint の通過も、審査の通過を保証しない**（審査は提出時点の公式文書と人のレビューで決まる）
- 公式文書の**どれにも UI・README の言語の要件は無い**（4 文書とも、言語・英語・ローカライズへの言及なし）。英語化は審査の必須条件ではなく、一覧の読者（英語）に届けるための判断である

## 1. 審査要件と現状

結果の凡例: PASS（根拠つきで満たす）／要対応（提出前に直す）／未実施（実機や本人の確認が要る）／判断（本人が決める）。「担当」は残る作業を持つチケット。LEV-226〜228 は本書 §3 で切った LEV-136 の子、LEV-25 は既存の別チケット（対応環境の宣言と実機検証）で LEV-136 の子ではない。

### 1.1 提出の手順と必須ファイル

| # | 要件（出典） | Mappy の現状 | 結果 | 担当 |
| --- | --- | --- | --- | --- |
| 1 | リポジトリのルートに `README.md`・`LICENSE`・`manifest.json`（Submit） | 3 つとも在る。LICENSE は MIT | PASS | — |
| 2 | README は目的と使い方を説明する（Submit） | `README.md` は英語で、目的・保存形式・導入・操作・対応環境・制限・復旧・ネットワーク・ライセンスを持つ。日本語版は同じ節で `README.ja.md`（先頭で互いにリンク。LEV-227。それまでは日本語の `README.md` だけだった） | PASS（要件は言語を問わない） | LEV-227 |
| 3 | `manifest.version` と同じ `x.y.z` タグの GitHub Release に `main.js`・`manifest.json`・`styles.css` を添付（Submit） | `release.yml` が検査して添付（LEV-68）。ただし **0.x のタグは必ず pre-release になる**（`release.yml` の `0.*) prerelease="--prerelease"`） | PASS（Submit の文面は満たす）／未確認: 公式文書は pre-release の可否に触れていない。pre-release のままで一覧が版を拾えるかを提出準備で確かめ、拾えないときだけ `release.yml` か 1.0.0 を本人が決める | LEV-228 |
| 4 | 提出は community.obsidian.md で Obsidian アカウントに GitHub を連携して行い、自動レビューの指摘には版を上げた Release で応える（Submit） | 未提出。LEV-24 の時点の記録には無かった手順 | 未実施 | LEV-228 |
| 5 | `id` は公開済みの全プラグインで一意、`obsidian` を含まない（Submit・Requirements） | `mappy`。`scripts/validate-release.mjs` が形を検査。一覧との衝突は本人が 2026-09-19 に確認 | PASS（提出の直前にもう一度確かめる） | LEV-228 |

### 1.2 manifest

| # | 要件（出典） | Mappy の現状 | 結果 | 担当 |
| --- | --- | --- | --- | --- |
| 6 | `description`: 動詞で始める、`This is a plugin` で始めない、250 字以内、ピリオドで終わる、絵文字・特殊文字なし、固有名詞と頭字語の大文字（Requirements） | `View and edit Markdown as linked, illustrated mind maps.`（56 字、英語） | PASS | — |
| 7 | `fundingUrl` は寄付を受けるときだけ置く（Requirements） | 無し | PASS | — |
| 8 | `minAppVersion` は必要な最小版（Requirements） | `1.8.7`。型 1.8.7 で型検査が通る。1.8.7 の実機は未確認 | PASS（型）／未実施（実機） | LEV-25 |
| 9 | Node／Electron API を使うなら `isDesktopOnly: true`（Requirements） | `false`。`src/` に Node／Electron の import 0 件（ESLint で禁止）。バンドルの `require` は `obsidian`（17）・`@lezer/common`・`@lezer/highlight` だけ | PASS（コード）／未実施（モバイル実機） | LEV-25 |
| 10 | `name` に `Obsidian`・`Plugin` を含めない、`author` を置く（上の 4 文書には無い。`scripts/validate-release.mjs` の検査と LEV-24 の記録による） | `Mappy`、`Hiroya Iizuka` | PASS | — |

### 1.3 コマンド・UI 文言

| # | 要件（出典） | Mappy の現状 | 結果 | 担当 |
| --- | --- | --- | --- | --- |
| 11 | コマンド ID にプラグイン ID を前置しない（Requirements） | 10 コマンド（`create-mindmap` … `call-map`、`convert-to-list`）。前置なし | PASS | — |
| 12 | コマンド名にプラグイン名を入れない、既定ホットキーを置かない（Guidelines） | 名前は `src/i18n` の表から引き、英語（`Create new mind map` など）・日本語のどちらも `Mappy` を含まない（2026-09-28、LEV-226 のあとの木で確認）。`hotkeys` の指定 0 件 | PASS | — |
| 13 | 条件付きは `checkCallback`、無条件は `callback`（Guidelines） | LEV-24 から形は同じ | PASS | — |
| 14 | UI 文言は sentence case（Guidelines） | 0.3.8 の時点では日本語なので実質何も検査していなかった。LEV-233 で `eslint.config.mjs` に `src/i18n/en.ts` を対象とする `ui/sentence-case-locale-module` の block を足し、`npm run lint` が英語の表を検査する（`tests/tooling/i18n-lint.test.mjs`）。値を差し込む関数の中の文字列は規則が読まない | PASS（lint。関数の文言は読まない） | LEV-226 |
| 15 | 設定の見出しは区画が複数のときだけ、見出しに「settings」を入れない、`setHeading()` を使う（Guidelines） | 見出しなしの 4 項目（テーマ・既定レイアウト・作成先フォルダ・左下のレイアウト） | PASS | — |
| 16 | UI の言語（要件なし） | 0.3.8 の時点では UI 文言が 24 ファイルに約 200 個、すべて日本語だった。§2 の (b) を 2026-09-28 に本人が確定し、LEV-226（LEV-233・LEV-234・LEV-235、#118・#120・#121）で `src/i18n` の表へ移した: Obsidian の言語が `ja` なら日本語、それ以外は英語。`src/` の日本語の文字列は `src/i18n/ja.ts` だけ。英語の Obsidian での表示は実機 E63（macOS、Obsidian 1.14.2）で確認。0.4.0 で初めて出る | 判断済み（(b)） | LEV-226 |

### 1.4 セキュリティ・リソース・ワークスペース・Vault

| # | 要件（出典） | Mappy の現状 | 結果 | 担当 |
| --- | --- | --- | --- | --- |
| 17 | `innerHTML`／`outerHTML`／`insertAdjacentHTML` を使わない（Guidelines） | 0 件 | PASS | — |
| 18 | グローバル `app`・`workspace.activeLeaf` を使わない（Guidelines） | `activeLeaf` 0 件。`app` は引数と `this.app` だけ | PASS | — |
| 19 | ログは既定でエラーだけ（Guidelines） | `console.*` は `document-store.ts` の `console.error`（書き込みの購読者が投げた例外）1 件だけ | PASS（ガイドライン）／**harness.md「審査要件のチェック項目」の「`console.*` が `src/` と `dist/mappy/main.js` にない」には反する**。どちらに合わせるか（1 件を消すか、項目をガイドラインに合わせて「エラー以外」にするか）を提出準備で決める | LEV-228 |
| 20 | unload で登録を解除し、`onunload` で leaf を閉じない（Guidelines） | `register*` と `this.register` で解除。`detachLeavesOfType` なし。テストあり（LEV-24 の #31〜35） | PASS（テスト）／未実施（実機の無効化・再有効化・ペインの閉開） | LEV-25 |
| 21 | 開いたノートは Editor、背景の変更は `Vault.process`、frontmatter は `processFrontMatter`（Guidelines） | 開いた文書は Editor、閉じた文書は `Vault.process` 内で原文を照合（AGENTS.md の規約）。明示の変換・解除（`mappy`・`mappy-layout` の書き込みと削除）は `processFrontMatter`（`obsidian/frontmatter.ts`）。マップの編集に伴う `mappy-layout`・`mappy-topics` の更新は、マップ自身の編集と同じ書き込みの列に載せるため**原文範囲の差分**で書く（LEV-196。列の外で書くと、その間に計画した編集が他者の変更として拒否された） | 判断（後者はガイドラインからの意図的な逸脱。審査で問われたときの英語の説明を用意する） | LEV-228 |
| 22 | `WorkspaceLeaf.prototype.setViewState` の差し替え（ガイドラインに記述なし） | Excalidraw・Kanban と同じ方式。解除で元に戻り、後から包まれていても素通し（テストあり） | PASS（テスト）／審査で説明を求められうる | LEV-228 |
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
| 27 | ネットワーク利用は使う先と理由を明示する（Policies） | 自前の通信は SVG／PNG 書き出しでノートが参照する外部画像を `requestUrl` で取る 1 経路だけ（`image-export.ts`）。表示はノートの外部画像を Obsidian と同じく読む。README「Network use」（英語）と `README.ja.md`「ネットワーク利用」に同じ内容で開示（LEV-227） | PASS | LEV-227 |
| 28 | 支払い・アカウント・Vault 外のファイル（Policies） | どれも無い。**M9（有料の AI 機能）を入れる時点でこの行が変わる**（保留中） | PASS | — |
| 29 | LICENSE と同梱物の表示（Policies） | MIT。同梱の `@lezer/markdown`（MIT）を README（英語）と `README.ja.md` の「License／ライセンス」に表示（LEV-227） | PASS | LEV-227 |

### 1.7 公開の前に済ませたい品質（要件ではない）

| # | 項目 | 現状 | 担当 |
| --- | --- | --- | --- |
| 30 | 宣言した対応環境での実機確認 | macOS の Obsidian 1.14.2 だけ。Windows・Linux・モバイル・1.8.7 は未確認 | LEV-25 |
| 31 | 一覧に載せる画像（README の先頭のスクリーンショットか GIF） | LEV-227 で両方の README の先頭にテスト Vault のマップのスクリーンショット 1 枚（明色、`docs/images/mappy-map.png`）を置いた。一覧（Obsidian のプラグインの画面）が README の相対パスを解決するかは確かめていないので、`main` の raw.githubusercontent.com の絶対 URL で参照する（merge 前のブランチでは表示されない）。一覧での表示は提出準備（LEV-228）で確かめる | LEV-227 |
| 32 | ベータ表記と既知の制限 | LEV-227 で英語の「Known limitations」を置き、IME の項目を「日本語以外（中国語・韓国語など）の IME も未確認」まで広げた（日本語版も同じ）。表示言語を「対応環境」に足した | LEV-227 |

## 2. 英語化の方式

### 2.1 前提（実測、2026-09-27、`0e8c4d1`）

- UI 文言: `src/` の 24 ファイルに日本語の文字列リテラル約 200 個。多いのは `ui/mindmap-view.ts`（54）、`main.ts`（36）、`core/commands.ts`（18）、`obsidian/settings-tab.ts`・`obsidian/excalidraw-bridge.ts`（14 ずつ）。core・export の例外文（約 40）も `Notice` を通って利用者に見える
- **Markdown に書き込まれる既定の文字列**が 3 つある: 新しいノードの `サブトピック`、新しいトピックの `トピック`、新規ファイルの `無題のマインドマップ`。これは UI ではなく本文になる
- 保存値は言語に依存しない: 設定は `follow`・`light`・`dark`、レイアウトは `mindmap` などの id を保存し、日本語はラベルにしか使っていない（`THEME_LABELS`・`LAYOUT_LABELS`。LEV-233・LEV-234 以降は `layoutLabel()`・`themeLabel()`）。言語を切り替えても既存の設定とノートは読める
- バンドル: 本番の `main.js` は 239,762 B。esbuild の既定（`charset: ascii`）で非 ASCII の文字はすべて `\uXXXX`（1 字 6 B）に書かれる。その数は 3,454、うち CJK と仮名（U+3000〜U+9FFF）が 3,430 で約 20.6 KB（バンドルの約 8.6%）。全角の括弧・斜線（U+FF08 など）を足すと 3,444
- Obsidian API 1.8.7（`minAppVersion` と同じ）に `getLanguage()`（アプリの言語の ISO コード、既定 `en`）がある。公式 lint には `prefer-get-language`（`localStorage.getItem('language')` を使わせない）（recommended に入っている）と、英語のロケールファイル（`**/en.ts`・`**/en/*.ts` など）の文字列に sentence case を強いる `ui/sentence-case-locale-module` がある。**後者は `configs.recommendedWithLocalesEn` にだけ入っていて、Mappy の `eslint.config.mjs` が使う `configs.recommended` には入っていない**。(b) で英語の表を検査させるには、設定を `recommendedWithLocalesEn` に切り替えるか、`src/i18n/en.ts` に当たる block を足す
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
- **審査要件のチェックと提出準備**（LEV-228。方式に依らない）: `docs/harness.md`「審査要件のチェック項目」の全項目と本書 §1 の全行を提出直前の木で再確認する。とくに判断の #21（frontmatter の書き方の逸脱の説明）、未実施の #4（提出）、PASS だが提出の直前に確かめ直す #5（id の一意性）、未確認の #3（pre-release のままで一覧が版を拾えるか）、harness.md と食い違う #19（`console.error`）、審査で説明を求められうる #22（prototype の差し替え）。#2・#14・#16 は LEV-226・LEV-227 が片付け、ここでは結果を確かめるだけ。community.obsidian.md への提出と自動レビューへの対応も持つ。英語化の 2 本と LEV-25 の後に着手する
