import type { MeasuredNode } from "./layout";
import {
  connect, foldControlFor, foldControlSize,
  type FoldPosition, type LayoutBounds, type LayoutEdge, type PositionedNode,
} from "./primitives";

/**
 * Hierarchy (organization chart, logic tree, WBS): the root on top, every depth on one
 * row, branches spreading downward. Each subtree owns a horizontal extent wide enough
 * for the node, its collapsed badge and its children, so siblings and cousins never
 * overlap however long their titles are. Rows are aligned across the whole tree: a
 * row is as tall as its tallest node and nodes hang from the row's top edge, so the
 * connector bus above a row sits at one height for every parent of that depth.
 */
const HIERARCHY_ROOT_GAP = 64;
const HIERARCHY_ROW_GAP = 48;
const HIERARCHY_SIBLING_GAP = 24;
const HIERARCHY_BADGE_OFFSET = 16;

interface Visit {
  node: MeasuredNode;
  depth: number;
}

interface Extent {
  /** Width reserved for the whole subtree. */
  width: number;
  /** Width of the children's row inside it (0 for a leaf). */
  forest: number;
}

interface Slot extends Visit {
  /** Left edge of the extent reserved for this subtree. */
  left: number;
}

function rowGap(depth: number): number {
  return depth === 0 ? HIERARCHY_ROOT_GAP : HIERARCHY_ROW_GAP;
}

/** Preorder with depth; children are pushed in reverse so they come out in source order. */
function preorder(root: MeasuredNode): Visit[] {
  const order: Visit[] = [];
  const pending: Visit[] = [{ node: root, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    order.push(current);
    for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
      const child = current.node.children[index];
      if (child) pending.push({ node: child, depth: current.depth + 1 });
    }
  }
  return order;
}

/** Root's top-left at (x, y); rows grow downward from there. */
export function placeHierarchy(
  root: MeasuredNode, x: number, y: number,
  nodes: PositionedNode[], edges: LayoutEdge[], folds: FoldPosition[], foldBounds: LayoutBounds[],
): void {
  const order = preorder(root);

  // Rows take the height of their tallest visible node.
  const rowHeights: number[] = [];
  for (const { node, depth } of order) rowHeights[depth] = Math.max(rowHeights[depth] ?? 0, node.height);
  const rowTops: number[] = [y];
  for (let depth = 1; depth < rowHeights.length; depth += 1) {
    rowTops[depth] = (rowTops[depth - 1] ?? y) + (rowHeights[depth - 1] ?? 0) + rowGap(depth - 1);
  }

  // Reverse preorder: every child's extent is known before its parent's.
  const extents = new Map<MeasuredNode, Extent>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const node = order[index]?.node;
    if (!node) continue;
    let forest = 0;
    for (const child of node.children) forest += extents.get(child)?.width ?? child.width;
    forest += Math.max(0, node.children.length - 1) * HIERARCHY_SIBLING_GAP;
    extents.set(node, { width: Math.max(node.width, foldControlFor(node)?.width ?? 0, forest), forest });
  }
  const extentOf = (node: MeasuredNode): Extent => extents.get(node) ?? { width: node.width, forest: 0 };

  // Preorder again, now with each subtree's extent placed: nodes and forests are
  // centered inside their extent, so a parent sits over the middle of its children
  // and narrow children sit under the middle of a wide parent.
  const stack: Slot[] = [{ node: root, depth: 0, left: x - (extentOf(root).width - root.width) / 2 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const { node, depth, left } = current;
    const extent = extentOf(node);
    const position: PositionedNode = {
      id: node.id, x: left + (extent.width - node.width) / 2, y: rowTops[depth] ?? y, width: node.width, height: node.height,
    };
    nodes.push(position);
    const centerX = position.x + position.width / 2;
    const bottom = position.y + position.height;
    if (node.children.length > 0) {
      const childTop = rowTops[depth + 1] ?? bottom + rowGap(depth);
      // The bus runs through the middle of the gap above the children's row; the
      // fold control sits on it where the stem from the parent meets the branches.
      const busY = childTop - rowGap(depth) / 2;
      const control = foldControlSize(0);
      folds.push({ id: node.id, x: centerX, y: busY });
      foldBounds.push({ x: centerX - control.width / 2, y: busY - control.height / 2, ...control });
      let childLeft = left + (extent.width - extent.forest) / 2;
      const children: Slot[] = [];
      for (const child of node.children) {
        const childExtent = extentOf(child).width;
        const childPosition: PositionedNode = {
          id: child.id, x: childLeft + (childExtent - child.width) / 2, y: childTop, width: child.width, height: child.height,
        };
        const childCenterX = childPosition.x + childPosition.width / 2;
        edges.push(connect(position, childPosition, `M ${centerX} ${bottom} V ${busY} H ${childCenterX} V ${childTop}`));
        children.push({ node: child, depth: depth + 1, left: childLeft });
        childLeft += childExtent + HIERARCHY_SIBLING_GAP;
      }
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child) stack.push(child);
      }
    } else {
      // A collapsed branch shows its hidden count right under the node.
      const control = foldControlFor(node);
      if (!control) continue;
      const badgeY = bottom + HIERARCHY_BADGE_OFFSET;
      folds.push({ id: node.id, x: centerX, y: badgeY });
      foldBounds.push({ x: centerX - control.width / 2, y: badgeY - control.height / 2, ...control });
    }
  }
}
