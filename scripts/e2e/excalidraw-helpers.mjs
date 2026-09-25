/**
 * Shared steps of the Excalidraw cases (docs/harness.md E24・E25, §5 M6): the notes and the drawing they work on,
 * a real file drag from the file explorer onto the drawing, and reading what a drop added.
 *
 * The drag is the user's own gesture, not a call into Excalidraw's hook: `Input.setInterceptDrags` lets a
 * pressed-and-moved pointer on the explorer's item start Obsidian's own HTML5 drag (its `dragstart` sets
 * `app.dragManager`), and `Input.dispatchDragEvent` delivers the drop with the modifiers the user would hold. From
 * there on it is Excalidraw's drop handler deciding whether to call `ExcalidrawAutomate.onDropHook` — which is what
 * has to still work after the plugins are disabled, reloaded and enabled again (E25). The earlier probes
 * (`artifacts/lev-118-excalidraw-e2e`, `e2e-excalidraw-border-e27.js`) called the hook themselves, and so could
 * not see a hook Excalidraw no longer calls.
 */
import { wait } from './cdp.mjs';
import { refuseOpenLeaves } from './dom-helpers.mjs';

export const EXCALIDRAW = 'obsidian-excalidraw-plugin';
/** The title of the map note's root: a drop that inserted the map has a text element with it. */
export const MAP_ROOT = '対話フレーム';

/** A map with a boxed root, two boxed first-level branches, lines between them, and a link to the plain note. */
export const mapSource = plainName => [
  '---', 'mappy: true', '---',
  `## ${MAP_ROOT}`, '',
  '- 線と枠', `  - [[${plainName}]] へのリンク`,
  '- 二つ目の枝', '',
].join('\n');
/** A note without `mappy: true`: Excalidraw shows it as Markdown, whatever Mappy does. */
export const plainSource = mapName => ['# 通常ノート', '', '- 箇条書き', `- [[${mapName}]]`, ''].join('\n');

/**
 * Step body: writes the notes (path → text), makes the drawing with Excalidraw's own `create` and opens it in a
 * tab (`window.__mappyExcalidrawE2E = { leaf, drawing, errors }`). Stops first if a Markdown, map or drawing leaf is
 * already on one of these files (a previous `--keep`, or a run that stopped early; `refuseOpenLeaves`). A drawing
 * left at the same path by such a run is replaced: the name is the case's own, in the generated vault's Fixtures. Page errors and unhandled rejections
 * from here on are counted in `errors`, so a case can check that toggling the plugins threw nothing.
 */
export function makeDrawingSetup(evaluate, { notes, drawing }) {
  const folder = drawing.slice(0, drawing.lastIndexOf('/'));
  const name = drawing.slice(drawing.lastIndexOf('/') + 1).replace(/\.excalidraw\.md$/u, '');
  const paths = [...Object.keys(notes), drawing];
  return () => evaluate(`
    if (!app.plugins.plugins.mappy) throw new Error('Mappy is not loaded in this window');
    if (!app.plugins.plugins[${JSON.stringify(EXCALIDRAW)}] || !window.ExcalidrawAutomate) {
      throw new Error('Excalidraw is not loaded: install and enable it in this vault (docs/harness.md Obsidian 実機の初回準備 2)');
    }
    ${refuseOpenLeaves(paths, ['markdown', 'mappy-map', 'excalidraw'])}
    for (const [path, text] of Object.entries(${JSON.stringify(notes)})) {
      const existing = app.vault.getAbstractFileByPath(path);
      if (existing) await app.vault.modify(existing, text); else await app.vault.create(path, text);
    }
    const old = app.vault.getAbstractFileByPath(${JSON.stringify(drawing)});
    if (old) await app.vault.delete(old, true);
    await new Promise(resolve => setTimeout(resolve, 600));
    const ea = window.ExcalidrawAutomate;
    ea.reset();
    const created = await ea.create({ filename: ${JSON.stringify(name)}, foldername: ${JSON.stringify(folder)}, onNewPane: true });
    if (created !== ${JSON.stringify(drawing)}) throw new Error('Excalidraw created ' + created + ', not ' + ${JSON.stringify(drawing)});
    let leaf = null;
    for (const started = Date.now(); !leaf?.view?.excalidrawAPI && Date.now() - started < 10000;) {
      await new Promise(resolve => setTimeout(resolve, 200));
      leaf = app.workspace.getLeavesOfType('excalidraw').find(item => item.view.file?.path === created) ?? null;
    }
    if (!leaf?.view?.excalidrawAPI) throw new Error('The drawing did not open in an Excalidraw view');
    // A previous run that stopped early, or one with --keep, left its listeners on: take them off first.
    window.__mappyExcalidrawE2E?.off?.();
    const errors = [];
    const onError = event => { errors.push(String(event.message ?? event.error ?? event)); };
    const onRejection = event => { errors.push('unhandledrejection: ' + String(event.reason?.message ?? event.reason)); };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    window.__mappyExcalidrawE2E = { leaf, drawing: created, errors, off: () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    } };
    return { drawing: created, mappy: app.plugins.plugins.mappy.manifest.version, excalidraw: app.plugins.plugins[${JSON.stringify(EXCALIDRAW)}].manifest.version };`);
}

/** Script string: the drawing's leaf, reopened in a tab when a reload of Excalidraw took the old one away. */
export const DRAWING_LEAF = `const E = window.__mappyExcalidrawE2E;
  const drawingLeaf = async () => {
    const live = app.workspace.getLeavesOfType('excalidraw').find(item => item.view.file?.path === E.drawing && item.view.excalidrawAPI);
    if (live) return live;
    const leaf = app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: 'excalidraw', state: { file: E.drawing }, active: true });
    for (const started = Date.now(); !leaf.view.excalidrawAPI && Date.now() - started < 10000;) await new Promise(resolve => setTimeout(resolve, 200));
    if (leaf.view.getViewType() !== 'excalidraw' || !leaf.view.excalidrawAPI) throw new Error('The drawing did not reopen in an Excalidraw view');
    await new Promise(resolve => setTimeout(resolve, 800));
    return leaf;
  };`;

/**
 * Drags `note` from the file explorer onto the drawing's canvas (at `at`, fractions of the canvas box) holding
 * `modifiers` (Input.dispatchDragEvent bits: Alt=1, Ctrl=2, Meta=4, Shift=8), then waits for the drawing to stop
 * changing and returns what the drop added: `kind` is 'map' when it holds the map's root title and its lines,
 * 'none' when nothing was added, and 'other' otherwise (Excalidraw's own default, a link to the note).
 */
export function makeFileDrag(cdp, evaluate) {
  return async (note, { modifiers = 0, at = [0.5, 0.8] } = {}) => {
    const points = await evaluate(`${DRAWING_LEAF}
      const leaf = await drawingLeaf();
      app.workspace.leftSplit.expand();
      const explorer = app.workspace.getLeavesOfType('file-explorer')[0];
      if (!explorer) throw new Error('No file explorer to drag from');
      await app.workspace.revealLeaf(explorer);
      explorer.view.revealInFolder(app.vault.getFileByPath(${JSON.stringify(note)}));
      await new Promise(resolve => setTimeout(resolve, 600));
      app.workspace.setActiveLeaf(leaf, { focus: true });
      await new Promise(resolve => setTimeout(resolve, 600));
      const item = document.querySelector('.nav-file-title[data-path=' + JSON.stringify(${JSON.stringify(note)}) + ']');
      if (!item) throw new Error('The note is not in the file explorer');
      const from = item.getBoundingClientRect();
      const canvas = leaf.view.containerEl.querySelector('canvas.interactive') ?? leaf.view.containerEl.querySelector('canvas');
      const to = canvas.getBoundingClientRect();
      E.before = new Set(leaf.view.excalidrawAPI.getSceneElements().map(element => element.id));
      return { from: { x: from.left + from.width / 2, y: from.top + from.height / 2 },
        to: { x: to.left + to.width * ${at[0]}, y: to.top + to.height * ${at[1]} } };`);
    const mouse = (type, point) => cdp.send('Input.dispatchMouseEvent', {
      type, x: point.x, y: point.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
    });
    await cdp.send('Input.setInterceptDrags', { enabled: true });
    let data;
    try {
      const intercepted = cdp.once('Input.dragIntercepted', 8000);
      // Awaited below; this only keeps its timeout from becoming an unhandled rejection (which ends the process
      // before the case's finally re-enables the plugins) when a mouse event throws first.
      intercepted.catch(() => {});
      await mouse('mousePressed', points.from);
      for (let step = 1; step <= 5; step += 1) await mouse('mouseMoved', { x: points.from.x + step * 8, y: points.from.y + step * 2 });
      ({ data } = await intercepted);
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await cdp.send('Input.dispatchDragEvent', { type, x: points.to.x, y: points.to.y, data, modifiers });
      }
    } finally {
      await mouse('mouseReleased', points.to);
      await cdp.send('Input.setInterceptDrags', { enabled: false });
    }
    // The map is inserted a render or two after the drop (Mappy measures each label in Excalidraw first): poll
    // until the added elements stop changing, rather than guessing a sleep.
    let added = [];
    for (let last = -1, stable = 0, started = Date.now(); Date.now() - started < 10000 && stable < 3;) {
      await wait(300);
      added = await evaluate(`${DRAWING_LEAF}
        const leaf = await drawingLeaf();
        return leaf.view.excalidrawAPI.getSceneElements().filter(element => !E.before.has(element.id) && !element.isDeleted)
          .map(element => ({ type: element.type, text: element.text ?? null, link: element.link ?? null }));`);
      stable = added.length === last && added.length > 0 ? stable + 1 : 0;
      last = added.length;
    }
    const texts = added.filter(element => element.type === 'text').map(element => element.text);
    const lines = added.filter(element => element.type === 'line').length;
    const kind = added.length === 0 ? 'none' : texts.includes(MAP_ROOT) && lines > 0 ? 'map' : 'other';
    return { kind, count: added.length, texts, lines, links: added.map(element => element.link).filter(Boolean), dragData: data.items.map(item => item.mimeType) };
  };
}

/** Step body: closes the case's leaves and deletes its drawing and notes (the vault's own files are not the case's). */
export function makeDrawingClean(evaluate, notes) {
  return () => evaluate(`const E = window.__mappyExcalidrawE2E;
    const paths = [E.drawing, ...${JSON.stringify(notes)}];
    const closed = [];
    app.workspace.iterateAllLeaves(item => {
      const path = item.view.file?.path ?? item.getViewState().state?.file;
      if (paths.includes(path)) closed.push(item);
    });
    for (const leaf of closed) leaf.detach();
    await new Promise(resolve => setTimeout(resolve, 400));
    const removed = [];
    for (const path of paths) {
      const file = app.vault.getAbstractFileByPath(path);
      if (file) { await app.vault.delete(file, true); removed.push(path); }
    }
    E.off();
    delete window.__mappyExcalidrawE2E;
    return { removed, leavesClosed: closed.length };`);
}

/**
 * Step body: with Mappy unloaded for a moment, a `mappy: true` note has to open as Markdown. A window that ran a build
 * which never took its routing off `WorkspaceLeaf.prototype.setViewState` keeps routing after that build is gone —
 * `--reload` does not undo it — and would make a build without routing look like one with it (docs/harness.md
 * 「壊したビルドの検証は、変種ごとに Obsidian を起動し直す」). Mappy is enabled again whatever happens.
 */
export function makeNoStaleRouting(evaluate, note) {
  return () => evaluate(`
    await app.plugins.disablePlugin('mappy');
    let opens;
    try {
      const leaf = app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: 'markdown', state: { file: ${JSON.stringify(note)} } });
      opens = leaf.view.getViewType();
      leaf.detach();
    } finally {
      await app.plugins.enablePlugin('mappy');
    }
    for (const started = Date.now(); !app.plugins.plugins.mappy && Date.now() - started < 10000;) await new Promise(resolve => setTimeout(resolve, 100));
    if (opens !== 'markdown') {
      throw new Error('With Mappy unloaded the note still opened as ' + opens + ': this window routes through a wrapper an earlier build left behind. Restart Obsidian.');
    }
    return { opensWithoutMappy: opens };`);
}
