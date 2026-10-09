/**
 * The map's history keys, read the same on the canvas and in a draft: ⌘Z／Ctrl+Z undoes, with Shift it redoes. With
 * Alt it is neither (⌘⌥Z is another shortcut; review 2 of LEV-331).
 */
export function historyKey(event: KeyboardEvent): "undo" | "redo" | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "z") return null;
  return event.shiftKey ? "redo" : "undo";
}
