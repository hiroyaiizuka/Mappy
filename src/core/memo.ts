import { applyEdits, type TextEdit } from './commands';
import { MEMO_ID_PATTERN, frontmatterLayout, parseMarkdown, type MemoBlock, type MindDocument } from './markdown';
import { locateFrontmatterKey, parseYamlValue } from './yaml-lite';

/** Frontmatter key holding memo positions as `<id>: { <layout>: [x, y] }`. */
export const MEMOS_KEY = 'mappy-memos';
const LAYOUT_PATTERN = /^[a-z][a-z0-9-]*$/u;
const BOM = 0xfeff;

export interface MemoPosition { x: number; y: number }

export interface Memo {
  /** Empty when the fence has no usable ID yet; the next write assigns one. */
  id: string;
  /** Raw text between the fences with the document's line endings. */
  text: string;
  /** Positions by layout name; absent layouts use the view's default placement. */
  positions: Record<string, MemoPosition>;
  block: MemoBlock;
}

export interface MemoPlan { edits: TextEdit[]; id: string }

interface MemoEntry { id: string; positions: Record<string, MemoPosition> }

type Positions = Map<string, Record<string, MemoPosition>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function memoPosition(value: unknown): MemoPosition | undefined {
  const pair: unknown[] = Array.isArray(value) ? (value as unknown[]) : isRecord(value) ? [value.x, value.y] : [];
  const [x, y] = pair;
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

/** Interpret a parsed `mappy-memos` value from the frontmatter text or Obsidian's metadata cache. */
export function memoPositionsFromValue(value: unknown): Positions {
  const result: Positions = new Map();
  if (!isRecord(value)) return result;
  for (const [id, layouts] of Object.entries(value)) {
    if (!MEMO_ID_PATTERN.test(id) || !isRecord(layouts)) continue;
    const positions: Record<string, MemoPosition> = {};
    for (const [layout, point] of Object.entries(layouts)) {
      const position = memoPosition(point);
      if (LAYOUT_PATTERN.test(layout) && position) positions[layout] = position;
    }
    if (Object.keys(positions).length > 0) result.set(id, positions);
  }
  return result;
}

/** Positions from the frontmatter text itself, so an open editor buffer stays authoritative. */
export function readMemoPositions(source: string): Positions {
  const layout = frontmatterLayout(source);
  const key = layout?.closed ? locateFrontmatterKey(source, layout, MEMOS_KEY) : null;
  return key ? memoPositionsFromValue(parseYamlValue(key.inline, key.nested)) : new Map<string, Record<string, MemoPosition>>();
}

/** Memo text and positions from the current source. Reading never writes. */
export function readMemos(doc: MindDocument): Memo[] {
  const positions = readMemoPositions(doc.source);
  return doc.memoBlocks.map((block) => ({
    id: block.id, text: doc.source.slice(block.textFrom, block.textTo),
    positions: { ...(positions.get(block.id) ?? {}) }, block,
  }));
}

function normalizeNewlines(text: string, eol: string): string {
  return text.replace(/\r\n?|\n/gu, eol);
}

function closesFence(text: string, fence: string): boolean {
  const pattern = new RegExp(`^ {0,3}[${fence.charAt(0)}]{${fence.length},}[ \\t]*$`, 'u');
  return text.split(/\r?\n/u).some((line) => pattern.test(line));
}

function serializeBlock(id: string, text: string, eol: string): string {
  let fence = '```';
  while (closesFence(text, fence)) fence += '`';
  return `${fence}mappy-memo ${id}${eol}${text ? text + eol : ''}${fence}`;
}

function serializePositions(entries: MemoEntry[], eol: string): string {
  const lines = [`${MEMOS_KEY}:`];
  for (const entry of entries) {
    const layouts = Object.entries(entry.positions)
      .map(([layout, point]) => `${layout}: [${Math.round(point.x)}, ${Math.round(point.y)}]`);
    if (entry.id && layouts.length > 0) lines.push(`  ${entry.id}: { ${layouts.join(', ')} }`);
  }
  return lines.length > 1 ? lines.join(eol) + eol : '';
}

function canonicalPositions(entries: MemoEntry[]): string {
  return serializePositions([...entries].sort((left, right) => left.id.localeCompare(right.id)), '\n');
}

function requireClosedFrontmatter(doc: MindDocument): ReturnType<typeof frontmatterLayout> {
  const layout = frontmatterLayout(doc.source);
  if (layout && !layout.closed) throw new Error('先に Markdown 側で frontmatter を閉じてください。');
  return layout;
}

/** Rewrite only the `mappy-memos` key. Other keys keep their bytes; a missing header is created. */
function positionsEdit(doc: MindDocument, entries: MemoEntry[]): TextEdit | null {
  const text = serializePositions(entries, doc.eol);
  const layout = requireClosedFrontmatter(doc);
  const key = layout ? locateFrontmatterKey(doc.source, layout, MEMOS_KEY) : null;
  if (key) {
    const existing = [...readMemoPositions(doc.source)].map(([id, positions]) => ({ id, positions }));
    if (canonicalPositions(existing) === canonicalPositions(entries)) return null;
    return { from: key.from, to: key.to, text };
  }
  if (!text) return null;
  if (layout) return { from: layout.closingFrom, to: layout.closingFrom, text };
  const bom = doc.source.charCodeAt(0) === BOM ? 1 : 0;
  return { from: bom, to: bom, text: `---${doc.eol}${text}---${doc.eol}` };
}

/** Everything a memo edit must leave untouched: other frontmatter keys, all content before the memos, and any comment after them. */
function protectedContent(doc: MindDocument): string {
  const layout = frontmatterLayout(doc.source);
  const key = layout?.closed ? locateFrontmatterKey(doc.source, layout, MEMOS_KEY) : null;
  const yaml = !layout ? '' : key
    ? doc.source.slice(layout.bodyFrom, key.from) + doc.source.slice(key.to, layout.closingFrom)
    : doc.source.slice(layout.bodyFrom, layout.closingFrom);
  const last = doc.memoBlocks[doc.memoBlocks.length - 1];
  const tail = last ? doc.source.slice(last.to) : '';
  // A comment after the last fence survives deletion by losing only the EOL that separated it.
  const kept = /^\s*$/u.test(tail) ? '' : tail.replace(/^\r?\n/u, '');
  return JSON.stringify([yaml, doc.source.slice(layout?.end ?? 0, doc.memoRegion?.from ?? doc.source.length) + kept]);
}

/** Planners list edits in document order; two insertions at one offset (an empty note) become one. */
function mergedInsertions(edits: TextEdit[]): TextEdit[] {
  const merged: TextEdit[] = [];
  for (const edit of edits) {
    const previous = merged[merged.length - 1];
    if (previous && previous.from === previous.to && edit.from === previous.from && edit.to === edit.from) previous.text += edit.text;
    else merged.push({ ...edit });
  }
  return merged;
}

function checked(doc: MindDocument, edits: TextEdit[], id: string, expected: (updated: MindDocument) => boolean): MemoPlan {
  const merged = mergedInsertions(edits);
  const updated = parseMarkdown(applyEdits(doc.source, merged), doc.root.title, undefined, doc.format);
  if (protectedContent(updated) !== protectedContent(doc) || !expected(updated)) {
    throw new Error('メモの変更が本文や他の frontmatter に影響するため中止しました。Markdown の構文を確認してください。');
  }
  return { edits: merged, id };
}

function locate(doc: MindDocument, memo: Memo): { block: MemoBlock; index: number } {
  const index = doc.memoBlocks.findIndex((block) => block.from === memo.block.from && block.id === memo.id);
  const block = doc.memoBlocks[index];
  if (!block) throw new Error('対象のメモが変更されています。再選択してください。');
  return { block, index };
}

function freshIds(doc: MindDocument): () => string {
  const used = new Set([...doc.memoBlocks.map((block) => block.id), ...readMemoPositions(doc.source).keys()]);
  let counter = 0;
  return () => {
    for (;;) {
      counter += 1;
      const id = `m${counter}`;
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };
}

function checkPosition(layout: string, position: MemoPosition): void {
  if (!LAYOUT_PATTERN.test(layout)) throw new Error('レイアウト名が不正です。');
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('メモの位置が不正です。');
}

function blockText(doc: MindDocument, block: MemoBlock): string {
  return doc.source.slice(block.textFrom, block.textTo);
}

/** Append a memo fence after the existing ones (or at the end of the note) and optionally place it. */
export function planMemoAdd(doc: MindDocument, text: string, placement?: { layout: string; position: MemoPosition }): MemoPlan {
  requireClosedFrontmatter(doc);
  if (placement) checkPosition(placement.layout, placement.position);
  const fresh = freshIds(doc);
  const normalized = normalizeNewlines(text, doc.eol);
  const last = doc.memoBlocks[doc.memoBlocks.length - 1];
  const lastId = last && !last.closed && !last.id ? fresh() : last?.id ?? '';
  const id = fresh();
  const block = serializeBlock(id, normalized, doc.eol);
  const edits: TextEdit[] = [];
  if (!last) {
    // Keep the note's trailing-newline style: the region owns one separator line either way.
    const prefix = doc.source.length === 0 ? '' : doc.eol;
    const suffix = doc.source.endsWith('\n') ? doc.eol : '';
    edits.push({ from: doc.source.length, to: doc.source.length, text: prefix + block + suffix });
  } else if (last.closed) {
    edits.push({ from: last.to, to: last.to, text: doc.eol + doc.eol + block });
  } else {
    // An unfinished last fence would swallow the new one; close it in place first.
    const closed = serializeBlock(lastId, blockText(doc, last), doc.eol);
    edits.push({ from: last.from, to: last.to, text: closed + doc.eol + doc.eol + block });
  }
  if (placement) {
    const entries: MemoEntry[] = [...readMemos(doc), { id, positions: { [placement.layout]: placement.position } }];
    const frontmatter = positionsEdit(doc, entries);
    if (frontmatter) edits.unshift(frontmatter);
  }
  return checked(doc, edits, id, (updated) => {
    const added = updated.memoBlocks[updated.memoBlocks.length - 1];
    return updated.memoBlocks.length === doc.memoBlocks.length + 1 && added?.id === id && blockText(updated, added) === normalized;
  });
}

/** Replace only the memo's text lines; the fence is rewritten just when it must change. */
export function planMemoText(doc: MindDocument, memo: Memo, text: string): MemoPlan {
  const { block, index } = locate(doc, memo);
  const normalized = normalizeNewlines(text, doc.eol);
  const id = block.id || freshIds(doc)();
  const edit: TextEdit = block.closed && block.id && !closesFence(normalized, block.fence)
    ? { from: block.textFrom, to: block.closeFrom, text: normalized ? normalized + doc.eol : '' }
    : { from: block.from, to: block.to, text: serializeBlock(id, normalized, doc.eol) };
  return checked(doc, [edit], id, (updated) => {
    const current = updated.memoBlocks[index];
    return updated.memoBlocks.length === doc.memoBlocks.length && current?.id === id && blockText(updated, current) === normalized;
  });
}

/** Store a layout position in frontmatter; the note body changes only when the memo still lacks an ID. */
export function planMemoMove(doc: MindDocument, memo: Memo, layout: string, position: MemoPosition): MemoPlan {
  checkPosition(layout, position);
  const { block, index } = locate(doc, memo);
  const id = block.id || freshIds(doc)();
  const edits: TextEdit[] = [];
  if (!block.id) edits.push({ from: block.from, to: block.to, text: serializeBlock(id, blockText(doc, block), doc.eol) });
  const entries = readMemos(doc).map((entry, order) => order === index
    ? { id, positions: { ...entry.positions, [layout]: position } } : entry);
  const frontmatter = positionsEdit(doc, entries);
  if (frontmatter) edits.unshift(frontmatter);
  return checked(doc, edits, id, (updated) => {
    const current = readMemos(updated)[index];
    const stored = current?.positions[layout];
    return updated.memoBlocks.length === doc.memoBlocks.length && current?.id === id
      && stored?.x === Math.round(position.x) && stored.y === Math.round(position.y);
  });
}

/** Remove one fence with its separator and drop its positions; other memos and the tail stay. */
export function planMemoDelete(doc: MindDocument, memo: Memo): MemoPlan {
  const { block, index } = locate(doc, memo);
  const blocks = doc.memoBlocks;
  const next = blocks[index + 1];
  const previous = blocks[index - 1];
  let edit: TextEdit;
  if (next) edit = { from: block.from, to: next.from, text: '' };
  else if (previous) edit = { from: previous.to, to: block.to, text: '' };
  else {
    const tail = doc.source.slice(block.to);
    const eol = /^\r?\n/u.test(tail) ? (tail.startsWith('\r') ? 2 : 1) : 0;
    edit = { from: doc.memoRegion?.from ?? block.from, to: /^\s*$/u.test(tail) ? doc.source.length : block.to + eol, text: '' };
  }
  const frontmatter = positionsEdit(doc, readMemos(doc).filter((_entry, order) => order !== index));
  return checked(doc, frontmatter ? [frontmatter, edit] : [edit], block.id,
    (updated) => updated.memoBlocks.length === blocks.length - 1);
}
