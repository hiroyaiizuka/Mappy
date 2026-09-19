// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, TFile, WorkspaceLeaf as ObsidianLeaf, ViewStateResult } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { Notice, WorkspaceLeaf } from '../../harness/browser/obsidian';
import { findFixture } from '../../harness/browser/fixtures';
import { projectMap, type MindDocument, type MindNode } from '../../src/core/markdown';
import { DocumentStore } from '../../src/obsidian/document-store';
import type { ViewRouter } from '../../src/obsidian/view-routing';
import { MindmapView } from '../../src/ui/mindmap-view';

// The browser-harness stand-in for `obsidian`, so the shipped view, renderer and store run against a real DOM.
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });
/** Views mounted by a test, closed after it so a pending refresh or layout frame cannot run into the next test. */
const mounted: MindmapView[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) { await view.onClose(); view.unload(); }
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

interface Mounted {
  app: HarnessApp;
  view: MindmapView;
  canvas: HTMLElement;
  other: TFile;
  nodes: () => Map<string, HTMLElement>;
  /** The note as the in-memory vault holds it now. */
  source: () => string;
  settle: () => Promise<void>;
  node: (title: string) => MindNode;
  /** Click a node, as the pointer selects it. */
  select: (title: string) => void;
  selected: () => string | undefined;
  editor: () => HTMLTextAreaElement | null;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

async function mount(source = fixtureSource()): Promise<Mounted> {
  const app = new HarnessApp();
  app.put(PATH, source);
  const other = app.put(OTHER, OTHER_SOURCE) as unknown as TFile;
  const leaf = new WorkspaceLeaf(app.asApp<App>());
  const store = new DocumentStore(app.asApp<App>());
  const view = new MindmapView(leaf as unknown as ObsidianLeaf, store, {} as ViewRouter);
  leaf.view = view as unknown as WorkspaceLeaf['view'];
  document.body.append(view.containerEl);
  mounted.push(view);
  view.load();
  await view.onOpen();
  const canvas = view.containerEl.querySelector<HTMLElement>('.mappy-canvas');
  if (!canvas) throw new Error('The view has no canvas');
  await view.setState({ file: PATH, layout: 'mindmap' }, { history: false } satisfies ViewStateResult);
  await new Promise(resolve => requestAnimationFrame(resolve));
  const file = app.asApp<App>().vault.getAbstractFileByPath(PATH) as TFile;
  const nodes = (): Map<string, HTMLElement> => new Map(Array.from(
    view.containerEl.querySelectorAll<HTMLElement>('.mappy-node'), node => [node.dataset.nodeId ?? '', node],
  ));
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 3; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => requestAnimationFrame(resolve));
  };
  const node = (title: string): MindNode => {
    const found = documentOf(view).nodes.find(candidate => candidate.title === title);
    if (!found) throw new Error(`Missing node ${title}`);
    return found;
  };
  const history = async (shift: boolean): Promise<void> => {
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: shift, bubbles: true, cancelable: true }));
    await settle();
  };
  return {
    app, view, canvas, other, nodes, settle, node,
    source: () => app.content(file),
    select: title => { nodes().get(node(title).id)?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); },
    selected: () => view.containerEl.querySelector<HTMLElement>('.mappy-node.is-selected')?.dataset.nodeId,
    editor: () => view.containerEl.querySelector<HTMLTextAreaElement>('textarea.mappy-inline-input'),
    undo: () => history(false),
    redo: () => history(true),
  };
}

describe('MindmapView.callMap (§5 M12, the input side)', () => {
  it('with nothing selected, appends the embed after the last child of the body root and selects it without opening the editor', async () => {
    const source = fixtureSource();
    const { view, other, source: current, node, selected, editor, app } = await mount();
    await view.callMap(other);
    const expected = source.replace('- 習慣化する\n', `- 習慣化する\n- ${LINK}\n`);
    expect(current()).toBe(expected);
    expect(projectMap(documentOf(view)).root.children.map(child => child.title)).toEqual(['回復する', '記録する', '習慣化する', LINK]);
    expect(selected()).toBe(node(LINK).id);
    expect(editor()).toBeNull();
    // The called map's note is not touched, and its link is the vault's own format prefixed with `!`.
    expect(app.content(other)).toBe(OTHER_SOURCE);
    expect(Notice.log).toEqual([]);
  });

  it('with a node selected, nests the embed as that node\'s last child at the children\'s depth', async () => {
    const source = fixtureSource();
    const { view, other, source: current, select, node, selected } = await mount();
    select('回復する');
    await view.callMap(other);
    expect(current()).toBe(source.replace('  - 睡眠\n', `  - 睡眠\n  - ${LINK}\n`));
    expect(node('回復する').children.map(child => child.title)).toEqual(['休息の取り方', '睡眠', LINK]);
    expect(selected()).toBe(node(LINK).id);
    // A leaf gets its first child one step deeper.
    select('ふりかえる');
    await view.callMap(other);
    expect(current()).toContain(`  - ふりかえる\n    - ${LINK}\n`);
  });

  it('with a free topic selected, appends under that topic; the body and the other topics keep their bytes', async () => {
    const source = fixtureSource();
    const { view, other, source: current, select, node } = await mount();
    select('補足: 用語');
    await view.callMap(other);
    const expected = source.replace('- 用語 B\n', `- 用語 B\n- ${LINK}\n`);
    expect(current()).toBe(expected);
    expect(node('補足: 用語').children.map(child => child.title)).toEqual(['用語 A', '用語 B', LINK]);
    expect(projectMap(documentOf(view)).topics.map(topic => topic.title)).toEqual(['参考資料', '補足: 用語', '位置のないトピック']);
  });

  it('is one step of the history: Undo removes the item as a whole, Redo puts it back', async () => {
    const source = fixtureSource();
    const { view, other, source: current, nodes, undo, redo } = await mount();
    await view.callMap(other);
    const called = current();
    expect(called).not.toBe(source);
    await undo();
    expect(current()).toBe(source);
    expect(nodes().size).toBe(documentOf(view).nodes.length);
    expect(documentOf(view).nodes.some(node => node.title === LINK)).toBe(false);
    await redo();
    expect(current()).toBe(called);
    await undo();
    expect(current()).toBe(source);
  });

  it('calls the same map twice into two items; the new item is what is selected, so a call straight after nests under it', async () => {
    const source = fixtureSource();
    const { view, other, source: current, node, select, selected } = await mount();
    await view.callMap(other);
    select('習慣化する');
    await view.callMap(other);
    select('習慣化する');
    await view.callMap(other);
    expect(current()).toBe(source.replace('- 習慣化する\n', `- 習慣化する\n  - ${LINK}\n  - ${LINK}\n- ${LINK}\n`));
    expect(node('習慣化する').children.map(child => child.title)).toEqual([LINK, LINK]);
    expect(projectMap(documentOf(view)).root.children.filter(child => child.title === LINK)).toHaveLength(1);
    // As after Tab, the selection moved to the item just added: the next call goes one level down.
    const [, last] = node('習慣化する').children;
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
    const { view, app, source: current, select, canvas, editor, other, node } = await mount();
    const self = app.asApp<App>().vault.getAbstractFileByPath(PATH) as TFile;
    await expect(view.callMap(self)).rejects.toThrow('自身');
    expect(current()).toBe(source);
    select('記録する');
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
    expect(editor()).not.toBeNull();
    await expect(view.callMap(other)).rejects.toThrow('編集を確定');
    // The guard sits on the shared edit path, so a context-menu add-child under a kept draft is refused the same way.
    const execute = (view as unknown as { execute(command: { type: 'add-child'; nodeId: string }): Promise<void> }).execute.bind(view);
    await expect(execute({ type: 'add-child', nodeId: node('記録する').id })).rejects.toThrow('編集を確定');
    expect(current()).toBe(source);
  });

  it('says so instead of dropping the choice while a save is in flight, and refuses a note whose body is the virtual root', async () => {
    const source = fixtureSource();
    const { view, other, source: current, settle } = await mount();
    const first = view.callMap(other);
    await expect(view.callMap(other)).rejects.toThrow('保存処理');
    await first;
    await settle();
    expect(current()).toBe(source.replace('- 習慣化する\n', `- 習慣化する\n- ${LINK}\n`));
    const headless = '---\nmappy: true\n---\n- 見出しより前の項目\n';
    const bare = await mount(headless);
    await expect(bare.view.callMap(bare.other)).rejects.toThrow('H2');
    expect(bare.source()).toBe(headless);
  });
});
