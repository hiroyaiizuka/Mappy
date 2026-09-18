import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMarkdown, projectMap } from "../../src/core/markdown";
import { buildScene, nodeExtent, sceneContents, type NodeMeasure } from "../../src/export/excalidraw-scene";
import { foldBadgeWidth, foldControlSize, layoutTree, type LayoutNode, type LayoutResult, type NodeSize, type PositionedNode } from "../../src/layout/layout";
import { pathToPoints } from "../../src/layout/path-points";
import { estimateNodeSizes, makePerformanceFixture, performanceNodeCounts } from "../../scripts/performance-fixtures.mjs";

const ROOT_GAP = 48;
const ROW_GAP = 32;
const SIBLING_GAP = 24;

/** The gap under a parent at this depth: the root's children hang a little lower than the rest. */
function gapBelow(parentDepth: number): number {
  return parentDepth === 0 ? ROOT_GAP : ROW_GAP;
}

function node(id: string, ...children: LayoutNode[]): LayoutNode {
  return { id, children };
}

function byId(result: LayoutResult): Map<string, PositionedNode> {
  return new Map(result.nodes.map(item => [item.id, item]));
}

function centerX(item: PositionedNode): number {
  return item.x + item.width / 2;
}

function overlaps(first: { x: number; y: number; width: number; height: number }, second: { x: number; y: number; width: number; height: number }): boolean {
  return first.x < second.x + second.width && first.x + first.width > second.x
    && first.y < second.y + second.height && first.y + first.height > second.y;
}

/** An axis-aligned segment passes through the rectangle's interior (touching the border does not count). */
function segmentCrosses(rect: { x: number; y: number; width: number; height: number }, [ax, ay]: [number, number], [bx, by]: [number, number]): boolean {
  return Math.min(ax, bx) < rect.x + rect.width && Math.max(ax, bx) > rect.x
    && Math.min(ay, by) < rect.y + rect.height && Math.max(ay, by) > rect.y;
}

/** Every segment of every connector, for checks against rectangles. */
function segments(result: LayoutResult): { edge: LayoutResult["edges"][number]; from: [number, number]; to: [number, number] }[] {
  return result.edges.flatMap(edge => {
    const points = pathToPoints(edge.path);
    return points.slice(1).map((to, index) => ({ edge, from: points[index] ?? to, to }));
  });
}

/** Depth, parent and descendant count of every node in the source tree, so rows and badges can be checked against the tree rather than the layout. */
function describeTree(root: LayoutNode): { depths: Map<string, number>; parents: Map<string, string>; descendants: Map<string, number> } {
  const depths = new Map<string, number>();
  const parents = new Map<string, string>();
  const descendants = new Map<string, number>();
  const count = (node: LayoutNode, depth: number): number => {
    depths.set(node.id, depth);
    let total = 0;
    for (const child of node.children) {
      parents.set(child.id, node.id);
      total += 1 + count(child, depth + 1);
    }
    descendants.set(node.id, total);
    return total;
  };
  count(root, 0);
  return { depths, parents, descendants };
}

/** Preorder ids of the visible tree: what a reader sees top-down, left-to-right. */
function preorder(root: LayoutNode, collapsed: ReadonlySet<string>): string[] {
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    result.push(current.id);
    if (collapsed.has(current.id)) continue;
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      const child = current.children[index];
      if (child) pending.push(child);
    }
  }
  return result;
}

/**
 * The hierarchy invariants: nodes and fold controls disjoint and inside the bounds,
 * every child's top edge exactly one gap below its own parent's bottom edge (so siblings
 * share a row while a tall parent lowers only its own children), siblings and cousins in
 * source order from left to right, and every connector made of axis-aligned segments
 * that start at the parent's bottom center, end at the child's top center and never
 * cross a node.
 */
function expectHierarchy(result: LayoutResult, root: LayoutNode, collapsed: ReadonlySet<string> = new Set()): void {
  const positions = byId(result);
  const { depths: depthOf, parents: parentOf, descendants } = describeTree(root);
  // Fold controls count with their real hit area: a collapsed badge grows with its hidden count.
  const rects = [...result.nodes, ...result.folds.map(fold => {
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

  // Rows hang from each parent: a child's top edge is its parent's bottom edge plus the
  // gap for the parent's depth, whatever the cousins' parents measure.
  for (const item of result.nodes) {
    const depth = depthOf.get(item.id);
    expect(depth).toBeDefined();
    if (depth === undefined || item.id === root.id) continue;
    const parent = positions.get(parentOf.get(item.id) ?? "");
    if (!parent) throw new Error(`Node ${item.id} is placed without its parent`);
    const gap = item.y - (parent.y + parent.height);
    if (Math.abs(gap - gapBelow(depth - 1)) > 1e-6) {
      throw new Error(`Node ${item.id} hangs ${gap} below ${parent.id} instead of ${gapBelow(depth - 1)}`);
    }
  }

  // Order: preorder of the visible tree is left-to-right within each row.
  const lastXByDepth = new Map<number, number>();
  for (const id of preorder(root, collapsed)) {
    const item = positions.get(id);
    const depth = depthOf.get(id);
    expect(item && depth !== undefined).toBeTruthy();
    if (!item || depth === undefined) continue;
    const previous = lastXByDepth.get(depth);
    if (previous !== undefined) expect(item.x).toBeGreaterThanOrEqual(previous + SIBLING_GAP);
    lastXByDepth.set(depth, item.x + item.width);
  }

  // Connectors.
  expect(result.edges).toHaveLength(result.nodes.length - 1);
  for (const edge of result.edges) {
    const parent = positions.get(edge.from);
    const child = positions.get(edge.to);
    expect(parent && child).toBeTruthy();
    if (!parent || !child) continue;
    const points = pathToPoints(edge.path);
    expect(points[0]).toEqual([centerX(parent), parent.y + parent.height]);
    expect(points[points.length - 1]).toEqual([centerX(child), child.y]);
  }
  for (const { edge, from, to } of segments(result)) {
    expect(from[0] === to[0] || from[1] === to[1]).toBe(true);
    for (const item of result.nodes) {
      if (segmentCrosses(item, from, to)) throw new Error(`Edge ${edge.id} crosses node ${item.id}`);
    }
  }
}

describe("hierarchy layout", () => {
  const tree = node("root", node("a", node("a1"), node("a2", node("a21"))), node("b"), node("c", node("c1")));
  const sizes: ReadonlyMap<string, NodeSize> = new Map([
    ["root", { width: 220, height: 70 }],
    ["a", { width: 80, height: 260 }],
    ["a1", { width: 410, height: 55 }],
    ["a21", { width: 175, height: 300 }],
    ["b", { width: 380, height: 190 }],
    ["c1", { width: 290, height: 30 }],
  ]);

  it("puts the root on top, hangs each parent's children one gap below it and keeps siblings in source order", () => {
    const result = layoutTree(tree, sizes, new Set(), "hierarchy");
    expectHierarchy(result, tree);
    const positions = byId(result);
    const root = positions.get("root");
    expect(root).toBeDefined();
    if (!root) return;
    expect(root.y).toBe(0);
    expect(centerX(root)).toBe(0);
    expect(result.origin).toEqual({ x: root.x, y: root.y });
    // Siblings share a top edge; cousins hang from their own parent, so the tall `a` (260)
    // lowers only `a1`/`a2`, while `c1` stays one gap under the default-height `c` (44).
    const first = ["a", "b", "c"].map(id => positions.get(id));
    expect(first.every(item => item?.y === 70 + ROOT_GAP)).toBe(true);
    expect(["a1", "a2"].every(id => positions.get(id)?.y === 70 + ROOT_GAP + 260 + ROW_GAP)).toBe(true);
    expect(positions.get("c1")?.y).toBe(70 + ROOT_GAP + 44 + ROW_GAP);
    expect(positions.get("a21")?.y).toBe(70 + ROOT_GAP + 260 + ROW_GAP + 44 + ROW_GAP);
    expect(positions.get("a")?.x).toBeLessThan(positions.get("b")?.x ?? -Infinity);
    expect(positions.get("b")?.x).toBeLessThan(positions.get("c")?.x ?? -Infinity);
    expect(positions.get("a2")?.x).toBeLessThan(positions.get("c1")?.x ?? -Infinity);
  });

  it("centers a parent over its children and narrow children under a wide parent", () => {
    const result = layoutTree(node("root", node("p", node("p1"), node("p2"), node("p3")), node("wide", node("w1"), node("w2"))), new Map([
      ["root", { width: 100, height: 40 }],
      ["p", { width: 90, height: 30 }],
      ["wide", { width: 600, height: 30 }],
      ["w1", { width: 50, height: 20 }],
      ["w2", { width: 50, height: 20 }],
    ]), new Set(), "hierarchy");
    const positions = byId(result);
    const p = positions.get("p");
    const p1 = positions.get("p1");
    const p3 = positions.get("p3");
    const wide = positions.get("wide");
    const w1 = positions.get("w1");
    const w2 = positions.get("w2");
    const root = positions.get("root");
    expect(p && p1 && p3 && wide && w1 && w2 && root).toBeTruthy();
    if (!p || !p1 || !p3 || !wide || !w1 || !w2 || !root) return;
    expect(centerX(p)).toBeCloseTo((centerX(p1) + centerX(p3)) / 2, 6);
    expect((w1.x + w2.x + w2.width) / 2).toBeCloseTo(centerX(wide), 6);
    expect(w2.x - (w1.x + w1.width)).toBe(SIBLING_GAP);
    // The wide sibling reserves its own width, so `p`'s forest and `wide` never touch.
    expect(wide.x - (p3.x + p3.width)).toBeGreaterThanOrEqual(SIBLING_GAP);
    // The root is centered over the extents of its subtrees: `p`'s wide forest on the left, `wide` on the right.
    expect(centerX(root)).toBeCloseTo((p1.x + wide.x + wide.width) / 2, 6);
  });

  it("draws each branch as stem, bus and drop, with the bus halfway through the gap under its parent and no line under text", () => {
    const result = layoutTree(tree, sizes, new Set(), "hierarchy");
    const positions = byId(result);
    const busByParent = new Map<string, number>();
    const depthOf = describeTree(tree).depths;
    for (const edge of result.edges) {
      const parent = positions.get(edge.from);
      const child = positions.get(edge.to);
      expect(parent && child).toBeTruthy();
      if (!parent || !child) continue;
      const gap = gapBelow(depthOf.get(parent.id) ?? -1);
      const busY = parent.y + parent.height + gap / 2;
      expect(edge.path).toBe(`M ${centerX(parent)} ${parent.y + parent.height} V ${busY} H ${centerX(child)} V ${child.y}`);
      expect(child.y).toBe(busY + gap / 2);
      expect(busByParent.get(parent.id) ?? busY).toBe(busY);
      busByParent.set(parent.id, busY);
      expect(edge.path).not.toMatch(/[CQ]/u);
    }
    // The stem plus drop of every connector is the gap, whatever the parent's height: the
    // tall `a` (260) and the default `c` (44) both reach their children in ROW_GAP.
    const a = positions.get("a");
    const c = positions.get("c");
    expect(a && c).toBeTruthy();
    if (!a || !c) return;
    expect(busByParent.get("a")).toBe(a.y + a.height + ROW_GAP / 2);
    expect(busByParent.get("c")).toBe(c.y + c.height + ROW_GAP / 2);
    expect((busByParent.get("a") ?? 0) - (busByParent.get("c") ?? 0)).toBe(260 - 44);
  });

  it("puts expanded controls on the junction below the parent and collapsed badges under the node", () => {
    const expanded = layoutTree(tree, sizes, new Set(), "hierarchy");
    const positions = byId(expanded);
    const folds = new Map(expanded.folds.map(fold => [fold.id, fold]));
    expect([...folds.keys()].sort()).toEqual(["a", "a2", "c", "root"]);
    for (const [id, fold] of folds) {
      const parent = positions.get(id);
      const child = expanded.edges.find(edge => edge.from === id);
      const target = child ? positions.get(child.to) : undefined;
      expect(parent && target).toBeTruthy();
      if (!parent || !target) continue;
      expect(fold).toEqual({ id, x: centerX(parent), y: target.y - (id === "root" ? ROOT_GAP : ROW_GAP) / 2 });
    }
    const collapsed = layoutTree(tree, sizes, new Set(["a"]), "hierarchy");
    expectHierarchy(collapsed, tree, new Set(["a"]));
    expect(collapsed.nodes.map(item => item.id)).toEqual(["root", "a", "b", "c", "c1"]);
    const a = byId(collapsed).get("a");
    const badge = collapsed.folds.find(fold => fold.id === "a");
    expect(a && badge).toBeTruthy();
    if (!a || !badge) return;
    expect(badge).toEqual({ id: "a", x: centerX(a), y: a.y + a.height + 16 });
    expect(collapsed.bounds.width * collapsed.bounds.height).toBeLessThan(expanded.bounds.width * expanded.bounds.height);
    expect(layoutTree(tree, sizes, new Set(["root"]), "hierarchy").nodes).toHaveLength(1);
    // Re-expanding restores exactly the layout from before the fold.
    expect(layoutTree(tree, sizes, new Set(), "hierarchy")).toEqual(expanded);
  });

  // The feedback case (LEV-46): three siblings at depth 2, one of them carrying a 200 px
  // image; the text-only siblings and a cousin branch have children of their own.
  const imageTree = node("root",
    node("chapter", node("figure", node("figure-child")), node("text", node("text-child")), node("other", node("other-child"))),
    node("cousin", node("cousin-child")));
  const imageSizes: ReadonlyMap<string, NodeSize> = new Map([
    ["root", { width: 120, height: 54 }],
    ["chapter", { width: 200, height: 44 }],
    ["cousin", { width: 80, height: 44 }],
    ["figure", { width: 220, height: 30 + 200 }],
    ["figure-child", { width: 60, height: 30 }],
    ["text", { width: 60, height: 30 }],
    ["text-child", { width: 60, height: 30 }],
    ["other", { width: 60, height: 30 }],
    ["other-child", { width: 60, height: 30 }],
    ["cousin-child", { width: 60, height: 30 }],
  ]);

  it("lowers only the children of the node with the image and keeps every other connector one gap long", () => {
    const result = layoutTree(imageTree, imageSizes, new Set(), "hierarchy");
    expectHierarchy(result, imageTree);
    const positions = byId(result);
    const at = (id: string): PositionedNode => {
      const item = positions.get(id);
      if (!item) throw new Error(`Missing ${id}`);
      return item;
    };
    const bottom = (item: PositionedNode): number => item.y + item.height;
    // (1) Siblings share a top edge, under their own parent.
    expect(at("chapter").y).toBe(bottom(at("root")) + ROOT_GAP);
    expect(at("cousin").y).toBe(at("chapter").y);
    expect([at("figure").y, at("text").y, at("other").y]).toEqual(Array(3).fill(bottom(at("chapter")) + ROW_GAP));
    // (2) Cousins hang from their own parent: the text-only branches stay one gap long, the
    // image's child alone drops by the image height.
    expect(at("text-child").y).toBe(bottom(at("text")) + ROW_GAP);
    expect(at("other-child").y).toBe(bottom(at("other")) + ROW_GAP);
    expect(at("cousin-child").y).toBe(bottom(at("cousin")) + ROW_GAP);
    expect(at("figure-child").y).toBe(bottom(at("figure")) + ROW_GAP);
    expect(at("figure-child").y - at("text-child").y).toBe(200);
    // (3) The image reaches past the row of its nieces yet never overlaps them: the branch
    // keeps its own horizontal extent.
    expect(bottom(at("figure"))).toBeGreaterThan(at("text-child").y);
    for (const id of ["text-child", "other-child", "cousin-child"]) expect(overlaps(at("figure"), at(id))).toBe(false);
    // The stem plus drop of every connector is exactly the gap under its parent.
    const depthOf = describeTree(imageTree).depths;
    for (const edge of result.edges) {
      const points = pathToPoints(edge.path);
      const first = points[0];
      const last = points[points.length - 1];
      expect(first && last).toBeTruthy();
      if (first && last) expect(last[1] - first[1]).toBe(gapBelow(depthOf.get(edge.from) ?? -1));
    }
  });

  it("keeps the rule after collapsing and leaves the other branches' rows where they were", () => {
    const expanded = layoutTree(imageTree, imageSizes, new Set(), "hierarchy");
    const before = byId(expanded);
    for (const id of ["figure", "text", "chapter"]) {
      const collapsed = new Set([id]);
      const result = layoutTree(imageTree, imageSizes, collapsed, "hierarchy");
      expectHierarchy(result, imageTree, collapsed);
      const positions = byId(result);
      const node = positions.get(id);
      expect(node).toBeDefined();
      if (!node) continue;
      expect(result.folds.find(fold => fold.id === id)).toEqual({ id, x: centerX(node), y: node.y + node.height + 16 });
      // Folding one branch changes horizontal room only; no remaining node moves up or down.
      for (const item of result.nodes) expect(item.y, item.id).toBe(before.get(item.id)?.y);
    }
    expect(layoutTree(imageTree, imageSizes, new Set(), "hierarchy")).toEqual(expanded);
  });

  it("places free topics the same way whether or not the body has a tall node", () => {
    const topics = [
      { tree: node("t1", node("t1a"), node("t1b")), position: null },
      { tree: node("t2", node("t2a", node("t2aa"))), position: { x: 500, y: 40 } },
    ];
    const alone = layoutTree(imageTree, imageSizes, new Set(), "hierarchy");
    const result = layoutTree(imageTree, imageSizes, new Set(), "hierarchy", topics);
    const bodyIds = new Set(alone.nodes.map(item => item.id));
    expect(result.nodes.filter(item => bodyIds.has(item.id))).toEqual(alone.nodes);
    expect(result.origin).toEqual(alone.origin);
    const positions = byId(result);
    const t1 = positions.get("t1");
    const t2 = positions.get("t2");
    const t2a = positions.get("t2a");
    expect(t1 && t2 && t2a).toBeTruthy();
    if (!t1 || !t2 || !t2a) return;
    // Unplaced: centered under the body root, below everything the body placed (image and fold controls included).
    expect(centerX(t1)).toBeCloseTo(0, 6);
    expect(t1.y).toBeGreaterThanOrEqual(alone.bounds.y + alone.bounds.height + 48);
    // Placed: origin + offset, and its own tree hangs by the same rule.
    expect({ x: t2.x, y: t2.y }).toEqual({ x: result.origin.x + 500, y: result.origin.y + 40 });
    expect(["t1a", "t1b"].map(id => positions.get(id)?.y)).toEqual([t1.y + t1.height + ROOT_GAP, t1.y + t1.height + ROOT_GAP]);
    expect(t2a.y).toBe(t2.y + t2.height + ROOT_GAP);
    expect(positions.get("t2aa")?.y).toBe(t2a.y + t2a.height + ROW_GAP);
  });

  it("gives the Excalidraw scene the same coordinates as the map, image rows included", () => {
    const source = "## 講座\n- 章\n  - 項目\n    ![[図.png]]\n    - 項目の子\n  - c\n    - xx\n  - aaaa\n    - 子\n- 別の章\n  - 別の子\n";
    const contents = sceneContents(parseMarkdown(source, "Note"));
    const measures = new Map<string, NodeMeasure>(contents.nodes.map(item => [item.id, {
      label: item.role === "root" ? { width: 140, height: 54 } : item.role === "stage" ? { width: 100, height: 44 } : { width: 80, height: 30 },
      images: item.images.map(() => ({ width: 200, height: 200 })),
    }]));
    const scene = buildScene(contents, measures, "hierarchy", new Set(), [10, 20]);
    const sizes = new Map([...measures].map(([id, measure]) => [id, nodeExtent(measure)]));
    const layout = layoutTree(contents.tree, sizes, new Set(), "hierarchy");
    expectHierarchy(layout, contents.tree);
    const dx = 10 - layout.bounds.x;
    const dy = 20 - layout.bounds.y;
    for (const item of layout.nodes) {
      expect(scene.blocks.find(block => block.nodeId === item.id && block.kind === "label")).toMatchObject({ x: item.x + dx, y: item.y + dy });
    }
    expect(scene.lines).toEqual(layout.edges.map(edge => pathToPoints(edge.path).map(([x, y]) => [x + dx, y + dy])));
    const byText = new Map(contents.nodes.map(item => [item.text, item.id]));
    const labelOf = (text: string): { y: number; height: number } => {
      const block = scene.blocks.find(candidate => candidate.nodeId === byText.get(text) && candidate.kind === "label");
      if (!block) throw new Error(`Missing block for ${text}`);
      return block;
    };
    const image = scene.blocks.find(block => block.kind === "image");
    expect(image).toBeDefined();
    if (!image) return;
    // In the scene too, only the image's child drops: `xx` sits one gap under `c`, `項目の子` one gap under the image.
    expect(labelOf("xx").y).toBe(labelOf("c").y + labelOf("c").height + ROW_GAP);
    expect(labelOf("項目の子").y).toBe(image.y + image.height + ROW_GAP);
    expect(labelOf("項目の子").y - labelOf("xx").y).toBe(200 + 6);
  });

  it("retains a collapsed root control under the root and fits its four-digit count", () => {
    const wide = node("root", ...Array.from({ length: 1000 }, (_, index) => node(`hidden-${index}`)));
    const result = layoutTree(wide, new Map([["root", { width: 100, height: 20 }]]), new Set(["root"]), "hierarchy");
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toEqual([]);
    const root = result.nodes[0];
    const fold = result.folds[0];
    expect(root && fold).toBeTruthy();
    if (!root || !fold) return;
    expect(result.folds).toEqual([{ id: "root", x: centerX(root), y: root.y + root.height + 16 }]);
    const halfWidth = foldBadgeWidth(1000) / 2;
    expect(result.bounds.x).toBeLessThanOrEqual(fold.x - halfWidth);
    expect(result.bounds.x + result.bounds.width).toBeGreaterThanOrEqual(fold.x + halfWidth);
    expect(result.bounds.y + result.bounds.height).toBeGreaterThanOrEqual(fold.y + 14);
    expect(fold.y - 14).toBeGreaterThanOrEqual(root.y + root.height);
  });

  it("keeps a four-digit badge inside the bounds and clear of neighbouring branches", () => {
    const many = node("closed", ...Array.from({ length: 1000 }, (_, index) => node(`hidden-${index}`)));
    const root = node("root", node("left", node("l1")), many, node("right", node("r1")));
    const result = layoutTree(root, new Map([
      ["closed", { width: 20, height: 24 }],
      ["left", { width: 20, height: 24 }],
      ["right", { width: 20, height: 24 }],
    ]), new Set(["closed"]), "hierarchy");
    expectHierarchy(result, root, new Set(["closed"]));
    const closed = byId(result).get("closed");
    const badge = result.folds.find(fold => fold.id === "closed");
    expect(closed && badge).toBeTruthy();
    if (!closed || !badge) return;
    const halfWidth = foldBadgeWidth(1000) / 2;
    expect(halfWidth).toBeGreaterThan(closed.width / 2);
    const badgeRect = { x: badge.x - halfWidth, y: badge.y - 9, width: halfWidth * 2, height: 18 };
    for (const item of result.nodes) expect(overlaps(badgeRect, item)).toBe(false);
    for (const { from, to } of segments(result)) expect(segmentCrosses(badgeRect, from, to)).toBe(false);
    expect(result.bounds.x).toBeLessThanOrEqual(badgeRect.x);
    expect(result.bounds.x + result.bounds.width).toBeGreaterThanOrEqual(badgeRect.x + badgeRect.width);
    expect(result.bounds.y + result.bounds.height).toBeGreaterThanOrEqual(badge.y + 14);
    const left = byId(result).get("left");
    const right = byId(result).get("right");
    if (left && right) {
      expect(badgeRect.x).toBeGreaterThan(left.x + left.width);
      expect(badgeRect.x + badgeRect.width).toBeLessThan(right.x);
    }
  });

  it("handles a deep chain of 2,000 rows without recursion and 500 mixed sizes without overlap", () => {
    let chain = node("deep-1999");
    for (let index = 1998; index >= 0; index -= 1) chain = node(`deep-${index}`, chain);
    const deep = layoutTree(chain, new Map(), new Set(), "hierarchy");
    expect(deep.nodes).toHaveLength(2000);
    expect(deep.edges).toHaveLength(1999);
    expect(deep.nodes[1999]?.y).toBeGreaterThan(100_000);
    expect(deep.nodes.every(item => centerX(item) === 0)).toBe(true);

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
    const result = layoutTree(wide, measurements, new Set(), "hierarchy");
    expect(result.nodes).toHaveLength(500);
    expectHierarchy(result, wide);
  });

  it("uses finite defaults, leaves the input untouched and rejects duplicate identities", () => {
    const result = layoutTree(node("root", node("child")), new Map([
      ["root", { width: NaN, height: -20 }],
      ["child", { width: Infinity, height: 0 }],
    ]), new Set(), "hierarchy");
    expectHierarchy(result, node("root", node("child")));
    expect(result.nodes.every(item => item.width > 0 && item.height > 0)).toBe(true);
    const before = JSON.stringify(tree);
    layoutTree(tree, sizes, new Set(["a"]), "hierarchy");
    expect(JSON.stringify(tree)).toBe(before);
    expect(() => layoutTree(node("root", node("same"), node("same")), new Map(), new Set(), "hierarchy")).toThrow(/duplicate/iu);
  });
});

describe("hierarchy layout of the fixtures", () => {
  // Sizes come from the estimate the layout benchmark uses too (no DOM in this layer).
  it("lays out uneven-branches: 24 siblings in order, an 8-deep chain in 8 rows and long Japanese without overlap", () => {
    const source = readFileSync(new URL("../fixtures/uneven-branches.md", import.meta.url), "utf8");
    const doc = parseMarkdown(source, "uneven-branches");
    const { root } = projectMap(doc);
    const result = layoutTree(root, estimateNodeSizes(doc.nodes), new Set(), "hierarchy");
    expectHierarchy(result, root);
    const positions = byId(result);
    const titles = new Map(doc.nodes.map(item => [item.id, item.title]));
    const siblings = result.nodes.filter(item => /^兄弟 \d+$/u.test(titles.get(item.id) ?? ""));
    expect(siblings).toHaveLength(24);
    const ordered = [...siblings].sort((first, second) => first.x - second.x).map(item => titles.get(item.id));
    expect(ordered).toEqual(Array.from({ length: 24 }, (_, index) => `兄弟 ${index + 1}`));
    expect(new Set(siblings.map(item => item.y)).size).toBe(1);
    // The 8-deep chain hangs link by link: each row one gap under the previous node, and the last one lowest of all.
    const chain = ["深い一列の枝", "二段目", "三段目", "四段目", "五段目", "六段目", "七段目（従来の見出し形式では作れない深さ）", "八段目"]
      .map(title => result.nodes.find(item => titles.get(item.id) === title));
    expect(chain.every(item => item !== undefined)).toBe(true);
    chain.forEach((item, index) => {
      const above = index === 0 ? positions.get(root.id) : chain[index - 1];
      if (item && above) expect(item.y).toBe(above.y + above.height + gapBelow(index));
    });
    const eighth = chain[chain.length - 1];
    if (eighth) expect(eighth.y).toBe(Math.max(...result.nodes.map(item => item.y)));
    const long = result.nodes.filter(item => (titles.get(item.id)?.length ?? 0) > 40);
    expect(long.length).toBeGreaterThanOrEqual(2);
    expect(long.every(item => item.width === 360)).toBe(true);
    // The wide branch is centered over its two children (one short, one as wide as itself).
    const parent = doc.nodes.find(item => item.title.startsWith("長い日本語"));
    expect(parent?.children.map(child => child.title.length)).toEqual([2, expect.any(Number)]);
    const wide = parent ? positions.get(parent.id) : undefined;
    const first = parent?.children[0] ? positions.get(parent.children[0].id) : undefined;
    const last = parent?.children[1] ? positions.get(parent.children[1].id) : undefined;
    expect(wide && first && last).toBeTruthy();
    if (!wide || !first || !last) return;
    expect(centerX(wide)).toBeCloseTo((first.x + last.x + last.width) / 2, 6);
    expect(last.x - (first.x + first.width)).toBe(SIBLING_GAP);
  });

  it.each(performanceNodeCounts)("lays out the %s node performance fixture with aligned rows and no overlap", count => {
    const [, source] = makePerformanceFixture(count);
    const doc = parseMarkdown(source, `performance-${count}`);
    const { root } = projectMap(doc);
    const result = layoutTree(root, estimateNodeSizes(doc.nodes), new Set(), "hierarchy");
    expect(result.nodes).toHaveLength(count);
    expectHierarchy(result, root);
    const collapsed = new Set(root.children.slice(0, Math.ceil(root.children.length / 2)).map(item => item.id));
    const folded = layoutTree(root, estimateNodeSizes(doc.nodes), collapsed, "hierarchy");
    expectHierarchy(folded, root, collapsed);
    expect(folded.nodes.length).toBeLessThan(result.nodes.length);
    expect(folded.folds.filter(fold => collapsed.has(fold.id))).toHaveLength(collapsed.size);
  });
});
