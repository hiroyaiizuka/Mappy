import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMarkdown, projectMap } from "../../src/core/markdown";
import { buildScene, nodeExtent, sceneContents, type NodeMeasure } from "../../src/export/excalidraw-scene";
import {
  balancedSide, foldBadgeWidth, foldControlSize, layoutTree, type LayoutNode, type LayoutResult, type NodeSize, type PositionedNode,
} from "../../src/layout/layout";
import { pathToPoints } from "../../src/layout/path-points";
import { estimateNodeSizes, makePerformanceFixture, performanceNodeCounts } from "../../scripts/performance-fixtures.mjs";

/** The map's gaps, which the balanced map shares: root → first level, deeper levels, and between siblings. */
const ROOT_GAP = 80;
const BRANCH_GAP = 56;
const SIBLING_GAP = 22;

type Side = "right" | "left";
type Rect = { x: number; y: number; width: number; height: number };

function node(id: string, ...children: LayoutNode[]): LayoutNode {
  return { id, children };
}

function byId(result: LayoutResult): Map<string, PositionedNode> {
  return new Map(result.nodes.map(item => [item.id, item]));
}

function centerX(item: Rect): number {
  return item.x + item.width / 2;
}

function centerY(item: Rect): number {
  return item.y + item.height / 2;
}

function overlaps(first: Rect, second: Rect): boolean {
  return first.x < second.x + second.width && first.x + first.width > second.x
    && first.y < second.y + second.height && first.y + first.height > second.y;
}

/** An axis-aligned segment passes through the rectangle's interior (touching the border does not count). */
function segmentCrosses(rect: Rect, [ax, ay]: [number, number], [bx, by]: [number, number]): boolean {
  return Math.min(ax, bx) < rect.x + rect.width && Math.max(ax, bx) > rect.x
    && Math.min(ay, by) < rect.y + rect.height && Math.max(ay, by) > rect.y;
}

function segments(result: LayoutResult): { edge: LayoutResult["edges"][number]; from: [number, number]; to: [number, number] }[] {
  return result.edges.flatMap(edge => {
    const points = pathToPoints(edge.path);
    return points.slice(1).map((to, index) => ({ edge, from: points[index] ?? to, to }));
  });
}

/** Parent, depth, descendant count and side of every node of the source tree: the side is dealt at the first level and inherited below. */
function describeTree(root: LayoutNode): { parents: Map<string, string>; depths: Map<string, number>; descendants: Map<string, number>; sides: Map<string, Side> } {
  const parents = new Map<string, string>();
  const depths = new Map<string, number>();
  const descendants = new Map<string, number>();
  const sides = new Map<string, Side>();
  const count = (item: LayoutNode, depth: number, side: Side | null): number => {
    depths.set(item.id, depth);
    if (side) sides.set(item.id, side);
    let total = 0;
    item.children.forEach((child, index) => {
      parents.set(child.id, item.id);
      total += 1 + count(child, depth + 1, side ?? balancedSide(index));
    });
    descendants.set(item.id, total);
    return total;
  };
  count(root, 0, null);
  return { parents, depths, descendants, sides };
}

function gapUnder(depth: number): number {
  return depth === 0 ? ROOT_GAP : BRANCH_GAP;
}

/**
 * The balanced map's invariants: nodes and fold controls disjoint and inside the bounds; the
 * root's first child right, the second left, and so on, every deeper node on its branch's side
 * one gap past its parent; siblings top-down in source order on each side; every connector an
 * axis-aligned stem–bend–branch between the facing edges (the mirror image on the left) that
 * crosses no node; fold controls on the stem of their side, badges of collapsed nodes likewise.
 */
function expectBalanced(result: LayoutResult, root: LayoutNode, collapsed: ReadonlySet<string> = new Set()): void {
  const positions = byId(result);
  const { parents: parentOf, depths: depthOf, descendants, sides: sideOf } = describeTree(root);
  const rects: (Rect & { id: string })[] = [...result.nodes, ...result.folds.map(fold => {
    const control = foldControlSize(collapsed.has(fold.id) ? descendants.get(fold.id) ?? 0 : 0);
    return { id: `fold:${fold.id}`, x: fold.x - control.width / 2, y: fold.y - control.height / 2, ...control };
  })];
  for (let index = 0; index < rects.length; index += 1) {
    const first = rects[index];
    if (!first) continue;
    expect(Number.isFinite(first.x + first.y + first.width + first.height)).toBe(true);
    expect(first.x).toBeGreaterThanOrEqual(result.bounds.x);
    expect(first.y).toBeGreaterThanOrEqual(result.bounds.y);
    expect(first.x + first.width).toBeLessThanOrEqual(result.bounds.x + result.bounds.width);
    expect(first.y + first.height).toBeLessThanOrEqual(result.bounds.y + result.bounds.height);
    for (let other = index + 1; other < rects.length; other += 1) {
      const second = rects[other];
      if (second && overlaps(first, second)) throw new Error(`Overlapping rectangles: ${first.id}, ${second.id}`);
    }
  }

  // Sides and gaps: a right node's left edge is one gap past its parent's right edge, a left node's right edge one gap before its parent's left edge.
  const rootPosition = positions.get(root.id);
  if (!rootPosition) throw new Error("Root not placed");
  for (const item of result.nodes) {
    if (item.id === root.id) continue;
    const parent = positions.get(parentOf.get(item.id) ?? "");
    const depth = depthOf.get(item.id);
    const side = sideOf.get(item.id);
    if (!parent || depth === undefined || !side) throw new Error(`Node ${item.id} is placed without its parent`);
    const gap = gapUnder(depth - 1);
    if (side === "right") expect(item.x, `${item.id} right of ${parent.id}`).toBe(parent.x + parent.width + gap);
    else expect(item.x + item.width, `${item.id} left of ${parent.id}`).toBe(parent.x - gap);
    if (side === "right") expect(item.x).toBeGreaterThan(rootPosition.x + rootPosition.width);
    else expect(item.x + item.width).toBeLessThan(rootPosition.x);
  }

  // Order: on each side the visible siblings of a parent go top-down in source order, one sibling gap or more apart.
  const visibleChildren = (item: LayoutNode): readonly LayoutNode[] => (collapsed.has(item.id) ? [] : item.children);
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const columns: Record<Side, PositionedNode[]> = { right: [], left: [] };
    visibleChildren(current).forEach((child, index) => {
      const placed = positions.get(child.id);
      if (!placed) throw new Error(`Missing ${child.id}`);
      columns[current.id === root.id ? balancedSide(index) : sideOf.get(child.id) ?? "right"].push(placed);
      pending.push(child);
    });
    for (const column of [columns.right, columns.left]) {
      for (let index = 1; index < column.length; index += 1) {
        const above = column[index - 1];
        const below = column[index];
        if (above && below) expect(below.y, `${below.id} under ${above.id}`).toBeGreaterThanOrEqual(above.y + above.height + SIBLING_GAP);
      }
    }
  }

  // Connectors: one per visible child, stem–bend–branch between the facing edges, axis-aligned, crossing no node.
  expect(result.edges).toHaveLength(result.nodes.length - 1);
  for (const edge of result.edges) {
    const parent = positions.get(edge.from);
    const child = positions.get(edge.to);
    const side = sideOf.get(edge.to);
    if (!parent || !child || !side) throw new Error(`Edge ${edge.id} joins unplaced nodes`);
    const startX = side === "right" ? parent.x + parent.width : parent.x;
    const endX = side === "right" ? child.x : child.x + child.width;
    expect(edge.path).toBe(`M ${startX} ${centerY(parent)} H ${(startX + endX) / 2} V ${centerY(child)} H ${endX}`);
  }
  for (const { edge, from, to } of segments(result)) {
    expect(from[0] === to[0] || from[1] === to[1]).toBe(true);
    for (const item of result.nodes) {
      if (segmentCrosses(item, from, to)) throw new Error(`Edge ${edge.id} crosses node ${item.id}`);
    }
  }

  // Fold controls: on the stem of the node's side (the root's on its right stem); a collapsed node's badge just past it on that side.
  const folds = new Map(result.folds.map(fold => [fold.id, fold]));
  for (const item of result.nodes) {
    const fold = folds.get(item.id);
    const hidden = descendants.get(item.id) ?? 0;
    if (hidden === 0) { expect(fold).toBeUndefined(); continue; }
    if (!fold) throw new Error(`Node ${item.id} has descendants but no fold control`);
    const side = sideOf.get(item.id) ?? "right";
    const offset = collapsed.has(item.id) ? Math.max(14, foldBadgeWidth(hidden) / 2 + 4) : gapUnder(depthOf.get(item.id) ?? 0) / 2;
    expect(fold).toEqual({ id: item.id, x: side === "right" ? item.x + item.width + offset : item.x - offset, y: centerY(item) });
  }
}

describe("balanced layout", () => {
  const tree = node("root", node("a", node("a1"), node("a2", node("a21"))), node("b"), node("c", node("c1")), node("d", node("d1"), node("d2")));
  const sizes: ReadonlyMap<string, NodeSize> = new Map([
    ["root", { width: 220, height: 70 }],
    ["a", { width: 80, height: 260 }],
    ["a1", { width: 410, height: 55 }],
    ["a21", { width: 175, height: 300 }],
    ["b", { width: 380, height: 190 }],
    ["c1", { width: 290, height: 30 }],
    ["d", { width: 150, height: 44 }],
  ]);

  it("centres the root on the origin and deals the first level right, left, right, left in source order", () => {
    const result = layoutTree(tree, sizes, new Set(), "balanced");
    expectBalanced(result, tree);
    const positions = byId(result);
    const root = positions.get("root");
    expect(root).toBeDefined();
    if (!root) return;
    expect(centerX(root)).toBe(0);
    expect(centerY(root)).toBe(0);
    expect(result.origin).toEqual({ x: root.x, y: root.y });
    const [a, b, c, d] = ["a", "b", "c", "d"].map(id => positions.get(id));
    expect(a && b && c && d).toBeTruthy();
    if (!a || !b || !c || !d) return;
    // a (index 0) and c (2) hang right, b (1) and d (3) left, each one root gap from the root.
    expect(a.x).toBe(root.x + root.width + ROOT_GAP);
    expect(c.x).toBe(a.x);
    expect(b.x + b.width).toBe(root.x - ROOT_GAP);
    expect(d.x + d.width).toBe(b.x + b.width);
    // Within a side, source order is top-down; across sides the two columns are independent.
    expect(a.y + a.height + SIBLING_GAP).toBeLessThanOrEqual(c.y);
    expect(b.y + b.height + SIBLING_GAP).toBeLessThanOrEqual(d.y);
    // Deeper nodes stay on their branch's side: a's subtree right of the root, d's left.
    for (const id of ["a1", "a2", "a21", "c1"]) expect(positions.get(id)?.x ?? -Infinity).toBeGreaterThan(root.x + root.width);
    for (const id of ["d1", "d2"]) expect((positions.get(id)?.x ?? Infinity) + (positions.get(id)?.width ?? 0)).toBeLessThan(root.x);
  });

  it("recovers the source order from the two columns by taking right and left in turn", () => {
    const wide = node("root", ...Array.from({ length: 9 }, (_, index) => node(`s${index}`)));
    const result = layoutTree(wide, new Map([["root", { width: 100, height: 40 }]]), new Set(), "balanced");
    expectBalanced(result, wide);
    const root = byId(result).get("root");
    if (!root) throw new Error("Root not placed");
    const column = (side: Side): string[] => result.nodes
      .filter(item => item.id !== "root" && (side === "right" ? item.x > root.x : item.x < root.x))
      .sort((first, second) => first.y - second.y)
      .map(item => item.id);
    const right = column("right");
    const left = column("left");
    expect(right).toEqual(["s0", "s2", "s4", "s6", "s8"]);
    expect(left).toEqual(["s1", "s3", "s5", "s7"]);
    const merged: string[] = [];
    for (let index = 0; index < right.length; index += 1) {
      const fromRight = right[index];
      const fromLeft = left[index];
      if (fromRight) merged.push(fromRight);
      if (fromLeft) merged.push(fromLeft);
    }
    expect(merged).toEqual(wide.children.map(child => child.id));
    // Five on the right, four on the left: each column is centred on the root by itself.
    const extent = (ids: string[]): { top: number; bottom: number } => {
      const items = ids.map(id => byId(result).get(id)).filter((item): item is PositionedNode => item !== undefined);
      return { top: Math.min(...items.map(item => item.y)), bottom: Math.max(...items.map(item => item.y + item.height)) };
    };
    expect((extent(right).top + extent(right).bottom) / 2).toBeCloseTo(centerY(root), 6);
    expect((extent(left).top + extent(left).bottom) / 2).toBeCloseTo(centerY(root), 6);
    expect(extent(right).bottom - extent(right).top).toBe(5 * 44 + 4 * SIBLING_GAP);
    expect(extent(left).bottom - extent(left).top).toBe(4 * 44 + 3 * SIBLING_GAP);
  });

  it("keeps a lone child and a lone side on the right, and a childless root alone", () => {
    const single = layoutTree(node("root", node("only", node("deep"))), new Map(), new Set(), "balanced");
    expectBalanced(single, node("root", node("only", node("deep"))));
    const root = byId(single).get("root");
    const only = byId(single).get("only");
    expect(root && only).toBeTruthy();
    if (!root || !only) return;
    expect(only.x).toBe(root.x + root.width + ROOT_GAP);
    expect(centerY(only)).toBe(centerY(root));
    expect(single.bounds.x).toBe(root.x);
    const alone = layoutTree(node("root"), new Map([["root", { width: 120, height: 50 }]]), new Set(), "balanced");
    expect(alone.nodes).toEqual([{ id: "root", x: -60, y: -25, width: 120, height: 50 }]);
    expect(alone.edges).toEqual([]);
    expect(alone.folds).toEqual([]);
    expect(alone.bounds).toEqual({ x: -60, y: -25, width: 120, height: 50 });
  });

  it("mirrors the geometry on the left: connectors between facing edges and fold controls on the left stem", () => {
    const result = layoutTree(tree, sizes, new Set(), "balanced");
    const positions = byId(result);
    const root = positions.get("root");
    const b = positions.get("b");
    const d = positions.get("d");
    const d1 = positions.get("d1");
    const a = positions.get("a");
    const a1 = positions.get("a1");
    expect(root && b && d && d1 && a && a1).toBeTruthy();
    if (!root || !b || !d || !d1 || !a || !a1) return;
    const toB = result.edges.find(edge => edge.to === "b");
    const toD1 = result.edges.find(edge => edge.to === "d1");
    const toA1 = result.edges.find(edge => edge.to === "a1");
    // Left: from the root's left edge to b's right edge, bending halfway, i.e. on the stem where the fold control sits.
    expect(toB?.path).toBe(`M ${root.x} ${centerY(root)} H ${root.x - ROOT_GAP / 2} V ${centerY(b)} H ${b.x + b.width}`);
    expect(toD1?.path).toBe(`M ${d.x} ${centerY(d)} H ${d.x - BRANCH_GAP / 2} V ${centerY(d1)} H ${d1.x + d1.width}`);
    expect(result.folds.find(fold => fold.id === "d")).toEqual({ id: "d", x: d.x - BRANCH_GAP / 2, y: centerY(d) });
    // Right: the map's own shape, and the root's control on its right stem.
    expect(toA1?.path).toBe(`M ${a.x + a.width} ${centerY(a)} H ${a.x + a.width + BRANCH_GAP / 2} V ${centerY(a1)} H ${a1.x}`);
    expect(result.folds.find(fold => fold.id === "a")).toEqual({ id: "a", x: a.x + a.width + BRANCH_GAP / 2, y: centerY(a) });
    expect(result.folds.find(fold => fold.id === "root")).toEqual({ id: "root", x: root.x + root.width + ROOT_GAP / 2, y: centerY(root) });
    expect(result.edges.every(edge => !/[CQ]/u.test(edge.path))).toBe(true);
  });

  it("puts a collapsed node's badge on its own side, hides its descendants, and restores the layout on re-expanding", () => {
    const expanded = layoutTree(tree, sizes, new Set(), "balanced");
    for (const id of ["a", "d"]) {
      const collapsed = new Set([id]);
      const result = layoutTree(tree, sizes, collapsed, "balanced");
      expectBalanced(result, tree, collapsed);
      const item = byId(result).get(id);
      const badge = result.folds.find(fold => fold.id === id);
      expect(item && badge).toBeTruthy();
      if (!item || !badge) continue;
      const offset = Math.max(14, foldBadgeWidth(id === "a" ? 3 : 2) / 2 + 4);
      expect(badge).toEqual({ id, x: id === "a" ? item.x + item.width + offset : item.x - offset, y: centerY(item) });
      expect(result.nodes.some(placed => placed.id === `${id}1`)).toBe(false);
      // Folding one side leaves the other side exactly where it was.
      const untouched = id === "a" ? ["b", "d", "d1", "d2"] : ["a", "a1", "a2", "a21", "c", "c1"];
      for (const other of untouched) expect(byId(result).get(other)).toEqual(byId(expanded).get(other));
    }
    expect(layoutTree(tree, sizes, new Set(["root"]), "balanced").nodes).toHaveLength(1);
    expect(layoutTree(tree, sizes, new Set(), "balanced")).toEqual(expanded);
  });

  it("retains a collapsed root control on its right and fits a four-digit count in the bounds", () => {
    const wide = node("root", ...Array.from({ length: 1000 }, (_, index) => node(`hidden-${index}`)));
    const result = layoutTree(wide, new Map([["root", { width: 100, height: 20 }]]), new Set(["root"]), "balanced");
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toEqual([]);
    const root = result.nodes[0];
    const fold = result.folds[0];
    expect(root && fold).toBeTruthy();
    if (!root || !fold) return;
    const offset = Math.max(14, foldBadgeWidth(1000) / 2 + 4);
    expect(result.folds).toEqual([{ id: "root", x: root.x + root.width + offset, y: centerY(root) }]);
    expect(result.bounds.x + result.bounds.width).toBeGreaterThanOrEqual(fold.x + foldBadgeWidth(1000) / 2);
    expect(result.bounds.y).toBeLessThanOrEqual(fold.y - 14);
    expect(result.bounds.y + result.bounds.height).toBeGreaterThanOrEqual(fold.y + 14);
  });

  it("keeps a four-digit badge on the left clear of the root and inside the bounds", () => {
    const many = node("closed", ...Array.from({ length: 1000 }, (_, index) => node(`hidden-${index}`)));
    const root = node("root", node("first"), many, node("third"));
    const result = layoutTree(root, new Map([["closed", { width: 20, height: 24 }], ["root", { width: 60, height: 30 }]]), new Set(["closed"]), "balanced");
    expectBalanced(result, root, new Set(["closed"]));
    const closed = byId(result).get("closed");
    const badge = result.folds.find(fold => fold.id === "closed");
    expect(closed && badge).toBeTruthy();
    if (!closed || !badge) return;
    const halfWidth = foldBadgeWidth(1000) / 2;
    expect(badge.x + halfWidth).toBeLessThanOrEqual(closed.x);
    expect(result.bounds.x).toBeLessThanOrEqual(badge.x - halfWidth);
    const rootPosition = byId(result).get("root");
    if (rootPosition) expect(closed.x + closed.width).toBeLessThan(rootPosition.x);
  });

  it("places free topics as balanced trees of their own, stacked under the root's centre when unpositioned", () => {
    const topics = [
      { tree: node("t1", node("t1a"), node("t1b"), node("t1c")), position: null },
      { tree: node("t2", node("t2a", node("t2aa"))), position: { x: 2000, y: -60 } },
    ];
    const alone = layoutTree(tree, sizes, new Set(), "balanced");
    const result = layoutTree(tree, sizes, new Set(), "balanced", topics);
    const bodyIds = new Set(alone.nodes.map(item => item.id));
    expect(result.nodes.filter(item => bodyIds.has(item.id))).toEqual(alone.nodes);
    expect(result.origin).toEqual(alone.origin);
    const positions = byId(result);
    const t1 = positions.get("t1");
    const t1a = positions.get("t1a");
    const t1b = positions.get("t1b");
    const t1c = positions.get("t1c");
    const t2 = positions.get("t2");
    const t2a = positions.get("t2a");
    expect(t1 && t1a && t1b && t1c && t2 && t2a).toBeTruthy();
    if (!t1 || !t1a || !t1b || !t1c || !t2 || !t2a) return;
    // Unplaced: its whole extent centred under the body root, below everything the body placed (fold controls included).
    const extent = ["t1", "t1a", "t1b", "t1c"].map(id => positions.get(id)).filter((item): item is PositionedNode => item !== undefined);
    const left = Math.min(...extent.map(item => item.x));
    const right = Math.max(...extent.map(item => item.x + item.width));
    expect((left + right) / 2).toBeCloseTo(0, 6);
    expect(Math.min(...extent.map(item => item.y))).toBeGreaterThanOrEqual(alone.bounds.y + alone.bounds.height + 48);
    // A topic is dealt like the body: first and third children right, second left.
    expect(t1a.x).toBe(t1.x + t1.width + ROOT_GAP);
    expect(t1c.x).toBe(t1a.x);
    expect(t1b.x + t1b.width).toBe(t1.x - ROOT_GAP);
    // Placed: origin + offset, same shape.
    expect({ x: t2.x, y: t2.y }).toEqual({ x: result.origin.x + 2000, y: result.origin.y - 60 });
    expect(t2a.x).toBe(t2.x + t2.width + ROOT_GAP);
    expect(positions.get("t2aa")?.x).toBe(t2a.x + t2a.width + BRANCH_GAP);
    for (let index = 0; index < result.nodes.length; index += 1) {
      for (let other = index + 1; other < result.nodes.length; other += 1) {
        const first = result.nodes[index];
        const second = result.nodes[other];
        if (first && second && overlaps(first, second)) throw new Error(`Overlapping nodes: ${first.id}, ${second.id}`);
      }
    }
  });

  it("gives the Excalidraw scene the same coordinates as the map, on both sides", () => {
    const source = "## 講座\n- 章\n  - 項目\n    ![[図.png]]\n    - 項目の子\n  - c\n- 左の章\n  - 左の子\n    - 左の孫\n- 三つ目\n- 四つ目\n  - 四つ目の子\n";
    const contents = sceneContents(parseMarkdown(source, "Note"));
    const measures = new Map<string, NodeMeasure>(contents.nodes.map(item => [item.id, {
      label: item.role === "root" ? { width: 140, height: 54 } : item.role === "stage" ? { width: 100, height: 44 } : { width: 80, height: 30 },
      images: item.images.map(() => ({ width: 200, height: 200 })),
    }]));
    const scene = buildScene(contents, measures, "balanced", new Set(), [10, 20]);
    const sizes = new Map([...measures].map(([id, measure]) => [id, nodeExtent(measure)]));
    const layout = layoutTree(contents.tree, sizes, new Set(), "balanced");
    expectBalanced(layout, contents.tree);
    const dx = 10 - layout.bounds.x;
    const dy = 20 - layout.bounds.y;
    for (const item of layout.nodes) {
      expect(scene.blocks.find(block => block.nodeId === item.id && block.kind === "label")).toMatchObject({ x: item.x + dx, y: item.y + dy });
    }
    expect(scene.lines).toEqual(layout.edges.map(edge => pathToPoints(edge.path).map(([x, y]) => [x + dx, y + dy])));
    expect(scene.bounds).toEqual({ x: 10, y: 20, width: layout.bounds.width, height: layout.bounds.height });
    const byText = new Map(contents.nodes.map(item => [item.text, item.id]));
    const blockOf = (text: string): { x: number; width: number } => {
      const block = scene.blocks.find(candidate => candidate.nodeId === byText.get(text) && candidate.kind === "label");
      if (!block) throw new Error(`Missing block for ${text}`);
      return block;
    };
    // The stages sit on both sides of the root in the scene too, and the left grandchild is the leftmost block.
    const root = blockOf("講座");
    expect(blockOf("章").x).toBeGreaterThan(root.x + root.width);
    expect(blockOf("三つ目").x).toBeGreaterThan(root.x + root.width);
    expect(blockOf("左の章").x + blockOf("左の章").width).toBeLessThan(root.x);
    expect(blockOf("四つ目").x + blockOf("四つ目").width).toBeLessThan(root.x);
    expect(blockOf("左の孫").x).toBe(Math.min(...scene.blocks.map(block => block.x)));
    // Every polyline is axis-aligned, the mirrored ones included.
    for (const line of scene.lines) {
      for (let index = 1; index < line.length; index += 1) {
        const [ax, ay] = line[index - 1] ?? [NaN, NaN];
        const [bx, by] = line[index] ?? [NaN, NaN];
        expect(ax === bx || ay === by).toBe(true);
      }
    }
  });

  it("handles deep chains on both sides without recursion and 500 mixed sizes without overlap", () => {
    let rightChain = node("right-1999");
    for (let index = 1998; index >= 0; index -= 1) rightChain = node(`right-${index}`, rightChain);
    let leftChain = node("left-1999");
    for (let index = 1998; index >= 0; index -= 1) leftChain = node(`left-${index}`, leftChain);
    const deep = layoutTree(node("root", rightChain, leftChain), new Map(), new Set(), "balanced");
    expect(deep.nodes).toHaveLength(4001);
    expect(deep.edges).toHaveLength(4000);
    const rightEnd = deep.nodes.find(item => item.id === "right-1999");
    const leftEnd = deep.nodes.find(item => item.id === "left-1999");
    expect(rightEnd?.x).toBeGreaterThan(100_000);
    expect((leftEnd?.x ?? 0) + (leftEnd?.width ?? 0)).toBeLessThan(-100_000);
    expect(deep.nodes.every(item => centerY(item) === 0)).toBe(true);

    const branches: LayoutNode[] = [];
    const measurements = new Map<string, NodeSize>();
    let count = 1;
    for (let branch = 0; branch < 25; branch += 1) {
      const children: LayoutNode[] = [];
      for (let leaf = 0; leaf < 19 && count < 499; leaf += 1) {
        const id = `leaf-${count++}`;
        children.push(node(id));
        measurements.set(id, { width: 60 + leaf * 12, height: 25 + leaf * 7 });
      }
      branches.push(node(`branch-${count++}`, ...children));
    }
    const wide = node("root", ...branches);
    const result = layoutTree(wide, measurements, new Set(), "balanced");
    expect(result.nodes).toHaveLength(500);
    expectBalanced(result, wide);
  });

  it("uses finite defaults, leaves the input untouched and rejects duplicate identities", () => {
    const result = layoutTree(node("root", node("child"), node("other")), new Map([
      ["root", { width: NaN, height: -20 }],
      ["child", { width: Infinity, height: 0 }],
    ]), new Set(), "balanced");
    expectBalanced(result, node("root", node("child"), node("other")));
    expect(result.nodes.every(item => item.width > 0 && item.height > 0)).toBe(true);
    const before = JSON.stringify(tree);
    layoutTree(tree, sizes, new Set(["a"]), "balanced");
    expect(JSON.stringify(tree)).toBe(before);
    expect(() => layoutTree(node("root", node("same"), node("same")), new Map(), new Set(), "balanced")).toThrow(/duplicate/iu);
  });
});

describe("balanced layout of the fixtures", () => {
  it("lays out uneven-branches: the 24 siblings top-down on the left, the deep chain link by link on the right, long Japanese without overlap", () => {
    const source = readFileSync(new URL("../fixtures/uneven-branches.md", import.meta.url), "utf8");
    const doc = parseMarkdown(source, "uneven-branches");
    const { root } = projectMap(doc);
    const result = layoutTree(root, estimateNodeSizes(doc.nodes), new Set(), "balanced");
    expectBalanced(result, root);
    const positions = byId(result);
    const titles = new Map(doc.nodes.map(item => [item.id, item.title]));
    const rootPosition = positions.get(root.id);
    if (!rootPosition) throw new Error("Root not placed");
    // First level: 深い一列の枝 (0) right, 多数の兄弟 (1) left, and so on; its 24 children follow it to the left, in order.
    const stages = root.children.map(child => positions.get(child.id));
    stages.forEach((stage, index) => {
      if (!stage) throw new Error(`Stage ${index} not placed`);
      if (index % 2 === 0) expect(stage.x).toBe(rootPosition.x + rootPosition.width + ROOT_GAP);
      else expect(stage.x + stage.width).toBe(rootPosition.x - ROOT_GAP);
    });
    const siblings = result.nodes.filter(item => /^兄弟 \d+$/u.test(titles.get(item.id) ?? ""));
    expect(siblings).toHaveLength(24);
    expect(siblings.every(item => item.x + item.width < rootPosition.x)).toBe(true);
    expect(new Set(siblings.map(item => item.x + item.width)).size).toBe(1);
    const ordered = [...siblings].sort((first, second) => first.y - second.y).map(item => titles.get(item.id));
    expect(ordered).toEqual(Array.from({ length: 24 }, (_, index) => `兄弟 ${index + 1}`));
    // The 8-deep chain runs right, link by link, and ends as the rightmost node.
    const chain = ["深い一列の枝", "二段目", "三段目", "四段目", "五段目", "六段目", "七段目（従来の見出し形式では作れない深さ）", "八段目"]
      .map(title => result.nodes.find(item => titles.get(item.id) === title));
    expect(chain.every(item => item !== undefined)).toBe(true);
    chain.forEach((item, index) => {
      const before = index === 0 ? rootPosition : chain[index - 1];
      if (item && before) expect(item.x).toBe(before.x + before.width + gapUnder(index));
    });
    const eighth = chain[chain.length - 1];
    if (eighth) expect(eighth.x + eighth.width).toBe(Math.max(...result.nodes.map(item => item.x + item.width)));
    const long = result.nodes.filter(item => (titles.get(item.id)?.length ?? 0) > 40);
    expect(long.length).toBeGreaterThanOrEqual(2);
    expect(long.every(item => item.width === 360)).toBe(true);
  });

  it.each(performanceNodeCounts)("lays out the %s node performance fixture on both sides without overlap", count => {
    const [, source] = makePerformanceFixture(count);
    const doc = parseMarkdown(source, `performance-${count}`);
    const { root } = projectMap(doc);
    const result = layoutTree(root, estimateNodeSizes(doc.nodes), new Set(), "balanced");
    expect(result.nodes).toHaveLength(count);
    expectBalanced(result, root);
    const rootPosition = byId(result).get(root.id);
    if (root.children.length > 1 && rootPosition) {
      expect(result.nodes.some(item => item.x > rootPosition.x + rootPosition.width)).toBe(true);
      expect(result.nodes.some(item => item.x + item.width < rootPosition.x)).toBe(true);
    }
    const collapsed = new Set(root.children.slice(0, Math.ceil(root.children.length / 2)).map(item => item.id));
    const folded = layoutTree(root, estimateNodeSizes(doc.nodes), collapsed, "balanced");
    expectBalanced(folded, root, collapsed);
    expect(folded.nodes.length).toBeLessThan(result.nodes.length);
    expect(folded.folds.filter(fold => collapsed.has(fold.id))).toHaveLength(collapsed.size);
  });
});
