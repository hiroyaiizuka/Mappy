// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installObsidianDom } from '../../harness/browser/dom';
import { Notice } from '../../harness/browser/obsidian';
import { LAYOUT_MODES } from '../../src/core/layout-mode';
import { accessibleName } from './accessible-name';
import { mountMapView, type MountedMapView } from './map-view-mount';

// The browser-harness stand-in for `obsidian`, so the shipped view, renderer and store run against a real DOM.
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });
const opened: MountedMapView[] = [];
afterEach(async () => {
  for (const mounted of opened.splice(0)) await mounted.close();
  document.body.replaceChildren();
  Notice.log.length = 0;
});

const PATH = 'Fixtures/delete-selection.md';
// The report (LEV-204): the last of three children was deleted and the selection went to the parent.
const SOURCE = '---\nmappy: true\n---\n## 注意残余の対策\n- 作業途中で、ひと言メモを残す\n- aaaaaaaa\n- aaaa\n- 次の枝\n  - 一人っ子\n';

function selectedTitles(mounted: MountedMapView): string[] {
  return Array.from(mounted.view.containerEl.querySelectorAll<HTMLElement>('.mappy-node.is-selected'), accessibleName);
}

async function remove(mounted: MountedMapView, title: string, key: 'Delete' | 'Backspace'): Promise<void> {
  mounted.select(title);
  expect(selectedTitles(mounted)).toEqual([title]);
  mounted.key(mounted.canvas, key);
  await mounted.settle();
}

async function undo(mounted: MountedMapView): Promise<void> {
  mounted.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }));
  await mounted.settle();
}

describe('selection after Delete／Backspace in the view (LEV-204)', () => {
  // The rule is in the source order, so every layout (the balanced one splits siblings left and right) selects the same node.
  describe.each(LAYOUT_MODES)('%s', (layout) => {
    it.each(['Delete', 'Backspace'] as const)('%s selects the sibling above, else below, else the parent; Undo brings the node back', async (key) => {
      const mounted = await mountMapView(PATH, SOURCE, layout);
      opened.push(mounted);

      await remove(mounted, 'aaaa', key);
      expect(mounted.source()).not.toContain('- aaaa\n');
      expect(selectedTitles(mounted)).toEqual(['aaaaaaaa']);

      // Undo brings the node back; the selection stays where the delete put it, as it stayed on the parent before.
      await undo(mounted);
      expect(mounted.source()).toBe(SOURCE);
      expect(selectedTitles(mounted)).toEqual(['aaaaaaaa']);

      await remove(mounted, '作業途中で、ひと言メモを残す', key);
      expect(selectedTitles(mounted)).toEqual(['aaaaaaaa']);
      await undo(mounted);

      await remove(mounted, '一人っ子', key);
      expect(selectedTitles(mounted)).toEqual(['次の枝']);
      await undo(mounted);
      expect(mounted.source()).toBe(SOURCE);
      expect(Notice.log).toEqual([]);
    });
  });

});
