# Mappy 開発ハーネス

- 英語で考え、日本語で報告する。
- 製品要件は `docs/product-plan.md`、設計判断は `docs/architecture.md`、検証手順は `docs/harness.md`、チケット運用は `docs/linear-workflow.md`。
- 実装前に受入条件を確認する。修正時は対象の再現ケースを先に用意する。
- 追加したテストは、修正を戻した状態で実際に落ちることを確かめ、その出力を記録に残す。戻しても通るテストは回帰テストではない。消すか、何を固定しているのかを明記する。
- 症状を直すときの再現行列は、立てた仮説からではなく**本人の操作 × 対象の形**で作る（例: 「画像を貼る」×「空のノード・同名・一意・子・トピック」）。仮説で組んだ行列は仮説の外を見ない（LEV-142 は「同名ノード」で組み、画像を貼ると必ずできる「題名が空のノード」を落とした）。
- 対症療法で出荷しない。回避策を入れるなら、根本原因のチケットを同じ版で閉じるか、**回避策が成り立つ前提と崩れる条件を PR 本文に書く**。回避策は新しい前提を持ち込む。
- 実機のケースは `scripts/e2e/` に置き `npm run harness:e2e:<名前>` で再実行できる形にする。`artifacts/` の使い捨て probe は「確認済み」の記録だけを残して次から回らない。
- 完了前に `npm run check` を実行する。失敗を無効化や広範な lint 抑制で回避しない。
- **すべての PR で、PR を作る前に `/code-review high origin/main...HEAD` を通す。**範囲を省いた素の `/code-review` を打たない。引数なしは `@{upstream}...HEAD` を見るので、`git push -u` 済みで作業ツリーもクリーンなブランチでは対象が空のまま「指摘 0 件」で通る（LEV-183 で再現）。`origin/main` はそのブランチの base に読み替える（`orca worktree create --base-branch` で切った場合。読み替えないと親ブランチのコミットまで自分の指摘として返る）。変更した場所（`src/` かどうか）で対象を絞らない。危険の所在は場所ではなく役割で、PR #76 は `src/` を 1 行も含まない変更（`scripts/e2e/` 8 件・`docs/` 2 件・`package.json` の計 11 ファイル）だったが他チケットを「実機で確認済み」と認定する側の仕組みであり、規約の対象外としてスキップしたあとに回したレビューは指摘 14 件、うち 4 件が「実行されていない run を PASS として記録しうる」種類だった。指摘は重大度を問わず同じブランチで直し、**直したら `npm run check` を回し直す**。見送るものは理由を PR 本文に書く（`artifacts/` も `memory/` も git 管理外で、他所からは読めない）。手順の詳細は `docs/linear-workflow.md` の「ワーカーの手順」。実行するかどうかを本人に聞かない。
- **レビューの指摘を別チケットへ回す前に、本人が報告した現象と突き合わせる。**「範囲外」と判断した指摘が、報告された症状そのものだったことがある（LEV-140 → LEV-142）。回すなら、その指摘が報告の再現条件に関係しないことを PR 本文に書く。
- UI・保存経路を変更した場合は専用テスト Vault で実機確認し、実行条件・結果・証跡を `artifacts/` に残す。未実施なら明記する。モックの成功を実機の成功と呼ばない。
- `src/main.ts` は登録とライフサイクルに限定。core、layout、interaction は Obsidian に依存させない。
- Markdown が唯一の正本。閲覧でファイルを書き換えない。編集は最新 revision に対する原文範囲の差分とし、無関係な内容を再シリアライズしない。
- 開いた文書の変更は Editor 経由。閉じた文書は Vault.process 内で原文を照合。保存経路を二重に作らない。
- 内部・相対リンクの基準は元ファイル。MarkdownRenderer の Component は描画対象の寿命に合わせて解放する。
- 日本語 IME、Undo/Redo、同名見出し、外部変更、複数ビューは双方向編集の必須ケース。
- runtime はブラウザ互換。Node/Electron や個人パスを持ち込まない。公開 API と scoped CSS を使う。
- ランタイム依存を追加する前に、必要性・バンドル増分・モバイル互換性を記録する。
- 他プラグインは仕様の参考。MarkMind の非公開コードを流用しない。
- 本番 Vault をテスト対象にしない。自動準備はプロジェクト配下の `test-vault/` のみ。
- プライマリー（`projects/Mappy` のチェックアウト）は常に `main` に置く。ブランチ作業は `orca worktree create` で作った worktree で行い、プライマリーで `git checkout -b`／`git switch` を実行しない。
- 1 チケット＝1 worktree＝1 エージェント（`docs/linear-workflow.md`）。**worktree を作る前に `ListAgents` と `orca worktree list` でそのチケットの先客を確認する。いれば新しく作らず、そこにも入らない。** 共有された作業ツリーでは「自分の変更だけを戻す」が成立しない（相手の削除を自分の復元が打ち消す）。触ってしまったら、状態を保存して相手に渡す。
- 1 セッションで複数のチケットを渡り歩かない。長いセッションほど、序盤に読んだ規約が行動の直前に思い出されなくなる。
- `main.js`、`node_modules/`、`dist/`、証跡をコミットしない。ライセンスは MIT、名称は `Mappy`、plugin ID は `mappy`（2026-09-20 の本人決定。`docs/product-plan.md` の M5 行）。
- 開発メモリは Basic Memory のプロジェクト `mappy-memory`（実体はプライマリーの `memory/`。git 管理外）。`artifacts/` は 1 回の実行の証跡、`memory/` は残す知識（何をしたか・なぜか・何が壊れていたか）。カテゴリは `events/`（実装・リリース）・`bugfixes/`・`investigations/`・`designs/`・`reviews/`・`corrections/`・`archive/` で、`memory/` 直下には置かない。
- **セッション開始時に `bm tool read-note corrections/lessons --project mappy-memory` を実行して蒸留済みの教訓を読む。** ファイルを開きに行かない。`memory/` は git 管理外なのでワークツリーには存在せず（このファイルはブランチ作業を worktree で行えと命じている）、パスで読もうとすると必ず空振りする。`memory-manager` スキルはトリガー起動でセッション開始時には読み込まれないので、コマンドはここに置く。
- 作業が終わったらメモリに残す。新しいノートは `bm tool write-note --project mappy-memory`、既存ノートの書き換えは `bm tool edit-note <permalink> --project mappy-memory --operation <append|prepend|replace_section|find_replace> --content '...'`（本文はシングルクォートで囲み、`'` だけ `'\''` と書く。二重引用符ではバッククォートと `$` がシェルに展開されて黙って消える）。検索は `bm tool search-notes '...' --project mappy-memory`。**同じタイトルで `write-note` を 2 回打つと `NOTE_ALREADY_EXISTS`（終了コード 1、`action: "conflict"`、`file_path: null`）で何も書かれない。** `--overwrite` は `{folder}/{title}.md` のファイルにしか当たらず、ファイル名とタイトルが違うノート（`corrections/` の 3 つはどれもこの形）では既存を変えずに別のノートを作る（詳細は SKILL.md「既存のノートに追記する」）。**既存のノートを書き換えるときは必ず permalink を指定する `edit-note` を使い、`write-note` は新規専用とする。** 積み上げるノートは `edit-note --operation append`（末尾が `## Relations` のノートは次の項）。
- ノートの frontmatter には `permalink: {カテゴリ}/{英語スラッグ}` と `type: {カテゴリの単数形}` を必ず書く。省略すると既定に落ちて、次の 3 つが別々に効く。(1) permalink に `mappy-memory/` が前置され、`search-notes --permalink '{カテゴリ}/*'` から漏れる。(2) 日本語タイトルはスラッグがローマ字混じりの断片に化けるので、意図した `{カテゴリ}/{英語スラッグ}` では `read-note` も `[[wiki link]]` も当たらない（**前置だけなら当たる** —— どちらもタイトルからの解決が効く。当てを外すのはスラッグの化けの方）。(3) `type` が `note` になり、`search-notes --type` と `schema-validate {型}` から外れる。CLI と MCP のどちらで書いても同じで、効いているのは frontmatter の明示であって CLI への切り替えではない。
- ミスをしたら `corrections/inbox` の `## 未蒸留` の末尾に、**行頭の** `## Relations` を目印にした `bm tool edit-note corrections/inbox --project mappy-memory --operation find_replace` で 1 件足す。**コマンドは SKILL.md「corrections」のコードブロックをそのまま写す**（引用符・改行の置き方に意味があり、崩すと見出しが潰れるか本文の語が黙って消える。理由はそちらに書いてある）。`--content` に既存のエントリを含めない。**`append` を使わない** —— `inbox` も `lessons` も末尾が `## Relations` で、`append` はファイル末尾に足すため、記録が Relations の後ろに落ちて節の構造が崩れる。**`## 未蒸留` を `replace_section` で狙わない** —— 置き換わるのは見出しから最初の `###` の手前（空の範囲）だけなので、既存＋新規を渡すと既存が重複する。目印が 1 か所に当たらない（2 つある・無い）と `find_replace` は何も書かずに終了コード 1 で止まるので、inbox の形を `read-note` で見てから打ち直す。**`append` は当て先が無い permalink へ打つとエラーにならず、`mappy-memory/` を前置した別のノートが黙って作られる**（`replace_section`・`find_replace` は `Entity not found` で止まる）ので、先に `bm tool read-note corrections/inbox --project mappy-memory` で在ることを確かめる。`lessons` は節の中身が平らなリストなので `replace_section` では節ごと消える（`find_replace` を使う。SKILL.md「corrections」）。そこから先の流れ（inbox → lessons → graduated）は `memory/schemas/correction.md` が正本で、このファイルにもスキルにも写さない（`bm tool read-note schemas/correction --project mappy-memory` で読む）。
- 詳細は `.claude/skills/memory-manager/SKILL.md`。ここと SKILL.md を直したら `npm run harness:e2e:memory-procedure` を回す（使い捨ての Basic Memory プロジェクトを作って実行し、最後に消す。`mappy-memory` には触らない）。固定しているのは **bm CLI の挙動**と、手順書に必須の記述が残っていることの 2 つで、書いた文章が正しいかまでは見ない。文面を変えたら同じブランチでケースも直す。

現在はベータ（0.x）を GitHub Release ＋ BRAT で公開中（0.1.0〜0.2.1 は 2026-09-20、0.3.0・0.3.1 は 2026-09-21、0.3.2〜0.3.4 は 2026-09-22。最新は 0.3.4。各版の中身は `docs/product-plan.md` §5 M5。コミュニティ審査は未提出）。実装の存在と受入条件の達成は分けて扱い、実機テストの完成を先取りして報告しない。
