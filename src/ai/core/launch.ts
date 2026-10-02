/**
 * How the CLIs are started (docs/architecture.md §11.3): the arguments, the environment, the limits, and where an
 * executable is looked for. Pure, so each is pinned by a unit test; `src/ai/host/` applies them through `NodeHost`.
 */

export type Engine = 'claude' | 'codex';
export type Tool = Engine | 'yt-dlp';

/** A process to start: the file, its arguments, and the variables to add to the inherited environment. */
export interface Invocation {
  file: string;
  args: string[];
  /** Directories to put in front of PATH (the executable's own, and node's when it runs a script). */
  pathDirs: string[];
  env: Record<string, string>;
}

/** How Codex is started once found (§11.3): through node and its `codex.js` when node is found, else the native binary. */
export type CodexLaunch =
  | { kind: 'direct'; file: string }
  | { kind: 'node'; node: string; script: string }
  | { kind: 'native'; binary: string; packageRoot: string };

export const LIMITS = {
  /** No line on standard output for this long ends the run (Codex once stopped silently for 10 minutes, stage 0 #15). */
  idleMs: 90_000,
  idleMaxMs: 5 * 60_000,
  /** The whole run: 5 minutes, 2 more per 50,000 characters of material, at most 15 minutes. */
  totalBaseMs: 5 * 60_000,
  totalStepMs: 2 * 60_000,
  totalStepChars: 50_000,
  totalMaxMs: 15 * 60_000,
  /** Standard output beyond this ends the run. */
  outputMaxBytes: 5 * 1024 * 1024,
  /** SIGTERM to the process group, then SIGKILL if anything is left after this. */
  killGraceMs: 3_000,
  /** The materials together, in UTF-16 code units; over it the run stops instead of cutting the text. */
  materialMaxChars: 200_000,
  pdfMaxBytes: 50 * 1024 * 1024,
  /** The login shell the settings' 「探す」 button runs once. */
  loginShellMs: 5_000,
  /** One yt-dlp step (the video's metadata, then the subtitle file). */
  ytdlpMs: 2 * 60_000,
} as const;

/**
 * Silence allowed before the run is stopped: 90 seconds, a minute more per 50,000 characters of material, at most 5
 * minutes. Codex prints nothing while it writes its answer (one `agent_message` at the end), and that wait grows with
 * the material: 27 seconds for about 40,000 characters and 23 seconds for 75,000 (artifacts/lev-270).
 */
export function idleTimeoutMs(materialChars: number): number {
  const steps = Math.ceil(Math.max(0, materialChars) / LIMITS.totalStepChars);
  return Math.min(LIMITS.idleMs + steps * 60_000, LIMITS.idleMaxMs);
}

export function totalTimeoutMs(materialChars: number): number {
  const steps = Math.ceil(Math.max(0, materialChars) / LIMITS.totalStepChars);
  return Math.min(LIMITS.totalBaseMs + steps * LIMITS.totalStepMs, LIMITS.totalMaxMs);
}

const WEB_TOOLS = 'WebSearch,WebFetch';

/**
 * `claude -p` with an allow-list of tools: none without web search, only WebSearch and WebFetch with it (a deny-list
 * left subagents and other tools, stage 0 #16). `--restricted` skips the settings files and hooks, `--safe-mode`
 * the rest of the customizations (it runs on a subscription login, artifacts/lev-270 c2), `--strict-mcp-config`
 * every MCP server. The instruction goes to standard input.
 */
export function claudeInvocation(file: string, options: { model: string; webSearch: boolean; node?: string }): Invocation {
  const tools = options.webSearch ? WEB_TOOLS : '';
  const args = [
    '-p', '--restricted', '--safe-mode', '--strict-mcp-config', '--no-session-persistence',
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--tools', tools, '--allowedTools', tools,
    ...(options.model.trim() ? ['--model', options.model.trim()] : []),
  ];
  // An npm install's `cli.js` needs node, which a GUI app's PATH may not have.
  if (options.node !== undefined) return { file: options.node, args: [file, ...args], pathDirs: [dirname(options.node), dirname(file)], env: {} };
  return { file, args, pathDirs: [dirname(file)], env: {} };
}

/**
 * `codex exec` read-only in an empty working directory. `--ignore-user-config` drops the person's config (its model,
 * plugins, hooks, provider), and the run still turned on the plugin cache's MCP server and a login shell that sources
 * `.zshrc` (shell snapshot), so those are switched off too (artifacts/lev-270 x2, x3, x5). The global
 * `~/.codex/AGENTS.md` is still read (x1, x2); the lenient reading of the output takes what it changes.
 */
export function codexInvocation(launch: CodexLaunch, options: { model: string; webSearch: boolean; cwd: string }): Invocation {
  const args = [
    ...(options.webSearch ? ['--search'] : []),
    'exec', '--ignore-user-config',
    '--disable', 'shell_snapshot', '--disable', 'plugins', '--disable', 'apps', '-c', 'mcp_servers={}',
    '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--json',
    '-c', 'model_reasoning_effort="medium"',
    ...(options.model.trim() ? ['-m', options.model.trim()] : []),
    '-C', options.cwd, '-',
  ];
  switch (launch.kind) {
    case 'direct':
      return { file: launch.file, args, pathDirs: [dirname(launch.file)], env: {} };
    case 'node':
      return { file: launch.node, args: [launch.script, ...args], pathDirs: [dirname(launch.node)], env: {} };
    case 'native':
      // What codex.js (0.156.1) adds before it starts the binary; it does not change PATH.
      return {
        file: launch.binary, args, pathDirs: [dirname(launch.binary)],
        env: { CODEX_MANAGED_PACKAGE_ROOT: launch.packageRoot, CODEX_MANAGED_BY_NPM: '1' },
      };
  }
}

/**
 * Web search and material (the person's decision of 2026-10-02, A): when material (a PDF, a note, subtitles) is
 * attached, the request form starts with web search off, and the person can turn it back on. Material is outside
 * text: with web tools, an instruction written in it could send what the run holds (the node, the material) to a URL.
 * Turning it back on shows a caution on screen (the UI, LEV-271) and README #44 discloses it.
 */
export function webSearchDefault(materialCount: number): boolean {
  return materialCount === 0;
}

/** Whether the form shows the caution: web search is on while material is attached (A, above). */
export function webSearchCaution(materialCount: number, webSearch: boolean): boolean {
  return webSearch && materialCount > 0;
}

/** `yt-dlp` without the person's config (`--ignore-config`) and only the video that was open (`--no-playlist`). */
export function ytdlpInfoArgs(url: string): string[] {
  return ['--ignore-config', '--no-playlist', '--skip-download', '--dump-single-json', '--', url];
}

export function ytdlpSubtitleArgs(url: string, choice: { language: string; automatic: boolean }, outputDir: string): string[] {
  return [
    '--ignore-config', '--no-playlist', '--skip-download', choice.automatic ? '--write-auto-subs' : '--write-subs',
    // `%` in the directory would read as part of the output template.
    '--sub-langs', choice.language, '--sub-format', 'vtt', '-o', `${outputDir.replace(/%/gu, '%%')}/%(id)s.%(ext)s`, '--', url,
  ];
}

/** The inherited environment with the directories put in front of PATH (once each). Nothing else changes (§11.3). */
export function launchEnv(base: Readonly<Record<string, string | undefined>>, invocation: Pick<Invocation, 'pathDirs' | 'env'>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  const rest = (env.PATH ?? '').split(':').filter(dir => dir !== '');
  const front = [...new Set(invocation.pathDirs)];
  env.PATH = [...front, ...rest.filter(dir => !front.includes(dir))].join(':');
  return { ...env, ...invocation.env };
}

export function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

/** Where each tool says how to install it (Mappy installs none of them, §11.2, §11.3). */
export const INSTALL_URLS: Record<Tool, string> = {
  claude: 'https://docs.anthropic.com/en/docs/claude-code/setup',
  codex: 'https://github.com/openai/codex#installing-and-running-codex-cli',
  'yt-dlp': 'https://github.com/yt-dlp/yt-dlp#installation',
};

/** The names a tool's executable can have. */
export const EXECUTABLES: Record<Tool | 'node', string> = { claude: 'claude', codex: 'codex', 'yt-dlp': 'yt-dlp', node: 'node' };

/**
 * Where an executable is looked for when the settings leave its path empty, in order (§11.3). nvm's versions are
 * listed by the caller, newest first. The home directory comes from `os.homedir()`, never a written path.
 */
export function candidateDirs(home: string, nvmVersions: readonly string[] = []): string[] {
  return [
    `${home}/.local/share/mise/shims`,
    `${home}/.local/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${home}/.npm-global/bin`,
    `${home}/.volta/bin`,
    `${home}/.bun/bin`,
    `${home}/.claude/local`,
    ...nvmVersions.map(version => `${home}/.nvm/versions/node/${version}/bin`),
  ];
}

/** nvm's version directories, newest first (`v22.10.0` before `v22.9.1` before `v18.20.5`). */
export function sortNodeVersions(names: readonly string[]): string[] {
  const parts = (name: string) => name.replace(/^v/u, '').split('.').map(part => Number.parseInt(part, 10) || 0);
  return names.filter(name => /^v?\d+(?:\.\d+)*$/u.test(name)).sort((a, b) => {
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const difference = (y[i] ?? 0) - (x[i] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  });
}

/** A script that `#!/usr/bin/env node` would start: it has to be given to node, which a GUI app's PATH may lack. */
export function needsNode(realPath: string): boolean {
  return /\.(?:c|m)?js$/u.test(realPath);
}

const CODEX_TRIPLES: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
};

/**
 * Where the native binary sits next to an npm install's `codex.js` (`<package>/bin/codex.js`), in the order codex.js
 * looks: the platform package, then the package's own `vendor/`. Empty on a platform codex.js does not know.
 */
export function codexNativeCandidates(script: string, platform: string, arch: string): { binary: string; packageRoot: string }[] {
  const triple = CODEX_TRIPLES[`${platform}-${arch}`];
  if (!triple) return [];
  const packageRoot = dirname(dirname(script));
  return [
    `${packageRoot}/node_modules/@openai/codex-${platform}-${arch}/vendor/${triple}/bin/codex`,
    `${packageRoot}/vendor/${triple}/bin/codex`,
  ].map(binary => ({ binary, packageRoot }));
}

/** The login shell's lookup, run once by the 「探す」 button: `-i` too, since tool managers often activate in `.zshrc`. */
export function loginShellArgs(tool: Tool): string[] {
  return ['-ilc', `command -v ${EXECUTABLES[tool]}`];
}

/** The absolute path a login shell printed, or null (it may print the rc files' noise first). */
export function pathFromShellOutput(output: string): string | null {
  const lines = output.split(/\r?\n/u).map(line => line.trim()).filter(line => line.startsWith('/'));
  return lines[lines.length - 1] ?? null;
}
