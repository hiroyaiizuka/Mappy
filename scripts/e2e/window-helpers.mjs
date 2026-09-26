/**
 * Shared parts of E48, E50 and E51 (docs/harness.md, LEV-14): what a view leaves behind once it is closed, and how a
 * theme reads on screen.
 *
 * - `HANDLERS` counts the handlers on Obsidian's own event hubs (`app.workspace`, `app.vault`,
 *   `app.metadataCache`): a view that subscribes with `registerEvent` gives each back when it closes, so after
 *   any number of opens and closes the counts are the ones before the first (「多重イベント」).
 * - `makeTrack` keeps a `WeakRef` to each view (and its `contentEl`) as it closes; `preciseGc` then collects, and a
 *   view still reachable is one something kept — a listener on a document or window, a timer, a cache (「残留 DOM」).
 *   A counter alone (Memory.getDOMCounters) cannot say that: `HeapProfiler.collectGarbage` leaves detached DOM for
 *   a later sweep (measured on 1.14.2: +840 nodes after 20 opens that a heap snapshot's GC then took back), which
 *   is why `preciseGc` takes a heap snapshot instead — its GC is the one that also sweeps the DOM heap.
 * - `COLOR` parses any computed CSS colour (`oklch(…)`, `color-mix`, alpha) through a canvas and composites the
 *   backgrounds an element actually sits on, so a contrast ratio is the one the pixels have (E48).
 */
import { wait } from './cdp.mjs';

/** Script expression: handler counts per event name on the three hubs a view subscribes to. */
export const HANDLERS = `(() => {
  const count = hub => Object.fromEntries(Object.entries(hub?._ ?? {}).map(([name, list]) => [name, list.length]));
  return { workspace: count(app.workspace), vault: count(app.vault), metadataCache: count(app.metadataCache) };
})()`;

/** The event names whose handler count differs between two `HANDLERS` readings, as "hub.name: before → after". */
export function handlerDiff(before, after) {
  const changed = [];
  for (const hub of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[hub] ?? {}; const b = after[hub] ?? {};
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if ((a[name] ?? 0) !== (b[name] ?? 0)) changed.push(`${hub}.${name}: ${a[name] ?? 0} → ${b[name] ?? 0}`);
    }
  }
  return changed;
}

/**
 * A full collection, DOM included (see the file comment). The snapshot's chunks arrive as events the connection
 * ignores (`send` only waits for its own id); only the completion matters here.
 */
export async function preciseGc(cdp) {
  await cdp.send('HeapProfiler.enable');
  try {
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false });
  } finally {
    await cdp.send('HeapProfiler.disable');
  }
  await wait(100);
}

/**
 * DOM nodes, documents and JS event listeners of the page, and its JS heap, after `preciseGc`. The heap is
 * `Runtime.getHeapUsage`'s exact `usedSize`: `performance.memory` is bucketed and cached without
 * `--enable-precise-memory-info`, and two readings inside one cache window would show no growth at all.
 */
export async function memory(cdp) {
  await preciseGc(cdp);
  const counters = await cdp.send('Memory.getDOMCounters');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  return { ...counters, heapMB: Math.round(usedSize / 10485.76) / 100 };
}

/**
 * `track(label, expression)` (script: `expression` is a view) keeps weak references to it; `alive()` (after
 * `preciseGc`) lists the labels something still holds. The list lives on the main window, which outlives the
 * popouts whose views it follows.
 */
export function makeTrack(evaluate) {
  return {
    reset: () => evaluate('window.__mappyE2ETracked = []; return true;'),
    /** Script statement for inside an `evaluate`: `view` must be in scope there. */
    statement: label => `(window.opener ?? window).__mappyE2ETracked.push({ label: ${JSON.stringify(label)}, view: new WeakRef(view), el: new WeakRef(view.contentEl) });`,
    count: () => evaluate('return window.__mappyE2ETracked.length;'),
    alive: () => evaluate(`return window.__mappyE2ETracked
      .filter(entry => entry.view.deref() !== undefined || entry.el.deref() !== undefined)
      .map(entry => entry.label);`),
  };
}

export const APP_THEMES = { light: 'moonstone', dark: 'obsidian' };

/**
 * Switches Obsidian's base theme (`app.changeTheme`, what Appearance calls; `scheme` is 'light' or 'dark') from the
 * main window's `evaluate`, and waits until `body` in each of `windows` (evaluate functions; the main window by
 * default, a popout's too) carries `theme-<scheme>`, instead of sleeping a fixed time. Resolves to what each body
 * shows then ('light' or 'dark'), in order.
 */
export function makeAppTheme(evaluate) {
  return async (scheme, windows = [evaluate]) => {
    await evaluate(`app.changeTheme(${JSON.stringify(APP_THEMES[scheme])}); return true;`);
    const shown = [];
    for (const read of windows) {
      shown.push(await read(`for (const started = Date.now(); Date.now() - started < 5000 && !document.body.classList.contains(${JSON.stringify(`theme-${scheme}`)}); await new Promise(resolve => setTimeout(resolve, 50)));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return document.body.classList.contains('theme-dark') ? 'dark' : 'light';`));
    }
    return shown;
  };
}

/**
 * Script: collects this window's uncaught errors and rejections into `window.__mappyE2EErrors`. The listeners go on
 * once per window; the list starts empty on every run, or one error would fail every later case run in the same
 * Obsidian (LEV-216: E50 reported an error of the run before it for the seven runs after it).
 */
export const ERRORS = `window.__mappyE2EErrors = [];
if (!window.__mappyE2EErrorsWatched) {
  window.__mappyE2EErrorsWatched = true;
  window.addEventListener('error', event => { window.__mappyE2EErrors.push(String(event.error?.stack ?? event.message)); });
  window.addEventListener('unhandledrejection', event => { window.__mappyE2EErrors.push(String(event.reason?.stack ?? event.reason)); });
}`;

/**
 * Script prelude: `rgba(css)` → [r, g, b, a] (0–255, alpha 0–1) for any colour the browser can paint;
 * `backdrop(el)` → the opaque colour behind `el` (its own background and every ancestor's, composited from the
 * first opaque one down); `onto(color, below)` composites one colour over another; `contrast(a, b)` is the WCAG
 * ratio of two opaque colours.
 */
export const COLOR = `const paint = document.createElement('canvas'); paint.width = 1; paint.height = 1;
  const pen = paint.getContext('2d', { willReadFrequently: true });
  const rgba = css => {
    pen.clearRect(0, 0, 1, 1); pen.fillStyle = '#000'; pen.fillStyle = css; pen.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = pen.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const onto = (top, below) => {
    const a = top[3];
    return [0, 1, 2].map(i => Math.round(top[i] * a + below[i] * (1 - a))).concat(1);
  };
  const backdrop = element => {
    const layers = [];
    for (let at = element; at && at.nodeType === 1; at = at.parentElement) {
      const color = rgba(getComputedStyle(at).backgroundColor);
      if (color[3] > 0) layers.push(color);
      if (color[3] === 1) break;
    }
    let result = [255, 255, 255, 1];
    if (layers.length > 0 && layers[layers.length - 1][3] === 1) result = layers.pop();
    for (const layer of layers.reverse()) result = onto(layer, result);
    return result;
  };
  const luminance = color => {
    const [r, g, b] = color.slice(0, 3).map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return Math.round((x + 0.05) / (y + 0.05) * 100) / 100; };
  const css = color => 'rgb(' + color.slice(0, 3).join(', ') + ')';`;
