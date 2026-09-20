import { placeHierarchy } from "./hierarchy";
import type { LayoutMode } from "../core/layout-mode";
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

/** The mode vocabulary is core's (`../core/layout-mode`); re-exported so layout callers need one import. */
export { LAYOUT_LABELS, LAYOUT_MODES, isLayoutMode, type LayoutMode } from "../core/layout-mode";

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
/** How far right of a stage's centre its forest starts; exported so the snap zones can score by the landing column. */
export const TIMELINE_STEM_GAP = 20;
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

/** The side of a node its branches grow on: the map grows right, the balanced map right or left. */
type Side = "right" | "left";

/** Where a node's fold control sits: on the stem to its side, or above/below a timeline stage. */
type FoldSide = Side | "upper" | "lower";

function addFold(
  node: MeasuredNode,
  position: PositionedNode,
  folds: FoldPosition[],
  bounds: LayoutBounds[],
  side: FoldSide = "right",
): void {
  if (node.descendantCount === 0) return;
  const collapsed = node.children.length === 0;
  const size = foldControlSize(collapsed ? node.descendantCount : 0);
  const fold: FoldPosition = side === "right" || side === "left"
    ? {
      id: node.id,
      x: side === "right" ? position.x + position.width + foldOffset(node) : position.x - foldOffset(node),
      y: position.y + position.height / 2,
    }
    : {
      id: node.id,
      x: position.x + position.width / 2,
      y: collapsed || side === "upper" ? position.y - TIMELINE_FOLD_OFFSET : position.y + position.height + TIMELINE_FOLD_OFFSET,
    };
  folds.push(fold);
  bounds.push({ x: fold.x - size.width / 2, y: fold.y - size.height / 2, ...size });
}

/** Stem, bend and branch between the facing edges of parent and child; growing left is the mirror image. */
function sidewaysEdge(parent: PositionedNode, child: PositionedNode, side: Side): LayoutEdge {
  const startX = side === "right" ? parent.x + parent.width : parent.x;
  const startY = parent.y + parent.height / 2;
  const endX = side === "right" ? child.x : child.x + child.width;
  const endY = child.y + child.height / 2;
  const middleX = (startX + endX) / 2;
  const branch = `M ${startX} ${startY} H ${middleX} V ${endY} H ${endX}`;
  return connect(parent, child, branch);
}

function forestHeight(children: readonly MeasuredNode[], gap: number): number {
  return children.reduce((height, child) => height + child.subtreeHeight, 0) + Math.max(0, children.length - 1) * gap;
}

function childForestHeight(node: MeasuredNode): number {
  return forestHeight(node.children, node.verticalGap);
}

/** Top-left of a node whose near edge (left when growing right, right when growing left) is at `edge`. */
function placeBeside(node: MeasuredNode, edge: number, top: number, side: Side): PositionedNode {
  return place(node, side === "right" ? edge : edge - node.width, top);
}

/**
 * Place `root` and its forest growing to `side`, the root's near edge at `edge` and the
 * subtree's top at `top`. Growing left mirrors the map's geometry: children hang one gap
 * past the parent's left edge with their right edges aligned, and the fold control sits
 * on the stem to the left.
 */
function placeSideways(
  root: MeasuredNode,
  edge: number,
  top: number,
  side: Side,
  nodes: PositionedNode[],
  edges: LayoutEdge[],
  folds: FoldPosition[],
  foldBounds: LayoutBounds[],
): void {
  const pending = [{ node: root, edge, top }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const position = placeBeside(current.node, current.edge, current.top, side);
    nodes.push(position);
    addFold(current.node, position, folds, foldBounds, side);
    let childTop = current.top + (current.node.subtreeHeight - childForestHeight(current.node)) / 2;
    const childEdge = side === "right"
      ? position.x + current.node.width + current.node.horizontalGap
      : position.x - current.node.horizontalGap;
    const children: typeof pending = [];
    for (const child of current.node.children) {
      edges.push(sidewaysEdge(position, placeBeside(child, childEdge, childTop, side), side));
      children.push({ node: child, edge: childEdge, top: childTop });
      childTop += child.subtreeHeight + current.node.verticalGap;
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) pending.push(child);
    }
  }
}

/** The side a first-level child of the balanced map grows on: the first child right, the next left, and so on. */
export function balancedSide(index: number): Side {
  return index % 2 === 0 ? "right" : "left";
}

/**
 * Balanced map: root's top-left at (x, y), the first level dealt to its right and left in
 * source order (`balancedSide`), every deeper node growing on its branch's side. Each side is
 * a column of subtrees centred on the root, so a side is only as tall as its own branches.
 * The root's fold control sits on the right stem, where its first child hangs.
 */
function placeBalanced(
  root: MeasuredNode, x: number, y: number,
  nodes: PositionedNode[], edges: LayoutEdge[], folds: FoldPosition[], foldBounds: LayoutBounds[],
): void {
  const rootPosition = { id: root.id, x, y, width: root.width, height: root.height };
  nodes.push(rootPosition);
  addFold(root, rootPosition, folds, foldBounds, "right");
  const columns: Record<Side, MeasuredNode[]> = { right: [], left: [] };
  root.children.forEach((child, index) => { columns[balancedSide(index)].push(child); });
  const centreY = y + root.height / 2;
  const tops: Record<Side, number> = {
    right: centreY - forestHeight(columns.right, root.verticalGap) / 2,
    left: centreY - forestHeight(columns.left, root.verticalGap) / 2,
  };
  const edgeOf: Record<Side, number> = { right: x + root.width + root.horizontalGap, left: x - root.horizontalGap };
  root.children.forEach((child, index) => {
    const side = balancedSide(index);
    const top = tops[side];
    edges.push(sidewaysEdge(rootPosition, placeBeside(child, edgeOf[side], top, side), side));
    placeSideways(child, edgeOf[side], top, side, nodes, edges, folds, foldBounds);
    tops[side] = top + child.subtreeHeight + root.verticalGap;
  });
}

/**
 * Half the height of the band a timeline keeps clear around its axis: the root and the stages are
 * centred on the axis, and every forest starts one axis gap past the tallest of them, so a short stage
 * beside a tall one hangs its children where the tall one does. Shared with the snap zones, which
 * measure a childless stage's slot from the band's edge.
 */
export function axisBand(root: NodeSize, stages: readonly NodeSize[]): number {
  return stages.reduce((height, stage) => Math.max(height, stage.height / 2), root.height / 2);
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
  const axisHalfHeight = axisBand(root, root.children);
  for (let index = 0; index < root.children.length; index += 1) {
    const stage = root.children[index];
    if (!stage) continue;
    const upper = index % 2 === 0;
    const childOffset = stage.width / 2 + TIMELINE_STEM_GAP;
    const sideNextX = upper ? upperNextX : lowerNextX;
    const stageX = stage.children.length > 0 ? Math.max(nextAxisX, sideNextX - childOffset) : nextAxisX;
    const position = { id: stage.id, x: stageX, y: axisY - stage.height / 2, width: stage.width, height: stage.height };
    nodes.push(position);
    addFold(stage, position, folds, foldBounds, upper ? "upper" : "lower");
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
      placeSideways(child, childX, childTop, "right", nodes, edges, folds, foldBounds);
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
  else if (mode === "balanced") placeBalanced(tree, x, y, nodes, edges, folds, foldBounds);
  else placeSideways(tree, x, y - (tree.subtreeHeight - tree.height) / 2, "right", nodes, edges, folds, foldBounds);
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
 * flush with the body's left edge, or centered under the root in the hierarchy and the
 * balanced map, whose left edge can be a far-off leaf of the widest row or of the left side.
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
  // The map's forest starts at y = 0, the timeline axis runs through y = 0, the
  // hierarchy's root is centered on x = 0, and the balanced map's root on (0, 0).
  const origin = mode === "hierarchy"
    ? { x: -measured.width / 2, y: 0 }
    : mode === "balanced"
      ? { x: -measured.width / 2, y: -measured.height / 2 }
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
    const column = mode === "hierarchy" || mode === "balanced" ? origin.x + (measured.width - probe.bounds.width) / 2 : body.bounds.x;
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
