import type { DropPosition } from "../core/commands";
import type { LayoutMode } from "../core/layout-mode";
import type { LayoutBounds, PositionedNode } from "./primitives";

/**
 * Snap zones for a free tree, in layout units: how far past a node its root may sit (a little
 * beyond the branch gap), how far it may overlap, and slack across. Tight on purpose: a topic
 * carried past the body must not catch on it, only one brought up beside a node.
 */
const SNAP_GAP = 72;
const SNAP_OVERLAP = 8;
const SNAP_PAD = 12;
/** How far from the line a node's children share the root may sit to slot in among them. */
const SNAP_LINE = 24;

/** A slot beside `targetId`; `distance` orders competing slots (the gap plus the offset across). */
export interface SnapSlot { targetId: string; position: DropPosition; distance: number }

type Axis = "x" | "y";
/** A side of a node on which its children hang. */
type Side = "right" | "below" | "above";

function span(box: LayoutBounds, axis: Axis): { from: number; to: number; mid: number } {
  const from = axis === "x" ? box.x : box.y;
  const size = axis === "x" ? box.width : box.height;
  return { from, to: from + size, mid: from + size / 2 };
}

/** Where a leaf's first child would go: the root's near edge within the gap range, overlapping the node across. */
function beside(rect: LayoutBounds, node: PositionedNode, side: Side, widen: number): SnapSlot | null {
  const gap = side === "right" ? rect.x - (node.x + node.width)
    : side === "below" ? rect.y - (node.y + node.height)
      : node.y - (rect.y + rect.height);
  if (gap < -SNAP_OVERLAP * widen || gap > SNAP_GAP * widen) return null;
  const across: Axis = side === "right" ? "y" : "x";
  const own = span(rect, across);
  const other = span(node, across);
  const pad = SNAP_PAD * widen;
  if (own.to < other.from - pad || own.from > other.to + pad) return null;
  return { targetId: node.id, position: "inside", distance: Math.abs(gap) + Math.abs(own.mid - other.mid) };
}

/**
 * A slot among `kids`, which line up along `axis` (a column for "y", a row for "x"): the root must
 * sit on their shared line (`lineOf` reads the edge or centre they have in common) and reach along
 * them; the first child whose middle it has not passed gets it in front, else it goes last.
 */
function among(
  rect: LayoutBounds, kids: readonly PositionedNode[], axis: Axis, lineOf: (box: LayoutBounds) => number, widen: number,
): SnapSlot | null {
  const sorted = [...kids].sort((left, right) => span(left, axis).from - span(right, axis).from);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return null;
  const drift = Math.abs(lineOf(rect) - lineOf(first));
  if (drift > SNAP_LINE * widen) return null;
  const pad = SNAP_PAD * widen;
  const centre = span(rect, axis).mid;
  if (centre < span(first, axis).from - pad || centre > span(last, axis).to + pad) return null;
  const next = sorted.find(kid => centre < span(kid, axis).mid);
  const distance = drift + (next ? Math.abs(centre - span(next, axis).from) : Math.abs(centre - span(last, axis).to));
  return next ? { targetId: next.id, position: "before", distance } : { targetId: last.id, position: "after", distance };
}

function nearer(first: SnapSlot | null, second: SnapSlot | null): SnapSlot | null {
  if (!first || !second) return first ?? second;
  return second.distance < first.distance ? second : first;
}

/**
 * The slot the root of a dragged tree (`rect`) would take beside `node`, whose visible children are
 * `kids` and whose depth in its own tree is `depth`, or null when the root is not in the node's zone.
 * The zones follow each layout's geometry. With no children, the root joins as the last child when
 * it sits where the first child would go: right of the node in the map and in the timeline's forests,
 * below it in the hierarchy, above or below a timeline stage. With children, it slots in among them
 * by position along the line they share (a column, a row, or the timeline axis) when it lines up
 * with them across it. `widen` stretches every zone, so the slot already shown is kept a while.
 */
export function snapSlot(
  mode: LayoutMode, rect: LayoutBounds, node: PositionedNode, kids: readonly PositionedNode[], depth: number, widen = 1,
): SnapSlot | null {
  if (kids.length === 0) {
    if (mode === "hierarchy") return beside(rect, node, "below", widen);
    if (mode === "timeline" && depth === 1) return nearer(beside(rect, node, "above", widen), beside(rect, node, "below", widen));
    return beside(rect, node, "right", widen);
  }
  if (mode === "hierarchy") return among(rect, kids, "x", box => box.y, widen);
  if (mode === "timeline" && depth === 0) return among(rect, kids, "x", box => box.y + box.height / 2, widen);
  return among(rect, kids, "y", box => box.x, widen);
}
