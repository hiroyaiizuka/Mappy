/**
 * A map's folds between its ids and the keys kept for the next opening (LEV-365): what a view hands the memory
 * (`foldEntryOf`) and which nodes the kept keys fold or leave open when the note opens again (`rememberedIds`). Pure
 * functions over the parsed document and its called maps.
 */
import { callerOfCalledNode, type CallProjection } from './calls';
import { foldKeyMaker, nodeOfFoldKey, type FoldKey } from './fold-keys';
import { sortedKeys, type FoldEntry } from './fold-memory';
import type { MindDocument } from './markdown';

/** A note's map as a view has it: the document and the called maps grafted in. */
export interface FoldedMap {
  document: MindDocument;
  calls: CallProjection;
}

/** The keys kept for a note, by their JSON text. */
export interface RememberedFolds {
  folds: Map<string, FoldKey>;
  open: Map<string, FoldKey>;
}

export function rememberedFolds(entry: FoldEntry): RememberedFolds {
  const byText = (keys: readonly FoldKey[]): Map<string, FoldKey> => new Map(keys.map(key => [JSON.stringify(key), key]));
  return { folds: byText(entry.folds), open: byText(entry.open) };
}

/** The nodes `keys` name on `map` (the kept folds, or the kept opened called nodes); a key no node stands at names none. */
export function rememberedIds(map: FoldedMap, keys: ReadonlyMap<string, FoldKey>): Set<string> {
  const found = new Set<string>();
  for (const key of keys.values()) {
    const id = nodeOfFoldKey(map.document, map.calls, key);
    if (id !== undefined) found.add(id);
  }
  return found;
}

/**
 * What a map keeps for its note: what differs from how the note opens with nothing kept, so a map nobody folded keeps
 * nothing and its opening writes nothing (code review 1 of LEV-365). The host's own nodes folded (`collapsed`); a called
 * map's nodes with children start folded (`initialCallFolds`), so of those only the ones the map has shown (`known`) open
 * are kept, and a called node folded is not (the calling item itself is the host's own node). A kept key of a called map
 * not drawn now (its note unread, not a map for a while, its link broken) stays as it was kept while the item calling it is
 * in the note, as the view keeps that branch's folds (LEV-246, LEV-260); one whose map is drawn without that node, or whose
 * item is gone, is dropped, and so is every key of the host's own nodes no longer there. Sorted (`sortedKeys`), so the
 * same folds make the same entry. `ids` is the key of each node the entry names by its id, for the view to tell how a
 * re-parse moved them (`moves`).
 */
export function foldEntryOf(
  map: FoldedMap, collapsed: ReadonlySet<string>, known: ReadonlySet<string>, remembered?: RememberedFolds,
): { entry: FoldEntry; ids: Map<string, FoldKey> } {
  const { document, calls } = map;
  const folds = new Map<string, FoldKey>();
  const open = new Map<string, FoldKey>();
  const ids = new Map<string, FoldKey>();
  const keyOf = foldKeyMaker(document, calls);
  const add = (into: Map<string, FoldKey>, id: string): void => {
    const key = keyOf(id);
    if (!key) return;
    into.set(JSON.stringify(key), key);
    ids.set(id, key);
  };
  for (const id of collapsed) if (callerOfCalledNode(id) === undefined) add(folds, id);
  for (const id of known) {
    if (callerOfCalledNode(id) !== undefined && !collapsed.has(id) && (calls.byId.get(id)?.children.length ?? 0) > 0) add(open, id);
  }
  if (remembered) {
    for (const [kept, into] of [[remembered.folds, folds], [remembered.open, open]] as const) {
      for (const [text, key] of kept) if (!folds.has(text) && !open.has(text) && undrawnCall(map, key)) into.set(text, key);
    }
  }
  return { entry: { folds: sortedKeys(folds.values()), open: sortedKeys(open.values()) }, ids };
}

/**
 * How a re-parse moved the keys of the nodes a map had kept (`before`, by id) to `after`: the keys whose node now stands
 * elsewhere or under another title (a rename on the map, a move, a sibling of the same title added before it), and the
 * keys whose node is gone or no longer folded or opened. What the map changed by itself, not what it shows: another map of
 * the note may have changed the folds kept since (code review 2 of LEV-365).
 */
export function moves(before: ReadonlyMap<string, FoldKey>, after: ReadonlyMap<string, FoldKey>): { moved: Map<string, FoldKey>; dropped: Set<string> } {
  const moved = new Map<string, FoldKey>();
  const dropped = new Set<string>();
  for (const [id, key] of before) {
    const text = JSON.stringify(key);
    const now = after.get(id);
    if (!now) dropped.add(text);
    else if (JSON.stringify(now) !== text) moved.set(text, now);
  }
  return { moved, dropped };
}

/** True for a key into a called map whose calling item is in the note and draws no map now. */
function undrawnCall(map: FoldedMap, key: FoldKey): boolean {
  const boundary = key.indexOf(null);
  if (boundary === -1 || nodeOfFoldKey(map.document, map.calls, key) !== undefined) return false;
  const caller = nodeOfFoldKey(map.document, map.calls, key.slice(0, boundary));
  return caller !== undefined && callerOfCalledNode(caller) === undefined && !map.calls.sources.get(caller)?.root;
}
