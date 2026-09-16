/** The layout depends on tree identity and measurements, never Markdown or DOM. */
export interface LayoutNode {
  readonly id: string;
  readonly children: readonly LayoutNode[];
}

export interface NodeSize {
  width: number;
  height: number;
}

export interface LayoutBounds extends NodeSize {
  x: number;
  y: number;
}

export interface PositionedNode extends LayoutBounds {
  id: string;
}

export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  path: string;
}

export interface FoldPosition {
  id: string;
  x: number;
  y: number;
}

export interface LayoutResult {
  nodes: PositionedNode[];
  edges: LayoutEdge[];
  folds: FoldPosition[];
  bounds: LayoutBounds;
}

interface MeasuredNode extends NodeSize {
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
const DEFAULT_WIDTH = 160;
const DEFAULT_HEIGHT = 44;

/** Shared with the renderer, so numeric badges and their hit areas fit the layout. */
export function foldBadgeWidth(count = 0): number {
  return count > 0 ? Math.max(18, 8 + String(count).length * 7) : 18;
}

export function foldControlSize(count = 0): NodeSize {
  return { width: Math.max(28, foldBadgeWidth(count)), height: 28 };
}

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
  mode: "mindmap" | "timeline",
): MeasuredNode {
  const nodes: MeasuredNode[] = [];
  const seen = new Set<string>();
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
    const foldSize = node.descendantCount > 0 ? foldControlSize(node.children.length === 0 ? node.descendantCount : 0) : null;
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

function connect(parent: PositionedNode, child: PositionedNode, path: string): LayoutEdge {
  return { id: JSON.stringify([parent.id, child.id]), from: parent.id, to: child.id, path };
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

function placeTimeline(
  root: MeasuredNode, nodes: PositionedNode[], edges: LayoutEdge[], folds: FoldPosition[], foldBounds: LayoutBounds[],
): void {
  const rootPosition = { id: root.id, x: 0, y: -root.height / 2, width: root.width, height: root.height };
  nodes.push(rootPosition);
  addFold(root, rootPosition, folds, foldBounds);
  let nextAxisX = root.width + HORIZONTAL_GAP;
  let previousAxisRight = root.width;
  let upperNextX = 0;
  let lowerNextX = 0;
  const axisHalfHeight = root.children.reduce((height, stage) => Math.max(height, stage.height / 2), root.height / 2);
  for (let index = 0; index < root.children.length; index += 1) {
    const stage = root.children[index];
    if (!stage) continue;
    const upper = index % 2 === 0;
    const childOffset = stage.width / 2 + TIMELINE_STEM_GAP;
    const sideNextX = upper ? upperNextX : lowerNextX;
    const stageX = stage.children.length > 0 ? Math.max(nextAxisX, sideNextX - childOffset) : nextAxisX;
    const position = { id: stage.id, x: stageX, y: -stage.height / 2, width: stage.width, height: stage.height };
    nodes.push(position);
    addFold(stage, position, folds, foldBounds, upper);
    // The tree relationship remains root → stage, but each visible axis segment
    // is drawn only once and leaves the topic's text rectangle unobstructed.
    edges.push(connect(rootPosition, position, `M ${previousAxisRight} 0 H ${position.x}`));

    const startY = upper ? position.y : position.y + position.height;
    let childTop = upper
      ? -axisHalfHeight - TIMELINE_AXIS_GAP - childForestHeight(stage)
      : axisHalfHeight + TIMELINE_AXIS_GAP;
    let forestRight = 0;
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

export function layoutTree(
  root: LayoutNode,
  sizes: ReadonlyMap<string, NodeSize>,
  collapsed: ReadonlySet<string>,
  mode: "mindmap" | "timeline",
): LayoutResult {
  const measured = measureTree(root, sizes, collapsed, mode);
  const nodes: PositionedNode[] = [];
  const edges: LayoutEdge[] = [];
  const folds: FoldPosition[] = [];
  const foldBounds: LayoutBounds[] = [];
  if (mode === "timeline") placeTimeline(measured, nodes, edges, folds, foldBounds);
  else placeRightward(measured, 0, 0, nodes, edges, folds, foldBounds);
  return { nodes, edges, folds, bounds: boundsOf([...nodes, ...foldBounds]) };
}
