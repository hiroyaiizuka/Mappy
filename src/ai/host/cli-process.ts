import { LIMITS } from '../core/launch';
import type { NodeHost } from './node-host';

/**
 * One external program run to its end (docs/architecture.md §11.3): started in its own process group in an empty
 * directory, the instruction written to standard input, standard output read line by line. It stops on the caller's
 * signal, on silence (`idleMs` without a line), on the whole time (`totalMs`) and on too much output, each by
 * SIGTERM to the group and SIGKILL to what is left after 3 seconds. Whether it was cancelled is this side's flag,
 * never the exit code: Codex's node wrapper exits 0 on SIGTERM (stage 0 #19, artifacts/lev-270 x3).
 */

export interface CliSpec {
  file: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  idleMs: number;
  totalMs: number;
  maxOutputBytes?: number;
}

export type CliEnd =
  | { kind: 'exited'; code: number | null; signal: string | null; stderr: string }
  | { kind: 'cancelled' }
  | { kind: 'timeout'; which: 'idle' | 'total' }
  | { kind: 'output-too-large' }
  | { kind: 'spawn-failed'; error: string };

/** How much of standard error is kept for the message: its end, where the reason usually is. */
const STDERR_KEEP = 4_000;

export function runCli(host: NodeHost, spec: CliSpec, onLine: (line: string) => void, signal: AbortSignal): Promise<CliEnd> {
  if (signal.aborted) return Promise.resolve({ kind: 'cancelled' });
  return new Promise(resolve => {
    let stop: CliEnd | null = null;
    let settled = false;
    let idle: number | null = null;
    let onAbort = (): void => undefined;
    const timers: number[] = [];
    const finish = (end: CliEnd): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) window.clearTimeout(timer);
      if (idle !== null) window.clearTimeout(idle);
      signal.removeEventListener('abort', onAbort);
      resolve(end);
    };

    let child: ReturnType<NodeHost['spawn']>;
    try {
      child = host.spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env });
    } catch (error) {
      finish({ kind: 'spawn-failed', error: String(error) });
      return;
    }
    const pid = child.pid;

    const halt = (end: CliEnd): void => {
      if (stop !== null || settled) return;
      stop = end;
      if (pid === undefined) { finish(end); return; }
      host.killGroup(pid, 'SIGTERM');
      timers.push(window.setTimeout(() => { host.killGroup(pid, 'SIGKILL'); }, LIMITS.killGraceMs));
    };
    onAbort = (): void => { halt({ kind: 'cancelled' }); };
    signal.addEventListener('abort', onAbort);

    const armIdle = (): void => {
      if (idle !== null) window.clearTimeout(idle);
      idle = window.setTimeout(() => { halt({ kind: 'timeout', which: 'idle' }); }, spec.idleMs);
    };
    armIdle();
    timers.push(window.setTimeout(() => { halt({ kind: 'timeout', which: 'total' }); }, spec.totalMs));

    const decoder = new TextDecoder();
    let pending = '';
    let bytes = 0;
    child.stdout?.on('data', chunk => {
      if (stop !== null) return;
      bytes += chunk.byteLength;
      if (bytes > (spec.maxOutputBytes ?? LIMITS.outputMaxBytes)) { halt({ kind: 'output-too-large' }); return; }
      pending += decoder.decode(chunk, { stream: true });
      let index: number;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index).replace(/\r$/u, '');
        pending = pending.slice(index + 1);
        armIdle();
        if (line) onLine(line);
      }
    });
    const stderrDecoder = new TextDecoder();
    let stderr = '';
    child.stderr?.on('data', chunk => {
      stderr = (stderr + stderrDecoder.decode(chunk, { stream: true })).slice(-STDERR_KEEP);
    });

    child.on('error', error => {
      // ENOENT and EACCES arrive here, after spawn() returned.
      finish(stop ?? { kind: 'spawn-failed', error: error.message });
    });
    child.on('close', (code, exitSignal) => {
      const rest = (pending + decoder.decode()).replace(/\r$/u, '');
      if (stop === null && rest) onLine(rest);
      finish(stop ?? { kind: 'exited', code, signal: exitSignal, stderr: stderr + stderrDecoder.decode() });
    });

    // A CLI that exits before reading its input closes the pipe (EPIPE); the exit reports what happened.
    child.stdin?.on('error', () => undefined);
    child.stdin?.write(spec.stdin);
    child.stdin?.end();
  });
}
