import type { AiTemplate, OutlineItem } from "../../ai/contract";
import type { MindDocument, MindNode } from "../../core/markdown";
import { findNode } from "../../core/text-edits";

/** The titles from the note's root down to the node's parent (§11.4 `context.ancestors`): the file name first. */
export function ancestorTitles(document: MindDocument, node: MindNode): string[] {
  const titles: string[] = [];
  let parent = node.parentId === null ? undefined : findNode(document, node.parentId);
  while (parent) {
    titles.unshift(parent.title);
    parent = parent.parentId === null ? undefined : findNode(document, parent.parentId);
  }
  return titles;
}

/**
 * How many levels the AI may write under the node (§11.5): at most 3, and in the headings format no level past H6
 * (an H5 takes 1, an H6 none, and then the AI button does not show).
 */
export function maxDepth(document: MindDocument, node: MindNode): number {
  return document.format === "headings" ? Math.max(0, Math.min(3, 6 - node.level)) : 3;
}

/** The result as a Markdown list, for the clipboard: what the user can paste once the map could not keep it. */
export function outlineMarkdown(items: readonly OutlineItem[]): string {
  const lines = (list: readonly OutlineItem[], depth: number): string[] =>
    list.flatMap(item => [`${"  ".repeat(depth)}- ${item.text}`, ...lines(item.children, depth + 1)]);
  return lines(items, 0).join("\n");
}

/** The input's template list, 質問 (`free`) first: the entrance shown first (本人の決定 2026-10-02). */
export const AI_TEMPLATES: readonly AiTemplate[] = ["free", "summary", "brainstorm", "issue-tree"];
