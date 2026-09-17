// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { TFile } from 'obsidian';
import { MindmapView } from '../../src/ui/mindmap-view';
import type { DocumentStore } from '../../src/obsidian/document-store';
import type { ViewRouter } from '../../src/obsidian/view-routing';

vi.mock('obsidian', () => {
  class TFile {
    path = '';
    get name(): string { return this.path.split('/').pop() ?? ''; }
    get basename(): string { return this.name.replace(/\.[^.]+$/u, ''); }
    get extension(): string { return this.name.includes('.') ? this.name.split('.').pop() ?? '' : ''; }
  }
  class ItemView {
    app: unknown;
    contentEl = document.createElement('div');
    constructor(public leaf: { app: unknown }) { this.app = leaf.app; }
    setState(): Promise<void> { return Promise.resolve(); }
  }
  return {
    ItemView,
    MarkdownView: class {},
    Menu: class {},
    Notice: class {},
    TFile,
    setIcon: vi.fn(),
  };
});

vi.mock('../../src/ui/node-renderer', () => ({ NodeRenderer: class {} }));
vi.mock('../../src/ui/map-viewport', () => ({ MapViewport: class {} }));
vi.mock('../../src/ui/map-events', () => ({ MapEvents: class {} }));
vi.mock('../../src/ui/edit-modal', () => ({ EditModal: class {} }));
vi.mock('../../src/ui/inline-editor', () => ({ InlineEditor: class {} }));
vi.mock('../../src/ui/link-suggest', () => ({ LinkSuggest: class {} }));

function fixture() {
  const properties: Record<string, unknown> = { mappy: true };
  const file = new TFile();
  file.path = 'Map.md';
  const processFrontMatter = vi.fn((_file, change: (value: Record<string, unknown>) => void) => {
    change(properties);
    return Promise.resolve();
  });
  const app = {
    vault: { getAbstractFileByPath: vi.fn(() => file) },
    metadataCache: { getFileCache: vi.fn(() => ({ frontmatter: properties })) },
    fileManager: { processFrontMatter },
    workspace: { requestSaveLayout: vi.fn() },
  };
  const view = new MindmapView(
    { app } as never,
    {} as DocumentStore,
    {} as ViewRouter,
  );
  view.file = file;
  return { app, file, processFrontMatter, properties, view };
}

describe('MindmapView layout preference', () => {
  it('persists an explicit timeline selection and restores it in a new map view', async () => {
    const { app, processFrontMatter, properties, view } = fixture();
    const draw = vi.spyOn(view as unknown as { draw: () => void }, 'draw').mockImplementation(() => undefined);

    (view as unknown as { selectMode(mode: 'timeline'): void }).selectMode('timeline');
    await vi.waitFor(() => { expect(processFrontMatter).toHaveBeenCalledTimes(1); });

    expect(properties).toEqual({ mappy: true, 'mappy-layout': 'timeline' });
    expect(draw).toHaveBeenCalledTimes(1);
    expect(app.workspace.requestSaveLayout).toHaveBeenCalledTimes(1);

    const restored = new MindmapView(
      { app } as never,
      {} as DocumentStore,
      {} as ViewRouter,
    );
    await restored.setState({ file: 'Map.md' }, {} as never);
    expect(restored.snapshot()?.mode).toBe('timeline');
  });

  it('removes the optional layout key when the user selects the regular map', async () => {
    const { processFrontMatter, properties, view } = fixture();
    properties['mappy-layout'] = 'timeline';
    await view.setState({ file: 'Map.md', layout: 'timeline' }, {} as never);
    vi.spyOn(view as unknown as { draw: () => void }, 'draw').mockImplementation(() => undefined);

    (view as unknown as { selectMode(mode: 'mindmap'): void }).selectMode('mindmap');
    await vi.waitFor(() => { expect(processFrontMatter).toHaveBeenCalledTimes(1); });

    expect(properties).toEqual({ mappy: true });
  });
});
