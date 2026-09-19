// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, WorkspaceLeaf as ObsidianLeaf, ViewStateResult } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { WorkspaceLeaf } from '../../harness/browser/obsidian';
import { EMBED_TARGETS, findFixture } from '../../harness/browser/fixtures';
import { LAYOUT_LABELS, LAYOUT_MODES, type LayoutMode } from '../../src/core/layout-mode';
import { DocumentStore } from '../../src/obsidian/document-store';
import type { ViewRouter } from '../../src/obsidian/view-routing';
import { MindmapView } from '../../src/ui/mindmap-view';

// The browser-harness stand-in for `obsidian`, so the shipped view runs against a real DOM.
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });
afterEach(() => { document.body.replaceChildren(); });

const REGULAR = 'Fixtures/uneven-branches.md';
const TIMELINE = 'Fixtures/embed-timeline.md';

function mount(app = new HarnessApp()) {
  const regular = findFixture('uneven-branches');
  const timeline = EMBED_TARGETS.find(target => target.path === TIMELINE);
  if (!regular || !timeline) throw new Error('Missing uneven-branches or embed-timeline fixture');
  app.put(REGULAR, regular.source);
  app.put(TIMELINE, timeline.source);
  const leaf = new WorkspaceLeaf(app.asApp<App>());
  const store = new DocumentStore(app.asApp<App>());
  const view = new MindmapView(leaf as unknown as ObsidianLeaf, store, {} as ViewRouter);
  leaf.view = view as unknown as WorkspaceLeaf['view'];
  document.body.append(view.containerEl);
  const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => requestAnimationFrame(resolve));
  };
  return {
    app, view, settle,
    open: async (path: string, layout?: LayoutMode) => {
      view.load();
      await view.onOpen();
      await view.setState({ file: path, ...(layout ? { layout } : {}) }, { history: false } satisfies ViewStateResult);
      await settle();
    },
    /** The bottom-left bar's buttons in DOM order: which layout, whether it shows, whether it is the current one. */
    buttons: () => Array.from(view.containerEl.querySelectorAll<HTMLButtonElement>('.mappy-modes .mappy-button'))
      .map(button => ({ label: button.getAttribute('aria-label'), hidden: button.hidden, active: button.classList.contains('is-active') })),
    button: (mode: LayoutMode) => {
      const button = Array.from(view.containerEl.querySelectorAll<HTMLButtonElement>('.mappy-modes .mappy-button'))
        .find(candidate => candidate.getAttribute('aria-label') === LAYOUT_LABELS[mode]);
      if (!button) throw new Error(`No button for ${mode}`);
      return button;
    },
  };
}

const ALL = LAYOUT_MODES.map(mode => LAYOUT_LABELS[mode]);

describe('MindmapView visible layouts (settings, M14)', () => {
  it('shows every button by default, in LAYOUT_MODES order, with no hidden attribute anywhere on the bar', async () => {
    const { view, open, buttons } = mount();
    await open(REGULAR);
    expect(buttons()).toEqual(ALL.map((label, index) => ({ label, hidden: false, active: index === 0 })));
    expect(view.containerEl.querySelectorAll('.mappy-modes [hidden]')).toHaveLength(0);
    // The bar itself is as it was before the setting existed: four buttons, nothing else.
    expect(view.containerEl.querySelector('.mappy-modes')?.children).toHaveLength(4);
  });

  it('hides the layouts the settings leave out, keeps the rest, and shows them all again when the list is restored', async () => {
    const { view, open, buttons } = mount();
    await open(REGULAR);
    view.setVisibleLayouts(['mindmap', 'hierarchy']);
    expect(buttons().map(button => button.hidden)).toEqual([false, true, false, true]);
    expect(buttons().map(button => button.label)).toEqual(ALL);
    view.setVisibleLayouts(['mindmap']);
    expect(buttons().map(button => button.hidden)).toEqual([false, true, true, true]);
    view.setVisibleLayouts([...LAYOUT_MODES]);
    expect(buttons().map(button => button.hidden)).toEqual([false, false, false, false]);
    expect(view.containerEl.querySelectorAll('.mappy-modes [hidden]')).toHaveLength(0);
  });

  it('applies a list set before the view opens, as the plugin does when it constructs the view', async () => {
    const { view, open, buttons } = mount();
    view.setVisibleLayouts(['mindmap', 'balanced']);
    await open(REGULAR);
    expect(buttons().map(button => button.hidden)).toEqual([false, true, true, false]);
    expect(buttons()[0]?.active).toBe(true);
  });

  it('keeps the button of the layout on screen even when hidden: a timeline note shows タイムライン selected, and it goes once 通常マップ is chosen', async () => {
    const { app, view, open, buttons, button, settle } = mount();
    view.setVisibleLayouts(['mindmap']);
    await open(TIMELINE);
    expect(view.snapshot()?.mode).toBe('timeline');
    expect(buttons()).toEqual([
      { label: '通常マップ', hidden: false, active: false },
      { label: 'タイムライン', hidden: false, active: true },
      { label: '階層図', hidden: true, active: false },
      { label: '左右バランス', hidden: true, active: false },
    ]);
    expect(button('timeline').getAttribute('aria-pressed')).toBe('true');
    button('mindmap').click();
    await settle();
    expect(view.snapshot()?.mode).toBe('mindmap');
    expect(buttons().map(button => button.hidden)).toEqual([false, true, true, true]);
    expect(buttons()[0]?.active).toBe(true);
    // The deliberate switch is saved as before (the note's next-open preference); hiding changed nothing about that.
    const file = app.vault.getAbstractFileByPath(TIMELINE);
    expect(file && app.metadataCache.getFileCache(file)?.frontmatter?.['mappy-layout']).toBeUndefined();
  });

  it('follows the current layout when it changes through the view state, so a restored workspace keeps its button', async () => {
    const { view, open, buttons } = mount();
    view.setVisibleLayouts(['mindmap']);
    await open(REGULAR, 'balanced');
    expect(buttons().map(button => [button.hidden, button.active])).toEqual([[false, false], [true, false], [true, false], [false, true]]);
    await view.setState({ file: REGULAR, layout: 'hierarchy' }, { history: false } satisfies ViewStateResult);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(buttons().map(button => [button.hidden, button.active])).toEqual([[false, false], [true, false], [false, true], [true, false]]);
    // Changing the list while a hidden layout is on screen never removes that layout's button.
    view.setVisibleLayouts(['mindmap', 'timeline']);
    expect(buttons().map(button => [button.hidden, button.active])).toEqual([[false, false], [false, false], [false, true], [true, false]]);
  });

  it('is presentation only: the note, its frontmatter and the view state are untouched, and other views are not affected', async () => {
    const app = new HarnessApp();
    const first = mount(app);
    const second = mount(app);
    await first.open(TIMELINE);
    await second.open(TIMELINE);
    const file = app.vault.getAbstractFileByPath(TIMELINE);
    if (!file) throw new Error('Fixture missing');
    const before = app.content(file);
    const state = first.view.getState();
    first.view.setVisibleLayouts(['mindmap']);
    first.view.setVisibleLayouts(['mindmap', 'hierarchy']);
    await first.settle();
    expect(app.content(file)).toBe(before);
    expect(app.activity.filter(entry => entry.kind === 'frontmatter' || entry.kind === 'layout-saved')).toEqual([]);
    expect(first.view.getState()).toEqual(state);
    expect(first.view.snapshot()?.mode).toBe('timeline');
    expect(first.buttons().map(button => button.hidden)).toEqual([false, false, false, true]);
    expect(second.buttons().map(button => button.hidden)).toEqual([false, false, false, false]);
  });
});
