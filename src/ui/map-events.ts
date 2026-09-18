import { Component } from "obsidian";
import type { DropPosition, EditCommand, MoveCommand } from "../core/commands";
import type { MindNode } from "../core/markdown";

export interface MapActions {
  selected: () => MindNode | undefined;
  visible: () => MindNode[];
  select: (id: string, focus?: boolean) => void;
  fold: (id: string) => void;
  edit: () => void;
  command: (command: EditCommand) => void;
  history: (direction: "undo" | "redo") => void;
  attach: (file: File) => void;
  link: (link: string, newLeaf: boolean) => void;
  /** The move a drop would perform, or null when the target must refuse the dragged node. */
  dropTarget: (draggedId: string, targetId: string, position: DropPosition) => MoveCommand | null;
}

/** Share of the node's extent on each edge that means "sibling before/after"; the rest means "last child". */
const EDGE_ZONE = 0.3;

export class MapEvents extends Component {
  private dragged: string | null = null;
  private drop: { element: HTMLElement; position: DropPosition } | null = null;
  private composing = false;

  constructor(private readonly canvas: HTMLElement, private readonly actions: MapActions) { super(); }

  onload(): void {
    this.registerDomEvent(this.canvas, "compositionstart", () => { this.composing = true; });
    this.registerDomEvent(this.canvas, "compositionend", () => { this.composing = false; });
    this.registerDomEvent(this.canvas, "click", event => {
      const target = this.element(event.targetNode);
      if (!target) return;
      const anchor = target.closest<HTMLAnchorElement>("a.internal-link");
      if (anchor) {
        event.preventDefault();
        event.stopPropagation();
        this.actions.link(anchor.dataset.href ?? anchor.getAttribute("href") ?? "", event.metaKey || event.ctrlKey);
        return;
      }
      if (target.closest("a")) return;
      const id = target.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
      if (!id) return;
      this.actions.select(id, true);
      if (target.closest(".mappy-node-toggle")) this.actions.fold(id);
    });
    this.registerDomEvent(this.canvas, "dblclick", event => {
      const target = this.element(event.targetNode);
      if (target?.closest("a,button")) return;
      const id = target?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
      if (id) { this.actions.select(id); this.actions.edit(); }
    });
    this.registerDomEvent(this.canvas, "keydown", event => { this.keydown(event); });
    this.registerDomEvent(this.canvas, "dragstart", event => {
      const target = this.element(event.targetNode);
      if (target?.closest("a,img")) { event.preventDefault(); return; }
      const id = target?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
      if (!id || !event.dataTransfer) return;
      this.dragged = id;
      this.actions.select(id);
      event.dataTransfer.setData("application/x-mappy-node", id);
      event.dataTransfer.effectAllowed = "move";
    });
    this.registerDomEvent(this.canvas, "dragover", event => {
      const node = this.element(event.targetNode)?.closest<HTMLElement>("[data-node-id]");
      const id = node?.dataset.nodeId;
      if (!node || !id) { this.clearDrop(); return; }
      if (!this.dragged) {
        // Image files attach to the hovered node; anything else is not ours.
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        this.showDrop(node, "inside");
        return;
      }
      const position = this.dropPosition(node, event);
      if (!this.actions.dropTarget(this.dragged, id, position)) {
        this.clearDrop();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      this.showDrop(node, position);
    });
    this.registerDomEvent(this.canvas, "dragleave", event => {
      const entered = this.element(event.relatedTarget as Node | null);
      if (!entered || !this.canvas.contains(entered)) this.clearDrop();
    });
    this.registerDomEvent(this.canvas, "drop", event => {
      const node = this.element(event.targetNode)?.closest<HTMLElement>("[data-node-id]");
      const id = node?.dataset.nodeId;
      const previewed = this.drop;
      this.clearDrop();
      if (!node || !id) return;
      const file = event.dataTransfer?.files[0];
      if (file?.type.startsWith("image/")) {
        event.preventDefault();
        this.actions.select(id);
        this.actions.attach(file);
      } else if (this.dragged) {
        event.preventDefault();
        const from = this.dragged;
        this.dragged = null;
        // Perform exactly what the preview promised for this node.
        const position = previewed?.element === node ? previewed.position : this.dropPosition(node, event);
        const command = this.actions.dropTarget(from, id, position);
        if (command) this.actions.command(command);
      }
    });
    this.registerDomEvent(this.canvas, "dragend", () => { this.dragged = null; this.clearDrop(); });
    this.registerDomEvent(this.canvas, "paste", event => {
      if (event.defaultPrevented) return;
      const image = Array.from(event.clipboardData?.files ?? []).find(file => file.type.startsWith("image/"));
      if (!image) return;
      event.preventDefault();
      this.actions.attach(image);
    });
  }

  private element(target: Node | null): Element | null {
    return target?.instanceOf(Element) ? target : null;
  }

  /** Edge zones select a sibling slot; timeline stages line up horizontally, so their edges are left and right. */
  private dropPosition(node: HTMLElement, event: MouseEvent): DropPosition {
    if (node.hasClass("is-root")) return "inside";
    const rect = node.getBoundingClientRect();
    const ratio = node.hasClass("is-timeline") && node.hasClass("is-stage")
      ? (event.clientX - rect.left) / rect.width
      : (event.clientY - rect.top) / rect.height;
    if (!Number.isFinite(ratio)) return "inside";
    return ratio < EDGE_ZONE ? "before" : ratio > 1 - EDGE_ZONE ? "after" : "inside";
  }

  private showDrop(element: HTMLElement, position: DropPosition): void {
    if (this.drop?.element === element && this.drop.position === position) return;
    this.clearDrop();
    element.addClass("is-drop-target");
    element.dataset.drop = position;
    this.drop = { element, position };
  }

  private clearDrop(): void {
    this.drop = null;
    this.canvas.querySelectorAll<HTMLElement>(".is-drop-target").forEach(element => {
      element.removeClass("is-drop-target");
      delete element.dataset.drop;
    });
  }

  private keydown(event: KeyboardEvent): void {
    if (event.isComposing || this.composing || event.key === "Process"
      || this.element(event.targetNode)?.closest("input,textarea,button,a,select,[contenteditable]:not([contenteditable='false'])")) return;
    const node = this.actions.selected();
    if (!node) return;
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.stopPropagation();
      this.actions.history(event.shiftKey ? "redo" : "undo");
      return;
    }
    if (modifier || event.altKey) {
      if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        event.stopPropagation();
        this.actions.command({ type: event.key === "ArrowUp" ? "move-up" : "move-down", nodeId: node.id });
      }
      return;
    }
    const commands = { Enter: "add-sibling", Tab: "add-child", Delete: "delete", Backspace: "delete" } as const;
    if (event.key in commands) {
      event.preventDefault();
      event.stopPropagation();
      const type = commands[event.key as keyof typeof commands];
      this.actions.command({ type, nodeId: node.id });
    } else if (event.key === "F2") { event.preventDefault(); this.actions.edit(); }
    else if (event.key === " ") { event.preventDefault(); this.actions.fold(node.id); }
    else if (event.key.startsWith("Arrow")) {
      event.preventDefault();
      const visible = this.actions.visible();
      const index = visible.findIndex(item => item.id === node.id);
      let next: string | undefined;
      if (event.key === "ArrowUp") next = visible[Math.max(0, index - 1)]?.id;
      if (event.key === "ArrowDown") next = visible[Math.min(visible.length - 1, index + 1)]?.id;
      if (event.key === "ArrowLeft") next = node.parentId ?? undefined;
      if (event.key === "ArrowRight") next = node.children[0]?.id;
      if (next && visible.some(item => item.id === next)) this.actions.select(next, true);
    }
  }
}
