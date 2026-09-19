// Boots the shipped MindmapView against the browser-harness stand-ins (jsdom), the way the view tests do.
// A test file mocks `obsidian` with `harness/browser/obsidian` and installs the DOM helpers itself; this
// module only holds the steps they share. mindmap-view-external / -topics keep their own richer variants.
import type { App, WorkspaceLeaf as ObsidianLeaf, TFile, ViewStateResult } from 'obsidian';
import { HarnessApp } from '../../harness/browser/app';
import { WorkspaceLeaf } from '../../harness/browser/obsidian';
import type { LayoutMode } from '../../src/layout/layout';
import { DocumentStore } from '../../src/obsidian/document-store';
import type { ViewRouter } from '../../src/obsidian/view-routing';
import { MindmapView } from '../../src/ui/mindmap-view';

export interface MountedMapView {
  app: HarnessApp;
  view: MindmapView;
  file: TFile;
  canvas: HTMLElement;
  /** The note as the in-memory vault holds it now. */
  source: () => string;
  /** Let queued saves, refreshes and one layout frame run. */
  settle: () => Promise<void>;
  /** The visible node element with this label. */
  node: (title: string) => HTMLElement;
  /** Click a node the way a pointer would: the map selects and focuses it. */
  select: (title: string) => HTMLElement;
  /** Dispatch a keydown at a target and return it, so `defaultPrevented` can be read. */
  key: (target: EventTarget, value: string, init?: KeyboardEventInit) => KeyboardEvent;
  /** The inline title editor, if one is open. */
  editor: () => HTMLTextAreaElement | null;
  /** Close the view and release its listeners; the container is left for the test to drop. */
  close: () => Promise<void>;
}

export async function mountMapView(path: string, source: string, layout: LayoutMode = 'mindmap', app = new HarnessApp()): Promise<MountedMapView> {
  app.put(path, source);
  const leaf = new WorkspaceLeaf(app.asApp<App>());
  const store = new DocumentStore(app.asApp<App>());
  const view = new MindmapView(leaf as unknown as ObsidianLeaf, store, {} as ViewRouter);
  leaf.view = view as unknown as WorkspaceLeaf['view'];
  document.body.append(view.containerEl);
  view.load();
  await view.onOpen();
  await view.setState({ file: path, layout }, { history: false } satisfies ViewStateResult);
  await new Promise(resolve => requestAnimationFrame(resolve));
  const canvas = view.containerEl.querySelector<HTMLElement>('.mappy-canvas');
  if (!canvas) throw new Error('The view has no canvas');
  const file = app.asApp<App>().vault.getAbstractFileByPath(path) as TFile | null;
  if (!file) throw new Error('The note is missing from the harness vault');
  const node = (title: string): HTMLElement => {
    const found = Array.from(view.containerEl.querySelectorAll<HTMLElement>('.mappy-node')).find(el => el.getAttribute('aria-label') === title);
    if (!found) throw new Error(`No element for ${title}`);
    return found;
  };
  return {
    app, view, file, canvas, node,
    source: () => app.content(file),
    settle: async () => {
      for (let round = 0; round < 3; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => requestAnimationFrame(resolve));
    },
    select: title => {
      const element = node(title);
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return element;
    },
    key: (target, value, init = {}) => {
      const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    },
    editor: () => view.containerEl.querySelector<HTMLTextAreaElement>('textarea.mappy-inline-input'),
    close: async () => { await view.onClose(); view.unload(); },
  };
}
