# Mappy の設計と試作実装

更新: 2026-09-20。現在の実装と、引き続き検証する条件を記す。実装済みという記述は、対応環境全体での動作保証を意味しない。

## 1. 中心となる判断

**文書の正本は Markdown 一つにする。マップはその投影と編集 UI にする。** マップ専用 JSON と Markdown を相互変換して保存する構成は採用しない。変更していない本文をそのまま残すことを、描画より先に設計する。

```mermaid
flowchart LR
  E[Obsidian 標準 Markdown エディタ] -->|editor-change| S[文書セッション: 原文と revision]
  S --> P[原文範囲付きツリー]
  P --> L[マップ / タイムライン / 階層図 / 左右バランス配置]
  L --> V[HTML ノード + SVG 接続線]
  V -->|ノード編集コマンド| C[revision 検証と部分変更]
  C -->|Editor.transaction| E
  F[Vault の外部変更] --> S
  C -->|エディタがない場合だけ Vault.process| F
```

TypeScript＋esbuild と標準 DOM を使う。ノードの表示には Obsidian の MarkdownRenderer、ノードのインライン入力には専用 textarea を使い、分割先は標準 Markdown エディタを使う。React や汎用グラフエディタは導入していない。

## 2. モジュール境界

| 層 | 責務 | 外部依存 |
| --- | --- | --- |
| `src/main.ts` | view・command・ribbon・ファイルメニューの登録 | Obsidian |
| `src/core/markdown.ts` | 構文解析、原文範囲、ノードの対応付け | `@lezer/markdown` |
| `src/core/commands.ts` / `list-commands.ts` / `body.ts` | rename / add（空、または `title` 付きで文を同じ差分に）/ move / delete / 本文変更 → 原文差分 | 純粋 TypeScript |
| `src/core/list-conversion.ts` | 旧見出し形式から H2＋箇条書きへの明示変換 | 純粋 TypeScript |
| `src/core/topics.ts` / `yaml-lite.ts` | frontmatter `mappy-topics` の読み取り（YAML サブセット）と、そのキーだけを差し替える書き込み（移動・キーの付け替え・削除時の除去）。キーの導出 `topicKeys` | 純粋 TypeScript |
| `src/layout/layout.ts` | tree＋実測サイズ → マップ／タイムライン／階層図／左右バランスの座標と線。モードの振り分け、右向き・左向き（鏡像）の枝の配置、フリートピックの配置 | 純粋 TypeScript |
| `src/layout/hierarchy.ts` / `primitives.ts` | 階層図（ルートを上、親ごとに段揃え）の配置本体と、全モード・renderer が共有する矩形・線・開閉ボタンの型と寸法 | 純粋 TypeScript |
| `src/interaction/viewport.ts` | パン・ズーム・Fit の座標計算 | 純粋 TypeScript |
| `src/core/attachments.ts` / `plain-text.ts` | 本文からのリンク・画像抽出、タイトルの平文化 | `@lezer/markdown` |
| `src/export/excalidraw-scene.ts` / `src/layout/path-points.ts` | tree＋計測 → 描画 API 非依存のシーン（ブロック・折れ線） | 純粋 TypeScript |
| `src/export/svg-document.ts` | SVG 書き出しのシーン（ノードの XHTML・線のパス・バッジ・色）→ SVG 文字列、viewBox と余白、PNG の縮尺、スタイルの重複除去 | 純粋 TypeScript |
| `src/export/svg-capture.ts` | 配置済みのノード要素と `LayoutResult` → シーン。算出スタイルの白名簿を直列化し、画像は差し込まれた resolver で data URL に。SVG → canvas → PNG | DOM（Obsidian の global `createEl` で作業用要素） |
| `src/obsidian/image-export.ts` | Vault の画像を data URL に読む resolver、添付設定の保存先への `create`／`createBinary`、モバイルのピクセル上限 | Vault、metadataCache、FileManager、`requestUrl`、`Platform` |
| `src/obsidian/document-store.ts` | Editor/Vault の一本化、原文照合、キュー、履歴 | Obsidian の公開 API |
| `src/obsidian/frontmatter.ts` / `map-files.ts` | `mappy: true` の識別、初期レイアウト、新規マップ作成 | metadataCache、FileManager、Vault |
| `src/obsidian/settings.ts` / `settings-tab.ts` | 設定の型・既定値・欠損／旧形式の正規化と、`PluginSettingTab`（`display()` と 1.13 以降の `getSettingDefinitions`）。保存は `main.ts` の `loadData`／`saveData` | Obsidian の Setting UI |
| `src/obsidian/view-routing.ts` / `patch.ts` | frontmatter を持つノートを map view へ導く `setViewState` の差し替え | WorkspaceLeaf.prototype |
| `src/obsidian/excalidraw-bridge.ts` / `src/types/excalidraw-automate.ts` | Excalidraw の `ExcalidrawAutomate` へのドロップフック連結と要素生成 | `window.ExcalidrawAutomate`（任意） |
| `src/ui/mindmap-view.ts` | ファイル・表示状態、描画更新、編集経路の接続 | Obsidian ItemView |
| `src/ui/node-renderer.ts` | ノードの差分描画、計測、MarkdownRenderer の寿命。呼び出したマップのノード（M12）は `sources` に従い、呼び出し先の文書・パスで題名と添付を描き、`is-called`／`is-called-root` と `link` の印・ツールチップを付ける | Obsidian MarkdownRenderer |
| `src/ui/map-events.ts` / `node-drag.ts` / `map-viewport.ts` | キー・リンク・画像貼付（クリックの解釈 `mapClick` は埋め込みと共有。`nodeOf` はそのキャンバスのノード要素）、呼び出したノードのダブルクリック（`open`）と読み取り専用の遮断（`readOnly`）、pointer イベントによるノードのドラッグとゴースト、DOM のパン／ズーム | Obsidian Component、DOM |
| `src/layout/drop-preview.ts` / `snap.ts` | ドラッグ中の移動先に仮ノードを差し込んだレイアウト用の木と、運んだトピックのルートの矩形からレイアウト別の幾何で合流先を決めるスロット判定 | 純粋 TypeScript |
| `src/ui/inline-editor.ts` / `link-suggest.ts` | インライン入力とノート候補 | DOM、候補取得時の Obsidian API |
| `src/core/embed.ts` / `map-keys.ts` | 埋め込み（M10）の純粋な部分: 原文からのマップ識別と `mappy-layout`（キーは `map-keys.ts` で cache 側と共有）、`#見出し` の区画解決（Obsidian の `stripHeading` に準じた正規化と最初の一致）、埋め込みが描く木、開いた時点の折りたたみ、可視ノード。項目が埋め込み 1 つだけかの判定（`embedOnlyTitle`、M12） | 純粋 TypeScript |
| `src/core/calls.ts` | マップの中の呼び出し（M12）の投影: 呼び出し先の木を現在の木に継ぎ足す `projectCalls`（`callerId/nodeId` の id、各ノードの出所 `CallSource`）、開いた時点の折りたたみ `initialCallFolds` | 純粋 TypeScript |
| `src/obsidian/embed-target.ts` | マップノートの判定 `isMapNote`（metadataCache の `mappy: true`。埋め込みと検索で共有）と、`.internal-embed` の `src` からのマップノートと見出しパスの解決（`parseLinktext`、`getFirstLinkpathDest`） | Obsidian の公開 API |
| `src/obsidian/map-search.ts` | コマンド「マップを検索して呼び出す」の検索 UI（M12 の入力側）: 他のマップノートを候補にした `FuzzySuggestModal`。候補の列挙 `listMapNotes`、検索文字列 `searchText`、選んだファイルを返すだけで書き込みは持たない | Obsidian の FuzzySuggestModal、Vault、metadataCache |
| `src/obsidian/map-calls.ts` | 呼び出し先の読み取り `CallReader`（M12 の表示側）: `![[…]]` だけの項目を `resolveEmbedTarget` で解決し、`DocumentStore` で読んで（開いているエディタ優先）パスごとに 1 度だけ解析し、前回の解析を同一性の基準にする。view と Excalidraw 挿入が共有 | Obsidian の公開 API、DocumentStore |
| `src/ui/map-embed.ts` / `edge-layer.ts` | post-processor（`MapEmbeds`）と、区画の寿命に合わせた読み取り専用のマップ（`MapEmbed`: `MarkdownRenderChild`、M10）。線の差分描画 | Obsidian MarkdownRenderChild、MarkdownPostProcessor |

Markdown parser は原文の UTF-16 offset を得られる `@lezer/markdown` を採用した。通常の Markdown を構文解析し、frontmatter と Obsidian コメントを補助処理する。製品コードはブラウザ互換にし、Node/Electron や非公開の Obsidian parser を使わない。ランタイム依存は package.json で固定し、バンドルの実測値とハッシュは各ビルドの `dist/build-info.json` と証跡で追う。モバイル互換性は設計上の条件であり、実機では未確認。

## 3. Markdown とノードの対応

H2＋箇条書きの形式と、従来の見出し形式を実装している。文書直下に H2 以外の見出しがある場合は `format: 'headings'`、H2 だけ・見出しなしの場合は `format: 'list'` とする。コード・引用・コメント・frontmatter の偽見出しは判定に使わない。編集検証では必要に応じて既存の形式を指定して再解析できる。

解析上はファイル名の仮想ルートを持ち、その直下に最上位区画（見出し形式では最上位の見出し、リスト形式では H2 と、最初の H2 より前の文書直下のリスト項目）を並べる。表示は `projectMap` で本体とフリートピックに分ける（M7）。文書が見出し区画で始まればその区画が本体、後ろの最上位区画はフリートピック。見出しのない文書は仮想ルートのまま。最初の H2 より前に文書直下のリスト項目がある文書は、仮想ルートを本体（そのリスト項目だけを子として見せる）にし、すべての H2 区画をフリートピックにする。この分割は表示だけであり、ノードの範囲・親子・ID は変えず、コマンドは従来どおり `doc.root` の木に対して動く（H2 の兄弟追加は文書末尾寄りの新しい最上位区画になる）。表示のために原文を足し引きしない。リスト形式では、文書直下の BulletList を直前の H2 配下へ、H2 より前のリストを仮想ルート配下へ置く。

フリートピックの位置は frontmatter `mappy-topics` に、見出しの文をキー、レイアウト名をサブキーとして `[x, y]` で持つ（`src/core/topics.ts`）。座標は本体ルートのノード左上を原点とするレイアウト座標で、トピックのルートのノード左上を指す（`LayoutResult.origin`）。Mappy は flow 形式 `見出し: { mindmap: [x, y], timeline: [x, y] }` を 1 行ずつ整数で書き、YAML や自前の読み取りが誤読し得るキー（`:`・`#`・`[` を含む、数値や真偽値に見える、空、先頭が記号）は二重引用符で囲む。読み取りは `src/core/yaml-lite.ts` の YAML サブセットで、Obsidian の Properties が書き直す block 形式と引用符付きキーも受け付け、孤児キー・不正値は無視する。書き込みは `mappy-topics` の行だけを差し替え、他のキーはバイト保持、frontmatter がなければ作り、最後の項目を除いて他のキーが残らなければヘッダーごと取り除く。存在しない見出しのエントリは読めた限り残す（Markdown 側で改名を戻せば位置も戻る）。キーは `topicKeys(doc): Map<nodeId, key>` の 1 か所で導出する（LEV-86）: 原文順の n 番目の同名トピックが `<見出し>`、`<見出し> (2)`、`(3)`… を使い、その文字列が別の最上位見出し（他のトピックか本体のルート）と重なるときは使われていない最小の番号にする。読み（view の `topicLayouts`、埋め込みの `embedTopicLayouts`）も書き（`planTopicMoves` は node id 渡し）もこれを通し、view は見出しの文で引かない。構造を変える編集（`rename`・`delete`・`move`／`reparent`・`move-up`／`move-down`・`detach`・`add-sibling`・`add-topic`）は `commands.ts` の `withTopicKeys` が、編集前後のトピックを原文順で対応させて（動かす node と着地点は別扱い）キーが変わった項目を `planTopicRekey` で同じ編集セットで付け替える: 1 つ目の同名トピックを改名・削除・合流させると 2 つ目の `(2)` が `<見出し>` に繰り上がり、⌥↑↓で同名の 2 つを入れ替えると項目も入れ替わる。本体とトピックが入れ替わる編集（最初のトピックの ⌥↑）は対応が取れないので frontmatter を変えない。最上位区画に触れない編集（リスト項目の追加・削除・移動）は `touchesTopLevel` で除き、再解析しない。キーは 1 行の YAML なので複数行の Setext 見出しの位置は書かない（拒否する）。metadataCache の値から読む場合は `topicPositionsFromValue` を使い、開いているエディタの原文を正とする経路は `readTopicPositions` を使う。入れ子は Lezer の ListItem 構造に従い、タブを含むインデントを独自の行正規表現だけで推測しない。OrderedList とタスク項目、およびその下位は原文を保持してノード化しない。

```markdown
---
mappy: true
---
## 講座

講座全体の説明。

- 回復する
  参考: [[睡眠ノート|睡眠]] と [資料](https://example.com)
  ![[図.png]]
  - 休息の取り方
    この本文もノードと一緒に保持する。
```

`mappy: true` はマップの必須識別子である。文字列 `"true"`、`false`、`mappy-layout` だけのノートは対象にしない。`mappy-layout` は任意の初期表示設定で、`timeline` ならタイムライン、`hierarchy` なら階層図、`balanced` なら左右バランス、それ以外と省略時は通常マップにする（値の一覧は `src/core/layout-mode.ts` の `LAYOUT_MODES` が唯一の定義で、frontmatter・view state・レイアウトボタン（`Record<LayoutMode, …>` で網羅を型検査）・Excalidraw 挿入はすべてそれを使う。`layout.ts` からも再 export する）。新規作成・マインドマップ化・解除と、レイアウトボタンによる明示選択だけが frontmatter を書く。タイムライン・階層図・左右バランスの選択は `mappy-layout` にその値を保存し、通常マップ選択はキーを削除する。閲覧・折りたたみ・ズーム・Excalidraw への挿入では書かない。旧 `mappy-layout` 単独ノートは自動で取得せず、明示的なマインドマップ化で旧レイアウトを引き継いで `mappy: true` を追加する。新規作成と、`mappy-layout` を持たないノートのマインドマップ化が書く値は設定「新規マップの既定レイアウト」（M14、既定は通常マップ＝キーなし）で、既存ノートの読み取り（`readMapLayout`）は設定を見ない。ファイル・レイアウト・viewport は各 leaf の view state で扱い、選択と折りたたみはビュー内の一時状態として保持する。

- ATX 見出し、Setext、frontmatter、フェンス、空行、CRLF、末尾改行、引用、コメントを fixture で扱う。初期に編集未対応の構文は表示または source 編集へ誘導し、推測で変更しない。
- 不明な記法は原文の範囲として保存する。本文を AST 全体から再生成しない。
- 従来の見出し形式で深さが飛ぶ場合は、直前の小さい深さの見出しへ接続する。原文は自動修正しない。
- 同名見出しがあるため、タイトルや配列の位置だけをノード ID にしない。セッション内 ID と原文範囲、編集差分を対応付け、外部全変更では一致する部分を再対応する。曖昧なら選択を解除し、古い ID で書き込まない。最上位区画（本体ルートとフリートピック）は、見出しと区画の原文（見出し行から区画の終わりまで、末尾の空行は除く）が変わっていなければ同名でも ID を引き継ぐ（`assignIds`、LEV-86。フリートピックの移動は frontmatter しか変えないので、同名トピックの 2 つとも ID と選択が残る）。原文が同じ区画が複数あれば順序で対応させる（区別できないので同じこと）。原文が変わった同名区画は推測しない。
- 従来の見出し形式だけは最大深さ6を、移動後の子孫も含め検証する。リスト形式にはこの上限を設けない。

リスト項目の `from` はインデントを含む行頭、`headingTo` は最初の行末、`titleFrom/titleTo` は最初の行のテキストを表す。`to` は ListItem の最終行の末尾で、直後の改行は含めない。子リストの後にある親の文章を、子の `to` に含めない。直接本文は初行改行後から最初の子の行頭までとし、子がなければ ListItem の末尾まで。本文がない葉では `bodyFrom/bodyTo` を `to` の空範囲にする。

`node.list` にマーカー前の生のインデント、`-` / `+` / `*` のマーカー、継続本文の必要列数に相当する空白列を保持する。本文画面へ渡す際にはコンテナのインデントだけを除き、保存時に戻す。本文編集・リンクや画像の追記はその原文範囲だけを変更し、周囲のノード構造を再解析して確認する。最初の子より後の親の文章は保持するが、直接本文の編集 UI には含めない。

旧見出し形式からの変換は `planListConversion` で見出しの範囲と本文各行へのインデント挿入だけを計画し、DocumentStore の通常経路から保存する。変換後のタイトル・件数・親子関係を照合する。本文内の箇条書きで余計なノードが増える場合や複数行 Setext など、安全な変換ができない場合は拒否する。閲覧時の変換は行わず、明示操作後は同じマップ履歴で Undo できる。

## 4. 同期・保存・Undo

**通常の MarkdownView＋マップ ItemView の分割**と同じ leaf での切り替えを実装している。分割先には標準 Undo と標準リンク補完のある公式 Editor を使う。マップ内の textarea と履歴は別に管理する。ノート種別 `.md` のグローバルな登録は置き換えない。

### Markdown → map

1. 対象ファイルの `editor-change` から保存前のテキストを取得する。metadata cache はリンク解決の補助であり、編集中原文の正本にしない。
2. `editor-change` と対象ファイルの変更通知を 45ms の debounce でまとめる。
3. ビューの更新世代を読込前後で確認し、ファイルや世代が変わった非同期結果を破棄する。
4. ノード ID で DOM を差分更新し、選択と viewport を保つ。毎回 Fit を実行しない。

### map → Markdown

1. コマンドは解析時の文書から UTF-16 の原文範囲と置換テキストを生成する。保存時には差分とともに期待する元文書を渡す。
2. キューをファイル単位に直列化し、最新バッファが期待原文と完全一致することと、差分範囲の妥当性を確認する。
3. 開いているエディタには一つの `Editor.transaction` で適用する。未保存バッファがある状態で Vault へ直接書かない。
4. エディタがない場合のみ、`Vault.process` のコールバック内で期待原文を検証して差分を適用する。読み取りと書き込みの間で更新されても古い内容を押し戻さない。
5. 自分の変更も最新の原文として観測する。外部変更を検出したら古いマップ履歴を捨て、通知を無条件に無視しない。
6. 競合したら古い原文で上書きせず、インライン入力のドラフトとエラーを残す。自動マージはせず、必要な入力を保持したうえで更新後のノードを編集し直す。

複数 MarkdownView が同じファイルを開いた場合は、バッファが一致することを確認する。一つに transaction を適用して共有バッファへ伝播済みなら次への適用を省き、独立バッファなら変更前原文が一致するエディタへ適用する。内容が不一致なら自動変更を止める。この分岐をモックで検証しているが、別ウィンドウを含む実機の組み合わせは引き続き確認する。

### 表裏切り替えの検証課題

`ItemView` はファイルの自動保存・Undo をそのまま引き継ぐわけではない。切り替え実装では対象ファイルと選択ノードの原文位置から Markdown を開く。切替時の未保存内容、選択位置、Ctrl/Cmd+Z の送り先、エディタが閉じた場合の履歴は M2 の実機受入条件として残す。

マップ操作はファイルごとに最大50件の前後原文・差分・逆差分をセッション履歴に保持し、Undo/Redo も現在原文を照合して適用する。Markdown 側の編集や外部変更を観測すると履歴を破棄する。標準エディタとマップの履歴を完全に統合したものではなく、プラグイン再読込後の履歴も永続化しない。

`TextFileView` も候補だが、`requestSave` の遅延保存と標準エディタの保存が競合し得るため初期の保存主体にしない。この点は「表裏切替が自動的に安全になる API がある」と仮定しない。[公式 API 型定義](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)

## 5. 描画・リンク・画像

HTML ノード＋SVG 接続線を一つの変換レイヤーに配置する。ノード ID と描画内容のキーで DOM を再利用し、描画後にまとめてサイズを読み取って座標を書き込む。現在は可視ノードを計測して全体を配置するため、枝だけを再配置する最適化は未実装。

ノードの表示は `MarkdownRenderer.render(app, markdown, el, sourcePath, component)` を使う。`sourcePath` は元ファイルで、component はノードの描画寿命に合わせる。差し替え時は古い描画を破棄し、関連 component・イベントも解放する。[ライフサイクル管理](https://docs.obsidian.md/plugins/guides/lifecycle-management)

内部リンクは `openLinkText`、解決は `getFirstLinkpathDest`、作成は `generateMarkdownLink` を境界へまとめる。クリックではリンクを優先し、ノードドラッグへ伝播させない。見出し／ブロック参照、別名、空白、日本語を検証する。画像追加は添付先を Obsidian の設定から取得し、重複を避けて保存する。ローカル画像を初期の受入対象とし、外部画像の読込方針・エラー表示は M3 で明文化する。[公式 API 型定義](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)

本文全部を常に全ノードへ描画せず、ノードのテキストと直接本文内のリンク・画像を表示する。通常の文章は右クリックの本文編集から扱う。画像読込とビューのサイズ変更で再配置する。描画の差し替え時には古い Component を解放する。

表示ルートの ID で濃い面のルートを判定し、その直接の子は枠付き、下位は平文にする。H2 がルートの場合も同じ基準を使う。フリートピックのルートも濃い面（`is-root` に `is-topic` を併記）で、その直接の子が枠付きになる。線はノード領域の左右中央へ接続し、文字の下へ伸ばさない。通常マップも直角線にし、親から共通の幹を伸ばして分岐点から子へ接続する。現在の通常マップの横間隔はルート80px・下位56px、兄弟の縦間隔は22pxとし、タイムラインとは別の寸法を使う。

`LayoutResult.folds` に開閉操作の中心座標を返し、renderer が分岐点にボタンを配置する。展開中はボタンの領域へカーソルを合わせたとき、またはキーボードフォーカス時に丸い − を表示する。折りたたみ件数には直接の子だけでなく隠れる子孫をすべて含める。数字の桁数で変わるバッジ幅とヒット領域の寸法を layout と renderer で共有し、枝間の余白と Fit の bounds に含める。閉じた枝にも開閉座標を残す。

`layoutTree` は本体を原点に配置したうえで、各フリートピックを同じモードの独立した木として配置する。位置があるトピックは `origin + 位置` に置く（他のノードと重なっても利用者の指定を優先する）。位置がないトピックは本体の bounds の下に原文順で積み、配置済みのどの矩形（開閉ボタンを含む）とも重ならない最初の空きに置く。列はマップとタイムラインでは本体の左端に揃え、階層図と左右バランスでは本体の左端が最も広い段や左側の枝の端になり得るためルートの中央に揃える。Fit の bounds は本体・トピック・開閉ボタンすべてを含む。ドラッグ中の仮ノードは移動先を含む木（本体または一つのトピック）だけを組み替える。Excalidraw への挿入（`sceneContents`）は本体のみで、フリートピックを含めるかは M7 の残項目。

大規模化は、差分更新 → 折りたたみ → 可視領域外 DOM の省略の順に検討する。Worker や WebGL は、計測で必要性が出た段階で判断する。

### 5b. 埋め込み表示（M10）

別のノートの `![[マップノート]]`／`![[ノート#見出し]]` を読み取り専用のマップとして描く。`registerMarkdownPostProcessor` を 1 つ登録し（`src/main.ts`）、post-processor `MapEmbeds.process` は同じ区画を 2 つの経路で見る。

1. **ホストの区画（閲覧モード・ホバープレビュー）**: 区画の `.internal-embed` の `src` を `resolveEmbedTarget` で解決し、`mappy: true` のノート（cache で判定。文字列 `"true"`、Excalidraw、`.md` 以外、ブロック参照 `#^id`、自分自身は対象外）なら、Obsidian がノートを読み込む前に placeholder の span を `div.mappy-embed.mappy-view` に差し替える。Obsidian の読み込みが先に走って span に内容や `is-loaded` が付いていた場合は差し替えず、2 の要領で claim する（span の中の Obsidian の Component は区画と一緒に解放される）。
2. **埋め込み先の区画（ライブプレビュー）**: ライブプレビューではホストの段落は CodeMirror の widget で区画にならず、Obsidian が埋め込み先のノートを `.internal-embed.markdown-embed` の中に描いたその区画が post-processor に届く（`ctx.sourcePath` は埋め込み先）。`ctx.sourcePath` のノートがマップで、区画が DOM に付いた `.internal-embed` の中にあれば、その容器を 1 度だけ claim する: `mappy-embed-host` を付けて Obsidian の内容を CSS で隠し（`.internal-embed.mappy-embed-host > :not(.mappy-embed)`）、`markdown-embed`／`inline-embed` を外して同じ枠を末尾に足す。枠は区画の外（容器）にあるので、Component の `containerEl` には区画の中に置いた隠しの anchor（`mappy-embed-anchor`）を使う（Obsidian は `containerEl` が区画から外れたときに unload するため）。区画は document に付く前に届くことがある（Obsidian 1.6.7 の実機では、画面内の埋め込みは区画が届いてから容器が付くまで 17〜28 ms、画面の下の埋め込みはスクロールで画面に入るまで付かない（2.5 s の例）。開いた直後は埋め込みを 2 回描き、1 回目は付かないまま捨てられる。LEV-64／LEV-91）。届いた区画が未接続なら、区画の中に隠しの anchor（同じ `mappy-embed-anchor`）を置いて `PendingClaim`（`MarkdownRenderChild`。`ctx.addChild` で区画の寿命に乗せる）とし、その document に 1 つだけ置く `MutationObserver`（`documentElement` の `childList`＋`subtree`。待つ区画がある間だけ接続）が DOM の変化のたびに待っている anchor の `isConnected` を見て、付いた時点で容器を claim する。polling はしない（`IntersectionObserver` は Chromium 153 で未接続の target にも初回の entry を届け、hidden の anchor は接続されても 2 回目が来ないので使えない）。待ちは `EMBED_CLAIM_HOLD_MS` = 60 s の間はプラグインが強く保持し、その後は `WeakRef` で Obsidian が区画（の Component）を保持している間だけ待つ: 画面の下の埋め込みは何分後にスクロールしても claim され、捨てられた描画は Obsidian が unload するか GC で消える。unload された区画・プラグインの unload 後（`dispose` が待ちの区画をすべて settle し、observer を切る）は claim せず、anchor もタイマーもリスナーも残さない。load されない Component に渡された区画（他プラグインの `MarkdownRenderer.render`）も同じ経路で待ち、claim される。接続された区画が `.internal-embed` の外（ノート自身の閲覧モード）、マップの中（あとから描かれたノードのタイトル）、claim 済みの容器の中なら何もしない（`el.closest` で区画から上をすべて見る）。1 フレームだけ見直していた頃は埋め込みが多いノートほど接続が間に合わず、30 フレームの上限では画面の下の埋め込みに届かず、通常の埋め込みが残った（LEV-91）。マップ自身のノードの中で描かれた区画（`.mappy-view` の内側）と、claim した容器の中に残る Obsidian の描画は対象にしない。通常ノートの埋め込みの中にあるマップの埋め込みは（Obsidian がその通常ノートを描くときに）描く。

描画は既存の `NodeRenderer`（`sourcePath` は元ノート。リンク・画像は元ノート基準）、`layoutTree`、`fitToBounds` を使い、view の編集・ドラッグ・パン／ズーム・履歴は持ち込まない。元ノートの原文は `DocumentStore.read`（開いているエディタのバッファを優先）で読み、`mappy: true` と `mappy-layout` は cache ではなくその原文から読む（`readMapFromSource`）。`![[ノート#A#B]]` は Obsidian の `[[ノート#A#B]]` と同じく、文書順で最初に A に一致する見出し、その区画の中で最初に B に一致する見出しに解決する（`findSection`。正規化は `stripHeading` に準じて `:#|^\` と `%%`・`[[`・`]]` を空白にし、連続する空白を 1 つにして大文字小文字を無視する。リスト項目は見出しではない）。見出しが見つからない場合とノートがマップでなくなった場合は枠の中に一文を出す。枠の高さは既定 320px（`--mappy-embed-height`）で、配置後に全体を Fit し、1 倍を超えて拡大しない。開いた時点でルート直下より下の枝をすべて折りたたみ（`initialFolds`）、開閉ボタンで一段ずつ開ける。折りたたみは枠内の一時状態で原文を変えない。元ノートの `editor-change`（別 leaf の未保存の編集）・`modify`・`rename`・`delete` で 45 ms の debounce の後に再読込し、読者の折りたたみは残し、新しく現れた枝は折りたたむ。枠の中に一文を出す間も最後に描いた文書は保持し、マップに戻ったときノードの同一性と折りたたみを引き継ぐ。枠の大きさが変わったときは Fit だけをやり直す（配置は変えない）。右上のボタンで元ノートを開く（`openLinkText`。`mappy: true` のノートは §8 のルーティングでマップになる）。クリックの解釈（内部リンク・ノード・開閉ボタン）は view と同じ `mapClick`（`map-events.ts`）で、埋め込みは開閉とリンクだけに応える。

Component は `MarkdownRenderChild` で `ctx.addChild` に渡し、区画が差し替えられたとき・ホストを閉じたとき・ポップオーバーが閉じたときに Obsidian が unload する。unload で rAF・タイマー・`ResizeObserver`・vault／workspace のイベント（`registerEvent`）・`NodeRenderer` の MarkdownRenderer の Component を解放し、ホスト側の DOM を元に戻す（閲覧モードは placeholder の span、ライブプレビューは容器のクラスと内容）。`MapEmbeds` は生きている埋め込みを持ち、プラグインの unload で全部を解放し、その枠を含んでいた閲覧モードの view（`containerEl.contains(frame)` で選ぶ。パスでは入れ子や埋め込み先の区画を取り違える）を `previewMode.rerender(true)` で描き直す。解放後は post-processor もフレームの見直しも何もしない。ノードのタイトルの `![[ノート]]`（画像以外）は本文の添付と同じ規則でリンクとして描くので（`transclusionsAsLinks`）、埋め込みの中で別のノートの埋め込みが描かれることはなく、循環しない。自分自身の埋め込みは Obsidian の扱いに任せる。

### 5c. マップの中の呼び出し（M12 の表示側）

map view のノードの題名が `![[マップノート]]`／`![[ノート#見出し]]` 1 つだけなら（core の `embedOnlyTitle`。前後の空白は許し、`|別名` は Obsidian が `src` から捨てるのと同じく捨てる）、そのノードを呼び出し先のルートとして、呼び出し先の本体の木を現在のマップの枝と同じ見た目・同じレイアウトで右に並べる（LEV-82。枠に縮小して描いた LEV-69 の形は本人の実機フィードバックで置き換えた）。枠も縮小もなく、呼び出した部分は読み取り専用で、選択・折りたたみ・ダブルクリックで元マップを開くことだけができる。

**投影の型（`src/core/calls.ts`、純粋）:**

```ts
/** `![[…]]` だけの項目が解決した先: 呼び出し先のノート（解析済み）と、求めた見出しパス（`#A#B`。全体なら ''）。 */
interface CallTarget { path: string; subpath: string; document: MindDocument }
/** 呼び出し元の項目の id → 呼び出し先。解決できなかった項目（マップでない・存在しない・自分自身・ブロック参照・見出しなし）は載らず、リンクのまま。 */
type CallTargets = ReadonlyMap<string, CallTarget>
/** 呼び出したマップから来たノードの出所。 */
interface CallSource {
  callerId: string;            // 呼び出し元の項目（ホストのノード id）
  path: string; subpath: string;
  document: MindDocument;      // 呼び出し先の文書
  node: MindNode;              // 呼び出し先の文書のノード（題名・本文・リンクはここから読む）
  root: boolean;               // 呼び出し元の項目そのもの（呼び出し先のルートの代わりに立つ）なら true
}
/** 継ぎ足した木: 本体ルートとフリートピック、出所（ホスト自身のノードは載らない）、id → 投影ノード。 */
interface CallProjection { roots: MindNode[]; sources: ReadonlyMap<string, CallSource>; byId: ReadonlyMap<string, MindNode> }
projectCalls(roots: readonly MindNode[], targets: CallTargets): CallProjection
/** 分割（projectMap）と継ぎ足しを合成する唯一の場所: view・Excalidraw 挿入・切り離しの原点が使う。 */
projectShown(document, targets): { split: MapProjection; calls: CallProjection }
calledNodeId(callerId, nodeId) === `${callerId}/${nodeId}`
initialCallFolds(projection): Set<string>
```

`projectCalls` は `projectMap` が分けた本体ルートとフリートピックを歩き、`targets` にある項目（題名が今も `![[…]]` 1 つだけの項目に限る。木のルート自身、つまり見出しが `![[…]]` だけのフリートピック — 未選択の「マップを検索して呼び出す」が作る `## ![[別マップ]]`（LEV-83）— も同じ規則で、`CallReader` は見出しも含む `document.nodes` を歩くので `targets` に入る）を次の複製に置き換える: 題名は呼び出し先のルート（`embedTrees(document, subpath)?.root`。全体の呼び出しなら本体ルート、`#見出し` ならその区画。呼び出し先のフリートピックは描かない）の文、子は「呼び出し先のルートの子の複製 … 自分の子」の順。呼び出し先のノードの複製は id を `callerId/nodeId` にし（同じマップを 2 回呼んでも衝突しない。文書の id は `node-N` で `/` を含まない）、`parentId` を投影の親に、`level` を呼び出し元からの深さに直し、原文範囲（`from`・`bodyFrom` など）は呼び出し先の文書のまま持つので `nodeBody(source.document, source.node)` がそのまま効く。ホスト自身のノードは `children` と `parentId` だけ差し替えた複製で id・範囲は変わらず、編集コマンドは従来どおり `doc.root` の木に対して動く。

1 段だけ: 呼び出し先のノードの複製は `targets` を見ないので、呼び出し先の中の `![[…]]` は `transclusionsAsLinks` がリンクにする（M10 と同じ）。自分自身は読み取り側が拒む（`path === hostPath`）。したがって A→A、A→B→A、A→B→C→A のどれも 1 段目のリンクで止まり、鎖の追跡を持たない。`initialCallFolds` は呼び出し先の（ルート以外の）子を持つノードすべてで、「ルートの子まで開き、それより下は折りたたんだ状態」から一段ずつ開ける。

**データの流れ（`MindmapView`）:**

```text
refresh():     store.read(host) → parseMarkdown（ローカル）→ CallReader.read(document, host.path) → targets
               → this.document と targets を同時に公開（adopt）→ draw   ※ 読み取りの待ちの間は古い文書と画面が一致したまま
recall:        metadataCache changed/deleted・vault modify/rename/delete・editor-change（ホスト以外）
               → callConcerns(file): 前回読んだノート（旧パス含む）か、いずれかの項目が今そのファイルに解決するときだけ
               → 45 ms debounce → CallReader.read → targets が変われば adopt → draw
adopt(targets): projectShown(document, targets) を (document, targets) ごとに 1 度組み、
               collapsed を byId に刈り、まだ見ていない呼び出し id に initialCallFolds を足す（折りたたみが変わる唯一の場所）
projection():  adopt が組んだ木を返すだけ（副作用なし）
draw():        visible()（投影の木を preorder、閉じた枝の下は省く）→ renderer.update(nodes, document, host.path, collapsed, { …, sources, trees })
               → scheduleLayout → layoutTree(投影の root, sizes, collapsed, mode, topics)
```

- **読み取り**は `CallReader`（`src/obsidian/map-calls.ts`）。項目ごとに `embedOnlyTitle` → `resolveEmbedTarget`（metadataCache の `mappy: true`、ブロック参照でない、存在する）→ ホスト自身を拒む → `DocumentStore.read`（開いているエディタのバッファ優先）→ その原文でも `readMapFromSource` がマップと言う（未保存の編集で `mappy: true` を失えばリンク）→ `parseMarkdown(text, basename, previous)` をパスごとに 1 度。前回の解析を同一性の基準に渡すので、呼び出し先の編集で id が保たれ折りたたみが残る。同じマップを 2 回呼んでも解析は 1 度で、投影の id が `callerId/` で分かれる。読めないノートはリンクに戻る。`targets` の各項目は `document` の参照で比べ、原文が同じなら同じ文書を返すので、無関係な cache 変更では描き直さない。
- **描画**は `NodeRenderer.update` の `appearance.sources`。呼び出したノードは題名と添付を `source.document`／`source.node` から、`sourcePath` を `source.path` にして描く（リンク・画像は呼び出し先のノート基準。M10 と同じ）。呼び出し元の項目は題名だけ呼び出し先のルートの文で、添付は自分の項目の本文（このマップで「本文・リンクを編集」「画像を追加」できるもの）をホストのパスで描く。呼び出し先のルートの本文は描かない。class は `is-called`（呼び出したマップから来たノード全部。呼び出し元の項目も）と `is-called-root`（呼び出し元の項目）、`aria-readonly="true"`（項目を除く）、`title` 属性に「呼び出し元: パス」、呼び出し元の項目の label の前に小さな `link` アイコン（`.mappy-node-call-mark`）。文字色は `--text-muted` 寄り（styles.css）。同一性キーにパスと `is-called-root` を含めるので、呼び出しが変われば描き直す。折りたたみの件数は `appearance.trees`（投影の root とトピック）で数える。
- **リンク**: `MapActions.link(link, newLeaf, nodeId)` はリンクが載るノードの id を運び、view は呼び出したノードなら `source.path`、それ以外（ホストのノードと呼び出し元の項目）ならホストのパスを基準に `openLinkText` する（「内部・相対リンクの基準は元ファイル」）。
- **読み取り専用**: `MapActions.open(id)`（ダブルクリック。呼び出したノードなら `openLinkText(source.path, host.path)` で元ノートをマップで開き true）、`NodeDragActions.readOnly(id)`（押下を始めない＝ドラッグもゴーストも切り離しもない）。view は `execute`（Enter／Tab／Delete／⌥↑↓／ドロップ）・`editTitle`（F2）・`editBody`・`attachImage`・`callMap` を呼び出したノードで Notice「呼び出したマップは読み取り専用です」と断る。ドロップ先が呼び出したノードのときは `resolveDrop` がホストの文書にそのノードを見つけないので拒み、スロットも出ない。右クリックは「元のマップを開く」「折りたたみ」と履歴だけ。Space と開閉ボタン、矢印キーは投影の木で動く（`MapEvents` は矢印を `visible()` のノードで辿る）。呼び出し元の項目自体は通常のノード: F2 は原文 `![[…]]`、Enter／Tab／Delete／ドラッグは同じ差分で、Delete で呼び出した木ごと消え、⌘Z で戻る（ホストの 1 編集）。
- **選択**: `selected()` はホストの id ならホストの文書のノード（編集は原文の題名を使う）、呼び出しの id なら投影のノード。「Markdown に切り替え」のカーソルは、呼び出したノードが選ばれていればその呼び出し元の項目の位置。
- **ドラッグの事前表示**: `previewTree(root, command, collapsed)` は投影の木から組み直すので、ドラッグ中も呼び出した枝が消えない。`resolveDrop` の `index` はホストの子の中の位置なので、移動先が呼び出し元の項目なら view が呼び出し先のルートの子の数だけずらして仮ノードを置く。切り離しの原点（`originFor`）も `projectShown` で測る。フリートピックの位置（`mappy-topics`）は見出しの原文（`split.topics` の題名）をキーにし、`## ![[Map]]` のトピックでも呼び出し先のルートの文をキーにしない。
- **書き出し**: SVG／PNG は DOM をそのまま読むので、呼び出したノードは通常のノードとして入る（LEV-69 の `serializeFrame` はなくなった。LEV-73 はこれで解消）。Excalidraw は `sceneContents(document, collapsed, calls)` が同じ `projectCalls` で継ぎ足し、`SceneNodeContent.sourcePath` でノードのリンクと画像を呼び出し先のノートから解決し、呼び出し元の項目の要素は呼び出し先のノートへリンクする。`ImportRequest.calls` は view の `snapshot()` が渡す。Markdown view からの挿入（`calls` なし）は bridge が `CallReader` で自ら読み、呼び出し先を開いた時点と同じ折りたたみ（ルートの子まで）で入れる。
- `nodeOf` はそのキャンバスの中でターゲットを含むノード要素。map view のノードは入れ子にならない（題名の `![[…]]` はリンク、M10 の枠は閲覧モードの区画にしかない）。`MapEmbed`（M10）は変えず、`nodeEmbeds` はなくなった。

2,000 ノードのマップを呼んでも解析は 1 度（数十 ms）、投影は変更ごとに 1 度で、描くのはルートの子までなので現在のマップの操作は止まらない。

再検討する条件: 呼び出し先のフリートピックを描くか（今は本体の木だけ）。呼び出し先のルートの本文（添付）を項目に描くか（今は項目自身の本文だけ）。右上のポップオーバー（LEV-81）の「マップを検索して呼び出す」は呼び出したノードが選ばれていると `callMap` が同じ Notice で断る。Obsidian が公開 API で埋め込みの種類を登録できるようになった場合（`embedRegistry` は非公開）。

## 6. 操作とズーム

パン・ズームは transform を更新し、構文解析やツリー再配置を呼ばない。キャンバスに専用の上部・下部行を割かず、左下にレイアウト切り替え、右上に歯車 1 つのポップオーバー（view 自身の要素。Markdown に切り替え／マップを検索して呼び出す／書き出す の 3 項目だけで、ノードの操作はキー・右クリック・コマンドパレットに置く。`src/main.ts` の経路（検索・書き出し）は `MapMenuAction` の配列としてコンストラクタで受け取り、view は `app.commands` を呼ばない。Obsidian の `Menu` は右端で画面外に出るので使わず、ペインの中に絶対配置して幅を `min(320px, ペイン幅 − 余白)` に抑える）、右下に現在倍率・±・Fit・100% を浮かせて置く。倍率の上限は3.0、下限は長い文書を Fit できるよう 0.000001 としている。表示倍率と手動ズームで同じ制限を共有し、Fit 後の最初の操作で倍率が跳ねないようにする。

ポインター p、平行移動 t、倍率 s に対してワールド座標は `w = (p - t) / s`。倍率を s' に変えた後の平行移動を `t' = p - w * s'` とし、ポインター直下の点を固定する。画面外オフセット、devicePixelRatio、popout を含めてテストする。

背景ドラッグと二本指スクロールをパン、ピンチと修飾キー付きホイールをズームにする。`preventDefault` はマップが処理する範囲のみ。IME の `isComposing` / composition イベント中は構造変更キーを発火しない。マップの roving focus と編集入力を分離し、ノード上だけで Enter/Tab/Delete を扱う。グローバル既定 hotkey を登録しない。ただし Obsidian のキーマップは `window` の capture 段階で active view の `Scope` を自分のホットキーより先に評価し、既定ホットキー（F2 = `workspace:edit-file-title`。LEV-74 より前は map が非 navigation だったため `checkCallback` が map が active でも真になり、直近の Markdown タブのタイトル改名を始めた）と重なるキーはキャンバスのリスナーに届く前に消費される。そのため map view は `Scope`（親 `app.scope`）に修飾キーなしの F2 だけを登録する。フォーカスが map view の中（`contentEl`）にある間は F2 はマップのキーで、キャンバス上では `MapEvents.hotkey()` がキャンバスのリスナーと同じ判定で選択ノードの編集を開き、inline 入力の中や浮かせたボタンの上では何もせず、どちらも `false`（Obsidian が `preventDefault`＋`stopPropagation` する）を返して既定ホットキーを動かさない。フォーカスが view の外にあれば `undefined` を返して辞退する（Obsidian 1.14.2 の `Scope.handleKey` はキー指定のハンドラが `undefined` を返しても親 scope を見ないので、map leaf が active な間は F2 のユーザー割り当ても発火しない。これは Obsidian 側の実装で、view はそれに依存しない）。Scope は workspace が毎回 `view.scope` を読むだけなので登録解除は要らない。F2 以外のマップのキーは scope に登録せず既定ホットキーとも重ならないので、ユーザーの割り当ては editor と同じく優先される。マップのキーは修飾キーなしで、Shift 付き（Shift+Tab のフォーカス移動、Shift+Enter など）は扱わない。⌘Z／⌘⇧Z と ⌥↑／⌥↓ だけがコードである。map view は `navigation = true`（LEV-74）。ノートを開く view は Markdown editor・Kanban・PDF と同じく navigation view にするのが API の規則で、既定の false（ファイルエクスプローラーのような静的 view）のままだと Obsidian 1.14.2 は非 navigation の active leaf を「現在のファイルではない」と扱い、`getActiveFileView()`（コアのファイル系コマンド、`getActiveFile()`、`file-open`）と workspace の window `keydown`（修飾なしの Escape）を「直近の navigation な leaf」に解決していた（inline 入力のないノードで Escape を押すと active leaf とフォーカスが隣の Markdown タブへ移り、コアコマンドが隣のノートを対象にする。`artifacts/lev-48-f2-scope` の G5）。true にした結果: (1) Escape で leaf は移らない（workspace は active leaf が navigation なら何もしない。inline 入力・ポップオーバー・ドラッグの Escape は従来どおり map 自身が `preventDefault`＋`stopPropagation` で閉じる／取り消す）。(2) map が active な間 `getActiveFileView()`／`getActiveFile()` は null（map は ItemView で FileView ではない）なので、`workspace:edit-file-title`・`workspace:copy-path`・`app:delete-file`・`file-explorer:move-file`・`open-with-default-app:*` などコアの 12 コマンドは隣のノートを対象にせず「対象なし」になる。`file-open` も null で発火し、アウトライン・バックリンク・プロパティのサイドバーは map の間は空になる（隣のノートを出していた従来より正しいが、map 自身のノートを出すには FileView 化が要る。LEV-89）。F2 の `Scope` は既定ホットキーの `checkCallback` が偽になるので必須ではなくなったが、FileView の区別に依存しないことと F2 のユーザー割り当てを map の中で受けないことのために残す。(3) `getLeaf(false)`（`getUnpinnedLeaf` → `canNavigate()`）が map 自身の leaf を返すので、map の中のリンク・呼び出したノードのダブルクリック・ファイルエクスプローラー／クイックスイッチャーの選択は Markdown タブと同じく **その leaf を置き換える**（従来は隣の Markdown タブか新しいタブ）。⌘クリックは従来どおり新しいタブ、ピン留めした map は置き換わらない。(4) leaf の戻る／進むの履歴に map の状態が載る: Markdown → map、map → 別のノート（`setState` はノートが変わったときだけ `result.history = true` を返す。FileView と同じで、レイアウト・viewport だけの変更は載せない）。`app:go-back`／`go-forward`（⌘⌥←／→）が map で有効になる。(5) `getActiveViewOfType(MindmapView)` を使う本プラグインのコマンドは変わらない。「新しいマインドマップを作成」の「現在のファイルと同じフォルダ」は map が active なら map のノートを基準にする（`activeFile()`。`getActiveFile()` だけでは null になるため）。(6) navigation view が受け取る ephemeral state を実装した: `subpath`（リンクの `#見出し`／`#^ブロック`。同じノートの `[[#見出し]]` も map の leaf で開くようになったため）は core の `locateSubpath`（Obsidian 1.14.2 の `resolveSubpath` の規則を原文に対して適用。見出しは句読点を空白にして大文字小文字を無視、`#A#B` は順に深い見出し、`^id` は行末、コード・HTML・コメントの中は数えない）でオフセットにし、そのオフセットを含む最も内側のノードを選択して見せる（editor が見出しへスクロールするのと同じ）。`focus`（`setActiveLeaf(leaf, { focus: true })`: コマンドで開いた・タブを押した・履歴で戻った）は選択ノード（なければキャンバス）にフォーカスを置き、inline 入力中は動かさない。`selection`（`getEphemeralState()` が返す選択ノードの位置と文。id は解析ごとに振り直されるので使えない。実機で見つけた）は戻る／進む・タブの複製で選択を戻し、フォーカスが view の中にあれば `focus` も返してキーが戻る。(7) inline 入力中に別のノートがこの leaf に入る（リンク、エクスプローラー、⌘⌥←）ときは `setState` が先に下書きを保存する（`InlineEditor.flush()`。Markdown タブがバッファを保つのと同じ。E05 の拒否は Notice で伝え、下書きは残せない）。(8) サイドバーに移した map は Bases と同じく静的（`syncNavigation`: `leaf.getRoot()` が `leftSplit`／`rightSplit` なら `navigation = false`。`onOpen` と `layout-change` で読む）で、エクスプローラーの選択がそこに入らない。履歴の戻る／進むが渡す `popstate` の状態は §8 のルーティングが素通しする。

ノードのドラッグは pointer イベントによる自前実装（`src/ui/node-drag.ts`）で、HTML5 の drag and drop は外部からの画像ファイルの添付だけに使う。ノード上の押下から 4px 動いた時点でドラッグを始め、クリック・ダブルクリック・リンク・開閉ボタン・インライン入力には触れない。ドラッグ中はノードの DOM を複製した半透明のゴーストをキャンバス座標で追従させ（ズーム倍率は矩形と `offsetWidth` の比から得る）、元のノードは薄く残す。位置判定は表示中のレイアウトに対して `elementFromPoint` で行い、ノード矩形の上下各 30% を兄弟の前後、残りを子の末尾、タイムラインの第一階層だけは左右で判定する。判定結果は core の `resolveDrop` に渡し、自分自身・子孫・仮想ルート直下のリスト項目・H6 超過なら何も表示しない。受け付ける場合は view が `previewTree`（`src/layout/drop-preview.ts`）で移動先の枝だけを組み替え、ドラッグ中ノードと同じ大きさの空の仮ノードを差し込んで再配置する。既存の兄弟はその分だけ避け、仮ノードへの接続線を太い丸い青線として描く。仮ノードを差し込むとポインターの下でレイアウトが動くため、仮ノード・元ノード・余白の上では現在の判定を保ち、別のノードへ切り替えるのは直前の切り替えから 8px 以上動いたときだけにする（ヒステリシス）。ドロップは最後に表示した位置の `move` コマンド（親 ID と、移動ノードを除いた兄弟内の位置）を実行し、Escape・pointercancel・キャンバス外での離しは取り消す。`move` は両形式で「移動元の行を取り除き、隣接する兄弟の深さ・インデントに合わせて挿入し、再解析した木の形が移動をシミュレートした木と一致する」ことを検証してから差分を返す。

マップ上の木のルート（`projectMap` の本体ルートと各トピックのルート）は「自由に動くノード」として別扱いにする（`NodeDragActions.free`）。ゴーストは作らず、押下からの移動量（screen px）を view に渡し（`shift`）、view は `LayoutResult.origin` 基準の開始位置＋移動量／倍率を `topicLayouts` の一時的な位置にして毎フレーム再配置するので、木全体（子・線・開閉ボタン）がポインターに追従する。動いている木のノードには `is-drag-moving`（`pointer-events: none`）を付け、`elementFromPoint` の判定は従来どおり続けるので、ノードの上では仮ノード＋青線のスロットが出る（このときトピックのルートは `is-merging` で平常のノードの見た目になる）。ポインターがノードに乗っていない間は、view の `snapTarget` が「ルートの矩形がどこにあるか」でスロットを決める（`NodeDragActions.snap`。ノードごとの判定は `src/layout/snap.ts` の `snapSlot`）: 子のないノード（または閉じたノード）の「最初の子が置かれる側」8〜72 単位・交差方向に重なる位置にルートの近い辺が来ればその末尾の子、子のあるノードの子が並ぶ線（±24 単位）に来れば並びの方向の位置で前後の兄弟。側と線はレイアウトの幾何に従う: 通常マップとタイムラインの上下の森（第二階層以下）では右側と縦の列、階層図では下側と横の段、タイムラインの第一階層では軸の中心線（左右の並び）、左右バランスでは各ノードの側（右側の枝は右と左辺の列、左側の枝は左と右辺の列。ルートの子は右列・左列それぞれの線で判定し、スロットはその側に着地する原文の index に解決する: 子の前ならその子の index、列の末尾は次の index がその側に配られるときだけ「全体の末尾の後ろ」、空の側は次の index がその側なら「ルートの隣」。view は `balancedSideOf` で第一階層の側をルートの中心との位置関係から決めて子孫に引き継ぎ、この読み取りは仮ノードなしのレイアウトごとに 1 回だけ作る（`topicDrag.index`）。子のないステージは、`placeTimeline` が森を置く側（偶数番目は上、奇数番目は下。view が配置結果の線からルート・ステージ・森を 1 パスで分ける）だけで受け付け、順位の距離は森の始まる列（ステージの中心＋20）からのずれで測る。ステージの zone はステージ自身の辺ではなく、その木が軸の周りに空ける帯の端（`axisBand`: ルートとステージの高さの最大の半分。`placeTimeline` はその 34 単位先から森を置く）から 8〜72 単位で測り、帯の端からステージ自身の辺までも zone に含める（LEV-47）。view は木ごとに `axisBand` を求め、側と一緒に `StagePlace` として渡す。低いステージが画像付きのステージの隣にあると森はステージの辺から 72 単位より離れて始まるため、辺基準では子の置かれる位置に運んでも zone に入らなかった。階層図は段が親ごと（LEV-46）なので、葉の子は葉の 32（ルート直下 48）単位下に置かれ、辺基準の zone にそのまま入る。通常マップ・左右バランスの子のない木のルート（本体ルート、見出しだけのトピック）は最初の子を右辺の `MAP_ROOT_GAP` 80 単位先に置く（枝は `MAP_BRANCH_GAP` 56 で、zone の 72 はそれに合わせた値）ので、ルートの zone は右辺の 24 単位先（80 − 56）の線から測り（`besideRoot`。`besideStage` と同じ `beyond`）、右辺の 8 手前から 96 先まで届く。左右バランスのルートの空いた列（`amongBalancedRoot`。子が 1 つのルートの左側）も同じ線で測る。着地点は線の 56 先なので、枝の着地点と同じ距離で順位を争う（LEV-90）。view は通常マップでも各木のルートに `"root"` を渡す（階層図だけが `places` を持たない）。判定はドラッグ中の「仮ノードのないレイアウト」（`topicDrag.base`。仮ノードなしのフレームごとに更新）に対して行う。仮ノードを差し込むと階層図の段は親の下で中央揃えし直され（兄弟が 72〜92 単位ずれる）、タイムラインの子のないステージは同じ側の森を避けて右へ跳ぶため、表示中のレイアウトで判定すると自分の仮ノードで判定が外れてフリッカーする。表示中のスロットは 2 倍の範囲で保ち、明らかに近い別のスロット（距離差 16 単位超）があるときだけ切り替える。ルートの矩形は DOM ではなくポインターと掴んだ位置から求める（DOM は次のフレームまで古い）。トピックを相手に重ねなくても、隣に来た時点で事前表示が出る。4 レイアウトとも同じ経路で、ポインターがノードに乗っているときはポインターの判定（重ねたときのスロット）が優先する。本体のルートのドラッグ中はどのノードにも合流しない（`resolveDrop` も両形式で本体の区画を拒否）。空白で離すと `place` → `planTopicMoves` で `mappy-topics` のそのレイアウトの項目だけを書く（位置未設定なら項目を作る。Markdown 側の改名で位置を失ったトピックは既定配置から動かした時点で新しいキーが書かれ、旧キーは孤児として残る）。スロットの上で離すと `move` コマンドで合流する。Escape・pointercancel・キャンバス外で離した場合は一時的な位置を捨てて元へ戻し、原文は変えない。

合流（区画→リストの枝）はリスト形式では `list-commands.ts` の `moveTo` が行う: 見出しの文を項目の初行にし、見出し行より後ろ（本文・画像・フェンス・入れ子のリスト）を項目の内容インデントだけ下げて、隣接する兄弟のインデント・マーカーに合わせて差し込む。本文冒頭の空行は落とし、それ以外の行はインデント以外のバイトを保つ。区画の削除と同じく末尾の区画なら区切りの空行も取り除く。`checkedMove` で「再解析した木の形が、区画を枝に移した形と一致する」ことを検証し、ずれれば拒否する。見出し形式では既存の `moveHeadingSection`（深さの付け替え）がそのまま合流になる。どちらも `mappy-topics` の項目を同じ編集セットで除き、同名のトピックが残ればそのキーを繰り上げる（`withTopicKeys`）。本体のルートは合流しない（`resolveDrop` と `moveTo` が拒否）。

切り離し（枝→区画）は `detach` コマンド。リスト形式では `list-commands.ts` の `detach` が枝の初行を `## 見出し` にし、残りの行から項目の内容インデント分だけを取り除いて（`dedent`。タブは 4 列で数え、足りない行は空白を持つ分だけ）文書末尾に新しい区画として追加する（見出しと本文の間に空行を 1 つ入れ、本文冒頭の空行は落とす）。枝の除去は `removalRange`、追加は `insertionPrefix` と末尾改行の流儀。`checkedMove` で「その枝がルート直下の最後の子になった木」と一致することを検証する。見出し形式では `moveHeadingSection` でルート直下の末尾へ動かす（深さは最後の最上位区画に合わせる）。`withTopicKeys` が離した位置を同じ編集セットで `mappy-topics` に書く（新しい区画が本体になる場合は書かない。同じ見出しの現存トピックがあれば `<見出し> (2)` のキーで書く）。UI 側では通常の木のドラッグ（ゴースト）を空白で離すと `NodeDragActions.detach(id, ゴーストの左上)` になる。押した場所の矩形＋16px 以内で離した場合と、ノード（ドロップを拒否したノードを含む）や仮ノードの上で離した場合は何もしない。スロットの事前表示は、対象ノードの矩形から 48px 以内の空白では保ち、それより離れると解除する（`leaveIfFar`）ので、遠くの空白で離せば切り離しになる。view はゴーストの左上をワールド座標に直し、枝を除いた文書を先に一度レイアウトして本体ルートの新しい位置（origin）を求め、そこからの相対位置として保存するので、新しいトピックは離した場所にそのまま現れる。

本体のルートのドラッグは、位置の原点が本体なので「本体をトピックに対して動かす」操作になる。押下時に全トピックの origin 基準の位置と viewport を控え、移動中は各トピックの一時的な位置を −移動量／倍率にし、viewport を移動量だけずらす（画面上では本体だけが動き、トピックは止まって見える）。離すと `planTopicMoves` で全トピック（位置未設定のものも既定配置の座標で）の項目を一度に書き、viewport はそのまま。Escape で viewport も戻す。トピックがなければ何も書かず、パンと同じ結果になる。

フリートピックの追加は、空白のダブルクリック（`MapEvents.addTopic`）と空白の右クリック「トピックを追加」から `add-topic` コマンド（`src/core/commands.ts`）で文書末尾に空の最上位区画を足す。深さは最後の最上位区画に合わせ（リスト形式は `## `）、末尾の改行の有無はファイルの流儀を保つ。ヘッダーがない文書では最初の見出しになるので本体のルートになり、位置は持たない。押した位置はキャンバス座標→ワールド座標→`origin` 基準に変換して view が `pendingTopic` として持ち、レイアウトにはその位置で出す。インライン入力の確定は `rename` コマンドに `position` を添え、見出しの文と `mappy-topics` の項目を同じ編集セット（履歴 1 段）で書く。Escape は既存ノードと同じく区画を残し、view 内の位置だけを保つので、後の改名やドラッグがその位置を保存する。削除（Delete／Backspace・右クリック「トピックを削除」）は `withTopicKeys` で項目の除去を区画の削除と同じ編集セットにし、Undo で区画と位置が一緒に戻る。同名のトピックが残る場合はそのキーを繰り上げる（`(2)` → `<見出し>`）。文書末尾の区画を削除するときは直前の区切りの空行も取り除き、追加→削除で原文が元に戻る（見出し形式の区画も同じ）。Undo や削除で選択ノードの DOM が作り直された場合は選択ノードへフォーカスを戻し、キーボード操作をマップに留める。

追加した空のノードはモーダルを出さず、そのノード内で編集する。リスト形式の下位には箇条書き、ルートには H2、従来の見出し形式には ATX 見出しを追加する。プレースホルダーを付けない。インライン入力中は Enter で保存、Tab で保存して子を追加、Escape で編集前のテキストに戻る。新しい空ノードを追加済みの場合、Escape は追加そのものを取り消さない。追加操作の取消は Undo で行う。

`[[` の候補は専用 textarea に対する独自 UI とし、Vault のノート・パス・別名と PNG・SVG・PDF 等の添付ファイルを候補にする。`![[` で開始したリンクは埋め込みの `!` を保つ。候補がある間は Enter/Tab を候補選択に使い、同じキーで保存や子追加まで行わない。選択箇所以外の入力を保持し、入力を閉じたら候補 DOM とイベントを解放する。見出し・ブロック候補を含む標準エディタの全補完機能を再現したものではない。

## 7. 添付画像のタイムライン

`layoutTree` の timeline モードで、第一階層を中央の水平線へ並べ、そのサブツリーを上下交互へ配置する。幹はステージの上辺または下辺の中央から伸ばし、子テキストの中央高さで曲げて左端に止める。深い枝も直角線にする。軸上の線は前のノードの右辺から次の左辺までの区間ごとに描く。

同じ側の枝は包絡矩形を使って間隔を確保し、反対側は横幅を共有する。計測と配置は明示的なスタックで処理し、深い木で再帰スタックに依存しない。長文・画像が混在する実機表示と性能は別途記録する。レイアウト単体の配置時間は `node scripts/measure-layout.mjs` が 10／100／500／2,000 ノードの fixture で 4 モードを計測し、`artifacts/layout-timing/` に記録する。

保存順序・ノード ID・編集コマンドは通常マップと共通。日時比例や工数を扱うものではなく、講座の章立てを表す配置である。レイアウト変更では初期表示用の frontmatter だけを更新し、本文を書き換えない。

## 7b. 階層図

`layoutTree` の hierarchy モード（`src/layout/hierarchy.ts`）で、ルートを上に置き、同じ親の子を同じ段（行）に揃えて下へ広げる。名前は用途（イシューツリー・ロジックツリー・組織図・WBS）ではなく形で付け、SmartArt の「階層構造」に合わせて「階層図」とする。段は親ごとに決める（LEV-46、XMind の組織図と同じ）: 子の上辺は自分の親の下辺 + 隙間で、兄弟は同じ上辺、従兄弟はそれぞれの親の下に付く。画像や本文で背の高い親はその子だけを下げ、他の枝の線は伸びない。隙間はルート直下 48px（枠付きの第一階層の高さ相当）、それ以下 32px（文字だけのノードの高さ相当。開閉ボタンの当たり判定 28px が収まる）。各サブツリーは「ノード幅・折りたたみバッジ幅・子の並びの幅」の最大を横の占有幅として持ち、兄弟は占有幅を 24px の間隔で並べる。親はその子の並びの中央に、子の並びが親より狭ければ子を親の中央に置く。占有幅が重ならない構造にしているため、長い日本語や多数の兄弟でもノードが重ならず、原文の順序がそのまま左→右の順序になる。

線は親の下辺中央から隙間の中央（バス）まで下り、子の上辺中央の真上まで水平に走ってから子へ下りる直角線で、ノードの内側や文字の下へは伸びない。幹と枝は隙間の半分ずつなので、縦線の長さは親の高さによらず一定になる（バスの高さは親ごと）。開閉ボタンは展開中はバスと幹の交点、閉じた枝ではノードの 16px 下に置き、非表示の子孫数のバッジ幅を占有幅と Fit の bounds に含める。計測と配置は明示的なスタックで処理し、深さ 2,000 の一列の枝でも再帰しない。

本体のルートは x = 0 を中心に置き（`LayoutResult.origin` はルートの左上）、フリートピックは同じモードの独立した木として本体の下、ルートの中央に揃えた列に積む。レイアウトボタン（左下の 3 つ目、Lucide の `network`）、`mappy-layout: hierarchy` の保存・復元、Excalidraw 挿入は M6 のタイムラインと同じ規則で動く。ノードには `is-hierarchy` を付け、ドラッグの兄弟判定は全階層で左右 30% にする（兄弟が横に並ぶため）。

## 7c. 左右バランス

`layoutTree` の balanced モード（`src/layout/layout.ts` の `placeBalanced`）で、ルートを中央に置き、第一階層を原文順に右・左・右・左と交互に振り分け（`balancedSide(index)`: 偶数番目が右、奇数番目が左。規則は 1 つに固定し、左右を手動で選ばせない）、以下の階層はその側へ伸ばす。通常マップの右向きの配置（`placeSideways` に `"right"`）を左向き（`"left"`）でも使い、左側は鏡像になる: 子は親の左辺から 1 隙間（ルート直下 80px・以下 56px）離れて右辺を揃え、線は親の左辺→中間で曲がる→子の右辺、開閉ボタンは左の幹（親の左辺 − 隙間/2）、閉じた枝のバッジはノードの左に出る。各側は独立した列で、その側の枝の合計高さ（兄弟間 22px）をルートの高さ中央に揃えるので、片側だけが背の高い枝を持っても反対側は動かない。ルートの開閉ボタンは右の幹に置く（第一階層があれば必ず右にある。閉じたルートのバッジも右）。`LayoutResult.origin` はルートの左上で、ルートの中心が (0, 0)。フリートピックは同じ規則の木として置き、位置未設定ならルートの中央に揃えた列に本体の下から積む。

配置は右列・左列の順位を保つので、右列を上から、左列を上から交互に読むと原文順に戻る。並べ替え（`move`）は他のレイアウトと同じ原文の index で行い、index の偶奇が側を決める。したがって第一階層に 1 つ差し込むと後続の兄弟は側が入れ替わる（規則が固定であるための帰結で、ドラッグの事前表示はその結果をそのまま見せる）。ノードには `is-balanced` を付ける。ドラッグの兄弟判定は上下 30% のまま（どちらの側でも兄弟は縦に並ぶ）。フリートピックの合流の事前表示（`snapSlot`）は側ごとの鏡像で、view の `snapTarget` が各木の第一階層を `balancedSideOf`（ルートの中心との位置関係）で右・左に分け、子孫に引き継いで `NodePlace` として渡す。ルートの子の列に対するスロットは、着地する側が列と一致する原文の index だけを出す（`amongBalancedRoot`。子の前はその子の index、列の末尾は次の index がその側に配られるときだけ全体の末尾の後ろ、空の側は次の index がその側ならルートの隣）。側の判定を geometry から読むのは、配置の規則が変わっても「ルートの左にあるものが左」という事実は変わらないためで、view と `snapSlot` は同じ関数を使う。レイアウトボタン（左下の 4 つ目、Lucide の `unfold-horizontal`）、`mappy-layout: balanced` の保存・復元、Excalidraw 挿入（`buildScene` は `layoutTree` の結果をそのまま使うので左側の線も鏡像の折れ線になる）は他のレイアウトと同じ規則で動く。

## 8. 表裏切替とビューのルーティング

コマンド「マップと Markdown を切り替え」は、map view なら同じ leaf で `showSource(false)`（選択ノードの原文位置へカーソル）、Markdown view なら同じ leaf を map view にする。Markdown からの切替は `mappy: true` のノートだけで有効にする。通常ノートは「このノートをマインドマップ化」を先に実行する。既定ホットキーは登録しない。

`mappy: true` を持つノートは、Excalidraw（`excalidraw-plugin`）や Kanban（`kanban-plugin`）と同じ方法で map view に導く。`WorkspaceLeaf.prototype.setViewState` を `patchMethod` で包み、`type: "markdown"` かつ `state.file` が該当ノートなら `type` を `mappy-map` に置き換える。`patchMethod` は `monkey-around` と同じ意味論（別プラグインが後から包んでいても、解除後は素通しになり原本を取り違えない）を依存なしで持つ。

- leaf ごとの選択を `WeakMap<WorkspaceLeaf, path>` に持つ。トグルで Markdown にした leaf は、同じノートを開き直しても Markdown のまま。別のノートを開くか map に戻すと記録を捨てる。
- `map → Markdown` の分割（`showSource(true)`）で作る新しい leaf も同じ経路で Markdown を維持する。
- 戻る／進む（`WorkspaceLeaf.history.go()`）が `setViewState` に渡す状態は `popstate: true` を持つ（1.14.2 の `updateState`。公開型にはないので object から読む）。`type: "markdown"` の `popstate` はその leaf が実際に見せていた Markdown（表裏切替の記録）なので map に振り直さず、トグルと同じく `markdownLeaves` に記録する。map view が navigation view になり（LEV-74）Markdown → map も履歴に載るため、この記録がないと ← で Markdown に戻れなかった。`popstate` の map 状態は通常どおり（マップでなくなったノートは Markdown）。
- 判定は `metadataCache` の frontmatter で行い、`excalidraw-plugin` を持つ図面は対象外にする。起動時の復元で cache が未準備なら保存済みの view type のまま開く。
- 公開 API だけの代替（`file-open` / `layout-change` 後に差し替える）は一瞬 Markdown が見えるうえ、他プラグインが内部で作る非アクティブな leaf（Excalidraw の対話フレームなど）に届かないため採用しない。`setViewState` は公開型の公開メソッドだが prototype の差し替え自体は非公開の慣習であり、解除と素通しをテストで固定する。

## 9. Excalidraw 連携

Excalidraw プラグインが有効なら、`window.ExcalidrawAutomate` の公開 API だけを使って二つの経路を提供する。npm の型パッケージは 2023 年で止まっているため、使うメンバーだけを `src/types/excalidraw-automate.ts` に写す。

1. **対話フレーム（ライブ）**: Excalidraw の「Insert interactive frame」は内部で `leaf.openFile` した後に `getViewType()` を見て、`markdown` 以外の専用ビューをそのまま表示する。8 節のルーティングにより、`mappy: true` を持つノートは Mappy のビューとして生きたまま埋め込まれる。Mappy 側に Excalidraw 依存のコードはない。
2. **ネイティブ要素（スナップショット）**: Option/Alt を押しながら `mappy: true` の `.md` をキャンバスへドロップすると、`onDropHook` が `type: "file"` の内部ドラッグを受け取り、マップを Excalidraw の要素として挿入する。通常 Markdown は扱わず、Excalidraw 既定の挿入ダイアログも維持する。既定経路で Mappy ノートから新しい embeddable／Markdown image が作られた場合は、Excalidraw Automate の identity-preserving edit でその要素の `strokeColor` だけを `transparent` にして外枠を消す。コマンド「現在のマップを Excalidraw の図面に挿入」は、直前にアクティブだった図面へ現在の表示（レイアウト・折りたたみ）を挿入する。

`onDropHook` は代入式の 1 スロットなので、既存のフックを退避して連結し、扱わないドロップは既存へ渡す。unload 時は自分が最前なら復元し、他が上に包んでいれば素通しにする。`onLayoutReady` と `layout-change` で冪等に再確認し、Excalidraw の後読み・再読込に追従する。判定は同期で `true` を返し、挿入は非同期に行う（Excalidraw 自身と同じ）。

要素の対応は map view の見た目に合わせる: 表示ルートは塗り矩形＋白文字、第一階層は枠付き矩形、下位は平文。線は `layoutTree` の `M/H/V` パスを折れ線にし、`![[画像]]` はラベル下に 240×140 以内で並べ、タイトル・本文の最初のリンクを要素の `link` に、ルートには元ノートへの `link` を付ける。1 回の挿入を 1 グループにする。呼び出したマップ（§5c）のノードは通常のノードとして入り、`![[…]]` の項目の要素は呼び出し先のノートへリンクし、呼び出したノードのリンクと画像は呼び出し先のノート基準で解決する（`SceneNodeContent.sourcePath`）。サイズは DOM ではなく Excalidraw 自身の計測に従う: 全要素を原点に作成 → 実寸を読む → `buildScene` で配置 → 座標を書き戻す。フォントは図面の `currentItemFontFamily` を使う。挿入後の図面と元ノートは同期しない。

対話フレーム内では Excalidraw が `--text-normal` を空にするため、線の色は `--mappy-line: currentColor` にしている。`var()` が空文字を展開すると `stroke` は無効値になり、`border` の省略形だけが生き残る。

## 9b. 設定（M14）

設定は `loadData`／`saveData` の 1 オブジェクト（`theme`・`defaultLayout`・`newMapFolder`・`visibleLayouts`）で、項目ごとの読み取り（`readSettingField`）を `normalizeSettings`（欠損・旧形式・不正値を項目ごとに既定値へ戻す）と設定タブの `setControlValue` が共有し、タブが受け付ける値と再読込で残る値を一致させる。既定値はどれも設定が無かったときの動作（テーマは Obsidian に追従、レイアウトは通常マップでキーなし、作成先は `FileManager.getNewFileParent`）である。設定タブは `PluginSettingTab` で、`display()`（1.8.7〜）と `getSettingDefinitions`／`getControlValue`／`setControlValue`（1.13 以降。宣言的設定で、Obsidian の設定検索にも出る。`obsidian` の型は 1.8.7 に固定しているので使う部分集合——`dropdown`／`text` の control と、行を自分で描く `render`——だけを `MapSettingDefinition` として写す）を同じ 4 項目の定義から出す。型が 1.13 の基底を知らないため、`update`・`settingItems`・`hide`・`renderTab`・`getControlBinding`・`refreshDomState`・`renderedItems`・`navEl`・`setting`・`name`・`id`・`icon` など `SettingTab`／`PluginSettingTab` の名前（app.js 1.14.2 のコンストラクタが置くフィールドと描画側のメソッド）をこのクラスの他のメンバーに使わない（`addSettingTab` が `update()` を呼んで `settingItems` を埋めるので、同名の private メソッドがあると宣言的経路が黙って死ぬ。ブラウザ検証ページのモックがこの流れを持ち、jsdom で固定する）。レイアウト名は `src/core/layout-mode.ts` の `LAYOUT_LABELS` が唯一の定義で、レイアウトボタンと設定のドロップダウン・トグルが共有する。保存はプラグインだけが行い、タブはノートにも Vault にも触れない。

左下に表示するレイアウト（`visibleLayouts`、LEV-76）は表示の設定であって機能の無効化ではない。値は `readVisibleLayouts` で正規化した `LayoutMode[]`（`LAYOUT_MODES` 順・重複なし・`mindmap` を必ず含む。配列でない値は未設定として全部）で、旧版のデータファイルは全部表示のまま。設定タブでは 1 つの行にトグル 4 つを置く。1.13 の宣言的設定はこの行を `render`（`Setting` を受け取って自分で描き、cleanup を返す）で出し、`display()` も同じ関数を呼ぶので両経路で同じ DOM になる。通常マップのトグルは on 固定で `setDisabled`、他は `setControlValue('visibleLayouts', …)` を通して保存する（文字ラベルのクリックでも同じトグルが動く）。`saveData` が失敗したときは `main.ts` の `saveSettings` がメモリの設定を前の値に戻し、タブはそのトグルを戻す（戻したときの `onChange` は保存済みの値と同じなので何もしない）。既定レイアウトが非表示のときの注記は同じ行の `descEl` の下に 1 行置き、`setControlValue` の完了後に更新するので、トグルでも既定レイアウトのドロップダウン（1.13 では binding → `setControlValue`）でも追従する。view 側は `MindmapView.setVisibleLayouts()` が `setTheme()` と同じ形で、左下の `.mappy-modes` のボタンに `hidden` を付け外しするだけ（styles.css が `.mappy-button[hidden]` を `display: none` にする。ボタンの DOM の並びは変えず、既定では属性が付かない）。表示中のレイアウト（`this.mode`。frontmatter・view state・ボタン選択のどれで決まっても）のボタンは設定に関わらず残し、別のレイアウトを選んだ時点で消える（`setState` と `selectMode` が `mode` を変えた直後に同期するので、文書がなく `draw()` が走らないときも従う）。`main.ts` は view の生成時と `saveSettings` で渡すだけで、`mappy-layout` の保存・復元、view state、コマンド、埋め込み、Excalidraw 挿入、「新規マップの既定レイアウト」は `visibleLayouts` を見ない。

テーマは `MindmapView.setTheme()` が map view のコンテナ（`.mappy-view`）にだけ Obsidian の `theme-light`／`theme-dark` class を付け外しする。Obsidian の app.css は素の配色（`--color-base-*`・`--mono-rgb-*`・`--color-<名前>`・`--shadow-s`・`color-scheme`）を `.theme-light`／`.theme-dark` に、意味変数（`--background-primary`・`--text-normal`・`--link-color`…）をそこから導く形で `body` に置くため、コンテナに class を付けるだけでは意味変数が body の計算済みの値のまま継承される。そこで styles.css の `:where(.mappy-view.theme-light, .mappy-view.theme-dark)` が、マップとノード内の描画済み Markdown が読む意味変数を app.css と同じ対応で導き直す（1.6.7 と 1.14.2 で照合）。`:where()` で詳細度を 0 にしてあるので、コミュニティテーマが `.theme-dark { --background-primary: … }` と書けばそれが勝つ。「Obsidian に従う」は class を外すだけで、設定が無かったときと同じ継承になる。埋め込み表示（M10）と Excalidraw 挿入はこの class を付けないので Obsidian のテーマに従う。プロパティとして body で確定するものは、子孫が body の算出済みの値を継承するので、変数を導き直しても誰かがその変数を読み直さない限り届かない。app.css が body で確定させる継承プロパティのうちテーマに依るのは `color: var(--text-normal)` と `caret-color: var(--caret-color)` の 2 つで（他は font 系と透明な tap-highlight）、どちらも `.mappy-view` が全モードで読み直す（LEV-93。`--caret-color: var(--text-normal)` は theme 上書きの変数に含め、モバイルは app.css と同じく `:where(.is-mobile .mappy-view.theme-*)` で `--text-accent` に向ける。追従モードでは継承していた値と同じ色に解決する）。`::selection` の背景は各要素の `--text-selection` を読むので導き直した変数で足りる。限界: app.css がモーダルの開閉アニメーション中に `body.hide-cursor { caret-color: transparent !important }` でキャレットを隠す間も、マップの中のキャレットは見えたままになる（コンテナ自身の宣言は継承した `!important` に勝つ）。限界: 変数ではなく body の class で分岐する子孫規則（コミュニティテーマの `.theme-dark .markdown-rendered code { … }` のような形）は、body が暗色ならコンテナが明色でも一致する。Obsidian 本体の app.css（1.14.2）にはノード内に届くこの形の規則がないが、コミュニティテーマでは起こり得るので LEV-62 の目視項目にする。

作成先フォルダは空欄で Obsidian の「新規ノートの作成場所」、`/` で最上位、それ以外は `normalizePath` した相対パス。`normalizePath` はスラッシュを整えるだけ（app.js 1.14.2 で確認）なので、`.`・`..`・`.` で始まる名前（Vault が索引しないフォルダ）はここで拒否する。大文字小文字だけが違う既存フォルダは再利用し（ファイルシステムは通常区別しない）、同名のファイルがあれば作らずにエラー、存在しなければ `Vault.createFolder`（結果が空ならエラー）。上書きはしない。

## 9c. SVG／PNG 書き出し

Excalidraw 挿入と並ぶ、外へ持ち出す経路（§5 M13）。図面 API を持たないので、map view が画面に置いたものをそのまま文書にする。

- **入力は view の最終配置**: `MindmapView.exportSource()` は、最後の配置フレームで使った `LayoutResult`、`NodeRenderer.entries` の複製、canvas、線の `<svg>` を渡す。debounce 中の refresh があれば先に実行し（発火済みで読み込み中の refresh は `refreshing` で待つ。読み込み中に届いた変更は epoch で捨てられて新しい debounce を残すので、どちらも無くなるまで繰り返す）、`NodeRenderer.idle(EXPORT_RENDER_WAIT_MS)`（表示中のノードの `MarkdownRenderer.render` がすべて終わるまで）を待ち、配置フレームが予約中なら 1 フレーム（隠れたウィンドウでは 100 ms）待ち、インライン編集中・ドラッグ中は拒否する。配置し直さないので、線の `d`・ノードの座標・折りたたみは画面と一致する。
- **描画の完了**（LEV-65）: `NodeRenderer` は進行中の描画をノード id ごとに持ち（値はラベルと添付の両方の settle を表す promise。再描画や削除で置き換わった古い描画は、遅れて終わっても待たず、新しい待ちも切らない。ラベルの描画が失敗しても添付の描画が終わるまで進行中）、描画の then／catch で `changed()`（配置フレームの予約）を呼んでから `idle()` の待ち手を起こすので、`exportSource()` は idle の直後に予約済みのフレームを見つけて待てる（進行中のノードを `update()` が削除したときも `changed()` を呼んでから起こす）。画像の `load` は待たない（外部 URL は届かないことがある）。`idle(stall)` の上限は「`stall` ms の間に 1 件も描画が終わらない」で、諦めたときは `false` を返して待ち手を外す（終わる見込みのない待ち手を溜めない）。描画が進んでいる大きなマップは合計で 2 秒を超えても待つ。諦めたとき（post-processor や埋め込みの停止）は、map view 自体もその途中の見た目なので、書き出しは `EXPORT_RENDER_STALLED_MESSAGE` の Notice を出して画面のまま続行する（エラーにしない）。
- **ノードは `foreignObject` の XHTML**: `svg-capture.ts` が要素を歩き、状態クラス（`is-selected` など）、開閉ボタン、`tabindex`／ARIA／インライン style を落として直列化する。DOM は最初の `await` の前に一度で読み切り（画像は印を置いて後から差し込む）、途中で refresh が来てもノードが欠けない。XML に書けない制御文字・孤立サロゲートは落とし、宣言していない接頭辞の属性（`foo:bar`）は捨て、`xlink:` はルートで宣言する。書き出す前に `DOMParser` で整形式を確かめる。見た目は Obsidian のスタイルシートに頼らず、`getComputedStyle` の白名簿（余白・枠・角丸・背景・文字・折り返し・flex）を宣言列ごとに 1 クラスにまとめ、`<style>` に置く（2,000 ノードでも数十クラス）。ノードのルートには配置時の幅と高さを書き、`foreignObject` は `overflow="visible"` にして、フォントが違う環境で 1 行増えても文字が切れないようにする。閉じた枝の件数は、枠からはみ出すので `foreignObject` の外に SVG の丸と文字で描く（`LayoutResult.folds` と `foldBadgeWidth`）。
- **画像は data URL**: resolver は差し込み。Obsidian 側（`image-export.ts`）は `.internal-embed[src]` の link target（`core/wiki-link.ts` の `wikiLinkPath`）を `metadataCache` で解決し、`core/attachments.ts` の画像拡張子表にあれば `vault.readBinary`、Markdown 形式の画像は属性に残った書かれたパスで同じことを試み、`http(s)` だけ `requestUrl` で取る（15 秒で諦め、`image/*` 以外は受け付けない）。読めなければ null を返し、`<img>` は同じ大きさの `<span>`（代替テキスト）になる。ノードは残る。
- **テーマ**: `themeOf(canvas)` が canvas から最も近い `.theme-light`／`.theme-dark`（設定のテーマ（§9b）は `.mappy-view` にだけ付ける）、無ければ body の `theme-dark` でルートの `class="mappy-export theme-…"`・`data-theme` と既定色を決める。色と同じ DOM を同じ瞬間に読むので、属性と色が食い違わない（`exportMap` の `theme` オプションは DOM に勝つ。LEV-92: 以前は常に body を見ていたため、暗色のアプリで明色にしたマップは色が明色なのに属性が dark だった）。背景は canvas の算出 `background-color`、線は最初の path の算出 `stroke`（`currentcolor` なら `color`）。
- **PNG**: 同じ SVG を `data:image/svg+xml` の `<img>` に読み込み、canvas に `scale` 倍で描いて `toBlob`。blob URL は `file://` のような不透明オリジンで canvas を汚染するため使わない。WebKit（iOS の Obsidian）は `foreignObject` を含む SVG 画像で canvas を汚染するので、コマンド実行時に 1 ピクセルの SVG で一度だけ読み戻しを試し（`canRasterizeForeignObject`）、できなければモーダルの PNG を無効にする。それでも `SecurityError` が出れば「この環境では PNG を作れません」に言い換える。縮尺は 2 倍を上限に、`DESKTOP_PNG_LIMITS`（8,192²・一辺 16,384）／`MOBILE_PNG_LIMITS`（4,096²）に収める。`<img>` に載せた SVG は文書の Web フォントを使えないので、フォントはこの端末のものになる。
- **保存**: `MindmapView.exportImage(format)` → `exportMap` → `getAvailablePathForAttachment(<basename>.svg|png, note.path)` → `vault.create`（SVG）／`vault.createBinary`（PNG）。パスを取るのは書き出す直前で、PNG が作れない環境はその前に断る（添付フォルダを作らない）。ノートは読まない・書かない。コマンドは `canSaveAttachments`（添付パス API と create の存在）が真のときだけ出す。

## 9d. マップの検索と呼び出し（M12 の入力側）

マップを開いたまま別のマップを `![[別マップ]]` の項目として足す経路。表示は §5c の投影（呼び出し先の木を枝として継ぎ足す。LEV-82）。書き込み側は通常のノード追加をそのまま使い、専用の保存経路を作らない。

- **コマンド**は `src/main.ts` の登録 1 か所。`checkCallback` で map view がアクティブなときだけ出し、`MapSearchModal` を開いて、選ばれた `TFile` を `MindmapView.callMap` に渡す。名前にプラグイン名を含めず、既定ホットキーは登録しない。
- **候補**は `listMapNotes`: `vault.getMarkdownFiles()` のうち `isMapNote`（`embed-target.ts`。metadataCache の frontmatter に真偽値の `mappy: true` があり Excalidraw でない）が真で、呼び出し元のノートでないもの。metadataCache を読むので、編集中で未保存の frontmatter は反映されない（埋め込みの解決と同じ前提）。検索文字列は拡張子なしのパス（`フォルダ/タイトル`）で、タイトル・フォルダ・`フォルダ/タイトル` のどれでも絞り込める。表示はファイル名と親フォルダの 2 行（Obsidian の `suggestion-title`／`suggestion-note` の class を使い、独自 CSS を足さない）で、一致箇所は Obsidian の `renderMatches(el, text, matches, offset)` で `suggestion-highlight` にする。`matches` は `フォルダ/タイトル` に対する位置で、`offset` は各 match の始点・終点に足される（終点が 0 以下の範囲は飛ばし、始点が文末以上で打ち切り。実機の 1.14.2 で確認、LEV-71）ので、title 行には `-(フォルダ長 + 1)`、note 行には 0 を渡す。0 件は `emptyStateText`。
- **書き込み**は `callMap`: 選択ノード（`selected()`。フリートピックのルートも通る）を親に、`![[` + `app.metadataCache.fileToLinktext(target, note.path, true)` + `]]` を `add-child` コマンドの `title` に渡す。何も選択していなければ（下記の選択の解除）、同じ文を `add-topic` の `title` に渡して文書末尾の最上位区画 `## ![[別マップ]]`（フリートピック）にする: core の `addTopic` は空のトピックと同じ 1 つの挿入に文を含め、再解析で「1 ノード増え、その見出しが `title.trim()` で親が root」を検証する。位置は書かない（`mappy-topics` に触れず、view の `pendingTopic` も使わない）ので、そのトピックは位置未設定の既定配置（本体のそばの列）に置かれ、ドラッグで初めてキー `![[別マップ]]` が書かれる。本体が仮想ルート（`kind === "root"`）のときも同じ経路（add-child でも末尾に `## ` を書くので同じ結果になる。LEV-70 の「先に H2 を」の拒否は LEV-83 でなくした）。中身のないノート（frontmatter だけ）ではその `## ![[別マップ]]` が最初の見出し＝本体になる（`add-topic` が空のノートで本体を作るのと同じ。表示のための見出しは足さない）。パスの形（最短・相対・絶対、同名なら完全パス）は Vault の「新しいリンクの形式」に従うが、記法は `generateMarkdownLink` に任せず Wiki 形式に固定する: ノードのタイトルを描く `transclusionsAsLinks` と表示側（§5c）の「`![[…]]` だけの項目」の判定が Wiki 形式しか読まないので、「Wikilinks を使用」オフの `![名前](パス.md)` を書くとノードの中にノート全体が展開されてしまう。core の `add`（両形式）は空の項目と同じ位置・同じ 1 つの挿入差分に文を含め、再解析した木で「1 ノード増え、その項目の文が `title.trim()`」であることを検証する（改行は事前に拒否）。view は空の add-child と同じく新しい項目を選択して表示するが、`title` 付きではインライン入力を開かない。差分と履歴は Tab と同じなので、Undo 1 回で項目ごと消え、`DocumentStore` の履歴・原文照合・開いているエディタ優先はそのまま効く。呼び出したマップの元ノートには触れない。
- **拒否**: 自分自身（候補には出ないが、モーダルを開いたあとに view のノートが変わった場合）、保存中（Tab は黙って捨てるが、選んだマップが消えたように見えないよう伝える）、呼び出したマップのノードが選ばれている（読み取り専用の Notice）、インライン編集中（`execute` 側のガードなので右クリックの子追加も同じ。下書きの確定 → 子追加の経路は `inlineEditor` を外したあとに通る）。見出し形式のノートでは add-child と同じく 1 段深い見出し `### ![[別マップ]]`、トピックは最後の最上位区画と同じ深さの見出しになる（拒否も変換の誘導もしない）。
- **選択の解除**（LEV-83）: LEV-83 より前の map view は描画のたびに 1 ノードを選択状態に保ち（開いた直後は本体ルート）、「未選択」は実機では起こらなかった。本人の「空白をクリックしてフォーカスを外した状態」を未選択にするため、空白の押下を持つ `MapViewport`（パン・ピンチ）がクリックを判定する: 主ボタンの押下（ノード・ボタン・入力欄の外。`MapViewport` の pointerdown が受けるものだけ）が `PRESS_TRAVEL`（4px。`map-events.ts` で NodeDrag と共有）以上動かず、2 本目のポインターにも会わず、`pointerup` で離されたら `clicked` を呼ぶ（`pointercancel` は呼ばない）。view はそれで `selectedId` を null、`deselected` を true にして `renderer.select(null)`（`is-selected`／`aria-selected` が消える）。パンは動くので外れず、右クリックは主ボタンではない。`MapEvents` は押下を追跡しない（click イベントの共通祖先の判定や自前の閾値を持たない）。`draw()` は `deselected` の間は選び直さず、それ以外（開いた直後、選択ノードが折りたたみ・削除・外部変更で消えた）は従来どおり先頭ノードを選ぶ。`select()` が `deselected` を戻す。インライン編集中の空白クリックは、押下でキャンバスにフォーカスが移って blur が下書きを保存し、離した時点で未選択になる。保存後の `finish` は `deselected` なら選び直さない。未選択のキー: `MapEvents.keydown` は ⌘Z／⌘⇧Z（履歴はノードに紐づかない）と修飾なしの矢印だけを受け、矢印は `visible()[0]`（本体ルート）を選択して再開する。Enter／Tab／Delete／F2／Space は何もしない（scope は `undefined` を返し、Obsidian の既定に任せる）。画像の貼り付けも未選択では受けない。歯車のポップオーバーとコマンドパレットはフォーカスを持っていくが `selectedId` を変えないので、空白クリック → 歯車／⌘P → 検索 → 選択の経路で `callMap` は未選択のまま届く。ポップオーバーを空白のクリックで閉じたときもそのクリックは空白のクリックとして選択を外す（見た目どおり）。
- 実機（E35 の入力側、LEV-71）で確かめた前提: 同じノートを Markdown で開いた分割表示では `DocumentStore` が editor の `transaction`（origin `mappy`）で書き、ディスクは Obsidian の保存に任せる。`fileToLinktext` は最短で同名ノートが 2 つあると完全パス、相対は呼び出し元のフォルダからのパスを返す。
- リスト形式の `insertion` は、改行で終わる文書の末尾に足すとき末尾の改行を保つように直した。子のない最終区画への Tab に加え、最後の H2 の Enter（兄弟）と仮想ルートへの Tab（どちらも末尾に `## ` を作る）も `## \n` で終わるようになる。

## 10. 最初に検証する順序

1. 原文範囲付きの parse と、変更しない部分のバイト保全。
2. 分割エディタで保存前入力の追従と、map からの 1 transaction・Undo。
3. 同名見出し、外部変更、複数ビュー、表裏切替時の履歴。
4. リンク・画像描画と component の廃棄。
5. 500 ノードの差分更新、viewport 維持、トラックパッド。
6. 通常配置とタイムラインを同じコマンドで編集できること。
7. frontmatter ルーティング（通常 leaf・Excalidraw の埋め込み leaf）と、Option ドロップ／コマンドによる Excalidraw への挿入。

この順序で、保存方式の欠陥をノード装飾や高度なレイアウトより先に見つける。
