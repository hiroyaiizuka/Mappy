// `layoutTree` dispatches here; fold sizing and edge identity stay in layout.ts so the
// renderer and every mode share them (functions only, so the import cycle is harmless).
import {
  connect, foldControlSize,
  type FoldPosition, type LayoutBounds, type LayoutEdge, type MeasuredNode, type PositionedNode,
} from "./layout";

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

interface Frame {
  node: MeasuredNode;
  depth: number;
  /** Left edge of the horizontal extent reserved for this subtree. */
  left: number;
}

function rowGap(depth: number): number {
  return depth === 0 ? HIERARCHY_ROOT_GAP : HIERARCHY_ROW_GAP;
}

function forestWidth(node: MeasuredNode, extents: ReadonlyMap<MeasuredNode, number>): number {
  let width = 0;
  for (const child of node.children) width += extents.get(child) ?? 0;
  return width + Math.max(0, node.children.length - 1) * HIERARCHY_SIBLING_GAP;
}

/** Root's top-left at (x, y); rows grow downward from there. */
export function placeHierarchy(
  root: MeasuredNode, x: number, y: number,
  nodes: PositionedNode[], edges: LayoutEdge[], folds: FoldPosition[], foldBounds: LayoutBounds[],
): void {
  // Preorder with depth; rows take the height of their tallest visible node.
  const order: Frame[] = [];
  const rowHeights: number[] = [];
  const pending: Frame[] = [{ node: root, depth: 0, left: 0 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    order.push(current);
    rowHeights[current.depth] = Math.max(rowHeights[current.depth] ?? 0, current.node.height);
    for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
      const child = current.node.children[index];
      if (child) pending.push({ node: child, depth: current.depth + 1, left: 0 });
    }
  }

  // Reverse preorder: every child's extent is known before its parent's.
  const extents = new Map<MeasuredNode, number>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const frame = order[index];
    if (!frame) continue;
    const { node } = frame;
    const badge = node.descendantCount > 0 ? foldControlSize(node.children.length === 0 ? node.descendantCount : 0).width : 0;
    extents.set(node, Math.max(node.width, badge, forestWidth(node, extents)));
  }

  const rowTops: number[] = [y];
  for (let depth = 1; depth < rowHeights.length; depth += 1) {
    rowTops[depth] = (rowTops[depth - 1] ?? y) + (rowHeights[depth - 1] ?? 0) + rowGap(depth - 1);
  }

  // Preorder again, now with each subtree's extent placed: nodes and forests are
  // centered inside their extent, so a parent sits over the middle of its children
  // and narrow children sit under the middle of a wide parent.
  const stack: Frame[] = [{ node: root, depth: 0, left: x - ((extents.get(root) ?? root.width) - root.width) / 2 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const { node, depth, left } = current;
    const extent = extents.get(node) ?? node.width;
    const position: PositionedNode = {
      id: node.id, x: left + (extent - node.width) / 2, y: rowTops[depth] ?? y, width: node.width, height: node.height,
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
      let childLeft = left + (extent - forestWidth(node, extents)) / 2;
      const children: Frame[] = [];
      for (const child of node.children) {
        const childExtent = extents.get(child) ?? child.width;
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
    } else if (node.descendantCount > 0) {
      // A collapsed branch shows its hidden count right under the node.
      const control = foldControlSize(node.descendantCount);
      const badgeY = bottom + HIERARCHY_BADGE_OFFSET;
      folds.push({ id: node.id, x: centerX, y: badgeY });
      foldBounds.push({ x: centerX - control.width / 2, y: badgeY - control.height / 2, ...control });
    }
  }
}
