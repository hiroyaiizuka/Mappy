// @vitest-environment jsdom
/**
 * Undo／Redo are writes of the map's own (LEV-150, the Undo／Redo half): the fold and the selection name nodes by
 * id, and the re-read after ⌘Z／⌘⇧Z has to carry every id over as the re-read after an edit does (LEV-146). The
 * matrix is what the user did before ⌘Z (an edit of another node, and that edit then a layout button — LEV-206
 * carries the history over the button) × the shape of the folded, selected node (one title, an untitled node, the
 * second of two same-titled nodes, a topic).
 *
 * Before the fix the store's Undo／Redo returned only the text, the re-read had no edits, and a node matched only by
 * its title — the untitled one and the second 同名 — came back with a new id: its branch opened and the selection
 * left it (`artifacts/lev-150-undo-redo-ids/tests-before-fix.log`). The 通常 and トピック rows hold there too; they
 * pin that the carried ids do not move a node matched by its title.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, TFile } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp, parseFrontmatter } from '../../harness/browser/app';
import { Notice } from '../../harness/browser/obsidian';
import { LAYOUT_LABELS } from '../../src/core/layout-mode';
import type { MindDocument } from '../../src/core/markdown';
import { mountMapView, type MountedMapView } from './map-view-mount';
import { accessibleName } from './accessible-name';

vi.mock('obsidian', () => import('../../harness/browser/obsidian'));
beforeAll(() => { installObsidianDom(); });

const opened: MountedMapView[] = [];
afterEach(async () => {
  for (const mounted of opened.splice(0)) await mounted.close();
  document.body.replaceChildren();
  Notice.log.length = 0;
});

const PATH = 'Fixtures/undo-ids.md';
const EMPTY_LABEL = '空のノード';
const SOURCE = [
  '---', 'mappy: true', '---',
  '## 履歴', '',
  '- 親', '  - 子1', '  - 子2',
  '- ', '  - 空の子',
  '- ', '  - 空の子2',
  '- 同名', '  - 同名の子A',
  '- 同名', '  - 同名の子B',
  '', '## トピック', '',
  '- 枝', '',
].join('\n');

/** Obsidian's `processFrontMatter` rewrites the header in the note's text (the harness's edits its cache only). */
function rewritingFrontmatter(app: HarnessApp): void {
  app.fileManager.processFrontMatter = async (file, change) => {
    await app.asApp<App>().vault.process(file as unknown as TFile, text => {
      const properties = parseFrontmatter(text) ?? {};
      change(properties);
      const body = text.replace(/^---\n[\s\S]*?\n---\n/u, '');
      return `---\n${Object.entries(properties).map(([key, value]) => `${key}: ${String(value)}`).join('\n')}\n---\n${body}`;
    });
  };
}

async function mount(): Promise<MountedMapView> {
  const app = new HarnessApp();
  rewritingFrontmatter(app);
  const mounted = await mountMapView(PATH, SOURCE, 'mindmap', app);
  opened.push(mounted);
  return mounted;
}

interface ViewState {
  document: MindDocument | undefined; collapsed: Set<string>; selectedId: string | null;
  refreshTimer: number | undefined; refreshing: Promise<void> | undefined; saving: boolean;
}
const state = (mounted: MountedMapView): ViewState => mounted.view as unknown as ViewState;

/** Every write and re-read done, with the map showing what the note holds. */
async function settled(mounted: MountedMapView, reached: (source: string) => boolean): Promise<void> {
  const view = state(mounted);
  await vi.waitFor(() => {
    expect({
      reached: reached(mounted.source()), timer: view.refreshTimer, read: view.refreshing, saving: view.saving,
      current: view.document?.source === mounted.source(),
    }).toEqual({ reached: true, timer: undefined, read: undefined, saving: false, current: true });
  }, { timeout: 2000, interval: 5 });
  await mounted.settle();
}

/** The `index`-th node on screen with this label (an untitled node reads as 空のノード). */
function nodeNamed(mounted: MountedMapView, label: string, index = 0): HTMLElement {
  const found = Array.from(mounted.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node')).filter(node => accessibleName(node) === label)[index];
  if (!found) throw new Error(`No node ${label} #${index}`);
  return found;
}

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/** ⌘Z, or ⌘⇧Z, on the canvas. */
async function history(mounted: MountedMapView, redo: boolean, reached: (source: string) => boolean): Promise<void> {
  mounted.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: redo, bubbles: true, cancelable: true }));
  await settled(mounted, reached);
}

/** 子1 renamed with F2: the step ⌘Z takes back. */
async function rename(mounted: MountedMapView): Promise<void> {
  click(nodeNamed(mounted, '子1'));
  mounted.key(mounted.canvas, 'F2');
  const editor = mounted.editor();
  if (!editor) throw new Error('F2 opened no editor');
  editor.value = '改名';
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  mounted.key(editor, 'Enter');
  await settled(mounted, source => source.includes('- 改名\n'));
}

const SHAPES = [
  { shape: '通常', label: '親', index: 0 },
  { shape: '空題名 (the second)', label: EMPTY_LABEL, index: 1 },
  { shape: '同名 (the second)', label: '同名', index: 1 },
  { shape: 'トピック', label: 'トピック', index: 0 },
] as const;

const BEFORE = [
  { name: 'an edit', layout: false },
  { name: 'an edit and then a layout button', layout: true },
] as const;

describe('the fold and the selection through Undo／Redo (LEV-150, the Undo／Redo half)', () => {
  it.each(BEFORE.flatMap(before => SHAPES.map(shape => ({ ...before, ...shape }))))(
    '$name, then ⌘Z and ⌘⇧Z: a folded, selected $shape node stays folded and selected', async ({ layout, label, index }) => {
      const mounted = await mount();
      await rename(mounted);
      if (layout) {
        const button = mounted.view.containerEl.querySelector<HTMLButtonElement>(`.mappy-modes button[aria-label="${LAYOUT_LABELS.timeline}"]`);
        if (!button) throw new Error('No layout button');
        button.click();
        await settled(mounted, source => source.includes('mappy-layout: timeline\n'));
      }
      const element = nodeNamed(mounted, label, index);
      click(element);
      const id = element.dataset.nodeId ?? '';
      const toggle = element.querySelector<HTMLElement>('.mappy-node-toggle');
      if (!toggle) throw new Error('No toggle');
      click(toggle);
      await mounted.settle();
      const view = state(mounted);
      expect({ collapsed: [...view.collapsed], selected: view.selectedId }).toEqual({ collapsed: [id], selected: id });

      await history(mounted, false, source => source.includes('- 子1\n'));
      expect({ collapsed: [...view.collapsed], selected: view.selectedId }).toEqual({ collapsed: [id], selected: id });
      expect(nodeNamed(mounted, label, index).dataset.nodeId).toBe(id);

      await history(mounted, true, source => source.includes('- 改名\n'));
      expect({ collapsed: [...view.collapsed], selected: view.selectedId }).toEqual({ collapsed: [id], selected: id });
      expect(nodeNamed(mounted, label, index).dataset.nodeId).toBe(id);
      if (layout) expect(mounted.source()).toContain('mappy-layout: timeline\n');
      expect(Notice.log).toEqual([]);
    });

  it('an external change after the edit still drops the history, and a same-titled node is not guessed (E05)', async () => {
    // Not a regression test of the bug: it pins what the fix must not do — take someone else's change for the map's own.
    const mounted = await mount();
    await rename(mounted);
    const id = nodeNamed(mounted, EMPTY_LABEL, 1).dataset.nodeId ?? '';
    await mounted.app.asApp<App>().vault.process(mounted.file, text => text.replace('- 子2\n', '- 外から\n'));
    await settled(mounted, source => source.includes('- 外から\n'));
    expect(nodeNamed(mounted, EMPTY_LABEL, 1).dataset.nodeId).not.toBe(id);
    const after = nodeNamed(mounted, EMPTY_LABEL, 1).dataset.nodeId;
    mounted.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }));
    await settled(mounted, () => true);
    expect(mounted.source()).toContain('- 改名\n');
    expect(nodeNamed(mounted, EMPTY_LABEL, 1).dataset.nodeId).toBe(after);
  });
});
