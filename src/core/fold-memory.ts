/**
 * The folds kept between the openings of a note (LEV-365, the person's decision of 2026-10-19): one file of Mappy's own in
 * the plugin's folder, by note path — not the note, not `localStorage`. This is its shape and the rules that keep it small;
 * reading and writing it through the vault's adapter is `src/obsidian/fold-store.ts`'s.
 *
 * ```json
 * { "version": 1, "savedAt": 1792377279563,
 *   "notes": { "Maps/Plan.md": { "at": 1792377279563, "folds": [["Plan", "Phase 1"], ["Plan", "Task", 2]], "open": [["Plan", "![[Other]]", null, "C1"]] } } }
 * ```
 *
 * `folds` are the nodes folded (`FoldKey`), `open` the called maps' nodes that start folded (§5 M12, `initialCallFolds`) and
 * were opened: without it they would fold again at every opening (a called node folded is as it starts, and is not kept).
 * `at` is when the note's folds last changed or a map last opened it, which decides the notes dropped first past the
 * limits. A note with neither is not kept.
 */
import { isFoldKey, type FoldKey } from './fold-keys';

export const FOLD_MEMORY_VERSION = 1;

/** What a map keeps for a note. */
export interface FoldEntry {
  folds: FoldKey[];
  open: FoldKey[];
}

export interface StoredFolds extends FoldEntry {
  at: number;
}

/**
 * How much the file holds at most: the notes whose folds changed (or were opened) last, up to `notes` of them and `bytes` of the file
 * (UTF-8). 1,000 notes of 20 folds each, three titles deep in Japanese, are 1.3 MB (artifacts/lev-365), well inside.
 * A file larger than `readBytes` is not read at all (the map opens with nothing folded, as with an unreadable one).
 */
export const FOLD_LIMITS = { notes: 1000, bytes: 4 * 1024 * 1024, readBytes: 8 * 1024 * 1024 } as const;

/** The notes of a file's text, or null when the text is not such a file (unreadable JSON, another version, another shape). */
export function readFoldFile(text: string): { savedAt: number; notes: Map<string, StoredFolds> } | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!isRecord(value) || value.version !== FOLD_MEMORY_VERSION || !isRecord(value.notes)) return null;
  const savedAt = typeof value.savedAt === 'number' && Number.isFinite(value.savedAt) ? value.savedAt : 0;
  const notes = new Map<string, StoredFolds>();
  for (const [path, stored] of Object.entries(value.notes)) {
    if (!isRecord(stored)) continue;
    const folds = keys(stored.folds);
    const open = keys(stored.open);
    if (folds.length === 0 && open.length === 0) continue;
    notes.set(path, { at: typeof stored.at === 'number' && Number.isFinite(stored.at) ? stored.at : 0, folds, open });
  }
  return { savedAt, notes };
}

/**
 * The file's text for `notes`, past the limits the notes whose folds changed longest ago left out (they open with nothing
 * folded, as a note never folded does). `notes` is left as it is: the caller drops what `kept` does not name.
 */
export function writeFoldFile(notes: ReadonlyMap<string, StoredFolds>, savedAt: number, limits: { notes: number; bytes: number } = FOLD_LIMITS): { text: string; kept: Set<string> } {
  const newest = Array.from(notes.entries()).sort((a, b) => b[1].at - a[1].at).slice(0, limits.notes);
  const sizes = newest.map(([path, stored]) => utf8Length(JSON.stringify(path)) + utf8Length(JSON.stringify(stored)) + 2);
  let total = 64 + sizes.reduce((sum, size) => sum + size, 0);
  while (newest.length > 0 && total > limits.bytes) {
    newest.pop();
    total -= sizes.pop() ?? 0;
  }
  const kept = new Set(newest.map(([path]) => path));
  const ordered = Object.fromEntries(Array.from(notes.entries()).filter(([path]) => kept.has(path)));
  return { text: JSON.stringify({ version: FOLD_MEMORY_VERSION, savedAt, notes: ordered }), kept };
}

/** The note paths that `from` stood for once it was renamed to `to`: the note itself, or every note in the folder. */
export function renamedPaths(paths: Iterable<string>, from: string, to: string): Map<string, string> {
  const moved = new Map<string, string>();
  for (const path of paths) {
    if (path === from) moved.set(path, to);
    else if (path.startsWith(`${from}/`)) moved.set(path, `${to}${path.slice(from.length)}`);
  }
  return moved;
}

/** Whether `path` is `removed` or inside it (a deleted folder). */
export function isRemoved(path: string, removed: string): boolean {
  return path === removed || path.startsWith(`${removed}/`);
}

/** Two entries the same, the order of their keys included (each map lists them sorted, `sortedKeys`). */
export function sameFolds(a: FoldEntry | undefined, b: FoldEntry | undefined): boolean {
  return JSON.stringify(a ? [a.folds, a.open] : null) === JSON.stringify(b ? [b.folds, b.open] : null);
}

/** Keys in one order whatever order the folds were made in, so the same folds compare and write the same. */
export function sortedKeys(keys: Iterable<FoldKey>): FoldKey[] {
  const unique = new Map<string, FoldKey>();
  for (const key of keys) unique.set(JSON.stringify(key), key);
  return Array.from(unique.keys()).sort().map(text => unique.get(text)!);
}

function keys(value: unknown): FoldKey[] {
  return Array.isArray(value) ? (value as unknown[]).filter(isFoldKey) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** UTF-8 bytes of `text` without encoding it: a title is mostly Japanese, three bytes a character. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; index += 1; }
    else bytes += 3;
  }
  return bytes;
}
