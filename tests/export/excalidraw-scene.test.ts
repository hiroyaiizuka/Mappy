import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../src/core/markdown';
import {
  IMAGE_GAP, IMAGE_ROW_GAP, buildScene, nodeExtent, sceneContents, type NodeMeasure,
} from '../../src/export/excalidraw-scene';

const SOURCE = [
  '## 講座の構成',
  '',
  '- はじめに',
  '  - この講座で学ぶこと',
  '- **回復する**',
  '  参考: [[睡眠ノート|睡眠]]',
  '  ![[図.png]]',
  '  - 睡眠',
  '',
].join('\n');

function measures(contents: ReturnType<typeof sceneContents>, images = new Map<string, NodeMeasure['images']>()) {
  return new Map(contents.nodes.map(node => [node.id, {
    label: { width: node.role === 'root' ? 140 : 100, height: node.role === 'root' ? 44 : 30 },
    images: images.get(node.id) ?? [],
  }]));
}

describe('sceneContents', () => {
  it('uses the single H2 as visual root and assigns roles by depth', () => {
    const contents = sceneContents(parseMarkdown(SOURCE, 'Note'));
    const byText = new Map(contents.nodes.map(node => [node.text, node]));
    expect(contents.visualRootId).toBe(byText.get('講座の構成')?.id);
    expect(byText.get('講座の構成')?.role).toBe('root');
    expect(byText.get('はじめに')?.role).toBe('stage');
    expect(byText.get('この講座で学ぶこと')?.role).toBe('branch');
    expect(contents.nodes.map(node => node.text)).toEqual(['講座の構成', 'はじめに', 'この講座で学ぶこと', '回復する', '睡眠']);
  });

  it('projects plain text, body links and images per node', () => {
    const contents = sceneContents(parseMarkdown(SOURCE, 'Note'));
    const recover = contents.nodes.find(node => node.text === '回復する');
    expect(recover).toMatchObject({ link: '睡眠ノート', images: ['図.png'] });
    expect(contents.nodes.find(node => node.text === 'はじめに')).toMatchObject({ link: null, images: [] });
  });

  it('prefers the title link over body links', () => {
    const contents = sceneContents(parseMarkdown('## [[A]]\n- [[B]]\n  [[C]]\n', 'Note'));
    expect(contents.nodes.map(node => [node.text, node.link])).toEqual([['A', 'A'], ['B', 'B']]);
  });

  it('shows the file name root when several top-level nodes exist', () => {
    const contents = sceneContents(parseMarkdown('## A\n## B\n', 'Note'));
    expect(contents.nodes[0]).toMatchObject({ id: 'root', role: 'root', text: 'Note' });
    expect(contents.nodes.filter(node => node.role === 'stage').map(node => node.text)).toEqual(['A', 'B']);
  });

  it('grafts the called maps in (§5 M12): the calling item shows the called root\'s text and links to its note, the called nodes read their note', () => {
    const called = parseMarkdown('---\nmappy: true\n---\n## 呼ばれた\n[[参考]]\n- 一\n  ![[絵.png]]\n  - 深い\n- 二\n', 'Called');
    const document = parseMarkdown('## 講座\n- ![[Called]]\n  - 自分の子\n- 葉\n', 'Note');
    const calling = document.nodes.find(node => node.title === '![[Called]]');
    const calls = new Map([[calling?.id ?? '', { path: 'Maps/Called.md', subpath: '', document: called }]]);
    const contents = sceneContents(document, new Set(), calls);
    expect(contents.nodes.map(node => node.text)).toEqual(['講座', '呼ばれた', '一', '深い', '二', '自分の子', '葉']);
    const byText = new Map(contents.nodes.map(node => [node.text, node]));
    // The calling item keeps its own item's body (none here) and links to the called note; its links resolve from the host.
    expect(byText.get('呼ばれた')).toMatchObject({ id: calling?.id, role: 'stage', link: 'Maps/Called.md', images: [] });
    expect(byText.get('呼ばれた')?.sourcePath).toBeUndefined();
    expect(byText.get('一')).toMatchObject({ role: 'branch', link: null, images: ['絵.png'], sourcePath: 'Maps/Called.md' });
    expect(byText.get('自分の子')?.sourcePath).toBeUndefined();
    expect(byText.get('葉')?.sourcePath).toBeUndefined();
    const bare = parseMarkdown('## 講座\n- ![[Called]]\n', 'Note');
    const withoutLink = sceneContents(bare, new Set(), new Map([[bare.nodes[1]?.id ?? '', { path: 'Maps/Called.md', subpath: '', document: parseMarkdown('---\nmappy: true\n---\n## 呼ばれた\n- 一\n', 'Called') }]]));
    expect(withoutLink.nodes.map(node => [node.text, node.link])).toEqual([['講座', null], ['呼ばれた', 'Maps/Called.md'], ['一', null]]);
    // The folds of the view apply to the called nodes by their projected ids.
    const deep = called.nodes.find(node => node.title === '一');
    const folded = sceneContents(document, new Set([`${calling?.id}/${deep?.id}`]), calls);
    expect(folded.nodes.map(node => node.text)).toEqual(['講座', '呼ばれた', '一', '二', '自分の子', '葉']);
    expect(folded.tree.children[0]?.children.map(child => child.children.length)).toEqual([1, 0, 0]);
  });

  it('omits descendants of collapsed nodes but keeps them in the tree', () => {
    const document = parseMarkdown(SOURCE, 'Note');
    const recover = document.nodes.find(node => node.title === '**回復する**');
    const contents = sceneContents(document, new Set([recover?.id ?? '']));
    expect(contents.nodes.map(node => node.text)).toEqual(['講座の構成', 'はじめに', 'この講座で学ぶこと', '回復する']);
    expect(contents.tree.children.map(child => child.children.length)).toEqual([1, 1]);
  });
});

describe('nodeExtent', () => {
  it('stacks a single image row under the label', () => {
    expect(nodeExtent({ label: { width: 100, height: 30 }, images: [] })).toEqual({ width: 100, height: 30 });
    expect(nodeExtent({ label: { width: 100, height: 30 }, images: [{ width: 120, height: 60 }, { width: 50, height: 80 }] }))
      .toEqual({ width: 120 + IMAGE_GAP + 50, height: 30 + IMAGE_ROW_GAP + 80 });
  });
});

describe('buildScene', () => {
  it('places labels at layout positions shifted to the origin, with connectors', () => {
    const contents = sceneContents(parseMarkdown(SOURCE, 'Note'));
    const scene = buildScene(contents, measures(contents), 'mindmap', new Set(), [1000, 500]);
    expect(scene.bounds.x).toBe(1000);
    expect(scene.bounds.y).toBe(500);
    const labels = scene.blocks.filter(block => block.kind === 'label');
    expect(labels).toHaveLength(5);
    const root = labels.find(block => block.nodeId === contents.visualRootId);
    expect(root).toMatchObject({ x: 1000, width: 140, height: 44 });
    expect(Math.min(...labels.map(block => block.y))).toBe(500);
    expect(scene.lines).toHaveLength(4);
    for (const line of scene.lines) {
      expect(line.length).toBeGreaterThanOrEqual(2);
      for (const [x, y] of line) { expect(x).toBeGreaterThanOrEqual(1000); expect(y).toBeGreaterThanOrEqual(500); }
    }
  });

  it('lays images out in a row under the label and widens the node for them', () => {
    const contents = sceneContents(parseMarkdown(SOURCE, 'Note'));
    const recover = contents.nodes.find(node => node.text === '回復する');
    const withImages = measures(contents, new Map([[recover?.id ?? '', [{ width: 180, height: 90 }, { width: 40, height: 20 }]]]));
    const scene = buildScene(contents, withImages, 'mindmap', new Set(), [0, 0]);
    const label = scene.blocks.find(block => block.nodeId === recover?.id && block.kind === 'label');
    const images = scene.blocks.filter(block => block.nodeId === recover?.id && block.kind === 'image');
    expect(label).toBeDefined();
    expect(images.map(image => image.index)).toEqual([0, 1]);
    expect(images[0]).toMatchObject({ x: label?.x, y: (label?.y ?? 0) + 30 + IMAGE_ROW_GAP, width: 180, height: 90 });
    expect(images[1]).toMatchObject({ x: (label?.x ?? 0) + 180 + IMAGE_GAP, width: 40 });
    // The child connector starts after the widened node, never through the image.
    const child = contents.nodes.find(node => node.text === '睡眠');
    const childLabel = scene.blocks.find(block => block.nodeId === child?.id);
    expect((childLabel?.x ?? 0)).toBeGreaterThanOrEqual((label?.x ?? 0) + 180 + IMAGE_GAP + 40);
  });

  it('uses the timeline layout when requested', () => {
    const contents = sceneContents(parseMarkdown(SOURCE, 'Note'));
    const scene = buildScene(contents, measures(contents), 'timeline', new Set(), [0, 0]);
    const stages = scene.blocks.filter(block => contents.nodes.find(node => node.id === block.nodeId)?.role === 'stage');
    expect(new Set(stages.map(stage => stage.y)).size).toBe(1);
    expect(scene.bounds.y).toBe(0);
  });

  it('uses the hierarchy layout when requested: root on top, stages on one row, connectors as polylines', () => {
    const contents = sceneContents(parseMarkdown(SOURCE, 'Note'));
    const scene = buildScene(contents, measures(contents), 'hierarchy', new Set(), [10, 20]);
    const role = (nodeId: string): string | undefined => contents.nodes.find(node => node.id === nodeId)?.role;
    const root = scene.blocks.find(block => role(block.nodeId) === 'root');
    const stages = scene.blocks.filter(block => block.kind === 'label' && role(block.nodeId) === 'stage');
    expect(root && stages.length > 1).toBeTruthy();
    if (!root) return;
    expect(new Set(stages.map(stage => stage.y)).size).toBe(1);
    expect(stages.every(stage => stage.y > root.y + root.height)).toBe(true);
    expect(scene.bounds).toMatchObject({ x: 10, y: 20 });
    expect(root.y).toBe(20);
    for (const line of scene.lines) {
      expect(line.length).toBeGreaterThanOrEqual(2);
      for (let index = 1; index < line.length; index += 1) {
        const [ax, ay] = line[index - 1] ?? [NaN, NaN];
        const [bx, by] = line[index] ?? [NaN, NaN];
        expect(ax === bx || ay === by).toBe(true);
      }
    }
  });

  it('uses the balanced layout when requested: stages on both sides of the root, mirrored connectors as polylines', () => {
    const contents = sceneContents(parseMarkdown(SOURCE, 'Note'));
    const scene = buildScene(contents, measures(contents), 'balanced', new Set(), [10, 20]);
    const role = (nodeId: string): string | undefined => contents.nodes.find(node => node.id === nodeId)?.role;
    const root = scene.blocks.find(block => role(block.nodeId) === 'root');
    const stages = scene.blocks.filter(block => block.kind === 'label' && role(block.nodeId) === 'stage');
    expect(root && stages.length === 2).toBeTruthy();
    if (!root) return;
    const [first, second] = stages;
    // はじめに (first) hangs right of the root, 回復する (second) left, both centred on the root's height.
    expect(first?.x).toBe(root.x + root.width + 80);
    expect((second?.x ?? 0) + (second?.width ?? 0)).toBe(root.x - 80);
    expect(stages.every(stage => stage.y + stage.height / 2 === root.y + root.height / 2)).toBe(true);
    expect(scene.bounds).toMatchObject({ x: 10, y: 20 });
    expect(Math.min(...scene.blocks.map(block => block.x))).toBe(10);
    // The left connector runs from the root's left edge to the stage's right edge; the right one is the map's shape.
    const toSecond = scene.lines.find(line => line[0]?.[0] === root.x);
    const toFirst = scene.lines.find(line => line[0]?.[0] === root.x + root.width);
    expect(toSecond?.[toSecond.length - 1]).toEqual([(second?.x ?? 0) + (second?.width ?? 0), (second?.y ?? 0) + (second?.height ?? 0) / 2]);
    expect(toFirst?.[toFirst.length - 1]).toEqual([first?.x, (first?.y ?? 0) + (first?.height ?? 0) / 2]);
    for (const line of scene.lines) {
      for (let index = 1; index < line.length; index += 1) {
        const [ax, ay] = line[index - 1] ?? [NaN, NaN];
        const [bx, by] = line[index] ?? [NaN, NaN];
        expect(ax === bx || ay === by).toBe(true);
      }
    }
  });

  it('skips nodes without measurements', () => {
    const contents = sceneContents(parseMarkdown(SOURCE, 'Note'));
    const partial = measures(contents);
    partial.delete(contents.nodes[1]?.id ?? '');
    const scene = buildScene(contents, partial, 'mindmap', new Set(), [0, 0]);
    expect(scene.blocks.filter(block => block.kind === 'label')).toHaveLength(4);
  });
});
