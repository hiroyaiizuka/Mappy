import { Component } from "obsidian";
import type { DropPosition, MoveCommand } from "../core/commands";

export interface NodeDragActions {
  select: (id: string) => void;
  /** The move a drop on `targetId` would perform, or null when the target must refuse the dragged node. */
  dropTarget: (draggedId: string, targetId: string, position: DropPosition) => MoveCommand | null;
  /** Show the slot a drop would fill (placeholder + connector), or clear it with null. */
  preview: (command: MoveCommand | null) => void;
  command: (command: MoveCommand) => void;
}

/** Pointer travel before a press on a node becomes a drag, so clicks and double-clicks stay untouched. */
const DRAG_THRESHOLD = 4;
/** Share of a node's extent on each edge that means "sibling before/after"; the middle means "last child". */
const EDGE_ZONE = 0.3;
/** After the preview changes, the layout shifts under a still pointer; a new node may take over only after this much travel. */
const SWITCH_DISTANCE = 8;

interface Press { pointerId: number; id: string; element: HTMLElement; x: number; y: number }

interface Session extends Press {
  ghost: HTMLElement;
  /** Pointer offset inside the node at grab time, in screen pixels. */
  grab: { x: number; y: number };
  scale: number;
  target: MoveCommand | null;
  anchor: { id: string; position: DropPosition } | null;
  switched: { x: number; y: number } | null;
}

/**
 * Pointer-driven node dragging: a translucent ghost follows the pointer, the source stays faint in
 * place, and the view previews the slot under the pointer. Pointer events (not HTML5 drag and drop)
 * so the ghost, the placeholder, and touch input are under our control; file drops stay separate.
 */
export class NodeDrag extends Component {
  private press: Press | null = null;
  private session: Session | null = null;

  constructor(private readonly canvas: HTMLElement, private readonly actions: NodeDragActions) { super(); }

  onload(): void {
    this.registerDomEvent(this.canvas, "pointerdown", event => {
      if (event.button !== 0 || this.session) return;
      const target = this.element(event.targetNode);
      if (!target || target.closest("a, img, button, input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
      const element = target.closest<HTMLElement>("[data-node-id]");
      const id = element?.dataset.nodeId;
      if (!element || !id) return;
      this.press = { pointerId: event.pointerId, id, element, x: event.clientX, y: event.clientY };
    });
    this.registerDomEvent(this.canvas, "pointermove", event => {
      if (this.session) { if (this.session.pointerId === event.pointerId) this.move(event); return; }
      const press = this.press;
      if (!press || press.pointerId !== event.pointerId) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_THRESHOLD) return;
      this.start(press, event);
    });
    this.registerDomEvent(this.canvas, "pointerup", event => {
      if (this.session?.pointerId === event.pointerId) this.finish(true);
      this.press = null;
    });
    const cancel = (event: PointerEvent): void => {
      if (this.session?.pointerId === event.pointerId) this.finish(false);
      this.press = null;
    };
    this.registerDomEvent(this.canvas, "pointercancel", cancel);
    this.registerDomEvent(this.canvas, "lostpointercapture", cancel);
    this.registerDomEvent(this.canvas, "keydown", event => {
      if (!this.session || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      this.finish(false);
    });
  }

  onunload(): void {
    this.finish(false);
    this.press = null;
  }

  private element(target: Node | null): Element | null {
    return target?.instanceOf(Element) ? target : null;
  }

  private start(press: Press, event: PointerEvent): void {
    this.press = null;
    const rect = press.element.getBoundingClientRect();
    const scale = press.element.offsetWidth > 0 ? rect.width / press.element.offsetWidth : 1;
    // A deep clone keeps the rendered label and attachments; standard DOM only, since it may live in a popout window.
    const ghost = press.element.cloneNode(true) as HTMLElement;
    ghost.querySelectorAll(".mappy-node-toggle").forEach(toggle => { toggle.remove(); });
    for (const name of ["data-node-id", "id", "tabindex", "role", "aria-selected", "aria-expanded", "aria-level"]) ghost.removeAttribute(name);
    ghost.classList.remove("is-selected", "is-drag-source");
    ghost.classList.add("mappy-drag-ghost");
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.width = `${press.element.offsetWidth}px`;
    ghost.style.height = `${press.element.offsetHeight}px`;
    this.canvas.append(ghost);
    press.element.addClass("is-drag-source");
    this.canvas.addClass("is-dragging-node");
    // A pointer that vanished between the press and this move cannot be captured; the drag still runs on canvas events.
    try { this.canvas.setPointerCapture(press.pointerId); } catch { /* InvalidPointerId */ }
    this.session = {
      ...press, ghost, scale, grab: { x: press.x - rect.left, y: press.y - rect.top }, target: null, anchor: null, switched: null,
    };
    this.actions.select(press.id);
    this.move(event);
  }

  private move(event: PointerEvent): void {
    const session = this.session;
    if (!session) return;
    const canvas = this.canvas.getBoundingClientRect();
    const x = event.clientX - canvas.left - session.grab.x;
    const y = event.clientY - canvas.top - session.grab.y;
    session.ghost.style.transform = `translate(${x}px, ${y}px) scale(${session.scale})`;
    if (event.clientX < canvas.left || event.clientX >= canvas.right || event.clientY < canvas.top || event.clientY >= canvas.bottom) {
      this.retarget(session, null, null, event);
      return;
    }
    const hit = this.canvas.doc.elementFromPoint(event.clientX, event.clientY);
    // Over the placeholder, the faint source, or empty canvas the current slot stays.
    if (!hit || !this.canvas.contains(hit) || hit.closest("[data-drop-placeholder]")) return;
    const node = hit.closest<HTMLElement>("[data-node-id]");
    const id = node?.dataset.nodeId;
    if (!node || !id || id === session.id) return;
    const position = this.dropPosition(node, event);
    if (session.anchor?.id === id && session.anchor.position === position) return;
    if (session.switched && Math.hypot(event.clientX - session.switched.x, event.clientY - session.switched.y) < SWITCH_DISTANCE) return;
    const command = this.actions.dropTarget(session.id, id, position);
    this.retarget(session, command, command ? { id, position } : null, event);
  }

  private retarget(session: Session, command: MoveCommand | null, anchor: Session["anchor"], event: PointerEvent): void {
    if (!command && !session.target) return;
    session.target = command;
    session.anchor = anchor;
    session.switched = { x: event.clientX, y: event.clientY };
    this.actions.preview(command);
  }

  /** Edge zones select a sibling slot; timeline stages line up horizontally, so their edges are left and right. */
  private dropPosition(node: HTMLElement, event: PointerEvent): DropPosition {
    if (node.hasClass("is-root")) return "inside";
    const rect = node.getBoundingClientRect();
    const ratio = node.hasClass("is-timeline") && node.hasClass("is-stage")
      ? (event.clientX - rect.left) / rect.width
      : (event.clientY - rect.top) / rect.height;
    if (!Number.isFinite(ratio)) return "inside";
    return ratio < EDGE_ZONE ? "before" : ratio > 1 - EDGE_ZONE ? "after" : "inside";
  }

  private finish(drop: boolean): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    session.ghost.remove();
    session.element.removeClass("is-drag-source");
    this.canvas.removeClass("is-dragging-node");
    if (this.canvas.hasPointerCapture(session.pointerId)) this.canvas.releasePointerCapture(session.pointerId);
    this.actions.preview(null);
    if (drop && session.target) this.actions.command(session.target);
  }
}
