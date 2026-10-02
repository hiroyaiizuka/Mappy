/**
 * YouTube videos (docs/architecture.md §11.2): which URLs are one, and which subtitle track to take from what
 * `yt-dlp --dump-single-json` reports. Pure, so the choice is tested without yt-dlp.
 */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;

/**
 * The video a URL names, as `https://www.youtube.com/watch?v=<id>`, or null. `watch?v=`, `youtu.be/` and `/shorts/`
 * are recognized; a playlist parameter is dropped (the run takes only the video that was open, with `--no-playlist`).
 */
export function youtubeVideoUrl(text: string): string | null {
  let url: URL;
  try { url = new URL(text.trim()); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^(?:www|m)\./u, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1] ?? null;
  else if (host === 'youtube.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else if (url.pathname.startsWith('/shorts/')) id = url.pathname.split('/')[2] ?? null;
  }
  return id !== null && VIDEO_ID.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
}

/** The part of `--dump-single-json` the choice reads. */
export interface VideoInfo {
  language?: string | null;
  subtitles?: Record<string, unknown> | null;
  automatic_captions?: Record<string, unknown> | null;
}

export interface SubtitleChoice {
  /** The key to pass to `--sub-langs`. */
  language: string;
  /** Automatic captions (`--write-auto-subs`) rather than uploaded ones (`--write-subs`). */
  automatic: boolean;
}

/** `en` for `en`, `en-US` and `en-eEY6OEpapPo` (uploaded tracks carry a suffix, artifacts/lev-270 y-dump-UF8uR6Z6KLc). */
function base(language: string): string {
  return (language.split('-')[0] ?? language).toLowerCase();
}

function keys(tracks: Record<string, unknown> | null | undefined): string[] {
  // `live_chat` is a replay of a stream's chat, not subtitles.
  return Object.keys(tracks ?? {}).filter(key => key !== 'live_chat');
}

/**
 * The track to summarize from: (a) an uploaded track in the video's own language → (b) one in the UI's language →
 * (c) any uploaded track → (d) the automatic captions in the video's own language (`<language>-orig`, or the key equal
 * to `language`). A machine-translated automatic track (another language's `automatic_captions`) is never taken: its
 * quality is worse and it is the one YouTube rate-limits. Null when there is nothing to take.
 */
export function pickSubtitle(info: VideoInfo, uiLanguage: string): SubtitleChoice | null {
  const manual = keys(info.subtitles);
  const original = info.language ? info.language : null;
  const prefer = (want: string | null): string | undefined => {
    if (want === null) return undefined;
    return manual.find(key => key === want) ?? manual.find(key => base(key) === base(want));
  };
  const uploaded = prefer(original) ?? prefer(uiLanguage) ?? manual[0];
  if (uploaded !== undefined) return { language: uploaded, automatic: false };
  const automatic = keys(info.automatic_captions);
  let orig: string | undefined;
  if (original !== null) {
    // `language` can carry a region (`en-US`) the caption keys do not (`en-orig`, `en`).
    const wanted = [`${original}-orig`, `${base(original)}-orig`, original, base(original)];
    orig = wanted.map(want => automatic.find(key => key === want)).find(key => key !== undefined);
  } else {
    // Without the video's language only an `-orig` track tells itself apart, and only when it is the one: a video
    // with dubbed audio lists one per language (artifacts/lev-270: `ar-orig`, `en-orig`, `ja-orig`, … on one video).
    const origs = automatic.filter(key => key.endsWith('-orig'));
    orig = origs.length === 1 ? origs[0] : undefined;
  }
  return orig !== undefined ? { language: orig, automatic: true } : null;
}
