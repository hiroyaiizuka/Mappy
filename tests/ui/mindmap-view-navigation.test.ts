// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, TFile, ViewState, ViewStateResult } from 'obsidian';
import { HarnessApp } from '../../harness/browser/app';
import { installObsidianDom } from '../../harness/browser/dom';
import { EditableFileView, FileView, MarkdownView, Notice, Scope, WorkspaceLeaf, type View } from '../../harness/browser/obsidian';
import { readMapLayout } from '../../src/obsidian/frontmatter';
import { ViewRouter } from '../../src/obsidian/view-routing';
import { VIEW_TYPE } from '../../src/ui/mindmap-view';
import { mountMapView, type MountedMapView } from './map-view-mount';

// The browser-harness stand-in for `obsidian`, so the shipped view runs against a real DOM.
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });
const opened: MountedMapView[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  Notice.log.length = 0;
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const mounted of opened.splice(0)) await mounted.close();
  document.body.replaceChildren();
});

const PATH = 'Fixtures/navigation.md';
const OTHER = 'Fixtures/navigation-other.md';
const PLAIN = 'Fixtures/navigation-plain.md';
const SOURCE = ['---', 'mappy: true', '---', '## 講座の構成', '', '- はじめに', '  - 学ぶこと', '- 記録する', ''].join('\n');
/** A note without a heading section: the root node drawn is the virtual one, named after the file. */
const ROOTLESS = ['---', 'mappy: true', '---', '- はじめに', '- 記録する', ''].join('\n');

/**
 * The core commands whose `checkCallback` (1.14.2) is decided by the current file — `getActiveFile()`, which is the
 * active editor's file, else the active file view's (`getActiveFileView()`: the active leaf's view when it
 * navigates and is a FileView). Two more want a particular view: `workspace:edit-file-title` an `EditableFileView`
 * (the Markdown editor; it then starts renaming in the view header), `markdown:toggle-preview` the active editor.
 */
const FILE_COMMANDS = [
  'workspace:copy-path', 'workspace:copy-full-path', 'workspace:copy-url', 'app:delete-file', 'file-explorer:move-file',
  'file-explorer:duplicate-file', 'file-explorer:reveal-active-file', 'open-with-default-app:open', 'open-with-default-app:show',
  'markdown:clear-metadata-properties', 'editor:download-attachments',
] as const;
const VIEW_COMMANDS = ['workspace:edit-file-title', 'markdown:toggle-preview'] as const;

/** A leaf as the workspace model below sees it: the harness leaf, its view, when it was last active, and whether it is pinned. */
interface Leaf { leaf: WorkspaceLeaf; view: View; activeTime: number; pinned: boolean }

/**
 * Obsidian 1.14.2's resolution of "the current file", of the events that carry it and of a bare Escape, copied
 * from app.js (the original text is in artifacts/lev-48-f2-scope/inspect-workspace-scope*.result.json and
 * inspect-modifiers-navigation.result.json; `activeLeafEvents`, `getActiveFile` and the commands' `checkCallback`
 * in artifacts/lev-89-fileview/record.md): `view.navigation` decides which leaf, `instanceof FileView` whether it
 * has a file. jsdom has no workspace, so the model holds the leaves of one window and the routines that read them;
 * a FileView's `loadFile` reaches it through `app.workspace.requestActiveLeafEvents` as it reaches the real one.
 * The real keys and leaves are checked on the test vault (artifacts/lev-74-view-navigation, lev-89-fileview).
 */
class WorkspaceModel {
  activeLeaf: Leaf | null = null;
  /** `Workspace.lastActiveFile`: what `file-open` last carried. */
  lastActiveFile: TFile | null = null;
  /** Every `file-open` fired, in order. */
  readonly fileOpens: (TFile | null)[] = [];
  constructor(readonly leaves: Leaf[], private readonly app: HarnessApp) {}

  setActiveLeaf(leaf: Leaf | null, focus = false): void {
    this.activeLeaf = leaf;
    if (!leaf) return;
    leaf.activeTime = Date.now();
    // `focusLeaf`: the container takes the focus, then `setEphemeralState({ focus: true })` — the Markdown editor's.
    if (focus) (leaf.view as View & { focus?: () => void }).focus?.();
    // `requestActiveLeafEvents` (debounced to the next tick in Obsidian; at once here).
    this.activeLeafEvents();
  }

  /** `Workspace.activeLeafEvents`: `active-leaf-change`, then `file-open` when the current file is not the one last told. */
  activeLeafEvents(): void {
    this.app.workspaceEvents.trigger('active-leaf-change', this.activeLeaf?.leaf ?? null);
    const file = this.getActiveFile();
    if (file === this.lastActiveFile) return;
    this.lastActiveFile = file;
    this.fileOpens.push(file);
    this.app.workspaceEvents.trigger('file-open', file);
  }

  /** `Workspace.getActiveFileView`: the active leaf when it navigates, else the most recently active navigation leaf; a FileView or nothing. */
  getActiveFileView(): FileView | null {
    const active = this.activeLeaf;
    if (active?.view.navigation) return active.view instanceof FileView ? active.view : null;
    let recent: Leaf | null = null;
    let found: FileView | null = null;
    for (const leaf of this.leaves) {
      if (leaf.view.navigation && (!recent || recent.activeTime < leaf.activeTime)) {
        recent = leaf;
        found = leaf.view instanceof FileView ? leaf.view : null;
      }
    }
    return found;
  }

  /** `Workspace.activeEditor`: the Markdown view of the active leaf (nothing else sets one here). */
  activeEditor(): MarkdownView | null {
    const view = this.activeLeaf?.view;
    return view instanceof MarkdownView ? view : null;
  }

  /** `Workspace.getActiveFile`: the active editor's file, else the active file view's. */
  getActiveFile(): TFile | null {
    return this.activeEditor()?.file ?? this.getActiveFileView()?.file ?? null;
  }

  /** The commands' `checkCallback(true)`, as 1.14.2 writes them. */
  commands(): Record<(typeof FILE_COMMANDS)[number] | (typeof VIEW_COMMANDS)[number], boolean> {
    const file = this.getActiveFile();
    const note = file?.extension === 'md';
    return {
      'workspace:copy-path': !!file, 'workspace:copy-full-path': !!file, 'workspace:copy-url': !!file, 'app:delete-file': !!file,
      // `file-explorer:move-file` also wants a file that is not the root folder or an external one; a note is neither.
      'file-explorer:move-file': !!file, 'file-explorer:duplicate-file': !!file, 'file-explorer:reveal-active-file': !!file,
      'open-with-default-app:open': !!file, 'open-with-default-app:show': !!file,
      'markdown:clear-metadata-properties': note, 'editor:download-attachments': note,
      'workspace:edit-file-title': this.getActiveFileView() instanceof EditableFileView,
      'markdown:toggle-preview': this.activeEditor() !== null,
    };
  }

  /**
   * `WorkspaceLeaf.openFile`: the view type comes from the registry by extension (Markdown for a note) unless the
   * FileView shown accepts the extension; the state then goes through `setViewState`, which the ViewRouter wraps
   * (§8). Returns what the leaf would really receive.
   */
  openFile(leaf: Leaf, file: TFile, router: ViewRouter): ViewState {
    let type = file.extension === 'md' ? 'markdown' : `${file.extension}-view`;
    const view = leaf.view;
    if (view instanceof FileView && view.canAcceptExtension(file.extension)) type = view.getViewType();
    return router.route(leaf.leaf as never, { type, state: { file: file.path } });
  }

  /** `Workspace.getUnpinnedLeaf`, the target of `getLeaf(false)`: the active leaf if it can navigate, else the most recently active one that can, else a new leaf. */
  getUnpinnedLeaf(): Leaf | 'new' {
    const active = this.activeLeaf;
    if (active && this.canNavigate(active)) return active;
    let chosen: Leaf | null = null;
    for (const leaf of this.leaves) {
      if (this.canNavigate(leaf) && (!chosen || chosen.activeTime < leaf.activeTime)) chosen = leaf;
    }
    return chosen ?? 'new';
  }

  /** `WorkspaceLeaf.canNavigate`. */
  canNavigate(leaf: Leaf): boolean { return leaf.view.navigation && !leaf.pinned; }

  /**
   * The workspace's window `keydown` for a bare Escape. The branch that refocuses an active Markdown leaf's own
   * editor is left out: the active leaf is the map in every case here.
   */
  onEscape(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.key !== 'Escape' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (this.activeLeaf?.view.navigation) return;
    let target: Leaf | null = null;
    for (const leaf of this.leaves) {
      if (leaf.view.navigation && (!target || target.activeTime < leaf.activeTime)) target = leaf;
    }
    this.setActiveLeaf(target, true);
  }
}

/** The Markdown tab beside the map: an EditableFileView (navigation) whose editor takes the focus when the leaf does. */
class MarkdownBeside extends MarkdownView {
  readonly content: HTMLElement;
  constructor(leaf: WorkspaceLeaf, path: string) {
    super(leaf);
    this.file = leaf.app.vault.getAbstractFileByPath(path) as MarkdownView['file'];
    this.content = this.contentEl.createDiv({ cls: 'cm-content', attr: { contenteditable: 'true', tabindex: '0' } });
  }
  focus(): void { this.content.focus(); }
}

/** The plugin's router as src/main.ts builds it, over the harness vault's frontmatter. */
function routerFor(app: HarnessApp): ViewRouter {
  return new ViewRouter({
    mapViewType: VIEW_TYPE,
    isMapFile: path => {
      const file = app.vault.getFileByPath(path);
      return file !== null && readMapLayout(app.asApp<App>(), file as unknown as TFile) !== null;
    },
  });
}

async function mount(source = SOURCE) {
  const mounted = await mountMapView(PATH, source);
  opened.push(mounted);
  mounted.app.put(OTHER, source.replace('講座の構成', '別のノート'));
  const markdown = new MarkdownBeside(new WorkspaceLeaf(mounted.app.asApp<App>()), OTHER);
  document.body.append(markdown.containerEl);
  const map: Leaf = { leaf: mounted.view.leaf as unknown as WorkspaceLeaf, view: mounted.view as unknown as View, activeTime: 2, pinned: false };
  const beside: Leaf = { leaf: markdown.leaf, view: markdown, activeTime: 1, pinned: false };
  const workspace = new WorkspaceModel([map, beside], mounted.app);
  // What a FileView's `loadFile` reads off the workspace: the active leaf, and the request for its events.
  Object.defineProperty(mounted.app.workspace, 'activeLeaf', { configurable: true, get: () => workspace.activeLeaf?.leaf ?? null });
  Object.assign(mounted.app.workspace, { requestActiveLeafEvents: () => { workspace.activeLeafEvents(); } });
  workspace.setActiveLeaf(map);
  // Obsidian registers its Escape handler on the window at the bubble phase, after the map's own listeners.
  const onKey = (event: KeyboardEvent): void => { workspace.onEscape(event); };
  window.addEventListener('keydown', onKey);
  cleanups.push(() => { window.removeEventListener('keydown', onKey); });
  return { ...mounted, workspace, map, beside, markdown };
}

describe('MindmapView as a FileView (LEV-89: the current file, its events and the core commands beside a Markdown tab)', () => {
  it('is the current file view while active, so the current file is its own note, not the tab beside', async () => {
    const { view, file, workspace, map, markdown } = await mount();
    expect(view).toBeInstanceOf(FileView);
    expect(view.allowNoFile).toBe(false);
    expect(view.navigation).toBe(true);
    expect(workspace.activeLeaf).toBe(map);
    expect(workspace.getActiveFileView()).toBe(view);
    expect(workspace.getActiveFile()).toBe(file);
    // The shape before LEV-74, for the record: a non-navigation map handed the workspace the Markdown tab beside.
    view.navigation = false;
    expect(workspace.getActiveFileView()).toBe(markdown);
    expect(workspace.getActiveFile()?.path).toBe(OTHER);
    view.navigation = true;
    expect(workspace.getActiveFile()).toBe(file);
  });

  it('makes the core file commands address the map\'s note; the two that want an editor still decline', async () => {
    const { workspace, beside, map } = await mount();
    // The eleven decided by `getActiveFile()` (LEV-74 made them decline on the map: an ItemView had no file).
    const onMap = workspace.commands();
    for (const id of FILE_COMMANDS) expect(onMap[id], id).toBe(true);
    // `workspace:edit-file-title` wants an EditableFileView (the header-title rename) and `markdown:toggle-preview` the
    // active editor: neither is the map, so F2's default stays off here and the palette leaves both out.
    for (const id of VIEW_COMMANDS) expect(onMap[id], id).toBe(false);
    workspace.setActiveLeaf(beside);
    const onMarkdown = workspace.commands();
    for (const id of [...FILE_COMMANDS, ...VIEW_COMMANDS]) expect(onMarkdown[id], id).toBe(true);
    workspace.setActiveLeaf(map);
    expect(workspace.commands()['workspace:copy-path']).toBe(true);
  });

  it('carries its note in file-open: when its leaf becomes active and when a navigation replaces the note, not for the layout or the viewport', async () => {
    const { app, view, file, workspace, map, beside, settle } = await mount();
    const other = app.vault.getFileByPath(OTHER) as unknown as TFile;
    // The mount made the map leaf active: the outline, the backlinks, the properties and the recent files were told its note.
    expect(workspace.fileOpens).toEqual([file]);
    const told: (TFile | null)[] = [];
    app.workspaceEvents.on('file-open', opened => { told.push(opened as TFile | null); });
    workspace.setActiveLeaf(beside);
    expect(told).toEqual([other]);
    workspace.setActiveLeaf(map);
    expect(told).toEqual([other, file]);
    await view.setState({ file: PATH, layout: 'timeline', viewport: { x: 1, y: 2, scale: 1 } }, { history: false });
    await settle();
    expect(told).toEqual([other, file]);
    // Another note in this leaf (a link, the explorer, back／forward): FileView's own load tells the workspace.
    await view.setState({ file: OTHER, layout: 'mindmap' }, { history: false });
    await settle();
    expect(told).toEqual([other, file, other]);
    expect(workspace.getActiveFile()).toBe(other);
  });

  it('keeps F2 the map\'s key through its scope, with the default rename declining on the map either way', async () => {
    const { view, workspace, select, settle, editor, key } = await mount();
    const node = select('学ぶこと');
    const event = new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: node });
    // The keymap asks the active view's scope first: `false` consumes the key, and the inline editor is open.
    expect((view.scope as Scope).handleKey(event)).toBe(false);
    await settle();
    expect(editor()?.value).toBe('学ぶこと');
    expect(workspace.commands()['workspace:edit-file-title']).toBe(false);
    key(editor() as HTMLTextAreaElement, 'Escape');
    await settle();
    expect(editor()).toBeNull();
  });

  it('opens through the registry and the router, never by accepting the extension: a map note stays a map, a plain one turns to Markdown, a leaf switched on purpose keeps Markdown (E22)', async () => {
    const { app, file, view, workspace, map } = await mount();
    const router = routerFor(app);
    const other = app.vault.getFileByPath(OTHER) as unknown as TFile;
    const plain = app.put(PLAIN, '- 通常のノート\n') as unknown as TFile;
    expect(view.canAcceptExtension('md')).toBe(false);
    // A file chosen in the explorer or the quick switcher for the map leaf: Markdown by registration, a map by the router.
    expect(workspace.openFile(map, other, router)).toEqual({ type: VIEW_TYPE, state: { file: OTHER } });
    expect(workspace.openFile(map, plain, router)).toEqual({ type: 'markdown', state: { file: PLAIN } });
    // The plain note made a map later opens as one: the router remembered nothing about that leaf.
    app.put(PLAIN, '---\nmappy: true\n---\n- 通常のノート\n');
    expect(workspace.openFile(map, plain, router)).toEqual({ type: VIEW_TYPE, state: { file: PLAIN } });
    // E22: the leaf switched to Markdown by the toggle keeps Markdown for that note, and only that note.
    await router.openMarkdown(map.leaf as never, file);
    expect(workspace.openFile(map, file, router)).toEqual({ type: 'markdown', state: { file: PATH } });
    expect(workspace.openFile(map, other, router)).toEqual({ type: VIEW_TYPE, state: { file: OTHER } });
  });

  it('follows a rename of its note: the tab title, the root node, the state and the saved layout', async () => {
    const { app, view, file, map, settle } = await mount(ROOTLESS);
    expect(map.leaf.headerText).toBe('navigation · マップ');
    expect(view.containerEl.querySelector('.mappy-node[aria-label="navigation"]')).not.toBeNull();
    const saved = app.activity.filter(entry => entry.kind === 'layout-saved').length;
    app.rename(PATH, 'Fixtures/renamed.md');
    // FileView's own subscription: the same note under its new name, the tab title at once.
    expect(view.file).toBe(file);
    expect(map.leaf.headerText).toBe('renamed · マップ');
    // The map's: a debounced re-read, since the root node is the basename.
    await vi.waitFor(() => { expect(view.containerEl.querySelector('.mappy-node[aria-label="renamed"]')).not.toBeNull(); });
    await settle();
    expect(view.containerEl.querySelector('.mappy-node[aria-label="navigation"]')).toBeNull();
    expect(view.getState()).toMatchObject({ file: 'Fixtures/renamed.md' });
    expect(app.activity.filter(entry => entry.kind === 'layout-saved').length).toBeGreaterThan(saved);
  });

  it('leaves the leaf when its note is deleted: the empty view with no history, the previous note with one; a draft goes without a save', async () => {
    const { app, view, file, map, select, key, settle, editor } = await mount();
    const reads = vi.spyOn(app.vault, 'read');
    key(select('学ぶこと'), 'F2');
    await settle();
    (editor() as HTMLTextAreaElement).value = '学ぶこと（下書き）';
    // With nothing to go back to, FileView opens the empty view: the map closes, its draft is dropped, nothing is read or written.
    app.remove(PATH);
    await settle();
    expect(map.leaf.view).toBeNull();
    expect(view.file).toBeNull();
    expect(editor()).toBeNull();
    expect(reads).not.toHaveBeenCalled();
    expect(Notice.log).toEqual([]);
    expect(file.path).toBe(PATH);
    // The same with a step behind it: FileView goes back, and the map shows that note and tells the workspace.
    const again = await mount();
    again.map.leaf.history.backHistory.push({ type: VIEW_TYPE, state: { file: OTHER, layout: 'mindmap' } });
    again.key(again.select('学ぶこと'), 'F2');
    await again.settle();
    (again.editor() as HTMLTextAreaElement).value = '学ぶこと（下書き）';
    const before = again.workspace.fileOpens.length;
    again.app.remove(PATH);
    await again.settle();
    expect(again.map.leaf.view).toBe(again.view);
    expect(again.view.file?.path).toBe(OTHER);
    expect(again.view.containerEl.querySelector('.mappy-node[aria-label="別のノート"]')).not.toBeNull();
    expect(again.editor()).toBeNull();
    expect(Notice.log).toEqual([]);
    expect(again.workspace.fileOpens.slice(before)).toEqual([again.app.vault.getFileByPath(OTHER)]);
    expect(again.app.content(again.app.vault.getFileByPath(OTHER) as never)).not.toContain('下書き');
  });

  it('lets go of a deleted note itself when the leaf is busy and FileView\'s history step is refused', async () => {
    const { app, view, file, map, settle } = await mount();
    map.leaf.history.backHistory.push({ type: VIEW_TYPE, state: { file: OTHER, layout: 'mindmap' } });
    // A `setViewState` of this very note is in flight (its read is held): the leaf is `working`.
    let release = (): void => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const read = vi.spyOn(app.vault, 'read').mockImplementation(async target => { await held; return app.content(target); });
    const opening = map.leaf.setViewState({ type: VIEW_TYPE, state: { file: PATH, layout: 'timeline' } });
    await vi.waitFor(() => { expect(read).toHaveBeenCalled(); });
    expect(map.leaf.working).toBe(true);
    // 1.14.2's `history.go` refuses with "Tab is busy" while the leaf works: FileView cannot leave the note for the map.
    app.remove(PATH);
    await settle();
    expect(map.leaf.history.backHistory).toHaveLength(1);
    expect(map.leaf.view).toBe(view);
    // So the map lets go of it on its own: no note, the empty state (a debounced refresh), nothing written, no error of its own.
    expect(view.file).toBeNull();
    await vi.waitFor(() => { expect(view.containerEl.querySelector<HTMLElement>('.mappy-empty-state')?.hidden).toBe(false); });
    expect(view.containerEl.querySelector('.mappy-node')).toBeNull();
    expect(view.getState()).not.toHaveProperty('file');
    expect(Notice.log).toEqual(['Tab is busy']);
    release();
    await opening;
    await settle();
    expect(view.file).toBeNull();
    expect(file.path).toBe(PATH);
  });

  it('waits for a save the blur of the navigating click started, and tells when the draft is refused on the way out', async () => {
    const { app, view, select, key, settle, editor, source } = await mount();
    key(select('学ぶこと'), 'F2');
    await settle();
    const input = editor();
    if (!input) throw new Error('no editor');
    input.value = '学ぶこと（改）';
    // The node changed outside (E05) and the map has not re-read yet: the save under way will be refused.
    const external = SOURCE.replace('  - 学ぶこと\n', '  - 学ぶこと（外部）\n');
    app.put(PATH, external);
    // A click on a link on the map: the textarea blurs (a save starts) and the leaf navigates in the same tick.
    input.dispatchEvent(new FocusEvent('blur'));
    await view.setState({ file: OTHER, layout: 'mindmap' }, { history: false });
    await settle();
    expect(editor()).toBeNull();
    expect(source()).toBe(external);
    expect(view.file?.path).toBe(OTHER);
    expect(Notice.log).toHaveLength(1);
    expect(Notice.log[0]).toContain('編集中の内容を保存できませんでした');
  });

  it('keeps the active leaf and the focus on the node when Escape is pressed with no inline editor open', async () => {
    const { view, workspace, map, beside, markdown, select, key, settle, editor } = await mount();
    const node = select('学ぶこと');
    expect(document.activeElement).toBe(node);
    expect(editor()).toBeNull();
    const event = key(node, 'Escape');
    await settle();
    // The map does not claim the key (nothing to cancel); the workspace returns before choosing another leaf.
    expect(event.defaultPrevented).toBe(false);
    expect(workspace.activeLeaf).toBe(map);
    expect(document.activeElement).toBe(node);
    expect(markdown.content).not.toBe(document.activeElement);
    // G5 of artifacts/lev-48-f2-scope: the same key on a non-navigation map moved the leaf and the focus to the editor.
    view.navigation = false;
    key(node, 'Escape');
    await settle();
    expect(workspace.activeLeaf).toBe(beside);
    expect(document.activeElement).toBe(markdown.content);
  });

  it('closes the inline editor on Escape and returns the focus to the node; the workspace never sees that key', async () => {
    const { workspace, map, select, key, settle, editor, source } = await mount();
    const node = select('学ぶこと');
    key(node, 'F2');
    await settle();
    const input = editor();
    expect(input?.value).toBe('学ぶこと');
    const event = key(input as HTMLTextAreaElement, 'Escape');
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(editor()).toBeNull();
    expect(source()).toBe(SOURCE);
    expect(workspace.activeLeaf).toBe(map);
    expect(document.activeElement).toBe(node);
  });

  it('is where a link opens: getLeaf(false) is the map leaf itself while it is active, the tab beside once the map is pinned', async () => {
    const { workspace, map, beside } = await mount();
    expect(workspace.canNavigate(map)).toBe(true);
    expect(workspace.getUnpinnedLeaf()).toBe(map);
    // A pinned map keeps its note, as a pinned Markdown tab does: the most recently active tab that can navigate.
    map.pinned = true;
    expect(workspace.getUnpinnedLeaf()).toBe(beside);
    beside.pinned = true;
    expect(workspace.getUnpinnedLeaf()).toBe('new');
  });

  it('reports a history step to the leaf when the note changes, none for the layout or the viewport alone', async () => {
    const { view, settle } = await mount();
    const layout: ViewStateResult = { history: false };
    await view.setState({ file: PATH, layout: 'timeline' }, layout);
    await settle();
    expect(layout.history).toBe(false);
    const viewport: ViewStateResult = { history: false };
    await view.setState({ file: PATH, layout: 'timeline', viewport: { x: 10, y: 20, scale: 1.5 } }, viewport);
    await settle();
    expect(viewport.history).toBe(false);
    const other: ViewStateResult = { history: false };
    await view.setState({ file: OTHER, layout: 'mindmap' }, other);
    await settle();
    expect(other.history).toBe(true);
    expect(view.file?.path).toBe(OTHER);
    expect(view.containerEl.querySelector('.mappy-node[aria-label="別のノート"]')).not.toBeNull();
  });

  it('reports no history step for a state naming a file that is not a note while no note is shown', async () => {
    const { app, view, settle } = await mount();
    const gone: ViewStateResult = { history: false };
    await view.setState({ file: 'Fixtures/missing.md' }, gone);
    await settle();
    expect(gone.history).toBe(true);
    expect(view.file).toBeNull();
    // Still no note: an image is not one either, so nothing changed and nothing is recorded (the vault does hand
    // the file over; the step is judged on the note the map can show).
    app.put('Fixtures/picture.png', '');
    const picture: ViewStateResult = { history: false };
    await view.setState({ file: 'Fixtures/picture.png' }, picture);
    await settle();
    expect(picture.history).toBe(false);
    expect(view.file).toBeNull();
  });

  it('saves a draft being typed before another note replaces this one, as a Markdown tab keeps its buffer', async () => {
    const { view, select, key, settle, editor, source } = await mount();
    key(select('学ぶこと'), 'F2');
    await settle();
    const input = editor();
    if (!input) throw new Error('no editor');
    input.value = '学ぶこと（改）';
    // ⌘⌥← (app:go-back, enabled on a navigation view), a link, the explorer: the leaf's state moves to another note.
    await view.setState({ file: OTHER, layout: 'mindmap' }, { history: false });
    await settle();
    expect(editor()).toBeNull();
    expect(source()).toBe(SOURCE.replace('  - 学ぶこと\n', '  - 学ぶこと（改）\n'));
    expect(view.file?.path).toBe(OTHER);
    expect(Notice.log).toEqual([]);
  });

  it('tells when the draft could not be saved on the way out, and still shows the other note', async () => {
    const { app, view, select, key, settle, editor, source } = await mount();
    key(select('学ぶこと'), 'F2');
    await settle();
    const input = editor();
    if (!input) throw new Error('no editor');
    input.value = '学ぶこと（改）';
    // The node under the draft changed outside (E05): the save is refused, and no draft can stay in a leaf that moved on.
    const external = SOURCE.replace('  - 学ぶこと\n', '  - 学ぶこと（外部）\n');
    app.put(PATH, external);
    await settle();
    await view.setState({ file: OTHER, layout: 'mindmap' }, { history: false });
    await settle();
    expect(editor()).toBeNull();
    expect(source()).toBe(external);
    expect(view.file?.path).toBe(OTHER);
    expect(Notice.log).toHaveLength(1);
    expect(Notice.log[0]).toContain('編集中の内容を保存できませんでした');
  });

  it('follows a link\'s subpath handed as ephemeral state: the node holding the heading or block is selected and focused', async () => {
    const withBlock = SOURCE.replace('- はじめに\n', '- はじめに ^intro\n');
    const mounted = await mountMapView(PATH, withBlock);
    opened.push(mounted);
    const { view, settle, node, select } = mounted;
    select('記録する');
    view.setEphemeralState({ subpath: '#講座の構成' });
    await settle();
    expect(node('講座の構成').classList.contains('is-selected')).toBe(true);
    expect(document.activeElement).toBe(node('講座の構成'));
    view.setEphemeralState({ subpath: '#^intro' });
    await settle();
    const intro = Array.from(view.containerEl.querySelectorAll<HTMLElement>('.mappy-node')).find(el => el.getAttribute('aria-label')?.startsWith('はじめに'));
    expect(intro?.classList.contains('is-selected')).toBe(true);
    expect(document.activeElement).toBe(intro);
    // Nothing at that subpath: the selection is left alone.
    view.setEphemeralState({ subpath: '#ない見出し' });
    await settle();
    expect(intro?.classList.contains('is-selected')).toBe(true);
  });

  it('hands out the selection by place and text, with the focus, and takes it back: a back／forward step or a duplicated tab keeps both', async () => {
    const { view, settle, select } = await mount();
    select('記録する');
    const state = view.getEphemeralState();
    // Not the node id: ids are handed out per parse, and the view that opens next parses again.
    expect(state).toEqual({ selection: { from: SOURCE.indexOf('- 記録する'), title: '記録する' }, focus: true });
    (document.activeElement as HTMLElement | null)?.blur();
    expect(view.getEphemeralState()).toEqual({ selection: { from: SOURCE.indexOf('- 記録する'), title: '記録する' } });
    // Restored into a fresh view of the same note, whose ids differ: the node at that place with that text.
    const again = await mountMapView(PATH, SOURCE);
    opened.push(again);
    again.select('学ぶこと');
    again.view.setEphemeralState(state);
    await again.settle();
    expect(again.node('記録する').classList.contains('is-selected')).toBe(true);
    expect(again.node('学ぶこと').classList.contains('is-selected')).toBe(false);
    expect(document.activeElement).toBe(again.node('記録する'));
    // The text moved (an edit above it): found by its text. Unknown text at an unknown place: nothing changes.
    again.view.setEphemeralState({ selection: { from: 0, title: '学ぶこと' } });
    expect(again.node('学ぶこと').classList.contains('is-selected')).toBe(true);
    again.view.setEphemeralState({ selection: { from: 9999, title: 'ない' } });
    expect(again.node('学ぶこと').classList.contains('is-selected')).toBe(true);
    // Nothing selected: no selection is handed out (the focus still is, while it sits in the view).
    (view as unknown as { deselect(): void }).deselect();
    view.setEphemeralState({ focus: true });
    expect(view.getEphemeralState()).toEqual({ focus: true });
    await settle();
  });

  it('takes the focus onto the selected node, or the canvas, when the leaf is focused; not out of a draft', async () => {
    const { view, canvas, settle, select, node, key, editor } = await mount();
    const blur = (): void => { (document.activeElement as HTMLElement | null)?.blur(); expect(document.activeElement).toBe(document.body); };
    select('記録する');
    blur();
    // `setActiveLeaf(leaf, { focus: true })`: the map opened by a command, its tab pressed, a history step.
    view.setEphemeralState({ focus: true });
    expect(document.activeElement).toBe(node('記録する'));
    (view as unknown as { deselect(): void }).deselect();
    blur();
    view.setEphemeralState({ focus: true });
    expect(document.activeElement).toBe(canvas);
    key(select('学ぶこと'), 'F2');
    await settle();
    const input = editor();
    expect(document.activeElement).toBe(input);
    view.setEphemeralState({ focus: true });
    expect(document.activeElement).toBe(input);
  });

  it('is not a navigation view in a sidebar, and becomes one again when moved to the main area', async () => {
    const app = new HarnessApp();
    const sidebar = await mountMapView(PATH, SOURCE, 'mindmap', app, {
      prepare: view => { (view.leaf as unknown as WorkspaceLeaf).root = app.workspace.rightSplit; },
    });
    opened.push(sidebar);
    expect(sidebar.view.navigation).toBe(false);
    (sidebar.view.leaf as unknown as WorkspaceLeaf).root = null;
    app.workspaceEvents.trigger('layout-change');
    expect(sidebar.view.navigation).toBe(true);
    (sidebar.view.leaf as unknown as WorkspaceLeaf).root = app.workspace.leftSplit;
    app.workspaceEvents.trigger('layout-change');
    expect(sidebar.view.navigation).toBe(false);
  });
});
