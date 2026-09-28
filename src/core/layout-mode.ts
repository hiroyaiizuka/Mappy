import { t } from "../i18n";

/**
 * The layouts a note can ask for. This list is the vocabulary shared by the
 * frontmatter value (`mappy-layout`), the view state, the layout buttons, the
 * `mappy-topics` keys and the layout engine; it lives in core so the persistence
 * layer can validate a string without loading the layout engine.
 *
 * mindmap: root on the left, branches to the right. timeline: first level on a
 * horizontal axis, deeper levels alternating above and below. hierarchy: root on
 * top, every depth on one row, branches downward. balanced: root in the centre,
 * first level dealt right and left in turn, each branch growing on its side.
 */
export const LAYOUT_MODES = ["mindmap", "timeline", "hierarchy", "balanced"] as const;
export type LayoutMode = (typeof LAYOUT_MODES)[number];

export function isLayoutMode(value: unknown): value is LayoutMode {
  return typeof value === "string" && (LAYOUT_MODES as readonly string[]).includes(value);
}

/** The text key of each layout's name; the Record type turns a new mode into a compile error until it is named. */
const LAYOUT_LABEL_KEYS: Record<LayoutMode, "layoutMindmap" | "layoutTimeline" | "layoutHierarchy" | "layoutBalanced"> = {
  mindmap: "layoutMindmap", timeline: "layoutTimeline", hierarchy: "layoutHierarchy", balanced: "layoutBalanced",
};

/**
 * The one name each layout goes by in the UI: the layout buttons and the settings dropdown both read it. Read
 * when shown, as it follows the app's language, which is set after this module has loaded (src/i18n).
 */
export function layoutLabel(mode: LayoutMode): string {
  return t()[LAYOUT_LABEL_KEYS[mode]];
}

/** A frontmatter value naming a layout, tolerant of case and surrounding space; anything else is null. */
export function parseLayout(value: unknown): LayoutMode | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : value;
  return isLayoutMode(normalized) ? normalized : null;
}

/** A frontmatter or view-state value as a layout: unknown values, casing and padding fall back to the regular map. */
export function layoutFromValue(value: unknown): LayoutMode {
  return parseLayout(value) ?? "mindmap";
}

/** What `mappy-layout` holds for a layout: the regular map is the default, so only the other layouts are written down. */
export function layoutKeyValue(layout: LayoutMode): LayoutMode | undefined {
  return layout === "mindmap" ? undefined : layout;
}
