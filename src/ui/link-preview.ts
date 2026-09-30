import { Component, type App, type HoverParent, type HoverPopover } from "obsidian";
import { nodeOf } from "./map-events";

/**
 * The id the map registers with the Page preview core plugin (`registerHoverLinkSource`, src/main.ts), whose settings
 * name it and keep its "requires ⌘／Ctrl" switch. Every map shares it: a tab, the tabs side by side, a read-only
 * embed and the called branches in them.
 */
export const HOVER_SOURCE = "mappy";

/**
 * Asks Obsidian's Page preview for the internal link under the pointer (`hover-link`), as a note's reading view
 * does; whether ⌘／Ctrl is needed is Page preview's setting for this source. `sourcePath` names the note a node's
 * links are resolved from (the map's own, or the called note's for a called branch; null when there is none).
 * No preview is asked for while a button is held (a drag, a pan) or while a node's text is being written, and the
 * one showing goes when a press, a wheel or a key starts something else on the map. This component is the popover's
 * parent, so it goes with the map (a closed tab, the plugin disabled).
 */
export class LinkPreview extends Component implements HoverParent {
  hoverPopover: HoverPopover | null = null;

  constructor(
    private readonly app: App,
    private readonly canvas: HTMLElement,
    private readonly sourcePath: (nodeId: string | null) => string | null,
  ) { super(); }

  onload(): void {
    this.registerDomEvent(this.canvas, "mouseover", event => { this.over(event); });
    this.registerDomEvent(this.canvas, "pointerdown", () => { this.hide(); }, true);
    this.registerDomEvent(this.canvas, "wheel", () => { this.hide(); }, { capture: true, passive: true });
    this.registerDomEvent(this.canvas, "keydown", event => {
      // ⌘／Ctrl alone is what asks Page preview to show the link already hovered; it must not close it.
      if (!["Meta", "Control", "Shift", "Alt"].includes(event.key)) this.hide();
    }, true);
  }

  onunload(): void { this.hide(); }

  private over(event: MouseEvent): void {
    const target = event.targetNode;
    if (!target?.instanceOf(Element)) return;
    const anchor = target.closest<HTMLElement>("a.internal-link");
    if (!anchor || !this.canvas.contains(anchor)) return;
    // Moving between the parts of one link is not a new hover.
    const from = event.relatedTarget as Node | null;
    if (from && anchor.contains(from)) return;
    // A drag or a pan passes over links with a button held; a node's text being written is not to be covered.
    if (event.buttons !== 0 || this.canvas.querySelector(".mappy-node.is-editing")) return;
    const linktext = anchor.dataset.href ?? anchor.getAttribute("href") ?? "";
    const sourcePath = this.sourcePath(nodeOf(this.canvas, anchor)?.dataset.nodeId ?? null);
    if (!linktext || sourcePath === null) return;
    this.app.workspace.trigger("hover-link", { event, source: HOVER_SOURCE, hoverParent: this, targetEl: anchor, linktext, sourcePath });
    // A reading view holding a read-only map (§5 M10) would ask again for the same link from its own source.
    event.stopPropagation();
  }

  private hide(): void {
    const popover = this.hoverPopover;
    this.hoverPopover = null;
    // `unload` is the public way to close it (a popover is a Component); `hide` is not in the API.
    popover?.unload();
  }
}
