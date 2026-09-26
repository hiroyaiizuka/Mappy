// @vitest-environment jsdom
/**
 * LEV-216: a draft open while its window loses the OS focus (another app, another Obsidian window). The textarea gets
 * a blur while it stays the document's active element and the document has no focus. Builds through 0.3.7 saved the
 * draft on that blur and closed it, so the keyboard went to its node and the Enter the person pressed on coming back to
 * confirm it added a sibling 「サブトピック」 (seen in E50's step 6; E56 is the real-window case). The draft is still
 * saved there — the note has it however Obsidian is left from there (quit, the window or tab closed, which in a window
 * without the focus sends the draft no blur) — but it stays open, and the Enter on coming back closes it.
 *
 * The required cases of two-way editing (AGENTS.md) that this changes: Undo (the leave and the Enter are one step),
 * an external change while the draft is kept (another view writing the note), and IME (inline-editor.test.ts).
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

/** Close the view the way Obsidian does (its element out of the document first, then `onClose`), once. */
async function closeView(mounted: MountedMapView): Promise<void> {
  opened.splice(opened.indexOf(mounted), 1);
  mounted.view.containerEl.remove();
  await mounted.close();
}

describe('a draft whose window loses the OS focus (LEV-216)', () => {
  it('is saved and stays open; the Enter on coming back closes it and adds no sibling', async () => {
    const { mounted, input, windowFocus } = await draftInBackgroundWindow();
    expect(mounted.source()).toBe(RENAMED);
    expect(mounted.editor()).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('戻って確定');
    windowFocus.mockReturnValue(true);
    mounted.key(input, 'Enter');
    await mounted.settle();
    expect(mounted.source()).toBe(RENAMED);
    expect(mounted.source()).not.toContain(NEW_NODE_TITLE);
    expect(mounted.editor()).toBeNull();
    // One step for Undo: the save on leaving; the Enter wrote nothing more.
    mounted.key(mounted.canvas, 'z', { metaKey: true });
    await mounted.settle();
    expect(mounted.source()).toBe(SOURCE);
  });

  it('takes what is typed after coming back, as a second step', async () => {
    const { mounted, input, windowFocus } = await draftInBackgroundWindow();
    windowFocus.mockReturnValue(true);
    input.value = '戻って書き足した';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    mounted.key(input, 'Enter');
    await mounted.settle();
    expect(mounted.source()).toBe(SOURCE.replace('- 通常のノード\n', '- 戻って書き足した\n'));
    mounted.key(mounted.canvas, 'z', { metaKey: true });
    await mounted.settle();
    expect(mounted.source()).toBe(RENAMED);
  });

  it('is in the note when the view closes while the window is still in the background', async () => {
    const { mounted } = await draftInBackgroundWindow();
    await closeView(mounted);
    expect(mounted.source()).toBe(RENAMED);
  });

  it('applies over a change another view wrote to the note while the window was away', async () => {
    const { mounted, input, windowFocus } = await draftInBackgroundWindow();
    // Another window edits another line of the same note; the map re-reads it under the kept draft.
    const changed = RENAMED.replace('- 別のノード\n', '- 別のウィンドウで編集\n');
    mounted.app.put(PATH, changed);
    // The map re-reads a change from outside on its debounce.
    await new Promise(resolve => setTimeout(resolve, 400));
    await mounted.settle();
    windowFocus.mockReturnValue(true);
    mounted.key(input, 'Enter');
    await mounted.settle();
    expect(mounted.view.containerEl.querySelector('.mappy-inline-error')?.textContent ?? '').toBe('');
    expect(mounted.source()).toBe(changed);
    expect(mounted.editor()).toBeNull();
  });
});
