// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, WorkspaceLeaf as ObsidianLeaf, ViewStateResult } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { WorkspaceLeaf } from '../../harness/browser/obsidian';
import { findFixture } from '../../harness/browser/fixtures';
import { planEdit, type MoveCommand } from '../../src/core/commands';
import { projectMap, type MindDocument } from '../../src/core/markdown';
import { readTopicPositions } from '../../src/core/topics';
import { PLACEHOLDER_ID } from '../../src/layout/drop-preview';
import type { LayoutResult } from '../../src/layout/layout';
import { DocumentStore } from '../../src/obsidian/document-store';
import type { ViewRouter } from '../../src/obsidian/view-routing';
import { MindmapView } from '../../src/ui/mindmap-view';

// The browser-harness stand-in for `obsidian`, so the shipped view, renderer and store run against a real DOM.
vi.mock('obsidian', () => import('../../harness/browser/obsidian'));

beforeAll(() => { installObsidianDom(); });
afterEach(() => { document.body.replaceChildren(); });

const PATH = 'Fixtures/free-topics.md';

function fixtureSource(): string {
  const fixture = findFixture('free-topics');
  if (!fixture) throw new Error('Missing free-topics fixture');
  return fixture.source;
}

/** The view's own parse, whose node IDs the DOM carries. */
function documentOf(view: MindmapView): MindDocument {
  const document = view.snapshot()?.document;
  if (!document) throw new Error('The view has not parsed its note');
  return document;
}

interface Mounted {
  app: HarnessApp;
  view: MindmapView;
  layout: () => LayoutResult;
  transform: (id: string) => { x: number; y: number };
  nodes: () => Map<string, HTMLElement>;
}

async function mount(source: string, layout: 'mindmap' | 'timeline' = 'mindmap'): Promise<Mounted> {
  const app = new HarnessApp();
  app.put(PATH, source);
  const leaf = new WorkspaceLeaf(app.asApp<App>());
  const view = new MindmapView(leaf as unknown as ObsidianLeaf, new DocumentStore(app.asApp<App>()), {} as ViewRouter);
  leaf.view = view as unknown as WorkspaceLeaf['view'];
  document.body.append(view.containerEl);
  view.load();
  await view.onOpen();
  await view.setState({ file: PATH, layout }, { history: false } satisfies ViewStateResult);
  await new Promise(resolve => requestAnimationFrame(resolve));
  const nodes = (): Map<string, HTMLElement> => new Map(Array.from(
    view.containerEl.querySelectorAll<HTMLElement>('.mappy-node'), node => [node.dataset.nodeId ?? '', node],
  ));
  return {
    app, view, nodes,
    layout: () => {
      const result = (view as unknown as { layout: LayoutResult | undefined }).layout;
      if (!result) throw new Error('Layout has not run');
      return result;
    },
    transform: (id) => {
      const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/u.exec(nodes().get(id)?.style.transform ?? '');
      if (!match) throw new Error(`No transform for ${id}`);
      return { x: Number(match[1]), y: Number(match[2]) };
    },
  };
}

describe('MindmapView with free topics', () => {
  it('shows the first H2 as the body root and every later H2 as a topic root, each styled as a root of its own tree', async () => {
    const source = fixtureSource();
    const { view, nodes } = await mount(source);
    const doc = documentOf(view);
    const { root, topics } = projectMap(doc);
    const byTitle = new Map(doc.nodes.map(node => [node.title, node.id]));
    const elements = nodes();
    expect(elements.has('root')).toBe(false);
    expect(elements.get(byTitle.get('講座の本体') ?? '')?.classList.contains('is-root')).toBe(true);
    expect(elements.get(byTitle.get('講座の本体') ?? '')?.classList.contains('is-topic')).toBe(false);
    for (const topic of topics) {
      const element = elements.get(topic.id);
      expect(element?.classList.contains('is-root')).toBe(true);
      expect(element?.classList.contains('is-topic')).toBe(true);
      expect(element?.classList.contains('is-stage')).toBe(false);
      for (const child of topic.children) expect(elements.get(child.id)?.classList.contains('is-stage')).toBe(true);
    }
    expect(elements.get(byTitle.get('回復する') ?? '')?.classList.contains('is-stage')).toBe(true);
    expect(elements.size).toBe(doc.nodes.length);
    expect(root.id).toBe(byTitle.get('講座の本体'));
    expect(view.snapshot()?.document?.source).toBe(source);
  });

  it.each(['mindmap', 'timeline'] as const)('places positioned topics at origin + stored offset and the unpositioned one below the body in %s', async mode => {
    const source = fixtureSource();
    const { view, layout, transform } = await mount(source, mode);
    const doc = documentOf(view);
    const positions = readTopicPositions(source);
    const { root, topics } = projectMap(doc);
    const result = layout();
    const [reference, glossary, unplaced] = topics;
    if (!reference || !glossary || !unplaced) throw new Error('Missing topics');
    expect(transform(root.id)).toEqual({ x: result.origin.x, y: result.origin.y });
    const stored = positions.get('参考資料')?.[mode];
    expect(stored).toBeDefined();
    if (stored) expect(transform(reference.id)).toEqual({ x: result.origin.x + stored.x, y: result.origin.y + stored.y });
    const bodyIds = new Set(doc.nodes.filter(node => node.from >= root.from && node.from < root.to).map(node => node.id));
    const bodyNodes = result.nodes.filter(node => bodyIds.has(node.id));
    const bodyBottom = Math.max(...bodyNodes.map(node => node.y + node.height));
    const quoted = positions.get('補足: 用語')?.[mode];
    if (quoted) expect(transform(glossary.id)).toEqual({ x: result.origin.x + quoted.x, y: result.origin.y + quoted.y });
    else expect(transform(glossary.id).y).toBeGreaterThan(bodyBottom);
    expect(transform(unplaced.id).y).toBeGreaterThan(bodyBottom);
    expect(transform(unplaced.id).x).toBe(Math.min(...bodyNodes.map(node => node.x)));
    // Fit bounds cover every topic, so 全体表示 shows the whole map.
    for (const node of result.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(result.bounds.x);
      expect(node.y + node.height).toBeLessThanOrEqual(result.bounds.y + result.bounds.height);
    }
  });

  it('keeps the virtual root only for documents that do not start with a heading section', async () => {
    const withTopics = '---\nmappy: true\n---\n## One\n- A\n\n## Two\n- B\n';
    const mounted = await mount(withTopics);
    const doc = documentOf(mounted.view);
    expect(mounted.nodes().has('root')).toBe(false);
    expect(mounted.nodes().get(doc.nodes[0]?.id ?? '')?.classList.contains('is-root')).toBe(true);
    expect(mounted.nodes().get(doc.nodes.find(node => node.title === 'Two')?.id ?? '')?.classList.contains('is-topic')).toBe(true);
    document.body.replaceChildren();
    const lists = await mount('- Only\n- Lists\n');
    expect(lists.nodes().get('root')?.classList.contains('is-root')).toBe(true);
    expect(lists.nodes().size).toBe(3);
    document.body.replaceChildren();
    const leadingSource = '- Before\n\n## One\n- A\n';
    const leading = await mount(leadingSource);
    const one = documentOf(leading.view).nodes.find(node => node.title === 'One')?.id;
    expect(leading.nodes().get('root')?.classList.contains('is-root')).toBe(true);
    expect(leading.nodes().get(one ?? '')?.classList.contains('is-topic')).toBe(true);
    expect(leading.layout().edges.some(edge => edge.from === 'root' && edge.to === one)).toBe(false);
    expect(leading.layout().nodes.map(node => node.id).sort()).toEqual(['root', ...documentOf(leading.view).nodes.map(node => node.id)].sort());
  });

  it('previews a drop inside a topic within that topic\'s tree and a drop inside the body within the body', async () => {
    const source = fixtureSource();
    const { view, layout, transform } = await mount(source);
    const doc = documentOf(view);
    const { root, topics } = projectMap(doc);
    const dragged = doc.nodes.find(node => node.title === '習慣化する');
    const glossary = topics[1];
    if (!dragged || !glossary) throw new Error('Missing fixture nodes');
    const preview = async (parentId: string): Promise<LayoutResult> => {
      (view as unknown as { previewDrop(command: MoveCommand | null): void }).previewDrop({ type: 'move', nodeId: dragged.id, parentId, index: 0 });
      await new Promise(resolve => requestAnimationFrame(resolve));
      return layout();
    };
    const intoTopic = await preview(glossary.id);
    const slot = intoTopic.nodes.find(node => node.id === PLACEHOLDER_ID);
    expect(slot).toBeDefined();
    expect(intoTopic.edges.some(edge => edge.from === glossary.id && edge.to === PLACEHOLDER_ID)).toBe(true);
    expect(transform(glossary.id)).toEqual({ x: intoTopic.origin.x + 560, y: intoTopic.origin.y - 140 });
    expect(slot && slot.x).toBeGreaterThan(transform(glossary.id).x);
    const intoBody = await preview(root.id);
    expect(intoBody.edges.some(edge => edge.from === root.id && edge.to === PLACEHOLDER_ID)).toBe(true);
    expect(intoBody.edges.some(edge => edge.from === glossary.id && edge.to === PLACEHOLDER_ID)).toBe(false);
    (view as unknown as { previewDrop(command: MoveCommand | null): void }).previewDrop(null);
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(layout().nodes.some(node => node.id === PLACEHOLDER_ID)).toBe(false);
  });

  it('renames a topic through the view and keeps its stored position under the new heading', async () => {
    const source = fixtureSource();
    const { app, view } = await mount(source);
    const doc = documentOf(view);
    const topic = doc.nodes.find(node => node.title === '参考資料');
    if (!topic) throw new Error('Missing topic');
    const plan = planEdit(doc, { type: 'rename', nodeId: topic.id, title: '資料: 参考' });
    await (view as unknown as { commit(source: string, edits: typeof plan.edits): Promise<void> }).commit(doc.source, plan.edits);
    const file = app.asApp<App>().vault.getAbstractFileByPath(PATH);
    const updated = app.content(file as never);
    expect(updated).toContain('\n  "資料: 参考": { mindmap: [-360, 200], timeline: [0, 260] }\n');
    expect(updated).not.toContain('参考資料');
    expect(updated.slice(updated.indexOf('## 講座の本体'), updated.indexOf('## 資料: 参考')))
      .toBe(source.slice(source.indexOf('## 講座の本体'), source.indexOf('## 参考資料')));
    expect(readTopicPositions(updated).get('資料: 参考')).toEqual({ mindmap: { x: -360, y: 200 }, timeline: { x: 0, y: 260 } });
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(view.snapshot()?.document?.source).toBe(updated);
  });
});
