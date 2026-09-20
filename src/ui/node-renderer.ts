import { Component, MarkdownRenderer, setIcon, type App } from "obsidian";
import type { MindDocument, MindNode } from "../core/markdown";
import { nodeBody } from "../core/body";
import { attachmentMarkdown, transclusionsAsLinks } from "../core/attachments";
import type { CallSource } from "../core/calls";
import { foldBadgeWidth, foldControlSize, type FoldPosition, type LayoutMode, type PositionedNode } from "../layout/layout";

interface NodeEntry {
  element: HTMLDivElement;
  content: HTMLDivElement;
  toggle: HTMLButtonElement;
  toggleMark: HTMLSpanElement;
  component: Component;
  key: string;
}

interface NodeAppearance {
  visualRootId: string;
  /** Free topics are roots of their own trees: dark face, framed first level. */
  topicIds?: ReadonlySet<string>;
  mode: LayoutMode;
  /**
   * Nodes drawn from a called map (§5 M12), by id: their text, body and links are read from the
   * called note (`source.document`, `source.node`, `source.path`), not from `document`.
   */
  sources?: ReadonlyMap<string, CallSource>;
  /** The trees on the map (the body root and the free topics), for the fold counts; `document.root` when absent. */
  trees?: readonly MindNode[];
}

/** Each Markdown render owns a disposable child component. */
export class NodeRenderer extends Component {
  readonly entries = new Map<string, NodeEntry>();
  private selectedId: string | null = null;

  constructor(
    private readonly app: App,
    private readonly layer: HTMLElement,
    private readonly changed: () => void,
  ) { super(); }

  update(
    nodes: MindNode[],
    document: MindDocument,
    sourcePath: string,
    collapsed: ReadonlySet<string>,
    appearance: NodeAppearance,
  ): void {
    const descendantCounts = countDescendants(appearance.trees ?? [document.root]);
    const retained = new Set(nodes.map(node => node.id));
    for (const [id, entry] of this.entries) {
      if (retained.has(id) || entry.element.hasClass("is-editing")) continue;
      this.removeChild(entry.component);
      entry.element.remove();
      this.entries.delete(id);
    }
    for (const node of nodes) {
      let entry = this.entries.get(node.id);
      if (!entry) {
        const element = this.layer.createDiv({ cls: "mappy-node", attr: {
          "data-node-id": node.id, role: "treeitem", tabindex: "-1", "aria-selected": "false",
        } });
        const content = element.createDiv({ cls: "mappy-node-content" });
        const toggle = element.createEl("button", { cls: "mappy-node-toggle", attr: { tabindex: "0", type: "button" } });
        const toggleMark = toggle.createSpan({ cls: "mappy-node-toggle-mark", attr: { "aria-hidden": "true" } });
        entry = { element, content, toggle, toggleMark, component: this.addChild(new Component()), key: "" };
        this.entries.set(node.id, entry);
      }
      const isCollapsed = collapsed.has(node.id) && node.children.length > 0;
      const isTopic = appearance.topicIds?.has(node.id) ?? false;
      const isRoot = isTopic || node.id === appearance.visualRootId;
      const parentIsRoot = node.parentId === appearance.visualRootId || (node.parentId !== null && (appearance.topicIds?.has(node.parentId) ?? false));
      // A node of a called map (§5 M12) reads its text and body from the called note; the calling item stands in for that map's root.
      const source = appearance.sources?.get(node.id);
      const path = source?.path ?? sourcePath;
      entry.element.toggleClass("is-root", isRoot);
      entry.element.toggleClass("is-topic", isTopic);
      entry.element.toggleClass("is-stage", !isRoot && parentIsRoot);
      entry.element.toggleClass("is-parent", node.children.length > 0);
      entry.element.toggleClass("is-called", source !== undefined);
      entry.element.toggleClass("is-called-root", source?.root ?? false);
      entry.element.toggleClass("is-timeline", appearance.mode === "timeline");
      entry.element.toggleClass("is-hierarchy", appearance.mode === "hierarchy");
      entry.element.toggleClass("is-balanced", appearance.mode === "balanced");
      entry.element.toggleClass("is-collapsed", isCollapsed);
      entry.element.setAttribute("aria-level", String(Math.max(1, node.level)));
      entry.element.setAttribute("aria-label", node.title.trim() || "空のノード");
      // The branches of a called map are read-only on this map; every node of them names its note on hover.
      if (source) {
        entry.element.setAttribute("aria-readonly", "true");
        entry.element.setAttribute("title", `呼び出し元: ${source.path}${source.subpath}`);
      } else {
        entry.element.removeAttribute("aria-readonly");
        entry.element.removeAttribute("title");
      }
      entry.toggle.hidden = node.children.length === 0;
      entry.toggleMark.empty();
      const hiddenCount = descendantCounts.get(node.id) ?? 0;
      const badgeCount = isCollapsed ? hiddenCount : 0;
      const controlSize = foldControlSize(badgeCount);
      entry.toggle.style.width = `${controlSize.width}px`;
      entry.toggle.style.height = `${controlSize.height}px`;
      entry.toggleMark.style.width = `${foldBadgeWidth(badgeCount)}px`;
      if (isCollapsed) entry.toggleMark.setText(String(hiddenCount));
      else if (node.children.length > 0) setIcon(entry.toggleMark, "minus");
      entry.toggle.setAttribute("aria-label", isCollapsed ? `${hiddenCount} 個のノードを展開` : "折りたたみ");
      entry.toggle.setAttribute("aria-expanded", String(!isCollapsed));
      if (node.children.length > 0) entry.element.setAttribute("aria-expanded", String(!collapsed.has(node.id)));
      else entry.element.removeAttribute("aria-expanded");
      const attachments = attachmentMarkdown(source ? nodeBody(source.document, source.node) : nodeBody(document, node));
      const key = `${path}\0${node.title}\0${attachments}${source?.root ? "\0called-root" : ""}`;
      if (entry.key === key) continue;
      entry.key = key;
      this.removeChild(entry.component);
      entry.component = this.addChild(new Component());
      entry.content.empty();
      const current = entry;
      const changed = (): void => {
        if (this.entries.get(node.id) === current && current.key === key) this.changed();
      };
      // The calling item carries a small link mark before the called root's text; the text itself (`![[…]]`) is what the inline editor shows.
      if (source?.root) setIcon(entry.content.createSpan({ cls: "mappy-node-call-mark", attr: { "aria-hidden": "true" } }), "link");
      const label = entry.content.createDiv({ cls: "mappy-node-label" });
      // A note transclusion in a title renders as a link (as in the body), so a node never nests another note's rendering.
      const labelTask = node.title
        ? MarkdownRenderer.render(this.app, transclusionsAsLinks(node.title), label, path, entry.component)
        : Promise.resolve();
      const attachmentsEl = entry.content.createDiv({ cls: "mappy-node-attachments" });
      const attachmentsTask = attachments
        ? MarkdownRenderer.render(this.app, attachments, attachmentsEl, path, entry.component).then(() => {
          // Keep rendered links and images, without reference labels or prose.
          const items = Array.from(attachmentsEl.querySelectorAll("a, .image-embed, img"))
            .filter(item => !item.parentElement?.closest("a, .image-embed"));
          attachmentsEl.replaceChildren(...items);
        })
        : Promise.resolve();
      entry.component.registerDomEvent(entry.content, "load", changed, true);
      entry.component.registerDomEvent(entry.content, "error", changed, true);
      void Promise.all([labelTask, attachmentsTask]).then(() => {
        changed();
      }).catch(() => {
        if (this.entries.get(node.id) === current && current.key === key) {
          label.setText(node.title);
          attachmentsEl.empty();
          this.changed();
        }
      });
    }
  }

  sizes(): Map<string, { width: number; height: number }> {
    return new Map(Array.from(this.entries, ([id, entry]) => [id, {
      width: entry.element.offsetWidth, height: entry.element.offsetHeight,
    }]));
  }

  /**
   * Reads come first, writes after: a layout read (clientLeft) right after a style
   * write forces a synchronous reflow of every node, once per fold, so a deep
   * branch of 2,000 nodes took seconds to place (LEV-45).
   */
  place(nodes: PositionedNode[], folds: FoldPosition[]): void {
    const junctions = new Map<string, { x: number; y: number }>();
    for (const fold of folds) {
      const element = this.entries.get(fold.id)?.element;
      if (element) junctions.set(fold.id, { x: fold.x - element.clientLeft, y: fold.y - element.clientTop });
    }
    for (const node of nodes) {
      const entry = this.entries.get(node.id);
      if (!entry) continue;
      entry.element.style.transform = `translate(${node.x}px, ${node.y}px)`;
      const junction = junctions.get(node.id);
      if (junction) {
        entry.toggle.style.left = `${junction.x - node.x}px`;
        entry.toggle.style.top = `${junction.y - node.y}px`;
      }
    }
  }

  /** Only the outgoing and incoming entries change, so selection stays O(1) on large maps. */
  select(id: string | null): void {
    const previous = this.selectedId;
    this.selectedId = id;
    for (const key of [previous, id]) {
      const entry = key === null ? undefined : this.entries.get(key);
      if (!entry) continue;
      const active = key === id;
      entry.element.toggleClass("is-selected", active);
      entry.element.setAttribute("aria-selected", String(active));
      entry.element.tabIndex = active ? 0 : -1;
    }
  }

  focus(id: string): void { this.entries.get(id)?.element.focus({ preventScroll: true }); }

  onunload(): void {
    for (const entry of this.entries.values()) entry.element.remove();
    this.entries.clear();
  }
}

/** Count the whole trees once, so nested folds still report all hidden nodes. */
function countDescendants(roots: readonly MindNode[]): Map<string, number> {
  const order: MindNode[] = [];
  const pending = [...roots];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) break;
    order.push(node);
    for (const child of node.children) pending.push(child);
  }
  const counts = new Map<string, number>();
  for (let index = order.length - 1; index >= 0; index--) {
    const node = order[index];
    if (!node) continue;
    let count = 0;
    for (const child of node.children) count += 1 + (counts.get(child.id) ?? 0);
    counts.set(node.id, count);
  }
  return counts;
}
