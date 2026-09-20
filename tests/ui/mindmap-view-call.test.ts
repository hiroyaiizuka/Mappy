// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, TFile } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { Notice } from '../../harness/browser/obsidian';
import { findFixture } from '../../harness/browser/fixtures';
import { projectMap, type MindDocument, type MindNode } from '../../src/core/markdown';
import { readTopicPositions } from '../../src/core/topics';
import type { MindmapView } from '../../src/ui/mindmap-view';
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

const PATH = 'Fixtures/free-topics.md';
const OTHER = 'Fixtures/other-map.md';
const OTHER_SOURCE = '---\nmappy: true\nmappy-layout: timeline\n---\n## 別のマップ\n- 第 1 週\n- 第 2 週\n';
/** The wiki embed of the in-memory `fileToLinktext` (the note's name without extension), as Obsidian writes it for a unique name. */
const LINK = '![[other-map]]';

function fixtureSource(): string {
  const fixture = findFixture('free-topics');
  if (!fixture) throw new Error('Missing free-topics fixture');
  return fixture.source;
}

function documentOf(view: MindmapView): MindDocument {
  const document = view.snapshot()?.document;
  if (!document) throw new Error('The view has not parsed its note');
  return document;
}

interface Mounted extends MountedMapView {
  /** The map to call, in the same vault. */
  other: TFile;
  /** The parsed node with this title, from the view's own document. */
  parsed: (title: string) => MindNode;
  /** The id of the node the map shows as selected. */
  selected: () => string | undefined;
  /** A primary-button press and release on the empty canvas at one point (a click, not a pan), as a pointer makes them. */
  clickBlank: (x?: number, y?: number) => void;
  /** ⌘Z / ⌘⇧Z on the canvas: the map's own history, then a refresh. */
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

/** The free-topics note as a map, next to a second map it can call. */
async function mount(source = fixtureSource()): Promise<Mounted> {
  const app = new HarnessApp();
  const other = app.put(OTHER, OTHER_SOURCE) as unknown as TFile;
  const mounted = await mountMapView(PATH, source, 'mindmap', app);
  opened.push(mounted);
  const history = async (shift: boolean): Promise<void> => {
    mounted.key(mounted.canvas, 'z', { metaKey: true, shiftKey: shift });
    await mounted.settle();
  };
  return {
    ...mounted, other,
    parsed: title => {
      const found = documentOf(mounted.view).nodes.find(candidate => candidate.title === title);
      if (!found) throw new Error(`Missing node ${title}`);
      return found;
    },
    selected: () => mounted.view.containerEl.querySelector<HTMLElement>('.mappy-node.is-selected')?.dataset.nodeId,
    clickBlank: (x = 400, y = 300) => {
      mounted.canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, button: 0, bubbles: true, cancelable: true, clientX: x, clientY: y }));
      mounted.canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, button: 0, bubbles: true, cancelable: true, clientX: x, clientY: y }));
      mounted.canvas.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true, clientX: x, clientY: y }));
    },
    undo: () => history(false),
    redo: () => history(true),
  };
}

describe('MindmapView.callMap (§5 M12, the input side)', () => {
  it('with the body root selected (the selection a note opens with), appends the embed after its last child and selects it without opening the editor', async () => {
    const source = fixtureSource();
    const { view, other, source: current, parsed, selected, editor, app } = await mount();
    expect(selected()).toBe(projectMap(documentOf(view)).root.id);
    await view.callMap(other);
    const expected = source.replace('- 習慣化する\n', `- 習慣化する\n- ${LINK}\n`);
    expect(current()).toBe(expected);
    expect(projectMap(documentOf(view)).root.children.map(child => child.title)).toEqual(['回復する', '記録する', '習慣化する', LINK]);
    expect(selected()).toBe(parsed(LINK).id);
    expect(editor()).toBeNull();
    // The called map's note is not touched.
    expect(app.content(other)).toBe(OTHER_SOURCE);
    expect(Notice.log).toEqual([]);
  });

  it('with a node selected, nests the embed as that node\'s last child at the children\'s depth', async () => {
    const source = fixtureSource();
    const { view, other, source: current, select, parsed, selected } = await mount();
    select('回復する');
    await view.callMap(other);
    expect(current()).toBe(source.replace('  - 睡眠\n', `  - 睡眠\n  - ${LINK}\n`));
    expect(parsed('回復する').children.map(child => child.title)).toEqual(['休息の取り方', '睡眠', LINK]);
    expect(selected()).toBe(parsed(LINK).id);
    // A leaf gets its first child one step deeper.
    select('ふりかえる');
    await view.callMap(other);
    expect(current()).toContain(`  - ふりかえる\n    - ${LINK}\n`);
  });

  it('with nothing selected (the empty canvas clicked), appends `## ![[map]]` as a free topic at the end with no position, shown as the called root beside the body', async () => {
    const source = fixtureSource();
    const { view, other, source: current, parsed, selected, editor, app, node, clickBlank, settle } = await mount();
    clickBlank();
    expect(selected()).toBeUndefined();
    await view.callMap(other);
    await settle();
    // One section appended; the frontmatter (the `mappy-topics` of the other topics included) and the body keep their bytes.
    expect(current()).toBe(`${source}\n## ${LINK}\n`);
    expect(readTopicPositions(current()).has(LINK)).toBe(false);
    const document = documentOf(view);
    expect(projectMap(document).topics.map(topic => topic.title)).toEqual(['参考資料', '補足: 用語', '位置のないトピック', LINK]);
    expect(projectMap(document).root.children.map(child => child.title)).toEqual(['回復する', '記録する', '習慣化する']);
    // The topic's root shows the called map's root and its tree as read-only branches; the heading itself is the host's own node.
    const topic = node('別のマップ');
    expect(topic.dataset.nodeId).toBe(parsed(LINK).id);
    expect(topic.hasClass('is-topic')).toBe(true);
    expect(topic.hasClass('is-called-root')).toBe(true);
    expect(topic.hasAttribute('aria-readonly')).toBe(false);
    expect(topic.querySelector('.mappy-node-call-mark')).not.toBeNull();
    for (const stage of ['第 1 週', '第 2 週']) {
      expect(node(stage).hasClass('is-called')).toBe(true);
      expect(node(stage).getAttribute('aria-readonly')).toBe('true');
    }
    expect(selected()).toBe(parsed(LINK).id);
    expect(editor()).toBeNull();
    expect(app.content(other)).toBe(OTHER_SOURCE);
    expect(Notice.log).toEqual([]);
    // F2 on the topic's root edits the heading as written.
    view.containerEl.querySelector<HTMLElement>('.mappy-canvas')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
    expect(editor()?.value).toBe(LINK);
  });

  it('a call with nothing selected is one step of the history: Undo removes the section and its branches, Redo puts them back; Delete on the topic removes the section too', async () => {
    const source = fixtureSource();
    const { view, other, source: current, clickBlank, undo, redo, settle, node, select, canvas, key } = await mount();
    clickBlank();
    await view.callMap(other);
    await settle();
    const called = current();
    expect(called).toBe(`${source}\n## ${LINK}\n`);
    await undo();
    expect(current()).toBe(source);
    expect(() => node('別のマップ')).toThrow();
    expect(view.containerEl.querySelectorAll('.mappy-node')).toHaveLength(documentOf(view).nodes.length);
    await redo();
    expect(current()).toBe(called);
    expect(node('別のマップ').hasClass('is-topic')).toBe(true);
    expect(node('第 2 週').hasClass('is-called')).toBe(true);
    // The topic's root is the host's own heading: Delete takes the section (and the called branches with it), Undo brings it back.
    select('別のマップ');
    key(canvas, 'Delete');
    await settle();
    expect(current()).toBe(source);
    expect(() => node('別のマップ')).toThrow();
    await undo();
    expect(current()).toBe(called);
    expect(Notice.log).toEqual([]);
  });

  it('a click on the empty canvas clears the selection on screen; a pan does not; an arrow key then starts from the body root, other keys do nothing', async () => {
    const source = fixtureSource();
    const { view, source: current, selected, select, clickBlank, canvas, key, editor, settle } = await mount();
    const root = projectMap(documentOf(view)).root.id;
    select('回復する');
    expect(selected()).toBe(documentOf(view).nodes.find(node => node.title === '回復する')?.id);
    clickBlank();
    expect(selected()).toBeUndefined();
    expect(canvas.querySelectorAll('.mappy-node.is-selected, .mappy-node[aria-selected="true"]')).toHaveLength(0);
    // Structural keys and F2 have no node to act on; the note is untouched and nothing is edited.
    for (const value of ['Tab', 'Enter', 'Delete', 'F2', ' ']) expect(key(canvas, value).defaultPrevented).toBe(false);
    await settle();
    expect(current()).toBe(source);
    expect(editor()).toBeNull();
    expect(selected()).toBeUndefined();
    // A redraw keeps nothing selected; an arrow key selects the first node on the map.
    expect(key(canvas, 'ArrowDown').defaultPrevented).toBe(true);
    expect(selected()).toBe(root);
    // A press that travelled (a pan) ends with a click on the canvas too, and keeps the selection.
    canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, button: 0, bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
    canvas.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true, clientX: 460, clientY: 340 }));
    expect(selected()).toBe(root);
    // A click on a node selects it again as before.
    select('記録する');
    expect(selected()).toBe(documentOf(view).nodes.find(node => node.title === '記録する')?.id);
  });

  it('with the root of a topic that calls a map selected, appends the embed as that section\'s own item, after the called branches', async () => {
    const source = `${fixtureSource()}\n## ${LINK}\n`;
    const { view, other, source: current, parsed, node, select } = await mount(source);
    select('別のマップ');
    await view.callMap(other);
    // The section's first item, as add-child writes it under a heading with no list yet.
    expect(current()).toBe(`${source}\n- ${LINK}\n`);
    expect(parsed(LINK).children.map(child => child.title)).toEqual([LINK]);
    // The section's own item is drawn after the called map's branches, itself a calling item.
    expect(node('別のマップ').hasClass('is-topic')).toBe(true);
    expect(view.containerEl.querySelectorAll('.mappy-node.is-called-root')).toHaveLength(2);
  });

  it('with a free topic selected, appends under that topic; the body and the other topics keep their bytes', async () => {
    const source = fixtureSource();
    const { view, other, source: current, select, parsed } = await mount();
    select('補足: 用語');
    await view.callMap(other);
    const expected = source.replace('- 用語 B\n', `- 用語 B\n- ${LINK}\n`);
    expect(current()).toBe(expected);
    expect(parsed('補足: 用語').children.map(child => child.title)).toEqual(['用語 A', '用語 B', LINK]);
    expect(projectMap(documentOf(view)).topics.map(topic => topic.title)).toEqual(['参考資料', '補足: 用語', '位置のないトピック']);
  });

  it('is one step of the history: Undo removes the item as a whole, Redo puts it back', async () => {
    const source = fixtureSource();
    const { view, other, source: current, undo, redo } = await mount();
    await view.callMap(other);
    const called = current();
    expect(called).not.toBe(source);
    await undo();
    expect(current()).toBe(source);
    expect(view.containerEl.querySelectorAll('.mappy-node')).toHaveLength(documentOf(view).nodes.length);
    expect(documentOf(view).nodes.some(node => node.title === LINK)).toBe(false);
    await redo();
    expect(current()).toBe(called);
    await undo();
    expect(current()).toBe(source);
  });

  it('calls the same map twice into two items; the new item is what is selected, so a call straight after nests under it', async () => {
    const source = fixtureSource();
    const { view, other, source: current, parsed, select, selected } = await mount();
    await view.callMap(other);
    select('習慣化する');
    await view.callMap(other);
    select('習慣化する');
    await view.callMap(other);
    expect(current()).toBe(source.replace('- 習慣化する\n', `- 習慣化する\n  - ${LINK}\n  - ${LINK}\n- ${LINK}\n`));
    expect(parsed('習慣化する').children.map(child => child.title)).toEqual([LINK, LINK]);
    expect(projectMap(documentOf(view)).root.children.filter(child => child.title === LINK)).toHaveLength(1);
    // As after Tab, the selection moved to the item just added: the next call goes one level down.
    const [, last] = parsed('習慣化する').children;
    expect(selected()).toBe(last?.id);
    await view.callMap(other);
    expect(current()).toContain(`  - ${LINK}\n  - ${LINK}\n    - ${LINK}\n- ${LINK}\n`);
  });

  it('writes a child heading in a headings-format note, as add-child does there', async () => {
    const source = '---\nmappy: true\n---\n# 講座\n\n## 第 1 章\n\n本文\n\n### 節\n\n## 第 2 章\n';
    const { view, other, source: current, select } = await mount(source);
    select('第 1 章');
    await view.callMap(other);
    expect(current()).toBe(`---\nmappy: true\n---\n# 講座\n\n## 第 1 章\n\n本文\n\n### 節\n\n### ${LINK}\n\n## 第 2 章\n`);
  });

  it('refuses to call the map into itself and refuses while a title is being edited, leaving the note as it was', async () => {
    const source = fixtureSource();
    const { view, app, source: current, select, canvas, editor, other, parsed, key } = await mount();
    const self = app.asApp<App>().vault.getAbstractFileByPath(PATH) as TFile;
    await expect(view.callMap(self)).rejects.toThrow('自身');
    expect(current()).toBe(source);
    select('記録する');
    key(canvas, 'F2');
    expect(editor()).not.toBeNull();
    await expect(view.callMap(other)).rejects.toThrow('編集を確定');
    // The guard sits on the shared edit path, so a context-menu add-child under a kept draft is refused the same way.
    const execute = (view as unknown as { execute(command: { type: 'add-child'; nodeId: string }): Promise<void> }).execute.bind(view);
    await expect(execute({ type: 'add-child', nodeId: parsed('記録する').id })).rejects.toThrow('編集を確定');
    expect(current()).toBe(source);
  });

  it('says so instead of dropping the choice while a save is in flight', async () => {
    const source = fixtureSource();
    const { view, other, source: current, settle } = await mount();
    const first = view.callMap(other);
    await expect(view.callMap(other)).rejects.toThrow('保存処理');
    await first;
    await settle();
    expect(current()).toBe(source.replace('- 習慣化する\n', `- 習慣化する\n- ${LINK}\n`));
  });

  it('adds the call as a topic to a note whose body is the virtual root, whether the root is selected or nothing is (no "先に H2 を")', async () => {
    const headless = '---\nmappy: true\n---\n- 見出しより前の項目\n';
    const bare = await mount(headless);
    expect(bare.selected()).toBe('root');
    await bare.view.callMap(bare.other);
    await bare.settle();
    expect(bare.source()).toBe(`${headless}\n## ${LINK}\n`);
    expect(projectMap(documentOf(bare.view)).root.kind).toBe('root');
    expect(projectMap(documentOf(bare.view)).topics.map(topic => topic.title)).toEqual([LINK]);
    expect(bare.node('別のマップ').hasClass('is-topic')).toBe(true);
    expect(bare.selected()).toBe(bare.parsed(LINK).id);
    bare.clickBlank();
    await bare.view.callMap(bare.other);
    await bare.settle();
    expect(bare.source()).toBe(`${headless}\n## ${LINK}\n\n## ${LINK}\n`);
    expect(Notice.log).toEqual([]);
  });
});
