import { LIMITS, launchEnv, dirname, ytdlpInfoArgs, ytdlpSubtitleArgs } from '../core/launch';
import type { MaterialText } from '../core/material-text';
import { vttToTranscript } from '../core/vtt';
import { pickSubtitle, type VideoInfo } from '../core/youtube';
import { runCli, type CliEnd } from './cli-process';
import type { NodeHost } from './node-host';

/**
 * A YouTube video's subtitles through the yt-dlp the person installed (docs/architecture.md §11.2). Mappy never
 * installs or updates it. Two runs in an empty temporary directory: the video's metadata (which tracks there are, and
 * the video's language), then the one chosen track as VTT, folded into `[mm:ss]` paragraphs.
 */

/** The JSON for one video is large (every format is listed), well past the CLI's 5 MB. */
const INFO_MAX_BYTES = 64 * 1024 * 1024;

function failure(end: CliEnd, step: string): MaterialText {
  switch (end.kind) {
    case 'cancelled': return { kind: 'cancelled' };
    case 'timeout': return { kind: 'failed', reason: 'material-failed', detail: `yt-dlp (${step}): timeout` };
    case 'output-too-large': return { kind: 'failed', reason: 'material-failed', detail: `yt-dlp (${step}): output too large` };
    case 'spawn-failed': return { kind: 'failed', reason: 'ytdlp-missing', detail: end.error };
    case 'exited': return { kind: 'failed', reason: 'material-failed', detail: `yt-dlp (${step}) exited ${end.code ?? end.signal ?? ''}: ${end.stderr.trim().slice(-600)}` };
  }
}

export async function fetchTranscript(
  host: NodeHost, ytdlp: string, url: string, uiLanguage: string, signal: AbortSignal, killNow?: AbortSignal,
): Promise<MaterialText> {
  let cwd: string | null = null;
  try {
    cwd = await host.mkdtemp('mappy-ai-');
    const env = launchEnv(host.env(), { pathDirs: [dirname(ytdlp)], env: {} });
    const spec = { file: ytdlp, cwd, env, stdin: '', idleMs: LIMITS.ytdlpMs, totalMs: LIMITS.ytdlpMs, ...(killNow ? { killNow } : {}) };
    let json = '';
    const info = await runCli(host, { ...spec, args: ytdlpInfoArgs(url), maxOutputBytes: INFO_MAX_BYTES }, line => { json += line; }, signal);
    if (info.kind !== 'exited' || info.code !== 0) return failure(info, 'info');
    let parsed: VideoInfo;
    try {
      parsed = JSON.parse(json) as VideoInfo;
    } catch {
      return { kind: 'failed', reason: 'material-failed', detail: 'yt-dlp (info): not JSON' };
    }
    const choice = pickSubtitle(parsed, uiLanguage);
    if (choice === null) return { kind: 'failed', reason: 'no-subtitles', detail: url };
    const download = await runCli(host, { ...spec, args: ytdlpSubtitleArgs(url, choice, cwd) }, () => undefined, signal);
    if (download.kind !== 'exited' || download.code !== 0) return failure(download, 'subtitles');
    const file = (await host.readdir(cwd)).find(name => name.endsWith('.vtt'));
    if (file === undefined) return { kind: 'failed', reason: 'no-subtitles', detail: `${url} (${choice.language})` };
    const text = vttToTranscript(await host.readText(`${cwd}/${file}`));
    return text ? { kind: 'ok', text } : { kind: 'failed', reason: 'no-subtitles', detail: `${url} (${choice.language})` };
  } catch (error) {
    // The temporary directory or the subtitle file could not be made or read.
    return { kind: 'failed', reason: 'material-failed', detail: `yt-dlp: ${String(error)}` };
  } finally {
    if (cwd !== null) await host.rm(cwd).catch(() => undefined);
  }
}
