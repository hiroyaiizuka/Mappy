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
  /** An internal link clicked in a node's text; `nodeId` names that node, so the link is resolved from the note it is written in. */
  link: (link: string, newLeaf: boolean, nodeId: string | null) => void;
  /** Empty canvas double-clicked at this canvas-relative point: add a free topic there (§5 M7). */
  addTopic: (point: { x: number; y: number }) => void;
  /**
   * A node double-clicked that is drawn from a called map (§5 M12): open the note it comes from
   * (in a new leaf with ⌘／Ctrl) instead of editing; true when it was such a node.
   */
  open: (id: string, newLeaf: boolean) => boolean;
}

/** What a click on a map means: an internal link to follow (and the node it sits in), or a node (and whether its fold control was hit). */
export type MapClick = { link: string; newLeaf: boolean; nodeId: string | null } | { nodeId: string; toggle: boolean };

/** Pointer travel since a press that still counts as a click: less, and a press on a node is not yet a drag (NodeDrag), one on the empty canvas not yet a pan (MapViewport). */
export const PRESS_TRAVEL = 4;

/** The node of this canvas that holds `target`; nodes are never nested (a title's `![[…]]` is a link). */
export function nodeOf(canvas: Element, target: Node | null): HTMLElement | null {
  const node = target?.instanceOf(Element) ? target.closest<HTMLElement>("[data-node-id]") : null;
  return node && canvas.contains(node) ? node : null;
}

/** Shared by the map view and the read-only embed, so links and fold controls answer the same way in both. */
export function mapClick(event: MouseEvent, canvas: Element): MapClick | null {
  const target = event.targetNode;
  if (!target?.instanceOf(Element)) return null;
  const anchor = target.closest<HTMLAnchorElement>("a.internal-link");
  if (anchor) {
    return { link: anchor.dataset.href ?? anchor.getAttribute("href") ?? "", newLeaf: event.metaKey || event.ctrlKey, nodeId: nodeOf(canvas, anchor)?.dataset.nodeId ?? null };
  }
  if (target.closest("a")) return null;
  const node = nodeOf(canvas, target);
  const nodeId = node?.dataset.nodeId;
  if (!node || !nodeId) return null;
  return { nodeId, toggle: Boolean(target.closest(".mappy-node-toggle")) };
}

export class MapEvents extends Component {
  private composing = false;

  constructor(private readonly canvas: HTMLElement, private readonly actions: MapActions) { super(); }

  onload(): void {
    this.registerDomEvent(this.canvas, "compositionstart", () => { this.composing = true; });
    this.registerDomEvent(this.canvas, "compositionend", () => { this.composing = false; });
    // A click on the empty canvas is MapViewport's to judge (a pan ends with one too); it clears the selection there.
    this.registerDomEvent(this.canvas, "click", event => {
      const click = mapClick(event, this.canvas);
      if (!click) return;
      if ("link" in click) {
        event.preventDefault();
        event.stopPropagation();
        this.actions.link(click.link, click.newLeaf, click.nodeId);
        return;
      }
      this.actions.select(click.nodeId, true);
      if (click.toggle) this.actions.fold(click.nodeId);
    });
    this.registerDomEvent(this.canvas, "dblclick", event => {
      const target = this.element(event.targetNode);
      if (!target || target.closest("a, button, input, textarea, .mappy-floating, [data-drop-placeholder], .mappy-drag-ghost")) return;
      const id = nodeOf(this.canvas, target)?.dataset.nodeId;
      if (id) {
        this.actions.select(id);
        if (this.actions.open(id, event.metaKey || event.ctrlKey)) event.preventDefault();
        else this.actions.edit();
        return;
      }
      event.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      this.actions.addTopic({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    });
    this.registerDomEvent(this.canvas, "keydown", event => { this.keydown(event); });
    // Node moves use pointer events (NodeDrag); HTML5 drag and drop only brings files in.
    this.registerDomEvent(this.canvas, "dragstart", event => {
      if (nodeOf(this.canvas, event.targetNode)) event.preventDefault();
    });
    this.registerDomEvent(this.canvas, "dragover", event => {
      const node = nodeOf(this.canvas, event.targetNode);
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
      const id = nodeOf(this.canvas, event.targetNode)?.dataset.nodeId;
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
      // An image goes to the selected node; with nothing selected the paste is not the map's.
      if (!image || !this.actions.selected()) return;
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

  /**
   * For the view's `Scope` (see `MindmapView`): Obsidian's keymap consults the active view's scope at
   * the window's capture phase, before its own hotkeys and before this component's canvas listener. A
   * key pressed inside the canvas is handled here exactly as the canvas listener would, and `false`
   * (Obsidian's "consumed": preventDefault and stopPropagation) reports that the map acted. Keys pressed
   * outside the canvas or in the inline editor are not acted on (`undefined`), nor, with nothing selected,
   * any key but ⌘Z／⌘⇧Z and a plain arrow (which selects the first node); the view decides what that means for the key.
   */
  hotkey(event: KeyboardEvent): false | undefined {
    const target = event.targetNode;
    if (!target || !this.canvas.contains(target)) return undefined;
    return this.keydown(event) ? false : undefined;
  }

  /**
   * Acts on a key for the selected node; true when the map took it. A key something already consumed is
   * not taken twice, and the map's keys carry no modifier: ⌘Z／⌘⇧Z and ⌥↑／⌥↓ are the only chords, so
   * Shift+Tab keeps moving the focus and Shift+Enter adds nothing.
   */
  private keydown(event: KeyboardEvent): boolean {
    if (event.defaultPrevented || event.isComposing || this.composing || event.key === "Process"
      || this.element(event.targetNode)?.closest("input,textarea,button,a,select,[contenteditable]:not([contenteditable='false'])")) return false;
    const modifier = event.metaKey || event.ctrlKey;
    // The map's history is not bound to a node: it answers with nothing selected too.
    if (modifier && event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.stopPropagation();
      this.actions.history(event.shiftKey ? "redo" : "undo");
      return true;
    }
    const node = this.actions.selected();
    if (!node) {
      // Nothing selected (the empty canvas was clicked): a plain arrow starts again from the first node on the map; every other key is left alone.
      if (modifier || event.altKey || event.shiftKey || !event.key.startsWith("Arrow")) return false;
      const first = this.actions.visible()[0];
      if (!first) return false;
      event.preventDefault();
      this.actions.select(first.id, true);
      return true;
    }
    if (modifier || event.altKey) {
      if (event.altKey && !event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        event.stopPropagation();
        this.actions.command({ type: event.key === "ArrowUp" ? "move-up" : "move-down", nodeId: node.id });
        return true;
      }
      return false;
    }
    if (event.shiftKey) return false;
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
      // The tree on screen decides the neighbours: a calling item's children are the called map's (§5 M12).
      const shown = visible[index] ?? node;
      let next: string | undefined;
      if (event.key === "ArrowUp") next = visible[Math.max(0, index - 1)]?.id;
      if (event.key === "ArrowDown") next = visible[Math.min(visible.length - 1, index + 1)]?.id;
      if (event.key === "ArrowLeft") next = shown.parentId ?? undefined;
      if (event.key === "ArrowRight") next = shown.children[0]?.id;
      if (next && visible.some(item => item.id === next)) this.actions.select(next, true);
    } else return false;
    return true;
  }
}
