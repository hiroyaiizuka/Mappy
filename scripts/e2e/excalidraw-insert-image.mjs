/**
 * E27 (docs/harness.md, §5 M6): Excalidraw's own insert routes for `mappy: true` notes, on the real Obsidian, through
 * Excalidraw itself (LEV-352). Each row drags notes from the file explorer onto a new drawing with the modifiers the
 * user holds (`dragPointer`: Obsidian's own `dragstart`, then Excalidraw's drop handler), and where Excalidraw opens its
 * "Insert File From Vault" dialog, presses the dialog's button with the pointer. The earlier E27 record
 * (`artifacts/lev-118-excalidraw-e2e`) called Mappy's hook and added the dialog's element with EA itself, and opened
 * the drawing once; the person's report (both the map and the Markdown image left in the drawing) needs the drawing's
 * file merged back into a view, which happens when it is open twice (row `image-dialog-two-panes`).
 *
 * The matrix is the user's gesture × the shape of the note (AGENTS.md):
 * - Shift ("Insert Image") → dialog → "as Image", for a map like the report's (root, five branches, children, a link),
 *   in one pane, in two panes of the same drawing, and on a dark drawing with a map holding a picture;
 * - Shift+Ctrl ("Insert Image @100%", no dialog); Shift with two notes selected (one in a folder; no dialog);
 * - Ctrl ("Insert Interactive-Frame") → dialog → "as Embeddable"; Shift on a plain note (Excalidraw's own image stays);
 * - Option (Mappy's native insert) and no modifier (a link) for the routes Mappy leaves as they were.
 * After the drop each row waits for the drawing to settle, saves the drop's pane as autosave does (`view.save()`),
 * waits for the other pane to merge the file, and reopens the drawing: a Markdown image of a map must be gone at
 * every point, and the map's SVG image (`<note>.svg` beside the drawing, the map's proportions, longer side at most 500,
 * `link` to the note) there.
 *
 * Usage: npm run harness:e2e:excalidraw-insert-image -- [--reload] [--rows a,b] [--json <out.json>] [--shot <out.png>] [--keep]
 *   --reload  re-enable Mappy first, so a build made after Obsidian started is the one under test
 *   --rows    run only these rows (names below)
 *   --shot    the screen with both panes of row image-dialog-two-panes just after the save (nothing without that row)
 *   --keep    leave the notes, drawings and attachments in the vault
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required, until } from './case-runner.mjs';
import { makePluginStep } from './dom-helpers.mjs';
import { dragPointer, makeDrawingSetup, makeRestore, noteName } from './excalidraw-helpers.mjs';

const { flag, value } = parseArgs();

const FOLDER = 'Fixtures/E2E-insert-image';
const PLAIN = 'Fixtures/E2E-insert-image-plain.md';
const REPORT = 'Fixtures/E2E-insert-image-report.md';
const SMALL = 'Fixtures/E2E-insert-image-small.md';
const PICTURE = 'Fixtures/E2E-insert-image-picture.md';
const NESTED = `${FOLDER}/E2E-insert-image-nested.md`;
const map = lines => ['---', 'mappy: true', '---', ...lines, ''].join('\n');
const NOTES = {
  // The report's shape: root 10X第4期, five first-level branches with children, a link. Its Markdown image is taller
  // than the map's, so a Markdown image left under the map shows below it, as in the report's screenshot (long child
  // labels make the map wide, so at 500 wide it is shorter).
  [REPORT]: map(['## 10X第4期', '', '- b1', `  - b1-1 最初の週に決めること [[${noteName(PLAIN)}]]`, '  - b1-2 毎朝の振り返りの時間を取る', '- b2',
    '  - b2-1 一緒に進める人を三人決める', '  - b2-2 週に一度の共有の場を作る', '- b3', '  - b3-1 数字で測れる目標に言い換える', '- b4',
    '  - b4-1 月末に結果をまとめて見直す', '  - b4-2 うまくいかなかった理由を書き残す', '- b5', '  - b5-1 次の期に持ち越すことを選ぶ',
    '  - b5-2 終わったら祝う']),
  [SMALL]: map(['## 小さなマップ', '', '- 枝 1', '- 枝 2']),
  [PICTURE]: map(['## 画像入り', '', '- 図', '  - ![[sample-image.svg]]', '- 文字だけ']),
  [NESTED]: map(['## フォルダの中', '', '- 枝 A', '- 枝 B']),
  [PLAIN]: ['# 通常ノート', '', '- 箇条書き', ''].join('\n'),
};
/** The text of SMALL's root: Option's native insert writes it as a text element. */
const SMALL_ROOT = '小さなマップ';
const SHIFT = 8;
const CTRL = 2;
const ALT = 1;

/**
 * `expect`: `map-image` (each note's Markdown image replaced by its map's SVG image), `embeddable` (a borderless frame),
 * `markdown` (Excalidraw's own Markdown image, left alone), `native` (Mappy's elements), `link` (a link text).
 */
const ROWS = [
  { name: 'image-dialog', notes: [REPORT], modifiers: SHIFT, dialog: 'image', expect: 'map-image' },
  { name: 'image-dialog-two-panes', notes: [REPORT], modifiers: SHIFT, dialog: 'image', panes: 2, expect: 'map-image' },
  { name: 'image-dialog-dark', notes: [PICTURE], modifiers: SHIFT, dialog: 'image', theme: 'dark', expect: 'map-image' },
  { name: 'image-full-size', notes: [SMALL], modifiers: SHIFT + CTRL, expect: 'map-image' },
  { name: 'image-two-notes', notes: [NESTED, PICTURE], modifiers: SHIFT, expect: 'map-image' },
  { name: 'embeddable-dialog', notes: [SMALL], modifiers: CTRL, dialog: 'embeddable', expect: 'embeddable' },
  { name: 'plain-image-dialog', notes: [PLAIN], modifiers: SHIFT, dialog: 'image', expect: 'markdown' },
  { name: 'option', notes: [SMALL], modifiers: ALT, expect: 'native' },
  { name: 'link', notes: [SMALL], modifiers: 0, expect: 'link' },
];
const only = value('--rows')?.split(',');
const rows = only ? ROWS.filter(row => only.includes(row.name)) : ROWS;
if (only && rows.length !== only.length) throw new Error(`Unknown row in --rows ${only.join(',')}; rows: ${ROWS.map(row => row.name).join(', ')}`);

const record = createRecord(VAULT, REPORT);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const restore = await makeRestore(evaluate);

/** Script string: `readPane(leaf)` lists the live elements a pane got since the drop, with the vault file an image shows. */
const READ_PANE = `const readPane = leaf => {
    const view = leaf.view;
    return view.excalidrawAPI.getSceneElements().filter(element => !window.__mappyExcalidrawE2E.before.has(element.id)).map(element => ({
      id: element.id, type: element.type, link: element.link ?? null, strokeColor: element.strokeColor,
      // Excalidraw shows a parsed link without its brackets; the raw text keeps them.
      text: element.text ?? null, raw: element.rawText ?? element.originalText ?? null,
      width: Math.round(element.width), height: Math.round(element.height),
      file: element.type === 'image' ? view.excalidrawData.getFile(element.fileId)?.file?.path ?? null : null,
    }));
  };`;

/** The panes on the row's drawing: the drop's first, then the other (when the row opened one). */
const readPanes = () => evaluate(`${READ_PANE}
  const E = window.__mappyExcalidrawE2E;
  return [E.leaf, E.other].filter(Boolean).map(leaf => leaf.view?.excalidrawAPI ? readPane(leaf) : null);`);

/** Whether a pane is what the row expects; returns the reasons it is not (empty when it is). */
function verdict(row, pane, svgs) {
  if (!pane) return ['the pane has no drawing'];
  const reasons = [];
  const images = pane.filter(element => element.type === 'image');
  if (row.expect === 'map-image') {
    for (const note of row.notes) {
      const name = noteName(note);
      if (images.some(element => element.file === note)) reasons.push(`${name}: the Markdown image is still in the drawing`);
      const mapped = images.filter(element => element.file && element.file.replace(/^.*\//u, '') === `${name}.svg`);
      if (mapped.length !== 1) { reasons.push(`${name}: ${mapped.length} map images, not 1`); continue; }
      const [image] = mapped;
      if (image.link !== `[[${name}]]`) reasons.push(`${name}: the map image links ${image.link}, not [[${name}]]`);
      const svg = svgs[image.file];
      if (!svg) { reasons.push(`${name}: the attachment ${image.file} was not read`); continue; }
      // EA's addImage with scale brings the longer side down to 500 and never up: a small map keeps its own size.
      const longer = Math.min(500, Math.max(svg.width, svg.height));
      if (Math.abs(Math.max(image.width, image.height) - longer) > 1) reasons.push(`${name}: the map image is ${image.width}×${image.height}, not ${Math.round(longer)} on its longer side`);
      if (Math.abs(image.width / image.height - svg.width / svg.height) > 0.02 * (svg.width / svg.height)) {
        reasons.push(`${name}: the map image is ${image.width}×${image.height}, not the map's proportions ${svg.width}×${svg.height}`);
      }
    }
    // Any other image is a leftover too, also one whose file Excalidraw does not name (yet).
    const known = new Set(row.notes.flatMap(note => [note, `${noteName(note)}.svg`]));
    for (const element of images) {
      if (!element.file || (!known.has(element.file) && !known.has(element.file.replace(/^.*\//u, '')))) reasons.push(`an image that is not a map image: ${element.file ?? 'no file'}`);
    }
  } else if (row.expect === 'embeddable') {
    const frames = pane.filter(element => element.type === 'embeddable');
    if (frames.length !== 1) reasons.push(`${frames.length} frames, not 1`);
    else if (frames[0].strokeColor !== 'transparent') reasons.push(`the frame keeps its border (${frames[0].strokeColor})`);
    else if (Math.max(frames[0].width, frames[0].height) > 800) reasons.push(`the frame is ${frames[0].width}×${frames[0].height}, longer than 800`);
    if (images.length > 0) reasons.push(`${images.length} images beside the frame`);
  } else if (row.expect === 'markdown') {
    if (images.filter(element => element.file === row.notes[0]).length !== 1) reasons.push(`Excalidraw's Markdown image of the plain note is not there: ${JSON.stringify(images)}`);
    if (images.some(element => element.file?.endsWith('.svg'))) reasons.push('a plain note got a map image');
  } else if (row.expect === 'native') {
    if (!pane.some(element => element.type === 'text' && element.text === SMALL_ROOT) || !pane.some(element => element.type === 'line')) {
      reasons.push(`Option did not insert the map's elements: ${JSON.stringify(pane.map(element => element.type))}`);
    }
    if (images.length > 0) reasons.push('Option inserted an image');
  } else if (row.expect === 'link') {
    const link = `[[${noteName(row.notes[0])}]]`;
    if (!pane.some(element => element.type === 'text' && [element.text, element.raw].some(text => text?.includes(link)))) reasons.push(`no link text: ${JSON.stringify(pane)}`);
    if (images.length > 0) reasons.push('a plain drag inserted an image');
  }
  return reasons;
}

/**
 * Whether Mappy is done with the drop as far as the panes show: for a map image, each note has its map image and no
 * Markdown image; for a frame, it lost its border. The settle wait does not stop before that (or its time limit), so a
 * paint that takes a while is not read half way.
 */
function done(row, panes) {
  return panes.every(pane => {
    if (!pane) return false;
    if (row.expect === 'embeddable') return pane.some(element => element.type === 'embeddable' && element.strokeColor === 'transparent');
    if (row.expect !== 'map-image') return pane.length > 0;
    return row.notes.every(note => !pane.some(element => element.file === note)
      && pane.some(element => element.file?.replace(/^.*\//u, '') === `${noteName(note)}.svg`));
  });
}

/** Width and height of each SVG attachment the panes show, from the file's root `<svg>`. */
const readSvgs = panes => evaluate(`const paths = ${JSON.stringify([...new Set(panes.flat().filter(Boolean).map(element => element.file).filter(file => file?.endsWith('.svg')))])};
  const sizes = {};
  for (const path of paths) {
    const file = app.vault.getFileByPath(path);
    const root = file ? (await app.vault.read(file)).match(/<svg[^>]*>/u)?.[0] ?? '' : '';
    const width = Number(root.match(/\\bwidth="([\\d.]+)"/u)?.[1]);
    const height = Number(root.match(/\\bheight="([\\d.]+)"/u)?.[1]);
    if (width > 0 && height > 0) sizes[path] = { width, height };
  }
  return sizes;`);

/** One row: a new drawing, the drop, the dialog, then the drawing read after settling, after a save, and reopened. */
async function runRow(row) {
  const drawing = `Fixtures/E2E-insert-image-${row.name}.excalidraw.md`;
  const result = { row: row.name };
  required(record, `${row.name}:setup`, await step(`${row.name}:setup`, makeDrawingSetup(evaluate, { notes: NOTES, drawing })));
  result.prepared = await evaluate(`const E = window.__mappyExcalidrawE2E;
    const view = E.leaf.view;
    if (${JSON.stringify(row.theme === 'dark')}) {
      view.excalidrawAPI.updateScene({ appState: { theme: 'dark' } });
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (${row.panes === 2}) {
      const other = app.workspace.createLeafBySplit(E.leaf, 'vertical');
      await other.setViewState({ type: 'excalidraw', state: { file: E.drawing } });
      for (let started = Date.now(); !other.view.excalidrawAPI && Date.now() - started < 10000;) await new Promise(resolve => setTimeout(resolve, 200));
      if (!other.view.excalidrawAPI) throw new Error('The second pane did not open the drawing');
      await new Promise(resolve => setTimeout(resolve, 1200));
      E.other = other;
    }
    E.files = new Set(app.vault.getFiles().map(file => file.path));
    E.sources = {};
    for (const path of ${JSON.stringify(Object.keys(NOTES))}) E.sources[path] = await app.vault.read(app.vault.getFileByPath(path));
    return { theme: view.excalidrawAPI.getAppState().theme, panes: E.other ? 2 : 1 };`);
  const points = await evaluate(`const E = window.__mappyExcalidrawE2E;
    const notes = ${JSON.stringify(row.notes)};
    app.workspace.leftSplit.expand();
    const explorer = app.workspace.getLeavesOfType('file-explorer')[0];
    if (!explorer) throw new Error('No file explorer to drag from');
    await app.workspace.revealLeaf(explorer);
    // The dragged note last, so the explorer has it on screen.
    for (const note of [...notes].reverse()) explorer.view.revealInFolder(app.vault.getFileByPath(note));
    await new Promise(resolve => setTimeout(resolve, 600));
    const tree = explorer.view.tree;
    tree.clearSelectedDoms?.();
    if (notes.length > 1) for (const note of notes) tree.selectItem(explorer.view.fileItems[note]);
    app.workspace.setActiveLeaf(E.leaf, { focus: true });
    await new Promise(resolve => setTimeout(resolve, 600));
    const item = document.querySelector('.nav-file-title[data-path=' + JSON.stringify(notes[0]) + ']');
    if (!item) throw new Error('The note is not in the file explorer');
    const from = item.getBoundingClientRect();
    const canvas = E.leaf.view.containerEl.querySelector('canvas.interactive') ?? E.leaf.view.containerEl.querySelector('canvas');
    const to = canvas.getBoundingClientRect();
    E.before = new Set(E.leaf.view.excalidrawAPI.getSceneElementsIncludingDeleted().map(element => element.id));
    return { from: { x: from.left + from.width / 2, y: from.top + from.height / 2 }, to: { x: to.left + to.width * 0.4, y: to.top + to.height * 0.4 } };`);
  const data = await dragPointer(cdp, points, row.modifiers);
  result.dragged = data.items.map(item => item.mimeType);
  if (row.dialog) {
    // The dialog Excalidraw opens for one Markdown note; its highlighted button is the action the modifier asked for.
    const button = await until(() => evaluate(`const modal = [...document.querySelectorAll('.modal-container .modal')].at(-1);
      const button = modal && [...modal.querySelectorAll('button.mod-cta')].find(item => item.offsetParent);
      if (!button) return null;
      const box = button.getBoundingClientRect();
      return { text: button.textContent, title: modal.querySelector('.modal-title')?.textContent ?? null, x: box.left + box.width / 2, y: box.top + box.height / 2 };`), 5000, 'Excalidraw did not open its insert dialog');
    result.dialog = { title: button.title, button: button.text };
    check(new RegExp(row.dialog, 'iu').test(button.text), `${row.name}: the dialog offered "${button.text}" first, not ${row.dialog}`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: button.x, y: button.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
    }
  }
  // Settled: Mappy is done (or 15 s passed, which is how a build that leaves the Markdown image is read), and then the
  // panes read the same for three polls in a row (~1.2 s).
  let panes = await readPanes();
  const started = Date.now();
  for (let last = '', quiet = 0; Date.now() - started < 25000;) {
    await wait(400);
    panes = await readPanes();
    const now = JSON.stringify(panes);
    quiet = now === last && panes.some(pane => pane?.length) ? quiet + 1 : 0;
    last = now;
    if (quiet >= 3 && (done(row, panes) || Date.now() - started > 15000)) break;
  }
  result.settled = panes;
  result.settledAfter = Date.now() - started;
  // Saved as autosave saves it; the other pane gets the file's modify and merges it.
  result.saved = await evaluate(`${READ_PANE}
    const E = window.__mappyExcalidrawE2E;
    await E.leaf.view.save();
    await new Promise(resolve => setTimeout(resolve, 2500));
    return [E.leaf, E.other].filter(Boolean).map(readPane);`);
  // The evidence the report is about: both panes of the drawing just after the save (the shot of row image-dialog-two-panes).
  const shot = value('--shot');
  if (shot && row.panes === 2) {
    await evaluate(`const E = window.__mappyExcalidrawE2E;
      for (const leaf of [E.leaf, E.other]) leaf.view.zoomToFit(false);
      await new Promise(resolve => setTimeout(resolve, 600));
      return true;`);
    result.shot = await cdp.screenshot(shot);
  }
  // Reopened: what the file holds.
  result.reopened = await evaluate(`${READ_PANE}
    const E = window.__mappyExcalidrawE2E;
    for (const leaf of [E.leaf, E.other].filter(Boolean)) leaf.detach();
    delete E.other;
    await new Promise(resolve => setTimeout(resolve, 800));
    // With only an empty, never-active leaf left in the main area, getLeaf('tab') throws "No tab group found".
    let leaf;
    try { leaf = app.workspace.getLeaf('tab'); } catch { leaf = app.workspace.getLeaf(false); }
    await leaf.setViewState({ type: 'excalidraw', state: { file: E.drawing }, active: true });
    for (let started = Date.now(); !leaf.view.excalidrawAPI && Date.now() - started < 10000;) await new Promise(resolve => setTimeout(resolve, 200));
    await new Promise(resolve => setTimeout(resolve, 2000));
    E.leaf = leaf;
    return [readPane(leaf)];`);
  const svgs = await readSvgs([...result.settled, ...result.saved, ...result.reopened]);
  result.svgs = svgs;
  for (const [stage, list] of [['settled', result.settled], ['saved', result.saved], ['reopened', result.reopened]]) {
    list.forEach((pane, index) => {
      for (const reason of verdict(row, pane, svgs)) check(false, `${row.name} (${stage}, pane ${index + 1}): ${reason}`);
    });
  }
  const after = await evaluate(`const E = window.__mappyExcalidrawE2E;
    const changed = [];
    for (const [path, text] of Object.entries(E.sources)) if (await app.vault.read(app.vault.getFileByPath(path)) !== text) changed.push(path);
    return { changed, errors: [...E.errors], notices: [...document.querySelectorAll('.notice')].map(notice => notice.textContent) };`);
  result.notices = after.notices;
  check(after.changed.length === 0, `${row.name}: notes changed: ${after.changed.join(', ')}`);
  check(after.errors.length === 0, `${row.name}: page errors: ${JSON.stringify(after.errors)}`);
  return result;
}

/** Closes the row's drawing and deletes it with the attachments made during the row (only the case's own `E2E-insert-image*` files). */
const cleanRow = () => evaluate(`const E = window.__mappyExcalidrawE2E;
  if (!E) return null;
  try {
    app.workspace.getLeavesOfType('excalidraw').filter(leaf => leaf.view.file?.path === E.drawing).forEach(leaf => leaf.detach());
    await new Promise(resolve => setTimeout(resolve, 400));
    const removed = [];
    // A row that stopped before it listed the vault's files (E.files) still has its drawing to remove, and nothing else.
    for (const file of app.vault.getFiles()) {
      if (file.path !== E.drawing && (!E.files || E.files.has(file.path) || !file.name.startsWith('E2E-insert-image'))) continue;
      await app.vault.delete(file, true);
      removed.push(file.path);
    }
    return removed;
  } finally {
    E.off();
    delete window.__mappyExcalidrawE2E;
  }`);

try {
  record.steps.versions = await evaluate(`return { obsidian: require('electron').ipcRenderer.sendSync('version'),
    excalidraw: app.plugins.plugins['obsidian-excalidraw-plugin']?.manifest.version ?? null, mappy: app.plugins.plugins.mappy?.manifest.version ?? null };`);
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  required(record, 'folder', await step('folder', () => evaluate(`
    if (!app.vault.getAbstractFileByPath(${JSON.stringify(FOLDER)})) await app.vault.createFolder(${JSON.stringify(FOLDER)});
    return ${JSON.stringify(FOLDER)};`)));
  record.rows = {};
  for (const row of rows) {
    try {
      record.rows[row.name] = await runRow(row);
    } catch (error) {
      if (error instanceof StopCase) throw error;
      record.failures.push(`${row.name}: stopped: ${error}`);
      record.rows[row.name] = { error: String(error) };
    } finally {
      // The dialog of a row that stopped early would sit over the next row's drop.
      await evaluate(`document.querySelectorAll('.modal-container .modal-close-button').forEach(button => button.click()); return true;`).catch(() => {});
      if (!flag('--keep')) record.rows[row.name].cleaned = await cleanRow().catch(error => String(error));
    }
    console.log(row.name, JSON.stringify(record.rows[row.name]).slice(0, 600));
  }
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`stopped: ${error}`);
} finally {
  if (!flag('--keep')) {
    record.steps.clean = await evaluate(`const removed = [];
      for (const path of ${JSON.stringify(Object.keys(NOTES))}) {
        const file = app.vault.getAbstractFileByPath(path);
        if (file) { await app.vault.delete(file, true); removed.push(path); }
      }
      const folder = app.vault.getAbstractFileByPath(${JSON.stringify(FOLDER)});
      if (folder && folder.children.length === 0) { await app.vault.delete(folder, true); removed.push(${JSON.stringify(FOLDER)}); }
      return removed;`).catch(error => ({ error: String(error) }));
  }
  record.steps.restore = await restore();
  if (record.steps.restore.failure) record.failures.push(record.steps.restore.failure);
  cdp.close();
}

process.exit(await finish(record, value('--json')));
