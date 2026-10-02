import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadNode } from '../../../src/ai/host/node-host';

/**
 * The one door to Node (architecture.md §11.1) and the two things the stop of a run rests on (§11.3): the child is
 * started `detached` (it leads a process group of its own) and the group is signalled with a negative pid. Every
 * other test goes through FakeHost, so without these nothing would notice either being taken away, and a cancelled
 * claude would keep running while the UI says it stopped (independent review of PR #159, M-1).
 */

afterEach(() => { vi.unstubAllGlobals(); });

function electron() {
  const spawn = vi.fn<(...args: unknown[]) => { pid: number }>(() => ({ pid: 4321 }));
  const kill = vi.fn<(pid: number, signal: string) => boolean>(() => true);
  const require = vi.fn((id: string) => {
    if (id === 'child_process') return { spawn };
    if (id === 'fs') return { constants: { X_OK: 1 }, promises: {} };
    if (id === 'os') return { homedir: () => '/Users/user', tmpdir: () => '/tmp' };
    if (id === 'path') return { join: (...parts: string[]) => parts.join('/') };
    throw new Error(`unexpected ${id}`);
  });
  vi.stubGlobal('window', { require, process: { platform: 'darwin', arch: 'arm64', env: { USER: 'user' }, kill } });
  return { spawn, kill, require };
}

describe('loadNode', () => {
  it('takes nothing outside the desktop app', () => {
    const { require } = electron();
    expect(loadNode(false)).toBeNull();
    expect(require).not.toHaveBeenCalled();
  });

  it('is null where the renderer has no require', () => {
    vi.stubGlobal('window', {});
    expect(loadNode(true)).toBeNull();
  });

  it('starts every child detached with all three streams piped, so it leads its own process group', () => {
    const { spawn } = electron();
    const host = loadNode(true);
    host?.spawn('/bin/cli', ['-p'], { cwd: '/tmp/mappy-ai-1', env: { PATH: '/bin' } });
    expect(spawn).toHaveBeenCalledWith('/bin/cli', ['-p'], { cwd: '/tmp/mappy-ai-1', env: { PATH: '/bin' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  });

  it('signals the whole group (a negative pid), and answers false when there is no such group', () => {
    const { kill } = electron();
    const host = loadNode(true);
    expect(host?.killGroup(123, 'SIGTERM')).toBe(true);
    expect(kill).toHaveBeenCalledWith(-123, 'SIGTERM');
    kill.mockImplementationOnce(() => { throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); });
    expect(host?.killGroup(123, 'SIGKILL')).toBe(false);
  });
});
