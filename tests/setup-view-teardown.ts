import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { closeEveryView, openViews, viewCount, type ClosableView } from './mocks/open-views';

// The check after every test that built a view, and after every file (LEV-239; LEV-236 had it in mindmap-view-topics
// alone). It runs after the file's own hooks (vitest runs `afterEach`／`afterAll` hooks in reverse order, and this
// file's are registered first), so the file has closed its views by then, with `closeOpenViews` where its own cleanup
// puts it. A view built outside a test (`beforeAll`, the module) may stay open across the file's tests, and is checked
// once the file is done.

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

/**
 * Close the views left open (the check's own clean-up, so what follows starts without them), then look for what the
 * closed views left behind; a view left open fails, after the clean-up, and a failed close after that.
 */
async function check(left: ClosableView[], where: string): Promise<void> {
  const [closing] = await Promise.allSettled([closeEveryView(left)]);
  if (typeof document !== 'undefined') {
    document.body.replaceChildren();
    await withoutDocument(60);
  }
  if (left.length > 0) {
    throw new Error(`${left.length} view(s) left open ${where}: close them with closeOpenViews() (tests/mocks/open-views.ts)`);
  }
  if (closing.status === 'rejected') throw closing.reason;
}

let builtInFile = 0;
beforeAll(() => { builtInFile = viewCount.built; });
let builtBefore = 0;
let openBefore = new Set<ClosableView>();
beforeEach(() => {
  builtBefore = viewCount.built;
  openBefore = new Set(openViews);
});

afterEach(async () => {
  if (viewCount.built === builtBefore) return;
  await check(Array.from(openViews).filter(view => !openBefore.has(view)), 'after the test');
});

afterAll(async () => {
  if (viewCount.built === builtInFile) return;
  await check(Array.from(openViews), 'after the file');
});
