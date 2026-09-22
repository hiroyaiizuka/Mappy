/**
 * Shared browser-side helpers for a case file (docs/harness.md 実機検証): reading the map view's DOM,
 * clicking a node until it is selected, the plugin/open steps every case starts with, and the synthetic
 * image paste E37 and E19 both drive. Each case still makes its own `connect()` (process isolation: a
 * hung or crashed case does not leave a later one driving a stale CDP socket), so this only removes the
 * ~60 lines of identical script string every case repeated, not the per-case connection.
 */
import { installedVersion, wait } from './cdp.mjs';

/** Read out of the view under test: its nodes, its inline editor, every message on screen, and its source. */
export const VIEW = `const leaf = window.__mappyE2E; const view = leaf.view; const el = view.contentEl;
  const nodes = () => Array.from(el.querySelectorAll('.mappy-node'));
  const label = node => node.getAttribute('aria-label') ?? '';
  const nth = (title, index) => nodes().filter(node => label(node) === title)[index];
  const input = () => el.querySelector('textarea.mappy-inline-input');
  const messages = () => [
    ...Array.from(el.querySelectorAll('.mappy-inline-error'), item => item.textContent.trim()),
    ...Array.from(document.querySelectorAll('.notice'), item => item.textContent.trim()),
  ].filter(Boolean);
  const source = () => app.vault.read(view.file);`;

/** Click a node until the map shows it selected: the first click after the view opens can land mid-layout. */
export function makeSelect(cdp, evaluate) {
  return async (title, index = 0) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const box = await evaluate(`${VIEW}
        const node = nth(${JSON.stringify(title)}, ${index});
        if (!node) throw new Error('No node ' + ${JSON.stringify(title)} + ' #' + ${index});
        const rect = node.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      }
      await wait(400);
      const selected = await evaluate(`${VIEW}
        return nth(${JSON.stringify(title)}, ${index})?.classList.contains('is-selected') ?? false;`);
      if (selected) return;
    }
    throw new Error(`The map would not select ${title} #${index}`);
  };
}

/** What the map shows: its messages, whether a draft is open, its node labels, and the note's own text. */
export function makeState(evaluate) {
  return () => evaluate(`${VIEW}
    return { messages: messages(), editing: !!input(), labels: nodes().map(label), source: await source() };`);
}

/**
 * A blank click inside the canvas (its top-left corner, away from the small fixtures' nodes): moves focus
 * into the view before a chord like ⌘Z that only the canvas's own `keydown` listener catches
 * (`src/ui/map-events.ts`'s `hotkey()` requires `this.canvas.contains(event.targetNode)`). Without it, a
 * command whose earlier step left focus elsewhere (blur, `showSource`'s `editor.focus()`) is not
 * `preventDefault`-ed and reaches the OS instead — the macOS-menu hang docs/harness.md warns about.
 */
export function makeFocusCanvas(cdp, evaluate) {
  return async () => {
    const box = await evaluate(`${VIEW}
      const rect = el.querySelector('.mappy-canvas').getBoundingClientRect();
      return { x: rect.left + 12, y: rect.top + 12 };`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await wait(200);
  };
}

/** Step body for `step('plugin', ...)`: optionally reloads the plugin, then asserts it is actually loaded. */
export function makePluginStep(cdp, evaluate, flag) {
  return async () => {
    if (flag('--reload')) {
      await evaluate(`
        if (document.querySelector('.mappy-inline-input')) throw new Error('A draft is open in this window');
        if (typeof app.plugins.loadManifests === 'function') await app.plugins.loadManifests();
        await app.plugins.disablePlugin('mappy'); await app.plugins.enablePlugin('mappy');
        await new Promise(resolve => setTimeout(resolve, 800));
        return true;`);
    }
    const version = await installedVersion(cdp);
    if (version === null) {
      // A vault opened for the first time starts in restricted mode, and then the plugin is enabled in the
      // settings but never loaded: `app.plugins.setEnable(true)` in the window turns community plugins on.
      throw new Error('Mappy is not loaded in this window (restricted mode?). Turn community plugins on and retry.');
    }
    return { version, reloaded: flag('--reload') };
  };
}

/**
 * Step body for `step('open', ...)`: writes the fixture note, opens it as a map, and records what the
 * vault already held (`window.__mappyE2EBefore`) so `clean` removes only what this run added.
 */
export function makeOpenStep(evaluate, { note, source, layout = 'mindmap' }) {
  return () => evaluate(`
    const existing = app.vault.getAbstractFileByPath(${JSON.stringify(note)});
    if (existing) await app.vault.modify(existing, ${JSON.stringify(source)});
    else await app.vault.create(${JSON.stringify(note)}, ${JSON.stringify(source)});
    await new Promise(resolve => setTimeout(resolve, 400));
    const opened = app.workspace.getLeaf('tab');
    await opened.setViewState({ type: 'mappy-map', state: { file: ${JSON.stringify(note)}, layout: ${JSON.stringify(layout)} }, active: true });
    await new Promise(resolve => setTimeout(resolve, 1500));
    app.workspace.setActiveLeaf(opened, { focus: true });
    window.__mappyE2E = opened;
    window.__mappyE2EBefore = new Set(app.vault.getFiles().map(file => file.path));
    ${VIEW}
    return { labels: nodes().map(label), source: await source() };`);
}

/**
 * The image a case pastes: 120x80, a blue block with a white border, written as bytes so nothing has to
 * reach the OS clipboard. Big enough that a screenshot shows whether the node actually drew it — a
 * one-pixel image would pass a "the node has an image" check while the map still looks empty.
 */
export const PNG_FIXTURE = 'new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,120,0,0,0,80,8,2,0,0,0,93,249,38,222,0,0,0,154,73,68,65,84,120,218,237,221,65,13,0,48,8,4,65,28,85,26,86,113,212,138,128,144,62,230,178,10,198,192,197,181,149,5,2,208,160,173,9,125,178,52,24,104,208,160,5,26,52,104,208,160,65,11,52,104,208,160,65,131,22,104,208,160,65,131,6,45,208,160,65,131,6,13,90,160,65,131,6,13,26,180,64,131,6,13,26,52,104,129,6,13,26,52,104,208,2,13,26,52,104,208,160,5,26,52,104,208,160,65,11,52,104,208,160,65,131,22,104,208,160,65,131,6,45,208,160,65,131,6,13,90,160,65,131,6,13,26,180,64,131,6,13,122,31,218,60,11,129,54,208,95,237,1,30,135,250,163,100,147,87,160,0,0,0,0,73,69,78,68,174,66,96,130])';

/** The clipboard as Obsidian delivers an image: a paste event carrying a file. The OS clipboard cannot be driven from CDP; everything past this event is the shipped code. */
export function makePaste(evaluate) {
  return name => evaluate(`${VIEW}
    const canvas = el.querySelector('.mappy-canvas');
    const file = new File([${PNG_FIXTURE}], ${JSON.stringify(name)}, { type: 'image/png' });
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [file] } });
    (document.activeElement ?? canvas).dispatchEvent(event);
    return true;`);
}
