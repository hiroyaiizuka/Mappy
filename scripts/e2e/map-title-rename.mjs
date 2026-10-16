/**
 * E87 マップの表札からの改名（LEV-340、本人の報告 2026-10-16）: マップの画面の上部のノート名（view header の title。
 * 以下「表札」）を押して名前を打ち変えると、Markdown の表札と同じくノートの名前が変わる。マップは開いたままで、
 * タブと表札はノート名だけ（「· マップ」を付けない）。コマンド「ファイルタイトルの編集」（`workspace:edit-file-title`）も
 * マップで効いて表札の編集に入る。マップの上（ノード）の F2 は従来どおりノードの編集（E02）。
 * 修正前（0.4.8 まで）はマップが `EditableFileView` でなく、表札は押しても編集にならず、コマンドはマップでは
 * 出なかった（タブと表札は「<名前> · マップ」）。
 *
 * 行列は本人の操作 × 対象の形（AGENTS.md）:
 *   操作: 表札を実クリック → 打ち変え → 実キーの Enter／空白の実クリック（フォーカスを外す）／Escape、コマンド（直接・
 *         コマンドパレットで検索して実キーの Enter）、ノードの上の実キーの F2、表札の上の実キーの F2、日本語の変換中の Enter
 *   形:   フォルダの中のノート・Vault の直下、日本語の名前、同じ名前のノートがある、空の名前・使えない文字、
 *         同じノートを Markdown の別のタブでも開いている、ファイル名が根になるマップ（LEV-301）、ノードの入力欄を開いたまま
 *         （表札を押す。打った下書きと、打っていない下書き〔保存が blur の最中に終わる〕。同じ原因の対照として、隣の
 *         Markdown を押す: 下書きの保存がフォーカスをノードへ取り返していた）、
 *         ほかのノートからリンクされている（リンクの更新は Obsidian の設定どおり。既定の「確かめる」でダイアログ）
 * 表札の文字は、押したあと JS の選択で全体を選んでから `Input.insertText` で打つ（⌘A の実キーは macOS のメニューへ
 * 抜けうるので送らない。docs/harness.md 実機検証）。表札にフォーカスが入らなかった行は、打たずに失敗として残す
 * （打った文字や Enter がほかへ届かないように）。各行はノートを書き直して開き直す。
 *
 * Usage: npm run harness:e2e:map-title-rename -- [--reload] [--json <out.json>] [--shot <out.png>] [--keep]
 *   --shot  writes the window with the map's title being edited (the click row, before Enter)
 */
import { connect, VAULT, wait } from './cdp.mjs';
import { parseArgs, createRecord, makeStep, makeCheck, finish, StopCase, required } from './case-runner.mjs';
import { VIEW, makeSelect, makePluginStep, makeOpenStep, makeFocusCanvas, makeMarkSeen, makePress } from './dom-helpers.mjs';
import { ERRORS } from './window-helpers.mjs';

const { flag, value } = parseArgs();

const FOLDER = 'Fixtures/E2E-map-title';
const NAME = 'ローンチメール';
const RENAMED = 'ローンチメール改';
const NOTE = `${FOLDER}/${NAME}.md`;
/** The vault-root shape: a note outside any folder. */
const ROOT_NOTE = 'E2E-表札.md';
const FM = '---\nmappy: true\n---\n';
/** The root node is the heading, so the rename changes the header and the tab but not the map. */
const SOURCE = `${FM}\n## 講座の案内\n\n- 件名\n  - 本文\n`;
/** No heading: the root node is the file name (LEV-301), so the rename shows on the map too. */
const ROOTLESS = `${FM}- 件名\n  - 本文\n`;
const SUFFIXES = [' · マップ', ' · map'];

const record = createRecord(VAULT, NOTE);
const cdp = await connect();
const evaluate = expression => cdp.evaluate(`(async () => { ${expression} })()`);
const step = makeStep(record);
const check = makeCheck(record);
const select = makeSelect(cdp, evaluate);
const focusCanvas = makeFocusCanvas(cdp, evaluate);
const markSeen = makeMarkSeen(evaluate);
const press = makePress(cdp, evaluate);

/** The header as the window shows it, the map's root, the note and what is on screen; read after `VIEW`. */
const LOOK = `
  const title = view.titleEl;
  const selection = document.getSelection();
  const root = el.querySelector('.mappy-node.is-root:not(.is-topic)');
  const errors = Array.from(document.querySelectorAll('.tooltip.mod-error'), item => item.textContent.trim());
  return {
    type: leaf.view?.getViewType?.() ?? null, path: leaf.view?.file?.path ?? null,
    title: title?.textContent ?? null, editable: !!title?.isContentEditable, focused: !!title && document.activeElement === title,
    selected: selection && title && selection.rangeCount > 0 && title.contains(selection.anchorNode) ? selection.toString() : null,
    tab: leaf.tabHeaderInnerTitleEl?.textContent ?? null, window: document.title,
    inView: el.contains(document.activeElement), root: root ? label(root) : null,
    messages: messages(), titleErrors: errors, editing: !!input(),
    labels: nodes().map(label), source: leaf.view?.file ? await app.vault.read(leaf.view.file) : null,
  };`;
const look = () => evaluate(`${VIEW} ${LOOK}`);

/** Whether a note is at `path` now, and the text there. */
const at = path => evaluate(`const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)}); return file ? await app.vault.read(file) : null;`);

/** Polls until a note is at `path` (or `timeout` ms passed): the rename is Obsidian's, and its write lands a moment later. */
async function arrived(path, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await at(path) !== null) { await wait(500); return true; }
    await wait(100);
  }
  return false;
}

/** Every leaf on the case's notes closed, their modals too, and the notes deleted; the folder is there for the next row. */
async function reset() {
  await evaluate(`
    document.querySelectorAll('.modal-container .modal-close-button').forEach(button => button.click());
    const ours = path => (path ?? '').startsWith(${JSON.stringify(`${FOLDER}/`)}) || (path ?? '').startsWith('E2E-表札');
    app.workspace.getLeavesOfType('mappy-map').forEach(item => item.detach());
    app.workspace.getLeavesOfType('markdown').filter(item => ours(item.view.file?.path) || ours(item.getViewState().state?.file)).forEach(item => item.detach());
    await new Promise(resolve => setTimeout(resolve, 300));
    for (const file of app.vault.getFiles().filter(file => ours(file.path))) await app.vault.delete(file);
    if (!app.vault.getAbstractFileByPath(${JSON.stringify(FOLDER)})) await app.vault.createFolder(${JSON.stringify(FOLDER)});
    return true;`);
}

async function open(note = NOTE, source = SOURCE) {
  await reset();
  await makeOpenStep(evaluate, { note, source })();
  await markSeen();
}

/** A real click on the header's title; then, if the title took the focus, all of its text selected (as a user would before typing over it). */
async function clickTitle({ selectAll = true } = {}) {
  await press('const node = view.titleEl;');
  await wait(400);
  return evaluate(`${VIEW}
    const title = view.titleEl;
    if (document.activeElement !== title) return false;
    if (${selectAll}) {
      const range = document.createRange(); range.selectNodeContents(title);
      const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }
    return true;`);
}

/** Types `name` over the selected title and presses `finish` ('Enter', 'Escape' or 'blur': a blank click on the canvas). */
async function typeAndFinish(name, finish) {
  if (name !== null) await cdp.insertText(name);
  await wait(200);
  const typed = await evaluate(`${VIEW} return view.titleEl.textContent;`);
  if (finish === 'blur') await focusCanvas();
  else await cdp.realKey(finish);
  await wait(600);
  return typed;
}

/** One row of the click shapes: open, click the title, type, finish; what was typed and what the window then shows. */
async function clickRow({ note = NOTE, source = SOURCE, name = RENAMED, finish = 'Enter', expect } = {}) {
  await open(note, source);
  const before = await look();
  const focused = await clickTitle();
  if (!focused) return { before, focused, after: await look() };
  const typed = await typeAndFinish(name, finish);
  const renamed = expect ? await arrived(expect) : null;
  return { before, focused, typed, renamed, after: await look() };
}

const folderPath = name => `${FOLDER}/${name}.md`;

/**
 * The checks every row that renames shares: the note moved, the map stayed on it, and the header and the tab say its name
 * only. `notice` (a RegExp) is a Notice the row expects from Obsidian itself (the links it updated).
 */
function checkRenamed(label, result, name, path, source, notice) {
  check(result?.focused === true, `${label}: the title did not take the focus (editable: ${JSON.stringify(result?.before?.editable ?? result?.opened?.editable)})`);
  check(result?.renamed === true, `${label}: no note at ${path}`);
  check(result?.after?.type === 'mappy-map' && result.after.path === path, `${label}: the leaf shows ${result?.after?.type} ${result?.after?.path}`);
  check(result?.after?.title === name && result.after.tab === name, `${label}: the header reads ${JSON.stringify(result?.after?.title)} and the tab ${JSON.stringify(result?.after?.tab)}, not ${name}`);
  check(result?.after?.source === source, `${label}: the note now reads ${JSON.stringify(result?.after?.source)}`);
  const messages = (result?.after?.messages ?? []).filter(message => !notice?.test(message));
  check(messages.length === 0 && result?.after?.titleErrors?.length === 0, `${label}: showed ${JSON.stringify([result?.after?.messages, result?.after?.titleErrors])}`);
  check(result?.after?.focused === false, `${label}: the title kept the focus`);
}

/** The checks of a row that must not rename: the note is where it was, the header back to its name, the error said. */
async function checkKept(label, result, { error }) {
  check(result?.focused === true, `${label}: the title did not take the focus on a click`);
  check(result?.refused?.titleErrors?.length > 0 === error, `${label}: the title's error was ${JSON.stringify(result?.refused?.titleErrors)}`);
  check(result?.after?.path === NOTE && await at(NOTE) === SOURCE, `${label}: the note is at ${result?.after?.path}`);
  check(result?.after?.title === NAME && result.after.tab === NAME, `${label}: the header reads ${JSON.stringify(result?.after?.title)}, the tab ${JSON.stringify(result?.after?.tab)}`);
}

let exitCode = 1;
try {
  required(record, 'plugin', await step('plugin', makePluginStep(cdp, evaluate, flag)));
  await step('setup', () => evaluate(`${ERRORS} return { obsidian: require('electron').ipcRenderer.sendSync('version'), alwaysUpdateLinks: app.vault.getConfig('alwaysUpdateLinks') ?? null };`));

  // The labels: the tab, the header and the window say the note's name, nothing else; the title is editable.
  const labels = await step('labels', async () => { await open(); return look(); });
  check(labels?.title === NAME && labels.tab === NAME, `labels: the header reads ${JSON.stringify(labels?.title)} and the tab ${JSON.stringify(labels?.tab)}, not ${NAME}`);
  check(!SUFFIXES.some(suffix => labels?.window?.includes(suffix)), `labels: the window title is ${JSON.stringify(labels?.window)}`);
  check(labels?.editable === true, 'labels: the header title is not editable');

  // Click, type, Enter: the report's operation on a note in a folder (the shape of 「…/Mail/ローンチメールマップ」).
  const enter = await step('click-enter', async () => {
    await open();
    const before = await look();
    const focused = await clickTitle();
    if (!focused) return { before, focused, after: await look() };
    await cdp.insertText(RENAMED);
    await wait(200);
    if (value('--shot')) await cdp.screenshot(value('--shot'));
    await cdp.realKey('Enter');
    const renamed = await arrived(folderPath(RENAMED));
    return { before, focused, renamed, gone: await at(NOTE) === null, after: await look() };
  });
  checkRenamed('click-enter', enter, RENAMED, folderPath(RENAMED), SOURCE);
  check(enter?.gone === true, 'click-enter: the old note is still there');
  check(enter?.after?.inView === true, 'click-enter: Enter did not hand the focus back to the map');
  check(enter?.after?.root === '講座の案内', `click-enter: the root reads ${JSON.stringify(enter?.after?.root)}`);

  // Blur (a blank click on the map) confirms too; a note at the vault's root.
  const blur = await step('click-blur-vault-root', () => clickRow({ note: ROOT_NOTE, name: 'E2E-表札-改', finish: 'blur', expect: 'E2E-表札-改.md' }));
  checkRenamed('click-blur-vault-root', blur, 'E2E-表札-改', 'E2E-表札-改.md', SOURCE);

  // Escape puts the name back and renames nothing.
  const escape = await step('click-escape', () => clickRow({ name: '取り消す名前', finish: 'Escape' }));
  check(escape?.focused === true, 'click-escape: the title did not take the focus on a click');
  check(escape?.typed === '取り消す名前', `click-escape: typed ${JSON.stringify(escape?.typed)}`);
  check(escape?.after?.path === NOTE && escape.after.title === NAME && escape.after.tab === NAME && escape.after.focused === false && escape.after.inView === true,
    `click-escape: ${JSON.stringify(escape?.after)}`);

  // The command, run as a hotkey or a menu runs it: the title is focused with its name selected.
  const command = await step('command', async () => {
    await open();
    const available = await evaluate(`return !!app.commands.commands['workspace:edit-file-title']?.checkCallback?.(true);`);
    const ran = await evaluate(`return app.commands.executeCommandById('workspace:edit-file-title');`);
    await wait(400);
    const opened = await look();
    if (!opened.focused) return { available, ran, opened };
    await cdp.insertText(RENAMED);
    await cdp.realKey('Enter');
    const renamed = await arrived(folderPath(RENAMED));
    return { available, ran, opened, focused: true, renamed, after: await look() };
  });
  check(command?.available === true && command.ran === true, `command: available ${command?.available}, ran ${command?.ran}`);
  check(command?.opened?.focused === true && command.opened.selected === NAME, `command: the title is ${JSON.stringify(command?.opened && { focused: command.opened.focused, selected: command.opened.selected })}`);
  checkRenamed('command', command, RENAMED, folderPath(RENAMED), SOURCE);

  // Obsidian's other `EditableFileView` check: 「現在のビューをブックマーク」 bookmarks the map's note (before, the command
  // was off on a map: product-plan §5 M2, LEV-89's known issue). Only whether it is offered; nothing is bookmarked.
  const bookmark = await step('bookmark-view', async () => {
    await open();
    return evaluate(`return { available: app.commands.commands['bookmarks:bookmark-current-view']?.checkCallback?.(true) ?? null };`);
  });
  check(bookmark?.available === true, `bookmark-view: 「現在のビューをブックマーク」 is ${JSON.stringify(bookmark?.available)} on the map`);

  // The same from the command palette: searched by its name and run with a real Enter — only when it is the one selected.
  const palette = await step('palette', async () => {
    await open();
    const name = await evaluate(`return app.commands.commands['workspace:edit-file-title'].name;`);
    await evaluate(`app.commands.executeCommandById('command-palette:open'); return true;`);
    await wait(400);
    await cdp.insertText(name);
    await wait(500);
    const offered = await evaluate(`return Array.from(document.querySelectorAll('.prompt .suggestion-item'), item => ({ text: item.querySelector('.suggestion-title, .suggestion-content')?.textContent.trim() ?? item.textContent.trim(), selected: item.classList.contains('is-selected') }));`);
    const chosen = offered.find(item => item.selected)?.text ?? null;
    if (chosen !== name) { await cdp.realKey('Escape'); await wait(300); return { name, offered, chosen, after: await look() }; }
    await cdp.realKey('Enter');
    await wait(500);
    const opened = await look();
    if (opened.focused) { await cdp.realKey('Escape'); await wait(400); }
    return { name, offered, chosen, opened, after: await look() };
  });
  check(palette?.chosen === palette?.name, `palette: the palette offered ${JSON.stringify(palette?.offered)}`);
  check(palette?.opened?.focused === true && palette.opened.selected === NAME, `palette: the title is ${JSON.stringify(palette?.opened && { focused: palette.opened.focused, selected: palette.opened.selected })}`);
  check(palette?.after?.path === NOTE && palette.after.title === NAME, `palette: Escape left ${JSON.stringify(palette?.after && { path: palette.after.path, title: palette.after.title })}`);

  // F2 on a node is still the map's: the node's input opens, the title stays as it is (E02, LEV-48).
  const f2Node = await step('F2-node', async () => {
    await open();
    await select('件名');
    await cdp.realKey('F2');
    await wait(600);
    const opened = await look();
    const draft = await evaluate(`${VIEW} return input()?.value ?? null;`);
    await cdp.realKey('Escape');
    await wait(400);
    return { opened, draft, after: await look() };
  });
  check(f2Node?.opened?.editing === true && f2Node.draft === '件名', `F2-node: the node's input is ${JSON.stringify(f2Node?.draft)}`);
  check(f2Node?.opened?.focused === false, 'F2-node: F2 on the node went to the title');
  check(f2Node?.after?.editing === false && f2Node.after.path === NOTE && f2Node.after.source === SOURCE, `F2-node: ${JSON.stringify(f2Node?.after)}`);

  // F2 with the title focused (the caret at its end): Obsidian's F2, as on a Markdown note — the whole name selected.
  const f2Title = await step('F2-title', async () => {
    await open();
    const focused = await clickTitle({ selectAll: false });
    if (!focused) return { focused, after: await look() };
    await evaluate(`${VIEW} const selection = document.getSelection(); selection.selectAllChildren(view.titleEl); selection.collapseToEnd(); return true;`);
    const caret = await look();
    await cdp.realKey('F2');
    await wait(400);
    const pressed = await look();
    await cdp.realKey('Escape');
    await wait(400);
    return { focused, caret, pressed, after: await look() };
  });
  check(f2Title?.focused === true, 'F2-title: the title did not take the focus on a click');
  check(f2Title?.caret?.selected === '' && f2Title.pressed?.focused === true && f2Title.pressed.selected === NAME && f2Title.pressed.editing === false,
    `F2-title: F2 left ${JSON.stringify(f2Title?.pressed && { focused: f2Title.pressed.focused, selected: f2Title.pressed.selected, editing: f2Title.pressed.editing })}`);
  check(f2Title?.after?.path === NOTE && f2Title.after.title === NAME, `F2-title: ${JSON.stringify(f2Title?.after)}`);

  // Japanese through an IME: the Enter that confirms a conversion (keyCode 229) does not rename; the next Enter does.
  const ime = await step('ime-enter', async () => {
    await open();
    const focused = await clickTitle();
    if (!focused) return { focused, after: await look() };
    await cdp.send('Input.imeSetComposition', { text: 'ろーんち', selectionStart: 4, selectionEnd: 4 });
    await cdp.realKey('Enter', 0, undefined, 229);
    await wait(600);
    const composing = { ...await look(), note: await at(NOTE) !== null };
    await cdp.insertText('ローンチ');
    await wait(200);
    await cdp.realKey('Enter');
    const renamed = await arrived(folderPath('ローンチ'));
    return { focused, composing, renamed, after: await look() };
  });
  check(ime?.composing?.note === true && ime.composing.focused === true, `ime-enter: the conversion's Enter renamed or left the title: ${JSON.stringify(ime?.composing && { focused: ime.composing.focused, path: ime.composing.path })}`);
  checkRenamed('ime-enter', ime, 'ローンチ', folderPath('ローンチ'), SOURCE);

  // A name another note in the folder has: refused with Obsidian's message, the note stays; Escape puts the name back.
  for (const [label, name, error] of [['taken', '既存', true], ['empty', '', true], ['invalid', 'a:b', true]]) {
    const result = await step(label, async () => {
      await open();
      if (label === 'taken') await evaluate(`await app.vault.create(${JSON.stringify(folderPath('既存'))}, '- 既存\\n'); return true;`);
      const focused = await clickTitle();
      if (!focused) return { focused, after: await look() };
      if (name === '') await cdp.realKey('Backspace'); else await cdp.insertText(name);
      await wait(200);
      await cdp.realKey('Enter');
      await wait(800);
      const refused = await look();
      await cdp.realKey('Escape');
      await wait(500);
      return { focused, refused, other: label === 'taken' ? await at(folderPath('既存')) : null, after: await look() };
    });
    await checkKept(label, result, { error });
    if (label === 'taken') check(result?.other === '- 既存\n', `taken: the other note reads ${JSON.stringify(result?.other)}`);
  }

  // The same note in a Markdown tab beside the map (Mappy's own split): both tabs follow the rename.
  const beside = await step('markdown-beside', async () => {
    await open();
    await evaluate(`await window.__mappyE2E.view.showSource(true); await new Promise(resolve => setTimeout(resolve, 800));
      app.workspace.setActiveLeaf(window.__mappyE2E, { focus: true }); await new Promise(resolve => setTimeout(resolve, 400)); return true;`);
    const before = await look();
    const focused = await clickTitle();
    if (!focused) return { before, focused, after: await look() };
    await typeAndFinish(RENAMED, 'Enter');
    const renamed = await arrived(folderPath(RENAMED));
    const markdown = await evaluate(`return app.workspace.getLeavesOfType('markdown').filter(item => item.view.file && item.view.file.path.startsWith(${JSON.stringify(`${FOLDER}/`)}))
      .map(item => ({ path: item.view.file.path, title: item.view.titleEl?.textContent ?? null, tab: item.tabHeaderInnerTitleEl?.textContent ?? null }));`);
    return { before, focused, renamed, markdown, after: await look() };
  });
  checkRenamed('markdown-beside', beside, RENAMED, folderPath(RENAMED), SOURCE);
  check(beside?.markdown?.length === 1 && beside.markdown[0].path === folderPath(RENAMED) && beside.markdown[0].title === RENAMED,
    `markdown-beside: the Markdown tab shows ${JSON.stringify(beside?.markdown)}`);

  // A map whose root is the file name (LEV-301): the root takes the new name.
  const fileRoot = await step('file-root', async () => {
    const result = await clickRow({ source: ROOTLESS, expect: folderPath(RENAMED) });
    await wait(600);
    return { ...result, after: await look() };
  });
  checkRenamed('file-root', fileRoot, RENAMED, folderPath(RENAMED), ROOTLESS);
  check(fileRoot?.before?.root === NAME && fileRoot.after?.root === RENAMED, `file-root: the root read ${JSON.stringify(fileRoot?.before?.root)} → ${JSON.stringify(fileRoot?.after?.root)}`);

  // A node's input open when the title is pressed: the input's blur saves the draft, then the title renames the note.
  const draft = await step('draft-open', async () => {
    await open();
    await select('件名');
    await cdp.realKey('F2');
    await wait(600);
    await cdp.insertText('件名（下書き）');
    await wait(200);
    const before = await look();
    const focused = await clickTitle();
    await wait(600);
    const saved = await look();
    if (!focused) return { before, focused, saved, after: saved };
    await typeAndFinish(RENAMED, 'Enter');
    const renamed = await arrived(folderPath(RENAMED));
    return { before, focused, saved, renamed, after: await look() };
  });
  const drafted = SOURCE.replace('- 件名', '- 件名（下書き）');
  check(draft?.before?.editing === true, 'draft-open: the node input did not open');
  check(draft?.saved?.editing === false && draft.saved.source === drafted, `draft-open: pressing the title left ${JSON.stringify(draft?.saved && { editing: draft.saved.editing, source: draft.saved.source })}`);
  checkRenamed('draft-open', draft, RENAMED, folderPath(RENAMED), drafted);
  check(draft?.after?.labels?.includes('件名（下書き）'), `draft-open: the map shows ${JSON.stringify(draft?.after?.labels)}`);

  // Nothing typed: the draft's save writes nothing and ends while the blur still runs, before the focus reaches the
  // title (code review of LEV-340). The title must still get the focus and rename the note.
  const unchanged = await step('draft-unchanged', async () => {
    await open();
    await select('件名');
    await cdp.realKey('F2');
    await wait(600);
    const before = await look();
    const focused = await clickTitle();
    await wait(600);
    const pressed = await look();
    if (!focused || !pressed.focused) return { before, focused: focused && pressed.focused, pressed, after: pressed };
    await typeAndFinish(RENAMED, 'Enter');
    const renamed = await arrived(folderPath(RENAMED));
    return { before, focused: true, pressed, renamed, after: await look() };
  });
  check(unchanged?.before?.editing === true && unchanged.pressed?.editing === false, `draft-unchanged: the node input was ${JSON.stringify([unchanged?.before?.editing, unchanged?.pressed?.editing])}`);
  checkRenamed('draft-unchanged', unchanged, RENAMED, folderPath(RENAMED), SOURCE);

  // The same draft closed by a press in the Markdown editor beside the map: saved, and the press keeps the editor and its
  // leaf (the save used to give the keyboard and the active leaf back to the map's node; same cause as draft-open).
  const away = await step('draft-markdown', async () => {
    await open();
    await evaluate(`await window.__mappyE2E.view.showSource(true); await new Promise(resolve => setTimeout(resolve, 800));
      app.workspace.setActiveLeaf(window.__mappyE2E, { focus: true });
      const map = window.__mappyE2E.view; map.viewport.fit(map.layout.bounds); await new Promise(resolve => setTimeout(resolve, 500)); return true;`);
    await select('件名');
    await cdp.realKey('F2');
    await wait(600);
    await cdp.insertText('件名（下書き）');
    await wait(200);
    await press(`const node = app.workspace.getLeavesOfType('markdown').find(item => item.view.file?.path === ${JSON.stringify(NOTE)})?.view.contentEl.querySelector('.cm-content');`);
    await wait(1200);
    // The note is open in an editor, so the map's save is an Editor edit, on disk only at Obsidian's debounce: read the editor.
    const where = await evaluate(`${VIEW} const active = document.activeElement;
      const markdown = app.workspace.getLeavesOfType('markdown').find(item => item.view.file?.path === ${JSON.stringify(NOTE)});
      return { inMap: el.contains(active), markdown: !!active?.closest?.('.cm-editor'), leaf: app.workspace.activeLeaf?.view?.getViewType() ?? null,
        text: markdown?.view.editor?.getValue() ?? null };`);
    return { where, after: await look() };
  });
  check(away?.after?.editing === false && away.where?.text === drafted, `draft-markdown: the press left ${JSON.stringify({ editing: away?.after?.editing, text: away?.where?.text })}`);
  check(away?.where?.markdown === true && away.where.inMap === false && away.where.leaf === 'markdown', `draft-markdown: the focus is ${JSON.stringify(away?.where)}`);

  // Another note links to the map's: Obsidian asks (its default) and, told to update this once, rewrites the link.
  const links = await step('links', async () => {
    await open();
    await evaluate(`await app.vault.create(${JSON.stringify(folderPath('リンク元'))}, '[[${NAME}]]\\n'); await new Promise(resolve => setTimeout(resolve, 800)); return true;`);
    const focused = await clickTitle();
    if (!focused) return { focused, after: await look() };
    await cdp.insertText(RENAMED);
    await cdp.realKey('Enter');
    await wait(1000);
    const dialog = await evaluate(`const modal = document.querySelector('.modal-container .modal');
      if (!modal) return null;
      const buttons = Array.from(modal.querySelectorAll('.modal-button-container button'));
      const text = { title: modal.querySelector('.modal-title')?.textContent ?? null, buttons: buttons.map(button => button.textContent) };
      // Obsidian's order: always update, update this once, do not update.
      buttons[1]?.click();
      return text;`);
    const renamed = await arrived(folderPath(RENAMED));
    await wait(800);
    return { focused, dialog, renamed, linking: await at(folderPath('リンク元')), after: await look() };
  });
  // Obsidian's notice of the links it updated (its own text; the case runs in Japanese, cdp.mjs `LANGUAGE`).
  checkRenamed('links', links, RENAMED, folderPath(RENAMED), SOURCE, /リンク|link/iu);
  // The vault's 「内部リンクを常に更新」 decides whether Obsidian asks first (the generated vault leaves it off).
  if (record.steps.setup?.alwaysUpdateLinks === true) check(links?.dialog === null, `links: Obsidian asked although it always updates: ${JSON.stringify(links?.dialog)}`);
  else check(links?.dialog?.buttons?.length === 3, `links: Obsidian's dialog was ${JSON.stringify(links?.dialog)}`);
  check(links?.linking === `[[${RENAMED}]]\n`, `links: the linking note reads ${JSON.stringify(links?.linking)}`);

  const errors = await step('page-errors', () => evaluate('return window.__mappyE2EErrors ?? null;'));
  check(Array.isArray(errors) && errors.length === 0, `page errors: ${JSON.stringify(errors)}`);
} catch (error) {
  if (!(error instanceof StopCase)) record.failures.push(`unexpected: ${error}`);
} finally {
  if (!flag('--keep')) await step('clean', async () => { await reset(); return evaluate(`const folder = app.vault.getAbstractFileByPath(${JSON.stringify(FOLDER)}); if (folder) await app.vault.delete(folder, true); return true;`); });
  exitCode = await finish(record, value('--json'));
  cdp.close();
}
process.exit(exitCode);
