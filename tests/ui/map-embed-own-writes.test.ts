// @vitest-environment jsdom
/**
 * A map embedded in another note (`MapEmbed`) re-reads the note after every write the map's tab makes, and carries
 * the ids over with the edits of that write as the tab does (LEV-217, after LEV-150): the reader's folds stay on a
 * node whose title repeats or is empty. The matrix is what the user does in the tab (an edit, a layout button, ⌘Z,
 * ⌘⇧Z) × the shape of the node the reader toggled in the embed (one title, the second untitled node, the second of
 * two same-titled nodes, a topic).
 *
 * Every branch below the first level starts folded in an embed, and a node the re-read cannot place (a new id) is
 * folded as new, so what the reader loses is a branch they opened: it closes again. The 通常 and トピック rows hold
 * before the fix too; they pin that the carried ids do not move a node matched by its title. The E05 row pins what
 * the fix must not do: an external change is still matched by titles alone (it holds before the fix too). The last
 * row fails when a record the re-read could not use is kept (`artifacts/lev-217-embed-onwrite/mutations.txt`).
 *
 * Before the fix the 空題名 and 同名 rows failed at the first edit: a new id, folded again
 * (`artifacts/lev-217-embed-onwrite/tests-before-fix.log`).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, MarkdownPostProcessorContext } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { Component, MarkdownRenderer } from '../../harness/browser/obsidian';
import { LAYOUT_LABELS } from '../../src/core/layout-mode';
import type { DocumentStore } from '../../src/obsidian/document-store';
import { MapEmbeds } from '../../src/ui/map-embed';
import { mountMapView, type MountedMapView } from './map-view-mount';
import { accessibleName } from './accessible-name';

vi.mock('obsidian', () => import('../../harness/browser/obsidian'));
beforeAll(() => { installObsidianDom(); });

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

interface Opened { map: MountedMapView; embeds: MapEmbeds; renderer: Component; section: HTMLElement }
const opened: Opened[] = [];
afterEach(async () => {
  for (const { map, embeds, renderer } of opened.splice(0)) {
    embeds.dispose();
    renderer.unload();
    await map.close();
  }
  document.body.replaceChildren();
});

/** The note open in a map tab, and embedded in the reading view of another note; the plugin gives both one store (src/main.ts). */
async function open(): Promise<Opened> {
  const app = new HarnessApp();
  app.put('Host.md', '![[Fixtures/undo-ids]]');
  const map = await mountMapView(PATH, SOURCE, 'mindmap', app);
  const store = (map.view as unknown as { store: DocumentStore }).store;
  const embeds = new MapEmbeds(app.asApp<App>(), store);
  const renderer = new Component();
  renderer.load();
  const section = document.body.createDiv({ cls: 'markdown-preview-section' });
  await MarkdownRenderer.render(app.asApp<App>(), '![[Fixtures/undo-ids]]', section, 'Host.md');
  const context: MarkdownPostProcessorContext = {
    docId: 'doc', sourcePath: 'Host.md', frontmatter: null, getSectionInfo: () => null,
    addChild: child => { renderer.addChild(child as unknown as Component); },
  };
  embeds.process(section, context);
  const result = { map, embeds, renderer, section };
  opened.push(result);
  await settled(result, () => true);
  return result;
}

interface ViewState { document: { source: string } | undefined; refreshTimer: number | undefined; refreshing: Promise<void> | undefined; saving: boolean }
interface EmbedState { drawnSource: string | null; refreshTimer: number | undefined }

/** Every write and re-read done, with the tab and the embed both showing what the note holds. */
async function settled({ map, embeds }: Opened, reached: (source: string) => boolean): Promise<void> {
  const view = map.view as unknown as ViewState;
  const [embed] = (embeds as unknown as { live: Set<EmbedState> }).live;
  await vi.waitFor(() => {
    expect({
      reached: reached(map.source()), timer: view.refreshTimer, read: view.refreshing, saving: view.saving,
      view: view.document?.source === map.source(), embed: embed?.drawnSource === map.source(), embedTimer: embed?.refreshTimer,
    }).toEqual({ reached: true, timer: undefined, read: undefined, saving: false, view: true, embed: true, embedTimer: undefined });
  }, { timeout: 2000, interval: 5 });
  await map.settle();
}

/** The `index`-th node with this label (an untitled node reads as 空のノード) inside `root`. */
function nodeNamed(root: ParentNode, label: string, index = 0): HTMLElement {
  const found = Array.from(root.querySelectorAll<HTMLElement>('.mappy-node')).filter(node => accessibleName(node) === label)[index];
  if (!found) throw new Error(`No node ${label} #${index}`);
  return found;
}

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/** What the reader sees of a node in the embed: its id and whether its branch is folded. */
function seen(section: HTMLElement, label: string, index: number): { id: string | undefined; folded: boolean } {
  const node = nodeNamed(section, label, index);
  return { id: node.dataset.nodeId, folded: node.hasClass('is-collapsed') };
}

/** `from` renamed with F2 in the tab (子1 by default, to a longer title so every node after it moves). */
async function rename(opened: Opened, from = '子1', to = 'ずっと長い題名に改名'): Promise<void> {
  const { map } = opened;
  click(nodeNamed(map.view.containerEl, from));
  map.key(map.canvas, 'F2');
  const editor = map.editor();
  if (!editor) throw new Error('F2 opened no editor');
  editor.value = to;
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  map.key(editor, 'Enter');
  await settled(opened, source => source.includes(`- ${to}\n`));
}

async function layout(opened: Opened): Promise<void> {
  const button = opened.map.view.containerEl.querySelector<HTMLButtonElement>(`.mappy-modes button[aria-label="${LAYOUT_LABELS.timeline}"]`);
  if (!button) throw new Error('No layout button');
  button.click();
  await settled(opened, source => source.includes('mappy-layout: timeline\n'));
}

/** ⌘Z, or ⌘⇧Z, on the tab's canvas. */
async function history(opened: Opened, redo: boolean, reached: (source: string) => boolean): Promise<void> {
  opened.map.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: redo, bubbles: true, cancelable: true }));
  await settled(opened, reached);
}

const SHAPES = [
  { shape: '通常', label: '親', index: 0 },
  { shape: '空題名 (the second)', label: EMPTY_LABEL, index: 1 },
  { shape: '同名 (the second)', label: '同名', index: 1 },
  { shape: 'トピック', label: 'トピック', index: 0 },
] as const;

describe("the embed's folds through the writes of the note's map tab (LEV-217)", () => {
  it.each(SHAPES)('an edit, a layout button, ⌘Z and ⌘⇧Z in the tab: the $shape node the reader toggled in the embed keeps its id and its fold', async ({ label, index }) => {
    const opened = await open();
    const { section } = opened;
    const before = seen(section, label, index);
    click(nodeNamed(section, label, index).querySelector<HTMLElement>('.mappy-node-toggle') ?? section);
    await opened.map.settle();
    const toggled = { id: before.id, folded: !before.folded };
    expect(seen(section, label, index)).toEqual(toggled);

    await rename(opened);
    expect({ step: 'edit', ...seen(section, label, index) }).toEqual({ step: 'edit', ...toggled });
    await layout(opened);
    expect({ step: 'layout', ...seen(section, label, index) }).toEqual({ step: 'layout', ...toggled });
    // The layout button is not a step of its own (LEV-206): ⌘Z takes the rename back under the new layout.
    await history(opened, false, source => source.includes('  - 子1\n') && source.includes('mappy-layout: timeline\n'));
    expect({ step: '⌘Z', ...seen(section, label, index) }).toEqual({ step: '⌘Z', ...toggled });
    await history(opened, true, source => source.includes('- ずっと長い題名に改名\n'));
    expect({ step: '⌘⇧Z', ...seen(section, label, index) }).toEqual({ step: '⌘⇧Z', ...toggled });
  });

  it('an external change is still matched by titles alone, and a same-titled node is not guessed (E05)', async () => {
    // Not a regression test of the bug: it pins what the fix must not do — take someone else's change for the map's own.
    const opened = await open();
    const { section, map } = opened;
    await rename(opened);
    const { id } = seen(section, EMPTY_LABEL, 1);
    await map.app.asApp<App>().vault.process(map.file, text => text.replace('- 子2\n', '- 外から\n'));
    await settled(opened, source => source.includes('- 外から\n'));
    expect(seen(section, EMPTY_LABEL, 1).id).not.toBe(id);
  });

  it('a write the embed had not re-read when the note changed under it is dropped, and the next edit in the tab carries the ids again', async () => {
    // The tab's rename is recorded, then an external change lands before the embed's re-read (its 45 ms debounce): the
    // rename cannot lead to the text found. Kept, it would stand at the end of the record, and every later write —
    // made on the text the embed now shows — would not lead on from it.
    const opened = await open();
    const { section, map } = opened;
    click(nodeNamed(section, EMPTY_LABEL, 1).querySelector<HTMLElement>('.mappy-node-toggle') ?? section);
    await map.settle();
    const store = (map.view as unknown as { store: DocumentStore }).store;
    const from = SOURCE.indexOf('子1');
    await store.applyLatest(map.file, () => [{ from, to: from + 2, text: '改名' }]);
    await map.app.asApp<App>().vault.process(map.file, text => text.replace('- 子2\n', '- 外から\n'));
    // The row's premise: the embed has not re-read the rename yet (its debounce is still waiting). Were it to, the
    // record would be spent correctly and the row would pass whatever the record does with a write it cannot use.
    const [embed] = (opened.embeds as unknown as { live: Set<EmbedState> }).live;
    expect({ drawn: embed?.drawnSource, waiting: embed?.refreshTimer !== undefined }).toEqual({ drawn: SOURCE, waiting: true });
    await settled(opened, source => source.includes('- 外から\n') && source.includes('- 改名\n'));
    // Titles alone: the second untitled node is not guessed, and comes back folded as new.
    const after = seen(section, EMPTY_LABEL, 1);
    expect(after.folded).toBe(true);
    click(nodeNamed(section, EMPTY_LABEL, 1).querySelector<HTMLElement>('.mappy-node-toggle') ?? section);
    await map.settle();
    await rename(opened, '改名', '別のもっと長い題名');
    expect(seen(section, EMPTY_LABEL, 1)).toEqual({ id: after.id, folded: false });
  });
});
