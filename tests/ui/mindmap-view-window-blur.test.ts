// @vitest-environment jsdom
/**
 * LEV-216: a draft open while its window loses the OS focus (another app, another Obsidian window). The textarea gets
 * a blur while it stays the document's active element and the document has no focus. Builds through 0.3.7 saved the
 * draft on that blur and closed it, so the Enter the person pressed on coming back to confirm it reached the selected
 * node and added a sibling 「サブトピック」 (seen in E50's step 6; E56 is the real-window case).
 *
 * Keeping the draft open must not lose it when the view closes before the person comes back: a draft taken out of a
 * focused document blurs and saves (LEV-215 decides whether closing should save at all), but in a window without the
 * focus Chromium sends no blur, so the view saves it on the way out as the switch did up to 0.3.7 (review 1: a popout
 * closed in the background dropped the draft, measured on 1.14.2).
 */
import { afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { installObsidianDom } from '../../harness/browser/dom';
import { NEW_NODE_TITLE } from '../../src/ui/mindmap-view';
import { mountMapView, type MountedMapView } from './map-view-mount';

vi.mock('obsidian', () => import('../../harness/browser/obsidian'));
beforeAll(() => { installObsidianDom(); });

const opened: MountedMapView[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const mounted of opened.splice(0)) await mounted.close();
  document.body.replaceChildren();
});

const PATH = 'Fixtures/window-blur.md';
const SOURCE = ['---', 'mappy: true', '---', '## 確認', '', '- 通常のノード', '  - 子ノード', '- 別のノード', ''].join('\n');
const RENAMED = SOURCE.replace('- 通常のノード\n', '- 戻って確定\n');

/** F2 on 「通常のノード」 and a new title typed, then the window loses the OS focus (the draft stays active). */
async function draftInBackgroundWindow(): Promise<{ mounted: MountedMapView; input: HTMLTextAreaElement; windowFocus: MockInstance<() => boolean> }> {
  const mounted = await mountMapView(PATH, SOURCE);
  opened.push(mounted);
  mounted.key(mounted.select('通常のノード'), 'F2');
  await mounted.settle();
  const input = mounted.editor();
  if (!input) throw new Error('F2 did not open the draft');
  input.value = '戻って確定';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const windowFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  input.dispatchEvent(new FocusEvent('blur'));
  await mounted.settle();
  return { mounted, input, windowFocus };
}

describe('a draft whose window loses the OS focus (LEV-216)', () => {
  it('stays open, and the Enter on coming back saves the rename and adds no sibling', async () => {
    const { mounted, input, windowFocus } = await draftInBackgroundWindow();
    expect(mounted.source()).toBe(SOURCE);
    expect(mounted.editor()).toBe(input);
    expect(document.activeElement).toBe(input);
    windowFocus.mockReturnValue(true);
    mounted.key(input, 'Enter');
    await mounted.settle();
    expect(mounted.source()).toBe(RENAMED);
    expect(mounted.source()).not.toContain(NEW_NODE_TITLE);
    expect(mounted.editor()).toBeNull();
  });

  it('is saved when the view closes while the window is still in the background', async () => {
    const { mounted } = await draftInBackgroundWindow();
    expect(mounted.source()).toBe(SOURCE);
    // Obsidian takes the view's element out of the document before `onClose` (measured on 1.14.2, E56): by then the
    // draft is not the active element any more, and in a window without the focus its removal sends no blur.
    mounted.view.containerEl.remove();
    await mounted.view.onClose();
    await mounted.settle();
    expect(mounted.source()).toBe(RENAMED);
  });

  it('is not saved by the close itself when its window has the focus (the draft\'s own blur is what saves it then)', async () => {
    // jsdom sends no blur for a removed element, so this pins that the close adds no save of its own in a focused
    // window: the removal blur does it on the real Obsidian (LEV-215), and a second save would be a second write.
    const mounted = await mountMapView(PATH, SOURCE);
    opened.push(mounted);
    mounted.key(mounted.select('通常のノード'), 'F2');
    await mounted.settle();
    const input = mounted.editor();
    if (!input) throw new Error('F2 did not open the draft');
    input.value = '戻って確定';
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    mounted.view.containerEl.remove();
    await mounted.view.onClose();
    await mounted.settle();
    expect(mounted.source()).toBe(SOURCE);
  });
});
