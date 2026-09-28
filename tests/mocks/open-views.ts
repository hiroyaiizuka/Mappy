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
 * Close every view still open, as Obsidian closes a tab (the harness's `View.close`, 1.14.2's order: the container
 * leaves the DOM, the view unloads, then `onClose`). Each is closed even when another's close fails; the first
 * failure is then thrown, for the test to report.
 */
export async function closeOpenViews(): Promise<void> {
  const closes = await Promise.allSettled(Array.from(openViews, view => view.close()));
  const failed = closes.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
}
