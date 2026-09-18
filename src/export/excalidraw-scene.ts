import type { MindDocument, MindNode } from '../core/markdown';
import { nodeBody } from '../core/body';
import { attachmentEntries } from '../core/attachments';
import { plainTitle } from '../core/plain-text';
import { layoutTree, type LayoutBounds, type LayoutMode, type LayoutNode, type NodeSize } from '../layout/layout';
import { pathToPoints, type Point } from '../layout/path-points';

export type NodeRole = 'root' | 'stage' | 'branch';

/** What each visible node shows, independent of any drawing API. */
export interface SceneNodeContent {
  id: string;
  role: NodeRole;
  text: string;
  /** First link of the title, else of the body; the node becomes clickable. */
  link: string | null;
  /** Image targets as written in the body, in order. */
  images: string[];
}

export interface SceneContents {
  visualRootId: string;
  tree: LayoutNode;
  nodes: SceneNodeContent[];
}

/** Measured label (including any box padding) and image sizes for a node. */
export interface NodeMeasure {
  label: NodeSize;
  images: NodeSize[];
}

export interface SceneBlock extends NodeSize {
  nodeId: string;
  kind: 'label' | 'image';
  /** Position within the node's image row; 0 for labels. */
  index: number;
  x: number;
  y: number;
}

export interface ExcalidrawScene {
  blocks: SceneBlock[];
  lines: Point[][];
  bounds: LayoutBounds;
}

export const IMAGE_GAP = 8;
export const IMAGE_ROW_GAP = 6;

function visualRoot(document: MindDocument): MindNode {
  const root = document.root;
  return root.children.length === 1 ? root.children[0] ?? root : root;
}

function layoutNode(node: MindNode): LayoutNode {
  return { id: node.id, children: node.children.map(layoutNode) };
}

/** Project the parsed document onto roles, plain text, links and images. */
export function sceneContents(document: MindDocument, collapsed: ReadonlySet<string> = new Set()): SceneContents {
  const root = visualRoot(document);
  const nodes: SceneNodeContent[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) break;
    const title = plainTitle(node.title);
    const entries = attachmentEntries(nodeBody(document, node));
    const bodyLink = entries.find(entry => entry.kind === 'link')?.target ?? null;
    nodes.push({
      id: node.id,
      role: node.id === root.id ? 'root' : node.parentId === root.id ? 'stage' : 'branch',
      text: title.text,
      link: title.link ?? bodyLink,
      images: entries.filter(entry => entry.kind === 'image').map(entry => entry.target),
    });
    if (!collapsed.has(node.id)) pending.push(...[...node.children].reverse());
  }
  return { visualRootId: root.id, tree: layoutNode(root), nodes };
}

/** Full node extent: label above a single row of images, as the map view stacks them. */
export function nodeExtent(measure: NodeMeasure): NodeSize {
  const row = imageRow(measure.images);
  return {
    width: Math.max(measure.label.width, row.width),
    height: measure.label.height + (row.height > 0 ? IMAGE_ROW_GAP + row.height : 0),
  };
}

function imageRow(images: readonly NodeSize[]): NodeSize {
  if (images.length === 0) return { width: 0, height: 0 };
  const width = images.reduce((sum, image) => sum + image.width, 0) + (images.length - 1) * IMAGE_GAP;
  const height = images.reduce((max, image) => Math.max(max, image.height), 0);
  return { width, height };
}

/** Place every block and connector; coordinates start at `origin` (top-left of the map). */
export function buildScene(
  contents: SceneContents,
  measures: ReadonlyMap<string, NodeMeasure>,
  mode: LayoutMode,
  collapsed: ReadonlySet<string>,
  origin: Point,
): ExcalidrawScene {
  const sizes = new Map<string, NodeSize>();
  for (const node of contents.nodes) {
    const measure = measures.get(node.id);
    if (measure) sizes.set(node.id, nodeExtent(measure));
  }
  const layout = layoutTree(contents.tree, sizes, collapsed, mode);
  const dx = origin[0] - layout.bounds.x;
  const dy = origin[1] - layout.bounds.y;
  const blocks: SceneBlock[] = [];
  for (const positioned of layout.nodes) {
    const measure = measures.get(positioned.id);
    if (!measure) continue;
    const x = positioned.x + dx;
    const y = positioned.y + dy;
    blocks.push({ nodeId: positioned.id, kind: 'label', index: 0, x, y, ...measure.label });
    let imageX = x;
    const imageY = y + measure.label.height + IMAGE_ROW_GAP;
    measure.images.forEach((image, index) => {
      blocks.push({ nodeId: positioned.id, kind: 'image', index, x: imageX, y: imageY, ...image });
      imageX += image.width + IMAGE_GAP;
    });
  }
  const lines = layout.edges.map(edge => pathToPoints(edge.path).map(([x, y]): Point => [x + dx, y + dy]));
  return {
    blocks,
    lines,
    bounds: { x: origin[0], y: origin[1], width: layout.bounds.width, height: layout.bounds.height },
  };
}
