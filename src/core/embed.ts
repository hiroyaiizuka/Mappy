/**
 * What `![[note]]` and `![[note#heading]]` show when another note embeds a map
 * (§5 M10): which note counts as a map, which section a heading path names, and
 * which nodes are visible when the embed opens. Pure functions over the parsed
 * document, so the reading of an open editor buffer stays authoritative and the
 * Obsidian layer only resolves the link and owns the rendering lifecycle.
 */
import { layoutFromValue, type LayoutMode } from './layout-mode';
import { EXCALIDRAW_KEY, LAYOUT_KEY, MAPPY_KEY } from './map-keys';
import { frontmatterLayout, projectMap, type MindDocument, type MindNode } from './markdown';
import type { TopicPositionMap } from './topics';
import { locateFrontmatterKey, parseYamlValue } from './yaml-lite';

/**
 * The layout a note asks for, read from its own text: `mappy: true` (the YAML
 * boolean in any of its spellings, never the string) makes it a map, `mappy-layout`
 * picks the layout, and an Excalidraw drawing is never claimed. Null for every
 * other note. Same verdict as the metadata cache (`readMapLayout`).
 */
export function readMapFromSource(source: string): LayoutMode | null {
  const layout = frontmatterLayout(source);
  if (!layout?.closed) return null;
  const read = (key: string): unknown => {
    const block = locateFrontmatterKey(source, layout, key);
    return block ? parseYamlValue(block.inline, block.nested) : undefined;
  };
  if (read(MAPPY_KEY) !== true || read(EXCALIDRAW_KEY) !== undefined) return null;
  return layoutFromValue(read(LAYOUT_KEY));
}

/**
 * Heading text as Obsidian compares it for `[[note#heading]]` (its `stripHeading`):
 * link-breaking characters become spaces, runs of whitespace shrink to one, and
 * case is ignored. Kept in core so a test and the browser page match the same way.
 */
export function normalizeHeading(text: string): string {
  return text.replace(/[:#|^\\\r\n]|%%|\[\[|\]\]/gu, ' ').replace(/\s+/gu, ' ').trim().toLowerCase();
}

/**
 * The link an item shows when its title is one embed and nothing else (§5 M12):
 * `![[note]]` or `![[note#heading]]`, with only whitespace around it; an alias or
 * size after `|` is dropped, as Obsidian drops it from the embed's `src`. Null for
 * anything else, so an embed inside a sentence, two embeds, or an inline code span
 * keep the rendering they have (the link, §5 M10). Whether the note is a map, and
 * whether drawing it would recurse, is the caller's to decide.
 */
export function embedOnlyTitle(title: string): string | null {
  const match = /^!\[\[([^\]\r\n|]+)(?:\|[^\]\r\n]*)?\]\]$/u.exec(title.trim());
  const linktext = match?.[1]?.trim();
  return linktext ? linktext : null;
}

/** Only `#^id` (anywhere in the path) is a block reference; those stay Obsidian's embeds. */
export function isBlockReference(subpath: string): boolean {
  return subpath.split('#').some((part) => part.trimStart().startsWith('^'));
}

function* headingsBelow(scope: MindNode): Generator<MindNode> {
  const pending = [...scope.children].reverse();
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) break;
    if (node.kind === 'atx' || node.kind === 'setext') yield node;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child) pending.push(child);
    }
  }
}

/**
 * The section a heading path names, the way Obsidian resolves `[[note#A#B]]`: the
 * first heading in the note whose text matches A, then the first B inside A's
 * section. Same-named headings resolve to the first one. List items are never
 * headings, a block reference or a missing heading resolves to nothing.
 */
export function findSection(doc: MindDocument, subpath: string, normalize = normalizeHeading): MindNode | null {
  if (isBlockReference(subpath)) return null;
  const parts = subpath.split('#').map((part) => normalize(part)).filter((part) => part !== '');
  if (parts.length === 0) return null;
  let scope = doc.root;
  for (const part of parts) {
    let found: MindNode | null = null;
    for (const heading of headingsBelow(scope)) {
      if (normalize(heading.title) === part) { found = heading; break; }
    }
    if (!found) return null;
    scope = found;
  }
  return scope;
}

/** The trees an embed draws: one body root and, for a whole-note embed, the free topics beside it. */
export interface EmbedTrees {
  root: MindNode;
  topics: MindNode[];
}

/**
 * `![[note]]` shows the map as the note opens it (body and free topics, §5 M7);
 * `![[note#heading]]` shows that section's subtree alone. Null when the heading
 * is missing or names a block.
 */
export function embedTrees(doc: MindDocument, subpath: string, normalize = normalizeHeading): EmbedTrees | null {
  if (subpath.replace(/^#/u, '').trim() === '') {
    const { root, topics } = projectMap(doc);
    return { root, topics };
  }
  const section = findSection(doc, subpath, normalize);
  return section ? { root: section, topics: [] } : null;
}

/**
 * The folds when an embed opens: every branch below the roots is closed, so the frame
 * shows the roots and their first level and a large map costs only that (§5 M10);
 * opening a branch then reveals one level at a time, the count on each fold saying
 * how much is behind it.
 */
export function initialFolds(trees: EmbedTrees): Set<string> {
  const folds = new Set<string>();
  const pending = [...trees.root.children, ...trees.topics.flatMap((topic) => topic.children)];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) break;
    if (node.children.length === 0) continue;
    folds.add(node.id);
    pending.push(...node.children);
  }
  return folds;
}

/** Preorder over the roots, skipping the children of folded nodes. */
export function visibleNodes(trees: EmbedTrees, collapsed: ReadonlySet<string>): MindNode[] {
  const result: MindNode[] = [];
  const pending = [trees.root, ...trees.topics].reverse();
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) break;
    result.push(node);
    if (!collapsed.has(node.id)) pending.push(...[...node.children].reverse());
  }
  return result;
}

/** Stored positions for this layout, one per heading text (the first topic of a name uses it, as the map view does). */
export function embedTopicLayouts(trees: EmbedTrees, positions: TopicPositionMap, mode: LayoutMode): { tree: MindNode; position: { x: number; y: number } | null }[] {
  const used = new Set<string>();
  return trees.topics.map((topic) => {
    const stored = used.has(topic.title) ? undefined : positions.get(topic.title)?.[mode];
    used.add(topic.title);
    return { tree: topic, position: stored ? { x: stored.x, y: stored.y } : null };
  });
}
