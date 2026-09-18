import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMarkdown, projectMap, type MindNode } from "../../src/core/markdown";
import { foldBadgeWidth, layoutTree, type LayoutNode, type LayoutResult, type NodeSize, type PositionedNode } from "../../src/layout/layout";
import { pathToPoints } from "../../src/layout/path-points";
import { makePerformanceFixture, performanceNodeCounts } from "../../scripts/performance-fixtures.mjs";

const ROOT_GAP = 64;
const ROW_GAP = 48;
const SIBLING_GAP = 24;

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

/** Depth of every node in the source tree, so rows can be checked against the tree rather than the layout. */
function depths(root: LayoutNode): Map<string, number> {
  const result = new Map<string, number>();
  const pending: { node: LayoutNode; depth: number }[] = [{ node: root, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    result.set(current.node.id, current.depth);
    for (const child of current.node.children) pending.push({ node: child, depth: current.depth + 1 });
  }
  return result;
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
 * The issue-tree invariants: nodes and fold controls disjoint and inside the bounds,
 * one row per depth with the tallest node setting the row height, siblings and cousins
 * in source order from left to right, and every connector made of axis-aligned
 * segments that start at the parent's bottom center, end at the child's top center and
 * never cross a node.
 */
function expectIssueTree(result: LayoutResult, root: LayoutNode, collapsed: ReadonlySet<string> = new Set()): void {
  const positions = byId(result);
  const depthOf = depths(root);
  // Fold controls count with their smallest hit area; wider badges are checked where they are collapsed.
  const rects = [...result.nodes, ...result.folds.map(fold => ({ id: `fold:${fold.id}`, x: fold.x - 14, y: fold.y - 14, width: 28, height: 28 }))];
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

  // Rows: same y per depth, each row below the previous one by at least the gap.
  const rowTop = new Map<number, number>();
  const rowBottom = new Map<number, number>();
  for (const item of result.nodes) {
    const depth = depthOf.get(item.id);
    expect(depth).toBeDefined();
    if (depth === undefined) continue;
    const top = rowTop.get(depth);
    if (top === undefined) rowTop.set(depth, item.y);
    else if (top !== item.y) throw new Error(`Node ${item.id} at depth ${depth} sits at y=${item.y} instead of the row's y=${top}`);
    rowBottom.set(depth, Math.max(rowBottom.get(depth) ?? -Infinity, item.y + item.height));
  }
  for (const [depth, top] of rowTop) {
    if (depth === 0) continue;
    const above = rowBottom.get(depth - 1);
    expect(above).toBeDefined();
    if (above !== undefined) expect(top - above).toBeCloseTo(depth === 1 ? ROOT_GAP : ROW_GAP, 6);
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

describe("issue tree layout", () => {
  const tree = node("root", node("a", node("a1"), node("a2", node("a21"))), node("b"), node("c", node("c1")));
  const sizes: ReadonlyMap<string, NodeSize> = new Map([
    ["root", { width: 220, height: 70 }],
    ["a", { width: 80, height: 260 }],
    ["a1", { width: 410, height: 55 }],
    ["a21", { width: 175, height: 300 }],
    ["b", { width: 380, height: 190 }],
    ["c1", { width: 290, height: 30 }],
  ]);

  it("puts the root on top, aligns every depth on one row and keeps siblings in source order", () => {
    const result = layoutTree(tree, sizes, new Set(), "issue-tree");
    expectIssueTree(result, tree);
    const positions = byId(result);
    const root = positions.get("root");
    expect(root).toBeDefined();
    if (!root) return;
    expect(root.y).toBe(0);
    expect(centerX(root)).toBe(0);
    expect(result.origin).toEqual({ x: root.x, y: root.y });
    // Rows take the tallest node: `a` (260) sets the first row, `a21` (300) the second.
    const first = ["a", "b", "c"].map(id => positions.get(id));
    const second = ["a1", "a2", "c1"].map(id => positions.get(id));
    expect(first.every(item => item?.y === 70 + ROOT_GAP)).toBe(true);
    expect(second.every(item => item?.y === 70 + ROOT_GAP + 260 + ROW_GAP)).toBe(true);
    expect(positions.get("a21")?.y).toBe(70 + ROOT_GAP + 260 + ROW_GAP + 55 + ROW_GAP);
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
    ]), new Set(), "issue-tree");
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

  it("draws each branch as stem, bus and drop, with one bus height per depth and no line under text", () => {
    const result = layoutTree(tree, sizes, new Set(), "issue-tree");
    const positions = byId(result);
    const busByDepth = new Map<number, number>();
    const depthOf = depths(tree);
    for (const edge of result.edges) {
      const parent = positions.get(edge.from);
      const child = positions.get(edge.to);
      expect(parent && child).toBeTruthy();
      if (!parent || !child) continue;
      const depth = depthOf.get(parent.id) ?? -1;
      const busY = child.y - (depth === 0 ? ROOT_GAP : ROW_GAP) / 2;
      expect(edge.path).toBe(`M ${centerX(parent)} ${parent.y + parent.height} V ${busY} H ${centerX(child)} V ${child.y}`);
      expect(busByDepth.get(depth) ?? busY).toBe(busY);
      busByDepth.set(depth, busY);
      expect(busY).toBeGreaterThan(parent.y + parent.height);
      expect(edge.path).not.toMatch(/[CQ]/u);
    }
    // `a` is the tallest of its row: the bus above the next row still clears it.
    const a = positions.get("a");
    expect(a).toBeDefined();
    if (a) expect(busByDepth.get(1)).toBe(a.y + a.height + ROW_GAP / 2);
  });

  it("puts expanded controls on the junction below the parent and collapsed badges under the node", () => {
    const expanded = layoutTree(tree, sizes, new Set(), "issue-tree");
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
    const collapsed = layoutTree(tree, sizes, new Set(["a"]), "issue-tree");
    expectIssueTree(collapsed, tree, new Set(["a"]));
    expect(collapsed.nodes.map(item => item.id)).toEqual(["root", "a", "b", "c", "c1"]);
    const a = byId(collapsed).get("a");
    const badge = collapsed.folds.find(fold => fold.id === "a");
    expect(a && badge).toBeTruthy();
    if (!a || !badge) return;
    expect(badge).toEqual({ id: "a", x: centerX(a), y: a.y + a.height + 16 });
    expect(collapsed.bounds.width * collapsed.bounds.height).toBeLessThan(expanded.bounds.width * expanded.bounds.height);
    expect(layoutTree(tree, sizes, new Set(["root"]), "issue-tree").nodes).toHaveLength(1);
    // Re-expanding restores exactly the layout from before the fold.
    expect(layoutTree(tree, sizes, new Set(), "issue-tree")).toEqual(expanded);
  });

  it("keeps a four-digit badge inside the bounds and clear of neighbouring branches", () => {
    const many = node("closed", ...Array.from({ length: 1000 }, (_, index) => node(`hidden-${index}`)));
    const root = node("root", node("left", node("l1")), many, node("right", node("r1")));
    const result = layoutTree(root, new Map([
      ["closed", { width: 20, height: 24 }],
      ["left", { width: 20, height: 24 }],
      ["right", { width: 20, height: 24 }],
    ]), new Set(["closed"]), "issue-tree");
    expectIssueTree(result, root, new Set(["closed"]));
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
    const deep = layoutTree(chain, new Map(), new Set(), "issue-tree");
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
    const result = layoutTree(wide, measurements, new Set(), "issue-tree");
    expect(result.nodes).toHaveLength(500);
    expectIssueTree(result, wide);
  });

  it("uses finite defaults, leaves the input untouched and rejects duplicate identities", () => {
    const result = layoutTree(node("root", node("child")), new Map([
      ["root", { width: NaN, height: -20 }],
      ["child", { width: Infinity, height: 0 }],
    ]), new Set(), "issue-tree");
    expectIssueTree(result, node("root", node("child")));
    expect(result.nodes.every(item => item.width > 0 && item.height > 0)).toBe(true);
    const before = JSON.stringify(tree);
    layoutTree(tree, sizes, new Set(["a"]), "issue-tree");
    expect(JSON.stringify(tree)).toBe(before);
    expect(() => layoutTree(node("root", node("same"), node("same")), new Map(), new Set(), "issue-tree")).toThrow(/duplicate/iu);
  });
});

describe("issue tree layout of the fixtures", () => {
  /** Roughly what the DOM measures: 14px per character, wrapped at the node's 360px maximum. */
  function estimateSizes(nodes: readonly MindNode[]): Map<string, NodeSize> {
    const sizes = new Map<string, NodeSize>();
    for (const item of nodes) {
      const text = Math.max(1, item.title.length) * 14 + 16;
      const lines = Math.ceil(text / 344);
      sizes.set(item.id, { width: Math.min(360, text), height: 22 * lines + 8 });
    }
    return sizes;
  }

  it("lays out uneven-branches: 24 siblings in order, an 8-deep chain in 8 rows and long Japanese without overlap", () => {
    const source = readFileSync(new URL("../fixtures/uneven-branches.md", import.meta.url), "utf8");
    const doc = parseMarkdown(source, "uneven-branches");
    const { root } = projectMap(doc);
    const result = layoutTree(root, estimateSizes(doc.nodes), new Set(), "issue-tree");
    expectIssueTree(result, root);
    const positions = byId(result);
    const titles = new Map(doc.nodes.map(item => [item.id, item.title]));
    const siblings = result.nodes.filter(item => /^兄弟 \d+$/u.test(titles.get(item.id) ?? ""));
    expect(siblings).toHaveLength(24);
    const ordered = [...siblings].sort((first, second) => first.x - second.x).map(item => titles.get(item.id));
    expect(ordered).toEqual(Array.from({ length: 24 }, (_, index) => `兄弟 ${index + 1}`));
    expect(new Set(siblings.map(item => item.y)).size).toBe(1);
    const eighth = result.nodes.find(item => titles.get(item.id) === "八段目");
    const rows = new Set(result.nodes.map(item => item.y));
    expect(eighth).toBeDefined();
    expect(rows.size).toBe(9);
    if (eighth) expect(eighth.y).toBe(Math.max(...rows));
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
    const result = layoutTree(root, estimateSizes(doc.nodes), new Set(), "issue-tree");
    expect(result.nodes).toHaveLength(count);
    expectIssueTree(result, root);
    const collapsed = new Set(root.children.slice(0, Math.ceil(root.children.length / 2)).map(item => item.id));
    const folded = layoutTree(root, estimateSizes(doc.nodes), collapsed, "issue-tree");
    expectIssueTree(folded, root, collapsed);
    expect(folded.nodes.length).toBeLessThan(result.nodes.length);
    expect(folded.folds.filter(fold => collapsed.has(fold.id))).toHaveLength(collapsed.size);
  });
});
