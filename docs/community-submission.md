# コミュニティ公開審査の要件と英語化の方式

LEV-136（2026-09-27）。本人の決定: **コミュニティプラグインの公開審査に出す方向で進め、英語化を次の大きな柱にする。AI 機能（M9、LEV-28）は当面保留。** 本書はその前提で、審査要件と Mappy の現状の対応表（§1）と、英語化の方式の比較と推奨（§2）を記す。決定そのものは `product-plan.md` §5 M5 と §7 が正本で、本書は根拠と作業の分け方を持つ。

- 参照した公式文書（2026-09-27 に取得）: [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)、[Submission requirements for plugins](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)、[Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)、[Developer policies](https://docs.obsidian.md/community-directory/developer-policies)。公式 ESLint プラグイン `eslint-plugin-obsidianmd` 0.4.2 の規則（`node_modules` で確認）
- 前回の照合は LEV-24（2026-09-19、47 項目。`artifacts/lev-24-readme/record.md`、git 管理外）。本書はそれを 0.3.8 の木（`main` の `0e8c4d1`）で grep し直し、変わった点を足したもの。**表の PASS も公式 lint の通過も、審査の通過を保証しない**（審査は提出時点の公式文書と人のレビューで決まる）
- 公式文書の**どれにも UI・README の言語の要件は無い**（4 文書とも、言語・英語・ローカライズへの言及なし）。英語化は審査の必須条件ではなく、一覧の読者（英語）に届けるための判断である

## 1. 審査要件と現状

結果の凡例: PASS（根拠つきで満たす）／要対応（提出前に直す）／未実施（実機や本人の確認が要る）／判断（本人が決める）。「子」はこの表から切った LEV-136 の子チケット（§3）。

### 1.1 提出の手順と必須ファイル

| # | 要件（出典） | Mappy の現状 | 結果 | 子 |
| --- | --- | --- | --- | --- |
| 1 | リポジトリのルートに `README.md`・`LICENSE`・`manifest.json`（Submit） | 3 つとも在る。LICENSE は MIT | PASS | — |
| 2 | README は目的と使い方を説明する（Submit） | 日本語で、目的・保存形式・導入・操作・対応環境・制限・復旧・ネットワーク・ライセンスを持つ（218 行） | 要対応（英語版が無い） | README の英語化 |
| 3 | `manifest.version` と同じ `x.y.z` タグの GitHub Release に `main.js`・`manifest.json`・`styles.css` を添付（Submit） | `release.yml` が検査して添付（LEV-68）。0.x は pre-release | PASS（審査用の版は pre-release にしない点を提出準備で確かめる） | 提出準備 |
| 4 | 提出は community.obsidian.md で Obsidian アカウントに GitHub を連携して行い、自動レビューの指摘には版を上げた Release で応える（Submit） | 未提出。LEV-24 の時点の記録には無かった手順 | 未実施 | 提出準備 |
| 5 | `id` は公開済みの全プラグインで一意、`obsidian` を含まない（Submit・Requirements） | `mappy`。`scripts/validate-release.mjs` が形を検査。一覧との衝突は本人が 2026-09-19 に確認 | PASS（提出の直前にもう一度確かめる） | 提出準備 |

### 1.2 manifest

| # | 要件（出典） | Mappy の現状 | 結果 | 子 |
| --- | --- | --- | --- | --- |
| 6 | `description`: 動詞で始める、`This is a plugin` で始めない、250 字以内、ピリオドで終わる、絵文字・特殊文字なし、固有名詞と頭字語の大文字（Requirements） | `View and edit Markdown as linked, illustrated mind maps.`（56 字、英語） | PASS | — |
| 7 | `fundingUrl` は寄付を受けるときだけ置く（Requirements） | 無し | PASS | — |
| 8 | `minAppVersion` は必要な最小版（Requirements） | `1.8.7`。型 1.8.7 で型検査が通る。1.8.7 の実機は未確認 | PASS（型）／未実施（実機） | LEV-25 |
| 9 | Node／Electron API を使うなら `isDesktopOnly: true`（Requirements） | `false`。`src/` に Node／Electron の import 0 件（ESLint で禁止）。バンドルの `require` は `obsidian`（17）・`@lezer/common`・`@lezer/highlight` だけ | PASS（コード）／未実施（モバイル実機） | LEV-25 |
| 10 | `name` に `Obsidian`・`Plugin` を含めない、`author` を置く（manifest の検査） | `Mappy`、`Hiroya Iizuka` | PASS | — |

### 1.3 コマンド・UI 文言

| # | 要件（出典） | Mappy の現状 | 結果 | 子 |
| --- | --- | --- | --- | --- |
| 11 | コマンド ID にプラグイン ID を前置しない（Requirements） | 10 コマンド（`create-mindmap` … `call-map`、`convert-to-list`）。前置なし | PASS | — |
| 12 | コマンド名にプラグイン名を入れない、既定ホットキーを置かない（Guidelines） | 名前は日本語で `Mappy` を含まない。`hotkeys` の指定 0 件 | PASS | — |
| 13 | 条件付きは `checkCallback`、無条件は `callback`（Guidelines） | LEV-24 から形は同じ | PASS | — |
| 14 | UI 文言は sentence case（Guidelines） | 日本語なので lint の `ui/sentence-case` は実質何も検査していない。**英語にした時点で初めて効く** | 要対応（英語化の中で lint を通す） | 文言の置き換え |
| 15 | 設定の見出しは区画が複数のときだけ、見出しに「settings」を入れない、`setHeading()` を使う（Guidelines） | 見出しなしの 4 項目（テーマ・既定レイアウト・作成先フォルダ・左下のレイアウト） | PASS | — |
| 16 | UI の言語（要件なし） | UI 文言は 24 ファイルに約 200 個、すべて日本語。コマンド名 10・右クリックメニュー・ボタンの `aria-label`・通知・設定の名前と説明・core の例外文（`Notice` に出る）を含む | 判断 → §2 | 文言の抽出・置き換え |

### 1.4 セキュリティ・リソース・ワークスペース・Vault

| # | 要件（出典） | Mappy の現状 | 結果 | 子 |
| --- | --- | --- | --- | --- |
| 17 | `innerHTML`／`outerHTML`／`insertAdjacentHTML` を使わない（Guidelines） | 0 件 | PASS | — |
| 18 | グローバル `app`・`workspace.activeLeaf` を使わない（Guidelines） | `activeLeaf` 0 件。`app` は引数と `this.app` だけ | PASS | — |
| 19 | ログは既定でエラーだけ（Guidelines） | `console.*` は `document-store.ts` の `console.error`（書き込みの購読者が投げた例外）1 件だけ | PASS | — |
| 20 | unload で登録を解除し、`onunload` で leaf を閉じない（Guidelines） | `register*` と `this.register` で解除。`detachLeavesOfType` なし。テストあり（LEV-24 の #31〜35） | PASS（テスト）／未実施（実機の無効化・再有効化・ペインの閉開） | LEV-25 |
| 21 | 開いたノートは Editor、背景の変更は `Vault.process`、frontmatter は `processFrontMatter`（Guidelines） | 開いた文書は Editor、閉じた文書は `Vault.process` 内で原文を照合（AGENTS.md の規約）。明示の変換・解除（`mappy`・`mappy-layout` の書き込みと削除）は `processFrontMatter`（`obsidian/frontmatter.ts`）。マップの編集に伴う `mappy-layout`・`mappy-topics` の更新は、マップ自身の編集と同じ書き込みの列に載せるため**原文範囲の差分**で書く（LEV-196。列の外で書くと、その間に計画した編集が他者の変更として拒否された） | PASS／後者は設計上の意図的な使い分けで、審査で問われたら理由を示す | 提出準備 |
| 22 | `WorkspaceLeaf.prototype.setViewState` の差し替え（ガイドラインに記述なし） | Excalidraw・Kanban と同じ方式。解除で元に戻り、後から包まれていても素通し（テストあり） | PASS（テスト）／審査で説明を求められうる | 提出準備 |
| 23 | 正規表現の後読みを使わない（モバイル。Guidelines） | 0 件 | PASS | — |

### 1.5 スタイル

| # | 要件（出典） | Mappy の現状 | 結果 | 子 |
| --- | --- | --- | --- | --- |
| 24 | 静的な見た目をインラインスタイルで書かない。CSS 変数を使う（Guidelines） | インラインは位置・寸法（レイアウトの結果）だけ。lint の `no-static-styles-assignment` が通る | PASS | — |
| 25 | CSS を自分の要素に限定する（Guidelines の意図） | `.mappy-*` と `.internal-embed.mappy-embed-host`（埋め込みの置き場）。`!important` は `.mappy-view { padding: 0 }` の 1 件 | PASS | — |

### 1.6 開発者ポリシー

| # | 要件（出典） | Mappy の現状 | 結果 | 子 |
| --- | --- | --- | --- | --- |
| 26 | 難読化・動的広告・クライアント側テレメトリ・自己更新をしない（Policies） | どれも無い。本番は esbuild の標準 minify（難読化ではない） | PASS | — |
| 27 | ネットワーク利用は使う先と理由を明示する（Policies） | 自前の通信は SVG／PNG 書き出しでノートが参照する外部画像を `requestUrl` で取る 1 経路だけ（`image-export.ts`）。表示はノートの外部画像を Obsidian と同じく読む。README「ネットワーク利用」に日本語で開示 | PASS（英語の README にも同じ開示が要る） | README の英語化 |
| 28 | 支払い・アカウント・Vault 外のファイル（Policies） | どれも無い。**M9（有料の AI 機能）を入れる時点でこの行が変わる**（保留中） | PASS | — |
| 29 | LICENSE と同梱物の表示（Policies） | MIT。同梱の `@lezer/markdown`（MIT）を README に表示 | PASS（英語の README にも残す） | README の英語化 |

### 1.7 公開の前に済ませたい品質（要件ではない）

| # | 項目 | 現状 | 子 |
| --- | --- | --- | --- |
| 30 | 宣言した対応環境での実機確認 | macOS の Obsidian 1.14.2 だけ。Windows・Linux・モバイル・1.8.7 は未確認 | LEV-25 |
| 31 | 一覧に載せる画像（README の先頭のスクリーンショットか GIF） | README に画像なし | README の英語化 |
| 32 | ベータ表記と既知の制限 | README の「既知の制限」は日本語 IME などを挙げる。英語圏の読者向けに書き直す | README の英語化 |

## 2. 英語化の方式

### 2.1 前提（実測、2026-09-27、`0e8c4d1`）

- UI 文言: `src/` の 24 ファイルに日本語の文字列リテラル約 200 個。多いのは `ui/mindmap-view.ts`（54）、`main.ts`（36）、`core/commands.ts`（18）、`obsidian/settings-tab.ts`・`obsidian/excalidraw-bridge.ts`（14 ずつ）。core・export の例外文（約 40）も `Notice` を通って利用者に見える
- **Markdown に書き込まれる既定の文字列**が 3 つある: 新しいノードの `サブトピック`、新しいトピックの `トピック`、新規ファイルの `無題のマインドマップ`。これは UI ではなく本文になる
- 保存値は言語に依存しない: 設定は `follow`・`light`・`dark`、レイアウトは `mindmap` などの id を保存し、日本語はラベルにしか使っていない（`THEME_LABELS`・`LAYOUT_LABELS`）。言語を切り替えても既存の設定とノートは読める
- バンドル: 本番の `main.js` は 239,762 B。esbuild の既定（`charset: ascii`）で非 ASCII の文字はすべて `\uXXXX`（1 字 6 B）に書かれる。その数は 1,302（約 7.8 KB。ほぼ日本語の UI 文言で、正規表現の文字範囲なども含む）
- Obsidian API 1.8.7（`minAppVersion` と同じ）に `getLanguage()`（アプリの言語の ISO コード、既定 `en`）がある。公式 lint には `prefer-get-language`（`localStorage.getItem('language')` を使わせない）と、英語のロケールファイル（`**/en.ts`・`**/en/*.ts` など）の文字列に sentence case を強いる `ui/sentence-case-locale-module` が recommended に入っている
- テストの結合: `tests/` と `scripts/e2e/` に日本語の文言を照合する箇所が多い（代表的な 5 語だけで 18 ファイル）。e2e はテスト用 Obsidian の画面の文言を読むので、その Obsidian の言語が結果を左右する

### 2.2 比較

| 観点 | (a) 英語に一本化 | (b) 文言テーブル＋ `getLanguage()` で切り替え | (c) 日本語のまま出す |
| --- | --- | --- | --- |
| 本人の日常使用 | 英語になる（毎日の操作が遅くなる、と本人） | 日本語のまま（Obsidian を日本語で使っている限り） | 日本語のまま |
| 公開の読者 | 英語 | 英語（日本語以外の言語はすべて英語に落ちる） | 日本語が読めない読者には使えない |
| 審査 | 要件は無いが、英語の一覧に日本語 UI という指摘を受けにくい | 同左。lint の `sentence-case-locale-module` が英語の表を検査する | 要件違反ではないが、sentence case などの文言規則が事実上検査されない。差し戻し・低評価の恐れ（推測。根拠となる公式の記述は無い） |
| バンドル増分 | 約 −4 KB（日本語 7.8 KB → 英語 約 3〜4 KB の見積もり。英語は 1 字 1 B で、日本語 1 字に英語 2〜3 字） | 約 +4〜5 KB（英語の表 約 3〜4 KB ＋ キーと参照 約 1 KB の見積もり。現在の約 2%） | 0 |
| ランタイム依存 | なし | なし（自前の数十行。i18next などは入れない） | なし |
| 保守 | 文言は 1 か所に 1 つ。追加の手間なし | 文言を足すたびに 2 言語を書く。**キーの欠けは型で止める**（`ja` を `typeof en` の型にする）。訳の質は機械では見ない | なし |
| テスト | 日本語を照合するテスト・e2e を英語に書き換える（大量） | 既存のテストは日本語のまま通る（テスト環境の言語を `ja` にする）。英語の表・切り替え・キーの一致を足す。e2e は起動する Obsidian の言語を `ja` に固定するか、照合を文言に依らない形（id・属性）へ移す | 変更なし |
| Markdown に書く既定文字列（`サブトピック` など） | 英語になる | UI と同じ言語に従う（日本語の Obsidian では従来どおり） | 日本語のまま |
| 戻しやすさ | 日本語 UI に戻すには (b) と同じ作業が要る | (a) には英語の表だけ残せば済む | — |

### 2.3 推奨: (b)

(b) を推奨する（オーケストレーターの推奨と同じ）。理由:

1. **本人の日常使用を変えずに公開を英語にできる唯一の案**。(a) は本人の操作を遅くし、(c) は一覧の読者に届かない
2. コストが小さい: 増分は約 2%、ランタイム依存なし、`getLanguage()` は `minAppVersion` 1.8.7 の型にあるので最小版を上げない。公式 lint が英語の表を検査する仕組みを既に持っている
3. 既存のテストを書き換えずに済む（テスト環境を `ja` に置く）。(a) を選ぶとテストの照合を大量に英語へ書き換える

実装の形（子チケットの前提。本人が (b) を確定したときに使う）:

- `src/i18n/`（Obsidian に依存しない。core から使えるように）に `en.ts`（正本。lint の対象パターンに合う名前）と `ja.ts`（型 `typeof en` で、キーの欠け・余りを型検査で止める）と、言語を選んで文言を返す小さな関数を置く。言語は `main.ts` の `onload` で `getLanguage()` を 1 回読んで渡す（Obsidian は言語を変えるとアプリを再読込するので、実行中の切り替えは扱わない）。`ja` なら日本語、それ以外は英語
- core・export の例外文も同じ表から引く（core を Obsidian に依存させない規約のため、`getLanguage()` は core から呼ばない）
- Markdown に書く既定文字列（`サブトピック`・`トピック`・`無題のマインドマップ`）も UI と同じ言語に従う
- テスト: 表のキーの一致、`en` の文言の lint、言語の選択（`ja`・`en`・その他 → 英語）。既存の DOM テストは `ja` のまま。e2e を回す Obsidian の言語をどう固定するかは、文言の置き換えのチケットで確かめる（今のテスト用プロファイルが何語かは未確認）

(b) を選ばない場合: (a) なら同じ子チケットの「表」を `en` だけにし、テストの照合を英語へ直す作業が増える。(c) なら子チケットは README の英語版と提出準備だけになる。

## 3. 子チケット（LEV-136 の子）

方式に依らない形で切り、(b) に依るものはそう明記する。

- **UI 文言の抽出と置き換え**（(b) を前提）: `src/i18n/` の新設、約 200 の文字列の移し替え、`getLanguage()` による選択、テスト（キーの一致・言語の選択・英語の lint）、e2e の言語の固定。量が多いので、層（core／obsidian／ui）で PR を分けてよい
- **README の英語版**（方式に依らない）: 英語を主にする README と日本語の README の置き方、ネットワーク利用・ライセンス・同梱物の開示、先頭の画像、既知の制限の書き直し
- **審査要件のチェックと提出準備**（方式に依らない）: 本書 §1 の「要対応」「判断」を提出の直前に再確認し（#3・#4・#5・#21・#22）、community.obsidian.md への提出と自動レビューへの対応。英語化の 2 本と LEV-25 の後に着手する
