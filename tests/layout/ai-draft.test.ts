import { describe, expect, it } from "vitest";
import { withDraft } from "../../src/layout/ai-draft";
import type { LayoutNode } from "../../src/layout/layout";

const node = (id: string, ...children: LayoutNode[]): LayoutNode => ({ id, children });

describe("withDraft (LEV-271): the AI draft's nodes as the anchor's last children", () => {
  const untouched = node("b", node("b1"));
  const tree = node("root", node("a", node("a1"), node("a2")), untouched);
  const draft = [node("ai-draft:1", node("ai-draft:2")), node("ai-draft:3")];

  it("appends the draft after the anchor's children and reuses every other subtree", () => {
    const result = withDraft(tree, "a", draft, new Set());
    expect(result).toEqual(node("root", node("a", node("a1"), node("a2"), ...draft), untouched));
    expect(result?.children[1]).toBe(untouched);
    // The tree on screen is left as it was.
    expect(tree.children[0]?.children).toHaveLength(2);
  });

  it("shows the draft alone under a collapsed anchor, and finds a nested anchor", () => {
    expect(withDraft(tree, "a", draft, new Set(["a"]))).toEqual(node("root", node("a", ...draft), untouched));
    expect(withDraft(tree, "b1", draft, new Set())?.children[1]).toEqual(node("b", node("b1", ...draft)));
  });

  it("is null when the anchor is not in the tree", () => {
    expect(withDraft(tree, "gone", draft, new Set())).toBeNull();
  });
});
