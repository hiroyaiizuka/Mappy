import { describe, expect, it } from "vitest";
import { parseMarkdown, type MindDocument, type MindNode } from "../../src/core/markdown";
import { PLACEHOLDER_ID, previewTree } from "../../src/layout/drop-preview";
import { layoutTree, type LayoutNode } from "../../src/layout/layout";

function find(doc: MindDocument, title: string): MindNode {
  const node = doc.nodes.find(candidate => candidate.title === title);
  if (!node) throw new Error(`Missing ${title}`);
  return node;
}

function titles(doc: MindDocument, node: LayoutNode): string[] {
  return node.children.map(child => child.id === PLACEHOLDER_ID ? "▢" : doc.nodes.find(candidate => candidate.id === child.id)?.title ?? child.id);
}

describe("drop preview tree", () => {
  const doc = parseMarkdown("## Root\n- A\n  - A1\n  - A2\n  - A3\n- B\n", "Note");
  const root = find(doc, "Root");

  it("puts the placeholder before the sibling that would follow the moved node", () => {
    const tree = previewTree(doc, root, { type: "move", nodeId: find(doc, "A3").id, parentId: find(doc, "A").id, index: 0 }, new Set());
    const a = tree?.children.find(child => child.id === find(doc, "A").id);
    expect(a && titles(doc, a)).toEqual(["▢", "A1", "A2", "A3"]);
    expect(tree?.children.map(child => child.id)).toEqual([find(doc, "A").id, find(doc, "B").id]);
  });

  it("appends after the last other sibling, leaving the moving node in place", () => {
    const tree = previewTree(doc, root, { type: "move", nodeId: find(doc, "A1").id, parentId: find(doc, "A").id, index: 2 }, new Set());
    const a = tree?.children.find(child => child.id === find(doc, "A").id);
    expect(a && titles(doc, a)).toEqual(["A1", "A2", "A3", "▢"]);
  });

  it("makes the placeholder the only child of a childless destination and reuses untouched subtrees", () => {
    const b = find(doc, "B");
    const tree = previewTree(doc, root, { type: "move", nodeId: find(doc, "A2").id, parentId: b.id, index: 0 }, new Set());
    const previewB = tree?.children.find(child => child.id === b.id);
    expect(previewB?.children.map(child => child.id)).toEqual([PLACEHOLDER_ID]);
    // A is not an ancestor of the destination, so the original node object is reused.
    expect(tree?.children[0]).toBe(find(doc, "A"));
  });

  it("shows only the placeholder under a collapsed destination", () => {
    const a = find(doc, "A");
    const tree = previewTree(doc, root, { type: "move", nodeId: find(doc, "B").id, parentId: a.id, index: 3 }, new Set([a.id]));
    expect(tree?.children.find(child => child.id === a.id)?.children.map(child => child.id)).toEqual([PLACEHOLDER_ID]);
  });

  it("returns null when the destination is outside the visual root or unknown", () => {
    expect(previewTree(doc, root, { type: "move", nodeId: find(doc, "B").id, parentId: "root", index: 0 }, new Set())).toBeNull();
    expect(previewTree(doc, root, { type: "move", nodeId: find(doc, "B").id, parentId: "missing", index: 0 }, new Set())).toBeNull();
  });

  it("lays out a rightward map where siblings make room for the placeholder", () => {
    const sizes = new Map(doc.nodes.map(node => [node.id, { width: 100, height: 30 }]));
    sizes.set(PLACEHOLDER_ID, { width: 100, height: 30 });
    const base = layoutTree(root, sizes, new Set(), "mindmap");
    const tree = previewTree(doc, root, { type: "move", nodeId: find(doc, "B").id, parentId: find(doc, "A").id, index: 1 }, new Set());
    if (!tree) throw new Error("Missing preview tree");
    const preview = layoutTree(tree, sizes, new Set(), "mindmap");
    const position = (layout: typeof base, id: string) => layout.nodes.find(node => node.id === id);
    const a1 = find(doc, "A1").id;
    const a2 = find(doc, "A2").id;
    const placeholder = position(preview, PLACEHOLDER_ID);
    expect(placeholder).toBeDefined();
    expect(placeholder && placeholder.y).toBeGreaterThan(position(preview, a1)?.y ?? Infinity);
    expect(placeholder && placeholder.y).toBeLessThan(position(preview, a2)?.y ?? -Infinity);
    expect((position(preview, a2)?.y ?? 0) - (position(preview, a1)?.y ?? 0))
      .toBeGreaterThan((position(base, a2)?.y ?? 0) - (position(base, a1)?.y ?? 0));
    expect(preview.edges.some(edge => edge.to === PLACEHOLDER_ID && edge.from === find(doc, "A").id)).toBe(true);
  });
});
