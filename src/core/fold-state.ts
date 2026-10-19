/**
 * A map's folds between its ids and the keys kept for the next opening (LEV-365): what a view hands the memory
 * (`foldEntryOf`) and which nodes the kept keys fold or leave open when the note opens again (`rememberedIds`). Pure
 * functions over the parsed document and its called maps.
 */
import { callerOfCalledNode, type CallProjection } from './calls';
import { foldKeyOf, nodeOfFoldKey, type FoldKey } from './fold-keys';
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

export function rememberedFolds(entry: FoldEntry | undefined): RememberedFolds | undefined {
  if (!entry) return undefined;
  const byText = (keys: readonly FoldKey[]): Map<string, FoldKey> => new Map(keys.map(key => [JSON.stringify(key), key]));
  return { folds: byText(entry.folds), open: byText(entry.open) };
}

/** Which nodes the kept keys name on `map`: those to fold, and the called nodes that start folded but were opened. */
export function rememberedIds(map: FoldedMap, remembered: RememberedFolds): { folds: Set<string>; open: Set<string> } {
  const ids = (keys: Map<string, FoldKey>): Set<string> => {
    const found = new Set<string>();
    for (const key of keys.values()) {
      const id = nodeOfFoldKey(map.document, map.calls, key);
      if (id !== undefined) found.add(id);
    }
    return found;
  };
  return { folds: ids(remembered.folds), open: ids(remembered.open) };
}

/**
 * What a map keeps for its note: the keys of the nodes folded (`collapsed`), and of the called nodes it has shown
 * (`known`) that have children and are not folded — those start folded at every opening, so having opened them is kept
 * too. A kept key of a called map not drawn now (its note unread, not a map for a while, its link broken) stays as it was
 * kept while the item calling it is in the note, as the view keeps that branch's folds (LEV-246, LEV-260); one whose map
 * is drawn without that node, or whose item is gone, is dropped, and so is every key of the host's own nodes no longer
 * there. Sorted (`sortedKeys`), so the same folds make the same entry.
 */
export function foldEntryOf(
  map: FoldedMap, collapsed: ReadonlySet<string>, known: ReadonlySet<string>, remembered?: RememberedFolds,
): FoldEntry {
  const { document, calls } = map;
  const folds = new Map<string, FoldKey>();
  const open = new Map<string, FoldKey>();
  const add = (into: Map<string, FoldKey>, id: string): void => {
    const key = foldKeyOf(document, calls, id);
    if (key) into.set(JSON.stringify(key), key);
  };
  for (const id of collapsed) add(folds, id);
  for (const id of known) {
    if (!collapsed.has(id) && (calls.byId.get(id)?.children.length ?? 0) > 0) add(open, id);
  }
  if (remembered) {
    for (const [kept, into] of [[remembered.folds, folds], [remembered.open, open]] as const) {
      for (const [text, key] of kept) if (!folds.has(text) && !open.has(text) && undrawnCall(map, key)) into.set(text, key);
    }
  }
  return { folds: sortedKeys(folds.values()), open: sortedKeys(open.values()) };
}

/** True for a key into a called map whose calling item is in the note and draws no map now. */
function undrawnCall(map: FoldedMap, key: FoldKey): boolean {
  const boundary = key.indexOf(null);
  if (boundary === -1 || nodeOfFoldKey(map.document, map.calls, key) !== undefined) return false;
  const caller = nodeOfFoldKey(map.document, map.calls, key.slice(0, boundary));
  return caller !== undefined && callerOfCalledNode(caller) === undefined && !map.calls.sources.get(caller)?.root;
}
