import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findWithLoginShell, locate, locateClaude } from '../../../src/ai/host/locate';
import { FakeHost } from '../fake-host';

beforeEach(() => { vi.stubGlobal('window', globalThis); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('locate (architecture.md §11.3)', () => {
  it('takes the first known place in order, nvm newest first', async () => {
    const host = new FakeHost({
      executables: ['/usr/local/bin/claude', '/opt/homebrew/bin/claude', '/Users/user/.nvm/versions/node/v18.20.5/bin/node', '/Users/user/.nvm/versions/node/v22.10.0/bin/node'],
      dirs: { '/Users/user/.nvm/versions/node': ['v18.20.5', 'v22.10.0'] },
    });
    await expect(locate(host, 'claude')).resolves.toBe('/opt/homebrew/bin/claude');
    await expect(locate(host, 'node')).resolves.toBe('/Users/user/.nvm/versions/node/v22.10.0/bin/node');
    await expect(locate(host, 'yt-dlp')).resolves.toBeNull();
  });

  it('starts nothing to look (no login shell on its own)', async () => {
    const host = new FakeHost({ executables: [] });
    await locate(host, 'codex');
    expect(host.children).toEqual([]);
  });

  it('gives an npm install’s cli.js to node, and gives up without node', async () => {
    const withNode = new FakeHost({ executables: ['/opt/homebrew/bin/claude', '/opt/homebrew/bin/node'], links: { '/opt/homebrew/bin/claude': '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js' } });
    await expect(locateClaude(withNode, '')).resolves.toEqual({ file: '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js', node: '/opt/homebrew/bin/node' });
    const without = new FakeHost({ executables: ['/opt/homebrew/bin/claude'], links: { '/opt/homebrew/bin/claude': '/x/cli.js' } });
    await expect(locateClaude(without, '')).resolves.toBeNull();
  });
});

describe('findWithLoginShell', () => {
  it('asks $SHELL -ilc once in a temporary directory and takes the path it prints', async () => {
    const host = new FakeHost({
      env: { SHELL: '/bin/zsh', USER: 'user', PATH: '/usr/bin' },
      executables: ['/Users/user/.local/share/mise/installs/yt-dlp/bin/yt-dlp'],
      onSpawn: child => { queueMicrotask(() => { child.out('rc noise\n/Users/user/.local/share/mise/installs/yt-dlp/bin/yt-dlp\n'); child.close(0); }); },
    });
    await expect(findWithLoginShell(host, 'yt-dlp', new AbortController().signal)).resolves.toBe('/Users/user/.local/share/mise/installs/yt-dlp/bin/yt-dlp');
    expect(host.children.map(child => [child.file, child.args])).toEqual([['/bin/zsh', ['-ilc', 'command -v yt-dlp']]]);
    expect(host.removed).toEqual(host.made);
  });

  it('gives up after 5 seconds', async () => {
    vi.useFakeTimers();
    const host = new FakeHost({ env: { SHELL: '/bin/zsh' } });
    const found = findWithLoginShell(host, 'claude', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(found).resolves.toBeNull();
    expect(host.kills[0]?.signal).toBe('SIGTERM');
  });

  it('does not take a path that is not an executable', async () => {
    const host = new FakeHost({ env: { SHELL: '/bin/zsh' }, onSpawn: child => { queueMicrotask(() => { child.out('/not/there/claude\n'); child.close(0); }); } });
    await expect(findWithLoginShell(host, 'claude', new AbortController().signal)).resolves.toBeNull();
  });
});
