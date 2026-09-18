import { Component } from "obsidian";
import type { EditCommand } from "../core/commands";
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
  /** Empty canvas double-clicked at this canvas-relative point: add a free topic there (§5 M7). */
  addTopic: (point: { x: number; y: number }) => void;
}

export class MapEvents extends Component {
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
      if (!target || target.closest("a, button, input, textarea, .mappy-floating, [data-drop-placeholder], .mappy-drag-ghost")) return;
      const id = target.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
      if (id) { this.actions.select(id); this.actions.edit(); return; }
      event.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      this.actions.addTopic({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    });
    this.registerDomEvent(this.canvas, "keydown", event => { this.keydown(event); });
    // Node moves use pointer events (NodeDrag); HTML5 drag and drop only brings files in.
    this.registerDomEvent(this.canvas, "dragstart", event => {
      if (this.element(event.targetNode)?.closest("[data-node-id]")) event.preventDefault();
    });
    this.registerDomEvent(this.canvas, "dragover", event => {
      const node = this.element(event.targetNode)?.closest<HTMLElement>("[data-node-id]");
      if (!node || !event.dataTransfer?.types.includes("Files")) { this.clearDrop(); return; }
      event.preventDefault();
      if (node.hasClass("is-drop-target")) return;
      this.clearDrop();
      node.addClass("is-drop-target");
    });
    this.registerDomEvent(this.canvas, "dragleave", event => {
      const entered = this.element(event.relatedTarget as Node | null);
      if (!entered || !this.canvas.contains(entered)) this.clearDrop();
    });
    this.registerDomEvent(this.canvas, "drop", event => {
      const id = this.element(event.targetNode)?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
      this.clearDrop();
      const file = event.dataTransfer?.files[0];
      if (!id || !file?.type.startsWith("image/")) return;
      event.preventDefault();
      this.actions.select(id);
      this.actions.attach(file);
    });
    this.registerDomEvent(this.canvas, "dragend", () => { this.clearDrop(); });
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

  private clearDrop(): void {
    this.canvas.querySelectorAll<HTMLElement>(".is-drop-target").forEach(element => { element.removeClass("is-drop-target"); });
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
