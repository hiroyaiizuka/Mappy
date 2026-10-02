// docs/architecture.md §11.4 の型（LEV-270・LEV-271・LEV-273 が共有する。形を変えるときは §11.4 を先に直す）。
export type AiTemplate = 'summary' | 'brainstorm' | 'issue-tree' | 'free';

export interface AiRequest {
  engine: 'claude' | 'codex';
  template: AiTemplate;
  instruction: string;          // 本人の頼みごと（自由のときはこれだけ）
  depth: 1 | 2 | 3;             // 返させる階層
  webSearch: boolean;
  context: { ancestors: string[]; title: string; body: string };  // 祖先の題名（根から）と、選んだノードの題名・本文
  materials: AiMaterial[];      // §11.2 で用意したもの（無ければ空）
}

export type AiMaterial = { kind: 'youtube' | 'pdf' | 'note'; label: string; text: string };

export type AiProgress =
  | { stage: 'material'; label: string }                      // 字幕を取得中・PDF を読み取り中
  | { stage: 'starting' }
  | { stage: 'searching'; query: string }
  | { stage: 'fetching'; url: string }
  | { stage: 'thinking' }
  | { stage: 'writing' };

export interface OutlineItem { text: string; children: OutlineItem[] }

export type AiResult =
  | { kind: 'outline'; items: OutlineItem[]; dropped: number; raw: string }  // dropped: 捨てた行の数
  | { kind: 'refused'; reason: string; raw: string }       // 「取得できませんでした: …」
  | { kind: 'failed'; reason: AiFailure; detail: string }
  | { kind: 'cancelled' };

export type AiFailure =
  | 'engine-missing'        // CLI が見つからない（導入の案内を出す）
  | 'ytdlp-missing'         // yt-dlp が見つからない（導入の案内を出す）
  | 'unsupported-platform'  // Windows など（§11.3）
  | 'not-logged-in'         // CLI が未ログイン・API キーが無い
  | 'no-subtitles'          // 字幕の無い動画
  | 'no-pdf-text'           // テキストの無い PDF（スキャン）
  | 'material-too-large'    // 素材が 200,000 文字超・PDF が 50 MB 超（detail に大きさと上限）
  | 'material-failed'       // yt-dlp・pdf.js・ノートの読み取りの失敗
  | 'timeout'               // 無出力・全体の時間切れ
  | 'output-too-large'      // 標準出力が 5 MB 超
  | 'unparsable'            // 箇条書きが 1 つも残らない
  | 'exited'                // CLI が 0 以外で終わった（detail に stderr の末尾）
  | 'not-entitled';         // ライセンスが有効でない（ランナーを作ったあとに失効した。§11.6。設定の「AI」へ案内する）

export interface AiRunner {
  run(request: AiRequest, onProgress: (progress: AiProgress) => void, signal: AbortSignal): Promise<AiResult>;
}
