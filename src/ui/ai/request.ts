import type { AiTemplate, OutlineItem } from "../../ai/contract";
import { nodeBody } from "../../core/body";
import type { MindDocument, MindNode } from "../../core/markdown";
import { findNode } from "../../core/text-edits";

/** What a node points at, for the input's defaults (§5 M9 LEV-271: a URL, YouTube or PDF node asks for a summary). */
export type NodeMaterial = "youtube" | "pdf" | "url" | null;

const YOUTUBE = /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?[^\s)\]]*v=|shorts\/)|youtu\.be\/)[\w-]/iu;
const PDF = /(?:\[\[[^\]|#]+\.pdf(?:[#|][^\]]*)?\]\]|\]\([^)\s]+\.pdf(?:[#?][^)\s]*)?\)|https?:\/\/[^\s)\]]+\.pdf\b)/iu;
const URL_TEXT = /https?:\/\/[^\s)\]]+/iu;

/** The material the node's title and body point at: a YouTube video before a PDF before any other URL, else none. */
export function nodeMaterial(document: MindDocument, node: MindNode): NodeMaterial {
  const text = `${node.title}\n${node.kind === "root" ? "" : nodeBody(document, node)}`;
  if (YOUTUBE.test(text)) return "youtube";
  if (PDF.test(text)) return "pdf";
  if (URL_TEXT.test(text)) return "url";
  return null;
}

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

export const AI_TEMPLATES: readonly AiTemplate[] = ["summary", "brainstorm", "issue-tree", "free"];
