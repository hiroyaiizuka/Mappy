/**
 * Pieces every layout mode and the renderer share: node/edge/fold shapes, fold
 * control sizing and edge identity. Kept apart from layout.ts so the per-mode
 * modules can import them without a cycle.
 */
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

/** Shared with the renderer, so numeric badges and their hit areas fit the layout. */
export function foldBadgeWidth(count = 0): number {
  return count > 0 ? Math.max(18, 8 + String(count).length * 7) : 18;
}

export function foldControlSize(count = 0): NodeSize {
  return { width: Math.max(28, foldBadgeWidth(count)), height: 28 };
}

/**
 * The control a node shows: a plain toggle while its children are visible, the
 * hidden-descendant count once collapsed, nothing for a leaf.
 */
export function foldControlFor(node: { children: readonly unknown[]; descendantCount: number }): NodeSize | null {
  if (node.descendantCount === 0) return null;
  return foldControlSize(node.children.length === 0 ? node.descendantCount : 0);
}

export function connect(parent: PositionedNode, child: PositionedNode, path: string): LayoutEdge {
  return { id: JSON.stringify([parent.id, child.id]), from: parent.id, to: child.id, path };
}
