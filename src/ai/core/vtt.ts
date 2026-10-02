/**
 * A WebVTT subtitle file folded into `[mm:ss] text` paragraphs of about 30 seconds (docs/architecture.md §11.2), the
 * rule of the stage-0 `vtt2txt.py` (artifacts/lev-268). YouTube's automatic captions roll: each cue repeats the line
 * before it and adds the new one word by word (`<c>` tags, then a 10 ms cue showing it plain), so a line is kept only
 * when it is not one of the last few kept.
 */

const CUE = /^(?:(\d+):)?(\d{2}):(\d{2})\.\d{3}\s+-->/u;
const PARAGRAPH_SECONDS = 30;
/** How far back a repeated line counts as the rolling display's echo rather than something said again. */
const ECHO_WINDOW = 3;

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&quot;': '"', '&#39;': "'" };

function plain(line: string): string {
  return line
    .replace(/<[^>]*>/gu, '')
    .replace(/&(?:amp|lt|gt|nbsp|quot|#39);/gu, entity => ENTITIES[entity] ?? entity)
    .replace(/\s+/gu, ' ')
    .trim();
}

function stamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `[${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}]`;
}

/** The subtitle's lines with the second each was shown at, rolling echoes removed. */
export function vttLines(vtt: string): { at: number; text: string }[] {
  const lines: { at: number; text: string }[] = [];
  let at: number | null = null;
  let inNote = false;
  for (const raw of vtt.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const cue = raw.match(CUE);
    if (cue) {
      at = Number(cue[1] ?? 0) * 3600 + Number(cue[2]) * 60 + Number(cue[3]);
      inNote = false;
      continue;
    }
    if (raw.trim() === '') { inNote = false; continue; }
    if (/^(?:NOTE|STYLE|REGION)\b/u.test(raw)) { inNote = true; continue; }
    // The header and its metadata (`Kind:`, `Language:`) come before the first cue.
    if (at === null || inNote) continue;
    const text = plain(raw);
    if (!text || lines.slice(-ECHO_WINDOW).some(line => line.text === text)) continue;
    lines.push({ at, text });
  }
  return lines;
}

/** `[mm:ss] text` paragraphs, one per line; a paragraph closes once a line starts 30 seconds after it began. */
export function vttToTranscript(vtt: string): string {
  const paragraphs: string[] = [];
  let start: number | null = null;
  let words: string[] = [];
  for (const line of vttLines(vtt)) {
    if (start !== null && line.at - start >= PARAGRAPH_SECONDS && words.length > 0) {
      paragraphs.push(`${stamp(start)} ${words.join(' ')}`);
      start = null;
      words = [];
    }
    start ??= line.at;
    words.push(line.text);
  }
  if (start !== null && words.length > 0) paragraphs.push(`${stamp(start)} ${words.join(' ')}`);
  return paragraphs.join('\n');
}
