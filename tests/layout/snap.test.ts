import { describe, expect, it } from "vitest";
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
    expect(snapSlot("mindmap", rect(260 + 130, 100), leaf, [], 1, 2)?.position).toBe("inside");
    expect(snapSlot("mindmap", rect(260 + 145, 100), leaf, [], 1, 2)).toBeNull();
    expect(snapSlot("mindmap", rect(300, 100 - 40 - 24), leaf, [], 1, 2)?.position).toBe("inside");
  });

  it("among children the root must line up with their shared edge and reach along them", () => {
    const parent = node("parent", 0, 100);
    const column = [node("a", 240, 0), node("b", 240, 66), node("c", 240, 132)];
    expect(snapSlot("mindmap", rect(240, 44), parent, column, 0)).toEqual({ targetId: "b", position: "before", distance: 2 });
    expect(snapSlot("mindmap", rect(240 + 24, 44), parent, column, 0)?.targetId).toBe("b");
    expect(snapSlot("mindmap", rect(240 + 25, 44), parent, column, 0)).toBeNull();
    expect(snapSlot("mindmap", rect(240, 132 + 22), parent, column, 0)).toEqual({ targetId: "c", position: "after", distance: 2 });
    expect(snapSlot("mindmap", rect(240, 176 + 12 - 20), parent, column, 0)?.position).toBe("after");
    expect(snapSlot("mindmap", rect(240, 176 + 13 - 20), parent, column, 0)).toBeNull();
    // The hierarchy's row: the same rule with the axes swapped, lined up on the row's top edge.
    const row = [node("a", 0, 200), node("b", 184, 200), node("c", 368, 200)];
    expect(snapSlot("hierarchy", rect(160 - 60, 200), parent, row, 0)).toEqual({ targetId: "b", position: "before", distance: 24 });
    expect(snapSlot("hierarchy", rect(100, 200 + 25), parent, row, 0)).toBeNull();
    expect(snapSlot("hierarchy", rect(368 + 80, 200), parent, row, 0)).toEqual({ targetId: "c", position: "after", distance: 20 });
    // Sorted by position, not by the order given.
    expect(snapSlot("hierarchy", rect(100, 200), parent, [...row].reverse(), 0)?.targetId).toBe("b");
  });

  it("on the timeline the root's stages line up by centre on the axis and a leaf stage takes a child above or below", () => {
    const root = node("root", 0, -22);
    const stages = [node("s1", 192, -22), node("s2", 384, -30, 160, 60), node("s3", 576, -22)];
    expect(snapSlot("timeline", rect(368 - 60, -20), root, stages, 0)).toEqual({ targetId: "s2", position: "before", distance: 16 });
    expect(snapSlot("timeline", rect(368 - 60, -20 + 24), root, stages, 0)?.targetId).toBe("s2");
    expect(snapSlot("timeline", rect(368 - 60, -20 + 25), root, stages, 0)).toBeNull();
    // The same row judged as a map node's children is a column and does not match.
    expect(snapSlot("timeline", rect(368 - 60, -20), root, stages, 2)).toBeNull();
    const stage = node("s3", 576, -22);
    const above = snapSlot("timeline", rect(576, -22 - 30 - 40), stage, [], 1);
    const below = snapSlot("timeline", rect(576, 22 + 30), stage, [], 1);
    expect(above).toEqual({ targetId: "s3", position: "inside", distance: 30 + 20 });
    expect(below).toEqual(above);
    expect(snapSlot("timeline", rect(576 + 160 + 30, -22), stage, [], 1)).toBeNull();
    // A collapsed root has no stage yet: the first goes right of it, like a map child.
    expect(snapSlot("timeline", rect(160 + 30, -22), root, [], 0)?.position).toBe("inside");
    // Deeper nodes hang in a rightward forest: right of a leaf, in a column under a parent.
    const branch = node("branch", 292, -158);
    expect(snapSlot("timeline", rect(292 + 160 + 30, -158), branch, [], 2)?.position).toBe("inside");
    expect(snapSlot("timeline", rect(508, -100), branch, [node("k1", 508, -158), node("k2", 508, -100)], 2))
      .toEqual({ targetId: "k2", position: "before", distance: 20 });
  });
});
