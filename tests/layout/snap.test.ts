import { describe, expect, it } from "vitest";
import { axisBand, layoutTree, type LayoutNode, type LayoutResult } from "../../src/layout/layout";
import { snapSlot, type StagePlace } from "../../src/layout/snap";
import type { PositionedNode } from "../../src/layout/primitives";

const node = (id: string, x: number, y: number, width = 160, height = 44): PositionedNode => ({ id, x, y, width, height });
const rect = (x: number, y: number, width = 120, height = 40) => ({ x, y, width, height });
/** A node of a layout result by id, for the tests that judge a real landing place. */
const nodeOf = (result: LayoutResult, id: string): PositionedNode => {
  const found = result.nodes.find(item => item.id === id);
  if (!found) throw new Error(`Missing ${id}`);
  return found;
};
/** The tree with a new leaf as the last child of `parent`. */
const withChild = (tree: LayoutNode, parent: string): LayoutNode => ({
  id: tree.id,
  children: tree.id === parent ? [...tree.children, { id: "new", children: [] }] : tree.children.map(child => withChild(child, parent)),
});

describe("snapSlot zones follow each layout's geometry", () => {
  const leaf = node("leaf", 100, 100);

  it("a leaf's zone is where its first child would go: right in the map, below in the hierarchy", () => {
    // Map: 8 units of overlap to 72 past the right edge, within 12 of the node vertically.
    expect(snapSlot("mindmap", rect(260 - 8, 100), leaf, [], 1)?.position).toBe("inside");
    expect(snapSlot("mindmap", rect(260 + 72, 100), leaf, [], 1)?.position).toBe("inside");
    expect(snapSlot("mindmap", rect(260 + 73, 100), leaf, [], 1)).toBeNull();
    expect(snapSlot("mindmap", rect(260 - 9, 100), leaf, [], 1)).toBeNull();
    expect(snapSlot("mindmap", rect(300, 100 - 40 - 12), leaf, [], 1)?.position).toBe("inside");
    expect(snapSlot("mindmap", rect(300, 100 - 40 - 13), leaf, [], 1)).toBeNull();
    expect(snapSlot("mindmap", rect(100, 144 + 30), leaf, [], 1)).toBeNull();
    // Hierarchy: the same zone turned downward.
    expect(snapSlot("hierarchy", rect(100, 144 - 8), leaf, [], 1)?.position).toBe("inside");
    expect(snapSlot("hierarchy", rect(100, 144 + 72), leaf, [], 1)?.position).toBe("inside");
    expect(snapSlot("hierarchy", rect(100, 144 + 73), leaf, [], 1)).toBeNull();
    expect(snapSlot("hierarchy", rect(260 + 12, 174), leaf, [], 1)?.position).toBe("inside");
    expect(snapSlot("hierarchy", rect(260 + 13, 174), leaf, [], 1)).toBeNull();
    expect(snapSlot("hierarchy", rect(300, 100), leaf, [], 1)).toBeNull();
  });

  it("the distance is the gap plus the offset across, so the nearer of two leaves wins", () => {
    expect(snapSlot("mindmap", rect(290, 110), leaf, [], 1)?.distance).toBe(30 + Math.abs(130 - 122));
    expect(snapSlot("hierarchy", rect(110, 174), leaf, [], 1)?.distance).toBe(30 + Math.abs(170 - 180));
  });

  it("widening stretches the gap, the overlap and the slack, which keeps the slot already shown", () => {
    expect(snapSlot("mindmap", rect(260 + 130, 100), leaf, [], 2)?.position).toBe("inside");
    expect(snapSlot("mindmap", rect(260 + 145, 100), leaf, [], 2)).toBeNull();
    expect(snapSlot("mindmap", rect(300, 100 - 40 - 24), leaf, [], 2)?.position).toBe("inside");
  });

  it("among children the root must line up with their shared edge and reach along them", () => {
    const parent = node("parent", 0, 100);
    const column = [node("a", 240, 0), node("b", 240, 66), node("c", 240, 132)];
    expect(snapSlot("mindmap", rect(240, 44), parent, column)).toEqual({ targetId: "b", position: "before", distance: 2 });
    expect(snapSlot("mindmap", rect(240 + 24, 44), parent, column)?.targetId).toBe("b");
    expect(snapSlot("mindmap", rect(240 + 25, 44), parent, column)).toBeNull();
    expect(snapSlot("mindmap", rect(240, 132 + 22), parent, column)).toEqual({ targetId: "c", position: "after", distance: 2 });
    expect(snapSlot("mindmap", rect(240, 176 + 12 - 20), parent, column)?.position).toBe("after");
    expect(snapSlot("mindmap", rect(240, 176 + 13 - 20), parent, column)).toBeNull();
    // The hierarchy's row: the same rule with the axes swapped, lined up on the row's top edge.
    const row = [node("a", 0, 200), node("b", 184, 200), node("c", 368, 200)];
    expect(snapSlot("hierarchy", rect(160 - 60, 200), parent, row)).toEqual({ targetId: "b", position: "before", distance: 24 });
    expect(snapSlot("hierarchy", rect(100, 200 + 25), parent, row)).toBeNull();
    expect(snapSlot("hierarchy", rect(368 + 80, 200), parent, row)).toEqual({ targetId: "c", position: "after", distance: 20 });
    // Sorted by position, not by the order given.
    expect(snapSlot("hierarchy", rect(100, 200), parent, [...row].reverse())?.targetId).toBe("b");
  });

  it("on the timeline the root's stages line up by centre on the axis, and a childless stage takes a child on its forest's side", () => {
    const root = node("root", 0, -22);
    const stages = [node("s1", 192, -22), node("s2", 384, -30, 160, 60), node("s3", 576, -22)];
    expect(snapSlot("timeline", rect(368 - 60, -20), root, stages, 1, "root")).toEqual({ targetId: "s2", position: "before", distance: 16 });
    expect(snapSlot("timeline", rect(368 - 60, -20 + 24), root, stages, 1, "root")?.targetId).toBe("s2");
    expect(snapSlot("timeline", rect(368 - 60, -20 + 25), root, stages, 1, "root")).toBeNull();
    // The same row judged as a forest node's children is a column and does not match.
    expect(snapSlot("timeline", rect(368 - 60, -20), root, stages, 1, "forest")).toBeNull();
    // An even stage hangs its forest above the axis, an odd one below; the other side is nothing. Stages of one
    // height keep the band at their own half-height, so the zone is the plain one from the stage's edge.
    const stage = node("s3", 576, -22);
    const upper: StagePlace = { side: "upper", band: 22 };
    const lower: StagePlace = { side: "lower", band: 22 };
    const above = rect(576, -22 - 30 - 40);
    const below = rect(576, 22 + 30);
    expect(snapSlot("timeline", above, stage, [], 1, upper)?.position).toBe("inside");
    expect(snapSlot("timeline", below, stage, [], 1, upper)).toBeNull();
    expect(snapSlot("timeline", below, stage, [], 1, lower)?.position).toBe("inside");
    expect(snapSlot("timeline", above, stage, [], 1, lower)).toBeNull();
    expect(snapSlot("timeline", rect(576, 22 + 72), stage, [], 1, lower)?.position).toBe("inside");
    expect(snapSlot("timeline", rect(576, 22 + 73), stage, [], 1, lower)).toBeNull();
    expect(snapSlot("timeline", rect(576, 22 - 8), stage, [], 1, lower)?.position).toBe("inside");
    expect(snapSlot("timeline", rect(576, 22 - 9), stage, [], 1, lower)).toBeNull();
    // The forest starts a stem's length right of the stage's centre, so the root's left edge is scored against that column.
    expect(snapSlot("timeline", above, stage, [], 1, upper)?.distance).toBe(30 + Math.abs(576 - (576 + 80 + 20)));
    expect(snapSlot("timeline", rect(576 + 80 + 20, -22 - 30 - 40), stage, [], 1, upper)).toEqual({ targetId: "s3", position: "inside", distance: 30 });
    expect(snapSlot("timeline", rect(576 + 160 + 30, -22), stage, [], 1, upper)).toBeNull();
    // A collapsed root has no stage yet: the first goes right of it, like a map child.
    expect(snapSlot("timeline", rect(160 + 30, -22), root, [], 1, "root")?.position).toBe("inside");
    // Deeper nodes hang in a rightward forest: right of a leaf, in a column under a parent.
    const branch = node("branch", 292, -158);
    expect(snapSlot("timeline", rect(292 + 160 + 30, -158), branch, [], 1, "forest")?.position).toBe("inside");
    expect(snapSlot("timeline", rect(508, -100), branch, [node("k1", 508, -158), node("k2", 508, -100)], 1, "forest"))
      .toEqual({ targetId: "k2", position: "before", distance: 20 });
  });
});

describe("snapSlot on the hierarchy's per-parent rows", () => {
  // Root → A (100 tall, like a node with an image) with A1, A2; B with B1; the leaf C. Rows hang from each parent
  // (LEV-46), so A's children sit lower than B's, and C's first child would land one gap under C itself.
  const tree: LayoutNode = {
    id: "root",
    children: [
      { id: "A", children: [{ id: "A1", children: [] }, { id: "A2", children: [] }] },
      { id: "B", children: [{ id: "B1", children: [] }] },
      { id: "C", children: [] },
    ],
  };
  const placed = layoutTree(tree, new Map([["A", { width: 160, height: 100 }]]), new Set(), "hierarchy");
  const byId = new Map(placed.nodes.map(item => [item.id, item]));
  const of = (id: string): PositionedNode => {
    const found = byId.get(id);
    if (!found) throw new Error(`Missing ${id}`);
    return found;
  };
  const kids = (id: string): PositionedNode[] => placed.edges.filter(edge => edge.from === id).map(edge => of(edge.to));

  it("follows each parent's own row: level with B's children it slots among them, 56 lower it slots among A's", () => {
    const [a, b, a1, a2, b1] = [of("A"), of("B"), of("A1"), of("A2"), of("B1")];
    expect(a1.y).toBe(a.y + a.height + 32);
    expect(b1.y).toBe(b.y + b.height + 32);
    expect(a1.y - b1.y).toBe(56);
    expect(snapSlot("hierarchy", rect(b1.x + b1.width / 2, b1.y), b, kids("B"))).toEqual({ targetId: "B1", position: "after", distance: 20 });
    expect(snapSlot("hierarchy", rect(b1.x + b1.width / 2, b1.y), a, kids("A"))).toBeNull();
    const between = (a1.x + a1.width + a2.x) / 2;
    expect(snapSlot("hierarchy", rect(between - 60, a1.y), a, kids("A"))).toEqual({ targetId: "A2", position: "before", distance: 12 });
    expect(snapSlot("hierarchy", rect(between - 60, a1.y), b, kids("B"))).toBeNull();
  });

  it("a leaf beside the tall parent takes its child one gap under itself, where the layout will put it", () => {
    const c = of("C");
    expect(snapSlot("hierarchy", rect(c.x, c.y + c.height + 32), c, [])).toEqual({ targetId: "C", position: "inside", distance: 32 + 20 });
    // The tall sibling's children row is 88 under C: no longer where C's child would land, and outside the plain zone.
    expect(snapSlot("hierarchy", rect(c.x, c.y + c.height + 88), c, [])).toBeNull();
  });
});

describe("snapSlot on the balanced map's two sides", () => {
  // Root → A (first, right) with A1, A2; B (second, left) with B1, B2; C (third, right, a leaf); D (fourth, left, a leaf).
  const tree: LayoutNode = {
    id: "root",
    children: [
      { id: "A", children: [{ id: "A1", children: [] }, { id: "A2", children: [] }] },
      { id: "B", children: [{ id: "B1", children: [] }, { id: "B2", children: [] }] },
      { id: "C", children: [] },
      { id: "D", children: [] },
    ],
  };
  const placed = layoutTree(tree, new Map([["root", { width: 200, height: 60 }]]), new Set(), "balanced");
  const byId = new Map(placed.nodes.map(item => [item.id, item]));
  const of = (id: string): PositionedNode => {
    const found = byId.get(id);
    if (!found) throw new Error(`Missing ${id}`);
    return found;
  };
  const kids = (id: string): PositionedNode[] => placed.edges.filter(edge => edge.from === id).map(edge => of(edge.to));

  it("a leaf takes its child on its own side: right of a right leaf, left of a left leaf, and nothing on the other side", () => {
    const [c, d] = [of("C"), of("D")];
    expect(snapSlot("balanced", rect(c.x + c.width + 30, c.y), c, [], 1, "right")).toEqual({ targetId: "C", position: "inside", distance: 30 + 2 });
    expect(snapSlot("balanced", rect(c.x - 30 - 120, c.y), c, [], 1, "right")).toBeNull();
    expect(snapSlot("balanced", rect(d.x - 30 - 120, d.y), d, [], 1, "left")).toEqual({ targetId: "D", position: "inside", distance: 30 + 2 });
    expect(snapSlot("balanced", rect(d.x + d.width + 30, d.y), d, [], 1, "left")).toBeNull();
    // The same zone limits as the map, mirrored: 8 units of overlap to 72 past the edge.
    expect(snapSlot("balanced", rect(d.x - 72 - 120, d.y), d, [], 1, "left")?.position).toBe("inside");
    expect(snapSlot("balanced", rect(d.x - 73 - 120, d.y), d, [], 1, "left")).toBeNull();
    expect(snapSlot("balanced", rect(d.x + 8 - 120, d.y), d, [], 1, "left")?.position).toBe("inside");
    expect(snapSlot("balanced", rect(d.x + 9 - 120, d.y), d, [], 1, "left")).toBeNull();
  });

  it("a left node's children line up on their right edges, a right node's on their left edges", () => {
    const [a, b, a1, a2, b1, b2] = [of("A"), of("B"), of("A1"), of("A2"), of("B1"), of("B2")];
    expect(a1.x).toBe(a.x + a.width + 56);
    expect(b1.x + b1.width).toBe(b.x - 56);
    // Between B1 and B2, right edge on their line: before B2. Off that line by more than 24 units: nothing.
    const betweenB = (b1.y + b1.height + b2.y) / 2 - 20;
    expect(snapSlot("balanced", rect(b1.x + b1.width - 120, betweenB), b, kids("B"), 1, "left")).toMatchObject({ targetId: "B2", position: "before" });
    expect(snapSlot("balanced", rect(b1.x + b1.width - 120 - 25, betweenB), b, kids("B"), 1, "left")).toBeNull();
    // Judged on the left edge, as a right node would be, the same spot lines up with nothing.
    expect(snapSlot("balanced", rect(b1.x + b1.width - 120, betweenB), b, kids("B"), 1, "right")).toBeNull();
    const betweenA = (a1.y + a1.height + a2.y) / 2 - 20;
    expect(snapSlot("balanced", rect(a1.x, betweenA), a, kids("A"), 1, "right")).toMatchObject({ targetId: "A2", position: "before" });
    expect(snapSlot("balanced", rect(a1.x, a2.y + a2.height / 2), a, kids("A"), 1, "right")).toMatchObject({ targetId: "A2", position: "after" });
  });

  it("the root's children form a column on each side, each judged on its own line, and a slot lands the topic on that side", () => {
    const root = of("root");
    const [a, b, c, d] = [of("A"), of("B"), of("C"), of("D")];
    // Right column: A then C. Between them, left edge on their line: before C (source index 2, an even index: the right side).
    expect(snapSlot("balanced", rect(a.x, (a.y + a.height + c.y) / 2 - 20), root, kids("root"), 1, "root")).toMatchObject({ targetId: "C", position: "before" });
    // Under C: the next index (4) is dealt to the right, so the topic joins after the last child of all (D), which keeps it under C.
    expect(snapSlot("balanced", rect(a.x, c.y + c.height / 2), root, kids("root"), 1, "root")).toMatchObject({ targetId: "D", position: "after" });
    // Left column: B then D, lined up on their right edges. Between them: before D (index 3, the left side).
    expect(snapSlot("balanced", rect(b.x + b.width - 120, (b.y + b.height + d.y) / 2 - 20), root, kids("root"), 1, "root")).toMatchObject({ targetId: "D", position: "before" });
    // Under D there is no index that lands on the left (index 4 goes right), so nothing is offered rather than a slot that jumps sides.
    expect(snapSlot("balanced", rect(b.x + b.width - 120, d.y + d.height / 2), root, kids("root"), 1, "root")).toBeNull();
    // The columns are far apart: a rect on the left edge line of the left column matches neither.
    expect(snapSlot("balanced", rect(b.x, (b.y + b.height + d.y) / 2 - 20), root, kids("root"), 1, "root")).toBeNull();
    // A collapsed root (no children) takes its first child on the right, like the map.
    expect(snapSlot("balanced", rect(root.x + root.width + 30, root.y), root, [], 1, "root")?.position).toBe("inside");
    expect(snapSlot("balanced", rect(root.x - 30 - 120, root.y), root, [], 1, "root")).toBeNull();
  });

  it("with an odd count the append slot is on the left, and a lone child leaves the root's left side open for the second", () => {
    // Three children: A (right), B (left), C (right). The next index, 3, is dealt to the left.
    const three: LayoutNode = { id: "root", children: [{ id: "A", children: [] }, { id: "B", children: [] }, { id: "C", children: [] }] };
    const placedThree = layoutTree(three, new Map([["root", { width: 200, height: 60 }]]), new Set(), "balanced");
    const at = (result: typeof placedThree, id: string): PositionedNode => {
      const found = result.nodes.find(item => item.id === id);
      if (!found) throw new Error(`Missing ${id}`);
      return found;
    };
    const rootOf = (result: typeof placedThree): PositionedNode => at(result, "root");
    const kidsOf = (result: typeof placedThree): PositionedNode[] => result.edges.filter(edge => edge.from === "root").map(edge => at(result, edge.to));
    const [a3, b3, c3] = [at(placedThree, "A"), at(placedThree, "B"), at(placedThree, "C")];
    // Under C in the right column: no even index is free after the last child, so nothing.
    expect(snapSlot("balanced", rect(a3.x, c3.y + c3.height / 2), rootOf(placedThree), kidsOf(placedThree), 1, "root")).toBeNull();
    // Under B in the left column: index 3 is the left side, reached by joining after the last child of all, C.
    expect(snapSlot("balanced", rect(b3.x + b3.width - 120, b3.y + b3.height / 2), rootOf(placedThree), kidsOf(placedThree), 1, "root"))
      .toMatchObject({ targetId: "C", position: "after" });
    // Before A still works: the topic takes index 0 (right) and A moves to the left, as the rule fixes.
    expect(snapSlot("balanced", rect(a3.x, a3.y - 20), rootOf(placedThree), kidsOf(placedThree), 1, "root")).toMatchObject({ targetId: "A", position: "before" });

    // One child: A on the right. The second child would hang left of the root, so that empty side is a zone (a root's,
    // measured from the line 24 out, so 30 out is 6 past the line; LEV-90); the right side is not.
    const one: LayoutNode = { id: "root", children: [{ id: "A", children: [] }] };
    const placedOne = layoutTree(one, new Map([["root", { width: 200, height: 60 }]]), new Set(), "balanced");
    const root1 = rootOf(placedOne);
    expect(snapSlot("balanced", rect(root1.x - 30 - 120, root1.y), root1, kidsOf(placedOne), 1, "root")).toEqual({ targetId: "root", position: "inside", distance: 6 + 10 });
    expect(snapSlot("balanced", rect(at(placedOne, "A").x, at(placedOne, "A").y + 44), root1, kidsOf(placedOne), 1, "root")).toBeNull();
  });
});

describe("snapSlot on the timeline's axis band (LEV-47)", () => {
  // A stage of 44 beside one of 200 (an image): the tree's band is 100 half-height, so the short stage's forest starts
  // 134 past the axis: 112 past its own edge, where the plain zone (8..72) never reached.
  const stage = node("s2", 384, -22);
  const lower: StagePlace = { side: "lower", band: 100 };
  const upper: StagePlace = { side: "upper", band: 100 };

  it("measures the gap from the band's edge, 8 units of overlap to 72 past it, and reaches back to the stage itself", () => {
    expect(snapSlot("timeline", rect(384, 100 + 34), stage, [], 1, lower)).toEqual({ targetId: "s2", position: "inside", distance: 34 + 100 });
    expect(snapSlot("timeline", rect(384, 100 + 72), stage, [], 1, lower)?.position).toBe("inside");
    expect(snapSlot("timeline", rect(384, 100 + 73), stage, [], 1, lower)).toBeNull();
    // Between the stage's edge and the band's: still the stage's slot, so a root brought up under the stage is caught.
    expect(snapSlot("timeline", rect(384, 22 + 30), stage, [], 1, lower)?.position).toBe("inside");
    expect(snapSlot("timeline", rect(384, 22 - 8), stage, [], 1, lower)?.position).toBe("inside");
    expect(snapSlot("timeline", rect(384, 22 - 9), stage, [], 1, lower)).toBeNull();
    // The mirror image above the axis.
    expect(snapSlot("timeline", rect(384, -100 - 34 - 40), stage, [], 1, upper)).toEqual({ targetId: "s2", position: "inside", distance: 34 + 100 });
    expect(snapSlot("timeline", rect(384, -100 - 73 - 40), stage, [], 1, upper)).toBeNull();
    expect(snapSlot("timeline", rect(384, -22 - 30 - 40), stage, [], 1, upper)?.position).toBe("inside");
    expect(snapSlot("timeline", rect(384, -22 + 9 - 40), stage, [], 1, upper)).toBeNull();
    // The other side of the axis is still nothing, band or no band.
    expect(snapSlot("timeline", rect(384, 100 + 34), stage, [], 1, upper)).toBeNull();
    expect(snapSlot("timeline", rect(384, -100 - 34 - 40), stage, [], 1, lower)).toBeNull();
  });

  it("widening stretches the gap past the band and the overlap, not the reach back to the stage", () => {
    expect(snapSlot("timeline", rect(384, 100 + 144), stage, [], 2, lower)?.position).toBe("inside");
    expect(snapSlot("timeline", rect(384, 100 + 145), stage, [], 2, lower)).toBeNull();
    expect(snapSlot("timeline", rect(384, 22 - 16), stage, [], 2, lower)?.position).toBe("inside");
    expect(snapSlot("timeline", rect(384, 22 - 17), stage, [], 2, lower)).toBeNull();
  });

  it("the landing column and the slack across follow the stage, not the band", () => {
    expect(snapSlot("timeline", rect(384 + 80 + 20, 100 + 34), stage, [], 1, lower)).toEqual({ targetId: "s2", position: "inside", distance: 34 });
    expect(snapSlot("timeline", rect(384 + 160 + 12, 100 + 34), stage, [], 1, lower)?.position).toBe("inside");
    expect(snapSlot("timeline", rect(384 + 160 + 13, 100 + 34), stage, [], 1, lower)).toBeNull();
  });

  it("between the stage and the band the distance is to the nearer of the two, so a root snug under the stage ranks close", () => {
    const column = 384 + 80 + 20;
    expect(snapSlot("timeline", rect(column, 22 + 10), stage, [], 1, lower)?.distance).toBe(10);
    expect(snapSlot("timeline", rect(column, 100 - 5), stage, [], 1, lower)?.distance).toBe(5);
    expect(snapSlot("timeline", rect(column, 22 + 39), stage, [], 1, lower)?.distance).toBe(39);
    expect(snapSlot("timeline", rect(column, 22 + 40), stage, [], 1, lower)?.distance).toBe(38);
    // Past the band, and with no band beyond the stage, it is the plain gap.
    expect(snapSlot("timeline", rect(column, 100 + 50), stage, [], 1, lower)?.distance).toBe(50);
    expect(snapSlot("timeline", rect(column, 22 + 50), stage, [], 1, { side: "lower", band: 22 })?.distance).toBe(50);
  });
});

describe("snapSlot where the layout lands a first child, with nodes of different heights (LEV-47)", () => {
  describe("timeline: the root and the stages are centred on the axis and every forest starts one gap past the tallest", () => {
    const tree: LayoutNode = {
      id: "root",
      children: [{ id: "tall", children: [] }, { id: "short", children: [] }, { id: "third", children: [] }],
    };
    const sizes = new Map([["tall", { width: 160, height: 200 }]]);
    const placed = layoutTree(tree, sizes, new Set(), "timeline");
    const stages = ["tall", "short", "third"].map(id => nodeOf(placed, id));
    const band = axisBand(nodeOf(placed, "root"), stages);
    const placeOf = (index: number): StagePlace => ({ side: index % 2 === 0 ? "upper" : "lower", band });

    it("the band is the tall stage's half-height, and the layout's forests start 34 past it on either side", () => {
      expect(band).toBe(100);
      const below = nodeOf(layoutTree(withChild(tree, "short"), sizes, new Set(), "timeline"), "new");
      const above = nodeOf(layoutTree(withChild(tree, "third"), sizes, new Set(), "timeline"), "new");
      expect(below.y).toBe(band + 34);
      expect(above.y + above.height).toBe(-band - 34);
    });

    it.each([["short", 1], ["third", 2], ["tall", 0]] as const)("brought to where %s's first child lands, the root is in its zone at the landing distance", (id, index) => {
      const stage = nodeOf(placed, id);
      const landing = nodeOf(layoutTree(withChild(tree, id), sizes, new Set(), "timeline"), "new");
      expect(snapSlot("timeline", landing, stage, [], 1, placeOf(index))).toEqual({ targetId: id, position: "inside", distance: 34 });
      // Measured from the stage's own edge (the band no taller than itself), the short stages' landings are out of reach.
      const own: StagePlace = { side: placeOf(index).side, band: stage.height / 2 };
      expect(snapSlot("timeline", landing, stage, [], 1, own)).toEqual(id === "tall" ? { targetId: id, position: "inside", distance: 34 } : null);
    });

    it("a topic's tree keeps its own band: its stages are all 44, so its forests start 56 past its axis", () => {
      const topic: LayoutNode = { id: "topic", children: [{ id: "t1", children: [] }, { id: "t2", children: [] }] };
      const both = layoutTree(tree, sizes, new Set(), "timeline", [{ tree: topic, position: { x: 0, y: 400 } }]);
      const topicBand = axisBand(nodeOf(both, "topic"), [nodeOf(both, "t1"), nodeOf(both, "t2")]);
      expect(topicBand).toBe(22);
      const landing = nodeOf(layoutTree(tree, sizes, new Set(), "timeline", [{ tree: withChild(topic, "t2"), position: { x: 0, y: 400 } }]), "new");
      expect(landing.y).toBe(nodeOf(both, "t2").y + 44 + 34);
      expect(snapSlot("timeline", landing, nodeOf(both, "t2"), [], 1, { side: "lower", band: topicBand })).toEqual({ targetId: "t2", position: "inside", distance: 34 });
      // 100 under the stage is past the topic's zone; judged with the body's band instead, it would still count, from a line the topic's forest never starts from.
      const far = { ...landing, y: landing.y + 66 };
      expect(snapSlot("timeline", far, nodeOf(both, "t2"), [], 1, { side: "lower", band: topicBand })).toBeNull();
      expect(snapSlot("timeline", far, nodeOf(both, "t2"), [], 1, { side: "lower", band })?.position).toBe("inside");
    });
  });

  describe("hierarchy: rows hang from each parent (LEV-46), so a leaf's child lands one gap under the leaf whatever its siblings measure", () => {
    // A tall root (an image) over a tall leaf and a short one; the short leaf's row-mate is 156 taller.
    const tree: LayoutNode = { id: "root", children: [{ id: "tallLeaf", children: [] }, { id: "shortLeaf", children: [] }] };
    const sizes = new Map([["root", { width: 160, height: 200 }], ["tallLeaf", { width: 160, height: 200 }]]);
    const placed = layoutTree(tree, sizes, new Set(), "hierarchy");

    it.each([["shortLeaf", 32], ["tallLeaf", 32], ["root", 48]] as const)("brought to where %s's first child lands (%i under it), the root is in its zone", (id, gap) => {
      const parent = nodeOf(placed, id);
      const kids = placed.edges.filter(edge => edge.from === id).map(edge => nodeOf(placed, edge.to));
      const landing = nodeOf(layoutTree(withChild(tree, id), sizes, new Set(), "hierarchy"), "new");
      expect(landing.y).toBe(parent.y + parent.height + gap);
      const slot = snapSlot("hierarchy", landing, parent, kids, 1);
      expect(slot).toMatchObject(kids.length === 0 ? { targetId: id, position: "inside" } : { position: "after" });
    });

    it("the tall sibling's bottom is not where the short leaf's child goes: no zone one gap under it", () => {
      const short = nodeOf(placed, "shortLeaf");
      const tall = nodeOf(placed, "tallLeaf");
      expect(tall.y).toBe(short.y);
      expect(snapSlot("hierarchy", rect(short.x, tall.y + tall.height + 32), short, [], 1)).toBeNull();
    });
  });
});

describe("snapSlot where the map and the balanced map land a root's first child: a root gap (80) past it, a branch's child a branch gap (56) (LEV-90)", () => {
  // A tree of one node: the body's root with nothing under it, or a topic that is only its heading.
  const lone: LayoutNode = { id: "root", children: [] };
  // A branch with a leaf under it: the leaf's first child lands a branch gap past the leaf.
  const branch: LayoutNode = { id: "root", children: [{ id: "leaf", children: [] }] };

  it.each(["mindmap", "balanced"] as const)("in %s, brought to where the lone root's first child lands, the root is in its zone at the branch gap's distance", mode => {
    const placed = layoutTree(lone, new Map(), new Set(), mode);
    const root = nodeOf(placed, "root");
    const grown = layoutTree(withChild(lone, "root"), new Map(), new Set(), mode);
    expect(nodeOf(grown, "root")).toEqual(root);
    const landing = nodeOf(grown, "new");
    expect(landing.x).toBe(root.x + root.width + 80);
    expect(landing.y + landing.height / 2).toBe(root.y + root.height / 2);
    // The landing sits the branch gap past the root's line, as a branch's child does past the branch, so both rank alike.
    expect(snapSlot(mode, landing, root, [], 1, "root")).toEqual({ targetId: "root", position: "inside", distance: 56 });
    // Judged as a branch (the map's default place), the landing is past the plain zone.
    expect(snapSlot(mode, landing, root, [], 1)).toBeNull();
  });

  it.each(["mindmap", "balanced"] as const)("in %s, a leaf's child still lands a branch gap past it, inside the plain zone", mode => {
    const placed = layoutTree(branch, new Map(), new Set(), mode);
    const leaf = nodeOf(placed, "leaf");
    const landing = nodeOf(layoutTree(withChild(branch, "leaf"), new Map(), new Set(), mode), "new");
    expect(landing.x).toBe(leaf.x + leaf.width + 56);
    expect(snapSlot(mode, landing, leaf, [], 1, mode === "balanced" ? "right" : "forest")).toEqual({ targetId: "leaf", position: "inside", distance: 56 });
  });

  it("in balanced, the root's empty left side takes the second child a root gap out too: brought to where the layout lands it, the root is in that zone", () => {
    const one: LayoutNode = { id: "root", children: [{ id: "A", children: [] }] };
    const placed = layoutTree(one, new Map(), new Set(), "balanced");
    const root = nodeOf(placed, "root");
    const kids = [nodeOf(placed, "A")];
    const landing = nodeOf(layoutTree(withChild(one, "root"), new Map(), new Set(), "balanced"), "new");
    expect(landing.x + landing.width).toBe(root.x - 80);
    expect(landing.y + landing.height / 2).toBe(root.y + root.height / 2);
    expect(snapSlot("balanced", landing, root, kids, 1, "root")).toEqual({ targetId: "root", position: "inside", distance: 56 });
    // 16 past the landing is the end of that zone, as on the right.
    expect(snapSlot("balanced", { ...landing, x: landing.x - 16 }, root, kids, 1, "root")?.position).toBe("inside");
    expect(snapSlot("balanced", { ...landing, x: landing.x - 17 }, root, kids, 1, "root")).toBeNull();
  });

  it("the root's zone runs from 8 units of overlap with the root to 16 past the landing, and widening stretches both ends", () => {
    const root = node("root", 100, 100);
    const right = root.x + root.width;
    expect(snapSlot("mindmap", rect(right + 96, 100), root, [], 1, "root")?.position).toBe("inside");
    expect(snapSlot("mindmap", rect(right + 97, 100), root, [], 1, "root")).toBeNull();
    expect(snapSlot("mindmap", rect(right - 8, 100), root, [], 1, "root")?.position).toBe("inside");
    expect(snapSlot("mindmap", rect(right - 9, 100), root, [], 1, "root")).toBeNull();
    // The slack across is the root's, as for any node.
    expect(snapSlot("mindmap", rect(right + 80, 100 - 40 - 12), root, [], 1, "root")?.position).toBe("inside");
    expect(snapSlot("mindmap", rect(right + 80, 100 - 40 - 13), root, [], 1, "root")).toBeNull();
    // Widened, the gap past the line and the overlap double; the reach from the line back to the root stays.
    expect(snapSlot("mindmap", rect(right + 24 + 144, 100), root, [], 2, "root")?.position).toBe("inside");
    expect(snapSlot("mindmap", rect(right + 24 + 145, 100), root, [], 2, "root")).toBeNull();
    expect(snapSlot("mindmap", rect(right - 16, 100), root, [], 2, "root")?.position).toBe("inside");
    expect(snapSlot("mindmap", rect(right - 17, 100), root, [], 2, "root")).toBeNull();
    // The balanced root's first child goes right too, with the same zone; its left side is nothing.
    expect(snapSlot("balanced", rect(right + 96, 100), root, [], 1, "root")?.position).toBe("inside");
    expect(snapSlot("balanced", rect(right + 97, 100), root, [], 1, "root")).toBeNull();
    expect(snapSlot("balanced", rect(root.x - 80 - 120, 100), root, [], 1, "root")).toBeNull();
  });

  it("between the root and its line the distance is to the nearer of the two, and past the line it is the gap from the line", () => {
    const root = node("root", 100, 100);
    const right = root.x + root.width;
    expect(snapSlot("mindmap", rect(right + 6, 102), root, [], 1, "root")?.distance).toBe(6);
    expect(snapSlot("mindmap", rect(right + 20, 102), root, [], 1, "root")?.distance).toBe(4);
    expect(snapSlot("mindmap", rect(right + 24, 102), root, [], 1, "root")?.distance).toBe(0);
    expect(snapSlot("mindmap", rect(right + 80, 102), root, [], 1, "root")?.distance).toBe(56);
    expect(snapSlot("mindmap", rect(right + 96, 102), root, [], 1, "root")?.distance).toBe(72);
  });

  it("the timeline's root and the hierarchy's keep their plain zones: their first child lands 32 and 48 past them", () => {
    const onAxis = layoutTree(lone, new Map(), new Set(), "timeline");
    const stage = nodeOf(layoutTree(withChild(lone, "root"), new Map(), new Set(), "timeline"), "new");
    expect(stage.x).toBe(nodeOf(onAxis, "root").x + nodeOf(onAxis, "root").width + 32);
    expect(snapSlot("timeline", stage, nodeOf(onAxis, "root"), [], 1, "root")).toEqual({ targetId: "root", position: "inside", distance: 32 });
    const onTop = layoutTree(lone, new Map(), new Set(), "hierarchy");
    const below = nodeOf(layoutTree(withChild(lone, "root"), new Map(), new Set(), "hierarchy"), "new");
    expect(below.y).toBe(nodeOf(onTop, "root").y + nodeOf(onTop, "root").height + 48);
    expect(snapSlot("hierarchy", below, nodeOf(onTop, "root"), [], 1, "root")).toEqual({ targetId: "root", position: "inside", distance: 48 });
  });
});
