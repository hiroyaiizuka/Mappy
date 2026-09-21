// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ViewStateResult } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { EMBED_TARGETS, findFixture } from '../../harness/browser/fixtures';
import { LAYOUT_LABELS, LAYOUT_MODES, type LayoutMode } from '../../src/core/layout-mode';
import type { MindmapView } from '../../src/ui/mindmap-view';
import { mountMapView, type MountedMapView } from './map-view-mount';

// The browser-harness stand-in for `obsidian`, so the shipped view runs against a real DOM.
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });

const REGULAR = 'Fixtures/uneven-branches.md';
const TIMELINE = 'Fixtures/embed-timeline.md';
const ALL = LAYOUT_MODES.map(mode => LAYOUT_LABELS[mode]);

const regular = findFixture('uneven-branches');
const timeline = EMBED_TARGETS.find(target => target.path === TIMELINE);
if (!regular || !timeline) throw new Error('Missing uneven-branches or embed-timeline fixture');
const SOURCES: Record<string, string> = { [REGULAR]: regular.source, [TIMELINE]: timeline.source };

const mounted: MountedMapView[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.close();
  document.body.replaceChildren();
});

/** The shipped view on a note, with the settings applied before it opens as the plugin does; `layout` null lets the note decide. */
async function mount(path: string, layout: LayoutMode | null, visible?: readonly LayoutMode[], app = new HarnessApp()): Promise<MountedMapView> {
  const view = await mountMapView(path, SOURCES[path] ?? '', layout, app, visible ? { prepare: v => { v.setVisibleLayouts(visible); } } : {});
  await view.settle();
  mounted.push(view);
  return view;
}

/** The bottom-left bar's buttons in DOM order: which layout, whether it shows, whether it is the current one. */
function buttons(view: MindmapView) {
  return Array.from(view.containerEl.querySelectorAll<HTMLButtonElement>('.mappy-modes .mappy-button'))
    .map(button => ({ label: button.getAttribute('aria-label'), hidden: button.hidden, active: button.classList.contains('is-active') }));
}

function button(view: MindmapView, mode: LayoutMode): HTMLButtonElement {
  const found = Array.from(view.containerEl.querySelectorAll<HTMLButtonElement>('.mappy-modes .mappy-button'))
    .find(candidate => candidate.getAttribute('aria-label') === LAYOUT_LABELS[mode]);
  if (!found) throw new Error(`No button for ${mode}`);
  return found;
}

const hidden = (view: MindmapView) => buttons(view).map(entry => entry.hidden);

describe('MindmapView visible layouts (settings, M14)', () => {
  it('shows every button by default, in LAYOUT_MODES order, with no hidden attribute anywhere on the bar', async () => {
    const { view } = await mount(REGULAR, null);
    expect(buttons(view)).toEqual(ALL.map((label, index) => ({ label, hidden: false, active: index === 0 })));
    expect(view.containerEl.querySelectorAll('.mappy-modes [hidden]')).toHaveLength(0);
    // The bar itself is as it was before the setting existed: four buttons, nothing else.
    expect(view.containerEl.querySelector('.mappy-modes')?.children).toHaveLength(4);
  });

  it('hides the layouts the settings leave out, keeps the rest, and shows them all again when the list is restored', async () => {
    const { view } = await mount(REGULAR, null);
    view.setVisibleLayouts(['mindmap', 'hierarchy']);
    expect(hidden(view)).toEqual([false, true, false, true]);
    expect(buttons(view).map(entry => entry.label)).toEqual(ALL);
    view.setVisibleLayouts(['mindmap']);
    expect(hidden(view)).toEqual([false, true, true, true]);
    view.setVisibleLayouts([...LAYOUT_MODES]);
    expect(hidden(view)).toEqual([false, false, false, false]);
    expect(view.containerEl.querySelectorAll('.mappy-modes [hidden]')).toHaveLength(0);
  });

  it('applies a list set before the view opens, as the plugin does when it constructs the view', async () => {
    const { view } = await mount(REGULAR, null, ['mindmap', 'balanced']);
    expect(hidden(view)).toEqual([false, true, true, false]);
    expect(buttons(view)[0]?.active).toBe(true);
  });

  it('keeps the button of the layout on screen even when hidden: a timeline note shows タイムライン selected, and it goes once 通常マップ is chosen', async () => {
    const { app, view, settle } = await mount(TIMELINE, null, ['mindmap']);
    expect(view.snapshot()?.mode).toBe('timeline');
    expect(buttons(view)).toEqual([
      { label: '通常マップ', hidden: false, active: false },
      { label: 'タイムライン', hidden: false, active: true },
      { label: '階層図', hidden: true, active: false },
      { label: '左右バランス', hidden: true, active: false },
    ]);
    expect(button(view, 'timeline').getAttribute('aria-pressed')).toBe('true');
    button(view, 'mindmap').click();
    await settle();
    expect(view.snapshot()?.mode).toBe('mindmap');
    expect(hidden(view)).toEqual([false, true, true, true]);
    expect(buttons(view)[0]?.active).toBe(true);
    // The deliberate switch is saved as before (the note's next-open preference); hiding changed nothing about that.
    const file = app.vault.getAbstractFileByPath(TIMELINE);
    expect(file && app.metadataCache.getFileCache(file)?.frontmatter?.['mappy-layout']).toBeUndefined();
  });

  it('follows the current layout when it changes through the view state, so a restored workspace keeps its button', async () => {
    const { view } = await mount(REGULAR, 'balanced', ['mindmap']);
    expect(buttons(view).map(entry => [entry.hidden, entry.active])).toEqual([[false, false], [true, false], [true, false], [false, true]]);
    await view.setState({ file: REGULAR, layout: 'hierarchy' }, { history: false } satisfies ViewStateResult);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(buttons(view).map(entry => [entry.hidden, entry.active])).toEqual([[false, false], [true, false], [false, true], [true, false]]);
    // Changing the list while a hidden layout is on screen never removes that layout's button.
    view.setVisibleLayouts(['mindmap', 'timeline']);
    expect(buttons(view).map(entry => [entry.hidden, entry.active])).toEqual([[false, false], [false, false], [false, true], [true, false]]);
  });

  it('follows a layout change even when nothing can be drawn: no note loaded, or a button pressed before the note is read', async () => {
    const { app, view } = await mount(REGULAR, null, ['mindmap']);
    app.put(TIMELINE, SOURCES[TIMELINE] ?? '');
    // The bar is not tied to draw(): with the note gone (a state naming one that is not there; FileView keeps the note
    // for a state without `file`) the view has no document, yet the state's layout still shows its button.
    await view.setState({ file: 'Fixtures/gone.md', layout: 'timeline' }, { history: false } satisfies ViewStateResult);
    expect(view.file).toBeNull();
    expect(buttons(view).map(entry => [entry.hidden, entry.active])).toEqual([[false, false], [false, true], [true, false], [true, false]]);
    // A button press on that empty view moves the bar the same way, and writes nothing (there is no note).
    button(view, 'mindmap').click();
    expect(buttons(view).map(entry => [entry.hidden, entry.active])).toEqual([[false, true], [true, false], [true, false], [true, false]]);
    // Switching to the note again: the bar follows the frontmatter layout once the note is the view's (FileView's own
    // load, a few microtasks), before the read of the note completes — held here until the bar has been checked.
    let release = (): void => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const read = vi.spyOn(app.vault, 'read').mockImplementation(async file => { await held; return app.content(file); });
    const opening = view.setState({ file: TIMELINE }, { history: false } satisfies ViewStateResult);
    await vi.waitFor(() => { expect(read).toHaveBeenCalled(); });
    expect(buttons(view).map(entry => [entry.hidden, entry.active])).toEqual([[false, false], [false, true], [true, false], [true, false]]);
    release();
    await opening;
  });

  it('is presentation only: the note, its frontmatter and the view state are untouched, and other views are not affected', async () => {
    const app = new HarnessApp();
    const first = await mount(TIMELINE, null, undefined, app);
    const second = await mount(TIMELINE, null, undefined, app);
    const before = app.content(first.file);
    const state = first.view.getState();
    first.view.setVisibleLayouts(['mindmap']);
    first.view.setVisibleLayouts(['mindmap', 'hierarchy']);
    await first.settle();
    expect(app.content(first.file)).toBe(before);
    expect(app.activity.filter(entry => entry.kind === 'frontmatter' || entry.kind === 'layout-saved')).toEqual([]);
    expect(first.view.getState()).toEqual(state);
    expect(first.view.snapshot()?.mode).toBe('timeline');
    expect(hidden(first.view)).toEqual([false, false, false, true]);
    expect(hidden(second.view)).toEqual([false, false, false, false]);
  });
});
