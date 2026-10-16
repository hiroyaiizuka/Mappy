// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installObsidianDom } from '../browser-harness/dom';
import { EditableFileView } from '../browser-harness/obsidian';
import { t } from '../../src/i18n';
import { nodeNamed } from './accessible-name';
import { mountMapView } from './map-view-mount';
import { closeOpenViews } from '../mocks/open-views';

// The browser-harness stand-in for `obsidian`, so the shipped view runs against a real DOM.
vi.mock('obsidian', () => import('../browser-harness/obsidian'));

beforeAll(() => { installObsidianDom(); });
afterEach(async () => {
  await closeOpenViews();
  document.body.replaceChildren();
});

const PATH = 'Mail/ローンチメール.md';
const RENAMED = 'Mail/ローンチメール改.md';
/** No heading section: the root node is the file name (LEV-301), so a rename shows on the map too. */
const SOURCE = ['---', 'mappy: true', '---', '- 件名', '  - 本文', ''].join('\n');

/**
 * LEV-340 (the person's report of 2026-10-16, decided as 「A」): the map's view header title renames its note, as the
 * Markdown editor's does — the map is an `EditableFileView`, and the tab and the header say the note's name only.
 * The harness's EditableFileView copies Obsidian 1.14.4's (tests/browser-harness/obsidian.ts); what reaches the map
 * is that `onOpen` and `setEphemeralState` hand Obsidian's part on, and that the map follows the rename. The real
 * title, keys and command run on the test vault (E87, `npm run harness:e2e:map-title-rename`).
 */
async function mount() {
  const mounted = await mountMapView(PATH, SOURCE);
  const title = (mounted.view as unknown as { titleEl: HTMLElement }).titleEl;
  const leaf = mounted.view.leaf as unknown as { headerText: string };
  /** What a user does in the title: focus it, write a name over it, and press a key there. */
  const type = (name: string, key: string): void => {
    title.focus();
    title.textContent = name;
    mounted.key(title, key);
  };
  const errors = (): string[] => Array.from(document.querySelectorAll('.tooltip.mod-error'), element => element.textContent ?? '');
  return { ...mounted, title, leaf, type, errors };
}

describe('MindmapView header title (LEV-340: rename the note from the map)', () => {
  it('names the tab and the header by the note\'s name only, and is an editable file view', async () => {
    const { view, title, leaf } = await mount();
    expect(view).toBeInstanceOf(EditableFileView);
    expect(view.getDisplayText()).toBe('ローンチメール');
    expect(leaf.headerText).toBe('ローンチメール');
    expect(title.textContent).toBe('ローンチメール');
    // EditableFileView's `onOpen`, which the map's own hands on to: the title is an editable field.
    expect(title.contentEditable).toBe('true');
    // Without a note the text is unchanged (a leaf without one closes: `allowNoFile` is false).
    view.file = null;
    expect(view.getDisplayText()).toBe(t().viewTitleEmpty);
  });

  it('renames the note when the title is confirmed with Enter: the map stays on it, its root renamed, the focus back on the map', async () => {
    const { app, view, file, title, leaf, type, source, settle, errors } = await mount();
    type('ローンチメール改', 'Enter');
    await settle();
    expect(app.vault.getAbstractFileByPath(PATH)).toBeNull();
    expect(app.vault.getAbstractFileByPath(RENAMED)).toBe(file);
    expect(view.file).toBe(file);
    expect(source()).toBe(SOURCE);
    expect(errors()).toEqual([]);
    expect(title.textContent).toBe('ローンチメール改');
    expect(leaf.headerText).toBe('ローンチメール改');
    expect(view.getState()).toMatchObject({ file: RENAMED });
    // The root node is the file name: the map's re-read after FileView's rename names it anew.
    await vi.waitFor(() => { expect(nodeNamed(view.containerEl, 'ローンチメール改')).not.toBeNull(); });
    expect(nodeNamed(view.containerEl, 'ローンチメール')).toBeNull();
    // EditableFileView hands the focus back (`setEphemeralState({ focus: true })`), and the map takes it.
    expect(view.contentEl.contains(document.activeElement)).toBe(true);
  });

  it('renames on a blur too; Escape puts the name back and renames nothing', async () => {
    const first = await mount();
    first.title.focus();
    first.title.textContent = '外したときの名前';
    first.canvas.focus();
    await first.settle();
    expect(first.app.vault.getAbstractFileByPath('Mail/外したときの名前.md')).toBe(first.file);
    expect(first.title.textContent).toBe('外したときの名前');
    await closeOpenViews();
    document.body.replaceChildren();

    const second = await mount();
    second.type('取り消す名前', 'Escape');
    await second.settle();
    expect(second.app.vault.getAbstractFileByPath(PATH)).toBe(second.file);
    expect(second.title.textContent).toBe('ローンチメール');
    expect(second.leaf.headerText).toBe('ローンチメール');
    expect(second.view.contentEl.contains(document.activeElement)).toBe(true);
  });

  it('refuses a name another note has, an empty name and one with `:`: the note stays, the error shows until Escape', async () => {
    for (const name of ['既存', '', 'a:b']) {
      const { app, file, title, type, errors, key, settle } = await mount();
      const other = app.put('Mail/既存.md', '- 既存\n');
      type(name, 'Enter');
      await settle();
      expect(app.vault.getAbstractFileByPath(PATH), name).toBe(file);
      expect(errors(), name).toHaveLength(1);
      expect(document.activeElement, name).toBe(title);
      key(title, 'Escape');
      await settle();
      expect(title.textContent, name).toBe('ローンチメール');
      expect(errors(), name).toEqual([]);
      expect(app.content(other), name).toBe('- 既存\n');
      await closeOpenViews();
      document.body.replaceChildren();
    }
  });

  it('starts the rename for `workspace:edit-file-title` (its `rename` state), and still takes its own states', async () => {
    const { view, title, type, settle, app, file, select } = await mount();
    // What the command asks of the active file view's leaf: the title focused, the whole name selected.
    view.setEphemeralState({ rename: 'all' });
    expect(document.activeElement).toBe(title);
    expect(document.getSelection()?.toString()).toBe('ローンチメール');
    type('ローンチメール改', 'Enter');
    await settle();
    expect(app.vault.getAbstractFileByPath(RENAMED)).toBe(file);
    // The map's own ephemeral state goes on as before: the focus on the selected node.
    const node = select('本文');
    title.focus();
    view.setEphemeralState({ focus: true });
    expect(document.activeElement).toBe(node);
    // A state that is not an object is none, as before: Obsidian's part reads `rename` off it unchecked, so it gets an object.
    expect(() => { view.setEphemeralState(undefined); view.setEphemeralState(null); }).not.toThrow();
  });

  it('saves a node\'s open input first when the title is pressed, and leaves the title to the rename', async () => {
    const { app, view, file, title, key, select, editor, source, settle } = await mount();
    key(select('本文'), 'F2');
    await settle();
    const input = editor();
    expect(input?.value).toBe('本文');
    (input as HTMLTextAreaElement).value = '本文（下書き）';
    // Pressing the title moves the focus there: the input's blur saves the draft (as any blur does).
    title.focus();
    await vi.waitFor(() => { expect(source()).toBe(SOURCE.replace('  - 本文', '  - 本文（下書き）')); });
    expect(editor()).toBeNull();
    await settle();
    // The draft's save does not take the focus back to its node: the title is still being edited (before the fix the
    // node took it, and the title's edit ended before a key was typed).
    expect(document.activeElement).toBe(title);
    expect(view.containerEl.querySelector('.mappy-node.is-selected')).not.toBeNull();
    title.textContent = 'ローンチメール改';
    key(title, 'Enter');
    await settle();
    expect(app.vault.getAbstractFileByPath(RENAMED)).toBe(file);
    expect(source()).toBe(SOURCE.replace('  - 本文', '  - 本文（下書き）'));
    await vi.waitFor(() => { expect(nodeNamed(view.containerEl, '本文（下書き）')).not.toBeNull(); });
  });

  it('leaves the title to the rename when the draft pressed away is unchanged: its save ends while the blur runs', async () => {
    const { app, view, file, title, key, select, editor, source, settle } = await mount();
    key(select('本文'), 'F2');
    await settle();
    const input = editor() as HTMLTextAreaElement;
    expect(input.value).toBe('本文');
    const focused: Element[] = [];
    view.contentEl.addEventListener('focusin', event => { focused.push(event.target as Element); });
    // Chromium's order for a press on the title: the input's blur runs, and the microtasks after it, with the body
    // active and the title as `relatedTarget`; the title is focused only afterwards. Nothing typed, the save writes
    // nothing and the draft closes within those microtasks (code review of LEV-340). jsdom moves the focus first, so the
    // order is played here.
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => document.body });
    try {
      input.dispatchEvent(new FocusEvent('blur', { relatedTarget: title }));
      for (let round = 0; round < 50 && editor(); round += 1) await Promise.resolve();
      expect(editor()).toBeNull();
    } finally {
      delete (document as { activeElement?: unknown }).activeElement;
    }
    // The map did not take the focus back for its node: the title gets it, and renames the note.
    expect(focused).toEqual([]);
    title.focus();
    await settle();
    expect(source()).toBe(SOURCE);
    expect(document.activeElement).toBe(title);
    title.textContent = 'ローンチメール改';
    key(title, 'Enter');
    await settle();
    expect(app.vault.getAbstractFileByPath(RENAMED)).toBe(file);
  });

  it('leaves the focus where a press outside the map put it when that press closes a draft; Enter still gives it to the node', async () => {
    const { view, key, select, editor, source, settle, node } = await mount();
    // Another view's editor (the Markdown tab beside, say), outside the map's content.
    const elsewhere = document.body.createDiv({ attr: { contenteditable: 'true', tabindex: '0' } });
    const revealed = vi.spyOn(view as unknown as { ensureVisible: (id: string) => void }, 'ensureVisible');
    key(select('件名'), 'F2');
    await settle();
    (editor() as HTMLTextAreaElement).value = '件名（外）';
    revealed.mockClear();
    elsewhere.focus();
    await vi.waitFor(() => { expect(source()).toBe(SOURCE.replace('- 件名', '- 件名（外）')); });
    await settle();
    expect(document.activeElement).toBe(elsewhere);
    // The node keeps its selection and is brought on screen as any closed draft's is; only the keyboard stays away.
    expect(view.containerEl.querySelector('.mappy-node.is-selected')).toBe(node('件名（外）'));
    expect(revealed).toHaveBeenCalled();
    // Confirmed with its own Enter, the draft leaves the page and the node takes the keyboard, as before.
    key(select('件名（外）'), 'F2');
    await settle();
    (editor() as HTMLTextAreaElement).value = '件名（確定）';
    key(editor() as HTMLTextAreaElement, 'Enter');
    await vi.waitFor(() => { expect(source()).toBe(SOURCE.replace('- 件名', '- 件名（確定）')); });
    await settle();
    expect(document.activeElement).toBe(node('件名（確定）'));
    expect(view.contentEl.contains(document.activeElement)).toBe(true);
  });
});
