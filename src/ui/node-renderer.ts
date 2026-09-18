import { Component, MarkdownRenderer, setIcon, type App } from "obsidian";
import type { MindDocument, MindNode } from "../core/markdown";
import { nodeBody } from "../core/body";
import { attachmentMarkdown } from "../core/attachments";
import { foldBadgeWidth, foldControlSize, type FoldPosition, type PositionedNode } from "../layout/layout";

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
  mode: "mindmap" | "timeline";
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
    const descendantCounts = countDescendants(document.root);
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
      entry.element.toggleClass("is-root", isRoot);
      entry.element.toggleClass("is-topic", isTopic);
      entry.element.toggleClass("is-stage", !isRoot && parentIsRoot);
      entry.element.toggleClass("is-parent", node.children.length > 0);
      entry.element.toggleClass("is-timeline", appearance.mode === "timeline");
      entry.element.toggleClass("is-collapsed", isCollapsed);
      entry.element.setAttribute("aria-level", String(Math.max(1, node.level)));
      entry.element.setAttribute("aria-label", node.title.trim() || "空のノード");
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
      const attachments = attachmentMarkdown(nodeBody(document, node));
      const key = `${sourcePath}\0${node.title}\0${attachments}`;
      if (entry.key === key) continue;
      entry.key = key;
      this.removeChild(entry.component);
      entry.component = this.addChild(new Component());
      entry.content.empty();
      const label = entry.content.createDiv({ cls: "mappy-node-label" });
      const labelTask = node.title
        ? MarkdownRenderer.render(this.app, node.title, label, sourcePath, entry.component)
        : Promise.resolve();
      const attachmentsEl = entry.content.createDiv({ cls: "mappy-node-attachments" });
      const attachmentsTask = attachments
        ? MarkdownRenderer.render(this.app, attachments, attachmentsEl, sourcePath, entry.component).then(() => {
          // Keep rendered links and images, without reference labels or prose.
          const items = Array.from(attachmentsEl.querySelectorAll("a, .image-embed, img"))
            .filter(item => !item.parentElement?.closest("a, .image-embed"));
          attachmentsEl.replaceChildren(...items);
        })
        : Promise.resolve();
      const current = entry;
      const changed = (): void => {
        if (this.entries.get(node.id) === current && current.key === key) this.changed();
      };
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

  place(nodes: PositionedNode[], folds: FoldPosition[]): void {
    const foldPositions = new Map(folds.map(fold => [fold.id, fold]));
    for (const node of nodes) {
      const entry = this.entries.get(node.id);
      if (!entry) continue;
      entry.element.style.transform = `translate(${node.x}px, ${node.y}px)`;
      const fold = foldPositions.get(node.id);
      if (fold) {
        entry.toggle.style.left = `${fold.x - node.x - entry.element.clientLeft}px`;
        entry.toggle.style.top = `${fold.y - node.y - entry.element.clientTop}px`;
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

/** Count the whole source tree once, so nested folds still report all hidden nodes. */
function countDescendants(root: MindNode): Map<string, number> {
  const order: MindNode[] = [];
  const pending = [root];
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
