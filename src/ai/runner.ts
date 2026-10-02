import type { AiFailure, AiMaterial, AiProgress, AiRequest, AiResult, AiRunner } from './contract';
import { claudeReader, codexReader, type StreamOutcome } from './core/events';
import { LIMITS, claudeInvocation, codexInvocation, dirname, idleTimeoutMs, launchEnv, totalTimeoutMs, type Invocation } from './core/launch';
import type { MaterialText } from './core/material-text';
import { outlineResult } from './core/outline';
import { buildPrompt, type PromptLanguage } from './core/prompt';
import { youtubeVideoUrl } from './core/youtube';
import { runCli, type CliEnd } from './host/cli-process';
import { locate, locateClaude, locateCodex } from './host/locate';
import type { NodeHost } from './host/node-host';
import { fetchTranscript } from './host/yt-dlp';
import type { VaultMaterials } from './obsidian/material';
import type { AiPrefs, RunnerPaths } from './settings';

/**
 * The real `AiRunner` (docs/architecture.md §11.3, §11.4): it prepares the materials, starts the chosen CLI read-only
 * in an empty temporary directory with the instruction on standard input, turns its event stream into progress, and
 * reads the final answer leniently. A material whose `text` is empty is fetched here from its `label` (a YouTube URL,
 * or a vault path for a PDF or a note); one with text is used as it is.
 */

export interface CliRunnerDeps {
  host: NodeHost;
  prefs: () => AiPrefs;
  paths: () => RunnerPaths;
  /** Null where there is no vault to read (the materials then have to come with their text). */
  vault: VaultMaterials | null;
  /** The UI's language: the instruction's, the answer's, and the one a subtitle track is preferred in. */
  language: () => PromptLanguage;
  /** Fires when Mappy is going away: every process is killed at once (see `CliSpec.killNow`). */
  killNow?: () => AbortSignal;
}

function failed(reason: AiFailure, detail: string): AiResult {
  return { kind: 'failed', reason, detail };
}

type Prepared = { kind: 'ok'; materials: AiMaterial[] } | { kind: 'stop'; result: AiResult };

/** A material's text from its source: yt-dlp for a video, the vault for a PDF or a note. */
async function fetchMaterial(
  deps: CliRunnerDeps, material: AiMaterial, onProgress: (progress: AiProgress) => void, signal: AbortSignal,
): Promise<MaterialText> {
  onProgress({ stage: 'material', label: material.label });
  if (material.kind === 'youtube') {
    const url = youtubeVideoUrl(material.label);
    if (url === null) return { kind: 'failed', reason: 'material-failed', detail: material.label };
    const ytdlp = await locate(deps.host, 'yt-dlp', deps.paths()['yt-dlp']);
    if (ytdlp === null) return { kind: 'failed', reason: 'ytdlp-missing', detail: '' };
    return fetchTranscript(deps.host, ytdlp, url, deps.language(), signal, deps.killNow?.());
  }
  if (deps.vault === null) return { kind: 'failed', reason: 'material-failed', detail: material.label };
  return material.kind === 'pdf' ? deps.vault.pdf(material.label, signal) : deps.vault.note(material.label);
}

async function prepareMaterials(
  deps: CliRunnerDeps, materials: readonly AiMaterial[], onProgress: (progress: AiProgress) => void, signal: AbortSignal,
  ownText: number,
): Promise<Prepared> {
  const ready: AiMaterial[] = [];
  for (const material of materials) {
    if (signal.aborted) return { kind: 'stop', result: { kind: 'cancelled' } };
    if (material.text !== '') ready.push(material);
    else {
      const fetched = await fetchMaterial(deps, material, onProgress, signal);
      if (fetched.kind !== 'ok') return { kind: 'stop', result: fetched.kind === 'cancelled' ? { kind: 'cancelled' } : failed(fetched.reason, fetched.detail) };
      ready.push({ ...material, text: fetched.text });
    }
    // Checked after each one, so a run already over the limit does not go on to fetch the rest.
    // The selected node's body and the request go into the same prompt: they count too.
    const size = ownText + ready.reduce((sum, item) => sum + item.text.length, 0);
    if (size > LIMITS.materialMaxChars) {
      // Cutting the text would make "a summary of the whole" untrue: stop and say how large it is.
      return { kind: 'stop', result: failed('material-too-large', `${size} / ${LIMITS.materialMaxChars}`) };
    }
  }
  if (ownText > LIMITS.materialMaxChars) return { kind: 'stop', result: failed('material-too-large', `${ownText} / ${LIMITS.materialMaxChars}`) };
  return { kind: 'ok', materials: ready };
}

/** The invocation, or why there is none: the engine is not found, or it needs a node that is not found. */
async function invocationFor(deps: CliRunnerDeps, request: AiRequest, cwd: string): Promise<Invocation | 'missing' | 'no-node'> {
  const prefs = deps.prefs();
  const paths = deps.paths();
  let invocation: Invocation;
  let node: string | null;
  if (request.engine === 'claude') {
    const claude = await locateClaude(deps.host, paths.claude);
    if (claude === null) return 'missing';
    if (claude === 'no-node') return 'no-node';
    node = claude.node;
    invocation = claudeInvocation(claude.file, { model: prefs.claudeModel, webSearch: request.webSearch, ...(claude.script && claude.node !== null ? { node: claude.node } : {}) });
  } else {
    const codex = await locateCodex(deps.host, paths.codex);
    if (codex === null) return 'missing';
    if (codex === 'no-node') return 'no-node';
    node = codex.node;
    invocation = codexInvocation(codex.launch, { model: prefs.codexModel, webSearch: request.webSearch, cwd });
  }
  // A wrapper that is not a script itself may still call `node` from PATH (pnpm's global bin): put node's directory there too.
  return node === null || invocation.pathDirs.includes(dirname(node)) ? invocation : { ...invocation, pathDirs: [...invocation.pathDirs, dirname(node)] };
}

function endResult(end: CliEnd, outcome: StreamOutcome, depth: number): AiResult {
  switch (end.kind) {
    case 'cancelled': return { kind: 'cancelled' };
    case 'timeout': return failed('timeout', end.which);
    case 'output-too-large': return failed('output-too-large', `${LIMITS.outputMaxBytes} bytes`);
    // Only a missing file is "not installed"; a file that cannot be run (EACCES, E2BIG…) is another failure.
    case 'spawn-failed': return failed(/ENOENT/u.test(end.error) ? 'engine-missing' : 'exited', end.error);
    case 'exited':
      if (outcome.notLoggedIn) return failed('not-logged-in', outcome.error ?? end.stderr.trim().slice(-600));
      // An answer counts only from a CLI that ended well: a message before a crash is not the answer.
      if (outcome.text !== null && end.code === 0) return outlineResult(outcome.text, depth);
      return failed('exited', outcome.error ?? (end.stderr.trim().slice(-600) || `exit ${end.code ?? end.signal ?? ''}`));
  }
}

export function createCliRunner(deps: CliRunnerDeps): AiRunner {
  return {
    async run(request, onProgress, signal) {
      // The contract is a result, never a rejection: what the host throws (a temporary directory that cannot be made,
      // a file that cannot be read) comes back as a failure the UI can show.
      // A progress handler that throws (a view already gone) must not lose the lines after it, or the answer.
      const report = (progress: AiProgress): void => {
        try { onProgress(progress); } catch { /* the display failed; the run goes on */ }
      };
      try {
        return await runOnce(deps, request, report, signal);
      } catch (error) {
        // §11.4 has no kind for "the host failed"; `exited` with the error as detail is the nearest. A run the
        // person had already cancelled stays cancelled.
        return signal.aborted ? { kind: 'cancelled' } : failed('exited', String(error));
      }
    },
  };
}

async function runOnce(deps: CliRunnerDeps, request: AiRequest, onProgress: (progress: AiProgress) => void, signal: AbortSignal): Promise<AiResult> {
  if (signal.aborted) return { kind: 'cancelled' };
  const ownText = request.context.body.length + request.instruction.length;
  const prepared = await prepareMaterials(deps, request.materials, onProgress, signal, ownText);
  if (prepared.kind === 'stop') return prepared.result;
  const prompt = buildPrompt({ ...request, materials: prepared.materials }, deps.language());
  const cwd = await deps.host.mkdtemp('mappy-ai-');
  try {
    const invocation = await invocationFor(deps, request, cwd);
    if (invocation === 'missing') return failed('engine-missing', request.engine);
    // Found, but it is a node script and there is no node: name node, not the engine, as what to install.
    if (invocation === 'no-node') return failed('engine-missing', `${request.engine}: node`);
    if (signal.aborted) return { kind: 'cancelled' };
    onProgress({ stage: 'starting' });
    const reader = request.engine === 'claude' ? claudeReader() : codexReader();
    const materialChars = ownText + prepared.materials.reduce((sum, material) => sum + material.text.length, 0);
    const end = await runCli(deps.host, {
      file: invocation.file, args: invocation.args, cwd, env: launchEnv(deps.host.env(), invocation), stdin: prompt,
      idleMs: idleTimeoutMs(materialChars), totalMs: totalTimeoutMs(materialChars),
      ...(deps.killNow ? { killNow: deps.killNow() } : {}),
    }, line => { for (const progress of reader.line(line)) onProgress(progress); }, signal);
    return endResult(end, reader.outcome(), request.depth);
  } finally {
    await deps.host.rm(cwd).catch(() => undefined);
  }
}
