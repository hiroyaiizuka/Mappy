import {
  EXECUTABLES, LIMITS, candidateDirs, codexNativeCandidates, launchEnv, loginShellArgs, needsNode, pathFromShellOutput,
  sortNodeVersions, type CodexLaunch, type Tool,
} from '../core/launch';
import { runCli } from './cli-process';
import type { NodeHost } from './node-host';

/**
 * Finding the executables (docs/architecture.md §11.3). A GUI app does not inherit the shell's PATH (a name alone is
 * ENOENT from Obsidian, artifacts/lev-270 v-byname), so a path is (1) the one in the settings, else (2) the first of
 * the known places that has it. The login shell runs only when the person presses 「探す」 in the settings, once.
 */

async function inKnownPlaces(host: NodeHost, name: string): Promise<string | null> {
  const home = host.homedir();
  const nvm = sortNodeVersions(await host.readdir(`${home}/.nvm/versions/node`));
  for (const dir of candidateDirs(home, nvm)) {
    const path = `${dir}/${name}`;
    if (await host.isExecutable(path)) return path;
  }
  return null;
}

/** The executable for `tool`: the configured path when it is set (and nothing else then), else a known place. */
export async function locate(host: NodeHost, tool: Tool | 'node', configured = ''): Promise<string | null> {
  const path = configured.trim();
  if (path) return await host.isExecutable(path) ? path : null;
  return inKnownPlaces(host, EXECUTABLES[tool]);
}

/** Claude as found: a script (an npm install's `cli.js`) is given to node, which then has to be found too. */
export async function locateClaude(host: NodeHost, configured: string): Promise<{ file: string; node?: string } | null> {
  const file = await locate(host, 'claude', configured);
  if (file === null) return null;
  const real = await host.realpath(file) ?? file;
  if (!needsNode(real)) return { file };
  const node = await locate(host, 'node');
  return node === null ? null : { file: real, node };
}

/**
 * How to start Codex (§11.3). An npm install's `bin/codex` is `codex.js` under `#!/usr/bin/env node`, which fails
 * with 127 when node is not on PATH: it is run as `<node> <codex.js>` when node is found, and only otherwise as the
 * native binary next to it, given the variables codex.js would set. Anything else (a mise shim, Homebrew's binary)
 * runs as it is.
 */
export async function locateCodex(host: NodeHost, configured: string): Promise<CodexLaunch | null> {
  const file = await locate(host, 'codex', configured);
  if (file === null) return null;
  const real = await host.realpath(file) ?? file;
  if (!needsNode(real)) return { kind: 'direct', file };
  const node = await locate(host, 'node');
  if (node !== null) return { kind: 'node', node, script: real };
  for (const native of codexNativeCandidates(real, host.platform, host.arch)) {
    if (await host.isExecutable(native.binary)) return { kind: 'native', ...native };
  }
  return null;
}

/**
 * What the person's login shell finds for `tool` (`$SHELL -ilc 'command -v …'`, 5 seconds at most), for the settings'
 * 「探す」 button only: an interactive shell is slow and runs the person's rc files, so it never runs on its own.
 */
export async function findWithLoginShell(host: NodeHost, tool: Tool, signal: AbortSignal): Promise<string | null> {
  const env = host.env();
  const shell = env.SHELL && env.SHELL.startsWith('/') ? env.SHELL : '/bin/zsh';
  const cwd = await host.mkdtemp('mappy-ai-');
  try {
    const lines: string[] = [];
    const end = await runCli(host, {
      file: shell, args: loginShellArgs(tool), cwd, env: launchEnv(env, { pathDirs: [], env: {} }), stdin: '',
      idleMs: LIMITS.loginShellMs, totalMs: LIMITS.loginShellMs,
    }, line => { lines.push(line); }, signal);
    if (end.kind !== 'exited') return null;
    const path = pathFromShellOutput(lines.join('\n'));
    return path !== null && await host.isExecutable(path) ? path : null;
  } finally {
    await host.rm(cwd);
  }
}
