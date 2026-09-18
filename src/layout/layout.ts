import { placeHierarchy } from "./hierarchy";
import {
  connect, foldBadgeWidth, foldControlFor, foldControlSize,
  type FoldPosition, type LayoutBounds, type LayoutEdge, type NodeSize, type PositionedNode,
} from "./primitives";

export { foldBadgeWidth, foldControlSize } from "./primitives";
export type { FoldPosition, LayoutBounds, LayoutEdge, NodeSize, PositionedNode } from "./primitives";

/** The layout depends on tree identity and measurements, never Markdown or DOM. */
export interface LayoutNode {
  readonly id: string;
  readonly children: readonly LayoutNode[];
}

export interface LayoutPoint {
  x: number;
  y: number;
}

/**
 * mindmap: root on the left, branches to the right. timeline: first level on a
 * horizontal axis, deeper levels alternating above and below. hierarchy: root on
 * top, every depth on one row, branches downward (`./hierarchy`).
 */
export type LayoutMode = "mindmap" | "timeline" | "hierarchy";

/**
 * A free topic: an independent tree placed beside the body. `position` is its root
 * node's top-left relative to the body root's top-left (`LayoutResult.origin`), so a
 * topic follows the body root when the body grows. Null asks for the default slot
 * below the body, clear of every node already placed.
 */
export interface FreeTopicLayout {
  tree: LayoutNode;
  position: LayoutPoint | null;
}

export interface LayoutResult {
  nodes: PositionedNode[];
  edges: LayoutEdge[];
  folds: FoldPosition[];
  /** Body, free topics and fold controls together, for Fit. */
  bounds: LayoutBounds;
  /** Top-left of the body root; free-topic positions are offsets from here. */
  origin: LayoutPoint;
}

/** Tree with sizes resolved and collapsed children removed; `descendantCount` still counts the hidden ones. */
export interface MeasuredNode extends NodeSize {
  id: string;
  children: MeasuredNode[];
  descendantCount: number;
  subtreeWidth: number;
  subtreeHeight: number;
  horizontalGap: number;
  verticalGap: number;
}

const HORIZONTAL_GAP = 32;
const VERTICAL_GAP = 14;
const MAP_ROOT_GAP = 80;
const MAP_BRANCH_GAP = 56;
const MAP_VERTICAL_GAP = 22;
const TIMELINE_GAP = 44;
const TIMELINE_STEM_GAP = 20;
const TIMELINE_AXIS_GAP = 34;
const TIMELINE_FOLD_OFFSET = 12;
const TOPIC_GAP = 48;
const DEFAULT_WIDTH = 160;
const DEFAULT_HEIGHT = 44;

function foldOffset(node: MeasuredNode): number {
  return node.children.length > 0 ? node.horizontalGap / 2 : Math.max(14, foldBadgeWidth(node.descendantCount) / 2 + 4);
}

function dimension(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function measureTree(
  root: LayoutNode,
  sizes: ReadonlyMap<string, NodeSize>,
  collapsed: ReadonlySet<string>,
  mode: LayoutMode,
  seen: Set<string>,
): MeasuredNode {
  const nodes: MeasuredNode[] = [];
  const pending: { source: LayoutNode; parent: MeasuredNode | null }[] = [{ source: root, parent: null }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const { source, parent } = current;
    if (seen.has(source.id)) throw new Error(`Duplicate layout node ID: ${source.id}`);
    seen.add(source.id);
    const size = sizes.get(source.id);
    const measured: MeasuredNode = {
      id: source.id,
      width: dimension(size?.width, DEFAULT_WIDTH),
      height: dimension(size?.height, DEFAULT_HEIGHT),
      children: [],
      descendantCount: 0,
      subtreeWidth: 0,
      subtreeHeight: 0,
      horizontalGap: mode === "timeline" ? HORIZONTAL_GAP : parent ? MAP_BRANCH_GAP : MAP_ROOT_GAP,
      verticalGap: mode === "timeline" ? VERTICAL_GAP : MAP_VERTICAL_GAP,
    };
    nodes.push(measured);
    parent?.children.push(measured);
    for (let index = source.children.length - 1; index >= 0; index -= 1) {
      const child = source.children[index];
      if (child) pending.push({ source: child, parent: measured });
    }
  }

  // Reverse preorder makes every descendant available before its parent.
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (!node) continue;
    // Count the original tree before hiding descendants, retaining folded controls.
    node.descendantCount = node.children.reduce((count, child) => count + child.descendantCount + 1, 0);
    if (collapsed.has(node.id)) node.children = [];
    let childWidth = 0;
    let childHeight = 0;
    for (const child of node.children) {
      childWidth = Math.max(childWidth, child.subtreeWidth);
      childHeight += child.subtreeHeight;
    }
    if (node.children.length > 1) childHeight += (node.children.length - 1) * node.verticalGap;
    const foldSize = foldControlFor(node);
    const foldExtent = foldSize ? foldOffset(node) + foldSize.width / 2 : 0;
    node.subtreeHeight = Math.max(node.height, childHeight, foldSize?.height ?? 0);
    node.subtreeWidth = node.width + Math.max(foldExtent, node.children.length > 0 ? node.horizontalGap + childWidth : 0);
  }
  const measuredRoot = nodes[0];
  if (!measuredRoot) throw new Error("A layout requires a root node.");
  return measuredRoot;
}

function place(node: MeasuredNode, x: number, top: number): PositionedNode {
  return { id: node.id, x, y: top + (node.subtreeHeight - node.height) / 2, width: node.width, height: node.height };
}

function addFold(
  node: MeasuredNode,
  position: PositionedNode,
  folds: FoldPosition[],
  bounds: LayoutBounds[],
  upperStage?: boolean,
): void {
  if (node.descendantCount === 0) return;
  const collapsed = node.children.length === 0;
  const size = foldControlSize(collapsed ? node.descendantCount : 0);
  const fold: FoldPosition = upperStage === undefined
    ? { id: node.id, x: position.x + position.width + foldOffset(node), y: position.y + position.height / 2 }
    : {
      id: node.id,
      x: position.x + position.width / 2,
      y: collapsed || upperStage ? position.y - TIMELINE_FOLD_OFFSET : position.y + position.height + TIMELINE_FOLD_OFFSET,
    };
  folds.push(fold);
  bounds.push({ x: fold.x - size.width / 2, y: fold.y - size.height / 2, ...size });
}

function rightwardEdge(parent: PositionedNode, child: PositionedNode): LayoutEdge {
  const startX = parent.x + parent.width;
  const startY = parent.y + parent.height / 2;
  const endX = child.x;
  const endY = child.y + child.height / 2;
  const middleX = (startX + endX) / 2;
  const branch = `M ${startX} ${startY} H ${middleX} V ${endY} H ${endX}`;
  return connect(parent, child, branch);
}

function childForestHeight(node: MeasuredNode): number {
  return node.children.reduce((height, child) => height + child.subtreeHeight, 0)
    + Math.max(0, node.children.length - 1) * node.verticalGap;
}

function placeRightward(
  root: MeasuredNode,
  x: number,
  top: number,
  nodes: PositionedNode[],
  edges: LayoutEdge[],
  folds: FoldPosition[],
  foldBounds: LayoutBounds[],
): void {
  const pending = [{ node: root, x, top }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const position = place(current.node, current.x, current.top);
    nodes.push(position);
    addFold(current.node, position, folds, foldBounds);
    let childTop = current.top + (current.node.subtreeHeight - childForestHeight(current.node)) / 2;
    const children: typeof pending = [];
    for (const child of current.node.children) {
      const childX = current.x + current.node.width + current.node.horizontalGap;
      edges.push(rightwardEdge(position, place(child, childX, childTop)));
      children.push({ node: child, x: childX, top: childTop });
      childTop += child.subtreeHeight + current.node.verticalGap;
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) pending.push(child);
    }
  }
}

/** Root's top-left at (x, y); the axis runs through the root's vertical center. */
function placeTimeline(
  root: MeasuredNode, x: number, y: number,
  nodes: PositionedNode[], edges: LayoutEdge[], folds: FoldPosition[], foldBounds: LayoutBounds[],
): void {
  const axisY = y + root.height / 2;
  const rootPosition = { id: root.id, x, y, width: root.width, height: root.height };
  nodes.push(rootPosition);
  addFold(root, rootPosition, folds, foldBounds);
  let nextAxisX = x + root.width + HORIZONTAL_GAP;
  let previousAxisRight = x + root.width;
  let upperNextX = -Infinity;
  let lowerNextX = -Infinity;
  const axisHalfHeight = root.children.reduce((height, stage) => Math.max(height, stage.height / 2), root.height / 2);
  for (let index = 0; index < root.children.length; index += 1) {
    const stage = root.children[index];
    if (!stage) continue;
    const upper = index % 2 === 0;
    const childOffset = stage.width / 2 + TIMELINE_STEM_GAP;
    const sideNextX = upper ? upperNextX : lowerNextX;
    const stageX = stage.children.length > 0 ? Math.max(nextAxisX, sideNextX - childOffset) : nextAxisX;
    const position = { id: stage.id, x: stageX, y: axisY - stage.height / 2, width: stage.width, height: stage.height };
    nodes.push(position);
    addFold(stage, position, folds, foldBounds, upper);
    // The tree relationship remains root → stage, but each visible axis segment
    // is drawn only once and leaves the topic's text rectangle unobstructed.
    edges.push(connect(rootPosition, position, `M ${previousAxisRight} ${axisY} H ${position.x}`));

    const startY = upper ? position.y : position.y + position.height;
    let childTop = upper
      ? axisY - axisHalfHeight - TIMELINE_AXIS_GAP - childForestHeight(stage)
      : axisY + axisHalfHeight + TIMELINE_AXIS_GAP;
    let forestRight = -Infinity;
    for (const child of stage.children) {
      const childX = stageX + childOffset;
      const childPosition = place(child, childX, childTop);
      const startX = position.x + position.width / 2;
      const endY = childPosition.y + childPosition.height / 2;
      edges.push(connect(position, childPosition, `M ${startX} ${startY} V ${endY} H ${childX}`));
      placeRightward(child, childX, childTop, nodes, edges, folds, foldBounds);
      forestRight = Math.max(forestRight, childX + child.subtreeWidth);
      childTop += child.subtreeHeight + VERTICAL_GAP;
    }
    // Opposite sides can reuse horizontal space. Only forests on the same side
    // reserve an exclusive span, including clearance for the next vertical stem.
    if (stage.children.length > 0) {
      if (upper) upperNextX = forestRight + TIMELINE_GAP;
      else lowerNextX = forestRight + TIMELINE_GAP;
    }
    previousAxisRight = position.x + position.width;
    nextAxisX = previousAxisRight + HORIZONTAL_GAP;
  }
}

function boundsOf(nodes: readonly LayoutBounds[]): LayoutBounds {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const node of nodes) {
    left = Math.min(left, node.x);
    top = Math.min(top, node.y);
    right = Math.max(right, node.x + node.width);
    bottom = Math.max(bottom, node.y + node.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

interface PlacedTree {
  nodes: PositionedNode[];
  edges: LayoutEdge[];
  folds: FoldPosition[];
  foldBounds: LayoutBounds[];
  /** Nodes and fold controls together. */
  bounds: LayoutBounds;
}

/** Place one measured tree with its root's top-left at (x, y). */
function placeTree(tree: MeasuredNode, x: number, y: number, mode: LayoutMode): PlacedTree {
  const nodes: PositionedNode[] = [];
  const edges: LayoutEdge[] = [];
  const folds: FoldPosition[] = [];
  const foldBounds: LayoutBounds[] = [];
  if (mode === "timeline") placeTimeline(tree, x, y, nodes, edges, folds, foldBounds);
  else if (mode === "hierarchy") placeHierarchy(tree, x, y, nodes, edges, folds, foldBounds);
  else placeRightward(tree, x, y - (tree.subtreeHeight - tree.height) / 2, nodes, edges, folds, foldBounds);
  return { nodes, edges, folds, foldBounds, bounds: boundsOf([...nodes, ...foldBounds]) };
}

function intersects(first: LayoutBounds, second: LayoutBounds): boolean {
  return first.x < second.x + second.width && first.x + first.width > second.x
    && first.y < second.y + second.height && first.y + first.height > second.y;
}

/** The nearest slot below the body, in the column starting at `x`, that no placed rectangle touches. */
function defaultSlot(size: NodeSize, x: number, body: LayoutBounds, occupied: readonly LayoutBounds[]): LayoutPoint {
  // Only the probe's extent matters here; its own x/y (nonzero when the root is centered) must not leak into the slot.
  const slot = { x, y: body.y + body.height + TOPIC_GAP, width: size.width, height: size.height };
  for (let guard = 0; guard <= occupied.length; guard += 1) {
    const blocker = occupied.find((area) => intersects(slot, area));
    if (!blocker) break;
    slot.y = blocker.y + blocker.height + TOPIC_GAP;
  }
  return { x: slot.x, y: slot.y };
}

/**
 * Lay out the body at the origin and each free topic as its own tree of the same mode.
 * Positioned topics land where asked, even over other nodes; the rest stack under the
 * body in source order, each in the first slot clear of everything placed before it:
 * flush with the body's left edge, or centered under the root in the hierarchy, whose
 * left edge can be a far-off leaf of its widest row.
 */
export function layoutTree(
  root: LayoutNode,
  sizes: ReadonlyMap<string, NodeSize>,
  collapsed: ReadonlySet<string>,
  mode: LayoutMode,
  topics: readonly FreeTopicLayout[] = [],
): LayoutResult {
  const seen = new Set<string>();
  const measured = measureTree(root, sizes, collapsed, mode, seen);
  // The map's forest starts at y = 0, the timeline axis runs through y = 0, and the
  // hierarchy's root is centered on x = 0.
  const origin = mode === "hierarchy"
    ? { x: -measured.width / 2, y: 0 }
    : { x: 0, y: mode === "timeline" ? -measured.height / 2 : (measured.subtreeHeight - measured.height) / 2 };
  const body = placeTree(measured, origin.x, origin.y, mode);
  const placed: (PlacedTree | undefined)[] = [];
  const occupied = [body.bounds];
  const measuredTopics = topics.map((topic) => measureTree(topic.tree, sizes, collapsed, mode, seen));
  measuredTopics.forEach((tree, index) => {
    const position = topics[index]?.position;
    if (!position) return;
    const result = placeTree(tree, origin.x + position.x, origin.y + position.y, mode);
    placed[index] = result;
    occupied.push(result.bounds);
  });
  measuredTopics.forEach((tree, index) => {
    if (placed[index]) return;
    // Measure once at the origin, then move the whole extent (fold controls included) into the slot.
    const probe = placeTree(tree, 0, 0, mode);
    const column = mode === "hierarchy" ? origin.x + (measured.width - probe.bounds.width) / 2 : body.bounds.x;
    const slot = defaultSlot(probe.bounds, column, body.bounds, occupied);
    const result = placeTree(tree, slot.x - probe.bounds.x, slot.y - probe.bounds.y, mode);
    placed[index] = result;
    occupied.push(result.bounds);
  });
  const trees = [body, ...placed.filter((tree): tree is PlacedTree => tree !== undefined)];
  return {
    nodes: trees.flatMap((tree) => tree.nodes),
    edges: trees.flatMap((tree) => tree.edges),
    folds: trees.flatMap((tree) => tree.folds),
    bounds: boundsOf(trees.flatMap((tree) => [...tree.nodes, ...tree.foldBounds])),
    origin,
  };
}
