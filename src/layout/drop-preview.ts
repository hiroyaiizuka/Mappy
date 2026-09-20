import type { MoveCommand } from "../core/commands";
import type { MindNode } from "../core/markdown";
import type { LayoutNode } from "./layout";

/** Layout id of the empty slot shown while a node is dragged; never a Markdown node. */
export const PLACEHOLDER_ID = "mappy-drop-placeholder";

/**
 * Tree to lay out while a drop is previewed: an empty placeholder occupies the slot the move
 * would fill, so existing siblings make room, while the moving node stays where it is.
 * Only the ancestors of the destination are rebuilt; every other subtree is reused as-is.
 * A collapsed destination shows just the placeholder, keeping its hidden children hidden.
 * The tree walked is the one on screen (the host's, with called maps grafted in, §5 M12),
 * so branches that are not the host's own keep their place during the drag.
 */
export function previewTree(
  visualRoot: MindNode,
  command: MoveCommand,
  collapsed: ReadonlySet<string>,
): LayoutNode | null {
  const byId = new Map<string, MindNode>();
  const pending = [visualRoot];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) break;
    byId.set(node.id, node);
    for (const child of node.children) pending.push(child);
  }
  const parent = byId.get(command.parentId);
  if (!parent) return null;
  const chain = new Set<string>();
  for (let cursor: MindNode | undefined = parent; cursor; cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)) {
    chain.add(cursor.id);
    if (cursor.id === visualRoot.id) break;
  }
  if (!chain.has(visualRoot.id)) return null;
  const placeholder: LayoutNode = { id: PLACEHOLDER_ID, children: [] };
  const rebuild = (node: MindNode): LayoutNode => {
    if (node.id !== parent.id) return { id: node.id, children: node.children.map(child => chain.has(child.id) ? rebuild(child) : child) };
    if (collapsed.has(node.id)) return { id: node.id, children: [placeholder] };
    const siblings = node.children.filter(child => child.id !== command.nodeId);
    const before = siblings[command.index];
    const last = siblings[siblings.length - 1];
    const at = before ? node.children.indexOf(before) : last ? node.children.indexOf(last) + 1 : 0;
    const children: LayoutNode[] = [...node.children];
    children.splice(at, 0, placeholder);
    return { id: node.id, children };
  };
  return rebuild(visualRoot);
}
