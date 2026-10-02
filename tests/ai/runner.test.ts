import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiMaterial, AiProgress, AiRequest } from '../../src/ai/contract';
import type { VaultMaterials } from '../../src/ai/obsidian/material';
import { createCliRunner } from '../../src/ai/runner';
import { DEFAULT_AI_PREFS, EMPTY_PATHS, type RunnerPaths } from '../../src/ai/settings';
import { FakeHost, type FakeChild, type FakeHostOptions } from './fake-host';

/** The real runner with the processes mocked: a CLI "runs" by replaying a recorded stream (tests/fixtures/ai). */

beforeEach(() => { vi.stubGlobal('window', globalThis); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const fixture = (name: string): string[] => readFileSync(new URL(`../fixtures/ai/${name}`, import.meta.url), 'utf8').split('\n').filter(Boolean);

const SHIMS = '/Users/user/.local/share/mise/shims';
const CODEX_JS = '/Users/user/.local/share/mise/installs/npm-openai-codex/0.156.1/lib/node_modules/@openai/codex/bin/codex.js';

const request: AiRequest = {
  engine: 'claude', template: 'brainstorm', instruction: '観点を挙げて', depth: 2, webSearch: false,
  context: { ancestors: ['Root'], title: 'マインドマップ', body: '' }, materials: [],
};

/** Replays `name` and exits with `code` for the engine; yt-dlp runs as `ytdlp` says. */
function replaying(name: string, code = 0, ytdlp?: (child: FakeChild) => void): (child: FakeChild) => void {
  return child => {
    queueMicrotask(() => {
      if (child.file.endsWith('yt-dlp')) { ytdlp?.(child); return; }
      child.lines(fixture(name));
      child.close(code);
    });
  };
}

function runner(options: FakeHostOptions, paths: Partial<RunnerPaths> = {}, vault: VaultMaterials | null = null) {
  const host = new FakeHost(options);
  const run = createCliRunner({
    host, prefs: () => DEFAULT_AI_PREFS, paths: () => ({ ...EMPTY_PATHS, ...paths }), vault, language: () => 'ja',
  });
  const progress: AiProgress[] = [];
  return { host, progress, run: (input: AiRequest, signal = new AbortController().signal) => run.run(input, step => { progress.push(step); }, signal) };
}

describe('the real runner with Claude', () => {
  it('starts the found claude read-only in an empty temporary directory, the prompt on standard input', async () => {
    const { host, progress, run } = runner({ executables: [`${SHIMS}/claude`], onSpawn: replaying('claude-partial.jsonl') });
    const result = await run(request);
    expect(result.kind).toBe('outline');
    const [child] = host.children;
    expect(child?.file).toBe(`${SHIMS}/claude`);
    expect(child?.args).toEqual(expect.arrayContaining(['-p', '--restricted', '--safe-mode', '--tools', '', '--allowedTools', '']));
    expect(child?.options.cwd).toBe(host.made[0]);
    expect(child?.options.env).toMatchObject({ USER: 'user', HOME: '/Users/user', PATH: `${SHIMS}:/usr/bin:/bin` });
    expect(child?.stdinText.join('')).toContain('## 頼みごと\n\n観点を挙げて');
    // The directory goes whatever happened.
    expect(host.removed).toEqual(host.made);
    expect(progress).toEqual(expect.arrayContaining([{ stage: 'starting' }, { stage: 'thinking' }, { stage: 'writing' }]));
  });

  it('uses the path in the settings and nothing else', async () => {
    const { host, run } = runner({ executables: [`${SHIMS}/claude`, '/opt/claude'], onSpawn: replaying('claude-partial.jsonl') }, { claude: '/opt/claude' });
    await run(request);
    expect(host.children[0]?.file).toBe('/opt/claude');
    const missing = runner({ executables: [`${SHIMS}/claude`] }, { claude: '/nowhere/claude' });
    await expect(missing.run(request)).resolves.toEqual({ kind: 'failed', reason: 'engine-missing', detail: 'claude' });
    expect(missing.host.children).toEqual([]);
  });

  it('stops with engine-missing when claude is nowhere, starting nothing', async () => {
    const { host, run } = runner({});
    await expect(run(request)).resolves.toEqual({ kind: 'failed', reason: 'engine-missing', detail: 'claude' });
    expect(host.children).toEqual([]);
  });

  it('reports not-logged-in', async () => {
    const { run } = runner({ executables: [`${SHIMS}/claude`], onSpawn: replaying('claude-not-logged-in.jsonl', 1) });
    await expect(run(request)).resolves.toMatchObject({ kind: 'failed', reason: 'not-logged-in' });
  });

  it('reports a non-zero exit without an answer with the end of standard error', async () => {
    const { run } = runner({ executables: [`${SHIMS}/claude`], onSpawn: child => { queueMicrotask(() => { child.err('boom\n'); child.close(2); }); } });
    await expect(run(request)).resolves.toEqual({ kind: 'failed', reason: 'exited', detail: 'boom' });
  });

  it('reads the refusal line as refused', async () => {
    const { run } = runner({ executables: [`${SHIMS}/claude`], onSpawn: replaying('claude-refused.jsonl') });
    await expect(run(request)).resolves.toMatchObject({ kind: 'refused' });
  });

  it('is cancelled by the signal, whatever the CLI exits with, and still removes the directory', async () => {
    const controller = new AbortController();
    const { host, run } = runner({
      executables: [`${SHIMS}/claude`],
      onSpawn: child => { queueMicrotask(() => { child.lines(fixture('claude-partial.jsonl').slice(0, 3)); controller.abort(); }); },
      onKill: (child, signal) => { if (signal === 'SIGTERM') queueMicrotask(() => { child.close(0); }); return true; },
    });
    await expect(run(request, controller.signal)).resolves.toEqual({ kind: 'cancelled' });
    expect(host.kills).toEqual([{ pid: 1000, signal: 'SIGTERM' }]);
    expect(host.removed).toEqual(host.made);
  });

  it('times out when the CLI goes silent for 90 seconds', async () => {
    vi.useFakeTimers();
    const { run } = runner({ executables: [`${SHIMS}/claude`], onSpawn: child => { queueMicrotask(() => { child.lines(fixture('claude-partial.jsonl').slice(0, 2)); }); } });
    const done = run(request);
    await vi.advanceTimersByTimeAsync(89_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(done).resolves.toEqual({ kind: 'failed', reason: 'timeout', detail: 'idle' });
  });
});

describe('the real runner with Codex', () => {
  const codexRequest: AiRequest = { ...request, engine: 'codex', webSearch: true };

  it("runs an npm install's codex.js through node, with --search", async () => {
    const { host, run } = runner({
      executables: [`${SHIMS}/node`, '/opt/homebrew/bin/codex'], links: { '/opt/homebrew/bin/codex': CODEX_JS },
      onSpawn: replaying('codex-search.jsonl'),
    });
    const result = await run(codexRequest);
    expect(result.kind).toBe('outline');
    const [child] = host.children;
    expect(child?.file).toBe(`${SHIMS}/node`);
    expect(child?.args.slice(0, 4)).toEqual([CODEX_JS, '--search', 'exec', '--ignore-user-config']);
    expect(child?.args.slice(-3)).toEqual(['-C', host.made[0], '-']);
  });

  it('runs the native binary when node is nowhere, and stops when that is missing too', async () => {
    const native = '/Users/user/.local/share/mise/installs/npm-openai-codex/0.156.1/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex';
    const { host, run } = runner({
      executables: ['/opt/homebrew/bin/codex', native], links: { '/opt/homebrew/bin/codex': CODEX_JS }, onSpawn: replaying('codex-transcript.jsonl'),
    });
    await expect(run(codexRequest)).resolves.toMatchObject({ kind: 'outline' });
    expect(host.children[0]?.file).toBe(native);
    expect(host.children[0]?.options.env).toMatchObject({ CODEX_MANAGED_BY_NPM: '1' });
    const none = runner({ executables: ['/opt/homebrew/bin/codex'], links: { '/opt/homebrew/bin/codex': CODEX_JS } });
    await expect(none.run(codexRequest)).resolves.toEqual({ kind: 'failed', reason: 'engine-missing', detail: 'codex' });
  });

  it('runs a mise shim as it is', async () => {
    const { host, run } = runner({ executables: [`${SHIMS}/codex`], links: { [`${SHIMS}/codex`]: '/Users/user/.local/bin/mise' }, onSpawn: replaying('codex-transcript.jsonl') });
    await run(codexRequest);
    expect(host.children[0]?.file).toBe(`${SHIMS}/codex`);
  });

  it('reports not-logged-in after the retries', async () => {
    const { run } = runner({ executables: [`${SHIMS}/codex`], onSpawn: replaying('codex-not-logged-in.jsonl', 1) });
    await expect(run(codexRequest)).resolves.toMatchObject({ kind: 'failed', reason: 'not-logged-in' });
  });
});

describe('materials', () => {
  const VIDEO = 'https://www.youtube.com/watch?v=M-cd7Q-Onhk&list=PL1';
  const info = JSON.stringify({ id: 'M-cd7Q-Onhk', language: 'ja', subtitles: {}, automatic_captions: { en: [], 'ja-orig': [] } });
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nこんにちは\n';

  function ytdlp(host: () => FakeHost) {
    return (child: FakeChild): void => {
      if (child.args.includes('--dump-single-json')) { child.out(`${info}\n`); child.close(0); return; }
      host().files.set(`${child.options.cwd}/M-cd7Q-Onhk.ja-orig.vtt`, vtt);
      child.close(0);
    };
  }

  it('fetches subtitles with the yt-dlp found, folds them and puts them last in the prompt', async () => {
    let fake: FakeHost | null = null;
    const setup = runner({
      executables: [`${SHIMS}/claude`, '/opt/homebrew/bin/yt-dlp'],
      onSpawn: replaying('claude-partial.jsonl', 0, ytdlp(() => fake as unknown as FakeHost)),
    });
    fake = setup.host;
    const material: AiMaterial = { kind: 'youtube', label: VIDEO, text: '' };
    await expect(setup.run({ ...request, materials: [material] })).resolves.toMatchObject({ kind: 'outline' });
    const [info, subtitles, claude] = setup.host.children;
    expect(info?.args).toEqual(['--ignore-config', '--no-playlist', '--skip-download', '--dump-single-json', '--', 'https://www.youtube.com/watch?v=M-cd7Q-Onhk']);
    expect(subtitles?.args).toEqual(expect.arrayContaining(['--write-auto-subs', '--sub-langs', 'ja-orig']));
    expect(claude?.stdinText.join('')).toMatch(/## 素材: https:\/\/www\.youtube\.com\/watch\?v=M-cd7Q-Onhk&list=PL1\n\n\[00:01\] こんにちは\n$/u);
    expect(setup.progress[0]).toEqual({ stage: 'material', label: VIDEO });
    // yt-dlp's directory and the CLI's both go.
    expect(setup.host.removed.sort()).toEqual(setup.host.made.sort());
  });

  it('stops with ytdlp-missing, starting nothing, when yt-dlp is nowhere', async () => {
    const { host, run } = runner({ executables: [`${SHIMS}/claude`] });
    await expect(run({ ...request, materials: [{ kind: 'youtube', label: VIDEO, text: '' }] })).resolves.toEqual({ kind: 'failed', reason: 'ytdlp-missing', detail: '' });
    expect(host.children).toEqual([]);
  });

  it('stops with no-subtitles when only machine translations exist', async () => {
    const { run } = runner({
      executables: [`${SHIMS}/claude`, '/opt/homebrew/bin/yt-dlp'],
      onSpawn: child => { queueMicrotask(() => { child.out(`${JSON.stringify({ language: 'en', automatic_captions: { ja: [] } })}\n`); child.close(0); }); },
    });
    await expect(run({ ...request, materials: [{ kind: 'youtube', label: VIDEO, text: '' }] })).resolves.toMatchObject({ kind: 'failed', reason: 'no-subtitles' });
  });

  it('reads PDFs and notes through the vault, and stops before starting anything over 200,000 characters', async () => {
    const pdf = vi.fn<VaultMaterials["pdf"]>(() => Promise.resolve({ kind: 'ok' as const, text: 'p'.repeat(150_000) }));
    const note = vi.fn<VaultMaterials["note"]>(() => Promise.resolve({ kind: 'ok' as const, text: 'n'.repeat(60_000) }));
    const vault: VaultMaterials = { pdf, note };
    const { host, run } = runner({ executables: [`${SHIMS}/claude`] }, {}, vault);
    const result = await run({ ...request, materials: [{ kind: 'pdf', label: 'a.pdf', text: '' }, { kind: 'note', label: 'b.md', text: '' }] });
    expect(result).toEqual({ kind: 'failed', reason: 'material-too-large', detail: '210000 / 200000' });
    expect(pdf).toHaveBeenCalledWith('a.pdf', expect.anything());
    expect(note).toHaveBeenCalledWith('b.md');
    expect(host.children).toEqual([]);
  });

  it('passes a material that already has its text as it is, and reports the vault’s failure', async () => {
    const vault: VaultMaterials = {
      pdf: () => Promise.resolve({ kind: 'failed' as const, reason: 'no-pdf-text' as const, detail: 'scan.pdf' }),
      note: () => Promise.resolve({ kind: 'ok' as const, text: '' }),
    };
    const ready = runner({ executables: [`${SHIMS}/claude`], onSpawn: replaying('claude-partial.jsonl') }, {}, vault);
    await ready.run({ ...request, materials: [{ kind: 'note', label: 'given.md', text: 'given text' }] });
    expect(ready.host.children[0]?.stdinText.join('')).toContain('## 添付: given.md\n\ngiven text');
    const scanned = runner({ executables: [`${SHIMS}/claude`] }, {}, vault);
    await expect(scanned.run({ ...request, materials: [{ kind: 'pdf', label: 'scan.pdf', text: '' }] })).resolves.toEqual({ kind: 'failed', reason: 'no-pdf-text', detail: 'scan.pdf' });
  });
});
