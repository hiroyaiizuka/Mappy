# Mappy の設計と試作実装

更新: 2026-09-18。現在の実装と、引き続き検証する条件を記す。実装済みという記述は、対応環境全体での動作保証を意味しない。

## 1. 中心となる判断

**文書の正本は Markdown 一つにする。マップはその投影と編集 UI にする。** マップ専用 JSON と Markdown を相互変換して保存する構成は採用しない。変更していない本文をそのまま残すことを、描画より先に設計する。

```mermaid
flowchart LR
  E[Obsidian 標準 Markdown エディタ] -->|editor-change| S[文書セッション: 原文と revision]
  S --> P[原文範囲付きツリー]
  P --> L[マップ / タイムライン配置]
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
| `src/core/commands.ts` / `list-commands.ts` / `body.ts` | rename / add / move / delete / 本文変更 → 原文差分 | 純粋 TypeScript |
| `src/core/list-conversion.ts` | 旧見出し形式から H2＋箇条書きへの明示変換 | 純粋 TypeScript |
| `src/layout/layout.ts` | tree＋実測サイズ → マップ／タイムラインの座標と線 | 純粋 TypeScript |
| `src/interaction/viewport.ts` | パン・ズーム・Fit の座標計算 | 純粋 TypeScript |
| `src/core/attachments.ts` / `plain-text.ts` | 本文からのリンク・画像抽出、タイトルの平文化 | `@lezer/markdown` |
| `src/export/excalidraw-scene.ts` / `src/layout/path-points.ts` | tree＋計測 → 描画 API 非依存のシーン（ブロック・折れ線） | 純粋 TypeScript |
| `src/obsidian/document-store.ts` | Editor/Vault の一本化、原文照合、キュー、履歴 | Obsidian の公開 API |
| `src/obsidian/frontmatter.ts` / `map-files.ts` | `mappy: true` の識別、初期レイアウト、新規マップ作成 | metadataCache、FileManager、Vault |
| `src/obsidian/view-routing.ts` / `patch.ts` | frontmatter を持つノートを map view へ導く `setViewState` の差し替え | WorkspaceLeaf.prototype |
| `src/obsidian/excalidraw-bridge.ts` / `src/types/excalidraw-automate.ts` | Excalidraw の `ExcalidrawAutomate` へのドロップフック連結と要素生成 | `window.ExcalidrawAutomate`（任意） |
| `src/ui/mindmap-view.ts` | ファイル・表示状態、描画更新、編集経路の接続 | Obsidian ItemView |
| `src/ui/node-renderer.ts` | ノードの差分描画、計測、MarkdownRenderer の寿命 | Obsidian MarkdownRenderer |
| `src/ui/map-events.ts` / `map-viewport.ts` | キー・リンク・ドラッグ・画像貼付・DOM のパン／ズーム | Obsidian Component、DOM |
| `src/ui/inline-editor.ts` / `link-suggest.ts` | インライン入力とノート候補 | DOM、候補取得時の Obsidian API |

Markdown parser は原文の UTF-16 offset を得られる `@lezer/markdown` を採用した。通常の Markdown を構文解析し、frontmatter と Obsidian コメントを補助処理する。製品コードはブラウザ互換にし、Node/Electron や非公開の Obsidian parser を使わない。ランタイム依存は package.json で固定し、バンドルの実測値とハッシュは各ビルドの `dist/build-info.json` と証跡で追う。モバイル互換性は設計上の条件であり、実機では未確認。

## 3. Markdown とノードの対応

H2＋箇条書きの形式と、従来の見出し形式を実装している。文書直下に H2 以外の見出しがある場合は `format: 'headings'`、H2 だけ・見出しなしの場合は `format: 'list'` とする。コード・引用・コメント・frontmatter の偽見出しは判定に使わない。編集検証では必要に応じて既存の形式を指定して再解析できる。

解析上はファイル名の仮想ルートを持ち、最上位ノードが一つならそれを表示ルートにする。複数ある場合だけ仮想ルートを表示し、そのために原文を足し引きしない。リスト形式では、文書直下の BulletList を直前の H2 配下へ、H2 より前のリストを仮想ルート配下へ置く。入れ子は Lezer の ListItem 構造に従い、タブを含むインデントを独自の行正規表現だけで推測しない。OrderedList とタスク項目、およびその下位は原文を保持してノード化しない。

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

`mappy: true` はマップの必須識別子である。文字列 `"true"`、`false`、`mappy-layout` だけのノートは対象にしない。`mappy-layout` は任意の初期表示設定で、`timeline` のときだけタイムライン、それ以外と省略時は通常マップにする。新規作成・マインドマップ化・解除と、レイアウトボタンによる明示選択だけが frontmatter を書く。タイムライン選択は `mappy-layout: timeline` を保存し、通常マップ選択はキーを削除する。閲覧・折りたたみ・ズーム・Excalidraw への挿入では書かない。旧 `mappy-layout` 単独ノートは自動で取得せず、明示的なマインドマップ化で旧レイアウトを引き継いで `mappy: true` を追加する。ファイル・レイアウト・viewport は各 leaf の view state で扱い、選択と折りたたみはビュー内の一時状態として保持する。

- ATX 見出し、Setext、frontmatter、フェンス、空行、CRLF、末尾改行、引用、コメントを fixture で扱う。初期に編集未対応の構文は表示または source 編集へ誘導し、推測で変更しない。
- 不明な記法は原文の範囲として保存する。本文を AST 全体から再生成しない。
- 従来の見出し形式で深さが飛ぶ場合は、直前の小さい深さの見出しへ接続する。原文は自動修正しない。
- 同名見出しがあるため、タイトルや配列の位置だけをノード ID にしない。セッション内 ID と原文範囲、編集差分を対応付け、外部全変更では一致する部分を再対応する。曖昧なら選択を解除し、古い ID で書き込まない。
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

表示ルートの ID で濃い面のルートを判定し、その直接の子は枠付き、下位は平文にする。H2 がルートの場合も同じ基準を使う。線はノード領域の左右中央へ接続し、文字の下へ伸ばさない。通常マップも直角線にし、親から共通の幹を伸ばして分岐点から子へ接続する。現在の通常マップの横間隔はルート80px・下位56px、兄弟の縦間隔は22pxとし、タイムラインとは別の寸法を使う。

`LayoutResult.folds` に開閉操作の中心座標を返し、renderer が分岐点にボタンを配置する。展開中はボタンの領域へカーソルを合わせたとき、またはキーボードフォーカス時に丸い − を表示する。折りたたみ件数には直接の子だけでなく隠れる子孫をすべて含める。数字の桁数で変わるバッジ幅とヒット領域の寸法を layout と renderer で共有し、枝間の余白と Fit の bounds に含める。閉じた枝にも開閉座標を残す。

大規模化は、差分更新 → 折りたたみ → 可視領域外 DOM の省略の順に検討する。Worker や WebGL は、計測で必要性が出た段階で判断する。

## 6. 操作とズーム

パン・ズームは transform を更新し、構文解析やツリー再配置を呼ばない。キャンバスに専用の上部・下部行を割かず、左下にレイアウト切り替え、右上に Markdown 表示・分割、右下に現在倍率・±・Fit・100% を浮かせて置く。倍率の上限は3.0、下限は長い文書を Fit できるよう 0.000001 としている。表示倍率と手動ズームで同じ制限を共有し、Fit 後の最初の操作で倍率が跳ねないようにする。

ポインター p、平行移動 t、倍率 s に対してワールド座標は `w = (p - t) / s`。倍率を s' に変えた後の平行移動を `t' = p - w * s'` とし、ポインター直下の点を固定する。画面外オフセット、devicePixelRatio、popout を含めてテストする。

背景ドラッグと二本指スクロールをパン、ピンチと修飾キー付きホイールをズームにする。`preventDefault` はマップが処理する範囲のみ。IME の `isComposing` / composition イベント中は構造変更キーを発火しない。マップの roving focus と編集入力を分離し、ノード上だけで Enter/Tab/Delete を扱う。グローバル既定 hotkey を登録しない。

ノードのドラッグは HTML5 の drag and drop を使い、`dragover` でポインター位置をノード矩形の比率に変換して `before` / `after` / `inside`（子の末尾）を決める。上下各 30% が兄弟の前後、残りが子の末尾で、タイムラインの第一階層だけは左右で判定する。判定結果は core の `resolveDrop` に渡し、自分自身・子孫・仮想ルート直下のリスト項目・H6 超過なら事前表示を出さず `dropEffect` を `none` にする。受け付ける場合は `data-drop` 属性で挿入バーか破線枠を描き、`drop` は最後に表示した位置の `move` コマンド（親 ID と、移動ノードを除いた兄弟内の位置）を実行する。`move` は両形式で「移動元の行を取り除き、隣接する兄弟の深さ・インデントに合わせて挿入し、再解析した木の形が移動をシミュレートした木と一致する」ことを検証してから差分を返す。画像ファイルのドロップは従来どおり添付として扱う。

追加した空のノードはモーダルを出さず、そのノード内で編集する。リスト形式の下位には箇条書き、ルートには H2、従来の見出し形式には ATX 見出しを追加する。プレースホルダーを付けない。インライン入力中は Enter で保存、Tab で保存して子を追加、Escape で編集前のテキストに戻る。新しい空ノードを追加済みの場合、Escape は追加そのものを取り消さない。追加操作の取消は Undo で行う。

`[[` の候補は専用 textarea に対する独自 UI とし、Vault のノート・パス・別名と PNG・SVG・PDF 等の添付ファイルを候補にする。`![[` で開始したリンクは埋め込みの `!` を保つ。候補がある間は Enter/Tab を候補選択に使い、同じキーで保存や子追加まで行わない。選択箇所以外の入力を保持し、入力を閉じたら候補 DOM とイベントを解放する。見出し・ブロック候補を含む標準エディタの全補完機能を再現したものではない。

## 7. 添付画像のタイムライン

`layoutTree` の timeline モードで、第一階層を中央の水平線へ並べ、そのサブツリーを上下交互へ配置する。幹はステージの上辺または下辺の中央から伸ばし、子テキストの中央高さで曲げて左端に止める。深い枝も直角線にする。軸上の線は前のノードの右辺から次の左辺までの区間ごとに描く。

同じ側の枝は包絡矩形を使って間隔を確保し、反対側は横幅を共有する。計測と配置は明示的なスタックで処理し、深い木で再帰スタックに依存しない。長文・画像が混在する実機表示と性能は別途記録する。

保存順序・ノード ID・編集コマンドは通常マップと共通。日時比例や工数を扱うものではなく、講座の章立てを表す配置である。レイアウト変更では初期表示用の frontmatter だけを更新し、本文を書き換えない。

## 8. 表裏切替とビューのルーティング

コマンド「マップと Markdown を切り替え」は、map view なら同じ leaf で `showSource(false)`（選択ノードの原文位置へカーソル）、Markdown view なら同じ leaf を map view にする。Markdown からの切替は `mappy: true` のノートだけで有効にする。通常ノートは「このノートをマインドマップ化」を先に実行する。既定ホットキーは登録しない。

`mappy: true` を持つノートは、Excalidraw（`excalidraw-plugin`）や Kanban（`kanban-plugin`）と同じ方法で map view に導く。`WorkspaceLeaf.prototype.setViewState` を `patchMethod` で包み、`type: "markdown"` かつ `state.file` が該当ノートなら `type` を `mappy-map` に置き換える。`patchMethod` は `monkey-around` と同じ意味論（別プラグインが後から包んでいても、解除後は素通しになり原本を取り違えない）を依存なしで持つ。

- leaf ごとの選択を `WeakMap<WorkspaceLeaf, path>` に持つ。トグルで Markdown にした leaf は、同じノートを開き直しても Markdown のまま。別のノートを開くか map に戻すと記録を捨てる。
- `map → Markdown` の分割（`showSource(true)`）で作る新しい leaf も同じ経路で Markdown を維持する。
- 判定は `metadataCache` の frontmatter で行い、`excalidraw-plugin` を持つ図面は対象外にする。起動時の復元で cache が未準備なら保存済みの view type のまま開く。
- 公開 API だけの代替（`file-open` / `layout-change` 後に差し替える）は一瞬 Markdown が見えるうえ、他プラグインが内部で作る非アクティブな leaf（Excalidraw の対話フレームなど）に届かないため採用しない。`setViewState` は公開型の公開メソッドだが prototype の差し替え自体は非公開の慣習であり、解除と素通しをテストで固定する。

## 9. Excalidraw 連携

Excalidraw プラグインが有効なら、`window.ExcalidrawAutomate` の公開 API だけを使って二つの経路を提供する。npm の型パッケージは 2023 年で止まっているため、使うメンバーだけを `src/types/excalidraw-automate.ts` に写す。

1. **対話フレーム（ライブ）**: Excalidraw の「Insert interactive frame」は内部で `leaf.openFile` した後に `getViewType()` を見て、`markdown` 以外の専用ビューをそのまま表示する。8 節のルーティングにより、`mappy: true` を持つノートは Mappy のビューとして生きたまま埋め込まれる。Mappy 側に Excalidraw 依存のコードはない。
2. **ネイティブ要素（スナップショット）**: Option/Alt を押しながら `mappy: true` の `.md` をキャンバスへドロップすると、`onDropHook` が `type: "file"` の内部ドラッグを受け取り、マップを Excalidraw の要素として挿入する。通常 Markdown は扱わず、Excalidraw 既定の挿入ダイアログも維持する。既定経路で Mappy ノートから新しい embeddable／Markdown image が作られた場合は、Excalidraw Automate の identity-preserving edit でその要素の `strokeColor` だけを `transparent` にして外枠を消す。コマンド「現在のマップを Excalidraw の図面に挿入」は、直前にアクティブだった図面へ現在の表示（レイアウト・折りたたみ）を挿入する。

`onDropHook` は代入式の 1 スロットなので、既存のフックを退避して連結し、扱わないドロップは既存へ渡す。unload 時は自分が最前なら復元し、他が上に包んでいれば素通しにする。`onLayoutReady` と `layout-change` で冪等に再確認し、Excalidraw の後読み・再読込に追従する。判定は同期で `true` を返し、挿入は非同期に行う（Excalidraw 自身と同じ）。

要素の対応は map view の見た目に合わせる: 表示ルートは塗り矩形＋白文字、第一階層は枠付き矩形、下位は平文。線は `layoutTree` の `M/H/V` パスを折れ線にし、`![[画像]]` はラベル下に 240×140 以内で並べ、タイトル・本文の最初のリンクを要素の `link` に、ルートには元ノートへの `link` を付ける。1 回の挿入を 1 グループにする。サイズは DOM ではなく Excalidraw 自身の計測に従う: 全要素を原点に作成 → 実寸を読む → `buildScene` で配置 → 座標を書き戻す。フォントは図面の `currentItemFontFamily` を使う。挿入後の図面と元ノートは同期しない。

対話フレーム内では Excalidraw が `--text-normal` を空にするため、線の色は `--mappy-line: currentColor` にしている。`var()` が空文字を展開すると `stroke` は無効値になり、`border` の省略形だけが生き残る。

## 10. 最初に検証する順序

1. 原文範囲付きの parse と、変更しない部分のバイト保全。
2. 分割エディタで保存前入力の追従と、map からの 1 transaction・Undo。
3. 同名見出し、外部変更、複数ビュー、表裏切替時の履歴。
4. リンク・画像描画と component の廃棄。
5. 500 ノードの差分更新、viewport 維持、トラックパッド。
6. 通常配置とタイムラインを同じコマンドで編集できること。
7. frontmatter ルーティング（通常 leaf・Excalidraw の埋め込み leaf）と、Option ドロップ／コマンドによる Excalidraw への挿入。

この順序で、保存方式の欠陥をノード装飾や高度なレイアウトより先に見つける。
