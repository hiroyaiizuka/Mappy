import { describe, expect, it } from "vitest";
import { layoutTree, type LayoutNode, type LayoutResult, type NodeSize } from "../../src/layout/layout";

function node(id: string, ...children: LayoutNode[]): LayoutNode {
  return { id, children };
}

function expectDisjoint(result: LayoutResult): void {
  for (let index = 0; index < result.nodes.length; index += 1) {
    const first = result.nodes[index];
    if (!first) continue;
    expect(Number.isFinite(first.x + first.y + first.width + first.height)).toBe(true);
    expect(first.x).toBeGreaterThanOrEqual(result.bounds.x);
    expect(first.y).toBeGreaterThanOrEqual(result.bounds.y);
    expect(first.x + first.width).toBeLessThanOrEqual(result.bounds.x + result.bounds.width);
    expect(first.y + first.height).toBeLessThanOrEqual(result.bounds.y + result.bounds.height);
    for (let other = index + 1; other < result.nodes.length; other += 1) {
      const second = result.nodes[other];
      if (!second) continue;
      const overlap = first.x < second.x + second.width
        && first.x + first.width > second.x
        && first.y < second.y + second.height
        && first.y + first.height > second.y;
      if (overlap) throw new Error(`Overlapping nodes: ${first.id}, ${second.id}`);
    }
  }
  expect(result.edges).toHaveLength(result.nodes.length - 1);
  for (const edge of result.edges) {
    expect(result.nodes.some((item) => item.id === edge.from)).toBe(true);
    expect(result.nodes.some((item) => item.id === edge.to)).toBe(true);
    expect(edge.path).toMatch(/^M /u);
    expect(edge.path).not.toMatch(/NaN|Infinity|undefined/u);
  }
}

describe("tree layout", () => {
  const tree = node("root", node("a", node("a1"), node("a2", node("a21"))), node("b"), node("c", node("c1")));
  const sizes: ReadonlyMap<string, NodeSize> = new Map([
    ["root", { width: 220, height: 70 }],
    ["a", { width: 80, height: 260 }],
    ["a1", { width: 410, height: 55 }],
    ["a21", { width: 175, height: 300 }],
    ["b", { width: 380, height: 190 }],
    ["c1", { width: 290, height: 30 }],
  ]);

  it("places unequal rightward subtrees without overlap and preserves measurements", () => {
    const result = layoutTree(tree, sizes, new Set(), "mindmap");
    expectDisjoint(result);
    for (const edge of result.edges) {
      const parent = result.nodes.find((item) => item.id === edge.from);
      const child = result.nodes.find((item) => item.id === edge.to);
      expect(parent).toBeDefined();
      expect(child).toBeDefined();
      if (parent && child) expect(child.x).toBeGreaterThan(parent.x + parent.width);
    }
    expect(result.nodes.find((item) => item.id === "a")).toMatchObject({ width: 80, height: 260 });
    expect(result.nodes.find((item) => item.id === "b")?.y)
      .toBeGreaterThan(result.nodes.find((item) => item.id === "a")?.y ?? Infinity);
  });

  it("puts main topics on one horizontal axis and alternates descendants above and below", () => {
    const result = layoutTree(tree, sizes, new Set(), "timeline");
    expectDisjoint(result);
    const positions = new Map(result.nodes.map((item) => [item.id, item]));
    for (const id of ["root", "a", "b", "c"]) {
      const item = positions.get(id);
      expect(item).toBeDefined();
      if (item) expect(item.y + item.height / 2).toBe(0);
    }
    const alternating = layoutTree(node("r", node("u", node("u1")), node("d", node("d1"))), sizes, new Set(), "timeline");
    const upper = alternating.nodes.find((item) => item.id === "u1");
    const lower = alternating.nodes.find((item) => item.id === "d1");
    expect(upper).toBeDefined();
    expect(lower).toBeDefined();
    if (upper && lower) {
      expect(upper.y + upper.height).toBeLessThan(0);
      expect(lower.y).toBeGreaterThan(0);
    }
    expect(positions.get("b")?.x).toBeLessThan(positions.get("a21")?.x ?? -Infinity);
    expect(positions.get("c")?.x).toBeGreaterThan(positions.get("b")?.x ?? Infinity);
  });

  it("joins the center of node edges without extending beneath text", () => {
    const result = layoutTree(node("parent", node("child")), new Map([
      ["parent", { width: 100, height: 30 }],
      ["child", { width: 70, height: 20 }],
    ]), new Set(), "mindmap");
    const parent = result.nodes[0];
    const child = result.nodes[1];
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    if (!parent || !child) return;
    expect(result.edges[0]?.path).toBe(
      `M ${parent.x + parent.width} ${parent.y + parent.height / 2} H 140 V ${child.y + child.height / 2} H ${child.x}`,
    );
  });

  it("puts expanded map controls on the common stem where every child branch starts", () => {
    const result = layoutTree(node("parent", node("child1"), node("child2")), new Map(), new Set(), "mindmap");
    const parent = result.nodes[0];
    expect(parent).toBeDefined();
    if (!parent) return;
    const x = parent.x + parent.width + 40;
    const y = parent.y + parent.height / 2;
    expect(result.folds).toEqual([{ id: "parent", x, y }]);
    expect(result.edges.every(edge => edge.path.startsWith(`M ${parent.x + parent.width} ${y} H ${x} V `))).toBe(true);
  });

  it("uses spacious orthogonal map stems with matching fold controls at each depth", () => {
    const result = layoutTree(node("root", node("a", node("a1"), node("a2")), node("b", node("b1"))), new Map(), new Set(), "mindmap");
    expectDisjoint(result);
    const positions = new Map(result.nodes.map(item => [item.id, item]));
    const folds = new Map(result.folds.map(item => [item.id, item]));
    expect(result.edges.every(edge => !/[CQ]/u.test(edge.path))).toBe(true);
    for (const edge of result.edges) {
      const parent = positions.get(edge.from)!;
      const child = positions.get(edge.to)!;
      const gap = edge.from === "root" ? 80 : 56;
      expect(child.x - parent.x - parent.width).toBe(gap);
      const stemX = parent.x + parent.width + gap / 2;
      const centerY = parent.y + parent.height / 2;
      expect(folds.get(parent.id)).toEqual({ id: parent.id, x: stemX, y: centerY });
      expect(edge.path).toBe(`M ${parent.x + parent.width} ${centerY} H ${stemX} V ${child.y + child.height / 2} H ${child.x}`);
    }
    const first = positions.get("a1")!;
    const second = positions.get("a2")!;
    expect(second.y - first.y - first.height).toBeGreaterThanOrEqual(22);
  });

  it.each(["mindmap", "timeline"] as const)("retains a collapsed root control and fits its four-digit count in %s", mode => {
    const tree = node("root", ...Array.from({ length: 1000 }, (_, index) => node(`hidden-${index}`)));
    const result = layoutTree(tree, new Map([["root", { width: 100, height: 20 }]]), new Set(["root"]), mode);
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toEqual([]);
    const root = result.nodes[0];
    const fold = result.folds[0];
    expect(fold).toBeDefined();
    if (!root || !fold) return;
    expect(result.folds).toEqual([{ id: "root", x: root.x + root.width + 22, y: root.y + root.height / 2 }]);
    expect(fold.x - 18).toBeGreaterThanOrEqual(root.x + root.width + 4);
    expect(result.bounds.x + result.bounds.width).toBeGreaterThanOrEqual(fold.x + 18);
    expect(result.bounds.y).toBeLessThanOrEqual(fold.y - 14);
    expect(result.bounds.y + result.bounds.height).toBeGreaterThanOrEqual(fold.y + 14);
  });

  it("places expanded timeline controls on their upper/lower stems and collapsed ones above the stage", () => {
    const tree = node("root", node("upper", node("u")), node("lower", node("l")), node("closed", node("c")));
    const result = layoutTree(tree, new Map(), new Set(["closed"]), "timeline");
    const nodes = new Map(result.nodes.map(item => [item.id, item]));
    const folds = new Map(result.folds.map(item => [item.id, item]));
    for (const id of ["upper", "lower", "closed"]) {
      const stage = nodes.get(id);
      expect(stage).toBeDefined();
      if (!stage) continue;
      const expectedY = id === "lower" ? stage.y + stage.height + 12 : stage.y - 12;
      expect(folds.get(id)).toEqual({ id, x: stage.x + stage.width / 2, y: expectedY });
    }
    expect(folds.has("u")).toBe(false);
    expect(folds.has("l")).toBe(false);
    expect(folds.has("c")).toBe(false);
    expect(folds.has("root")).toBe(true);
  });

  it("keeps four-digit badges clear of the next same-side stem and stage-top badges clear of forests", () => {
    const tree = node("root",
      node("upper", node("closed-descendant", ...Array.from({ length: 1000 }, (_, index) => node(`hidden-${index}`)))),
      node("closed-stage", node("stage-child")),
      node("next-upper", node("next-child")),
    );
    const result = layoutTree(tree, new Map([
      ["closed-descendant", { width: 600, height: 18 }],
      ["closed-stage", { width: 24, height: 44 }],
      ["next-upper", { width: 24, height: 44 }],
    ]), new Set(["closed-descendant", "closed-stage"]), "timeline");
    const nodes = new Map(result.nodes.map(item => [item.id, item]));
    const folds = new Map(result.folds.map(item => [item.id, item]));
    const descendant = nodes.get("closed-descendant");
    const descendantFold = folds.get("closed-descendant");
    const nextStage = nodes.get("next-upper");
    const closedStageFold = folds.get("closed-stage");
    expect(descendant && descendantFold && nextStage && closedStageFold).toBeTruthy();
    if (!descendant || !descendantFold || !nextStage || !closedStageFold) return;
    const nextStemX = nextStage.x + nextStage.width / 2;
    expect(nextStemX - 14).toBeGreaterThan(descendantFold.x + 18);
    expect(descendant.y + descendant.height).toBeLessThan(closedStageFold.y - 14);
    expect(descendantFold.y + 14).toBeLessThan(closedStageFold.y - 14);
  });

  it("reuses the opposite side's horizontal span while keeping same-side forests apart", () => {
    const tree = node("root",
      node("upper", node("upper-child", node("upper-grandchild"))),
      node("lower", node("lower-child", node("lower-grandchild"))),
      node("upper-next", node("upper-next-child")),
    );
    const measurements = new Map<string, NodeSize>([
      ["root", { width: 140, height: 30 }],
      ["upper", { width: 110, height: 26 }],
      ["lower", { width: 120, height: 300 }],
      ["upper-next", { width: 80, height: 22 }],
      ["upper-child", { width: 160, height: 30 }],
      ["upper-grandchild", { width: 500, height: 24 }],
      ["lower-child", { width: 130, height: 28 }],
      ["lower-grandchild", { width: 450, height: 26 }],
    ]);
    const result = layoutTree(tree, measurements, new Set(), "timeline");
    expectDisjoint(result);
    const positions = new Map(result.nodes.map(item => [item.id, item]));
    const upper = positions.get("upper");
    const upperChild = positions.get("upper-child");
    const upperEnd = positions.get("upper-grandchild");
    const lowerChild = positions.get("lower-child");
    const nextChild = positions.get("upper-next-child");
    expect(upper && upperChild && upperEnd && lowerChild && nextChild).toBeTruthy();
    if (!upper || !upperChild || !upperEnd || !lowerChild || !nextChild) return;
    expect(upperChild.x - (upper.x + upper.width / 2)).toBe(20);
    expect(lowerChild.x).toBeLessThan(upperEnd.x + upperEnd.width);
    expect(nextChild.x).toBeGreaterThan(upperEnd.x + upperEnd.width);
    expect(upperChild.y + upperChild.height).toBeLessThan(-150);
    expect(lowerChild.y).toBeGreaterThan(150);
    expect(result.edges.every(edge => !edge.path.includes(" C "))).toBe(true);
    const upperEdge = result.edges.find(edge => edge.to === "upper-child");
    expect(upperEdge?.path).toBe(
      `M ${upper.x + upper.width / 2} ${upper.y} V ${upperChild.y + upperChild.height / 2} H ${upperChild.x}`,
    );
  });

  it("keeps timeline stems outside text and ends every branch at the child center", () => {
    const tree = node("root",
      node("upper", node("u1"), node("u2", node("u21"), node("u22"))),
      node("lower", node("l1"), node("l2", node("l21"), node("l22"))),
    );
    const measurements = new Map<string, NodeSize>([
      ["root", { width: 210, height: 80 }],
      ["upper", { width: 140, height: 48 }],
      ["lower", { width: 150, height: 52 }],
      ["u1", { width: 300, height: 70 }],
      ["l2", { width: 200, height: 56 }],
    ]);
    const result = layoutTree(tree, measurements, new Set(), "timeline");
    expectDisjoint(result);
    const positions = new Map(result.nodes.map(item => [item.id, item]));
    for (const edge of result.edges) {
      if (edge.from === "root") continue;
      const parent = positions.get(edge.from);
      const child = positions.get(edge.to);
      expect(parent).toBeDefined();
      expect(child).toBeDefined();
      if (!parent || !child) continue;
      const endY = child.y + child.height / 2;
      if (edge.from === "upper" || edge.from === "lower") {
        const startY = edge.from === "upper" ? parent.y : parent.y + parent.height;
        expect(edge.path).toBe(`M ${parent.x + parent.width / 2} ${startY} V ${endY} H ${child.x}`);
      } else {
        const startX = parent.x + parent.width;
        const startY = parent.y + parent.height / 2;
        expect(edge.path).toBe(`M ${startX} ${startY} H ${(startX + child.x) / 2} V ${endY} H ${child.x}`);
      }
    }
  });

  it("draws nonoverlapping horizontal axis segments while retaining parent identities", () => {
    const tree = node("root", node("a"), node("b"), node("c"));
    const result = layoutTree(tree, new Map(), new Set(), "timeline");
    let previousRight = result.nodes[0]?.width ?? 0;
    for (const stage of result.nodes.slice(1)) {
      const edge = result.edges.find(edge => edge.to === stage.id);
      expect(edge?.from).toBe("root");
      expect(edge?.path).toBe(`M ${previousRight} 0 H ${stage.x}`);
      expect(stage.x).toBeGreaterThan(previousRight);
      previousRight = stage.x + stage.width;
    }
  });

  it.each(["mindmap", "timeline"] as const)("removes collapsed descendants and their edges in %s", (mode) => {
    const expanded = layoutTree(tree, sizes, new Set(), mode);
    const collapsed = layoutTree(tree, sizes, new Set(["a"]), mode);
    expectDisjoint(collapsed);
    expect(collapsed.nodes.map((item) => item.id)).toEqual(["root", "a", "b", "c", "c1"]);
    expect(collapsed.bounds.width * collapsed.bounds.height).toBeLessThan(expanded.bounds.width * expanded.bounds.height);
    expect(layoutTree(tree, sizes, new Set(["root"]), mode).nodes).toHaveLength(1);
  });

  it.each(["mindmap", "timeline"] as const)("handles 500 nodes of mixed sizes without overlap in %s", (mode) => {
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
    const result = layoutTree(node("root", ...branches), measurements, new Set(), mode);
    expect(result.nodes).toHaveLength(500);
    expectDisjoint(result);
  });

  it("handles a deep tree without recursive stack dependence", () => {
    let tree = node("deep-1999");
    for (let index = 1998; index >= 0; index -= 1) tree = node(`deep-${index}`, tree);
    const result = layoutTree(tree, new Map(), new Set(), "mindmap");
    expect(result.nodes).toHaveLength(2000);
    expect(result.edges).toHaveLength(1999);
    expect(result.nodes[1999]?.x).toBeGreaterThan(100_000);
  });

  it("uses finite default dimensions when measurements are missing or unusable", () => {
    const result = layoutTree(node("root", node("child")), new Map([
      ["root", { width: NaN, height: -20 }],
      ["child", { width: Infinity, height: 0 }],
    ]), new Set(), "mindmap");
    expectDisjoint(result);
    expect(result.nodes.every((item) => item.width > 0 && item.height > 0)).toBe(true);
  });

  it("does not mutate the input and rejects duplicate identities", () => {
    const before = JSON.stringify(tree);
    layoutTree(tree, sizes, new Set(["a"]), "timeline");
    expect(JSON.stringify(tree)).toBe(before);
    expect(() => layoutTree(node("root", node("same"), node("same")), new Map(), new Set(), "mindmap"))
      .toThrow(/duplicate/iu);
  });
});
