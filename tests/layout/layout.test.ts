import { describe, expect, it } from "vitest";
import { TIMELINE_STAGE_CLEARANCE, foldControlSize, layoutTree, type LayoutNode, type LayoutResult, type NodeSize } from "../../src/layout/layout";

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

  it.each(["mindmap", "timeline", "hierarchy", "balanced"] as const)("removes collapsed descendants and their edges in %s", (mode) => {
    const expanded = layoutTree(tree, sizes, new Set(), mode);
    const collapsed = layoutTree(tree, sizes, new Set(["a"]), mode);
    expectDisjoint(collapsed);
    expect(collapsed.nodes.map((item) => item.id)).toEqual(["root", "a", "b", "c", "c1"]);
    expect(collapsed.bounds.width * collapsed.bounds.height).toBeLessThan(expanded.bounds.width * expanded.bounds.height);
    expect(layoutTree(tree, sizes, new Set(["root"]), mode).nodes).toHaveLength(1);
  });

  it.each(["mindmap", "timeline", "hierarchy", "balanced"] as const)("handles 500 nodes of mixed sizes without overlap in %s", (mode) => {
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

describe("free topics", () => {
  const body = node("root", node("a", node("a1"), node("a2")), node("b"));
  const bodySizes: ReadonlyMap<string, NodeSize> = new Map([
    ["root", { width: 200, height: 60 }],
    ["a1", { width: 300, height: 40 }],
    ["b", { width: 120, height: 90 }],
    ["t1", { width: 180, height: 50 }],
    ["t1a", { width: 240, height: 30 }],
    ["t2", { width: 90, height: 40 }],
  ]);
  const topics = [
    { tree: node("t1", node("t1a"), node("t1b")), position: null },
    { tree: node("t2"), position: null },
    { tree: node("t3", node("t3a")), position: null },
  ];

  function byId(result: LayoutResult): Map<string, LayoutResult["nodes"][number]> {
    return new Map(result.nodes.map(item => [item.id, item]));
  }

  function rectsOverlap(first: LayoutResult["nodes"][number], second: LayoutResult["nodes"][number]): boolean {
    return first.x < second.x + second.width && first.x + first.width > second.x
      && first.y < second.y + second.height && first.y + first.height > second.y;
  }

  it.each(["mindmap", "timeline", "hierarchy", "balanced"] as const)("leaves the body geometry untouched and reports the body root as origin in %s", mode => {
    const alone = layoutTree(body, bodySizes, new Set(), mode);
    const withTopics = layoutTree(body, bodySizes, new Set(), mode, topics);
    const bodyIds = new Set(alone.nodes.map(item => item.id));
    expect(withTopics.nodes.filter(item => bodyIds.has(item.id))).toEqual(alone.nodes);
    expect(withTopics.edges.filter(edge => bodyIds.has(edge.from))).toEqual(alone.edges);
    expect(withTopics.folds.filter(fold => bodyIds.has(fold.id))).toEqual(alone.folds);
    const root = byId(alone).get("root");
    expect(root).toBeDefined();
    if (!root) return;
    expect(alone.origin).toEqual({ x: root.x, y: root.y });
    expect(withTopics.origin).toEqual(alone.origin);
    // Map: root on the left edge. Timeline: axis through y = 0. Hierarchy: root centered on x = 0. Balanced: root centered on (0, 0).
    if (mode === "balanced") expect([root.x + root.width / 2, root.y + root.height / 2]).toEqual([0, 0]);
    else expect(mode === "timeline" ? root.y + root.height / 2 : mode === "hierarchy" ? root.x + root.width / 2 : root.x).toBe(0);
  });

  it.each(["mindmap", "timeline", "hierarchy", "balanced"] as const)("stacks unpositioned topics below the body without overlapping anything and inside the bounds in %s", mode => {
    const alone = layoutTree(body, bodySizes, new Set(), mode);
    const result = layoutTree(body, bodySizes, new Set(), mode, topics);
    expect(result.nodes).toHaveLength(alone.nodes.length + 6);
    expect(result.edges).toHaveLength(alone.edges.length + 3);
    for (let index = 0; index < result.nodes.length; index += 1) {
      for (let other = index + 1; other < result.nodes.length; other += 1) {
        const first = result.nodes[index];
        const second = result.nodes[other];
        if (first && second && rectsOverlap(first, second)) throw new Error(`Overlapping nodes: ${first.id}, ${second.id}`);
      }
    }
    const positions = byId(result);
    const bodyBottom = alone.bounds.y + alone.bounds.height;
    let previousBottom = bodyBottom;
    for (const id of ["t1", "t2", "t3"]) {
      const topic = positions.get(id);
      expect(topic).toBeDefined();
      if (!topic) continue;
      // Source order becomes vertical order: each topic sits below the body and below the previous topic.
      expect(topic.y).toBeGreaterThanOrEqual(previousBottom + 48);
      const subtree = result.nodes.filter(item => item.id.startsWith(id));
      // The topic's tree is flush with the body's left edge; in the hierarchy and the balanced map, whose left edge
      // may be a far-off leaf of the widest row or of the left side, it is centered under the body root instead.
      const left = Math.min(...subtree.map(item => item.x));
      const right = Math.max(...subtree.map(item => item.x + item.width));
      if (mode === "hierarchy" || mode === "balanced") expect((left + right) / 2).toBeCloseTo(alone.origin.x + (byId(alone).get("root")?.width ?? 0) / 2, 6);
      else expect(left).toBe(alone.bounds.x);
      previousBottom = Math.max(...subtree.map(item => item.y + item.height));
      for (const item of subtree) {
        expect(item.x).toBeGreaterThanOrEqual(result.bounds.x);
        expect(item.x + item.width).toBeLessThanOrEqual(result.bounds.x + result.bounds.width);
        expect(item.y + item.height).toBeLessThanOrEqual(result.bounds.y + result.bounds.height);
      }
    }
    // Fold controls of a topic count towards the slot, so the next topic never covers them.
    const t1Fold = result.folds.find(fold => fold.id === "t1");
    const t2 = positions.get("t2");
    expect(t1Fold).toBeDefined();
    if (t1Fold && t2) expect(t2.y).toBeGreaterThanOrEqual(t1Fold.y + 14);
    expect(result.bounds.height).toBeGreaterThan(alone.bounds.height);
  });

  it.each(["mindmap", "timeline", "hierarchy", "balanced"] as const)("puts a positioned topic's root at origin + offset, keeps its tree shape, and includes it in the bounds in %s", mode => {
    const placed = [
      { tree: node("t1", node("t1a"), node("t1b")), position: { x: -400, y: 300 } },
      { tree: node("t2"), position: { x: 900, y: -250 } },
    ];
    const result = layoutTree(body, bodySizes, new Set(), mode, placed);
    const positions = byId(result);
    const t1 = positions.get("t1");
    const t2 = positions.get("t2");
    expect(t1 && t2).toBeTruthy();
    if (!t1 || !t2) return;
    expect({ x: t1.x, y: t1.y }).toEqual({ x: result.origin.x - 400, y: result.origin.y + 300 });
    expect({ x: t2.x, y: t2.y }).toEqual({ x: result.origin.x + 900, y: result.origin.y - 250 });
    expect(t1.width).toBe(180);
    // The topic is laid out like a body of its own: children to the right, same gaps, same edge shapes.
    const alone = layoutTree(node("t1", node("t1a"), node("t1b")), bodySizes, new Set(), mode);
    const shift = { x: t1.x - (alone.nodes[0]?.x ?? 0), y: t1.y - (alone.nodes[0]?.y ?? 0) };
    for (const item of alone.nodes) {
      expect(positions.get(item.id)).toEqual({ ...item, x: item.x + shift.x, y: item.y + shift.y });
    }
    for (const edge of alone.edges) {
      const moved = result.edges.find(candidate => candidate.id === edge.id);
      expect(moved?.path).toBe(edge.path.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)|([HV]) (-?\d+(?:\.\d+)?)/gu, (match, x, y, axis, value) => {
        if (axis === "H") return `H ${Number(value) + shift.x}`;
        if (axis === "V") return `V ${Number(value) + shift.y}`;
        return x !== undefined ? `${Number(x) + shift.x} ${Number(y) + shift.y}` : match;
      }));
    }
    expect(result.bounds.x).toBeLessThanOrEqual(t1.x);
    expect(result.bounds.y).toBeLessThanOrEqual(t2.y);
    expect(result.bounds.x + result.bounds.width).toBeGreaterThanOrEqual(t2.x + t2.width);
    expect(result.bounds.y + result.bounds.height).toBeGreaterThanOrEqual(Math.max(...result.nodes.map(item => item.y + item.height)));
  });

  it("keeps same-side timeline forests apart when a topic is placed left of the body", () => {
    const topic = { tree: node("t", node("s1", node("s1c")), node("s2", node("s2c")), node("s3", node("s3c"))), position: { x: -3000, y: 0 } };
    const result = layoutTree(body, bodySizes, new Set(), "timeline", [topic]);
    const positions = byId(result);
    const first = positions.get("s1c");
    const third = positions.get("s3");
    expect(first && third).toBeTruthy();
    if (!first || !third) return;
    expect(third.x + third.width / 2).toBeGreaterThanOrEqual(first.x + first.width + TIMELINE_STAGE_CLEARANCE - 1);
    expect(positions.get("s2")?.x).toBeLessThan(0);
  });

  it("places a default topic in the first free slot when a positioned topic already occupies the slot below the body", () => {
    const free = byId(layoutTree(body, bodySizes, new Set(), "mindmap", [{ tree: node("t2"), position: null }])).get("t2");
    const origin = layoutTree(body, bodySizes, new Set(), "mindmap").origin;
    expect(free).toBeDefined();
    if (!free) return;
    const blocker = { tree: node("blocker"), position: { x: free.x - origin.x, y: free.y - origin.y } };
    const result = layoutTree(body, bodySizes, new Set(), "mindmap", [blocker, { tree: node("t2"), position: null }]);
    const positions = byId(result);
    const placed = positions.get("blocker");
    const stacked = positions.get("t2");
    expect(placed && stacked).toBeTruthy();
    if (!placed || !stacked) return;
    expect({ x: placed.x, y: placed.y }).toEqual({ x: free.x, y: free.y });
    expect(rectsOverlap(placed, stacked)).toBe(false);
    expect(stacked.y).toBeGreaterThanOrEqual(placed.y + placed.height + 48);
    // A positioned topic far away does not push the default slot further than needed.
    const far = layoutTree(body, bodySizes, new Set(), "mindmap", [{ tree: node("far"), position: { x: 0, y: 5000 } }, { tree: node("t2"), position: null }]);
    expect(byId(far).get("t2")?.y).toBe(free.y);
  });

  it("collapses topics like any branch and rejects an identity shared between the body and a topic", () => {
    const result = layoutTree(body, bodySizes, new Set(["t1"]), "mindmap", topics);
    expect(result.nodes.some(item => item.id === "t1a")).toBe(false);
    expect(result.folds.some(fold => fold.id === "t1")).toBe(true);
    expect(() => layoutTree(body, bodySizes, new Set(), "mindmap", [{ tree: node("a"), position: null }])).toThrow(/duplicate/iu);
  });
});

describe("timeline stage clearance", () => {
  /** Every id in `tree` below its root. */
  function descendantIds(tree: LayoutNode): string[] {
    return tree.children.flatMap(child => [child.id, ...descendantIds(child)]);
  }

  function descendantCount(tree: LayoutNode): number {
    return tree.children.reduce((count, child) => count + 1 + descendantCount(child), 0);
  }

  function find(tree: LayoutNode, id: string): LayoutNode | undefined {
    if (tree.id === id) return tree;
    for (const child of tree.children) {
      const found = find(child, id);
      if (found) return found;
    }
    return undefined;
  }

  /** The right edge of everything a stage's forest draws: its nodes and their fold controls (a collapsed one shows its count). */
  function forestRight(result: LayoutResult, tree: LayoutNode, stage: LayoutNode, collapsed: ReadonlySet<string>): number {
    const ids = new Set(descendantIds(stage));
    let right = -Infinity;
    for (const item of result.nodes) if (ids.has(item.id)) right = Math.max(right, item.x + item.width);
    for (const fold of result.folds) {
      if (!ids.has(fold.id)) continue;
      const source = find(tree, fold.id);
      const count = source && collapsed.has(fold.id) ? descendantCount(source) : 0;
      right = Math.max(right, fold.x + foldControlSize(count).width / 2);
    }
    return right;
  }

  const hidden = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => node(`${prefix}-${index}`));
  const deep = (prefix: string, depth: number): LayoutNode => depth === 0 ? node(prefix) : node(`${prefix}-${depth}`, deep(prefix, depth - 1));

  // The shapes a user builds a stage's forest from: mixed widths, a collapsed branch whose count badge
  // is the rightmost thing drawn, an image node, and a deep chain.
  const forests: Record<string, { children: LayoutNode[]; sizes: [string, NodeSize][]; collapsed: string[] }> = {
    "mixed widths": {
      children: [node("w1"), node("w2", node("w21")), node("w3")],
      sizes: [["w1", { width: 120, height: 30 }], ["w2", { width: 420, height: 30 }], ["w21", { width: 90, height: 30 }], ["w3", { width: 260, height: 60 }]],
      collapsed: [],
    },
    "collapsed branch": {
      children: [node("c1"), node("closed", ...hidden("h", 1000))],
      sizes: [["c1", { width: 140, height: 30 }], ["closed", { width: 400, height: 30 }]],
      collapsed: ["closed"],
    },
    "image node": {
      children: [node("img"), node("i2")],
      sizes: [["img", { width: 360, height: 240 }], ["i2", { width: 110, height: 30 }]],
      collapsed: [],
    },
    "deep branch": {
      children: [deep("d", 6)],
      sizes: [],
      collapsed: [],
    },
  };

  // The cases below compare the layout with the constant, so they follow whatever value it holds; this pins the
  // value itself to the 64–80 px the ticket asks for (about three times the 24 px it replaces, LEV-205), and is
  // what fails if the constant is set back to 24.
  it("keeps the clearance within the range the stage gap was chosen from", () => {
    expect(TIMELINE_STAGE_CLEARANCE).toBeGreaterThanOrEqual(64);
    expect(TIMELINE_STAGE_CLEARANCE).toBeLessThanOrEqual(80);
  });

  for (const [name, forest] of Object.entries(forests)) {
    it.each(["upper", "lower"] as const)(`keeps the next %s stem clear of a ${name} forest`, side => {
      const previous = node("previous", ...forest.children);
      const next = node("next", node("next-child"));
      // Stages alternate upper, lower, upper, …: the forest and the next stage on the same side are two apart,
      // and every forest here is wide enough that the next stem stands exactly the clearance past it.
      const stages = side === "upper"
        ? [previous, node("between", node("between-child")), next]
        : [node("first", node("first-child")), previous, node("between", node("between-child")), next];
      const tree = node("root", ...stages);
      const collapsed = new Set(forest.collapsed);
      const result = layoutTree(tree, new Map(forest.sizes), collapsed, "timeline");
      expectDisjoint(result);
      const stage = result.nodes.find(item => item.id === "next");
      expect(stage).toBeDefined();
      if (!stage) return;
      const stemX = stage.x + stage.width / 2;
      expect(stemX - forestRight(result, tree, previous, collapsed)).toBe(TIMELINE_STAGE_CLEARANCE);
    });
  }
});
