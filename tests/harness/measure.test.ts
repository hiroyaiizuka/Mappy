// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, WorkspaceLeaf as ObsidianLeaf } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { WorkspaceLeaf } from '../../harness/browser/obsidian';
import { findFixture } from '../../harness/browser/fixtures';
import {
  EDIT_MARK, editTarget, installProbes, measureFrames, measureInlineEdit, measureLoad, measureMarkdownEdit, toggledTitle,
  type MeasureContext, type Probes,
} from '../../harness/browser/measure';
import { parseMarkdown } from '../../src/core/markdown';
import { DocumentStore } from '../../src/obsidian/document-store';
import type { ViewRouter } from '../../src/obsidian/view-routing';
import { MindmapView } from '../../src/ui/mindmap-view';

// The browser-harness stand-in for `obsidian`, so the shipped view runs against jsdom like it runs on the page.
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

let probes: Probes;
beforeAll(() => { installObsidianDom(); probes = installProbes(window); });
afterEach(() => { document.body.replaceChildren(); });

function fixture(id: string): { id: string; path: string; source: string } {
  const found = findFixture(id);
  if (!found) throw new Error(`Missing fixture ${id}`);
  return found;
}

interface Mounted { app: HarnessApp; view: MindmapView; pane: HTMLElement; context: MeasureContext }

async function mount(id: string): Promise<Mounted> {
  const app = new HarnessApp();
  const { path, source } = fixture(id);
  app.put(path, source);
  const pane = document.body.createDiv();
  const leaf = new WorkspaceLeaf(app.asApp<App>());
  const view = new MindmapView(leaf as unknown as ObsidianLeaf, new DocumentStore(app.asApp<App>()), {} as ViewRouter);
  leaf.view = view as unknown as WorkspaceLeaf['view'];
  pane.append(view.containerEl);
  view.load();
  await view.onOpen();
  const settle = async (): Promise<void> => { for (let index = 0; index < 3; index += 1) await probes.nextFrame(); };
  return { app, view, pane, context: { probes, pane, vault: app.vault, settle } };
}

const finite = (value: number): boolean => Number.isFinite(value) && value >= 0;
const label = (pane: HTMLElement, id: string): string =>
  Array.from(pane.querySelectorAll<HTMLElement>('.mappy-node')).find(node => node.dataset.nodeId === id)
    ?.querySelector('.mappy-node-label')?.textContent?.trim() ?? '';

describe('performance probes', () => {
  it('records product frames and timers with start and end, but not the page\'s own waits', async () => {
    const frames = probes.frames.length;
    const timers = probes.timers.length;
    await probes.nextFrame();
    expect(probes.frames).toHaveLength(frames);
    const ran = new Promise<void>(resolve => { window.requestAnimationFrame(() => { resolve(); }); });
    await ran;
    expect(probes.frames).toHaveLength(frames + 1);
    const frame = probes.frames[frames]!;
    expect(frame.startedAt).toBeGreaterThanOrEqual(frame.requestedAt);
    expect(frame.endedAt).toBeGreaterThanOrEqual(frame.startedAt);
    expect(Number.isFinite(frame.frameTime)).toBe(true);
    const fired = new Promise<void>(resolve => { window.setTimeout(() => { resolve(); }, 5); });
    expect(probes.timers).toHaveLength(timers + 1);
    expect(probes.timers[timers]?.delay).toBe(5);
    expect(probes.timers[timers]?.startedAt).toBeNaN();
    await fired;
    expect(finite(probes.timers[timers]?.startedAt ?? NaN)).toBe(true);
    const id = window.setTimeout(() => { throw new Error('cancelled timer ran'); }, 5);
    window.clearTimeout(id);
    await new Promise(resolve => { window.setTimeout(resolve, 10); });
  });

  it('picks the first child with children as the edit target and toggles a mark on its title', () => {
    const headings = parseMarkdown(fixture('performance-100').source, 'performance-100');
    expect(editTarget(headings).title).toBe('第1節');
    const wide = parseMarkdown(fixture('performance-100-wide').source, 'performance-100-wide');
    expect(editTarget(wide).title).toBe('兄弟 1');
    const deep = parseMarkdown(fixture('performance-10-deep').source, 'performance-10-deep');
    expect(editTarget(deep).title).toBe('段 1');
    expect(() => editTarget(parseMarkdown('', 'empty'))).toThrow(/no editable node/u);
    expect(toggledTitle('第1節')).toBe(`第1節${EDIT_MARK}`);
    expect(toggledTitle(`第1節${EDIT_MARK}`)).toBe('第1節');
  });

  it('times a load through setState and the view\'s own layout frame', async () => {
    const { view, pane, context } = await mount('performance-100');
    const sample = await measureLoad(context, view, fixture('performance-100'));
    expect(sample.kind).toBe('load');
    expect(sample.nodes).toBe(100);
    expect(pane.querySelectorAll('.mappy-node')).toHaveLength(100);
    for (const key of ['parseMs', 'stateMs', 'measureMs', 'layoutMs', 'frameMs', 'paintMs', 'firstLayoutMs', 'settledMs'] as const) {
      expect(finite(sample[key]), key).toBe(true);
    }
    expect(sample.firstLayoutMs).toBeGreaterThanOrEqual(sample.stateMs);
    expect(sample.settledMs).toBeGreaterThanOrEqual(sample.firstLayoutMs);
    expect(sample.frames).toBeGreaterThanOrEqual(1);
  });

  it('times a Markdown-side change from modify through the debounce to the layout frame', async () => {
    const { app, view, pane, context } = await mount('performance-100');
    await measureLoad(context, view, fixture('performance-100'));
    const file = app.vault.getAbstractFileByPath('Fixtures/performance-100.md');
    const target = editTarget(view.snapshot()!.document!);
    const sample = await measureMarkdownEdit(context, view, fixture('performance-100'), file);
    expect(sample.kind).toBe('markdown-edit');
    expect(sample.target).toBe('第1節');
    expect(sample.debounceMs).toBeGreaterThanOrEqual(40);
    expect(sample.totalMs).toBeGreaterThan(sample.debounceMs);
    for (const key of ['parseMs', 'refreshMs', 'waitMs', 'frameMs', 'paintMs', 'settledMs'] as const) {
      expect(finite(sample[key]), key).toBe(true);
    }
    expect(label(pane, target.id)).toBe(`第1節${EDIT_MARK}`);
    expect(app.content(file!)).toContain(`## 第1節${EDIT_MARK}`);
    const again = await measureMarkdownEdit(context, view, fixture('performance-100'), file);
    expect(again.target).toBe(`第1節${EDIT_MARK}`);
    expect(label(pane, target.id)).toBe('第1節');
  });

  it('drives the inline editor through the DOM: keystrokes lay out, Enter renames and closes it', async () => {
    const { app, view, pane, context } = await mount('performance-100');
    await measureLoad(context, view, fixture('performance-100'));
    const target = editTarget(view.snapshot()!.document!);
    const samples = await measureInlineEdit(context, view, fixture('performance-100'), 3);
    expect(samples.map(sample => sample.kind)).toEqual(['inline-key', 'inline-key', 'inline-key', 'inline-commit']);
    for (const sample of samples) {
      for (const key of ['refreshMs', 'waitMs', 'frameMs', 'paintMs', 'totalMs'] as const) expect(finite(sample[key]), key).toBe(true);
    }
    expect(pane.querySelector('textarea.mappy-inline-input')).toBeNull();
    expect(label(pane, target.id)).toBe(`第1節${EDIT_MARK}`);
    const file = app.vault.getAbstractFileByPath('Fixtures/performance-100.md');
    expect(app.content(file!)).toContain(`## 第1節${EDIT_MARK}`);
  });

  it('collects one frame interval per wheel event for pan and zoom', async () => {
    const { view, context } = await mount('performance-10');
    await measureLoad(context, view, fixture('performance-10'));
    const before = view.getState().viewport as { x: number; y: number; scale: number };
    const pan = await measureFrames(context, view, fixture('performance-10'), 'pan', 4);
    expect(pan.kind).toBe('pan');
    expect(pan.intervals).toHaveLength(4);
    expect(pan.intervals.every(finite)).toBe(true);
    const afterPan = view.getState().viewport as { x: number; y: number; scale: number };
    expect(afterPan.scale).toBe(before.scale);
    const zoom = await measureFrames(context, view, fixture('performance-10'), 'zoom', 4);
    expect(zoom.intervals).toHaveLength(4);
    expect(zoom.nodes).toBe(10);
  });
});
