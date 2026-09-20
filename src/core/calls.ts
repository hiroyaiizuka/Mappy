/**
 * Calling another map from a node (§5 M12, the display side): an item whose title is
 * one `![[map]]` stands in for the called map's root, and the called map's body tree is
 * grafted under it, so the branches are laid out and drawn like the host's own. Pure
 * functions over parsed documents: reading the called notes (`CallReader`) and drawing
 * are the Obsidian layers' job. Nothing here writes; the called nodes are copies with
 * new ids, and the host's own nodes keep their ids and ranges, so edit commands still
 * address `doc.root`.
 */
import { embedOnlyTitle, embedTrees } from './embed';
import { projectMap, type MapProjection, type MindDocument, type MindNode } from './markdown';

/** What a `![[…]]`-only item resolved to: the called note, parsed, and the heading path it asked for (`''` for the whole note). */
export interface CallTarget {
  path: string;
  subpath: string;
  document: MindDocument;
}

/**
 * By the calling item's id, what it calls. An item whose call failed (not a map, missing,
 * the note itself, a block reference, an unreadable note) is absent and stays a link.
 */
export type CallTargets = ReadonlyMap<string, CallTarget>;

/** Where a node drawn from a called map comes from. */
export interface CallSource {
  /** The host's item whose `![[…]]` called the map. */
  callerId: string;
  path: string;
  subpath: string;
  /** The called note's document and the node the projected node was copied from: its text, body and links are read there. */
  document: MindDocument;
  node: MindNode;
  /** True on the calling item itself, which stands in for the called root and stays the host's own node. */
  root: boolean;
}

/** The host's trees with the called maps grafted in. */
export interface CallProjection {
  /** The body root and the free topics, in the order given, copied where a call changes something. */
  roots: MindNode[];
  /** By projected id, the called map a node comes from; the host's own nodes are absent. */
  sources: ReadonlyMap<string, CallSource>;
  /** Every projected node by id, the host's own and the called ones. */
  byId: ReadonlyMap<string, MindNode>;
}

/** The id a called note's node takes under a calling item; `/` never occurs in a document's own ids. */
export function calledNodeId(callerId: string, nodeId: string): string {
  return `${callerId}/${nodeId}`;
}

/**
 * Graft the called maps into the trees: an item in `targets` whose title is still one
 * embed becomes a copy titled as the called root, its children the called root's children
 * (copied under ids of `calledNodeId`, re-levelled, re-parented) followed by its own. A
 * whole-note call draws the called note's body root; `#heading` draws that section; the
 * called note's free topics are not drawn. Copies of called nodes never consult `targets`,
 * so a call inside a called map stays a link (one level only) and no chain can recurse.
 * The copies keep the called document's ranges, so `nodeBody(source.document, source.node)`
 * reads the called text.
 */
export function projectCalls(roots: readonly MindNode[], targets: CallTargets): CallProjection {
  const sources = new Map<string, CallSource>();
  const byId = new Map<string, MindNode>();
  const projectCalled = (node: MindNode, target: CallTarget, callerId: string, parentId: string, level: number): MindNode => {
    const id = calledNodeId(callerId, node.id);
    const projected: MindNode = {
      ...node, id, parentId, level,
      children: node.children.map((child) => projectCalled(child, target, callerId, id, level + 1)),
    };
    sources.set(id, { callerId, path: target.path, subpath: target.subpath, document: target.document, node, root: false });
    byId.set(id, projected);
    return projected;
  };
  const projectHost = (node: MindNode, parentId: string | null): MindNode => {
    const target = targets.get(node.id);
    const called = target && embedOnlyTitle(node.title) !== null ? embedTrees(target.document, target.subpath)?.root : undefined;
    const own = node.children.map((child) => projectHost(child, node.id));
    let projected: MindNode;
    if (target && called) {
      const grafted = called.children.map((child) => projectCalled(child, target, node.id, node.id, node.level + 1));
      projected = { ...node, parentId, title: called.title, children: [...grafted, ...own] };
      sources.set(node.id, { callerId: node.id, path: target.path, subpath: target.subpath, document: target.document, node: called, root: true });
    } else {
      projected = { ...node, parentId, children: own };
    }
    byId.set(projected.id, projected);
    return projected;
  };
  return { roots: roots.map((root) => projectHost(root, root.parentId)), sources, byId };
}

/** What a document shows: its own body/topic split (`split`) and the same trees with the called maps grafted in (`calls`). */
export interface ShownTrees {
  split: MapProjection;
  calls: CallProjection;
}

/** The one place the split and the grafting are composed: the body root first, then the free topics, in `calls.roots`. */
export function projectShown(document: MindDocument, targets: CallTargets): ShownTrees {
  const split = projectMap(document);
  return { split, calls: projectCalls([split.root, ...split.topics], targets) };
}

/**
 * The folds a called map starts with: every called node below the root that has children,
 * so the map shows the called root's children and no more (a 2,000-node map costs only
 * that), and each fold opens one level at a time. The calling item itself is not folded.
 */
export function initialCallFolds(projection: CallProjection): Set<string> {
  const folds = new Set<string>();
  for (const [id, source] of projection.sources) {
    if (source.root) continue;
    if ((projection.byId.get(id)?.children.length ?? 0) > 0) folds.add(id);
  }
  return folds;
}

/** True for a node drawn from a called map that is not the calling item: read-only on the map. */
export function isCalledNode(projection: CallProjection | undefined, id: string): boolean {
  const source = projection?.sources.get(id);
  return source !== undefined && !source.root;
}
