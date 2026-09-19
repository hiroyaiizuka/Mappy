// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, WorkspaceLeaf as ObsidianLeaf, ViewStateResult } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { WorkspaceLeaf } from '../../harness/browser/obsidian';
import { findFixture } from '../../harness/browser/fixtures';
import { DocumentStore } from '../../src/obsidian/document-store';
import type { ViewRouter } from '../../src/obsidian/view-routing';
import { MindmapView } from '../../src/ui/mindmap-view';

// The browser-harness stand-in for `obsidian`, so the shipped view runs against a real DOM.
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });
afterEach(() => { document.body.replaceChildren(); });

const PATH = 'Fixtures/uneven-branches.md';

function themeClasses(element: Element): string[] {
  return Array.from(element.classList).filter(name => name.startsWith('theme-')).sort();
}

function mount(app = new HarnessApp()) {
  const fixture = findFixture('uneven-branches');
  if (!fixture) throw new Error('Missing uneven-branches fixture');
  app.put(PATH, fixture.source);
  const leaf = new WorkspaceLeaf(app.asApp<App>());
  const store = new DocumentStore(app.asApp<App>());
  const view = new MindmapView(leaf as unknown as ObsidianLeaf, store, {} as ViewRouter);
  leaf.view = view as unknown as WorkspaceLeaf['view'];
  document.body.append(view.containerEl);
  return { app, view, open: async () => {
    view.load();
    await view.onOpen();
    await view.setState({ file: PATH }, { history: false } satisfies ViewStateResult);
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => requestAnimationFrame(resolve));
  } };
}

describe('MindmapView theme (settings, M14)', () => {
  it('starts without a theme class, so the container follows Obsidian, and keeps that after opening', async () => {
    const { view, open } = mount();
    expect(themeClasses(view.contentEl)).toEqual([]);
    await open();
    expect(view.contentEl.classList.contains('mappy-view')).toBe(true);
    expect(themeClasses(view.contentEl)).toEqual([]);
  });

  it('applies a theme set before the view opens, as the plugin does when it constructs the view', async () => {
    const { view, open } = mount();
    view.setTheme('dark');
    expect(themeClasses(view.contentEl)).toEqual(['theme-dark']);
    await open();
    expect(view.contentEl.classList.contains('mappy-view')).toBe(true);
    expect(themeClasses(view.contentEl)).toEqual(['theme-dark']);
    expect(view.containerEl.querySelectorAll('.mappy-node').length).toBeGreaterThan(0);
  });

  it('switches between light and dark on the open view and returns to following Obsidian', async () => {
    const { view, open } = mount();
    await open();
    view.setTheme('light');
    expect(themeClasses(view.contentEl)).toEqual(['theme-light']);
    view.setTheme('dark');
    expect(themeClasses(view.contentEl)).toEqual(['theme-dark']);
    view.setTheme('follow');
    expect(themeClasses(view.contentEl)).toEqual([]);
    expect(view.contentEl.classList.contains('mappy-view')).toBe(true);
  });

  it('puts the class on the map container only: not on the body, the leaf or the canvas, and not on another view', async () => {
    const app = new HarnessApp();
    const first = mount(app);
    const second = mount(app);
    await first.open();
    await second.open();
    first.view.setTheme('dark');
    expect(themeClasses(document.body)).toEqual([]);
    expect(themeClasses(first.view.containerEl)).toEqual([]);
    expect(themeClasses(first.view.contentEl)).toEqual(['theme-dark']);
    const canvas = first.view.containerEl.querySelector('.mappy-canvas');
    expect(canvas && themeClasses(canvas)).toEqual([]);
    expect(themeClasses(second.view.contentEl)).toEqual([]);
  });

  it('changes nothing in the note: no frontmatter write, no layout save, same source', async () => {
    const { app, view, open } = mount();
    await open();
    const file = app.vault.getAbstractFileByPath(PATH);
    if (!file) throw new Error('Fixture missing');
    const before = app.content(file);
    for (const theme of ['dark', 'light', 'follow'] as const) view.setTheme(theme);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(app.content(file)).toBe(before);
    expect(app.activity.filter(entry => entry.kind === 'frontmatter' || entry.kind === 'layout-saved')).toEqual([]);
    expect(view.snapshot()?.mode).toBe('mindmap');
  });
});
