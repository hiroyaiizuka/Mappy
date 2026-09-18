import type { TextEdit } from './commands';
import { frontmatterLayout, projectMap, type MindDocument, type MindNode } from './markdown';
import { locateFrontmatterKey, parseYamlValue } from './yaml-lite';

/**
 * Frontmatter key holding free-topic positions as `<heading text>: { <layout>: [x, y] }`.
 * The heading text is the identity (§7 of the product plan); Mappy writes the flow
 * style and also reads the block style Obsidian's Properties editor rewrites it into.
 */
export const TOPICS_KEY = 'mappy-topics';
const LAYOUT_PATTERN = /^[a-z][a-z0-9-]*$/u;
const BOM = 0xfeff;

/** Top-left of the topic's root node, relative to the body root's top-left in layout coordinates. */
export interface TopicPosition { x: number; y: number }
/** Positions by layout name; a layout without an entry uses the default placement. */
export type TopicPositions = Record<string, TopicPosition>;
/** Positions by heading text, in frontmatter order. */
export type TopicPositionMap = Map<string, TopicPositions>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function topicPosition(value: unknown): TopicPosition | undefined {
  const pair: unknown[] = Array.isArray(value) ? (value as unknown[]) : isRecord(value) ? [value.x, value.y] : [];
  const [x, y] = pair;
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

/** Interpret a parsed `mappy-topics` value from the frontmatter text or Obsidian's metadata cache. Invalid entries are dropped. */
export function topicPositionsFromValue(value: unknown): TopicPositionMap {
  const result: TopicPositionMap = new Map();
  if (!isRecord(value)) return result;
  for (const [title, layouts] of Object.entries(value)) {
    if (!isRecord(layouts)) continue;
    const positions: TopicPositions = {};
    for (const [layout, point] of Object.entries(layouts)) {
      const position = topicPosition(point);
      if (LAYOUT_PATTERN.test(layout) && position) positions[layout] = position;
    }
    if (Object.keys(positions).length > 0) result.set(title, positions);
  }
  return result;
}

/** Positions from the frontmatter text itself, so an open editor buffer stays authoritative. Reading never writes. */
export function readTopicPositions(source: string): TopicPositionMap {
  const layout = frontmatterLayout(source);
  const key = layout?.closed ? locateFrontmatterKey(source, layout, TOPICS_KEY) : null;
  return key ? topicPositionsFromValue(parseYamlValue(key.inline, key.nested)) : new Map<string, TopicPositions>();
}

/** Plain YAML keys stay readable in Properties; anything YAML or our reader could misread is double-quoted. */
function yamlKey(title: string): string {
  const plain = /^[^\s"'#{}[\],\-?:&*!|>%@`][^:#\t]*$/u.test(title)
    && !/^(?:true|false|null|~|yes|no|on|off|y|n)$/iu.test(title)
    && !/^[-+.]?\d/u.test(title);
  if (plain) return title;
  return `"${title.replace(/[\\"]/gu, (char) => `\\${char}`).replace(/\t/gu, '\\t')}"`;
}

/** The flow style Mappy writes: one line per topic, integers only. Empty when nothing is positioned. */
export function serializeTopicPositions(positions: TopicPositionMap, eol: string): string {
  const lines = [`${TOPICS_KEY}:`];
  for (const [title, layouts] of positions) {
    const entries = Object.entries(layouts).map(([layout, point]) => `${layout}: [${Math.round(point.x)}, ${Math.round(point.y)}]`);
    if (entries.length > 0) lines.push(`  ${yamlKey(title)}: { ${entries.join(', ')} }`);
  }
  return lines.length > 1 ? lines.join(eol) + eol : '';
}

function canonical(positions: TopicPositionMap): string {
  return serializeTopicPositions(new Map([...positions].sort(([left], [right]) => left.localeCompare(right))), '\n');
}

/**
 * Rewrite only the `mappy-topics` key so that it holds exactly `positions`. Other keys keep
 * their bytes; a missing header is created; an unchanged value yields no edit. Entries whose
 * heading no longer exists are kept as they are read: a heading renamed back in Markdown
 * finds its position again, and only the writer that removes a topic drops its entry.
 */
export function planTopicPositions(doc: MindDocument, positions: TopicPositionMap): TextEdit | null {
  const layout = frontmatterLayout(doc.source);
  if (layout && !layout.closed) throw new Error('先に Markdown 側で frontmatter を閉じてください。');
  const text = serializeTopicPositions(positions, doc.eol);
  const key = layout ? locateFrontmatterKey(doc.source, layout, TOPICS_KEY) : null;
  if (key) {
    if (canonical(readTopicPositions(doc.source)) === canonical(positions)) return null;
    return { from: key.from, to: key.to, text };
  }
  if (!text) return null;
  if (layout) return { from: layout.closingFrom, to: layout.closingFrom, text };
  const bom = doc.source.charCodeAt(0) === BOM ? 1 : 0;
  return { from: bom, to: bom, text: `---${doc.eol}${text}---${doc.eol}` };
}

/** Store one layout position for a topic heading; the note body never changes. */
export function planTopicMove(doc: MindDocument, title: string, layout: string, position: TopicPosition): TextEdit | null {
  if (!LAYOUT_PATTERN.test(layout)) throw new Error('レイアウト名が不正です。');
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('トピックの位置が不正です。');
  if (/[\r\n]/u.test(title)) throw new Error('トピックの見出しは 1 行にしてください。');
  const positions = readTopicPositions(doc.source);
  positions.set(title, { ...(positions.get(title) ?? {}), [layout]: position });
  return planTopicPositions(doc, positions);
}

/**
 * Store one layout's position for several headings at once (the body root dragged against its
 * topics: every topic keeps its place on screen, so every offset changes). One edit, or null.
 */
export function planTopicMoves(doc: MindDocument, layout: string, moves: ReadonlyMap<string, TopicPosition>): TextEdit | null {
  if (!LAYOUT_PATTERN.test(layout)) throw new Error('レイアウト名が不正です。');
  const positions = readTopicPositions(doc.source);
  for (const [title, position] of moves) {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('トピックの位置が不正です。');
    if (/[\r\n]/u.test(title)) throw new Error('トピックの見出しは 1 行にしてください。');
    positions.set(title, { ...(positions.get(title) ?? {}), [layout]: position });
  }
  return planTopicPositions(doc, positions);
}

/** One layout's position for a heading, as the rename command receives it from the view. */
export interface TopicPlacement { layout: string; x: number; y: number }

/**
 * Carry a free topic's positions over to its new heading text, in place, so a rename is
 * one edit set. Another current topic that already owns the new text keeps its entry.
 * `place` also stores one layout position under the new text: a topic added on the map
 * is placed where it was pressed by the same edit set that names it.
 */
export function planTopicRename(doc: MindDocument, from: string, to: string, place?: TopicPlacement): TextEdit | null {
  const { topics } = projectMap(doc);
  if (!topics.some((topic) => topic.title === from)) return null;
  if (place && !LAYOUT_PATTERN.test(place.layout)) throw new Error('レイアウト名が不正です。');
  if (place && (!Number.isFinite(place.x) || !Number.isFinite(place.y))) throw new Error('トピックの位置が不正です。');
  const positions = readTopicPositions(doc.source);
  if (!positions.has(from) && !place) return null;
  const taken = from !== to && positions.has(to) && topics.some((topic) => topic.title === to);
  const renamed: TopicPositionMap = new Map();
  for (const [title, layouts] of positions) {
    if (title === from) { if (!taken) renamed.set(to, layouts); continue; }
    if (title === to && !taken) continue;
    renamed.set(title, layouts);
  }
  if (place && !taken) renamed.set(to, { ...(renamed.get(to) ?? {}), [place.layout]: { x: place.x, y: place.y } });
  return planTopicPositions(doc, renamed);
}

/**
 * Drop the entry of a topic that is being deleted, so its section and its position leave in
 * one edit set and return together on Undo. Another current topic with the same heading keeps
 * the entry; entries of headings that no longer exist stay as they are read.
 */
export function planTopicRemoval(doc: MindDocument, node: MindNode): TextEdit | null {
  const { topics } = projectMap(doc);
  if (!topics.some((topic) => topic.id === node.id)) return null;
  if (topics.some((topic) => topic.id !== node.id && topic.title === node.title)) return null;
  const positions = readTopicPositions(doc.source);
  if (!positions.delete(node.title)) return null;
  return planTopicPositions(doc, positions);
}
