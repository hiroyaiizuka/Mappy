/**
 * The views a test has built and not yet closed (LEV-239). The browser harness's `View` enters itself here when it is
 * constructed and leaves once its `close` has run to the end; a test's own FileView stand-in can do the same. A test
 * file closes what is left with `closeOpenViews` after each test, and `tests/setup-view-teardown.ts` fails the test
 * when a view is still here after the file's own hooks — a view never closed keeps its timers and vault listeners.
 * Kept apart from the mocked `obsidian` module id, so the harness module and the setup file share one registry.
 */
export interface ClosableView {
  close(): Promise<void>;
}

export const openViews = new Set<ClosableView>();

/** How many views have been built so far; the setup file compares it across a test to know whether the test built one. */
export const viewCount = { built: 0 };

export function enterView(view: ClosableView): void {
  viewCount.built += 1;
  openViews.add(view);
}

export function leaveView(view: ClosableView): void {
  openViews.delete(view);
}

/** Close one view as Obsidian closes its tab (the harness's `View.close`); the `obsidian` typings lack `close`. */
export function closeView(view: object): Promise<void> {
  return (view as ClosableView).close();
}

/**
 * Set by `npm run harness:view-teardown` (scripts/check-view-teardown.mjs) to take the teardown out of every file at once,
 * so it can see each file fail without it. Read through `globalThis`: the browser page bundles this module too.
 */
export const SKIP_CLOSE_ENV = 'MAPPY_SKIP_VIEW_CLOSE';

/**
 * Close every view still open, as Obsidian closes a tab (the harness's `View.close`, 1.14.2's order: the container
 * leaves the DOM, the view unloads, then `onClose`), one after another in the order they were built, as the files'
 * own loops did: views on one store then save their drafts in turn. Each is closed even when another's close fails;
 * the first failure is then thrown, for the test to report.
 */
export async function closeOpenViews(): Promise<void> {
  if ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[SKIP_CLOSE_ENV]) return;
  await closeEveryView();
}

/** `closeOpenViews` without the check's switch (of `views`, all open ones by default): the setup file's own clean-up of what a file left open. */
export async function closeEveryView(views: readonly ClosableView[] = Array.from(openViews)): Promise<void> {
  const closes: PromiseSettledResult<void>[] = [];
  // Through `then`, so a close that throws before it returns a promise is a failure of that view, not of the loop.
  for (const view of views) closes.push(...await Promise.allSettled([Promise.resolve().then(() => view.close())]));
  const failed = closes.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
}
