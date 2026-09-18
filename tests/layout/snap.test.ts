import { describe, expect, it } from "vitest";
import { layoutTree, type LayoutNode } from "../../src/layout/layout";
import { snapSlot } from "../../src/layout/snap";
import type { PositionedNode } from "../../src/layout/primitives";

const node = (id: string, x: number, y: number, width = 160, height = 44): PositionedNode => ({ id, x, y, width, height });
const rect = (x: number, y: number, width = 120, height = 40) => ({ x, y, width, height });

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
    // An even stage hangs its forest above the axis, an odd one below; the other side is nothing.
    const stage = node("s3", 576, -22);
    const above = rect(576, -22 - 30 - 40);
    const below = rect(576, 22 + 30);
    expect(snapSlot("timeline", above, stage, [], 1, "upper")?.position).toBe("inside");
    expect(snapSlot("timeline", below, stage, [], 1, "upper")).toBeNull();
    expect(snapSlot("timeline", below, stage, [], 1, "lower")?.position).toBe("inside");
    expect(snapSlot("timeline", above, stage, [], 1, "lower")).toBeNull();
    // The forest starts a stem's length right of the stage's centre, so the root's left edge is scored against that column.
    expect(snapSlot("timeline", above, stage, [], 1, "upper")?.distance).toBe(30 + Math.abs(576 - (576 + 80 + 20)));
    expect(snapSlot("timeline", rect(576 + 80 + 20, -22 - 30 - 40), stage, [], 1, "upper")).toEqual({ targetId: "s3", position: "inside", distance: 30 });
    expect(snapSlot("timeline", rect(576 + 160 + 30, -22), stage, [], 1, "upper")).toBeNull();
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
