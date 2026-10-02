import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli, type CliSpec } from '../../../src/ai/host/cli-process';
import { FakeHost, type FakeChild } from '../fake-host';

/**
 * Starting and stopping a CLI (architecture.md §11.3) with the process mocked: the process group gets SIGTERM and,
 * 3 seconds later, SIGKILL when something is left; cancelling is this side's flag whatever the exit code; silence,
 * the whole time and too much output each stop the run.
 */

const spec: CliSpec = { file: '/bin/cli', args: ['-p'], cwd: '/tmp/mappy-ai-000000', env: { PATH: '/bin' }, stdin: 'prompt', idleMs: 90_000, totalMs: 300_000 };

// The timers are `window`'s (popout-safe, obsidianmd/prefer-window-timers); Node has no window.
beforeEach(() => { vi.stubGlobal('window', globalThis); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function start(host: FakeHost, overrides: Partial<CliSpec> = {}, signal = new AbortController().signal) {
  const lines: string[] = [];
  const done = runCli(host, { ...spec, ...overrides }, line => { lines.push(line); }, signal);
  const child = host.children[0] as FakeChild;
  return { lines, done, child };
}

describe('runCli', () => {
  it('starts the file with the arguments, directory and environment, writes the prompt and closes standard input', async () => {
    const host = new FakeHost();
    const { done, child } = start(host);
    expect(child).toMatchObject({ file: '/bin/cli', args: ['-p'], options: { cwd: '/tmp/mappy-ai-000000', env: { PATH: '/bin' } } });
    expect(child.stdinText).toEqual(['prompt']);
    expect(child.stdinEnded).toBe(true);
    child.close(0);
    await expect(done).resolves.toEqual({ kind: 'exited', code: 0, signal: null, stderr: '' });
  });

  it('splits standard output into lines across chunks, a character split between chunks included', async () => {
    const host = new FakeHost();
    const { done, child, lines } = start(host);
    const bytes = new TextEncoder().encode('{"a":"日本"}\r\n{"b"');
    child.out(bytes.slice(0, 8));
    child.out(bytes.slice(8));
    child.out(':1}\n\nlast without newline');
    child.err('warning\n');
    child.close(1);
    await expect(done).resolves.toEqual({ kind: 'exited', code: 1, signal: null, stderr: 'warning\n' });
    expect(lines).toEqual(['{"a":"日本"}', '{"b":1}', 'last without newline']);
  });

  it('cancels with SIGTERM to the group and reports cancelled even when the CLI exits 0 (Codex’s wrapper does)', async () => {
    const host = new FakeHost({ onKill: (child, signal) => { if (signal === 'SIGTERM') queueMicrotask(() => { child.close(0); }); return true; } });
    const controller = new AbortController();
    const { done } = start(host, {}, controller.signal);
    controller.abort();
    await expect(done).resolves.toEqual({ kind: 'cancelled' });
    expect(host.kills).toEqual([{ pid: 1000, signal: 'SIGTERM' }]);
  });

  it('sends SIGKILL 3 seconds after SIGTERM when the group is still there', async () => {
    const host = new FakeHost({ onKill: (child, signal) => { if (signal === 'SIGKILL') queueMicrotask(() => { child.close(null, 'SIGKILL'); }); return true; } });
    const controller = new AbortController();
    const { done } = start(host, {}, controller.signal);
    controller.abort();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(host.kills.map(kill => kill.signal)).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.kills.map(kill => kill.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    await expect(done).resolves.toEqual({ kind: 'cancelled' });
  });

  it('settles 3 seconds after SIGKILL even if the pipes never close (a descendant left the group holding them)', async () => {
    const host = new FakeHost({ onKill: () => true });
    const controller = new AbortController();
    const { done } = start(host, {}, controller.signal);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_999);
    let settled = false;
    void done.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toEqual({ kind: 'cancelled' });
  });

  it('settles 2 seconds after the exit when a descendant keeps standard output open, with the output so far, and kills what held it', async () => {
    const host = new FakeHost({ onKill: () => true });
    const { done, child, lines } = start(host);
    child.out('{"type":"turn.completed"}\n');
    child.exitHoldingPipes(0);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(host.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toEqual({ kind: 'exited', code: 0, signal: null, stderr: '' });
    expect(host.kills).toEqual([{ pid: 1000, signal: 'SIGKILL' }]);
    // What the descendant writes after the run settled reaches nobody.
    child.out('{"late":true}\n');
    expect(lines).toEqual(['{"type":"turn.completed"}']);
  });

  it('kills at once when Mappy is going away (no timer survives to send the later SIGKILL)', () => {
    const host = new FakeHost({ onKill: () => true });
    const killNow = new AbortController();
    start(host, { killNow: killNow.signal });
    killNow.abort();
    expect(host.kills.map(kill => kill.signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('kills at once when Mappy goes away within the 3 seconds after a cancel', async () => {
    const host = new FakeHost({ onKill: () => true });
    const controller = new AbortController();
    const killNow = new AbortController();
    start(host, { killNow: killNow.signal }, controller.signal);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.kills.map(kill => kill.signal)).toEqual(['SIGTERM']);
    killNow.abort();
    expect(host.kills.map(kill => kill.signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reads one long line delivered in many chunks', async () => {
    const host = new FakeHost();
    const { done, child, lines } = start(host, { maxOutputBytes: 10_000_000 });
    const long = 'x'.repeat(1_000_000);
    for (let at = 0; at < long.length; at += 65_536) child.out(long.slice(at, at + 65_536));
    child.out('\nnext\n');
    child.close(0);
    await done;
    expect(lines.map(line => line.length)).toEqual([1_000_000, 4]);
  });

  it('does not start at all when already cancelled', async () => {
    const host = new FakeHost();
    const controller = new AbortController();
    controller.abort();
    await expect(runCli(host, spec, () => undefined, controller.signal)).resolves.toEqual({ kind: 'cancelled' });
    expect(host.children).toEqual([]);
  });

  it('stops after the idle time without a line, each line restarting the clock', async () => {
    const host = new FakeHost();
    const { done, child } = start(host, { idleMs: 1_000 });
    await vi.advanceTimersByTimeAsync(900);
    child.out('one\n');
    await vi.advanceTimersByTimeAsync(900);
    // A chunk without a line break is not a line: the clock keeps running.
    child.out('half a line');
    expect(host.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(host.kills).toEqual([{ pid: 1000, signal: 'SIGTERM' }]);
    await expect(done).resolves.toEqual({ kind: 'timeout', which: 'idle' });
  });

  it('stops after the whole time even while lines keep coming', async () => {
    const host = new FakeHost();
    const { done, child } = start(host, { idleMs: 1_000, totalMs: 3_000 });
    for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(700); child.out('tick\n'); }
    await expect(done).resolves.toEqual({ kind: 'timeout', which: 'total' });
  });

  it('stops when standard output passes the limit, and reads nothing after it', async () => {
    const host = new FakeHost();
    const { done, child, lines } = start(host, { maxOutputBytes: 10 });
    child.out('12345\n');
    child.out('67890\n');
    await expect(done).resolves.toEqual({ kind: 'output-too-large' });
    expect(lines).toEqual(['12345']);
  });

  it('reports a file that cannot be started', async () => {
    const thrown = new FakeHost({ spawnThrows: new Error('EACCES') });
    await expect(runCli(thrown, spec, () => undefined, new AbortController().signal)).resolves.toEqual({ kind: 'spawn-failed', error: 'Error: EACCES' });
    const host = new FakeHost();
    const { done, child } = start(host);
    child.fail(new Error('spawn /bin/cli ENOENT'));
    await expect(done).resolves.toEqual({ kind: 'spawn-failed', error: 'spawn /bin/cli ENOENT' });
  });

  it('keeps the end of a long standard error', async () => {
    const host = new FakeHost();
    const { done, child } = start(host);
    child.err('x'.repeat(10_000));
    child.err('the reason');
    child.close(2);
    const end = await done;
    expect(end.kind === 'exited' && end.stderr.endsWith('the reason') && end.stderr.length).toBe(4_000);
  });
});
