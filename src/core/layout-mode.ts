/**
 * The layouts a note can ask for. This list is the vocabulary shared by the
 * frontmatter value (`mappy-layout`), the view state, the layout buttons, the
 * `mappy-topics` keys and the layout engine; it lives in core so the persistence
 * layer can validate a string without loading the layout engine.
 *
 * mindmap: root on the left, branches to the right. timeline: first level on a
 * horizontal axis, deeper levels alternating above and below. hierarchy: root on
 * top, every depth on one row, branches downward.
 */
export const LAYOUT_MODES = ["mindmap", "timeline", "hierarchy"] as const;
export type LayoutMode = (typeof LAYOUT_MODES)[number];

export function isLayoutMode(value: unknown): value is LayoutMode {
  return typeof value === "string" && (LAYOUT_MODES as readonly string[]).includes(value);
}

/** A frontmatter or view-state value as a layout: unknown values, casing and padding fall back to the regular map. */
export function layoutFromValue(value: unknown): LayoutMode {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : value;
  return isLayoutMode(normalized) ? normalized : "mindmap";
}
