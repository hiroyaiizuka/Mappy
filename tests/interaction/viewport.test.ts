import { describe, expect, it } from "vitest";
import { clampScale, fitToBounds, zoomAt } from "../../src/interaction/viewport";
import { layoutTree, type LayoutNode } from "../../src/layout/layout";

describe("viewport", () => {
  it("keeps the same world point under the pointer when zooming", () => {
    const view = { x: -215, y: 137, scale: 0.7 };
    const pointer = { x: 440, y: 290 };
    const zoomed = zoomAt(view, pointer, 1.8);
    expect((pointer.x - zoomed.x) / zoomed.scale).toBeCloseTo((pointer.x - view.x) / view.scale);
    expect((pointer.y - zoomed.y) / zoomed.scale).toBeCloseTo((pointer.y - view.y) / view.scale);
    expect(view).toEqual({ x: -215, y: 137, scale: 0.7 });
  });

  it("clamps zoom input and keeps the anchor at the clamped boundary", () => {
    expect(clampScale(-2)).toBe(0.000001);
    expect(clampScale(-Infinity)).toBe(0.000001);
    expect(clampScale(Infinity)).toBe(3);
    expect(clampScale(NaN)).toBe(1);
    const zoomed = zoomAt({ x: 10, y: 20, scale: 1 }, { x: 40, y: 50 }, 999);
    expect(zoomed).toEqual({ x: -50, y: -40, scale: 3 });
  });

  it("fits and centers bounds including their negative origin", () => {
    const bounds = { x: -100, y: -400, width: 1200, height: 800 };
    const view = fitToBounds(bounds, 900, 700, 50);
    expect(view.scale).toBeCloseTo(2 / 3);
    expect(view.x + bounds.x * view.scale).toBeCloseTo(50);
    expect(view.x + (bounds.x + bounds.width) * view.scale).toBeCloseTo(850);
    expect(view.y + (bounds.y + bounds.height / 2) * view.scale).toBeCloseTo(350);
  });

  it("returns finite transforms for an empty document or a hidden viewport", () => {
    for (const bounds of [
      { x: 0, y: 0, width: 0, height: 0 },
      { x: -20, y: -40, width: 200, height: 80 },
    ]) {
      const view = fitToBounds(bounds, 0, 0);
      expect(Number.isFinite(view.x + view.y + view.scale)).toBe(true);
      expect(view.scale).toBeGreaterThan(0);
    }
  });

  it("fits a very large map and zooms smoothly from the fitted scale", () => {
    const view = fitToBounds({ x: 0, y: 0, width: 100_000, height: 100_000 }, 500, 400);
    expect(view.scale).toBeCloseTo(0.0028);
    expect(view.x + 50_000 * view.scale).toBe(250);
    expect(view.y + 50_000 * view.scale).toBe(200);
    const pointer = { x: 180, y: 130 };
    const zoomed = zoomAt(view, pointer, view.scale * 1.2);
    expect(zoomed.scale / view.scale).toBeCloseTo(1.2);
    expect((pointer.x - zoomed.x) / zoomed.scale).toBeCloseTo((pointer.x - view.x) / view.scale);
    expect((pointer.y - zoomed.y) / zoomed.scale).toBeCloseTo((pointer.y - view.y) / view.scale);
  });

  it.each([500, 2000])("fits all %i nodes in both layouts with the requested padding", (count) => {
    const branches: LayoutNode[] = [];
    let nextId = 1;
    while (nextId < count) {
      const id = `section-${nextId++}`;
      const children: LayoutNode[] = [];
      for (let index = 0; index < 19 && nextId < count; index += 1) {
        children.push({ id: `child-${nextId++}`, children: [] });
      }
      branches.push({ id, children });
    }
    const root = { id: "root", children: branches };
    const allNodes = [root, ...branches, ...branches.flatMap(branch => branch.children)];
    const sizes = new Map(allNodes.map(node => [node.id, { width: 224, height: 54 }]));
    for (const mode of ["mindmap", "timeline", "hierarchy", "balanced"] as const) {
      const layout = layoutTree(root, sizes, new Set(), mode);
      expect(layout.nodes).toHaveLength(count);
      const view = fitToBounds(layout.bounds, 1000, 700, 60);
      for (const node of layout.nodes) {
        expect(view.x + node.x * view.scale).toBeGreaterThanOrEqual(60 - 0.000001);
        expect(view.y + node.y * view.scale).toBeGreaterThanOrEqual(60 - 0.000001);
        expect(view.x + (node.x + node.width) * view.scale).toBeLessThanOrEqual(940 + 0.000001);
        expect(view.y + (node.y + node.height) * view.scale).toBeLessThanOrEqual(640 + 0.000001);
      }
      const next = zoomAt(view, { x: 500, y: 350 }, view.scale / 1.2);
      expect(next.scale).toBeCloseTo(view.scale / 1.2);
      expect(next.scale).toBeLessThan(view.scale);
    }
  });
});
