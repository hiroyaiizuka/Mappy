/**
 * Where a fold is on a map, in words that outlive a parse (LEV-365): node ids are handed out per parse and carried only
 * across the parses of one view (`parseMarkdown`'s `previous`), so a fold kept for the next opening of a note names its
 * node by the titles on the way to it instead. Pure functions over the parsed document and the called maps grafted in
 * (§5 M12); keeping the keys between openings is the Obsidian layer's (`src/obsidian/fold-store.ts`).
 */
import { callerOfCalledNode, type CallProjection } from './calls';
import type { MindDocument, MindNode } from './markdown';

/**
 * A node's place: the titles from the top of the note down to it, the file name's root left out (the note's name, which a
 * rename changes, is not part of it), so the root itself is `[]`. A number after a title says which of the siblings with
 * that title it is, counted from the first in the note (2 for the second; the first has none), as `topicKeys` tells free
 * topics of one heading apart. `null` steps from a calling item into the map it calls: the titles after it are the called
 * note's, counted below the called root. JSON as it is, so the stored file needs no escaping of its own.
 */
export type FoldKey = (string | number | null)[];

/** Whether `value` is a key as `foldKeyOf` makes them: titles, each maybe followed by its number (2 or more), and at most one `null` after a title. */
export function isFoldKey(value: unknown): value is FoldKey {
  if (!Array.isArray(value)) return false;
  let boundary = false;
  let previous: unknown = undefined;
  for (const item of value as unknown[]) {
    if (typeof item === 'number') {
      if (typeof previous !== 'string' || !Number.isInteger(item) || item < 2) return false;
    } else if (item === null) {
      if (boundary || previous === undefined || previous === null) return false;
      boundary = true;
    } else if (typeof item !== 'string') return false;
    previous = item;
  }
  return previous !== null;
}

/** The node under `siblings` that a key's step names, and how many items of the key the step took. */
function resolveStep(key: FoldKey, at: number, siblings: readonly MindNode[]): { node: MindNode | undefined; used: number } {
  const title = key[at];
  if (typeof title !== 'string') return { node: undefined, used: 1 };
  const next = key[at + 1];
  const ordinal = typeof next === 'number' ? next : 1;
  let seen = 0;
  const node = siblings.find(sibling => sibling.title === title && ++seen === ordinal);
  return { node, used: typeof next === 'number' ? 2 : 1 };
}

const byIdCache = new WeakMap<MindDocument, Map<string, MindNode>>();

function byId(document: MindDocument): Map<string, MindNode> {
  let nodes = byIdCache.get(document);
  if (!nodes) {
    nodes = new Map([document.root, ...document.nodes].map(node => [node.id, node]));
    byIdCache.set(document, nodes);
  }
  return nodes;
}

/** The children of a calling item that come from the map it calls (its own come after them). */
function calledChildren(calls: CallProjection, callerId: string): MindNode[] {
  return calls.byId.get(callerId)?.children.filter(child => callerOfCalledNode(child.id) === callerId) ?? [];
}

/**
 * The key of the node `id` of `document`, or of a called map's node drawn under one of its items (`calls`); undefined
 * for an id neither knows. The host's own nodes go by their titles as written (a calling item by its `![[…]]`, not by the
 * called root's title it shows), a called node by its titles in the called note.
 */
export function foldKeyOf(document: MindDocument, calls: CallProjection | undefined, id: string): FoldKey | undefined {
  return foldKeyMaker(document, calls)(id);
}

/**
 * `foldKeyOf` for many nodes of one map: a node's key is its parent's and one step, each made once, and the numbers of a
 * parent's same-titled children are counted once — so keying every node of a large called map is one pass over it, not
 * a walk up from each with the siblings scanned at every step (code review 2 of LEV-365). For one document and projection.
 */
export function foldKeyMaker(document: MindDocument, calls: CallProjection | undefined): (id: string) => FoldKey | undefined {
  const nodes = byId(document);
  const keys = new Map<string, FoldKey | null>();
  const numbers = new Map<string, Map<string, number>>();
  /** The step to `node` among `siblings` (the children of the parent `under` names): its title, and its number when another before it has that title. */
  const stepTo = (under: string, siblings: readonly MindNode[], node: MindNode): FoldKey => {
    let table = numbers.get(under);
    if (!table) {
      table = new Map();
      const seen = new Map<string, number>();
      for (const sibling of siblings) {
        const number = (seen.get(sibling.title) ?? 0) + 1;
        seen.set(sibling.title, number);
        table.set(sibling.id, number);
      }
      numbers.set(under, table);
    }
    const number = table.get(node.id) ?? 1;
    return number > 1 ? [node.title, number] : [node.title];
  };
  const keyOf = (id: string): FoldKey | undefined => {
    const known = keys.get(id);
    if (known !== undefined) return known ?? undefined;
    let key: FoldKey | undefined;
    const caller = callerOfCalledNode(id);
    const node = caller === undefined ? nodes.get(id) : calls?.byId.get(id);
    if (node?.kind === 'root' && caller === undefined) key = [];
    else if (node && node.parentId !== null) {
      const parentId = node.parentId;
      if (caller !== undefined && parentId === caller && calls) {
        const host = keyOf(caller);
        if (host) key = [...host, null, ...stepTo(`${caller}/`, calledChildren(calls, caller), node)];
      } else {
        const siblings = caller === undefined ? nodes.get(parentId)?.children : calls?.byId.get(parentId)?.children;
        const parent = siblings ? keyOf(parentId) : undefined;
        if (siblings && parent) key = [...parent, ...stepTo(parentId, siblings, node)];
      }
    }
    keys.set(id, key ?? null);
    return key;
  };
  return keyOf;
}

/** The id of the node `key` names in `document` and its called maps, or undefined when no node stands there now. */
export function nodeOfFoldKey(document: MindDocument, calls: CallProjection | undefined, key: FoldKey): string | undefined {
  const boundary = key.indexOf(null);
  const host = boundary === -1 ? key : key.slice(0, boundary);
  let node: MindNode | undefined = document.root;
  for (let at = 0; at < host.length && node;) {
    const found = resolveStep(host, at, node.children);
    node = found.node;
    at += found.used;
  }
  if (!node || boundary === -1) return node?.id;
  if (!calls) return undefined;
  const callerId = node.id;
  const called = key.slice(boundary + 1);
  let siblings = calledChildren(calls, callerId);
  let found: MindNode | undefined;
  for (let at = 0; at < called.length;) {
    const taken = resolveStep(called, at, siblings);
    found = taken.node;
    if (!found) return undefined;
    siblings = found.children;
    at += taken.used;
  }
  return found?.id;
}
