import { Component, type App, type HoverParent, type HoverPopover } from "obsidian";
import { linkAt } from "./map-events";

/**
 * The id the map registers with the Page preview core plugin (`registerHoverLinkSource`, src/main.ts), whose settings
 * name it and keep its "requires ⌘／Ctrl" switch. Every map shares it: a tab, the tabs side by side, a read-only
 * embed and the called branches in them.
 */
export const HOVER_SOURCE = "mappy";

/** A popover as Obsidian has it at runtime: `hide` is not in the typings (1.8.7). */
type ClosablePopover = HoverPopover & { hide?: () => void };

export interface LinkPreviewOptions {
  /**
   * Keep a link's mouseover from the elements around the map: a reading view holding a read-only map (§5 M10)
   * previews every `a.internal-link` inside it from its own source and from the host note. Only the embed sets it;
   * in a map tab nothing around the canvas previews links, and other listeners may want to hear them.
   */
  isolate?: boolean;
  /** Whether a node's text is being written (the view's inline editor); an embed never writes. */
  editing?: () => boolean;
}

/**
 * Keys that only modify another: ⌘／Ctrl among them asks Page preview to show the link already hovered, so none of
 * them closes a popover (`KeyboardEvent.key` values of the UI Events spec).
 */
const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "AltGraph", "CapsLock", "Fn", "FnLock", "Hyper", "Super", "Symbol", "SymbolLock", "OS", "NumLock", "ScrollLock"]);

/**
 * Asks Obsidian's Page preview for the internal link under the pointer (`hover-link`), as a note's reading view
 * does; whether ⌘／Ctrl is needed is Page preview's setting for this source. `sourcePath` names the note a node's
 * links are resolved from (the map's own, or the called note's for a called branch; null when there is none), the
 * same note a click opens the link from (`linkAt`). No preview is asked for while a node's text is being written;
 * a press, a wheel or a key (other than a modifier) closes the one showing and the one still waiting for Page
 * preview's delay. This component is the popover's parent, so it goes with the map (a closed tab, the plugin disabled).
 *
 * Closing uses the popover's `hide`, which Obsidian has at runtime but not in its typings: `unload`, the public way
 * to end a Component, leaves the popover's element on screen and its show timer running (1.14.3's app.js), so there
 * is no public way to close one. Without `hide` a popover is left to Page preview (it closes when the pointer leaves).
 */
export class LinkPreview extends Component implements HoverParent {
  private shown: HoverPopover | null = null;
  /**
   * Whether the last link asked for may still show: set when `hover-link` is sent, cleared by a press, a wheel or a
   * key. Page preview shows a popover after its delay (300 ms in 1.14.3) and only then hands it to `hoverPopover`;
   * one that arrives cleared is closed at once. No button state is kept: a drag or a pan cannot send a new
   * `hover-link` (the canvas captures the pointer, so links hear no mouseover), and the next hover sets it again.
   */
  private live = false;

  constructor(
    private readonly app: App,
    private readonly canvas: HTMLElement,
    private readonly sourcePath: (nodeId: string | null) => string | null,
    private readonly options: LinkPreviewOptions = {},
  ) { super(); }

  get hoverPopover(): HoverPopover | null { return this.shown; }
  set hoverPopover(popover: HoverPopover | null) {
    this.shown = popover;
    if (!popover || (this.live && !this.editing())) return;
    // Page preview sets this from inside its `show`, which goes on to list and load the popover: closed at once, it
    // would be put back as a hidden popover that stays loaded. Closed once `show` has returned.
    queueMicrotask(() => { if (this.shown === popover) this.hide(); });
  }

  onload(): void {
    this.registerDomEvent(this.canvas, "mouseover", event => { this.over(event); });
    this.registerDomEvent(this.canvas, "pointerdown", () => { this.cancel(); }, true);
    this.registerDomEvent(this.canvas, "wheel", () => { this.cancel(); }, { capture: true, passive: true });
    this.registerDomEvent(this.canvas, "keydown", event => {
      if (!MODIFIER_KEYS.has(event.key)) { this.cancel(); return; }
      // ⌘／Ctrl pressed over a link hovered without it: Page preview makes the popover now, and it is wanted, even
      // after a key or a wheel since the hover (the pointer did not move, so no new `hover-link` came).
      if (event.key === "Meta" || event.key === "Control") this.live = true;
    }, true);
  }

  onunload(): void { this.cancel(); }

  /**
   * Closes the popover showing and the one waiting. For what the canvas never hears: a key Obsidian's keymap consumes
   * before it (the view's scope takes F2, which opens the inline editor), so the view calls this as the editor opens.
   */
  close(): void { this.cancel(); }

  private editing(): boolean {
    return this.options.editing?.() ?? false;
  }

  private over(event: MouseEvent): void {
    const found = linkAt(this.canvas, event.targetNode);
    if (!found) return;
    // Whatever happens below, the reading view around an embed does not preview this link a second time.
    if (this.options.isolate) event.stopPropagation();
    // Moving between the parts of one link is not a new hover.
    const from = event.relatedTarget as Node | null;
    if (from && found.anchor.contains(from)) return;
    // A node's text being written is not to be covered. A drag or a pan never reaches here (the canvas captures the
    // pointer); a held button is a text selection dragged across the map, say.
    if (event.buttons !== 0 || this.editing()) return;
    const sourcePath = this.sourcePath(found.nodeId);
    if (!found.link || sourcePath === null) return;
    this.live = true;
    this.app.workspace.trigger("hover-link", {
      event, source: HOVER_SOURCE, hoverParent: this, targetEl: found.anchor, linktext: found.link, sourcePath,
    });
  }

  private cancel(): void {
    this.live = false;
    this.hide();
  }

  private hide(): void {
    const popover: ClosablePopover | null = this.shown;
    this.shown = null;
    if (typeof popover?.hide === "function") popover.hide();
  }
}
