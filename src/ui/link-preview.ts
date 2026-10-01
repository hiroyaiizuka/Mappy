import { Component, type App, type HoverParent, type HoverPopover } from "obsidian";
import { linkAt } from "./map-events";

/**
 * The id the map registers with the Page preview core plugin (`registerHoverLinkSource`, src/main.ts), whose settings
 * name it and keep its "requires ⌘／Ctrl" switch. Every map shares it: a tab, the tabs side by side, a read-only
 * embed and the called branches in them.
 */
export const HOVER_SOURCE = "mappy";

/** A popover as Obsidian has it at runtime: `hide` is not in the typings (1.8.7). */
type ClosablePopover = HoverPopover & { hide(): void };

/**
 * Asks Obsidian's Page preview for the internal link under the pointer (`hover-link`), as a note's reading view
 * does; whether ⌘／Ctrl is needed is Page preview's setting for this source. `sourcePath` names the note a node's
 * links are resolved from (the map's own, or the called note's for a called branch; null when there is none), the
 * same note a click opens the link from (`linkAt`). No preview is asked for while a node's text is being written,
 * and the one showing goes when a press, a wheel or a key starts something else on the map. This component is the
 * popover's parent, so it goes with the map (a closed tab, the plugin disabled).
 */
export class LinkPreview extends Component implements HoverParent {
  private shown: HoverPopover | null = null;
  /** A button held on the canvas: a press, a drag or a pan in progress. */
  private pressed = false;

  constructor(
    private readonly app: App,
    private readonly canvas: HTMLElement,
    private readonly sourcePath: (nodeId: string | null) => string | null,
  ) { super(); }

  /**
   * Page preview sets this when a popover it made shows, after its delay (300 ms in 1.14.3). A press or a draft that
   * began during the delay closes it at once: a drag that started on the link would otherwise have it appear mid-drag
   * (the canvas captures the pointer, so the link never hears the pointer leave).
   */
  get hoverPopover(): HoverPopover | null { return this.shown; }
  set hoverPopover(popover: HoverPopover | null) {
    this.shown = popover;
    if (popover && (this.pressed || this.editing())) this.hide();
  }

  onload(): void {
    this.registerDomEvent(this.canvas, "mouseover", event => { this.over(event); });
    this.registerDomEvent(this.canvas, "pointerdown", () => { this.pressed = true; this.hide(); }, true);
    const win = this.canvas.ownerDocument.defaultView;
    if (win) {
      // On the window: a drag or a pan ends wherever the pointer is let go (the canvas has it captured until then).
      this.registerDomEvent(win, "pointerup", () => { this.pressed = false; }, true);
      this.registerDomEvent(win, "pointercancel", () => { this.pressed = false; }, true);
    }
    this.registerDomEvent(this.canvas, "wheel", () => { this.hide(); }, { capture: true, passive: true });
    this.registerDomEvent(this.canvas, "keydown", event => {
      // ⌘／Ctrl alone is what asks Page preview to show the link already hovered; it must not close it.
      if (!["Meta", "Control", "Shift", "Alt"].includes(event.key)) this.hide();
    }, true);
  }

  onunload(): void { this.hide(); }

  private editing(): boolean {
    return this.canvas.querySelector(".mappy-node.is-editing") !== null;
  }

  private over(event: MouseEvent): void {
    const found = linkAt(event.targetNode, this.canvas);
    if (!found) return;
    // Moving between the parts of one link is not a new hover.
    const from = event.relatedTarget as Node | null;
    if (from && found.anchor.contains(from)) return;
    // A node's text being written is not to be covered. A drag or a pan never reaches here: the canvas captures the
    // pointer, so its mouseovers target the canvas; the held button is checked for a press that captured nothing.
    if (event.buttons !== 0 || this.editing()) return;
    const sourcePath = this.sourcePath(found.nodeId);
    if (!found.link || sourcePath === null) return;
    this.app.workspace.trigger("hover-link", {
      event, source: HOVER_SOURCE, hoverParent: this, targetEl: found.anchor, linktext: found.link, sourcePath,
    });
    // A reading view holding a read-only map (§5 M10) would ask again for the same link from its own source.
    event.stopPropagation();
  }

  private hide(): void {
    const popover = this.shown as ClosablePopover | null;
    this.shown = null;
    // `hide` detaches `hoverEl`, stops the show timer and unloads it; `unload` alone leaves the element on screen
    // (1.14.3's app.js), so there is no public way to close one.
    popover?.hide();
  }
}
