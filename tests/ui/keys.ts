/** A keydown that is not dispatched: what Obsidian's keymap hands a scope at the window, judged by its target. */
export function keyAt(target: EventTarget | null, value: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}
