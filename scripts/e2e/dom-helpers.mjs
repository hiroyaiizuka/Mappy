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
    // A notice marked seen (\`makeMarkSeen\`) was already on screen before the step that reads this.
    ...Array.from(document.querySelectorAll('.notice:not([data-mappy-e2e-seen])'), item => item.textContent.trim()),
  ].filter(Boolean);
  const source = () => app.vault.read(view.file);`;

/**
 * Script string, after `node` is a map node: where a real click on it would go. `hit` is whether the topmost
 * element at its centre is the node itself (or inside it); when it is not, `cover` names what is there instead —
 * the pane's edge, one of the map's floating controls (the gear, the layout and zoom buttons), or a Notice left
 * by the previous step. A Notice is dismissed (Obsidian closes one on a click; its text was read by the step
 * that showed it) so the next look can reach the node; anything else means a pointer event would land on
 * something other than the node, and the step would fail (or worse, pass) for a reason that is not the build's.
 */
const AIM = `const rect = node.getBoundingClientRect();
  const x = rect.left + rect.width / 2; const y = rect.top + rect.height / 2;
  const top = document.elementFromPoint(x, y);
  const hit = node.contains(top);
  const notice = hit ? null : top?.closest?.('.notice');
  if (notice) notice.click();
  const cover = hit ? null : notice ? 'a Notice (dismissed)' : top ? (top.className || top.tagName) : 'nothing (outside the window)';`;

/**
 * The centre of the `index`-th node titled `title`, in the window's CSS pixels, once a real pointer there would
 * reach it. Mid-layout (a fit, or a re-layout after an edit) the node can be briefly elsewhere, and a Notice
 * takes a moment to go: it looks again a few times before giving up with what was in the way.
 */
export function makeAim(evaluate) {
  return async (title, index = 0) => {
    let box;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      box = await evaluate(`${VIEW}
        const node = nth(${JSON.stringify(title)}, ${index});
        if (!node) throw new Error('No node ' + ${JSON.stringify(title)} + ' #' + ${index});
        ${AIM}
        return { x, y, hit, cover };`);
      if (box.hit) return { x: box.x, y: box.y };
      await wait(400);
    }
    throw new Error(`${title} #${index} cannot be reached at (${Math.round(box.x)},${Math.round(box.y)}): ${box.cover} is there`);
  };
}

/** Click a node until the map shows it selected: the first click after the view opens can land mid-layout. */
export function makeSelect(cdp, evaluate) {
  const aim = makeAim(evaluate);
  return async (title, index = 0) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const box = await aim(title, index);
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
 *
 * It first refuses a note some leaf is already on — a map or a Markdown editor, a tab restored in the
 * background (Obsidian's deferred view, which has no `view.file` yet) included through its view state. One
 * left there (a previous run's `--keep`, or one that stopped early) makes this map's edits Editor edits, saved
 * to disk only on Obsidian's debounce, so every source read after them would see the note before. The sidebar's
 * backlinks, outline and outgoing links name the active note too, but do not change how a write reaches disk.
 */
export function makeOpenStep(evaluate, { note, source, layout = 'mindmap' }) {
  return () => evaluate(`
    const already = [];
    app.workspace.iterateAllLeaves(item => {
      const state = item.getViewState();
      if (!['markdown', 'mappy-map'].includes(state.type)) return;
      if (item.view.file?.path === ${JSON.stringify(note)} || state.state?.file === ${JSON.stringify(note)}) already.push(state.type);
    });
    if (already.length) throw new Error('Close the leaves already on ' + ${JSON.stringify(note)} + ' first: ' + already.join(', '));
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


/** Marks every notice on screen now as seen, so `messages()` after the next action lists only what that action showed. */
export function makeMarkSeen(evaluate) {
  return () => evaluate(`document.querySelectorAll('.notice').forEach(item => item.setAttribute('data-mappy-e2e-seen', '')); return true;`);
}

/**
 * Waits until the note's text is no longer `before` and the map has re-read it (its parsed source is the note's),
 * then `SETTLE` ms more, and returns what the map shows then — or returns at `timeout` ms as it is, for a step
 * whose right answer is that nothing changes (the caller's byte comparison decides). Polling instead of a fixed
 * sleep: no dead time when the write lands quickly, and no race when it lands late. The extra wait after the
 * write is for what a build might do a task or two later — a Notice, a draft left open, another write — which
 * the step's `messages`/`editing` checks must still see.
 */
const SETTLE = 500;
export function makeAfter(evaluate) {
  const poll = () => evaluate(`${VIEW}
    const text = await source();
    return { source: text, mapCurrent: view.document?.source === text };`);
  const read = () => evaluate(`${VIEW}
    return { messages: messages(), editing: !!input(), labels: nodes().map(label), source: await source() };`);
  return async (before, timeout = 3000) => {
    const started = Date.now();
    for (;;) {
      const current = await poll();
      const changed = current.source !== before && current.mapCurrent;
      if (changed || Date.now() - started > timeout) {
        const waited = Date.now() - started;
        if (changed) await wait(SETTLE);
        return { ...await read(), waited };
      }
      await wait(100);
    }
  };
}

/**
 * A key that opens the inline editor on the selected node, then `title` and Enter to confirm it. With
 * `emptyWrite` (Enter／Tab: the new empty node is committed as its own history entry before the draft opens),
 * the text the Enter is compared against is read only once that empty node is on disk and the map has re-read
 * it — read earlier, a late empty-node write would pass for the title's.
 */
function makeDraft(cdp, evaluate) {
  const after = makeAfter(evaluate);
  const disk = () => evaluate(`${VIEW} const text = await source(); return { text, mapCurrent: view.document?.source === text };`);
  return async (key, title, { emptyWrite }) => {
    const original = (await disk()).text;
    await cdp.realKey(key);
    const started = Date.now();
    for (;;) {
      const editing = await evaluate(`${VIEW} return !!input();`);
      const current = emptyWrite ? await disk() : null;
      if (editing && (!emptyWrite || (current.text !== original && current.mapCurrent))) break;
      if (Date.now() - started > 3000) {
        throw new Error(editing ? `${key}'s new empty node never reached the note` : `${key} did not open the inline editor`);
      }
      await wait(100);
    }
    await cdp.insertText(title);
    await wait(300);
    const before = (await disk()).text;
    await cdp.realKey('Enter');
    return after(before);
  };
}

/** Enter (sibling) or Tab (child) on the selected node, then a title and Enter: the new node, named in place. */
export function makeAddNamed(cdp, evaluate) {
  const draft = makeDraft(cdp, evaluate);
  return (key, title) => draft(key, title, { emptyWrite: true });
}

/** F2 on the selected node, then `title` over its selected old one (`InlineEditor` selects it) and Enter: one rename, one history entry. */
export function makeRename(cdp, evaluate) {
  const draft = makeDraft(cdp, evaluate);
  return title => draft('F2', title, { emptyWrite: false });
}

/** ⌥↑ or ⌥↓ on the selected node (modifiers bit 1 = Alt). Only sent with no draft open (docs/harness.md 実機検証). */
export function makeMoveAlt(cdp, evaluate) {
  const after = makeAfter(evaluate);
  const state = makeState(evaluate);
  return async (key, timeout) => {
    const before = await state();
    if (before.editing) throw new Error(`${key} sent while a draft was open`);
    await cdp.realKey(key, 1);
    return after(before.source, timeout);
  };
}

/**
 * ⌘Z / ⌘⇧Z on the canvas (`MapEvents.keydown`: the history answers with nothing selected too). A blank click
 * first puts focus back in the canvas — the chord is only ever caught by the map's own `keydown` listener
 * while it is there, and otherwise reaches macOS and CDP hangs on the native dialog (docs/harness.md 実機検証).
 * Only sent with no draft open.
 */
export function makeHistory(cdp, evaluate) {
  const after = makeAfter(evaluate);
  const state = makeState(evaluate);
  const focusCanvas = makeFocusCanvas(cdp, evaluate);
  return async (direction, timeout) => {
    await focusCanvas();
    const before = await state();
    if (before.editing) throw new Error(`${direction} sent while a draft was open`);
    await cdp.realKey('z', direction === 'redo' ? 12 : 4);
    return after(before.source, timeout);
  };
}


/**
 * Script string, after VIEW: the map's own parse at the moment it runs (not the DOM's drawing) — `doc`, `byId`,
 * and `depth(node)`, the node's number of ancestors below the root. The one definition every case compares with.
 */
export const PARSE = `const doc = view.document;
  const byId = new Map(doc.nodes.map(node => [node.id, node]));
  const depth = node => { let d = 0; for (let at = node; at?.parentId && byId.has(at.parentId); at = byId.get(at.parentId)) d += 1; return d; };`;

/** The map's parse as data: its format, and each node's title, depth and parent's title in document order. */
export function makeTree(evaluate) {
  return () => evaluate(`${VIEW} ${PARSE}
    return { format: doc.format, nodes: doc.nodes.map(node => ({ title: node.title, depth: depth(node), parent: byId.get(node.parentId ?? '')?.title ?? doc.root.title })) };`);
}
