import type { LayoutNode } from "./layout";

/** Layout ids of the AI draft's provisional nodes (docs/architecture.md §11.5): never a Markdown node. */
export const AI_DRAFT_PREFIX = "ai-draft:";

export function isDraftId(id: string): boolean {
  return id.startsWith(AI_DRAFT_PREFIX);
}

/**
 * `tree` with the draft's nodes as the last children of `anchorId`, the way the drop preview inserts its slot
 * (`previewTree`): only the anchor's ancestors are rebuilt, every other subtree is reused. A collapsed anchor shows
 * the draft alone, its own children staying hidden; the caller lays the tree out with the anchor not collapsed.
 * Null when the anchor is not in `tree`.
 */
export function withDraft(
  tree: LayoutNode, anchorId: string, draft: readonly LayoutNode[], collapsed: ReadonlySet<string>,
): LayoutNode | null {
  const rebuild = (node: LayoutNode): LayoutNode | null => {
    if (node.id === anchorId) {
      return { id: node.id, children: collapsed.has(node.id) ? [...draft] : [...node.children, ...draft] };
    }
    for (let index = 0; index < node.children.length; index += 1) {
      const child = node.children[index];
      const rebuilt = child ? rebuild(child) : null;
      if (!rebuilt) continue;
      const children = [...node.children];
      children[index] = rebuilt;
      return { id: node.id, children };
    }
    return null;
  };
  return rebuild(tree);
}
