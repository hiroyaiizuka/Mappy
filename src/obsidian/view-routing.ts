import { WorkspaceLeaf, type TFile, type ViewState } from 'obsidian';
import type { MapLayout } from './frontmatter';
import { patchMethod } from './patch';

export interface ViewRouterOptions {
  /** View type that replaces "markdown" for map notes. */
  mapViewType: string;
  /** Whether the note at this vault path should open as a map by default. */
  isMapFile(path: string): boolean;
}

/**
 * Route notes marked in frontmatter to the map view, the way Excalidraw and
 * Kanban claim their Markdown files: every `setViewState({ type: "markdown" })`
 * is inspected, including leaves embedded in other plugins' canvases.
 * A leaf that switched to Markdown on purpose keeps Markdown for that file.
 */
export class ViewRouter {
  private readonly markdownLeaves = new WeakMap<WorkspaceLeaf, string>();
  private readonly explicitMapLeaves = new WeakMap<WorkspaceLeaf, string>();
  private uninstall: (() => void) | null = null;

  constructor(private readonly options: ViewRouterOptions) {}

  install(): () => void {
    const route = (leaf: WorkspaceLeaf, state: ViewState): ViewState => this.route(leaf, state);
    this.uninstall ??= patchMethod(WorkspaceLeaf.prototype, 'setViewState', original => function (
      this: WorkspaceLeaf, state: ViewState, eState?: unknown,
    ): Promise<void> {
      return original.call(this, route(this, state), eState);
    });
    return () => {
      this.uninstall?.();
      this.uninstall = null;
    };
  }

  /** Decide the view state a leaf should really receive. */
  route(leaf: WorkspaceLeaf, state: ViewState): ViewState {
    const path = typeof state.state?.file === 'string' ? state.state.file : null;
    if (state.type === this.options.mapViewType && path) {
      const explicit = this.explicitMapLeaves.get(leaf) === path;
      this.explicitMapLeaves.delete(leaf);
      if (!explicit && !this.options.isMapFile(path)) {
        this.markdownLeaves.set(leaf, path);
        return { ...state, type: 'markdown' };
      }
      this.markdownLeaves.delete(leaf);
      return state;
    }
    if (state.type !== 'markdown' || !path) {
      if (state.type !== 'markdown') this.markdownLeaves.delete(leaf);
      return state;
    }
    if (this.markdownLeaves.get(leaf) === path) return state;
    this.markdownLeaves.delete(leaf);
    return this.options.isMapFile(path) ? { ...state, type: this.options.mapViewType } : state;
  }

  /** Show the note's Markdown in this leaf even if it is a map note. */
  openMarkdown(leaf: WorkspaceLeaf, file: TFile, active = true): Promise<void> {
    this.markdownLeaves.set(leaf, file.path);
    return leaf.setViewState({ type: 'markdown', state: { file: file.path }, active });
  }

  openMap(leaf: WorkspaceLeaf, file: TFile, active = true, layout?: MapLayout): Promise<void> {
    this.markdownLeaves.delete(leaf);
    this.explicitMapLeaves.set(leaf, file.path);
    const opened = leaf.setViewState({
      type: this.options.mapViewType,
      state: { file: file.path, ...(layout ? { layout } : {}) },
      active,
    });
    return opened.finally(() => {
      if (this.explicitMapLeaves.get(leaf) === file.path) this.explicitMapLeaves.delete(leaf);
    });
  }
}
