/**
 * The types the three M9 tickets share (docs/architecture.md §11.4): the request the UI builds, the progress and the
 * result a runner reports, and the runner itself. The UI knows only `AiRunner`; the real one (LEV-270) starts the CLI,
 * the fake one (LEV-271) replays fixed steps. Change the shapes in §11.4 first, then here.
 */

export type AiTemplate = 'summary' | 'brainstorm' | 'issue-tree' | 'free';

export interface AiRequest {
  engine: 'claude' | 'codex';
  template: AiTemplate;
  /** What the person asked for (the whole request for `free`). */
  instruction: string;
  /** How many levels the answer may have. */
  depth: 1 | 2 | 3;
  webSearch: boolean;
  /** The titles of the ancestors (from the root) and the chosen node's title and body. */
  context: { ancestors: string[]; title: string; body: string };
  /** What §11.2 prepared (empty when there is none). */
  materials: AiMaterial[];
}

export type AiMaterial = { kind: 'youtube' | 'pdf' | 'note'; label: string; text: string };

export type AiProgress =
  | { stage: 'material'; label: string }
  | { stage: 'starting' }
  | { stage: 'searching'; query: string }
  | { stage: 'fetching'; url: string }
  | { stage: 'thinking' }
  | { stage: 'writing' };

export interface OutlineItem { text: string; children: OutlineItem[] }

export type AiResult =
  /** `dropped`: how many lines were not list items and were left out. */
  | { kind: 'outline'; items: OutlineItem[]; dropped: number; raw: string }
  /** The model said it could not get the material (「取得できませんでした: …」). */
  | { kind: 'refused'; reason: string; raw: string }
  | { kind: 'failed'; reason: AiFailure; detail: string }
  | { kind: 'cancelled' };

export type AiFailure =
  | 'engine-missing'        // the CLI was not found (show how to install it)
  | 'ytdlp-missing'         // yt-dlp was not found (show how to install it)
  | 'unsupported-platform'  // Windows and the like (§11.3)
  | 'not-logged-in'         // the CLI is not logged in / has no API key
  | 'no-subtitles'          // a video without subtitles
  | 'no-pdf-text'           // a PDF without text (scanned)
  | 'material-too-large'    // over 200,000 characters, or a PDF over 50 MB (detail: the size and the limit)
  | 'material-failed'       // yt-dlp, pdf.js or reading the note failed
  | 'timeout'               // no output for too long, or the whole run took too long
  | 'output-too-large'      // more than 5 MB on standard output
  | 'unparsable'            // not one list item survived
  | 'exited';               // the CLI ended with a non-zero code (detail: the end of stderr)

export interface AiRunner {
  run(request: AiRequest, onProgress: (progress: AiProgress) => void, signal: AbortSignal): Promise<AiResult>;
}
