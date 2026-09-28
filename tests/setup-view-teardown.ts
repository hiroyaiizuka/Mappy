import { afterEach, beforeEach } from 'vitest';
import { closeOpenViews, openViews, viewCount } from './mocks/open-views';

// The check after every test that built a view (LEV-239; LEV-236 had it in mindmap-view-topics alone). It runs after the
// file's own hooks (vitest runs `afterEach` hooks in reverse order, and this file's are registered first), so the file
// has closed its views by then, with `closeOpenViews` where its own cleanup puts it.

let builtBefore = 0;
beforeEach(() => { builtBefore = viewCount.built; });

/**
 * jsdom's teardown as whatever a test left behind meets it (LEV-236): the globals go, and work still scheduled or under way
 * runs against no `document`. The view's timers are Node's here (`contentEl.win.setTimeout`), so closing the jsdom window
 * does not stop them, and a `run()` that rejects then builds its `Notice` on no document: an unhandled rejection that fails
 * the run with every test passed. Only a file's last test meets the real teardown, and only now and then; so after every
 * test that built a view, once its views are closed, the document is taken away for longer than the longest timer the
 * view keeps (the 45 ms re-read). It sees only what reaches the global `document` in that time: a longer debounce, or
 * work that stays on `contentEl.doc`, passes.
 */
async function withoutDocument(ms: number): Promise<void> {
  // The property as the jsdom environment put it (an accessor or a value), so it goes back the same way.
  const kept = Object.getOwnPropertyDescriptor(globalThis, 'document');
  if (!kept) throw new Error('No global document to take away');
  delete (globalThis as { document?: Document }).document;
  try { await new Promise(resolve => setTimeout(resolve, ms)); } finally { Object.defineProperty(globalThis, 'document', kept); }
}

afterEach(async () => {
  if (viewCount.built === builtBefore) return;
  // A view the file left open fails its test; it is closed here all the same, so the next test starts without it.
  const left = openViews.size;
  const [closing] = await Promise.allSettled([closeOpenViews()]);
  openViews.clear();
  if (typeof document !== 'undefined') {
    document.body.replaceChildren();
    await withoutDocument(60);
  }
  if (left > 0) {
    throw new Error(`${left} view(s) left open after the test: close them in the file's afterEach with closeOpenViews() (tests/mocks/open-views.ts)`);
  }
  if (closing.status === 'rejected') throw closing.reason;
});
