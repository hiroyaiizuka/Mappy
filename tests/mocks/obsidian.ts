import type { Editor, TFile as ObsidianFile, ViewState } from 'obsidian';

/** Only the public runtime members used by DocumentStore are needed in Node. */
export { TFile, TFolder, normalizePath } from './obsidian-file';

/** Records the states a leaf received, so routing tests can inspect the real call. */
export class WorkspaceLeaf {
  view: unknown = null;
  states: ViewState[] = [];
  eStates: unknown[] = [];
  setViewState(state: ViewState, eState?: unknown): Promise<void> {
    this.states.push(state);
    this.eStates.push(eState);
    return Promise.resolve();
  }
}

export class Notice {
  static messages: string[] = [];
  constructor(message: string) { Notice.messages.push(message); }
}

export class MarkdownView {
  constructor(
    public file: ObsidianFile | null,
    public editor: Pick<Editor, 'getValue' | 'offsetToPos' | 'transaction'>,
  ) {}
}

/** Lifecycle and DOM subscriptions follow the public Component contract. */
export class Component {
  private loaded = false;
  private cleanups: (() => void)[] = [];

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.onload();
  }

  unload(): void {
    if (!this.loaded) return;
    this.loaded = false;
    for (const cleanup of this.cleanups.reverse()) cleanup();
    this.cleanups = [];
    this.onunload();
  }

  onload(): void { /* Subclass lifecycle hook. */ }
  onunload(): void { /* Subclass lifecycle hook. */ }

  registerDomEvent<K extends keyof HTMLElementEventMap>(
    element: HTMLElement,
    type: K,
    callback: (event: HTMLElementEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    element.addEventListener(type, callback, options);
    this.cleanups.push(() => { element.removeEventListener(type, callback, options); });
  }
}
