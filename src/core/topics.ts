import type { TextEdit } from './commands';
import { frontmatterLayout, projectMap, type MindDocument } from './markdown';
import { locateFrontmatterKey, parseYamlValue } from './yaml-lite';

/**
 * Frontmatter key holding free-topic positions as `<key>: { <layout>: [x, y] }`, the key being the
 * heading text (§7 of the product plan) — `<heading> (2)`, `<heading> (3)`… for the second and later
 * topics sharing one, see `topicKeys`. Mappy writes the flow style and also reads the block style
 * Obsidian's Properties editor rewrites it into.
 */
export const TOPICS_KEY = 'mappy-topics';
const LAYOUT_PATTERN = /^[a-z][a-z0-9-]*$/u;
const BOM = 0xfeff;

/** Top-left of the topic's root node, relative to the body root's top-left in layout coordinates. */
export interface TopicPosition { x: number; y: number }
/** Positions by layout name; a layout without an entry uses the default placement. */
export type TopicPositions = Record<string, TopicPosition>;
/** Positions by key (`topicKeys`), in frontmatter order. */
export type TopicPositionMap = Map<string, TopicPositions>;

/**
 * The `mappy-topics` key of every free topic, by node id: the heading text, and for the second and
 * later topics with the same heading `<heading> (2)`, `<heading> (3)`… in source order, a number whose
 * text is itself a top-level heading of the note (a topic or the body root) being skipped. The one
 * derivation both reading (the view, the embed) and writing (moves, renames, removals) go through, so
 * topics sharing a heading keep positions of their own; the first of a heading keeps the plain key, so
 * notes written before the ordinals read as before.
 */
export function topicKeys(doc: MindDocument): Map<string, string> {
  const { root, topics } = projectMap(doc);
  const titles = new Set(topics.map((topic) => topic.title));
  if (root.kind !== 'root') titles.add(root.title);
  const taken = new Set<string>();
  const keys = new Map<string, string>();
  for (const topic of topics) {
    let key = topic.title;
    for (let ordinal = 2; taken.has(key) || (key !== topic.title && titles.has(key)); ordinal++) key = `${topic.title} (${ordinal})`;
    taken.add(key);
    keys.set(topic.id, key);
  }
  return keys;
}

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
  if (key && layout) {
    if (canonical(readTopicPositions(doc.source)) === canonical(positions)) return null;
    // Removing the last entry from a header that held nothing else removes the header, not just its key.
    const rest = doc.source.slice(layout.bodyFrom, key.from) + doc.source.slice(key.to, layout.closingFrom);
    if (!text && rest.trim() === '') return { from: doc.source.charCodeAt(0) === BOM ? 1 : 0, to: layout.end, text: '' };
    return { from: key.from, to: key.to, text };
  }
  if (!text) return null;
  if (layout) return { from: layout.closingFrom, to: layout.closingFrom, text };
  const bom = doc.source.charCodeAt(0) === BOM ? 1 : 0;
  return { from: bom, to: bom, text: `---${doc.eol}${text}---${doc.eol}` };
}

function assertLayout(layout: string): void {
  if (!LAYOUT_PATTERN.test(layout)) throw new Error('レイアウト名が不正です。');
}

function assertPosition(position: TopicPosition): void {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('トピックの位置が不正です。');
}

/** A key is one line of YAML: a multi-line Setext heading cannot be written (`yamlKey` escapes no line breaks). */
function assertKeyLine(key: string): void {
  if (/[\r\n]/u.test(key)) throw new Error('トピックの見出しは 1 行にしてください。');
}

/**
 * Store one layout's position for topics given by node id (one dragged, or every one when the body root
 * is dragged against them: each keeps its place on screen, so every offset changes). One edit, or null.
 */
export function planTopicMoves(doc: MindDocument, layout: string, moves: ReadonlyMap<string, TopicPosition>): TextEdit | null {
  assertLayout(layout);
  const keys = topicKeys(doc);
  const positions = readTopicPositions(doc.source);
  for (const [id, position] of moves) {
    assertPosition(position);
    const key = keys.get(id);
    if (key === undefined) throw new Error('対象のトピックが変更されています。再選択してください。');
    assertKeyLine(key);
    positions.set(key, { ...(positions.get(key) ?? {}), [layout]: position });
  }
  return planTopicPositions(doc, positions);
}

/** One layout's position for a topic, as the rename and detach commands receive it from the view. */
export interface TopicPlacement { layout: string; x: number; y: number }

/**
 * Carry entries along with their topics through an edit that changes keys (§7): `rekeys` maps the key of
 * each topic before the edit to its key after it (a rename; the second of a heading becoming the first
 * when the first leaves; a reorder), `dropped` lists the keys of topics that leave (a deletion, a join),
 * and `placed` stores one layout position under a key in the same edit (a topic named or detached on
 * the map, where it was pressed). Entries stay in frontmatter order; one whose key a topic takes over is
 * an orphan (keys are unique among current topics) and is replaced. One edit, or null when nothing changes.
 */
export function planTopicRekey(
  doc: MindDocument, rekeys: ReadonlyMap<string, string>, dropped: ReadonlySet<string>, placed?: TopicPlacement & { key: string },
): TextEdit | null {
  if (placed) { assertLayout(placed.layout); assertPosition(placed); assertKeyLine(placed.key); }
  const positions = readTopicPositions(doc.source);
  const taken = new Set(Array.from(rekeys).filter(([from, to]) => from !== to).map(([, to]) => to));
  const result: TopicPositionMap = new Map();
  for (const [key, layouts] of positions) {
    if (dropped.has(key)) continue;
    const to = rekeys.get(key) ?? key;
    if (to === key && taken.has(key)) continue;
    if (to !== key) assertKeyLine(to);
    result.set(to, layouts);
  }
  if (placed) result.set(placed.key, { ...(result.get(placed.key) ?? {}), [placed.layout]: { x: placed.x, y: placed.y } });
  return planTopicPositions(doc, result);
}
