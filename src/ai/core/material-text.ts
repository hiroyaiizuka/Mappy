import type { AiFailure } from '../contract';

/** One material's text as its source gave it (yt-dlp's subtitles, a PDF, a note), or why there is none. */
export type MaterialText =
  | { kind: 'ok'; text: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason: AiFailure; detail: string };
