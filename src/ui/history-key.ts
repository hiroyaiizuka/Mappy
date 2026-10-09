/** The map's history keys, read the same on the canvas and in a draft: ⌘Z／Ctrl+Z undoes, with Shift it redoes. */
export function historyKey(event: KeyboardEvent): "undo" | "redo" | null {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return null;
  return event.shiftKey ? "redo" : "undo";
}
