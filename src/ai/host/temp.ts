import type { NodeHost } from './node-host';

/**
 * Temporary directories a run left behind (docs/architecture.md §11.3: removed when the run ends, whatever the
 * outcome). When Obsidian quits during a run the process is killed at once, but the page can go before the removal
 * runs. They are swept the next time Node is loaded, and only when older than a day: another vault's window on this
 * device may be running something in a fresh one right now.
 */

export const RUN_DIR_PREFIX = 'mappy-ai-';
const STALE_MS = 24 * 60 * 60 * 1000;

export async function sweepStaleRuns(host: NodeHost, now: number): Promise<string[]> {
  const root = host.tmpdir();
  const removed: string[] = [];
  for (const name of await host.readdir(root)) {
    if (!name.startsWith(RUN_DIR_PREFIX)) continue;
    const path = `${root}/${name}`;
    const modified = await host.modifiedAt(path);
    if (modified === null || now - modified < STALE_MS) continue;
    await host.rm(path).catch(() => undefined);
    removed.push(path);
  }
  return removed;
}
