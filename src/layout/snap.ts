import type { DropPosition } from "../core/commands";
import type { LayoutMode } from "../core/layout-mode";
import { TIMELINE_STEM_GAP, balancedSide } from "./layout";
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

/**
 * Where a node hangs in the layouts whose zones depend on it. Timeline: the root, a stage whose
 * forest goes above or below the axis (`placeTimeline` alternates by stage index), or a node
 * inside a forest. Balanced map: the root, or a node on its right or left side (`balancedSide`
 * deals the first level; deeper nodes keep their branch's side). The other layouts ignore it.
 */
export type NodePlace = "root" | "upper" | "lower" | "forest" | "right" | "left";

type Axis = "x" | "y";
/** A side of a node on which its children hang. */
type Side = "right" | "left" | "below" | "above";

function span(box: LayoutBounds, axis: Axis): { from: number; to: number; mid: number } {
  const from = axis === "x" ? box.x : box.y;
  const size = axis === "x" ? box.width : box.height;
  return { from, to: from + size, mid: from + size / 2 };
}

/**
 * Where a leaf's first child would go: the root's near edge within the gap range, overlapping the node
 * across. Competing slots rank by how far the root sits from the child's landing place across the gap:
 * centred on the node unless `landing` says where the layout hangs the child's near edge instead.
 */
function beside(rect: LayoutBounds, node: PositionedNode, side: Side, widen: number, landing?: (node: PositionedNode) => number): SnapSlot | null {
  const gap = side === "right" ? rect.x - (node.x + node.width)
    : side === "left" ? node.x - (rect.x + rect.width)
      : side === "below" ? rect.y - (node.y + node.height)
        : node.y - (rect.y + rect.height);
  if (gap < -SNAP_OVERLAP * widen || gap > SNAP_GAP * widen) return null;
  const across: Axis = side === "right" || side === "left" ? "y" : "x";
  const own = span(rect, across);
  const other = span(node, across);
  const pad = SNAP_PAD * widen;
  if (own.to < other.from - pad || own.from > other.to + pad) return null;
  const offset = landing ? own.from - landing(node) : own.mid - other.mid;
  return { targetId: node.id, position: "inside", distance: Math.abs(gap) + Math.abs(offset) };
}

/**
 * A slot among `kids`, which line up along `axis` (a column for "y", a row for "x"): the root must
 * sit on their shared line (`lineOf` reads the edge or centre they have in common) and reach along
 * them; the first child whose middle it has not passed gets it in front, else it goes last.
 */
function among(
  rect: LayoutBounds, kids: readonly PositionedNode[], axis: Axis, lineOf: (box: LayoutBounds) => number, widen: number,
): SnapSlot | null {
  const any = kids[0];
  if (!any) return null;
  // Every child shares the line, so the cheap test comes before sorting a wide row.
  const drift = Math.abs(lineOf(rect) - lineOf(any));
  if (drift > SNAP_LINE * widen) return null;
  const sorted = [...kids].sort((left, right) => span(left, axis).from - span(right, axis).from);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return null;
  const pad = SNAP_PAD * widen;
  const centre = span(rect, axis).mid;
  if (centre < span(first, axis).from - pad || centre > span(last, axis).to + pad) return null;
  const next = sorted.find(kid => centre < span(kid, axis).mid);
  const distance = drift + (next ? Math.abs(centre - span(next, axis).from) : Math.abs(centre - span(last, axis).to));
  return next ? { targetId: next.id, position: "before", distance } : { targetId: last.id, position: "after", distance };
}

/** A stage's forest starts a stem's length right of its centre; the root's left edge is measured against that column. */
function stageLanding(stage: PositionedNode): number {
  return stage.x + stage.width / 2 + TIMELINE_STEM_GAP;
}

/** A column of children growing right shares its left edge; one growing left, its right edge (the mirror image). */
function columnLine(side: "right" | "left"): (box: LayoutBounds) => number {
  return side === "right" ? box => box.x : box => box.x + box.width;
}

/**
 * The side of a balanced tree's root a node was placed on, read from where it sits: a right branch
 * starts a whole gap past the root's right edge, so its centre is right of the root's centre, and the
 * mirror holds on the left. Shared with the view, which assigns every node's `NodePlace` from it.
 */
export function balancedSideOf(root: LayoutBounds, node: LayoutBounds): "right" | "left" {
  return node.x + node.width / 2 < root.x + root.width / 2 ? "left" : "right";
}

/**
 * The slot the root of a dragged tree would take among the balanced root's children, which form a
 * column on each side. Each column is judged on its own line, and the slot resolves to the source
 * index that keeps the topic on that side: before a kid it takes the kid's index (the kid and its
 * followers change sides, as the dealing rule fixes); after the column's last kid it joins as the last
 * child of all, which is only possible when the next index would be dealt to that side; an empty
 * column takes it beside the root on that side under the same condition.
 */
function amongBalancedRoot(rect: LayoutBounds, root: PositionedNode, kids: readonly PositionedNode[], widen: number): SnapSlot | null {
  const next = balancedSide(kids.length);
  const columns = { right: kids.filter(kid => balancedSideOf(root, kid) === "right"), left: kids.filter(kid => balancedSideOf(root, kid) === "left") };
  const slots: SnapSlot[] = [];
  for (const side of ["right", "left"] as const) {
    const column = columns[side];
    if (column.length === 0) {
      const slot = next === side ? beside(rect, root, side, widen) : null;
      if (slot) slots.push(slot);
      continue;
    }
    const slot = among(rect, column, "y", columnLine(side), widen);
    if (!slot) continue;
    if (slot.position === "before") { slots.push(slot); continue; }
    if (next !== side) continue;
    // The last child of all sits at the bottom of the other column (the last index was dealt there).
    const other = [...columns[side === "right" ? "left" : "right"]].sort((first, second) => first.y - second.y);
    const last = other[other.length - 1];
    if (last) slots.push({ targetId: last.id, position: "after", distance: slot.distance });
  }
  return slots.sort((first, second) => first.distance - second.distance)[0] ?? null;
}

/**
 * The slot the root of a dragged tree (`rect`) would take beside `node`, whose visible children are
 * `kids`, or null when the root is not in the node's zone. The zones follow each layout's geometry.
 * With no children, the root joins as the last child when it sits where the first child would go:
 * right of the node in the map and in the timeline's forests, below it in the hierarchy, on the
 * side of the axis a timeline stage's forest takes, and on a balanced node's own side (`place`).
 * With children, it slots in among them by position along the line they share (a column, a row,
 * or the timeline axis) when it lines up with them across it; the balanced root's children form
 * a column on each side (`amongBalancedRoot`). `widen` stretches every zone, so the slot already
 * shown is kept a while.
 */
export function snapSlot(
  mode: LayoutMode, rect: LayoutBounds, node: PositionedNode, kids: readonly PositionedNode[], widen = 1, place: NodePlace = "forest",
): SnapSlot | null {
  if (kids.length === 0) {
    if (mode === "hierarchy") return beside(rect, node, "below", widen);
    if (mode === "timeline" && (place === "upper" || place === "lower")) return beside(rect, node, place === "upper" ? "above" : "below", widen, stageLanding);
    if (mode === "balanced" && place === "left") return beside(rect, node, "left", widen);
    return beside(rect, node, "right", widen);
  }
  if (mode === "hierarchy") return among(rect, kids, "x", box => box.y, widen);
  if (mode === "timeline" && place === "root") return among(rect, kids, "x", box => box.y + box.height / 2, widen);
  if (mode === "balanced" && place === "root") return amongBalancedRoot(rect, node, kids, widen);
  return among(rect, kids, "y", columnLine(mode === "balanced" && place === "left" ? "left" : "right"), widen);
}
