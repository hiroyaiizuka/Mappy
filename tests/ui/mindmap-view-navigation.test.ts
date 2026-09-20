// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, ViewStateResult } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { MarkdownView, WorkspaceLeaf, type View } from '../../harness/browser/obsidian';
import { mountMapView, type MountedMapView } from './map-view-mount';

// The browser-harness stand-in for `obsidian`, so the shipped view runs against a real DOM.
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });
const opened: MountedMapView[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const mounted of opened.splice(0)) await mounted.close();
  document.body.replaceChildren();
});

const PATH = 'Fixtures/navigation.md';
const OTHER = 'Fixtures/navigation-other.md';
const SOURCE = ['---', 'mappy: true', '---', '## 講座の構成', '', '- はじめに', '  - 学ぶこと', '- 記録する', ''].join('\n');

/** A leaf as the workspace model below sees it: its view, when it was last active, and whether it is pinned. */
interface Leaf { view: View; activeTime: number; pinned: boolean }

/**
 * Obsidian 1.14.2's resolution of "the current file" and of a bare Escape, copied from app.js (the original text is in
 * artifacts/lev-48-f2-scope/inspect-workspace-scope*.result.json and inspect-modifiers-navigation.result.json): only
 * `view.navigation` decides. jsdom has no workspace, so the model holds the leaves of one window and the routines
 * that read the flag; the real keys and leaves are checked on the test vault (artifacts/lev-74-view-navigation).
 */
class WorkspaceModel {
  activeLeaf: Leaf | null = null;
  constructor(readonly leaves: Leaf[]) {}

  setActiveLeaf(leaf: Leaf | null, focus = false): void {
    this.activeLeaf = leaf;
    if (!leaf) return;
    leaf.activeTime = Date.now();
    // `focusLeaf`: the container takes the focus, then `setEphemeralState({ focus: true })` — the Markdown editor's.
    if (focus) (leaf.view as View & { focus?: () => void }).focus?.();
  }

  /** `Workspace.getActiveFileView`: the active leaf when it navigates, else the most recently active navigation leaf. */
  getActiveFileView(): View | null {
    const active = this.activeLeaf;
    if (active?.view.navigation) return active.view instanceof MarkdownView ? active.view : null;
    let recent: Leaf | null = null;
    let found: View | null = null;
    for (const leaf of this.leaves) {
      if (leaf.view.navigation && (!recent || recent.activeTime < leaf.activeTime)) {
        recent = leaf;
        found = leaf.view instanceof MarkdownView ? leaf.view : null;
      }
    }
    return found;
  }

  /** `Workspace.getActiveFile` with no active editor (the map is active in every case here). */
  getActiveFile(): { path: string } | null {
    return (this.getActiveFileView() as MarkdownView | null)?.file ?? null;
  }

  /** `workspace:edit-file-title`'s checkCallback: rename the active file view's file, or decline. */
  editFileTitleAvailable(): boolean {
    const view = this.getActiveFileView();
    return view instanceof MarkdownView;
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

/** The Markdown tab beside the map: a navigation view (a FileView) whose editor takes the focus when the leaf does. */
class MarkdownBeside extends MarkdownView {
  readonly content: HTMLElement;
  constructor(leaf: WorkspaceLeaf, path: string) {
    super(leaf);
    this.navigation = true;
    this.file = leaf.app.vault.getAbstractFileByPath(path) as MarkdownView['file'];
    this.content = this.contentEl.createDiv({ cls: 'cm-content', attr: { contenteditable: 'true', tabindex: '0' } });
  }
  focus(): void { this.content.focus(); }
}

async function mount() {
  const mounted = await mountMapView(PATH, SOURCE);
  opened.push(mounted);
  mounted.app.put(OTHER, SOURCE.replace('講座の構成', '別のノート'));
  const markdown = new MarkdownBeside(new WorkspaceLeaf(mounted.app.asApp<App>()), OTHER);
  document.body.append(markdown.containerEl);
  const map: Leaf = { view: mounted.view as unknown as View, activeTime: 2, pinned: false };
  const beside: Leaf = { view: markdown, activeTime: 1, pinned: false };
  const workspace = new WorkspaceModel([map, beside]);
  workspace.setActiveLeaf(map);
  // Obsidian registers its Escape handler on the window at the bubble phase, after the map's own listeners.
  const onKey = (event: KeyboardEvent): void => { workspace.onEscape(event); };
  window.addEventListener('keydown', onKey);
  cleanups.push(() => { window.removeEventListener('keydown', onKey); });
  return { ...mounted, workspace, map, beside, markdown };
}

describe('MindmapView as a navigation view (LEV-74: Escape and the current file beside a Markdown tab)', () => {
  it('opens a note, so it navigates: the workspace resolves the current file to the map (none: not a FileView), not to the tab beside', async () => {
    const { view, workspace, map, markdown } = await mount();
    expect(view.navigation).toBe(true);
    expect(workspace.activeLeaf).toBe(map);
    // The core file commands (`workspace:edit-file-title`, copy path, delete, move, open with default app...) ask
    // `getActiveFileView()` / `getActiveFile()`: on the map they now find nothing and decline.
    expect(workspace.getActiveFileView()).toBeNull();
    expect(workspace.getActiveFile()).toBeNull();
    expect(workspace.editFileTitleAvailable()).toBe(false);
    // The shape before LEV-74, for the record: a non-navigation map handed them the Markdown tab beside.
    view.navigation = false;
    expect(workspace.getActiveFileView()).toBe(markdown);
    expect(workspace.getActiveFile()?.path).toBe(OTHER);
    expect(workspace.editFileTitleAvailable()).toBe(true);
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
});
